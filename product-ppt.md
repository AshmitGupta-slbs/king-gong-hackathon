# King Gong — elaborate product deck

Use this file to build a long product PPT (PowerPoint, Keynote, or Google Slides).

Each `## Slide N` is **one slide**.

| Block | What to do with it |
|---|---|
| **On slide** | Type this. Short. No paragraphs on the glass. |
| **Visual** | Screenshot, diagram, or layout |
| **Build** | Optional click-order if you animate |
| **Say** | Speaker notes only. Do not paste onto the slide. |

**Do not put on any slide:** API keys, `.env`, portal ids, “we sync HubSpot / JustCall” as if it is live, a quality score vs Gong, the stub-extractor banner.

**Do not claim as shipped:** JustCall ingest, HubSpot push, Zoom/Meet/Loom join-or-share auto-transcribe, Speak on the live path.

---

## How long to run

| Cut | Slides | Time | Use when |
|---|---|---|---|
| **Pitch** | 1–8, 28 | ~8 min | Friday room, then go live |
| **Product** | 1–20, 28 | ~15 min | Stakeholder walkthrough |
| **Full** | 1–32 | ~25 min | Deep dive / internal |

If you can go live, **replace slides 5–7 with the real app**. Keep those slides as backup.

---

## Screenshots to capture first

Run `npm run dev` (or the Railway URL). Open **Halcyon Health — heavy objections** or **Bright Harbour — competitor-named**.

| # | Shot | Where |
|---|---|---|
| A | Home | Title, call list, upload, Notes engine picker |
| B | Workspace | Transcript left, notes right, one citation chip selected |
| C | Seek | Player jumped; line pulsing |
| D | Rejections | “What the citation gate rejected” |
| E | Commitments | Carried-in action items with a quoted tick and one still open |
| F | Scoring | MEDPICC (or BANT) with inherited cite chips |
| G | CRM payload | After “Show the payload” — keep the “Nothing is sent” banner in frame |
| H | What actually ran | Home footer: STT, extract, skills |
| I | `./kg` | Terminal: claim + timestamp + “hear this moment” |
| J | Progress | Upload → Transcribe → Extract → Gate |
| K | Recap vs Claude | Same call, two engines (if you have `recap:read`) |
| L | `docs/king-gong.png` | Wordmark / hero (prefer this over a stub-banner `hero.png`) |

---

# Section A — The problem

## Slide 1 — Title

**On slide**

# King Gong
Deal notes with receipts.

Gong is ~$1,400 a seat.
The job after a call is three questions.

**Visual:** `docs/king-gong.png`. Dark slide, wordmark large.

**Say:** “Gong charges about fourteen hundred dollars a seat. After a call the job is three questions: what happened, what did they push back on, what do I do next. King Gong does that job. Every line in the notes points at the moment in the call that proves it.”

---

## Slide 2 — Three questions

**On slide**

After every sales call:

1. What happened?
2. What did they push back on?
3. What do I do next?

That is the whole job.
Not a suite. Not a forecast. Not a coaching dashboard.

**Visual:** Three numbered lines, very large. Strike-through: coaching / forecast / deal board.

**Say:** “If you need inspection, forecasting and coaching, buy the suite. This is for the case where the notes *are* the job — and they have to be auditable.”

---

## Slide 3 — The failure mode

**On slide**

Every notes tool will write you a summary.

A confident paragraph about “budget concerns”
is worthless if nobody can find where they said it.

Worse if they never did.

Summaries are table stakes.
Proof is the product.

**Visual:** One fake summary bubble vs an empty “where in the call?”

**Say:** “We are not here to win on prettier prose. The failure mode is a fluent sentence with no source. You cannot tell which sentences are real.”

---

## Slide 4 — The rule

**On slide**

# No proof, no claim.

- Every objection, next step, intent, and follow-up email cites a real line
- A citation that does not exist is **deleted**, not softened
- A line that exists but does not support the claim ships **flagged**
- We **publish what we threw away**

Ask any other tool in this category to show you its rejected claims.

**Build:** Four bullets, one click each. Last bullet lands last.

**Say:** “That last line is the whole pitch.”

---

# Section B — The moment

## Slide 5 — Click a claim, hear the moment

**On slide**

Click a claim.
The audio jumps to that second.
The transcript line pulses.

