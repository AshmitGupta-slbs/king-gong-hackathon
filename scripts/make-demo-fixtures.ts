/**
 * Hand-authored demo notes for the five committed sample calls.
 *
 * WHY THIS EXISTS. The keyword stub produces claims that are truncated verbatim quotes
 * ("Prospect raised a concern: <the quote>…") and it always cites exactly one segment, so there is
 * nothing to show for either "these are useful notes" or "this insight came from three moments".
 * Running a real model needs a credential this machine does not have.
 *
 * WHAT IS AND IS NOT FABRICATED — the distinction is the whole point:
 *
 *   FABRICATED   the claim text, the summaries, the follow-up emails. I wrote them.
 *   REAL         every citation. The drafts below go through `runCitationGate` — the same gate the
 *                production path uses — so segment ids are resolved against the real transcript,
 *                evidence text and timestamps are copied from the real segments, support scores are
 *                genuinely computed, and verdicts and rejections are the gate's own decisions.
 *
 * So these files are honest about the one thing this product sells: no claim here cites a line that
 * does not exist, because the gate would have deleted it — and in `heavy-objections` it does exactly
 * that, on purpose, so the rejection panel has real content to show.
 *
 * They are stamped `extracted_by: 'demo-fixture'`, which is NOT in `REAL_MODEL_EXTRACTORS`, so
 * `check:ship` still reports the samples as not-model-produced and the UI still shows its warning.
 * That is correct and deliberate: do not "fix" it by renaming the extractor.
 *
 *   npm run fixtures
 *
 * ⚠️ `npm run extract:samples` overwrites everything this writes. That is fine when you have a real
 *    credential (real output beats authored output every time) — but it is not recoverable, so
 *    re-run this script afterwards if you want the demo notes back.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCitationGate } from '@/lib/harness/gate';
import type { ExtractionDraft, TranscriptSegment } from '@/lib/types';

const SAMPLES = join(process.cwd(), 'samples');
const EXTRACTED_BY = 'demo-fixture';

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * Multi-segment claims are the reason this file exists, so they are written deliberately: where a
 * point was made in more than one place, the claim cites every place. On a 63–77 second call the
 * ticks are only legible if they are far apart, so these pair early segments with late ones.
 */
