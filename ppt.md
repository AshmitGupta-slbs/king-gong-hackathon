# King Gong — slide script

Use this file to build a deck. Each `## Slide` is one slide: **on-slide copy** is what to type,
**Visual** is what to show, **Say** is the speaker note. Do not paste the Say block onto the slide.

**Recommended length:** 14 slides (~8 minutes). If you only have 5 minutes, use slides 1, 2, 4, 5,
7, 8, 14.

**Tone:** one idea per slide, short lines, no paragraphs on the glass. This product’s pitch is a
*mechanic*, not a feature list — spend time on “click the claim, hear the moment” and “we show you
what we threw away.” Do not read a summary aloud. Every competitor has one.

**Do not claim as shipped:** JustCall ingest, HubSpot push, live CRM sync. Those are in `plan.md`
only. The CRM tab today is a **preview** of what a push would post.

**Screenshots to capture** (run `npm run dev`, open a sample call — `heavy-objections` or
`competitor-named`):

1. Home — “Deal notes with receipts” + call list + upload
2. Call workspace — transcript left, notes right, a citation chip selected
3. Player jumped to a segment, line pulsing
4. “What the citation gate rejected” panel
5. Action items / commitments (if the call has them)
6. CRM payload tab after “Show the payload”
7. Home footer — “What actually ran”

---

## Slide 1 — Title

**King Gong**
Deal notes with receipts.

Gong is ~$1,400 a seat.
The job after a call is three questions.

**Visual:** Product wordmark. Optional: `docs/hero.png` (transcript left, cited notes right).

**Say:** “Gong charges about fourteen hundred dollars a seat. After a call the job is three
questions: what happened, what did they push back on, what do I do next. King Gong does that job.
The difference is every line in the notes points at the moment in the call that proves it.”

---

## Slide 2 — The problem

Every notes tool will write you a summary.

A confident paragraph about “budget concerns” is worthless if nobody can find where they said it.

Worse if they never did.

**Visual:** One fake summary bubble vs a blank “where?” — or just the three lines, large.

**Say:** “Summaries are table stakes. The failure mode is a fluent sentence with no source. You
cannot tell which sentences are real. That is the problem we built for — not prettier notes.”

---

## Slide 3 — What it is

**One job.** After a call:

1. What happened
2. What they pushed back on
3. What I do next

…and **prove every line** against the recording.

Not a suite. No coaching dashboards. No forecast rollups. No deal board.

**Visual:** Three numbered questions. Strike-through list of suite features we are not.

**Say:** “If you need inspection, forecasting and coaching, buy the suite. This is for the case
where the notes *are* the job — and they have to be auditable.”

---

## Slide 4 — The rule

# No proof, no claim.

- Every objection, next step, intent label and follow-up email cites a real transcript line
- A claim citing a line that does not exist is **deleted**, not softened
- A claim whose line exists but does not support it ships **flagged**
- We **show you what we threw away**

**Visual:** Four rules as a vertical stack. Bold the last one.

**Say:** “That last one is the whole pitch. Ask any other tool in this category to show you its
rejected claims.”

---

## Slide 5 — The demo moment

Click a claim.
The audio jumps to that second.
The transcript line pulses.

The quote under the claim is pulled from the transcript — not written by the model.

**Visual:** Screenshot 2 + 3. Circle the citation chip (`seg_003 · 0:18`).

**Say:** “This is the slide you should *leave* and go live. Open a call, click an objection, stop
talking while the five seconds play. That silence is when the room gets it. Do not narrate the
summary.”

**Live instead of this slide if you can.** Keep the slide as backup if the network dies.

---

## Slide 6 — What you get after a call

| You see | What it is |
|---|---|
| Transcript | Speakers named. Stereo = exact (one party per channel). Mono = diarizer, first speaker = rep |
| Summary | What happened — still cited |
| Objections | Pushback, each with a receipt |
| Intent | A label, only if a line supports it |
| Next steps | Commitments the call actually made |
| Follow-up email | Drafted from verified claims |
| Timeline markers | Competitor, pricing, objections on the scrubber |
| Rejections | First-class panel, not an error state |

