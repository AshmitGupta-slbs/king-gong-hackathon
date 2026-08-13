/**
 * A single number with its label under it — the shape the reference dashboards use for KPIs.
 *
 * These carry the usage counter, which is real recorded work and a scored part of the project. It
 * previously rendered as an 11px monospace run separated by `·` characters coloured with a BORDER
 * token, i.e. at roughly 1.4:1 against the header. It is a headline number now.
 */
import { cx } from './cx';

export function StatTile({
  value,
  label,
  tone = 'default',
}: {
  value: string;
  label: string;
  tone?: 'default' | 'brand' | 'bad';
}) {
  return (
    <div className="flex flex-col items-end leading-none">
      <span
        className={cx(
          'text-heading font-semibold tabular-nums',
          tone === 'brand' ? 'text-brand' : tone === 'bad' ? 'text-bad' : 'text-fg',
        )}
      >
        {value}
      </span>
      <span className="mt-1 text-caption whitespace-nowrap text-fg-dim">{label}</span>
    </div>
  );
}