const DRAFTS: Record<string, ExtractionDraft> = {
  // ── Northwind Logistics — final call, closed won ───────────────────────────
  'clean-close': {
    summary:
      'Marcus confirmed the security review came back clean, removing the last blocker on a 40-seat ' +
      'rollout across the two sales pods. He agreed scope on the condition of a pre-agreed 10-seat ' +
      'expansion in Q2 at the same rate, and committed to getting the paperwork through signature by ' +
      'Friday — procurement has already reserved the budget line.',
    intent: { label: 'ready to sign', segment_ids: ['seg_001', 'seg_007'] },
    objections: [
      {
        claim:
          'Wants the option to add ten more seats in the second quarter without renegotiating the whole agreement.',
        segment_ids: ['seg_003'],
      },
      {
        claim:
          'Checked that onboarding is run by our team rather than becoming work for his managers.',
        segment_ids: ['seg_005'],
      },
    ],
    next_steps: [
      {
        claim:
          'Send the paperwork today so Marcus can get it through signature by Friday; procurement has the budget line reserved.',
        segment_ids: ['seg_007', 'seg_008'],
      },
      {
        claim: 'Copy Elena on the paperwork — she is handling the vendor forms and will chase it.',
        segment_ids: ['seg_009'],
      },
      {
        claim:
          'Write the ten-seat expansion in as a pre-agreed option at the same rate, exercisable within the first twelve months.',
        segment_ids: ['seg_004'],
      },
    ],
    follow_up_email: {
      subject: 'Paperwork for signature — 40 seats + pre-agreed expansion',
      body:
        'Hi Marcus,\n\nGreat news on the security sign-off. As agreed: 40 seats across the two sales ' +
        'pods, with a pre-agreed option on a further 10 in Q2 at the same rate, exercisable inside the ' +
        'first twelve months.\n\nPaperwork is on its way within the hour and I have copied Elena for the ' +
        'vendor forms. Onboarding is two sessions in week one, run by us, with a check-in at day ' +
        'thirty — nothing for your managers to build.\n\nSam',
      segment_ids: ['seg_004', 'seg_007', 'seg_009'],
    },
    key_moments: [
      { type: 'next_step', segment_id: 'seg_001', note: 'Security signed off — last blocker cleared' },
      { type: 'objection', segment_id: 'seg_003', note: 'Wants expansion optionality without renegotiating' },
      { type: 'next_step', segment_id: 'seg_007', note: 'Signature by Friday, budget line reserved' },
    ],
  },

  // ── Halcyon Health — discovery, heavy objections ───────────────────────────
  // This one deliberately contains a claim citing a segment that does not exist, so the citation
  // gate drops it and the "what the gate rejected" panel has real content on a sample call.
  'heavy-objections': {
    summary:
      'Priya is sceptical on the back of a failed call-recording rollout two years ago, where reps ' +
      'felt surveilled and moved calls off-platform within a quarter. She named three blockers — rep ' +
      'trust, the privacy review, and no internal bandwidth — and was explicit that the privacy ' +
      'review is the one that matters, because nothing else proceeds without approval.',
    intent: { label: 'sceptical — evaluating', segment_ids: ['seg_001', 'seg_007'] },
    objections: [
      {
        claim:
          'Rep trust is the core adoption risk: the previous recording tool was used by managers in one-to-ones, reps felt surveilled, and within a quarter they were taking calls off platform to avoid it.',
        segment_ids: ['seg_001', 'seg_003'],
      },
      {
        claim:
          'The privacy office is the gating blocker — anything touching patient information has to clear a review that is slow and often says no, and Priya will not commit to a timeline for it.',
        segment_ids: ['seg_005', 'seg_007', 'seg_009'],
      },
      {
        claim:
          'No headcount to run another rollout; her team is already stretched covering two regions.',
        segment_ids: ['seg_005'],
      },
      {
        // Deliberate: a plausible-sounding inference nobody actually said. The gate cannot resolve
        // seg_014 (the call has ten segments) and deletes it. That deletion is the demo.
        claim:
          'Halcyon has already allocated budget for this initiative in the current fiscal year.',
        segment_ids: ['seg_014'],
      },
    ],
    next_steps: [
      {
        claim:
          'Send the data processing terms and the deployment options, including the one where nothing leaves their tenancy; Priya will forward it to the privacy office.',
        segment_ids: ['seg_008', 'seg_009'],
      },
    ],
    follow_up_email: {
      subject: 'Data processing terms + deployment options',
      body:
        'Hi Priya,\n\nThank you for being straight about what went wrong last time — reps feeling ' +
        'surveilled is the failure mode we design against, and it is worth a proper conversation once ' +
        'privacy is satisfied.\n\nAttached are the data processing terms and the deployment options, ' +
        'including the configuration where no recording or transcript leaves your tenancy. That is the ' +
        'one to put in front of your privacy office.\n\nNo timeline pressure from me.\n\nSam',
      segment_ids: ['seg_008', 'seg_009'],
    },
    key_moments: [
      { type: 'objection', segment_id: 'seg_003', note: 'Prior rollout failed — reps went off platform' },
      { type: 'objection', segment_id: 'seg_005', note: 'Privacy office + no bandwidth' },
      { type: 'objection', segment_id: 'seg_007', note: 'Privacy review is the one blocker that matters' },
      { type: 'next_step', segment_id: 'seg_009', note: 'Will forward terms to privacy, no timeline promised' },
    ],
  },

  // ── Bright Harbour Software — competitive evaluation ───────────────────────
  'competitor-named': {
    summary:
      'Bright Harbour is down to three vendors — us, Gong and Chorus — having ruled out Fireflies for ' +
      'weak coaching. Gong is the internal favourite for political rather than product reasons: their ' +
      'VP used it before and trusts it. Dana\'s own objections to Gong are price and paying for a full ' +
      'revenue suite when they want about a third of it, and Chorus lost on summary quality.',
    intent: { label: 'competitive evaluation', segment_ids: ['seg_001', 'seg_003'] },
    objections: [
      {
        claim:
          'Gong is the safe internal choice because their VP came from a company that used it and trusts it — Dana needs to show him this is not a downgrade from the tool he already knows.',
        segment_ids: ['seg_003', 'seg_007'],
      },
      {
        claim:
          'Price is the objection to Gong, specifically paying for a whole revenue suite when they want maybe a third of it.',
        segment_ids: ['seg_003'],
      },
      {
        claim:
          'Chorus was cheaper but its summaries were noticeably worse in the pilot — her rep stopped reading them by week two.',
        segment_ids: ['seg_005'],
      },
    ],
    next_steps: [
      {
        claim:
          'Send a side-by-side comparison Dana can put in front of her VP before the decision meeting on the twentieth.',
        segment_ids: ['seg_008', 'seg_009'],
      },
    ],
    follow_up_email: {
      subject: 'Side-by-side for your decision meeting on the 20th',
      body:
        'Hi Dana,\n\nAs promised, something you can put in front of Ryan side by side.\n\nThe short ' +
        'version: every line in the notes links back to the moment in the call it came from, so a claim ' +
        'you cannot verify does not survive to be read. That is the part the suite does not do, and it ' +
        'is why this is not a downgrade on the thing he already trusts.\n\nHappy to join the meeting on ' +
        'the 20th if useful.\n\nSam',
      segment_ids: ['seg_008', 'seg_009'],
    },
    key_moments: [
      { type: 'competitor_mention', segment_id: 'seg_001', note: 'Down to three: us, Gong, Chorus' },
      { type: 'competitor_mention', segment_id: 'seg_003', note: 'VP trusts Gong; price is the objection' },
      { type: 'competitor_mention', segment_id: 'seg_005', note: 'Chorus lost on summary quality' },
      { type: 'next_step', segment_id: 'seg_009', note: 'Decision meeting on the twentieth' },
    ],
  },

  // ── Cobalt Freight — pricing pushback ──────────────────────────────────────
  'pricing-pushback': {
    summary:
      'Helen was explicit that the product is not the issue — the per-seat number is. At 25 seats it ' +
      'becomes a finance-committee item, and their CFO requires anything new to displace existing ' +
      'spend rather than add to it. She believes the recording tool and part of the conversation ' +
      'analytics spend could be retired, covering roughly half. Under five thousand in year one she ' +
      'can approve it herself.',
    intent: { label: 'price-sensitive', segment_ids: ['seg_001', 'seg_009'] },
    objections: [
      {
        claim:
          'Per-seat price is the blocker, not the product — at their volume it is more than they currently spend on the entire sales tooling stack.',
        segment_ids: ['seg_001', 'seg_003'],
      },
      {
        claim:
          'Their CFO requires anything new to displace existing spend rather than add to it, and Helen can only identify about half the cost in things it would retire.',
        segment_ids: ['seg_003', 'seg_005'],
      },
      {
        claim:
          'She will not go to the finance committee twice, so the number has to be right the first time she takes it in.',
        segment_ids: ['seg_007'],
      },
    ],
    next_steps: [
      {
        claim:
          'Put together a ten-seat starting tier so the first year lands under the committee threshold, plus a written comparison of what it retires.',
        segment_ids: ['seg_008', 'seg_009'],
      },
    ],
    follow_up_email: {
      subject: 'Revised structure — 10-seat start + what it retires',
      body:
        'Hi Helen,\n\nTwo things, as discussed.\n\nFirst, a ten-seat starting tier that brings year one ' +
        'under the threshold you can approve yourself, with a defined path to the full 25.\n\nSecond, a ' +
        'written comparison of what this retires — the recording tool and the overlapping part of the ' +
        'conversation analytics spend — so the displacement argument is on paper before it reaches the ' +
        'committee.\n\nSam',
      segment_ids: ['seg_008', 'seg_009'],
    },
    key_moments: [
      { type: 'pricing', segment_id: 'seg_001', note: 'Per-seat price exceeds their whole tooling spend' },
      { type: 'pricing', segment_id: 'seg_003', note: 'Finance committee + CFO displacement rule' },
      { type: 'pricing', segment_id: 'seg_009', note: 'Under five thousand year one = self-approval' },
      { type: 'next_step', segment_id: 'seg_008', note: 'Ten-seat tier + written displacement comparison' },
    ],
  },

  // ── Verity Partners — no decision, went quiet ──────────────────────────────
  'no-decision': {
    summary:
      'Nothing has moved at Verity. The original driver — ramping new reps faster — is still a real ' +
      'problem but no longer a priority, because hiring was paused in August. Their enablement lead ' +
      'left in July and nobody picked the initiative up, so there is no internal champion. Tom would ' +
      'not give a date he did not believe in and asked to be revisited in January.',
    intent: { label: 'no decision', segment_ids: ['seg_003', 'seg_007'] },
    objections: [
      {
        claim:
          'Hiring was paused in August, so the original driver of ramping new reps faster is still a problem but no longer the priority.',
        segment_ids: ['seg_003'],
      },
      {
        claim:
          'There is no internal champion — the enablement lead left in July and nobody has picked it up.',
        segment_ids: ['seg_007'],
      },
      {
        // Low content-word overlap with the cited line on purpose: the segment exists and is the
        // right one, but it does not visibly state this. The gate ships it flagged rather than
        // deleting it, which is the 'unverified' half of the trust story.
        claim: 'The account is likely to churn to a competitor within two quarters.',
        segment_ids: ['seg_005'],
      },
    ],
    next_steps: [
      {
        claim:
          'Check back in January — Tom committed to saying honestly whether hiring has restarted.',
        segment_ids: ['seg_005', 'seg_009'],
      },
    ],
    follow_up_email: {
      subject: 'Parking this until January',
      body:
        'Hi Tom,\n\nAppreciated you being straight with me — a date neither of us believed in would not ' +
        'have helped either of us.\n\nParking this until January. If hiring restarts before then and it ' +
        'becomes live again, you know where I am.\n\nSam',
      segment_ids: ['seg_005', 'seg_009'],
    },
    key_moments: [
      { type: 'objection', segment_id: 'seg_003', note: 'Hiring paused — no longer the priority' },
      { type: 'objection', segment_id: 'seg_007', note: 'Champion left; nobody owns it' },
      { type: 'next_step', segment_id: 'seg_009', note: 'Revisit in January' },
    ],
  },
};