The quote under the claim is pulled from the transcript.
The model summarises. The evidence comes from the call.

**Visual:** Shots B + C. Circle `seg_003 · 0:18`.

**Say:** “This is the slide you should leave. Open a call, click an objection, stop talking while five seconds play. That silence is when the room gets it. Do not read the summary.”

---

## Slide 6 — What you get on one call

**On slide**

| Surface | What it is |
|---|---|
| Transcript | Speakers labelled. Stereo = exact (one party per channel). Mono = diarizer |
| Summary | What happened — synthesis, not a cited claim |
| Objections | Pushback, each with a receipt |
| Intent | A label, only if a line supports it |
| Next steps | Commitments the call actually made |
| Follow-up email | Drafted from verified claims |
| Timeline | Competitor, pricing, objections on the scrubber |
| Rejections | First-class panel, not an error state |
| Score | MEDPICC / BANT / SPICED / CHAMP / ANUM from *already-cited* notes |
| Share / export | `/s/{id}`, Markdown with quotes, JSON verbatim |

**Visual:** Shot B, or this table set cleanly.

**Say:** “Walk one call deeply. `heavy-objections` and `competitor-named` have the most material. Do not click through four calls.”

---

## Slide 7 — The gate, live

**On slide**

Two checks, before anything reaches you.

1. **Does the citation resolve?** `seg_412` does not exist → **dropped**
2. **Does the line support the claim?** Score below 0.18 → **flagged**

**Test the gate** on any call.
Hand-written claims. Same function production uses.

**Visual:** Shot D. Two example rows:

- “Legal has already blocked the purchase” → `seg_412` → Dropped
- “Signed PO is in place” → real segment, support 0.00 → Flagged

**Say:** “Those demo claims are hand-written. We will not fake a hallucination on stage. What is real is the gate.”

---

# Section C — How a call is analysed

## Slide 8 — The pipeline

**On slide**

```
                Claude (schema-forced)
audio → Hear → segments →              → draft → GATE → notes
                Recap (cited here)
```

1. Transcribe. Segment ids assigned **once** — never by a model
2. Extract. Schema-forced, or Recap (we attach citations)
3. Gate. Resolve, then support
4. Ship: `shipped` · `partial` · `failed` · `deadline`

The draft is untrusted. The gate is the product.

**Visual:** Four boxes. Mark “draft” as untrusted. Hear and Recap in the PyAI colour if you have one.

**Say:** “Anyone can call a transcription API. The product is the gate sitting between a fluent model and a human.”

---

## Slide 9 — Hear: speakers without guessing (when we can)

**On slide**

**Stereo, one party per channel** → `channel: true`
Exact. No diarization model. Left channel = the rep.

**Everything else** → `diarize: true`
Whoever talks first is labelled the rep.
The UI says which mode produced the labels.

Auto reads the WAV. Dual-mono and room mixes do **not** get fake “exact” separation.

**Visual:** Two columns: Channel vs Diarize. “Auto decides from the bytes.”

**Say:** “A stereo phone recording uploaded as ‘mono’ used to collapse onto one speaker. We read the file now. Guessing channel on a mono-exported-as-stereo file would be a silent new failure.”

---

## Slide 10 — Long mono calls

**On slide**

PyAI’s diarize stage 500s on some long mono jobs.
Not our file. Time windows. Same bytes succeed later.

**What we do**
- Stereo stays one job (`channel` never hits that stage)
- Mono WAV longer than ~6 minutes is split into ~200s chunks on silence
- Retry is **per chunk**, not the whole call again

**Visual:** One bar split into three chunks. Label “validated on a real 13-minute call.”

**Say:** “We do not pretend the upstream never fails. We stop one flake from throwing away ten minutes of work that already succeeded.”

---

## Slide 11 — Two notes engines

**On slide**

| | Claude / Bedrock (default) | PyAI Recap (opt-in) |
|---|---|---|
| Who writes notes | Your model, your prompt | PyAI Recap |
| Skills / account context | Yes | No — Recap takes no prompt |
| Citations | Model asserts `segment_ids` | We match quotes / overlap here |
| Gate can **delete** | Yes | No — a matched id always resolves; bad claims **flag** |
| Minutes | Hear + your LLM | Hear + Recap |
| How to pick | Default, or picker | `LLM_PROVIDER=recap` or **Notes engine** on upload |