**Visual:** Screenshot of the workspace, or this table cleanly set.

**Say:** “Walk one call deeply. Do not click through four. `heavy-objections` and `competitor-named`
have the most material.”

---

## Slide 7 — The citation gate

Two checks, before anything reaches you.

1. **Does the citation resolve?** `seg_412` does not exist → **dropped**, logged with a reason
2. **Does the line support the claim?** Score below 0.18 → ships **flagged**, not mixed in

You can press **Test the gate** on any call. It feeds hand-written claims — some citing lines that
do not exist — through the *same* function production uses.

**Visual:** Screenshot 4. Two example rows:

- “Legal has already blocked the purchase” → `seg_412` → Dropped
- “Signed PO is in place” → real segment, support 0.00 → Flagged

**Say:** “Those demo claims are hand-written. We will not fake a hallucination on stage. What is
real is the gate.”

---

## Slide 8 — Commitments that survive the next call

A verified next step becomes an **open commitment**.

The next call with that account is asked about each one, by id.

To close it, the model must **quote a line on this call**. Silence closes nothing.

A person may close one with no quote — and the UI says a person did.

We always show the denominator. “2 of 3” is a sentence. A bare 67% is not.

**Visual:** Screenshot 5, or `2 / 3 kept` with one open row and one quoted tick.

**Say:** “Only if the call on screen actually has carried-in items. Do not invent this beat.”

---

## Slide 9 — How a call is analysed

```
audio  →  PyAI Hear  →  segments  →  Claude  →  draft  →  GATE  →  notes
          speakers      seg_000…     schema     untrusted   drop/flag    + receipts
```

1. Transcribe. Segment ids assigned **once**, here — never by a model
2. Extract. Schema-forced. No parse-and-repair loop
3. Gate. Resolve, then support
4. Ship as `shipped` · `partial` · `failed` · `deadline`. Never nothing

**Visual:** The pipeline as four boxes. Mark the draft as untrusted.

**Say:** “Anyone can call a transcription API. The product is the gate sitting between a fluent
model and a human.”

---

## Slide 10 — Features around the notes

**Upload** — file or https URL. Auto reads the WAV: true two-party stereo gets exact channel
separation; everything else diarizes.

**Accounts** — Setup holds company context. It grounds the model; it is never allowed to be the
source of a cited claim.

**Skills** — `skills/*/SKILL.md`. What counts as an objection, when a commitment is real. Markdown a
salesperson can edit. They may say what to *look for*, not what words to *write*.

**Share link** — `/s/{id}`. Recipients get the transcript and citations. Not the deal value.

**Export** — Markdown you can paste, quotes and timestamps inline, rejections in a table at the
bottom. JSON is the verbatim transcript.

**Usage bar** — minutes only move when work happens. Bundled samples burn nothing. `0.0 min` on a
fresh clone is correct.

**Visual:** Six small icons or a 2×3 grid. No architecture diagram.

---

## Slide 11 — CRM: the payload you can read

We will show you **exactly** what a HubSpot note would contain.

- Real property names (`hs_note_body` is HTML)
- Every claim is a link back to `/s/{share}#seg_014`
- Unverified claims are left out and counted
- No `dealstage` write — those ids are per-portal GUIDs

**Nothing is sent.** There is no HubSpot client and no credential. A ship check fails the build if
either appears.

**Visual:** Screenshot 6 — CRM payload JSON, plus the “Nothing is sent” banner.

**Say:** “The brief said no CRM sync, so we built the half you can read and argue with. Connecting
JustCall and HubSpot is a plan, not this build.”

---

## Slide 12 — Why not just buy Gong?

| | King Gong | A per-seat suite |
|---|---|---|
| Every claim has a source line | Yes — blocking gate | Summaries are standard; per-claim receipts are not the norm |
| Shows what it rejected | Yes — UI and export | Not something we have seen offered |
| Price | Usage on the APIs. No seats | Per seat, per month |
| Your keys, your repo | MIT. Swap a provider in one file | Closed |
| Time to first value | `npm i && npm run dev` | A sales cycle |
| Transcripts live | Your SQLite (or Mongo) | Their tenancy |

