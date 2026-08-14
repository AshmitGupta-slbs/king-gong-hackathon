# PyAI API truth — verified H0, Thu 13 Aug 2026 ~11:50 IST

Everything below was **probed against the live API**, not read from docs. Where the docs and the
API disagree, the API wins and the disagreement is recorded. Probe scripts: `scripts/probe/`.

## Sandbox key: mints with no auth, and has more scopes than documented

`POST https://api.pyai.com/v1/sandbox/keys` with `{"label":"..."}` → **201**, no auth header needed.

```
scopes: hear:transcribe, hear:stream, transcribe:jobs, voice:synthesize,
        omni:session, nova:run, amd:detect, amd:configure, amd:read, cast:render
base_url: https://api.pyai.com/v1     environment: test     expires: +7 days
```

- **`transcribe:jobs` IS granted.** `authentication.md` lists only four scopes and omits it, and
  `sandbox/mint-a-sandbox-key` advertises a shorter list. Both are stale. This was the single
  decision the architecture hung on, and it went our way.
- **No `recap:*` and no `trace:*` on a SANDBOX key.** That was the original reason extraction runs on
  Claude. It no longer applies to the live key — see "Recap" below, probed Fri 14 Aug. Trace is
  still unreachable for us.
- `nova:run` and `cast:render` are granted but **have no reachable endpoint** (404 on
  `/cast/render`, `/audio/cast`, `/cast`, `/nova/run`). Scopes for unshipped products. Ignore.
- Key expires **Thu 20 Aug**, comfortably past Friday's demo. Re-mint is one unauthenticated call,
  so first-run auto-mint is safe.

`GET /v1/models` → the real product surface: `pyai-hear` (transcription, diarization, batch,
stream), `pyai-voice` (speech, clone, design), `pyai-omni-realtime`, `pyai-amd`.
**The Speak model id is `pyai-voice`, not `pyai-speak`.**

## Hear batch jobs — the primary path, confirmed working

`POST /v1/transcription/jobs` (multipart, `audio` part) → **202** `{job_id, status:"queued"}`.
`GET /v1/transcription/jobs/{id}` → `completed` after **one 1.5s poll** for 30s of audio. Fast.

Terminal `result` keys: `text`, `segments`, `words`, `speakers`, `audio_seconds`.

```json
{ "id": 0, "start": 0.0, "end": 6.16, "speaker": "speaker_1", "channel": 0,
  "text": "hi sarah thanks for making the time today ..." }
```

Four shape facts that make the ingest mapper real work, not a passthrough:

| API gives | Our contract wants | Mapping |
|---|---|---|
| `id` **integer** 0-based | `seg_000` **string** | zero-pad index, assigned once at ingest |
| `start`/`end` **float seconds** | `start_ms`/`end_ms` **int ms** | `round(x * 1000)` |
| `speaker: "speaker_1"` | `rep` \| `prospect` | via `channel` (stereo) or first-speaker heuristic (mono) |
| `channel` present only when `channel:true` | — | absent on diarized mono |

- **`words[]` carries per-word `start`/`end`/`speaker`.** Unasked-for bonus — enables word-level
  highlight-as-it-plays in the transcript viewer for near-zero extra work.
- **`x-pyai-units` is NOT returned by the jobs endpoints** (absent on both POST and GET). It *is*
  returned by flat `/audio/transcriptions` (`x-pyai-units: 1`). So the usage counter must be driven
  by **`result.audio_seconds`**, with the header read opportunistically where present. Anything
  built purely on the header would have silently displayed zero.
- `formats` is null unless `output_formats` asks for `srt`/`vtt`.

### Both speaker-separation modes work

| Mode | Input | Result |
|---|---|---|
| `channel: true` | stereo, one party per channel | 6/6 segments correct, `speakers: 2`, `channel` 0/1 populated. Exact and model-free. |
| `diarize: true` | mono mixdown | 6/6 segments correct, `speakers: 2`, no `channel` field. Sortformer is good. |

So: **stereo samples use `channel:true`** (deterministic rep/prospect from the channel int) and
**real mono uploads use `diarize:true`**. The "analyze a call from any dialer" claim holds up.

The **fallback stream-per-channel design is not needed** and is dropped from scope. Recorded here
so nobody rebuilds it: `hear:stream` finals carry `utterance_id`/`t_ms`/`audio_ms`, which would have
been segment-shaped, if `transcribe:jobs` had ever been denied.

## Hear streaming (`wss://…/v1/audio/transcriptions/stream`) — probed Thu 13 Aug, ~13:00 IST