Never auto-detected. A PyAI key exists on every machine. Detecting Recap from that would silently move everyone off Claude.

**Visual:** Shot K if you have it; otherwise this table.

**Say:** “The brief asked for a Hear + Recap loop. We have it. Claude remains the default because that is where the product’s central promise is strongest. Recap is labelled, not hidden.”

---

# Section D — What happens after the notes

## Slide 12 — Commitments that survive the next call

**On slide**

A verified next step becomes an **open commitment**.

The next call with that account is asked about each one, by id.

To close it, the model must **quote a line on this call**.
Silence closes nothing.

A person may close one with no quote — and the UI says a person did.

We always show the denominator.
**2 of 3** is a sentence. A bare 67% is not.

**Visual:** Shot E.

**Say:** “Only if the call on screen actually has carried-in items. Do not invent this beat. Recap does not judge carried commitments — another reason Claude is the default for accounts with history.”

---

## Slide 13 — Skills a salesperson can edit

**On slide**

Judgement lives in `skills/<id>/SKILL.md`.
Markdown. Not a string in TypeScript.

What counts as an objection.
When a commitment is real.
How to read last call’s promise.

They may say what to **look for**.
They may not supply words to **write**.
Borrowed vocabulary makes true claims fail the gate.

`npm run test:skills` enforces that.

**Visual:** A few lines from `skills/objection-taxonomy/SKILL.md` (money / authority / timing / competitor / trust / staying put).

**Say:** “The model is not allowed to invent the playbook in prose that then cannot be cited. Home page lists which skills were live.”

---

## Slide 14 — Deal score, from proof you already have

**On slide**

MEDPICC · BANT · SPICED · CHAMP · ANUM

Scored from **this call’s already-cited notes**.
Not a second read of the transcript.
Every chip here is inherited proof.

All five methodologies computed at ingest.
Switching the dropdown is instant. No new API call.

**Visual:** Shot F. MEDPICC criteria with cite chips.

**Say:** “This is not a second opinion from a model that never saw the gate. If a criterion has a citation, some other claim already earned it.”

---

## Slide 15 — Accounts and context

**On slide**

Setup holds the account: industry, stage, notes you typed.

That block **grounds** the model.
It is never allowed to be the **source** of a cited claim.

Learnings from earlier calls are a separate block.
A call is never grounded in conclusions drawn from itself.

Share links (`/s/{id}`) get **participants only**.
Deal value is not serialized into a forwarded page.

**Visual:** Setup / context panel. Or a simple “typed by a human / inferred from a call / never on a share link” triad.

---

## Slide 16 — CRM: the payload you can read

**On slide**

Exactly what a HubSpot note would contain.

- Real property names (`hs_note_body` is HTML)
- Every claim is a link to `/s/{share}#seg_014`
- Unverified claims left out and counted
- No `dealstage` write — those ids are per-portal GUIDs

**Nothing is sent.**
No HubSpot client. No credential.
A ship check fails the build if either appears.

**Visual:** Shot G. Keep “Nothing is sent” in frame.

**Say:** “The brief said no CRM sync, so we built the half you can read and argue with. Connecting JustCall and HubSpot is a plan, not this build.”

---

# Section E — Surfaces

## Slide 17 — Two ways in

**On slide**

**Web** — `npm run dev` → localhost:3000
Call list, upload, workspace, share, export.

**Terminal** — `./kg`
Pick a call. Type a number next to a citation. Hear that moment.
`./kg analyse ~/Downloads/call.wav`
`./kg analyse call.wav --engine recap`

Same harness. Same gate. Same receipts.

**Visual:** Shot A beside shot I.

**Say:** “The terminal UI is for a clone that has no patience for a browser. The mechanic does not change.”

---

## Slide 18 — Upload, URL, or samples

**On slide**

- File: wav / mp3 / m4a / flac / ogg
- **https URL to a file** — the server `GET`s bytes
- Five bundled calls — no key, no network

A Zoom / Meet / Teams **join** link will not transcribe.
A Loom **share page** is HTML, not audio.
Paste a **recording file** URL, or upload the download.

**Visual:** Upload card. Placeholder: `https://example.com/call.wav`

**Say:** “We fetch audio. We do not join meetings and we do not scrape player pages.”

---

## Slide 19 — Usage is honest

