'use client';

/**
 * A tab strip with an underline, matching the reference dashboards.
 *
 * Controlled on purpose: the call page keeps the active tab in its own state so switching tabs
 * cannot remount the transcript pane or the audio element beside it.
 */
import type { ReactNode } from 'react';
import { cx } from './cx';

export type TabDef = { id: string; label: string; count?: number; icon?: ReactNode };

export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div className={cx('flex items-center gap-1 border-b border-border-subtle', className)} role="tablist">
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={cx(
              'relative -mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-meta font-medium transition-colors',
              on
                ? 'border-brand text-brand'
                : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg',
            )}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && (
              <span
                className={cx(
                  'rounded-chip px-1.5 py-0.5 text-caption font-semibold',
                  on ? 'bg-brand-wash text-brand' : 'bg-surface-inset text-fg-muted',
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