Probe: `scripts/probe/hear_stream_test.py` (transcript → macOS `say` → real-time PCM16 stream →
scored against the source text) and `scripts/probe/eos_probe.py`. Model self-reports as
**`hear-realtime-1`**. Not on the critical path — batch jobs still own ingest — but the published
doc snippet is wrong in ways that cost hours, so it is written down.

### ⚠ There are TWO stream protocols, and the default is the legacy one

**This corrects an earlier version of this section.** The connect URL takes a `protocol` query
parameter. Omitting it — which the published quickstart snippet does — lands you on the **legacy
`fusion-v0`** route. Passing `protocol=pyai-hear-v1` gives the documented one. Verified by running
the same audio down both routes (`hear_stream_test.py --protocol pyai-hear-v1`).

| | default / `fusion-v0` (legacy) | `protocol=pyai-hear-v1` (documented) |
|---|---|---|
| frame types | `session.created`, `transcript.partial`, `turn.end`, `usage.delta`, `transcript.final` | `partial`, `partial_stable`, `speech_final`, `final`, `usage`, `config_ack` |
| flush the tail | **only trailing silence** (~1.8s) — every control frame rejected | `{"type":"commit"}` → `endpoint_reason: "client_commit"`, works with **zero** trailing silence |
| endpointing | fixed; turns below ~1.8s merge, hard cap ~30s | `endpointing_ms` (50–5000) at connect **or** mid-session via `{"type":"config","endpointing_ms":N}` |
| turn-taking signal | `turn.end` with `confidence` / `backchannel_prob` | none seen; `partial_stable` instead |

So the quickstart snippet's `if msg["type"] == "partial"` **does** fire — but only if you add
`protocol=pyai-hear-v1`. As printed, against the default route, it silently matches nothing. The
docs themselves disagree on this: `api-reference/hear/stream-transcription-websocket` says the
default is `fusion-v0`, while `guides/streaming-stt` claims *"omitting the parameter uses the same
`pyai-hear-v1` default"* and that no legacy protocol exists. The API says otherwise; the API wins.

**On `pyai-hear-v1`, `final` repeats `speech_final` verbatim for the same utterance** (same
`utterance_id`, same `text`, same `t_ms`). Handle one and ignore the other or every line is
duplicated — `hear_stream_test.py` dedupes by comparing against the previous final.

The findings below were all measured on the **legacy** route and are marked accordingly. They are
kept because that is what you get if you follow the published snippet literally, which is the
mistake worth documenting.

Legacy-route frame types: `session.created`, `transcript.partial`, `turn.end`, `usage.delta`,
`transcript.final`. Errors come back as `{"type":"error","error":{"code":…}}` on both routes.

| Finding (legacy route unless noted) | Consequence |
|---|---|
| **Only trailing silence flushes the last utterance** (~1.8s). `eos`, `flush`, `input_audio.commit`, `transcript.finalize`, `session.close` all → `unknown_message_type`; `{"type":"end"}` is accepted but flushes nothing; closing the socket drops the tail. **Fixed on `pyai-hear-v1` by `{"type":"commit"}`.** | Pad silence before hanging up, or move to `pyai-hear-v1`. |
| `partial.text` is a **rolling ~16-word window**, not the utterance so far — leading words fall off. | Accumulating partials corrupts the transcript. Render `stable_text` + `active_text`; treat `transcript.final` as the record. |
| **`utterance_id` is not a join key** — the partials, the `turn.end`, and the `transcript.final` for one spoken turn each carry a *different* id. | Corrects the note above: stream finals are segment-*shaped* but not id-joinable. Pair by arrival order. |
| Utterances force-finalize at **~30s**; inter-turn gaps below the endpoint threshold do **not** split them (350ms merged five turns into one). **Tunable on `pyai-hear-v1` via `endpointing_ms`.** | On legacy, turn-level segments need ≥~1.8s of silence between turns. |
| `turn.end` carries `endpoint_reason` (`silence` / `peak_te_early`), `confidence`, `backchannel_prob`, and lands **~370ms before** the text. | This is the barge-in / turn-taking signal, and it is free. Undocumented. |

`t_ms` is the server's audio-stream clock; on a final it is when text was produced, and
`audio_ms` is the utterance's **duration**, not its end offset. Honest latency is
`final.t_ms − turn.end.t_ms`: **369ms mean** (min 361, max 379) over six turns. First partial
lands at **~490ms** on both routes from here — the docs advertise 185–205ms "in-region", and we
are not in-region, so treat that gap as network, not model.

`usage.delta` gives `active_audio_seconds` and `billed_micros` live, and bills **active** audio
only — 46.4s streamed (padding included) billed as 29.8s = 1490 micros ($0.0015). So the stream
path does carry usage in-band, unlike the jobs endpoints.

