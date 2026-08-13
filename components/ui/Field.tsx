/**
 * A labelled input, and the shared input styling behind it.
 *
 * `inputStyles` is exported because the file input needs the same frame with different internals
 * (`file:` pseudo-element rules), and copying the frame is how this codebase ended up with three
 * paddings for one concept.
 */
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export const inputStyles = cx(
  'w-full rounded-control border border-border-strong bg-surface px-3 py-2',
  'text-meta text-fg placeholder:text-fg-dim',
  'transition-colors outline-none focus:border-brand focus:ring-2 focus:ring-brand-wash',
);

export function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="text-micro font-medium text-fg-muted">{children}</span>;
}

export function Field({
  label,
  hint,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <input className={cx(inputStyles, className)} {...rest} />
      {hint && <span className="text-caption text-fg-dim">{hint}</span>}
    </label>
  );
}
