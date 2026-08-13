# Scorecard — King Gong against the hackathon rubric

**This build is scoring itself.** Treat every number below as a claim by an interested party. What
makes it worth reading anyway is that each one names the file or the command that produces it, so
you can check any line you doubt in under a minute. Where the evidence is an opinion rather than a
fact, it says so.

The brief's last build step asks for exactly this document: *"Final gut-check against the scorecard
— go criterion by criterion and name where you're weak, with evidence. Don't be diplomatic about
it."* So this is not a pitch. The weak parts are named, and the last section says which one gets the
remaining time.

Counts were taken by running the suites, not by reading them:

```bash
npm run verify        # the four suites + the ship checklist
npm run test:store    # storage contract, not part of verify
```

---

## The rubric

| Criterion | Weight | Self-score | |
|---|---|---|---|
| Product pull | 30% | **26** | The citation mechanic is real and it holds |
| Demo magnetism | 25% | **19** | The moment exists; the rehearsal does not |
| API gravity | 20% | **12** | ⚠️ Weakest. One PyAI product, and a demo that burns nothing |
| Loop depth | 15% | **14** | Seven parts, all load-bearing, all tested |
| Craft | 10% | **8** | Code would survive a hostile read. Docs, until today, would not |
| | | **79 / 100** | |

---

## Product pull — 30% → **26**

> *"Would a stranger switch to this tomorrow?"* The reference is explicit that this is answered by
> the citation mechanic, **not** summary quality: *"summaries are table stakes; every competitor
> already has one."*

**What holds.** Every claim carries `segment_ids`, and `lib/harness/gate.ts` resolves them against
the transcript before anything ships. A claim citing a line that does not exist is **deleted**, not
softened. Timestamps and quoted text are read from the segment, never from the model's prose
(`gate.ts`, `verifyCitations`). Click a citation and the audio seeks to that second.

Three things go further than the brief asked:

- **The rejections are published.** What the gate threw away is a first-class panel in the UI and a
  section in the Markdown export, not an error state. Most products hide this.
- **Unverified claims ship flagged rather than dropped**, with the support score visible, so the
  product never lies by omission either.
- **Commitments carry between calls and can only be closed by evidence.** A model marking a prior
  action item done must quote the line on *this* call that says so; if it cannot, the item stays
  open. A person may close one, and the UI says a person did, showing no line — because there is no
  line. `lib/action-items.ts`, `components/workspace/ActionItems.tsx`.

**What a stranger actually meets on their first run, which is the question being asked.**

1. The five bundled sample notes were **hand-authored**, not model-written. The app says so in three
   places and `extracted_by` reads `demo-fixture`. That is honest — and it means the first notes a
   stranger reads are not a demonstration of the product's own extraction.
2. `npm run verify` **fails on a clean clone**, on the provenance gate, for the reason above. A
   stranger evaluating a repo often runs the test command first. A red is a bad first impression
   even when the red is the project holding itself to its own standard.

Both are fixed by one command with a real credential: `npm run extract:samples`.

**−4.** Not for the mechanic, which is the strongest thing here, but for a first run that shows
hand-written notes and a failing test command.

---

## Demo magnetism — 25% → **19**

> *"Did the room go 'oh damn'?"* Earned by one visual moment, **rehearsed and timed on the real
> setup path**.

**The moment exists, and it is the one the reference predicted.** The build reference names
click-a-citation-and-the-audio-jumps as *"the single feature most likely to be your demo's 'oh
damn'"*. It works, it is instant, and the transcript scrolls to the line and pulses it.

**The harness has a stage moment too.** "Test the gate" on any call feeds hand-written claims —
including deliberately fabricated citations — through the real gate and shows what it dropped. That
is the brief's own advice for making Loop depth visible, and it is a button rather than a terminal
command.

**A third, new.** The CRM payload tab shows the exact JSON a HubSpot push would post, every claim
carrying a link back to the moment that proves it — and the app cannot send it. "Here is precisely
what we would write into your CRM, and here is the check that fails the build if anyone adds a way
to send it" is a strong close.