type ManifestEntry = { id: string; run_status: string; extracted_by?: string };

function main() {
  console.log(`\n${c.b('Hand-authored demo notes → the real citation gate')}\n`);

  const manifestPath = join(SAMPLES, 'index.json');
  const manifest: ManifestEntry[] = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : [];

  let failures = 0;
  const updated = manifest.map((entry) => {
    const draft = DRAFTS[entry.id];
    process.stdout.write(`  ${entry.id.padEnd(20)} `);

    if (!draft) {
      console.log(c.warn('no authored draft — left as is'));
      return entry;
    }
    const sttPath = join(SAMPLES, `${entry.id}.stt.json`);
    if (!existsSync(sttPath)) {
      console.log(c.bad('no transcript'));
      failures++;
      return entry;
    }

    const { segments } = JSON.parse(readFileSync(sttPath, 'utf8')) as {
      segments: TranscriptSegment[];
    };

    // The real gate. Citations are resolved against the real transcript; nothing below is authored.
    const { result } = runCitationGate(draft, segments, EXTRACTED_BY);
    writeFileSync(join(SAMPLES, `${entry.id}.result.json`), JSON.stringify(result, null, 2));

    const multi = [...result.objections, ...result.next_steps].filter(
      (cl) => cl.evidence.length > 1,
    ).length;
    const unverified = [...result.objections, ...result.next_steps].filter(
      (cl) => cl.verdict === 'unverified',
    ).length;
    const dropped = result.rejections.filter((r) => r.dropped).length;

    console.log(
      `${result.run_status === 'shipped' ? c.ok(result.run_status) : c.warn(result.run_status)} ` +
        c.dim(
          `${result.objections.length} obj · ${result.next_steps.length} next · ` +
            `${multi} multi-cited · ${unverified} unverified · ${dropped} dropped`,
        ),
    );
    return { ...entry, run_status: result.run_status, extracted_by: EXTRACTED_BY };
  });

  writeFileSync(manifestPath, JSON.stringify(updated, null, 2));

  console.log(
    `\n  ${c.warn('These notes are hand-authored, not model output.')}\n  ` +
      c.dim(
        'Every CITATION is real — resolved and scored by the production gate — but the claim text\n  ' +
          'was written by a person. `check:ship` will keep reporting the samples as not-model-produced,\n  ' +
          'and the UI will keep saying so. That is correct.\n',
      ),
  );
  process.exit(failures > 0 ? 1 : 0);
}

main();
