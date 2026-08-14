/**
 * Cited notes, rendered for a terminal.
 *
 * The web workspace puts claims and transcript side by side and links them by click. A terminal has no
 * second column and no pointer, so the layout inverts: each claim is followed immediately by the lines
 * that prove it, indented underneath. Same information, same order of importance, no scrolling between
 * a claim and its evidence.
 *
 * Three things are deliberately preserved from the web UI rather than simplified away:
 *
 *  1. EVERY citation is shown, not just the first. The `EvidenceTrail` component exists because an
 *     earlier version showed only `evidence[0]`, which made multi-source claims look single-sourced.
 *  2. An unverified claim is marked, with its support score. "Ships flagged, not silently mixed in with
 *     the verified ones" is a product promise, and a terminal renderer can break it just as easily.
 *  3. What the gate REJECTED is a section, not a footnote. It is the thing no other tool in this
 *     category will show you.
 */
import type { CallBundle, CitedClaim, Evidence, TranscriptSegment } from '@/lib/types';
import { describeExtractor } from '@/lib/provenance';
import { readableFor } from '@/lib/readability';
import { analyseCall } from '@/lib/analytics';
import { c, mmss, padVisible, termWidth, visibleWidth } from '../_ui';

/** A rule that spans the window, so sections separate without a box-drawing dependency. */
export const rule = (label = '') => {
  const w = termWidth();
  if (!label) return c.dim('-'.repeat(w));
  const text = ` ${label} `;
  return c.dim(`--${text}${'-'.repeat(Math.max(0, w - visibleWidth(text) - 2))}`);
};

/** Wrap on word boundaries at a given indent, because a claim is a sentence and sentences wrap. */
export function wrap(text: string, indent: number, width = termWidth()): string[] {
  const budget = Math.max(20, width - indent);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > budget) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const pad = (n: number) => ' '.repeat(n);

export function printWrapped(text: string, indent: number, paint: (s: string) => string = (s) => s) {
  for (const line of wrap(text, indent)) console.log(`${pad(indent)}${paint(line)}`);
}

/**
 * A marker on the first line, and every continuation line hanging under the text.
 *
 * Without this, a wrapped claim's second line starts in the same column as its bullet, so the bullet
 * stops marking anything and a long claim reads as several claims. The prefix is measured with
 * `visibleWidth` because it is usually coloured.
 */
export function printBullet(
  prefix: string,
  text: string,
  indent: number,
  paint: (s: string) => string = (s) => s,
) {
  const hang = indent + visibleWidth(prefix) + 1;
  const lines = wrap(text, hang);
  console.log(`${pad(indent)}${prefix} ${paint(lines[0])}`);
  for (const line of lines.slice(1)) console.log(`${pad(hang)}${paint(line)}`);
}

/**
 * One piece of evidence, numbered.
 *
 * The number is the interaction: it is what you type to hear that exact moment. Numbering is global
 * across the whole `show` output rather than per claim, so there is never ambiguity about which "2"
 * you meant.
 */
export function printEvidence(ev: Evidence, index: number, display: (s: string) => string) {
  const head = `${pad(4)}${c.mono(`[${index}]`)} ${c.dim(mmss(ev.start_ms))} ${c.dim(ev.speaker)}`;
  console.log(head);
  printWrapped(display(ev.text), 8, c.dim);
}

export type EvidenceIndex = { n: number; segment_id: string; start_ms: number; end_ms: number }[];

function printClaim(
  claim: CitedClaim,
  display: (s: string) => string,
  index: EvidenceIndex,
): void {
  const verified = claim.verdict === 'verified';
  const dot = verified ? c.ok('*') : c.warn('!');
  printBullet(dot, claim.claim, 2);
  if (!verified) {
    console.log(
      `${pad(4)}${c.warn(`unverified - support ${claim.support.toFixed(2)}`)} ` +
        c.dim('(the cited line exists but does not clearly back this)'),
    );
  }
  if (claim.evidence.length === 0) {
    console.log(`${pad(4)}${c.bad('no citation')}`);
    return;
  }
  for (const ev of claim.evidence) {
    const n = index.length + 1;
    index.push({ n, segment_id: ev.segment_id, start_ms: ev.start_ms, end_ms: ev.end_ms });
    printEvidence(ev, n, display);
  }
}

function section(title: string, count?: number) {
  const suffix = typeof count === 'number' ? c.dim(` (${count})`) : '';
  console.log(`\n${c.b(title)}${suffix}`);
}

/**
 * The whole call. Returns the evidence index so the caller can turn a keypress into audio.
 */