**What is missing, and it is the thing the brief warns about most.**

- **The demo has never been rehearsed or timed.** `scripts/check-ship.ts` prints this itself as
  something it does not cover: *"run the demo twice, on the real setup path"*. Not done.
- **`docs/hero.png` — the README's flagship image — shows the stub-extractor banner.** This project's
  own demo script forbids exactly that: *"Do not demo with the STUB EXTRACTOR badge showing."* The
  first image a stranger sees breaks the rule the repo wrote. It also predates the CRM payload tab
  and the action-items card, so it shows a UI that no longer exists.

**−6.** The material is there. The rehearsal is not, and the one image everybody sees is wrong.

---

## API gravity — 20% → **12** ⚠️ the weakest criterion

> *"Does daily use burn minutes?"* Earned by a visible live minutes counter plus a shape that gets
> used daily.

**The counter is real and honest.** Top bar, unmissable, counting audio seconds, tokens, calls and
claims blocked — and `components/UsageBar.tsx` states the rule it follows: replaying a committed
sample records **nothing**, so the number only moves when work actually happens. A counter that
inflated itself would undercut the one thing this product sells.

**Then three things count against it, and they are not small.**

**One PyAI product, not two.** The portfolio slide specifies this build's surface as a **"Hear +
Recap loop"**. Hear is genuinely used for every upload. **Recap is not used at all** — extraction
runs on Claude via the Anthropic API or Bedrock. The reason is real and documented in
`lib/registry/providers/claude-extract.ts`: the sandbox key carries neither `recap:read` nor
`recap:configure`, Recap needs an org add-on, and PyAI's own conversation-intelligence guide says to
bring your own model for free-form extraction. Defensible. Still one product where the brief
specified two.

**Speak is coded and switched off.** `lib/registry/providers/pyai-speak.ts` exists, is tested, and
would burn Speak minutes — but the default is `macos-say` because Speak returned `503
upstream_error` across three model ids and two response formats during the build (`docs/api-truth.md`).
So in practice nobody burns Speak minutes. And TTS is sample-generation only; it is never on the
request path.

**The zero-setup demo burns nothing.** This is the honest cost of the ship checklist. Sample calls
replay from committed JSON with no network, which is what makes setup work with no key — and it
means a judge who clicks through the demo sees `0.0 min`. The counter only moves if somebody uploads
a real file, which is demo beat 2 and takes a live key.

**And the shape is per-call, not daily.** The brief's own model of gravity is dictation — hit dozens
of times a day. Deal notes are a few times a week. Action items pull a rep back between calls, which
helps, but does not make this a daily habit.

**−8.** One of two products, a demo that burns nothing by design, and a weekly rather than daily
shape.

---

## Loop depth — 15% → **14**

> *"Do the gates actually block bad output?"* Earned by all seven harness parts being real.

All seven exist as named files with a stated contract, and each has a section in the test suites.
They are enumerated in one place, `lib/harness/loop.ts`:

| Part | Where | What proves it |
|---|---|---|
| One named loop | `lib/harness/loop.ts` | Four exits — `shipped` · `partial` · `failed` · `deadline`. `status` initialises to `failed`, so an unhandled path still ends named |
| Blocking gate | `lib/harness/gate.ts` | Tier 1 deletes, tier 2 flags. 37 checks in `test:gate`, plus a live button |
| Bounded aimed retry | `lib/harness/retry.ts` | Capped at 2; the gate's own complaint is fed into the next prompt |
| Failure invariant | `lib/harness/loop.ts` + `lib/db.ts` | Row written *before* work, closed in `finally`; orphans reconcile to `failed` on page load |
| Capability registry | `lib/registry/index.ts` | One file to swap a provider; an unknown value **throws** rather than falling back |
| Safe parallelism | `lib/harness/parallel.ts` | Per-call lock; independent reads run concurrently |
| Budget governor | `lib/harness/budget.ts` | Tokens, wall clock and dollars checked **before** each call; breach exits `deadline` |

