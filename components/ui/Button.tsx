/**
 * The one button.
 *
 * Replaces five hand-written class strings, three of which were the same string copy-pasted for
 * Export .md / .json / Share link. `ButtonLink` exists because three of those are anchors — same
 * geometry, different element, which is exactly the case a shared `styles()` function is for.
 */
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-on-brand border border-transparent hover:bg-brand-hover shadow-card',
  secondary:
    'bg-surface text-fg-muted border border-border-strong hover:bg-surface-inset hover:text-fg',
  ghost: 'bg-transparent text-fg-muted border border-transparent hover:bg-surface-inset hover:text-fg',
  /**
   * "Test the gate" is destructive-looking on purpose — it feeds deliberately broken claims through
   * the real gate — but it is not a destructive ACTION, so it is outlined rather than filled.
   */
  danger: 'bg-bad-wash text-bad border border-bad-border hover:bg-bad-wash/70',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-micro gap-1.5',
  md: 'h-9 px-3.5 text-meta gap-2',
};

export function buttonStyles(variant: ButtonVariant = 'secondary', size: ButtonSize = 'sm') {
  return cx(
    'inline-flex shrink-0 items-center justify-center rounded-control font-medium',
    'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
};

export function Button({ variant, size, className, children, ...rest }: ButtonProps) {
  return (
    <button className={cx(buttonStyles(variant, size), className)} {...rest}>
      {children}
    </button>
  );
}

type ButtonLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
};

export function ButtonLink({ variant, size, className, children, ...rest }: ButtonLinkProps) {
  return (
    <a className={cx(buttonStyles(variant, size), className)} {...rest}>
      {children}
    </a>
  );
}
