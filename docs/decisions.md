# Decisions

The judgement calls behind the code, written down because several of them have more than one
defensible answer and picking one silently is the failure mode worth avoiding. Code comments point
here rather than restating the reasoning in six places.

---

## 1. The citation gate has two tiers, and only one of them can delete a claim

**Tier 1 — does the citation resolve?** Every `segment_id` must exist in *this* call's transcript.
Exact, cheap, non-negotiable. Failure means the claim is removed.

**Tier 2 — does the segment support the claim?** Deterministic content-word overlap (recall of the
claim's content words in the cited text, after stopword removal and light stemming) against a
configurable threshold, default `0.18`. Below it the claim **still ships**, marked `unverified` with
a visible amber badge.

The reference spec flags "does the segment actually support the claim" as a real design decision
with several valid answers — keyword overlap, an LLM-as-judge second pass, or a human-in-the-loop
flag — and says to choose openly. We chose overlap because it is free, instant, reproducible, and
explainable to someone watching a demo: here is the score, here is the threshold. An LLM judge
would be more semantically accurate and is the obvious upgrade path, but it adds a model call to
every extraction and cannot be shown to be deterministic on stage.

**Recall, not F1 or Jaccard.** Evidence is allowed to say much more than the claim — a segment is
usually longer than the sentence summarising it — but a claim should not assert content that appears
nowhere in what it cites.

### Tier 2 applies to assertions, not to abstractions

This one was a bug first and a decision second. Tier 2 originally ran on every field, and the
`intent` label failed it immediately: `price-sensitive` shares no content words with *"the pricing
is the real problem though"*, so a correct classification scored `0.00` and got flagged. Applying
claim-support scoring to a categorical label is a category error.

So tier 2 gates **objections** and **next_steps** — statements about what was said, which must
lexically echo the call. It does not gate **intent labels**, **key-moment notes**, or the
**follow-up email**, which are classifications and drafted prose. Those still have to pass tier 1:
the citation must point at a real segment. Their support score is still computed and stored, so the
choice stays auditable.

### Drop versus flag is asymmetric, on purpose

- **List claims** (`objections`, `next_steps`, `key_moments`) with unresolvable citations are
  **dropped**. There is always a coherent output without them.
- **Singleton deliverables** (`intent`, `follow_up_email`) are **never silently dropped**. Removing
  them leaves a hole a reader misreads as "no objections found". They ship marked `unverified`,
  with unresolvable ids stripped, and they force `run_status` to `partial`.

Either way nothing ships as though it were grounded when it is not, and every decision is logged to
`gate_rejections` with a reason.

---

## 2. `segment_ids` is deliberately NOT enum-constrained in the schema

Structured outputs would let us constrain `segment_ids` to an enum of the call's actual ids, making
a fabricated citation *structurally impossible*. We don't, and the reason is not laziness:

A gate that cannot fire is decoration. "Claims blocked: 6" is one of the most honest and legible
signals this product has, and it is the entire visible proof of Loop Depth. We want real rejections,
counted and displayed, rather than a guarantee nobody can see.

Enum-constraining is written down as the hardening move if hallucinated ids turn out to be frequent
rather than occasional. It is one line in `extract-shared.ts`.

---

## 3. Model output is a *draft*; `run_status` and verdicts are gate outputs

`ExtractionDraft` is what the model returns. `ExtractionResult` is what the gate produces. The
draft schema deliberately contains no `run_status` and no `verdict` field, because a model must not
be able to declare its own output shipped. The reference spec puts `run_status` on the extraction
shape; splitting them is a deliberate divergence.

---

## 4. Transcripts are stored verbatim, including the lowercase and missing punctuation

PyAI's Hear returns `hi sarah thanks for making the time today i know you've been evaluating`, on
both `pyai-hear` and `pyai-hear-telephony`. It is not a model-selection problem (see
`api-truth.md`).

`segment.text` stores exactly what the provider returned, and it is the only thing the **gate** reads.
A readability pass (`lib/readability.ts`) runs at the **presentation boundary** — the UI and the
Markdown export — and is deliberately **not** a model call.

The tempting fix is to ask a model to restore punctuation. We don't, because a model rewriting
evidence is precisely the failure this product exists to prevent: it could quietly change what a
citation asserts. Instead the pass is deterministic and **word-preserving**. It may:

- capitalise the first letter of a segment;
- fix `i` → `I` and its contractions;
- uppercase business acronyms (`cfo` → `CFO`) and capitalise domain proper nouns (competitor names,
  weekdays) plus proper nouns **derived from the call title**, which is human-authored metadata
  rather than model output;
- append at most one terminal full stop.

It may never insert, remove, reorder or respell a word. That property is **enforced, not asserted**:
every result is compared to its input with `sameWords()` (case- and punctuation-insensitive) and the
original is returned on any mismatch. So the worst case is ugly, never wrong.
`npm run test:readability` asserts it across all 50 committed transcript segments.

Consequences worth knowing: **Markdown export is readable, JSON export is verbatim** — anything
machine-read gets exactly what Hear returned. Commas and sentence boundaries are still missing,
because inserting those needs judgement, and judgement here means a model touching evidence.

---

## 5. Usage counts only work that actually happened

Replaying a committed sample records **no** usage, because it burns nothing — no PyAI minutes, no
tokens. That means a freshly cloned repo shows `0.0 min transcribed` until you process a call live,
which looks weaker than it could.

We keep it that way. The product's entire argument is that unverifiable numbers are worthless; a
usage counter that inflated itself on cached data would undercut exactly that. The demo processes a
real call so the counter visibly moves.

Related: PyAI's `/v1/transcription/jobs` endpoints do **not** return the `x-pyai-units` header
(only the flat `/v1/audio/transcriptions` does), so the meter is driven by `result.audio_seconds`.
A counter built purely on the header would have silently displayed zero forever.

---

## 6. The keyword stub exists, and is prevented from ever being demoed

`stub-heuristic` derives claims from the transcript with keyword rules so the UI, routes, export and
harness verification were not blocked behind a model credential. Because claims are built out of
real segments, citations always resolve and the gate runs for real.

Presenting keyword output as model reasoning would be precisely the dishonesty this product points
at. So provenance is enforced rather than remembered:

- `extracted_by` is persisted into every `samples/*.result.json`.
- `isRealModelExtractor()` is the single definition of "real output", read by both the UI and the
  ship check.
- The UI shows a permanent banner and a `STUB EXTRACTOR` badge whenever the active extractor is not
  a model.
- `npm run check:ship` **fails** while any shipped extraction is stub-produced.

---

## 7. `node:sqlite` instead of `better-sqlite3`

Node's built-in SQLite means **zero native dependencies** — no `node-gyp`, no compiler, no prebuilt
binary roulette on a stranger's laptop. That directly serves the pass/fail "five-minute setup"
gate, since a failed native build is the classic way a clone turns five minutes into forty.

The cost, found by running it: `node:sqlite` returns rows with a **null prototype**, and React
Server Components refuse to serialize those to client components. Every read in `lib/db.ts`
therefore rebuilds a plain object explicitly instead of casting the row — which is better practice
anyway, since a schema change now surfaces as a type error rather than `undefined` in the UI.

---

## 8. Sample audio is synthesised, not recorded

Five written calls, synthesised per-speaker and interleaved into stereo with the rep on the **left**
channel. No customer audio and no PII in a public repo, exact ground-truth speaker separation via
`channel: true`, and the demo needs no setup because the WAVs are committed.

PyAI Speak was the intended voice and returned `503 upstream_error` throughout the build, so audio
comes from macOS `say` behind the registry's `tts` capability. `pyai-speak` is registered and swaps
in with `OPENGONG_TTS=pyai-speak`. Since the WAVs are committed, **nobody cloning the repo needs any
TTS at all.**

The rep-on-left convention is load-bearing: `pyai-jobs.ts` maps `channel 0 → rep`. Change it in both
places or neither.

---

## 9. Speaker roles in mono are a stated heuristic, not a fact

With `channel: true` the mapping is deterministic. With `diarize: true` there is no ground truth, so
we use a stated rule: **whoever speaks first is the rep**, because the rep opens the call. Right on
essentially every real sales call, wrong on some. `Call.separation` is persisted and displayed in
the UI so nobody mistakes a heuristic for a measurement.

---

## 10. Skills are files, and they may not supply vocabulary

The parts of the prompt most worth iterating on — what counts as a real objection, when a commitment
is verifiable, how to judge whether last call's promise happened — are the parts a programmer is
worst placed to write. They live in `skills/<id>/SKILL.md` so a salesperson can improve them without
touching TypeScript.

**The constraint that makes it safe:** a skill may say what to *look for* and how to *judge*. It may
not supply phrasing to *describe* findings in. The gate scores a claim by how much of it appears in
the line it cites, so a skill saying "describe pricing pushback as budget-constrained" hands the
model words that are nowhere in the call — and a true claim comes back under-supported, everywhere,
while still reading well. `npm run test:skills` checks the corpus for the imperatives that introduce
output wording and for framework jargon no prospect would utter, and records the failure with a
worked example: the same true claim scores 1.00 in the call's words and 0.00 in borrowed ones.

Frontmatter is three flat scalars, not YAML. A file reaching for nesting is doing something the
loader would only half understand, so it throws instead. `OPENGONG_SKILLS` naming a skill that does
not exist throws too — a typo must not silently mean "analysed without it", because the notes would
look fine and have been produced under different instructions.

**This is not the Anthropic Agent Skills runtime.** No progressive disclosure, no tool use, and the
model never selects its own. Selection happens in code before the call, because a pipeline with a
fixed budget and a gate that must explain itself needs the instruction set knowable in advance
rather than discovered mid-request.

*Rejected:* keeping the prompt in string literals (nobody outside the codebase can improve it), and
a builder-time skill in `.claude/skills/` as the reference suggested (helps whoever writes the code,
not whoever uses the product).

---

## 11. Action items are a new table, and silence closes nothing

A commitment is not a learning. A learning is true forever once it is true; a commitment is open
until something happens. So `action_items` is its own table.

It had to be a new **table** rather than a column: this schema is one `CREATE TABLE IF NOT EXISTS`
block with no migration system, so a new column is a silent no-op on every database that already
exists and then throws at INSERT time, mid-run, after the run row was written. And it could not
reuse `promoted` on `company_learnings`, which already means "a human copied this into notes" — a
different axis, since a commitment can be in the notes and still not done.

**Only a citation or a person closes one.** A model marking an item done must quote a line from a
*later* call that says so; a human may do it with no citation, because that is what a human
assertion is. Both are stored distinguishably and rendered differently, because a percentage that
mixed them silently would be worse than either alone.

**Silence resolves nothing.** An item nobody mentioned stays open and comes back next time. That
costs one line in a prompt; wrongly closing it means nobody ever chases the thing again.

Two smaller choices inside it. Tier 2 scores the model's *note about this call*, not the carried
commitment's text — scoring the latter would measure overlap between two different conversations and
flag correct judgements as unsupported. And the percentage always renders with its denominator:
"67%" is a claim about an account, "2 of 3" is a fact about three specific commitments, and on a real
deal the number is always small enough for the difference to matter.

---

## 12. The CRM payload has no client, and writes no `dealstage`

The question worth answering before wiring a CRM token is not "can we push?" but "what lands in the
CRM, and would we be happy for a customer to read it?" That is answerable with no credential and no
risk to a live pipeline, so it was answered first. `check:ship` now fails the build if an outbound
HubSpot host or a `HUBSPOT_*` credential appears anywhere — the promise is enforced rather than
remembered.

Three decisions inside the payload, all from reading a live portal's schema rather than the docs:

- **No `dealstage` is ever written.** Stage ids are per-portal GUIDs, not labels — in the portal
  checked, "Negotiate" is `4a26def2-fe7f-49ef-8a0b-cb73f99f3907` — and our own `DealStage`
  vocabulary matches none of them. A label would be rejected; a guessed GUID would move somebody's
  real deal. Stage travels as a signal for a human to act on.
- **Association ids are null**, each carrying the lookup that would resolve it. Nothing in this app
  stores a HubSpot object id, and an invented one would look more finished and be less true.
- **Unverified claims are excluded from the note body** and counted under `omitted`. In the app they
  ship with a visible warning, because hiding them would be lying by omission to the person who
  recorded the call. A CRM is a different audience: the note outlives its context and becomes the
  account's record.

The brief lists CRM sync as out of scope. This is not a sync, but it is adjacent, and the flag is
raised in [`scorecard.md`](scorecard.md) rather than left in a commit message.

---

## 13. The budget governor now sizes the message it is capping

It used to estimate input tokens from the transcript alone, ignoring the system prompt and every
context block. On a two-line call that is 14 estimated tokens against a real prompt of 980.

Tolerable while the preamble was fixed and small. Wrong the moment skills made it something a user
can grow: a 20 KB skill adds roughly 5,500 real input tokens and, under the old estimate, zero. A cap
that cannot see the text it is capping is not a cap. It now asks the prompt builder how large its own
output is, so the estimate cannot drift from the message again.
