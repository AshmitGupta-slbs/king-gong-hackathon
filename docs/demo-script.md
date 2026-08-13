# Demo script — 5 minutes, 5 beats

Runs on the **real setup path**: `npm run dev`, browser at `localhost:3000`. No shortcuts only one
person knows. Rehearse it twice, timed, before Friday.

**Before you start:** have a second terminal open, and one short stereo call file ready on the
desktop for beat 2. Reset state with `rm -rf data/` if you want the usage counter to start at zero.

---

## Beat 0 — the sentence (15s)

> "Gong charges about fourteen hundred dollars a seat. The job it actually does after a call is
> three questions: what happened, what did they push back on, what do I do next. We built that. The
> difference is that every line in our notes points at the moment in the call that proves it."

Land on the home page while saying it. Don't narrate the UI.

---

## Beat 1 — zero setup (30s)

> "This is a clone of the repo. No key, no signup, no database. Five real calls already analysed."

Click **Bright Harbour Software — competitive evaluation**.

Point at the header: `1:11 · 10 segments · separation: channel`.

> "Ten segments, speakers separated exactly — one party per channel, no diarization model guessing."

---

## Beat 2 — make the counter move (45s)

**Do this early**, because it is the one number people assume is fake.

Go back home, drag your own call file into the upload card, pick the right separation mode, hit
**Analyse call**.

> "That is going to PyAI Hear right now. Watch the top right."

When it lands, point at the header: minutes and calls have both increased.

> "That is real. Loading a bundled sample records nothing, because replaying a cached file burns
> nothing. The number only moves when work actually happens — a usage counter that inflated itself
> would undercut the only thing we are selling."

---

## Beat 3 — the receipts (90s) ← **this is the demo**

Back on a sample call. Press play, let two lines go by so the highlight tracking is visible.

> "Transcript follows the audio. Now look at the notes."

Point at an objection. Then click its citation chip — `seg_003 · 0:18`.

> "I clicked the claim. It jumped the audio to the exact second, and highlighted the line."

Let the audio play those few seconds out loud. **Stop talking while it plays.** That silence is the
moment the room gets it.

> "Every objection, every next step, the intent label, the follow-up email — all of it carries the
> line it came from. And the quoted text under each claim is pulled from the transcript, not written
> by the model. The model summarises; the evidence comes from the call."

Point at the amber markers on the scrubber.

> "Flagged moments, plotted on the timeline. Competitor mentions, pricing, objections."

---

## Beat 4 — the gate, live (60s)

> "Here is the part nobody else in this category will show you."

Click **Test the gate**.

> "That just fed hand-written claims through the real citation gate. Some of them cite segments that
> do not exist."

Scroll to **What the citation gate rejected**. Read two rows out loud:

> "'The prospect said their legal team has already blocked the purchase' — cited seg_412, no such
> segment. **Dropped.** Not softened, not hedged — deleted, and logged with the reason.
>
> And this one is subtler: 'The prospect confirmed a signed purchase order is in place.' It cited a
> segment that *does* exist — but the line does not support it. Support score 0.00 against a 0.18
> threshold. So it ships **flagged**, not silently mixed in with the verified claims."

Point at "claims blocked" in the header, now higher.

> "To be straight with you: those claims are hand-written, not a real hallucination. We are not going
> to fake a hallucination on stage and we are not going to wait for one. What is real is the gate,
> and it is the same function the production path calls."

---

## Beat 5 — the close (45s)

Click **Export .md**, open the file.

> "Notes you can paste into the CRM, with the quotes and timestamps inline — and a table at the
> bottom of everything the gate rejected. We publish our own rejections. Ask any other tool in this
> category to do that."

Then, in the terminal:

```bash
npm run test:harness
```

> "Sixty checks across the gate and the harness. Budgets stop runs before the spend, retries are
> capped and carry the failure reason forward, and no run can vanish without leaving a record —
> including if you kill the process mid-run."

> "MIT, public, one `npm run dev`. A PyAI sandbox key mints itself. Gong is fourteen hundred a seat;
> this is a git clone."

---

## If something breaks

| Symptom | Do this |
|---|---|
| Upload fails / PyAI errors | Say so plainly, then carry on with a bundled sample. The point is the citation mechanic, not the network. |
| Counter reads `0.0 min` | Correct on a fresh clone — explain why (beat 2). Don't apologise for it. |
| Audio will not autoplay | Press play manually once first; browsers block autoplay until a user gesture. |
| Notes look thin on a call | Use `heavy-objections` or `competitor-named` — they have the most material. |

## Do not

- Do not demo with the **STUB EXTRACTOR** badge showing. If it is visible, notes came from keyword
  rules, not a model — `npm run check:ship` will refuse to pass. Fix the credential first.
- Do not read the summary paragraph aloud. Summaries are table stakes; every competitor has one.
  Spend the time on citations and the gate.
- Do not click through four calls. One call, deeply, beats four calls skimmed.
