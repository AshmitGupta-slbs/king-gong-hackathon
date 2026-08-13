'use client';

/**
 * Play/pause, a scrubbable track, and the flagged moments marked on it.
 *
 * Two fixes over the previous version, both about being able to see where you are:
 *  - the playhead is now visible at rest. It used to be `opacity-0` until hover, so a paused
 *    player showed no position indicator at all beyond the end of the fill.
 *  - Home/End join the arrow keys, and the slider reports `aria-valuetext` in mm:ss rather than
 *    a bare second count.
 */
import { Pause, Play } from 'lucide-react';
import { cx } from '@/components/ui/cx';
import { fmt } from './format-context';

export function Player({
  playing,
  timeMs,
  durationMs,
  markers,
  onToggle,
  onScrub,
  follow,
  onFollowChange,
}: {
  playing: boolean;
  timeMs: number;
  durationMs: number;
  markers: { id: string; ms: number; type: string }[];
  onToggle: () => void;
  onScrub: (ms: number) => void;
  follow: boolean;
  onFollowChange: (v: boolean) => void;
}) {
  const pct = durationMs > 0 ? Math.min(100, (timeMs / durationMs) * 100) : 0;

  const scrubFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onScrub(ratio * durationMs);
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onToggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-brand text-on-brand shadow-card transition-colors hover:bg-brand-hover"
      >
        {playing ? (
          <Pause size={15} fill="currentColor" strokeWidth={0} />
        ) : (
          <Play size={15} fill="currentColor" strokeWidth={0} className="ml-0.5" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div
          onClick={scrubFromEvent}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(durationMs / 1000)}
          aria-valuenow={Math.round(timeMs / 1000)}
          aria-valuetext={`${fmt(timeMs)} of ${fmt(durationMs)}`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') onScrub(Math.min(durationMs, timeMs + 5000));
            if (e.key === 'ArrowLeft') onScrub(Math.max(0, timeMs - 5000));
            if (e.key === 'Home') onScrub(0);
            if (e.key === 'End') onScrub(durationMs);
          }}
          className="group relative h-6 cursor-pointer"
        >
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-surface-inset">
            <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
          </div>
          {markers.map((m) => (
            <span
              key={`${m.id}-${m.ms}`}
              title={`flagged: ${m.type.replace('_', ' ')}`}
              className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-warn-solid ring-2 ring-surface"
              style={{ left: `${durationMs ? (m.ms / durationMs) * 100 : 0}%` }}
            />
          ))}
          {/* Visible at rest, and grows on hover — the position indicator, not a hover affordance. */}
          <span
            aria-hidden
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-brand shadow-card transition-transform group-hover:scale-125"
            style={{ left: `${pct}%` }}
          />
        </div>

        <div className="flex items-center gap-3 text-caption text-fg-dim">
          <span className="font-mono tabular-nums text-fg-muted">
            {fmt(timeMs)} <span className="text-fg-dim">/ {fmt(durationMs)}</span>
          </span>
          {markers.length > 0 && (
            <span className="hidden items-center gap-1.5 sm:inline-flex">
              <span aria-hidden className="inline-block size-1.5 rounded-full bg-warn-solid" />
              {markers.length} flagged
            </span>
          )}
          <label
            className={cx(
              'ml-auto flex cursor-pointer items-center gap-1.5 select-none',
              follow ? 'text-brand' : 'text-fg-dim',
            )}
          >
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => onFollowChange(e.target.checked)}
              className="accent-[var(--brand)]"
            />
            follow transcript
          </label>
        </div>
      </div>
    </div>
  );
}
