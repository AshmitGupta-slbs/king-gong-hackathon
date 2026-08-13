/**
 * A status badge that always carries a WORD.
 *
 * The old UI signalled run status with an 8px coloured dot whose meaning lived only in `title=` —
 * unreachable by touch, unreliable for assistive tech, and invisible to anyone who does not know
 * the colour code. Colour is the secondary signal here; the label is the primary one.
 */
import type { ReactNode } from 'react';
import { cx } from './cx';

export type BadgeTone = 'brand' | 'ok' | 'warn' | 'bad' | 'neutral';

const TONES: Record<BadgeTone, { chip: string; dot: string }> = {
  brand: { chip: 'bg-brand-wash text-brand border-brand-border', dot: 'bg-brand' },
  ok: { chip: 'bg-ok-wash text-ok border-ok-border', dot: 'bg-ok' },
  warn: { chip: 'bg-warn-wash text-warn border-warn-border', dot: 'bg-warn' },
  bad: { chip: 'bg-bad-wash text-bad border-bad-border', dot: 'bg-bad' },
  neutral: { chip: 'bg-surface-inset text-fg-muted border-border-subtle', dot: 'bg-fg-dim' },
};

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
  hint,
  className,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
  /** Expanded meaning. Rendered as an accessible label, not a hover-only tooltip. */
  hint?: string;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <span
      title={hint}
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-chip border px-2 py-0.5',
        'text-micro font-medium whitespace-nowrap',
        t.chip,
        className,
      )}
    >
      {dot && <span aria-hidden className={cx('size-1.5 rounded-full', t.dot)} />}
      {children}
      {/* Read aloud after the label rather than replacing it, and still available on hover. */}
      {hint && <span className="sr-only"> — {hint}</span>}
    </span>
  );
}