**`numerals=true` works here and applies at finalization, not on partials**: partials read
"one four oh oh", the final reads "1400" (and "12", "15"). This is the counterpart to the jobs-
endpoint numerals problem noted below — on the stream, judge numerals from finals only.

Quality on `say`-synthesized audio: **8.4% WER** after case/punctuation normalization. Errors are
the predictable ones — "gong" → "gang"/"gong in", "crm" → "erm", "Q4" → "q 4". Proper nouns and
competitor names are where it slips, which is exactly what a tracker feature depends on.

### Live mic works, and exposed the one finding with product consequences

`hear_stream_test.py --mic` streams the default input device (`sounddevice`, whose macOS wheel
**bundles PortAudio — no Homebrew needed**, which matters on this machine). Verified end to end by
acoustic loopback: `afplay` a `say` clip through the speakers, capture it on the built-in mic, and
Hear returned `the pricing came in around 1400 a seat which is hard to justify` — clean, through
the air, at 650–750ms endpoint→text.

**⚠ Hear fabricates fluent text from silence and room ambience.** Repeatedly, with nobody
speaking, it emitted confident finals (`confidence` 0.99+, `endpoint_reason` `silence`) containing
sentences that were never said. Measured input RMS: real speech **0.219**, the ambience windows
that produced fabricated text **0.035**.

This is not cosmetic. Our citation gate treats `segment.text` as the source of truth for quoted
evidence, so dead air on a call — hold music, mute, a pause while someone reads — can manufacture
a quotable claim that no human uttered, and it will pass the gate because the gate only checks
that the quote matches the transcript. **Any Hear-streaming ingest needs an input-level gate
before segments are trusted.** `--silence-floor` (default 0.08) implements the check for the
probe: it flags every final whose audio window never reached speech level.

### Batch jobs on silence: clean on exact zeroes, unresolved on room tone

`scripts/probe/batch_silence_probe.py` builds `speech | gap | speech` and checks whether any
returned segment lands inside the gap.

- **25s of digital silence (exact zeroes): CLEAN.** `speakers: 2`, exactly 2 segments, both real
  speech, nothing in the gap. `audio_seconds` still billed the full 30.8s.
- **RMS-0.035 room tone — the level that actually fooled the stream: CLEAN.** Now resolved (it
  was blocked for hours on upstream 500/504s on the uploads path, then on a capped key). 20s of
  noise at the exact level that produced fabricated finals on the mic returns **2 segments, both
  real speech, nothing in the gap**.

  **So the fabrication defect is specific to the streaming path, and the batch path — the one this
  app ingests with — does not have it.** That materially narrows the threat to the citation gate:
  dead air on an uploaded recording cannot manufacture a quotable segment. An input-level gate on
  batch ingest is therefore *not* needed, which is why none was built. Anything that later moves
  ingest onto `hear:stream` reopens this and would need one.

`audio_url` submission worked reliably while multipart upload was 500ing, which is a useful
fallback to know about: `pyai-jobs.ts` uses multipart.

## Operational findings that can kill a demo

**Correction to "Sandbox quota: Speak is rate-limited hard, Hear is not" below: Hear *can* exhaust
the cap, and when it does it blocks Hear.** That section's conclusion — *"Transcription … was never
at risk"* — held for a cap triggered by Speak. It is not true in general. Streaming and batch probe
runs exhausted the cap on their own, and the result blocked everything on the key:

```
429  {"error":{"code":"daily_cap_exceeded",
      "message":"Daily usage cap reached for this API key. Resets at 00:00 UTC.",
      "type":"requests_too_many"}}
```

`GET /v1/models` returned it too, and the streaming WebSocket upgrade failed with a bare `HTTP 429`
at handshake — no JSON body, so a client that only parses error payloads learns nothing.

**⚠ And the re-mint escape hatch runs out.** Minting *once* worked (fresh key, fresh allowance,
identical scopes). The next attempt, minutes later, did not:

```
429  {"type":"…/problems/sandbox_limit_reached","title":"Too Many Requests",
      "detail":"The sandbox-key limit for this network has been reached.
                Create a full account at https://console.pyai.com."}
```

So the limit is **per network, not per key** — auto-minting is not an unlimited recovery path, and
the advice below ("a blocked build is recoverable") only holds until the network budget is spent.
On this machine it is now spent. Current state: one working key, cached in `.pyai-key.json`; the
previous key capped until 00:00 UTC; no new keys available from this network.

**What this means for demo day, concretely.** If the key on the demo machine caps out mid-demo,
you cannot mint your way out from the venue's network — and every laptop on that network shares the
budget, so a room full of teammates minting keys is a real failure mode. Two mitigations, both
cheap: run the demo off the **committed sample data** (which needs no API calls at all — that is
already the design), and get a real account key from `console.pyai.com` as the live-path backup
rather than relying on sandbox minting.

