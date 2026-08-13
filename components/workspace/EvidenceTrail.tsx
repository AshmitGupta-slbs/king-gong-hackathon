'use client';

/**
 * Where a claim came from — the whole call in one thin bar.
 *
 * Citation chips already answered "which line proves this?" one line at a time. They could not
 * answer the question a reader actually asks first: *how much* of the call is this built on, and
 * was it one throwaway remark or a theme the prospect returned to three times?
 *
 * So the bar IS the call, left edge to right edge, with a tick at every cited moment. One tick reads
 * as one line. Three ticks spread across the width read, instantly and without a legend, as "they
 * kept coming back to this". That is a fact about the evidence, shown as a shape rather than stated
 * in a sentence nobody would read.
 *
 * Expanding lists every piece of proof — the previous version rendered `evidence.slice(0, 1)`, so
 * the second and third receipts were invisible even when the gate had resolved them.
 */
import { useState } from 'react';
import { ChevronDown, Play } from 'lucide-react';
import type { Evidence } from '@/lib/types';
import { cx } from '@/components/ui/cx';
import { fmt, initialsOf, useCallMeta, useSpeaker, useTextFmt } from './format-context';

/** Ticks closer than this share a pixel and become one blob, so they get nudged apart. */
const MIN_TICK_GAP_PCT = 3.2;

/**
 * Spread ticks that would overlap.
 *
 * On a 63-second sample two citations eight seconds apart are ~12% apart and fine, but two in the
 * same exchange are not — and a tick you cannot separate is a tick you cannot click. Positions are
 * nudged for legibility only; the timestamp shown and the seek target are always the true value.
 */
function layout(positions: number[]): number[] {
  const order = positions.map((pct, i) => ({ pct, i })).sort((a, b) => a.pct - b.pct);
  let prev = -Infinity;
  const out = new Array<number>(positions.length);
  for (const { pct, i } of order) {
    const placed = Math.max(pct, prev + MIN_TICK_GAP_PCT);
    out[i] = placed;
    prev = placed;
  }
  // If nudging pushed the last tick off the end, shift the whole run back inside the bar.
  const overflow = Math.max(...out) - 100;
  return overflow > 0 ? out.map((p) => p - overflow) : out;
}

export function EvidenceTrail({
  evidence,
  onCite,
  onHoverSegments,
}: {
  evidence: Evidence[];
  onCite: (id: string) => void;
  /** Lets the parent highlight every cited line in the transcript while this claim is hovered. */
  onHoverSegments?: (ids: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { durationMs } = useCallMeta();
  const display = useTextFmt();

  if (evidence.length === 0) return null;

  const pcts = layout(
    evidence.map((e) => (durationMs > 0 ? Math.min(100, (e.start_ms / durationMs) * 100) : 0)),
  );
  const ids = evidence.map((e) => e.segment_id);

  return (
    <div
      className="mt-2"
      onMouseEnter={() => onHoverSegments?.(ids)}
      onMouseLeave={() => onHoverSegments?.(null)}
    >
      <div className="flex items-center gap-2.5">
        {/* The call, end to end. */}
        <div className="relative h-4 min-w-0 flex-1">
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface-inset" />
          {evidence.map((e, i) => (
            <button
              key={`${e.segment_id}-${e.start_ms}-${i}`}
              type="button"
              onClick={() => onCite(e.segment_id)}
              title={`${fmt(e.start_ms)} — ${display(e.text)}`}
              aria-label={`Jump to the moment at ${fmt(e.start_ms)}`}
              className={cx(
                'absolute top-1/2 grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center',
                'rounded-full transition-transform hover:scale-125',
              )}
              style={{ left: `${pcts[i]}%` }}
            >
              <span className="size-2 rounded-full bg-brand ring-2 ring-surface" />
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex shrink-0 items-center gap-1 rounded-chip px-1 text-caption font-medium text-fg-dim transition-colors hover:text-brand"
        >
          {evidence.length} {evidence.length === 1 ? 'moment' : 'moments'}
          <ChevronDown
            size={13}
            aria-hidden
            className={cx('transition-transform', open && 'rotate-180')}
          />
        </button>
      </div>

      {open && (
        <ul className="mt-2 flex flex-col gap-1.5 border-l-2 border-brand-border pl-2.5">
          {evidence.map((e, i) => (
            <EvidenceLine key={`${e.segment_id}-${e.start_ms}-${i}`} e={e} onCite={onCite} />
          ))}
        </ul>
      )}
    </div>
  );
}

function EvidenceLine({ e, onCite }: { e: Evidence; onCite: (id: string) => void }) {
  const display = useTextFmt();
  const person = useSpeaker(e.speaker);
  const name = person?.name ?? e.speaker;

  return (
    <li>
      <button
        type="button"
        onClick={() => onCite(e.segment_id)}
        className="group flex w-full items-start gap-2 rounded-control px-1.5 py-1 text-left transition-colors hover:bg-brand-wash"
      >
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand-wash text-brand transition-colors group-hover:bg-brand group-hover:text-on-brand">
          <Play size={9} fill="currentColor" strokeWidth={0} className="ml-px" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="text-caption font-semibold text-fg">
              {person ? initialsOf(name) + ' · ' : ''}
              {name}
            </span>
            {/* The segment id stays visible: it is the auditable handle on the receipt, and the
                reason a reader can go check the claim against the transcript themselves. */}
            <span className="font-mono text-caption text-fg-dim tabular-nums">
              {e.segment_id} · {fmt(e.start_ms)}
            </span>
          </span>
          <span className="mt-0.5 block text-micro leading-relaxed text-fg-muted">
            “{display(e.text)}”
          </span>
        </span>
      </button>
    </li>
  );
}