export function renderCall(bundle: CallBundle): EvidenceIndex {
  const { call, segments, extraction } = bundle;
  const display = readableFor(call.title);
  const index: EvidenceIndex = [];

  console.log('');
  console.log(c.b(call.title));
  const meta = [
    mmss(call.duration_ms),
    `${segments.length} segments`,
    `${call.separation} separation`,
    extraction ? `run: ${extraction.run_status}` : 'not analysed',
  ];
  console.log(c.dim(meta.join('  ·  ')));

  if (!extraction) {
    console.log(
      `\n  ${c.warn('This call has a transcript but no notes.')}\n  ` +
        c.dim('Run ./kg doctor to see whether a notes engine is configured.'),
    );
    return index;
  }

  // Provenance first, because it changes how everything below should be read.
  const prov = describeExtractor(extraction.extracted_by);
  if (!prov.isReal) {
    console.log(`\n  ${c.warn('These notes were not written by a model.')}`);
    printWrapped(`${prov.label} - ${prov.detail}`, 2, c.dim);
  } else if (prov.caveated) {
    console.log(`\n  ${c.mono('engine:')} ${prov.label}`);
    printWrapped(prov.detail, 2, c.dim);
  } else {
    console.log(`\n  ${c.mono('engine:')} ${prov.label} ${c.dim('- produced by a model')}`);
  }

  section('Summary');
  printWrapped(extraction.summary, 2);

  section('Intent');
  printWrapped(`${c.mono(extraction.intent.label)}`, 2);
  for (const ev of extraction.intent.evidence) {
    const n = index.length + 1;
    index.push({ n, segment_id: ev.segment_id, start_ms: ev.start_ms, end_ms: ev.end_ms });
    printEvidence(ev, n, display);
  }

  section('Objections', extraction.objections.length);
  if (!extraction.objections.length) console.log(`${pad(2)}${c.dim('none')}`);
  for (const claim of extraction.objections) printClaim(claim, display, index);

  section('Next steps', extraction.next_steps.length);
  if (!extraction.next_steps.length) console.log(`${pad(2)}${c.dim('none')}`);
  for (const claim of extraction.next_steps) printClaim(claim, display, index);

  if (extraction.key_moments.length) {
    section('Flagged moments', extraction.key_moments.length);
    for (const m of extraction.key_moments) {
      const n = index.length + 1;
      index.push({
        n,
        segment_id: m.evidence.segment_id,
        start_ms: m.evidence.start_ms,
        end_ms: m.evidence.end_ms,
      });
      console.log(
        `${pad(2)}${c.mono(`[${n}]`)} ${c.dim(mmss(m.evidence.start_ms))} ` +
          `${c.warn(m.type.replace(/_/g, ' '))}`,
      );
      printWrapped(m.note, 6, c.dim);
    }
  }

  section('Follow-up email');
  console.log(`${pad(2)}${c.dim('subject:')} ${extraction.follow_up_email.subject}`);
  if (extraction.follow_up_email.verdict === 'unverified') {
    console.log(`${pad(2)}${c.warn('unverified - what this commits to is not clearly in the call')}`);
  }
  for (const line of extraction.follow_up_email.body.split('\n')) {
    if (!line.trim()) console.log('');
    else printWrapped(line, 2, c.dim);
  }

  // Not a footnote. This is the differentiator.
  section('What the citation gate rejected', extraction.rejections.length);
  if (!extraction.rejections.length) {
    console.log(`${pad(2)}${c.ok('nothing - every claim cited a line that backs it')}`);
  }
  for (const r of extraction.rejections) {
    const tag = r.dropped ? c.bad('DROPPED') : c.warn('flagged');
    console.log(`${pad(2)}${tag} ${c.dim(r.field)}`);
    printBullet(c.dim('-'), r.claim, 4);
    printWrapped(r.detail, 6, c.dim);
  }

  // Free, from a pure helper the web UI already uses.
  const stats = analyseCall(segments);
  section('Talk ratio');
  // `pct` is a PERCENTAGE with one decimal (56.7), not a fraction. Treating it as 0..1 drew a
  // 2268-character bar labelled "5670%" the first time this ran, which is the whole reason the unit
  // is spelled out here rather than left to the field name.
  const barMax = Math.min(40, termWidth() - 22);
  for (const share of stats.shares) {
    const width = Math.max(1, Math.round((share.pct / 100) * barMax));
    console.log(
      `${pad(2)}${padVisible(share.speaker, 10)} ${c.mono('#'.repeat(width))} ` +
        c.dim(`${share.pct.toFixed(1)}%`),
    );
  }
  // `longestMonologue` is null for a call with no speech at all, which the type is right to insist on.
  const mono = stats.longestMonologue
    ? `longest monologue ${mmss(stats.longestMonologue.ms)} (${stats.longestMonologue.speaker})  ·  `
    : '';
  console.log(`${pad(2)}${c.dim(`${mono}${stats.questions} questions`)}`);
  if (stats.competitors.length) {
    console.log(
      `${pad(2)}${c.dim(
        `competitors: ${stats.competitors.map((x) => `${x.name} x${x.mentions}`).join(', ')}`,
      )}`,
    );
  }

  return index;
}

/** The transcript, as its own view — the same words the browser shows, via the same renderer. */
export function renderTranscript(
  segments: TranscriptSegment[],
  title: string,
  citedIds = new Set<string>(),
) {
  const display = readableFor(title);
  console.log(`\n${c.b('Transcript')}`);
  for (const seg of segments) {
    // `cited` is one of the web UI's three orthogonal highlight states; in a terminal it becomes a
    // gutter mark, which is the only channel available that does not fight with speaker colour.
    const gutter = citedIds.has(seg.id) ? c.ok('|') : ' ';
    console.log(
      `${gutter} ${c.dim(mmss(seg.start_ms))} ${c.mono(padVisible(seg.speaker, 9))} ${c.dim(seg.id)}`,
    );
    printWrapped(display(seg.text), 4);
  }
}