**On slide**

Top bar: **min transcribed · calls · tokens · claims blocked**

Bundled samples record **nothing**.
The number only moves when Hear (and a model / Recap) actually run.

`0.0 min` on a fresh clone is correct.
A counter that inflated itself would undercut the only thing we are selling.

**Visual:** Shot H + the minutes tile.

**Say:** “On stage, upload a real file early. Watch the tile tick. Then go back to a sample for the citation click.”

---

## Slide 20 — One-command setup

**On slide**

```bash
curl -fsSL https://raw.githubusercontent.com/AshmitGupta-slbs/king-gong-hackathon/main/install.sh | bash
```

Checks Node (needs **22.13+**).
Clones, installs, asks for keys, **proves the pipeline on a real call** before it says it worked.

Already cloned: `./setup.sh` then `npm run dev` or `./kg`.

No database server. No ffmpeg. No Python.
A sandbox key can mint itself — per-network allowance can run out.

**Visual:** The curl, large. Then the two surfaces.

**Say:** “22.13, not 22.5 — between those, `node:sqlite` is experimental and the first query throws. We test whether Node can actually do it, not just the version number.”

---

# Section F — Why it is trustworthy

## Slide 21 — The harness (seven parts)

**On slide**

Anyone can hit an STT endpoint. Trust is the loop around it.

| Part | Guarantee |
|---|---|
| Named loop | Every run ends shipped / partial / failed / deadline |
| Blocking gate | Bad citation → deleted and logged |
| Aimed retry | Capped; the gate’s complaint goes into the next prompt |
| Failure invariant | Row written *before* work; a kill still leaves a record |
| Registry | Provider swap is one config line |
| Safe parallelism | Different calls concurrent; one call’s writes serial |
| Budget governor | Tokens / time / dollars checked *before* the model call |

**Visual:** The table. Optional: `npm run verify` terminal.

**Say:** “Skip this slide for a non-technical room. For this company, this is the moat slide.”

---

## Slide 22 — Provenance is labelled

**On slide**

| Notes say | What that means |
|---|---|
| Claude / Bedrock | A model wrote them, under our prompt |
| Recap | A model wrote them; we attached citations; caveats shown |
| demo-fixture | Hand-authored for the demo; citations still went through the real gate |
| stub-heuristic | Keyword rules. Banner on. Never demo this |

We would rather a red `verify` on a clean clone than stub notes that look like a model.

**Visual:** The three banners / footers, honestly.

---

## Slide 23 — vs a per-seat suite

**On slide**

| | King Gong | A per-seat suite |
|---|---|---|
| Every claim has a source line | Blocking gate | Summaries are standard |
| Shows what it rejected | UI and Markdown export | Not something we have seen offered |
| Price | Usage on the APIs. No seats | Per seat, per month |
| Your keys, your repo | MIT. Swap a provider in one file | Closed |
| Time to first value | One curl, or a git clone | A sales cycle |
| Transcripts live | Your SQLite or Mongo | Their tenancy |

We have **not** benchmarked summary quality against Gong.
Do not put a quality score on this slide.

**Say:** “Per-seat scales with headcount. We scale with calls actually analysed. At enough volume, usage is not always cheaper.”

---

## Slide 24 — Cost, honestly

**On slide**

- **Hear** — per minute of audio
- **Notes** — one Claude/Bedrock call, or Recap on your PyAI key
- **Everything else** — zero seats, zero platform fee

Ten reps × four calls a week = you pay for **forty calls**, not ten seats.
Someone on holiday costs nothing.

**Where per-seat wins:** very high volume and a team that wants the whole suite.

**Visual:** Two columns: seats vs minutes.

---

# Section G — Honesty and close

## Slide 25 — What we are not

**On slide**

- Not a meeting bot. Nothing joins Zoom / Meet / Teams
- Not live CRM sync. The payload is readable; it cannot be sent
- Not JustCall auto-ingest (planned, not built)
- Not coaching, forecasting, or a deal board
- Not a daily dictation habit — this is a few calls a week

The product stops when the after-the-call job is done.

**Visual:** A short “out of scope” list. No logos implying sync.

---

## Slide 26 — Honest caveats

**On slide**