The consequence worth acting on: **`lib/pyai.ts` `getPyaiKey()` re-mints only when `expires_at`
passes.** A `daily_cap_exceeded` 429 leaves a live, unexpired, useless cached key and surfaces as a
hard failure. A fresh clone is fine because it mints; **the demo machine, with a cached key, is
exactly the case that breaks.** Teaching the resolver to re-mint on `daily_cap_exceeded` is a few
lines and removes a whole class of demo-day failure.

## MP3 and other compressed formats

**The jobs endpoint decodes them server-side — upload the file as-is, no local conversion.**
Verified with a real MP3: uploaded byte-for-byte with `Content-Type: audio/mpeg`, `audio_seconds`
came back exact (32.731 vs the file's 32.703), and the transcript was character-identical to a
locally decoded 16 kHz WAV of the same audio. `mic_diarize_test.py --file x.mp3` does this.
Known-good extensions are mapped in that script: wav, mp3, m4a, mp4, flac, ogg, aac, aiff.

**Streaming is the exception.** The WebSocket takes raw PCM16 only, so an MP3 has to be decoded
locally first. `hear_stream_test.py --audio x.mp3` now does that via `afconvert`, which ships with
macOS and needs no ffmpeg (there is none on this machine).

**The API rejects an oversized/over-quota upload mid-body, and urllib turns that into a lie.**
Uploading a 4.42 MB file on an over-quota key: curl reported `429 daily_cap_exceeded` after sending
1,048,097 of 4,419,244 bytes — the server answers and closes the socket without reading the rest.
`urllib` keeps writing into the closed socket and raises `BrokenPipeError`, discarding the real
status, so the user sees a 40-line traceback where the answer was "you are out of quota". Any
uploader needs either a cheap preflight GET (what `mic_diarize_test.py` does now) or to treat a
broken pipe as "re-check status separately", never as a network fault.

**Trust the bytes, not the filename.** A real recording handed to the probe was named
`recording.mp3` and was actually `RIFF … WAVE, Microsoft PCM, 16 bit, stereo 8000 Hz`. Consequences
of believing the extension: `afconvert` picks the MP3 parser and dies with
`Couldn't open input file ('dta?')`, and the upload's `Content-Type: audio/mpeg` misdescribes a WAV
payload. `sniff_format()` in `hear_stream_test.py` reads magic bytes instead; `afconvert` dispatches
on extension, so a mislabelled file must be copied to a correctly-named temp path before decoding.
The same file being **stereo** is the more useful discovery — see `channel:true` above, which is
exact and skips the diarization stage entirely, so mislabelled telephony recordings are the case
where the currently-flaky mono path can be avoided altogether.

**macOS can decode MP3 but not encode it.** `afconvert -f MPG3 -d .mp3` fails with
`ExtAudioFileSetProperty ('cfmt') failed ('fmt?')` on every input and sample rate tried, including
a 44.1 kHz mono intermediate. `MPG3` is listed by `afconvert -hf` but is decode-only in practice.
So you cannot generate a test MP3 on this machine — find a real one. (There are two under
`/System/Library/PrivateFrameworks/PersonalAudio.framework/…/Enrollment_1.mp3`.)

## ⚠ The `diarize` step 500s intermittently, in multi-minute windows

`{"status":"failed","error":"diarize: HTTP 500: Internal Server Error"}` — the job is accepted
(202), transcription succeeds, and only the diarization stage fails.

Ruled out, each by direct experiment:

| Suspected cause | Result |
|---|---|
| MP3 vs WAV | Both fail in a bad window; both succeed in a good one |
| `numerals: true` alongside `diarize` | `diarize` alone fails too |
| Multipart field order (audio part before vs after the flags) | **No effect** — interleaved A/B/A/B, identical failures |
| Our multipart encoder | Same body with `diarize` omitted completes, returning exact `audio_seconds` and byte-identical text |

So it is time, not payload. Windows observed lasting several minutes, with the identical bytes
succeeding immediately before and after. Do not debug your audio when you see this.

Beware the trap this sets: because the windows are minutes long, an A/B test run sequentially will
show whichever variant you happened to try during a good window as "the fix". Two of those false
conclusions were reached and discarded here before interleaving settled it. Interleave, or wait.

`mic_diarize_test.py` retries 4 times with 5/15/30s backoff, which spans ~50s and is **not** always
enough. `lib/harness/retry.ts` caps at 2 attempts, so a demo-time ingest can lose to this — the
mitigation that matters is that the five committed samples need no API call at all.

**`POST /v1/transcription/jobs` was intermittently 500/504 on multipart uploads** for ~20 minutes,
recovering on its own; `audio_url` submissions kept working throughout, as did streaming and
`GET /v1/models`. So the blast radius was uploads specifically. `retryAimed` in
`lib/harness/loop.ts` plus `PyaiError.retryable` (5xx → retryable) already cover it — worth
confirming the demo path actually exercises that retry rather than surfacing the error, since this
is the ingest path.

## ⚠ Spoken figures come back as words, and no request flag fixes it — visible in the demo

*(This heading previously read "`numerals: true` does NOT work on the jobs endpoint". That was
retracted — see the correction below. Renamed because a heading is what gets quoted, and leaving a
withdrawn claim in the title while the body disowns it is worse than either alone.)*

**Correction to an earlier version of this section.** It claimed flatly that "the flag is accepted
and ignored". That was too strong, and further testing disproved it: the endpoint *does* return
digits sometimes, with or without the flag. The accurate claim is narrower and, for our purposes,
worse — **you cannot make spoken figures come back as digits by setting a flag.**

| Submission | Audio said | Came back as |
|---|---|---|
| the committed `pricing-pushback.wav` (stereo, `channel:true`, `numerals:true`), 68s conversation | "fourteen hundred" | `one four oh oh` |
| the same file, same flags, re-run later | "fourteen hundred" | `one four oh oh` — **reproducible** |
| `audio_url` JSON, `"numerals": true` (real boolean), PyAI's `original-interview.wav` | "ten thirty" | `ten thirty` |
| a short mono `say` clip of the same sentence — WAV 16k, WAV 22k, AIFC 22k, with `numerals:true` **and** without | "fourteen hundred" | `1400` in all four |

So the flag is not the variable. Something about the audio or the mode is: short clean mono
utterances render digits, while the long stereo `channel:true` conversation reproducibly renders
spoken digits, and setting or omitting `numerals` changes neither. Which of length, mono-vs-stereo,
`channel:true`, or surrounding context is responsible is **untested** — it would take several more
jobs to isolate and the answer would not change what we do.

What it means for us: digit rendering is **unreliable and not controllable from the request**, so
the display-side pass in `lib/readability.ts` is the right fix rather than a workaround for a broken
flag. Do not "fix" this by turning `numerals` on and re-running the samples — verified above, it
does not change them.

The streaming path renders the same phrase as **`1400`**, and the flat sync
`/v1/audio/transcriptions` also renders `1400` — but that endpoint has **no diarization**, so we
cannot simply switch to it.

All five committed samples are affected. Zero digits across the whole set; 30 spelled-out numbers:

| sample | spelled-out | digits |
|---|---|---|
| `pricing-pushback` | 13 | 0 |
| `clean-close` | 8 | 0 |
| `heavy-objections` | 6 | 0 |
| `competitor-named` | 2 | 0 |
| `no-decision` | 1 | 0 |

The damage is concentrated exactly where the product's pitch lives:

```
pricing-pushback: "the number is one four oh oh a seat is more than we spend on our entire…"
pricing-pushback: "do that if the first year comes in under five oh oh oh i can approve it…"
clean-close:      "we landed on forty seats across the two sales pods"
```

The README sells against Gong at "$1,400/seat" and the flagship sample is *about* that number.
A judge reading "one four oh oh" reads a broken product — this is Product-pull damage (30%), not a
cosmetic nit.

**Fixed, in `lib/readability.ts`.** The presentation layer now runs **two passes with two separate
guards**, rather than one guard loosened to cover both:

| Pass | Permitted change | Guard |
|---|---|---|
| `readable()` | letter case, one terminal full stop | `sameWords()` — same words, same order, ignoring case and punctuation. **Unchanged.** |
| `spokenDigitsToNumber()` | a run of spoken digits → the number it spells | `sameSpokenNumbers()` — same words *and* the same numbers, whichever way written |

Keeping them separate matters: `sameWords()` is the thing that lets us claim the display layer
cannot alter evidence, and it is asserted over all 50 committed segments. Relaxing it to accept
`"one four oh oh" ≡ "1400"` would have surrendered that proof for *every* transform in order to buy
digits. Instead the digit pass proves a different, weaker, honestly-labelled property, and only
`readableFor()` — the boundary the UI and Markdown export both go through — composes the two.

The digit pass is deliberately conservative: a run must be **four or more** words long **and**
contain at least one unambiguous digit word (`zero`/`one`…`nine`). Both bars come from measured
false positives — `"oh oh oh that is a problem"` → `"000 that is a problem"` (`oh` is an
interjection far more often than a zero) and `"we counted one two three items"` → `"123 items"`.
Where the two error directions trade off, prefer the false negative: an unconverted "one four oh oh"
is ugly and honest; a wrong "000" is neither, and it would be invisible because the gate reads
`text`, not `display_text`. Ordinary English is untouched — "forty seats" and "the two sales pods"
stay words, because "40 seats" and "the 2 sales pods" read worse.

Result on real data: 2 of 50 segments convert, both in `pricing-pushback`, which is exactly the
sample the pitch depends on:

```
before: the number is one four oh oh a seat is more than we spend on our entire sales tooling stack
after:  The number is 1400 a seat is more than we spend on our entire sales tooling stack.
before: do that if the first year comes in under five oh oh oh i can approve it myself
after:  Do that if the first year comes in under 5000 I can approve it myself.
```

`npm run test:readability` covers both passes — the casing contract, both real conversions, both
false positives, a 13-input round-trip sweep, and a whole-corpus invariant asserting every rendered
segment says the same words and numbers as the verbatim text the gate reads. The citation gate still
quotes verbatim `segment.text`, so evidence integrity is untouched either way.

## Known issue: Hear returns lowercase, unpunctuated text

```
hi sarah thanks for making the time today i know you've been evaluating a few options
```

Confirmed on **both** `pyai-hear-telephony` (the jobs default) and `pyai-hear` — not a model-choice
problem, it's how Hear returns text. This matters: it's 30% Product pull, and raw ASR casing is the
difference between "notes worth $1,400/seat" and "a machine dump".

**Decision — verbatim is the source of truth.** `segment.text` stores exactly what Hear returned and
is the only thing the citation gate and any quoted evidence ever read. Readability is applied at the
**presentation boundary** instead, and falls back to verbatim whenever its guard trips.

Two corrections to an earlier version of this paragraph, both worth knowing:

- **It is no longer "punctuation and casing only."** That was true until the spoken-digit pass
  landed; there are now two passes with two separate guards. See "Spoken figures come back as words,
  and no request flag fixes it" above for the full rules — that section is the authority, not this
  one. (This pointer named the section by its old title until the retraction renamed it.)
- **`display_text` is reserved, not live.** Nothing writes it. The schema field exists
  (`TranscriptSegmentSchema`) and the DB column exists, but the UI and the Markdown export both call
  `readableFor(call.title)` per segment at render time rather than reading a stored value. So the
  guard runs on every render and there is no persisted rendering to drift out of sync — which is
  the safer arrangement. Treat the field as a placeholder for a future ingest-time cache, and do not
  describe it as populated.

Also seen: "fourteen hundred" transcribed as "one four oh oh" on the jobs endpoint, while flat
`/audio/transcriptions` rendered "1400". **`numerals: true` does not fix this** — that was worth
trying and it was tested; see the dedicated section above.

## Sandbox quota: Speak is rate-limited hard, Hear has a larger allowance (not immunity)

Later in the build Speak recovered, and we tried to regenerate the sample audio on PyAI. What we
learned, in order, because the error message is actively misleading:

```
HTTP 429  {"error":{"code":"daily_cap_exceeded",
           "message":"Daily usage cap reached for this API key. Resets at 00:00 UTC."}}
```

- It first fired after roughly **30 rapid `/audio/speech` calls**.
- A single call minutes later **succeeded** — so it looked like a recoverable burst limit.
- A fresh run of ~10 calls at 250 ms spacing **429'd again**, and so did 6 attempts with backoff up
  to 24 s. Single calls kept succeeding throughout.

So the label is wrong in both directions: it is not purely a burst limit (sustained runs fail for
hours) and not a hard daily zero (isolated calls still pass). Treat **Speak on a sandbox key as
having a small allowance that sustained generation exhausts.** No `Retry-After` header is sent, so
there is nothing to honour — `PyaiError.retryAfterSec` is wired up and simply stays undefined here.

**Hear was unaffected *by the Speak-triggered cap*.** `/v1/transcription/jobs` kept returning 202
throughout, including after Speak was fully blocked. But this does **not** generalise: sustained
Hear probing later exhausted the cap on its own and blocked Hear itself, including the streaming
handshake and `GET /v1/models`. See "Operational findings that can kill a demo" above. Transcription
is not exempt — it just has a larger allowance than Speak.

**Quota is per key/org.** A freshly minted sandbox key comes back with a *different* `org_id` and a
fresh allowance. Minting one is a single unauthenticated call, so a blocked build is recoverable —
but do not lean on it as a strategy. **Update: this is now measured, and the ceiling is real —**
minting itself 429s with `sandbox_limit_reached` ("the sandbox-key limit for this **network** has
been reached") once you have taken a few. See "Operational findings that can kill a demo" above.
Treat minting as a one-shot recovery, not a strategy, exactly as this paragraph warned.

**Consequences for us.** Sample audio stays on macOS `say`, all five voice-consistent. A partial
regeneration is worse than none: it left three calls on 24 kHz PyAI audio paired with transcripts
from the 16 kHz `say` audio, which silently points every citation at the wrong moment. That failure
is now asserted in `npm run check:ship` (audio/transcript drift) and `npm run reindex:samples`
rebuilds the manifest from disk when a run dies partway.

```
HTTP 503  {"error":{"type":"server_error","code":"upstream_error",
           "message":"Speech synthesis is unavailable."},"service":"voice"}
```

Reproduced across `pyai-speak` / `pyai-voice` / no model field, `wav` and `mp3`, three attempts over
~15 minutes. `GET /v1/voices` works fine (144 stock voices), so it's the synthesis backend.
Per `errors-and-limits.md`, 503 is not in the retryable-code list but `upstream_error` is transient
by nature — worth re-probing before freeze.

**Impact and mitigation.** Sample-call audio comes from macOS `say` (16kHz PCM16 WAV, proven in the
probes above) behind the registry's `tts` capability, with `pyai-speak` registered and ready to swap
in one config line if the service recovers. The generated WAVs are committed, so **nobody cloning
the repo needs `say`, PyAI Speak, or any TTS at all** — the zero-setup demo is unaffected. What we
lose is Speak minute-burn; Hear minutes, which are the far larger burn, are unaffected.

## ⚠ Bedrock: `anthropic.claude-opus-5` is the CORRECT id — a 404 means region, not the string

Not a PyAI finding, but it cost a wrong fix's worth of time on the deployed app, so it lives
here with everything else that was measured rather than assumed.

Symptom on Railway, from `GET /api/usage` → `runs[]` after AWS credentials were set:

```
"status": "failed",
"error": "404 {\"type\":\"not_found_error\",
          \"message\":\"The model 'anthropic.claude-opus-5' does not exist\"}"
```

The obvious reading — "the model id is wrong, add a region prefix" — is wrong, and acting on
it would have broken a working call. Checked against the Claude API reference:

- `lib/registry/providers/bedrock-extract.ts:73` constructs **`AnthropicBedrockMantle`**, the
  Messages-API Bedrock endpoint. Mantle model ids take exactly an `anthropic.` prefix, which
  is what `bedrockModelId()` (`:37-40`) already produces.
- The **`us.` / `eu.` inference-profile prefixes** and ARN-versioned ids
  (`anthropic.claude-3-5-sonnet-20241022-v2:0`) belong to the **legacy** bedrock-runtime
  `InvokeModel`/`Converse` path — a different client and a different request shape. This app
  does not use it. The header comment at `bedrock-extract.ts:8-11` is correct; leave it.

So a 404 on a well-formed id means **the region cannot serve that model**, or Anthropic model
access is not enabled there (`bedrock-extract.ts:23-25` already records the access
requirement). Two levers, neither of them code:

1. `AWS_REGION` → a region that serves Claude Opus 5 on Bedrock (`us-east-1` / `us-west-2`),
   with model access enabled for that region in the Bedrock console. An India region such as
   `ap-south-1` is the likely trap here.
2. `OPENGONG_MODEL` → already read at `lib/registry/index.ts:65`, so
   `OPENGONG_MODEL=claude-sonnet-5` picks a different Bedrock model in the same region with no
   code change at all.

**The code change worth making is the error surface, not the id:** catch the 404 and rethrow
naming the model, the region, and both levers. As shipped, this arrives in the run log as a
raw SDK 404 with no hint that region or model access is the variable — which is exactly why it
read as an id bug.

Related, and separately confirmed: `extracted_by` is **sticky per call**. `gate.ts:343` writes
it into the persisted extraction JSON, so a call processed while the stub was active keeps
reporting `stub-heuristic` regardless of later credential changes. Only re-processing
overwrites it — re-upload rather than debugging the badge.

## Recap — reachable on a live key, and it returns far more than it documents

Probed **Fri 14 Aug 2026** with `scripts/probe/recap-probe.ts` against two committed samples
(`clean-close`, `heavy-objections`). The key is a `pyai_live_` key on a payg org:

```
GET /v1/me            scopes: … recap:configure, recap:read  (plus hear:transcribe, transcribe:jobs)
GET /v1/recap/config  { enabled: true, default_pack_id: "sales_outbound", webhook_url: null }
```

Recap was **already enabled** on the org, so no `PUT /v1/recap/config` was needed. Submitting an
existing transcript works exactly as documented: `POST /v1/recap/calls/{call_id}` with `utterances`
→ **202 `pending`**, then `GET /v1/recap/calls/{call_id}` reaches `complete` in **3.5–4.7s** for a
10-utterance call. Stage reported throughout as `extract+coverage`.

### `record` is typed as a bare `object` in the OpenAPI. Here is what it actually contains

Identical key set across both samples (`pack_id: sales_outbound`):

| key | shape | notes |
| --- | --- | --- |
| `tldr` | string | one line. Same text as the top-level `headline`. |
| `summary_draft` | string | the detailed notes. **There is no `summary` key on this pack** — the docs' troubleshooting table is right to say read `summary_draft`. |
| `next_steps` | **string** | prose, *not* a list. Easy to misread from the docs. |
| `action_items[]` | `{task, owner, due}` | `owner` is `agent`/`customer`; `due` is free text and **can be `null`**. |
| `objections[]` | `{text, note, response_quality, agent_response_type}` | `text` is a transcript quote; `note` is Recap's read of the agent's response. |
| `moments[]` | `{category, offset_s, description}` | categories seen: `buying_signal`, `objection_raised`, `risk_flagged`, `commitment_made`. |
| `buying_signals[]` | `{quote, category}` | can be empty. |
| `risk_signals[]` | `{quote, category, severity}` | can be empty. |
| `competitor_mentions[]` | — | empty on both samples; element shape unobserved. |
| `key_decisions[]` | string[] | can be empty. |
| `coverage_gaps[]` | `{fact, type, transcript_quote}` | facts Recap could not fully verify. `type` seen: `name`, `number`, `other`. **Duplicates occur** (the same quote appeared twice). |
| `extracted_fields` | object | pack-driven and **per-call**: `{number_of_seats, option_to_add_seats, onboarding_process}` on one call, `{industry, …}` on the other. Free-form. |
| `sentiment_phases[]` | `{phase, agent_sentiment, customer_sentiment, note}` | |
| `analytics` | `{talk_ratio, filler_rate, question_count}` | `filler_rate` and `question_count` were both `0` on both samples — suspect, unverified. |

### ⚠ `moments[].offset_s` is a FLOORED utterance start, so containment resolves the wrong segment

The offsets come back as whole seconds (`7`, `22`, `49`) and are the *truncated* start offset of the
utterance Recap means. Because flooring lands the value just **below** that utterance's start, the
obvious "which segment's `[start, end]` window contains this offset?" lookup returns the **previous**
segment — which on all three moments of `clean-close` was the other speaker. Measured:

| offset_s | containment | nearest start | Recap's description matches |
| --- | --- | --- | --- |
| 7 | seg_000 (rep) | **seg_001** (prospect) | seg_001 |
| 22 | seg_002 (rep) | **seg_003** (prospect) | seg_003 |
| 49 | seg_006 (rep) | **seg_007** (prospect) | seg_007 |

Nearest-segment-start scored **6/6 across both samples** (deltas +0.24s … +0.76s, always positive,
consistent with flooring); containment scored **0/6** and inverted the speaker every time. So:
resolve moments by **nearest segment start**, never by containment. This is exactly the class of bug
`docs/decisions.md` §8 was written about — a plausible lookup that silently attributes a quote to the
wrong party.

### Quotes are near-verbatim, not verbatim — Recap repairs ASR damage

`objections[].text`, `buying_signals[].quote`, `risk_signals[].quote` and
`coverage_gaps[].transcript_quote` are quotes of the utterances we submitted, so they can be resolved
back to a segment by substring match. Exact match hit **14/16**. Both misses were the same quote, and
the cause is informative: Hear transcribed *"it became a stigma, managers used…"* as
`it became a stig managers used`, and **Recap silently corrected it to `stigma`**. That quote still
resolves at 0.88 token overlap.

So quote resolution needs a tolerant second pass, and — importantly — Recap's prose can differ from
the transcript. `lib/harness/gate.ts` already guarantees the right thing here: quoted evidence and
timestamps are always taken from the **segment**, never from provider prose.

### What Recap does not give you

No per-claim segment ids, no follow-up email, and no way to pass a system prompt — so `skills/`,
account context, learned context and carried commitments cannot reach it. See
`lib/registry/providers/recap-extract.ts` for how each field is grounded and what is deliberately
left unmapped.

## Environment notes

- **No Homebrew on this machine.** Node was installed from the official tarball into `~/.local`
  (`node v24.19.0`, `npm 11.17.0`). Add `~/.local/bin` to `PATH`.
- python.org Python 3.14 ships **without a CA bundle** — probe scripts need
  `SSL_CERT_FILE=/etc/ssl/cert.pem`. Node is unaffected; this never touches the app.
- No `ffmpeg`, and none needed: stereo interleaving and mono mixdown of 16-bit PCM are ~10 lines of
  `wave` + byte slicing, verified working in the probes.
