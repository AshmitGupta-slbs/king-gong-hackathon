/**
 * The receipt. Clicking one moves the audio to the line that proves the claim.
 *
 * This is the single most important control in the product, and its class string was previously
 * written out four separate times — so it now lives here exactly once. It is violet because it is
 * an INTERACTION; it is not green, because green in this app means "the gate verified this", and a
 * citation chip is the thing you click to check that for yourself.
 */
import { cx } from './cx';

export function CiteChip({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cx(
        'inline-flex items-center rounded-chip border border-brand-border bg-brand-wash',
        'px-1.5 py-0.5 font-mono text-caption leading-4 font-medium text-brand',
        'transition-colors hover:border-brand hover:bg-brand hover:text-on-brand',
      )}
    >
      {children}
    </button>
  );
}

/** Shown where a claim survived with no resolvable citation — rare, and deliberately loud. */
export function NoCiteChip() {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-chip border border-bad-border bg-bad-wash',
        'px-1.5 py-0.5 text-caption leading-4 font-medium text-bad',
      )}
    >
      no resolvable citation
    </span>
  );
}