- Transcripts have almost no commas — Hear is unpunctuated; we will not let a model rewrite evidence
- Spoken numbers sometimes stay as words (`one four oh oh`); conversions are shown and must round-trip
- Mono speaker roles: first talker = the rep. The UI says so
- Sample audio is synthesised. No customer PII in a public repo
- Sample notes on a clean clone may still be hand-authored — the app says so
- Sandbox mint budget is **per network**
- Recap is a weaker product than Claude, and is labelled as one

**Say:** “Lead with the mechanic, not this slide. Use it if someone will call you on polish. It builds trust.”

---

## Slide 27 — What’s next (label: not built)

**On slide**

From the integration plan — **not this build**.

1. JustCall `call.completed` → recording in → same harness
2. Phone / email → HubSpot contact → deal
3. **Push notes** on a button, never automatically
4. Custom deal fields (`kg_intent`, commitments, competitors) — create once, update on push

Citation links survive into HubSpot. Unverified claims stay out. No `dealstage` write.

**Visual:** The four steps as a timeline. Stamp **PLAN** on the slide.

---

## Slide 28 — Close

**On slide**

```bash
curl -fsSL https://raw.githubusercontent.com/AshmitGupta-slbs/king-gong-hackathon/main/install.sh | bash
```

Five analysed calls. No signup.
Click a claim. Hear the moment.
Ask it to show you what it threw away.

**MIT. A git clone. Not a seat.**
Runs on PyAI.

**Visual:** Shot L + the curl. Footer: king-gong / PyAI.

**Say:** “Gong is fourteen hundred a seat. This is a git clone.”

---

# Appendix (optional slides)

## Slide 29 — Sample calls in the repo

| Call | Open it for |
|---|---|
| Bright Harbour / competitor-named | Competitor mention + receipts |
| Halcyon / heavy-objections | Gate + objection list |
| Cobalt / pricing-pushback | Numbers + spoken-digit honesty |
| Northwind / clean-close | Commitments / next steps |
| Verity / no-decision | Stalled deal; empty next meeting is a real state |

---

## Slide 30 — Demo script (5 beats)

| Beat | Time | Do |
|---|---|---|
| 0 | 15s | The sentence. Land on home. |
| 1 | 30s | Open Bright Harbour. Point at channel separation. |
| 2 | 45s | Upload a real file. Watch **min transcribed** move. |
| 3 | 90s | Click a citation. Play the line. Shut up. |
| 4 | 60s | Test the gate. Read a drop and a flag. |
| 5 | 45s | Export .md + CRM payload tab. `npm run test:harness` if there is time. |

If Hear 500s, say so and continue on a bundled sample.

---

## Slide 31 — Architecture (one slide)

**On slide**

```
app/(app)          UI: list, setup, workspace
app/api/calls      ingest (file or https file URL)
lib/harness        loop, gate, retry, budget, lock
lib/registry       Hear · Claude · Bedrock · Recap · fixtures
lib/skills         SKILL.md → extract prompt
lib/action-items   commitments across calls
lib/scoring        MEDPICC… from gated notes
lib/crm/payload    HubSpot document — no client
lib/db             SQLite default · Mongo if MONGODB_URI
./kg               same product in the terminal
```

Vendor SDKs live only under `lib/registry/providers/`.
`check:ship` fails the build if that boundary moves, or if a HubSpot client appears.

---

## Slide 32 — Verify

**On slide**

```bash
npm run verify          # gate, harness, skills, readability, ship checklist
npm run test:store      # storage contract — needs a backend
npm run check:key       # is Hear alive
npx tsx scripts/probe/recap-probe.ts
./setup.sh              # keys + a real end-to-end run
```

The suites force the failure. They do not just read the code.

---

## Slide design

- Dark or the app theme. `docs/king-gong.png` is the visual system
- One idea per slide. Title ≤ 6 words if you can
- Recurring motif: citation chips `seg_014 · 1:12`
- Footer on every slide: **King Gong — deal notes with receipts**
- Section divider slides (A–G) are optional; delete them if the deck feels long
- Never project a HubSpot or JustCall logo as if sync is live

## What not to put in the deck

- A quality score vs Gong
- “We connect JustCall and HubSpot” in the present tense
- A screenshot with **STUB EXTRACTOR**
- Loom / Zoom join links as a supported ingest path
- Internal file paths except on slides 21 and 31
- Any API key, even masked, on a projected screen
