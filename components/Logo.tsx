/**
 * The King Gong lockup — the mark, and optionally the name beside it.
 *
 * One definition because three places draw it (the sidebar at two widths, and the public share
 * header), and a brand that is re-assembled at each call site is how you end up with three sizes of
 * the same logo. The same reasoning as `inputStyles` in ui/Field.
 *
 * The mark is rendered WITHOUT a coloured plate behind it. The old placeholder was a lucide glyph
 * that needed a filled violet square to read as a logo; this one is a drawing with its own weight,
 * and a plate behind it only fights the crown.
 *
 * `alt` is empty on purpose wherever the name is rendered next to it: the image and the text say the
 * same thing, and announcing both makes a screen reader read the product name twice.
 */
import Image from 'next/image';
import { cx } from '@/components/ui/cx';

export const PRODUCT_NAME = 'King Gong';
export const PRODUCT_TAGLINE = 'deal notes with receipts';

export function LogoMark({ size = 34, className }: { size?: number; className?: string }) {
  return (
    <Image
      src="/logo-mark.png"
      alt=""
      width={size}
      height={size}
      // Loaded on every page and above the fold on all of them, so it is worth the preload hint
      // rather than a first paint with a hole where the logo goes.
      priority
      className={cx('shrink-0 object-contain', className)}
    />
  );
}

/** The mark with the product name, as it appears in the sidebar and the share header. */
export function Logo({ tagline = false, size }: { tagline?: boolean; size?: number }) {
  return (
    <>
      <LogoMark size={size} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body leading-tight font-semibold text-fg">
          {PRODUCT_NAME}
        </span>
        {tagline && (
          <span className="truncate text-caption leading-tight text-fg-dim">{PRODUCT_TAGLINE}</span>
        )}
      </span>
    </>
  );
}
