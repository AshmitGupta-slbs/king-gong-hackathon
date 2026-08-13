'use client';

/**
 * What was agreed before this call, and whether it happened.
 *
 * The card exists to answer one question a rep actually asks on the way into a meeting: what did I
 * promise last time, and did I do it. Everything about the design follows from wanting that answer
 * to be trustworthy.
 *
 * A ✓ is either evidenced or owned. A model-closed item shows the line from this call that says it
 * happened, clickable like any other citation. A person-closed item says a person closed it and
 * shows no line, because there isn't one — rather than borrowing a plausible-looking quote.
 *
 * The percentage always ships with its denominator. "67%" is a claim about an account; "2 of 3" is
 * a fact about three specific commitments, and on a real deal the number is always small enough for
 * the difference to matter.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, Circle, Loader2, Quote, RotateCcw, UserRound } from 'lucide-react';
import type { ActionItem, FollowThrough } from '@/lib/action-item-types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { cx } from '@/components/ui/cx';
import { fmt } from './format-context';

export function ActionItems({
  items,
  stats,
  onCite,
  readOnly = false,
}: {
  items: ActionItem[];
  stats: FollowThrough;
  onCite?: (id: string) => void;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  if (items.length === 0) return null;

  async function set(id: string, status: 'done' | 'open') {
    setBusy(id);
    try {
      const body = new FormData();
      body.set('id', id);
      body.set('status', status);
      await fetch('/api/action-items', { method: 'POST', body });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title="Carried in from earlier calls"
      count={items.length}
      actions={
        stats.pct !== null && (
          <span className="flex items-center gap-2">
            <span className="text-caption text-fg-dim">
              {stats.done} of {stats.total} done
            </span>
            <span
              aria-hidden
              className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-inset"
              title={`${stats.pct}% of commitments kept`}
            >
              <span
                className="block h-full rounded-full bg-ok"
                style={{ width: `${stats.pct}%` }}
              />
            </span>
            <span className="text-caption font-semibold text-fg">{stats.pct}%</span>
          </span>
        )
      }
    >
      <ul className="flex flex-col gap-2.5">
        {items.map((i) => {
          const done = i.status === 'done';
          const byModel = i.resolved_by === 'model';
          return (
            <li
              key={i.id}
              className={cx(
                'rounded-control border px-3 py-2.5',
                done ? 'border-ok-border bg-ok-wash/50' : 'border-border-subtle bg-surface',
              )}
            >
              <div className="flex items-start gap-2">
                <span aria-hidden className={cx('mt-0.5 shrink-0', done ? 'text-ok' : 'text-fg-dim')}>
                  {done ? <Check size={14} strokeWidth={3} /> : <Circle size={13} />}
                </span>
                <p className={cx('min-w-0 flex-1 text-meta', done ? 'text-fg-muted' : 'text-fg')}>
                  {i.text}
                </p>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    onClick={() => set(i.id, done ? 'open' : 'done')}
                    disabled={busy === i.id}
                    title={
                      done
                        ? 'Reopen this — it clears the resolution, including any citation'
                        : 'Mark it done yourself. No line from this call will be attached, because there is none.'
                    }
                  >
                    {busy === i.id ? (
                      <Loader2 size={12} className="animate-spin" aria-hidden />
                    ) : done ? (
                      <RotateCcw size={12} aria-hidden />
                    ) : (
                      <Check size={12} aria-hidden />
                    )}
                    {done ? 'Reopen' : 'Mark done'}
                  </Button>
                )}
              </div>

              {/* The receipt, or the honest absence of one. */}
              {done && byModel && i.resolved_segment_id && (
                <button
                  type="button"
                  onClick={() => onCite?.(i.resolved_segment_id!)}
                  className="mt-1.5 flex w-full items-start gap-1.5 rounded-control border-l-2 border-ok-border bg-surface py-1 pl-2 text-left text-caption leading-relaxed text-fg-muted transition-colors hover:bg-ok-wash"
                >
                  <Quote size={11} className="mt-0.5 shrink-0 text-ok" aria-hidden />
                  <span className="min-w-0">
                    “{i.resolved_quote}”
                    <span className="mt-0.5 block font-mono text-ok">
                      {i.resolved_segment_id}
                      {i.resolved_start_ms !== null && ` · ${fmt(i.resolved_start_ms)}`}
                    </span>
                  </span>
                </button>
              )}

              {done && !byModel && (
                <p className="mt-1.5 flex items-center gap-1.5 text-caption text-fg-dim">
                  <UserRound size={11} aria-hidden />
                  Marked done by a person — no line from this call was cited.
                </p>
              )}

              {!done && (
                <p className="mt-1.5 text-caption text-fg-dim">
                  Not settled on this call — stays open for the next one.
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-caption leading-relaxed text-fg-dim">
        Agreed on earlier calls with this account. A tick from the model quotes the line on{' '}
        <em>this</em> call that says it happened; anything it could not find stays open rather than
        being guessed at.
      </p>
    </Card>
  );
}

/** The account-level figure, for /setup where there is no single call in view. */
export function FollowThroughStat({ stats }: { stats: FollowThrough }) {
  if (stats.total === 0) {
    return (
      <span className="text-caption text-fg-dim italic">
        Nothing agreed yet — commitments appear here once a call establishes one.
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-caption">
      <Badge tone={stats.pct !== null && stats.pct >= 60 ? 'ok' : 'warn'}>
        {stats.done} of {stats.total} kept
      </Badge>
      {stats.open > 0 && <span className="text-fg-dim">{stats.open} still open</span>}
      {stats.dropped > 0 && <span className="text-fg-dim">· {stats.dropped} dropped</span>}
    </span>
  );
}
