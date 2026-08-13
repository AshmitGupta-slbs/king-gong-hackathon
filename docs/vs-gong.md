# OpenGong Lite vs. buying a conversation-intelligence suite

The launch kit asks for a side-by-side against the paid tool. Here it is — with a rule: **we only
claim things about our own product that a reader can verify in this repo, and we do not invent
details about anyone else's.**

That constraint is not modesty. This whole product argues that unverifiable claims are worthless. A
comparison table full of confident red crosses against a competitor we have not audited would be
exactly the thing we are criticising.

---

## What this actually replaces

Gong, Fireflies and Avoma are conversation-intelligence *suites*: recording, transcription,
summaries, coaching workflows, deal boards, forecast rollups, a UI a sales team lives in.

OpenGong Lite does **one job**: after a call, tell me what happened, what they pushed back on, and
what I do next — and prove every line of it against the recording.

If you need deal inspection, forecasting and coaching dashboards, buy the suite. That is a real
answer, and the [PyAI guide](https://docs.pyai.com/guides/conversation-intelligence) says the same.
This is for the case where the notes *are* the job.

---

## Where we are genuinely different

| | OpenGong Lite | A per-seat suite |
|---|---|---|
| **Every claim carries its source line** | Yes — enforced by a blocking gate; unprovable claims are deleted, not softened | Summaries are standard; per-claim citation into the transcript is not the norm |
| **Shows you what it rejected** | Yes — rejected claims are in the UI *and* the Markdown export | Not something we have seen offered |
| **Pricing model** | Usage-based on the underlying APIs. No seats. | Per seat, per month |
| **Runs on your own keys** | Yes — swap any provider in one config file | No |
| **Source available** | MIT, entire pipeline | No |
| **Time to first value** | `npm install && npm run dev`, ~11 seconds measured, no signup | Sales cycle |
| **Your transcripts live** | In your SQLite file | In their tenancy |

### The one that matters

Every tool in this category will write you a summary. **None of them will show you the line the
summary came from, and none of them will show you what they threw away.**

That is not a feature gap, it is a difference in what the product is willing to promise. A summary
you cannot audit is a confident guess. Ours is auditable by construction: click any claim, hear the
five seconds of call that produced it.

---

## Cost, honestly

Per-seat pricing for this category runs from roughly **$17–18/user/month** for meeting-notes tools up
to **four figures per seat per year** for full revenue-intelligence suites. (Figures quoted in the
PyAI Hackathon brief, mid-2026, from advertised pricing. Check current pricing yourself — we are not
going to pretend to a precision we do not have.)

Our cost is whatever the APIs charge:

- **Speech-to-text**: PyAI Hear, per minute of audio, batch rate.
- **Notes**: one model call per call, on your own key or your own AWS account.
- **Everything else**: zero. No seats, no platform fee, no per-user anything.

The shape of the difference is what matters, not the exact numbers. Per-seat cost scales with
**headcount**; usage cost scales with **calls actually analysed**. If ten reps each take four calls a
week, you pay for forty calls, not ten seats. If someone goes on holiday, you pay nothing for them.

**Where per-seat wins:** very high call volume per rep with a tolerance for flat, predictable
billing, and a team that wants the whole suite. We are not going to pretend usage-based pricing is
always cheaper — at enough volume it is not.

---

## What we are explicitly not claiming

- We have not benchmarked our summary quality against Gong's. Nobody should believe a vendor's own
  quality claim, including ours.
- We have not audited any competitor's feature list for this document. Where the table above says
  "not the norm" or "not something we have seen", that is exactly as strong as it sounds.
- This is not a suite. No coaching workflows, no deal boards, no forecasting, no CRM sync.
- Our transcripts arrive lowercase and uncommaed, because that is what the speech API returns.
  See the caveats in the README — all of them are in the README, which is the point.

---

## The pitch in one paragraph

Every paid notes tool is speech-to-text, a language model and a loop. We own the loop, the speech
API is metered per minute, and the code is MIT. So instead of paying per seat for a summary you have
to take on faith, clone a repo and get notes where every line points at the moment in the call that
proves it — including the lines it refused to write.