**Two things worth pointing at specifically.**

The gate's asymmetry is deliberate and documented: list claims with unresolvable citations are
dropped, singleton deliverables are flagged and force `run_status: partial`. That is a design
decision someone made on purpose, not a default.

The budget governor was **wrong until recently and is now right**. It estimated input tokens from
the transcript alone, ignoring the system prompt and every context block — 14 estimated tokens
against a real prompt of 980 on a two-line call. It now sizes the message actually sent. A cap that
cannot see the text it is capping is not a cap.

**−1.** `npm run verify` does not include `test:store` (66 checks), because that needs a configured
backend. Reasonable, but it means "the one command" is not literally everything.

---

## Craft — 10% → **8**

> *"Would we be proud of this code in public?"*

193 files, 17,317 lines of TypeScript, 47 commits. Five test suites totalling **252 checks**, plus a
27-item ship checklist, plus four operational checks (`check:key`, `check:model`, `check:store`,
`test:store`).

The code carries its reasoning. Comments explain *why*, including the mistakes: why `node:sqlite`
over `better-sqlite3`, why an unknown provider throws instead of falling back, why a new table
rather than a new column, why the share route extracts one field instead of hiding the rest. Several
comments document bugs that were found and fixed rather than quietly patched.

Boundaries are enforced rather than asserted. `check:ship` fails the build if a vendor SDK is
imported outside `lib/registry/providers/`, if a `process.env` read under `lib/` is undocumented, if
a credential appears in a committed file, or — since the CRM payload — if a HubSpot client or token
appears anywhere.

**−2, and it is the documentation.** Until this commit the README pointed at `lib/harness/runlog`,
which does not exist; gave the wrong path for the call page; omitted nine of nineteen scripts and the
entire `skills/` and `lib/store/` trees; and carried check counts that matched neither the code nor
the docs site. The docs site was four commits stale and its generator would have re-stamped the old
product name across all ten pages on the next build. Fixed now — but "would we be proud of this in
public" is a question about the whole artefact, and a stranger reads the docs first.

---

## Ship checklist — pass/fail, no partial credit

| # | Item | | Evidence |
|---|---|---|---|
| 1 | MIT license, public repo | **PASS** | `LICENSE` (MIT, SaaS Labs 2026), `package.json` `"license": "MIT"`, repo public |
| 2 | Five-minute setup that takes five minutes | **PASS\*** | Three commands. No native compilation — `node:sqlite`, no `node-gyp`. Cold start with zero credentials works: the extractor auto-detects down to the keyword stub |
| 3 | Sample data, demo needs zero setup | **PASS** | Five calls: audio in `public/samples/`, transcripts and notes in `samples/`. Seeded on first page load with no key and no network |
| 4 | One killer screenshot in the README | **PASS** | `docs/hero.png`, 2560×1440 — but see Demo magnetism; it shows a state the demo script forbids |
| 5 | Sandbox key mints itself, no manual steps | **PASS** | `lib/pyai.ts` — unauthenticated `POST /sandbox/keys`, cached, one attempt per process, and a named remedy when the allowance is gone |
| 6 | Clear exits, gates, capped retries, budgets | **PASS** | All seven parts — see Loop depth |

**\* The asterisk on item 2 is the brief's own condition and it has not been met.** The requirement
is a setup *"tested on a machine you haven't touched, not your dev laptop"*, timed, with someone who
has not seen the code. That test has not been run. Everything suggests it would pass — three
commands, no native deps, no credential needed — but the checklist item asks for evidence, and
"we're fairly sure" is not evidence. One genuine risk a clean machine would expose: Node must be
≥22.5, and on an older Node the app boots and then fails on the first query.

---

## Scope

The MVP scope is met: upload or paste a link · transcript with speaker roles · summary, objections,
intent, next steps and follow-up email, all cited · export to Markdown, JSON and a share link · five
sample calls, demo in seconds.

