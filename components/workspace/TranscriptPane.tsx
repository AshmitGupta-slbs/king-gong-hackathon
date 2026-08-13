'use client';

/**
 * The transcript: the surface every citation lands on.
 *
 * Speakers are shown as people. `segment.speaker` is still the literal role underneath — extraction
 * branches on it, so renaming it in the data would change what counts as an objection — but the
 * reader sees the name the CRM has for whoever was talking, and falls back to the raw label when
 * the call has no CRM record.
 *
 * Two highlight states, deliberately different:
 *   active — the line currently being spoken (violet wash, left rule)
 *   cited  — one of the lines backing the claim under the cursor (amber ring, no fill)
 * They can be true at once, so they must not use the same visual channel.
 */
import type { RenderedSpan } from '@/lib/readability';
import type { TranscriptSegment } from '@/lib/types';
import { cx } from '@/components/ui/cx';
import { fmt, initialsOf, useSpanFmt, useSpeaker } from './format-context';

export function TranscriptLine({
  seg,
  active,
  pulsed,
  cited,
  onClick,
  bindRef,
}: {
  seg: TranscriptSegment;
  active: boolean;
  pulsed: boolean;
  cited: boolean;
  onClick: () => void;
  bindRef: (el: HTMLDivElement | null) => void;
}) {
  const spans = useSpanFmt();
  const person = useSpeaker(seg.speaker);
  const internal = person ? person.side === 'internal' : seg.speaker === 'rep';
  const label = person ? person.name.split(/\s+/)[0] : seg.speaker;

  return (
    <div
      ref={bindRef}
      onClick={onClick}
      title={person ? `${person.name} — ${person.title}` : undefined}
      className={cx(
        'group grid cursor-pointer grid-cols-[46px_minmax(0,1fr)] gap-x-3 rounded-control',
        'border-l-2 py-2 pr-2.5 pl-2 text-body transition-colors sm:grid-cols-[46px_84px_minmax(0,1fr)]',
        active ? 'border-brand bg-brand-wash' : 'border-transparent hover:bg-surface-inset',
        cited && 'bg-warn-wash ring-1 ring-warn-border ring-inset',
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
          'col-start-2 row-start-2 mb-1 flex w-fit items-center gap-1.5',
          'sm:row-start-1 sm:mb-0 sm:self-start',
        )}
      >
        <span
          aria-hidden
          className={cx(
            'grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-bold',
            internal ? 'bg-rep-wash text-rep' : 'bg-prospect-wash text-prospect',
          )}
        >
          {person ? initialsOf(person.name) : label.slice(0, 2).toUpperCase()}
        </span>
        <span
          className={cx(
            'truncate text-caption font-semibold',
            internal ? 'text-rep' : 'text-prospect',
          )}
        >
          {label}
        </span>
      </span>

      <span
        className={cx('col-start-2 row-start-1 sm:col-start-3', active ? 'text-fg' : 'text-fg-muted')}
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
