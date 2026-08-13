/**
 * The panel. One radius, one padding, one heading treatment.
 *
 * The heading is 15px semibold in near-black. It used to be 11px uppercase in the dimmest grey in
 * the palette — the same treatment given to every other heading in the app, which is why no panel
 * looked more important than any other.
 */
import type { ReactNode } from 'react';
import { cx } from './cx';

export type CardTone = 'default' | 'warn' | 'bad';

const TONES: Record<CardTone, string> = {
  default: 'border-border-subtle',
  warn: 'border-warn-border',
  bad: 'border-bad-border',
};

export function Card({
  title,
  count,
  tone = 'default',
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  count?: number;
  tone?: CardTone;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cx('rounded-card border bg-surface shadow-card', TONES[tone], className)}
    >
      {(title || actions) && (
        <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          {title && (
            <h2 className="text-heading font-semibold text-fg">
              {title}
            </h2>
          )}
          {count !== undefined && (
            <span className="rounded-chip bg-surface-inset px-1.5 py-0.5 text-caption font-semibold text-fg-muted">
              {count}
            </span>
          )}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx('px-4 py-3.5', bodyClassName)}>{children}</div>
    </section>
  );
}