We have **not** benchmarked summary quality against Gong. Do not put a quality score on this slide.

**Visual:** The table. Highlight the “rejected claims” row.

**Say:** “Per-seat scales with headcount. We scale with calls actually analysed. At enough volume
usage is not always cheaper — we are not going to pretend it is.”

---

## Slide 13 — The harness (for a technical room)

Seven parts. All load-bearing. All tested by forcing the failure.

| Part | What it guarantees |
|---|---|
| Named loop | Every run ends `shipped` / `partial` / `failed` / `deadline` |
| Blocking gate | Bad citation → deleted and logged |
| Aimed retry | Capped; the gate’s complaint goes into the next prompt |
| Failure invariant | Run row written *before* work; a killed process still leaves a record |
| Registry | Provider swap is one config line |
| Safe parallelism | Different calls concurrent; one call’s writes serial |
| Budget governor | Tokens / time / dollars checked *before* the model call |

`npm run verify` — 252 checks + a 27-item ship checklist.

**Visual:** The table, or a terminal screenshot of `npm run verify` passing (after
`extract:samples` if you have a model key).

**Skip this slide** for a non-technical audience. Go to 14.

---

## Slide 14 — Try it

```
git clone <repo>
npm install
npm run dev
```

Open localhost:3000. Five analysed sample calls are already there.

No signup. No database to install. A PyAI sandbox key mints itself on the first *live* upload.

**MIT. A git clone. Not a seat.**

**Visual:** The three commands, large. Screenshot 1 behind them if it still reads.

**Say:** “Sample audio is synthesised — no customer PII in a public repo. Sample notes on a clean
clone were written by hand; the app says so. The citations still went through the real gate.”

---

## Optional slides (cut unless asked)

### A — Honest caveats

Use if someone will call you on polish. Builds trust; do not lead with it.

- Transcripts have almost no commas — Hear returns unpunctuated text; we will not let a model
  rewrite evidence
- Spoken numbers sometimes stay as words (`one four oh oh`); we only convert when it round-trips
- Mono speaker roles: first talker = rep. The UI says so
- Sandbox key allowance is **per network** and can run out on shared wifi
- `npm run verify` is red on a clean clone until `extract:samples` with a real model key

### B — What’s next (roadmap — label it)

From `plan.md`. Say “not built” on the slide.

1. JustCall webhook → recording in, same harness
2. Match phone/email → HubSpot contact → deal
3. **Push notes** on a button, never automatically
4. Custom deal fields: `kg_intent`, commitments, competitors — create once, update on push

### C — Sample calls in the repo

| Call | Why open it |
|---|---|
| Bright Harbour / competitor-named | Competitor mention + receipts |
| Heavy objections | Gate and objection list are richest |
| Pricing pushback | Numbers + “one four oh oh” honesty |
| Clean close | Commitments / next steps |
| No decision | Stalled deal; next meeting empty is a real state |

---

## 5-minute cut

| Min | Slide / live | Beat |
|---|---|---|
| 0:00 | 1 | The sentence |
| 0:20 | Live home | Zero setup, five calls |
| 0:50 | Live upload *or* skip if wifi is bad | Usage counter moves |
| 1:30 | Live call | Click a citation, play the line, shut up |
| 3:00 | Live | Test the gate — read a drop and a flag |
| 4:00 | 11 or live CRM tab | Payload you can read, cannot send |
| 4:30 | 14 | Clone it |

---

## Slide design notes

- Dark or the app’s own theme (`docs/hero.png` is the visual system)
- One claim per slide; 6 words in the title if you can
- Citation chips (`seg_014 · 1:12`) as a recurring motif
- Never put API keys, `.env`, or portal ids on a slide
- Never put a HubSpot “sync” logo as if it is live
- Footer on every slide: **King Gong — deal notes with receipts**

## What not to put in the deck

- A quality score vs Gong
- “We connect JustCall and HubSpot” as a present-tense feature
- The stub extractor — if that badge is on, do not screenshot it
- Internal file paths except on slide 13
- The PyAI sandbox key, even masked, on a projected screen