**One item is softer than it reads.** "Transcript with speaker names" ships speaker **roles** — rep
and prospect — exact for stereo where each party has a channel, and an explicitly stated heuristic
for mono (whoever speaks first is the rep). Real human names appear only when a CRM record supplies
them. The UI always shows which mode produced the labels, so nobody mistakes the heuristic for a
fact, but this is roles rather than names.

### 🚩 Scope creep, flagged as the brief requires

The brief lists **"no CRM sync"** among the things explicitly out of scope, and instructs: *"if a
request would add one of these, flag it as scope creep against the ship checklist rather than
building it quietly."*

**A CRM payload preview was built. This flag is that flag, and it is late.**

What was built is not a sync. There is no HubSpot client, no credential, and no code path that could
reach a portal — and `check:ship` now fails the build if any of those appear, which is a stronger
guarantee than the original scope line asked for. The feature answers "what would we send?" without
being able to send it, and it was scoped that way deliberately after checking a live portal's schema.

The letter of the rule holds. The instruction was still to raise the flag before building, and that
did not happen; it was recorded in a commit message instead. Recording it here is the correction.

### Divergence from the reference: where the skills went

The build reference anticipated an `opengong-lite-builder.skill` installed into `.claude/skills/` —
a skill for the *tool building the product*. This repo has no such file. It instead put skills at
**runtime**: `skills/<id>/SKILL.md`, six files, loaded into the extraction prompt itself, so the
judgement about what counts as a real objection lives in markdown a salesperson can edit.

Deliberate, and chosen over the builder-skill reading. Recording it as a divergence rather than
presenting it as compliance.

---

## The seven ways teams lose points

The brief lists these as warnings the reference raises about itself. Scored honestly:

| # | Pitfall | |
|---|---|---|
| 1 | Chasing polish, skipping the invisible 35% | **Half-avoided.** Loop depth is the second-strongest score. API gravity is the weakest — exactly the trap, half-sprung |
| 2 | Great summaries, loose citations | **Avoided.** The citations are the product; the summary is the one field explicitly *not* required to cite |
| 3 | A five-minute setup that only works on your laptop | **Unproven.** No native deps and no credential needed, but the clean-machine test has not been run |
| 4 | Bolting the harness on at hour 28 | **Avoided.** The harness is the spine; the gate predates most of the UI |
| 5 | Letting the schema drift | **Avoided.** One `lib/types.ts`, Zod as the source of truth, `check:ship` enforcing that nothing else defines a claim |
| 6 | Quietly building the out-of-scope thing | **Partly hit.** See the CRM flag above — built carefully, flagged late |
| 7 | Marking checklist items done that aren't | **This document is the attempt to avoid it.** Item 2 carries an asterisk for that reason |

---

## The weakest thing, and what to do about it

**API gravity, 12/20.** It is the lowest score, it is 20% of the total, and it is the one the brief
warns is easiest to under-invest in because it never shows up in a screenshot.

Three fixes, in order of value per hour:

1. **Run one real extraction over the samples** — `npm run extract:samples` with the Bedrock
   credential already configured on Railway. This single command makes the bundled notes
   model-written, clears the only red in `npm run verify`, moves the token counter off zero, and
   unblocks a hero screenshot that does not show the stub banner. It raises Product pull, Craft
   *and* Demo magnetism at once, and it is the highest-leverage action available.
2. **Make the demo burn minutes on stage.** Beat 2 of the demo script uploads a real file with a
   live key. Rehearse it, and make sure the counter visibly moves — the brief says this in as many
   words.
3. **Flip Speak on if it has recovered.** `OPENGONG_TTS=pyai-speak` is one variable; the code is
   written and tested. It was defaulted off after a real 503, not by choice. Worth re-probing.

**And the one thing that is not a code change at all:** run the setup on a machine nobody has
touched, timed, with someone who has not seen the code. It is the only checklist item still carrying
an asterisk, and it is the cheapest to close.
