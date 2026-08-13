/**
 * A labelled textarea, sharing the input frame.
 *
 * `inputStyles` is imported rather than re-declared — that export exists precisely so the frame is
 * defined once. Copying it is how this codebase previously ended up with three paddings for one
 * concept.
 */
import type { TextareaHTMLAttributes } from 'react';
import { cx } from './cx';
import { FieldLabel, inputStyles } from './Field';

export function Textarea({
  label,
  hint,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <textarea className={cx(inputStyles, 'min-h-20 resize-y leading-relaxed', className)} {...rest} />
      {hint && <span className="text-caption leading-relaxed text-fg-dim">{hint}</span>}
    </label>
  );
}
