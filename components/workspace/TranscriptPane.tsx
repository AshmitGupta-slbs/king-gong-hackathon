'use client';

/**
 * The transcript: the surface every citation lands on.
 *
 * Changes worth naming:
 *  - body text is 14px, not 13px, with real row padding. This is the densest reading surface in
 *    the product and it was set at the size the old UI used for footnotes.
 *  - the speaker is a labelled chip rather than a bare coloured word, so it survives being read
 *    by someone who cannot separate the two hues.
 *  - the hover-revealed `seg.id` is GONE. It was 10px text in a border colour (~1.4:1) — a debug
 *    artefact sitting in the primary reading surface. Segment IDs still appear where they mean
 *    something: on the citation chips that point here.
 */
import type { RenderedSpan } from '@/lib/readability';
import type { TranscriptSegment } from '@/lib/types';
import { cx } from '@/components/ui/cx';
import { fmt, useSpanFmt } from './format-context';

export function TranscriptLine({
  seg,
  active,
  pulsed,
  onClick,
  bindRef,
}: {
  seg: TranscriptSegment;
  active: boolean;
  pulsed: boolean;
  onClick: () => void;
  bindRef: (el: HTMLDivElement | null) => void;
}) {
  const isRep = seg.speaker === 'rep';
  const spans = useSpanFmt();

  return (
    <div
      ref={bindRef}
      onClick={onClick}
      className={cx(
        'group grid cursor-pointer grid-cols-[46px_minmax(0,1fr)] gap-x-3 rounded-control',
        'border-l-2 py-2 pr-2.5 pl-2 text-body transition-colors sm:grid-cols-[46px_78px_minmax(0,1fr)]',
        active
          ? 'border-brand bg-brand-wash'
          : 'border-transparent hover:bg-surface-inset',
        pulsed && 'cite-pulse',
      )}
    >
      <span
        className={cx(
          'font-mono text-caption tabular-nums',
          active ? 'text-brand' : 'text-fg-dim group-hover:text-brand',
        )}
      >
        {fmt(seg.start_ms)}
      </span>

      <span
        className={cx(
          'col-start-2 row-start-2 mb-1 inline-flex w-fit items-center rounded-chip border px-1.5 py-0.5',
          'text-caption font-semibold tracking-wide uppercase',
          'sm:row-start-1 sm:mb-0 sm:self-start',
          isRep
            ? 'border-rep-border bg-rep-wash text-rep'
            : 'border-prospect-border bg-prospect-wash text-prospect',
        )}
      >
        {seg.speaker}
      </span>

      <span
        className={cx(
          'col-start-2 row-start-1 sm:col-start-3',
          active ? 'text-fg' : 'text-fg-muted',
        )}
      >
        <SegmentText spans={spans(seg.text)} />
      </span>
    </div>
  );
}

/**
 * A transcript line, with the one word-changing transform shown rather than hidden.
 *
 * Hear reads figures out digit by digit ("one four oh oh"), and we collapse a long enough run to
 * "1400" so the line is readable. That is the only place the screen shows characters nobody spoke,
 * so it gets a dotted underline and a tooltip with the spoken words. Hovering tells you the truth;
 * the citation the gate checked is still the verbatim text underneath.
 */
export function SegmentText({ spans }: { spans: RenderedSpan[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.normalized ? (
          <span
            key={i}
            title={`spoken as "${s.spoken}" — shown as digits for readability. The citation checks the spoken words.`}
            className="cursor-help underline decoration-fg-dim decoration-dotted underline-offset-2"
          >
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
