'use client';

/**
 * What the server is actually doing, while it does it.
 *
 * Every row here changes because a stage genuinely completed, not because a timer advanced. There
 * is no percentage anywhere: the extract call is one opaque await with no token callback, so a bar
 * would race to a fifth and then sit still — worse than not drawing one. What it shows instead is a
 * live elapsed count, the segment count carried forward from transcription, and (only once at least
 * three runs have been recorded) the median of how long real runs took.
 *
 * The citation gate never renders as `running`. It finishes in single-digit milliseconds, so a
 * spinner on it would be theatre; it lands as a completed row whose detail is what it rejected.
 */
import { useEffect, useState } from 'react';
import { Check, CircleDashed, Loader2, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cx } from '@/components/ui/cx';
import type { StageName } from '@/lib/harness/progress';

export type StageView = {
  key: StageName;
  label: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  ms?: number;
  detail?: string;
  attempt?: number;
  retryReason?: string;
};

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function UploadProgress({
  stages,
  startedAt,
  expectedMs,
  onStopWatching,
}: {
  stages: StageView[];
  startedAt: number;
  expectedMs: number | null;
  onStopWatching: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);

  const elapsed = now - startedAt;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-body font-medium text-fg">Analysing the call…</p>
        <p className="mt-1 text-caption text-fg-dim tabular-nums">
          {secs(elapsed)} elapsed
          {expectedMs !== null && <> · similar runs took about {Math.round(expectedMs / 1000)}s</>}
        </p>
      </div>

      <ol className="flex flex-col gap-0.5">
        {stages.map((s) => (
          <li key={s.key} className="flex flex-col">
            <div
              className={cx(
                'flex items-center gap-2.5 rounded-control px-2 py-1.5',
                s.state === 'running' && 'bg-brand-wash',
              )}
            >
              <StageGlyph state={s.state} />
              <span
                className={cx(
                  'flex-1 text-meta',
                  s.state === 'pending' ? 'text-fg-dim' : 'text-fg',
                  s.state === 'running' && 'font-medium text-brand',
                )}
              >
                {s.label}
                {s.attempt !== undefined && s.attempt > 1 && (
                  <span className="ml-1.5 text-caption text-warn">attempt {s.attempt}</span>
                )}
              </span>
              <span className="shrink-0 font-mono text-caption text-fg-dim tabular-nums">
                {s.state === 'done' && s.ms !== undefined && (s.ms < 10 ? '<10ms' : secs(s.ms))}
                {s.state === 'running' && secs(elapsed)}
              </span>
            </div>

            {s.detail && s.state === 'done' && (
              <p className="mt-0.5 mb-1 pl-9 text-caption text-fg-dim">{s.detail}</p>
            )}

            {/* The harness's own reason for spending another attempt, verbatim. */}
            {s.retryReason && (
              <p className="mt-0.5 mb-1 flex items-start gap-1.5 pl-9 text-caption leading-relaxed text-warn">
                <RotateCcw size={12} className="mt-0.5 shrink-0" aria-hidden />
                {s.retryReason}
              </p>
            )}
          </li>
        ))}
      </ol>

      <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-3">
        <p className="text-caption leading-snug text-fg-dim">
          The run continues on the server if you stop watching — it will appear in the call list
          when it finishes.
        </p>
        <Button variant="secondary" onClick={onStopWatching}>
          Stop watching
        </Button>
      </div>
    </div>
  );
}

function StageGlyph({ state }: { state: StageView['state'] }) {
  if (state === 'done')
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-ok text-on-brand">
        <Check size={10} strokeWidth={3} aria-hidden />
      </span>
    );
  if (state === 'failed')
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-bad text-on-brand">
        <X size={10} strokeWidth={3} aria-hidden />
      </span>
    );
  if (state === 'running')
    return <Loader2 size={16} className="shrink-0 animate-spin text-brand" aria-hidden />;
  return <CircleDashed size={16} className="shrink-0 text-fg-dim" aria-hidden />;
}
