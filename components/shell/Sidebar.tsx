'use client';

/**
 * The left nav.
 *
 * It lists only destinations that exist — Calls and New analysis. Inventing a plausible-looking
 * nav full of dead links would be the interface equivalent of an uncited claim, which is the one
 * thing this product argues against.
 *
 * Below `lg` it narrows to an icon rail rather than sliding away behind a hamburger: this is a
 * desktop tool, and a rail keeps the current section visible at every width.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AudioLines, Building2, Upload } from 'lucide-react';
import { LogoMark, PRODUCT_NAME, PRODUCT_TAGLINE } from '@/components/Logo';
import { cx } from '@/components/ui/cx';

const NAV = [
  { href: '/', label: 'Calls', icon: AudioLines, match: (p: string) => p === '/' },
  {
    href: '/#upload',
    label: 'New analysis',
    icon: Upload,
    match: () => false,
  },
  { href: '/setup', label: 'Setup', icon: Building2, match: (p: string) => p.startsWith('/setup') },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      className={cx(
        'sticky top-0 flex h-dvh shrink-0 flex-col border-r border-border-subtle bg-surface',
        'w-[var(--sidebar-w-collapsed)] lg:w-[var(--sidebar-w)]',
      )}
    >
      <div className="flex h-[var(--header-h)] shrink-0 items-center border-b border-border-subtle px-3 lg:px-4">
        {/* Below `lg` the rail shows the mark alone — which is exactly what a mark is for, and why
            the wordmark is text beside it rather than baked into the image. */}
        <Link
          href="/"
          title={PRODUCT_NAME}
          className="flex min-w-0 items-center gap-2.5 rounded-control transition-opacity hover:opacity-80"
        >
          <LogoMark />
          <span className="hidden min-w-0 flex-col lg:flex">
            <span className="truncate text-body leading-tight font-semibold text-fg">
              {PRODUCT_NAME}
            </span>
            <span className="truncate text-caption leading-tight text-fg-dim">
              {PRODUCT_TAGLINE}
            </span>
          </span>
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-1 p-2 lg:p-3">
        {NAV.map(({ href, label, icon: Icon, match }) => {
          const active = match(pathname);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              title={label}
              className={cx(
                'flex items-center gap-3 rounded-control px-2.5 py-2 text-meta font-medium transition-colors',
                'justify-center lg:justify-start',
                active
                  ? 'bg-brand-wash text-brand'
                  : 'text-fg-muted hover:bg-surface-inset hover:text-fg',
              )}
            >
              <Icon size={17} strokeWidth={2} className="shrink-0" />
              <span className="hidden lg:inline">{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="hidden border-t border-border-subtle p-3 lg:block">
        <a
          href="https://docs.pyai.com/quickstart"
          target="_blank"
          rel="noreferrer"
          className="block text-caption text-fg-dim transition-colors hover:text-brand"
        >
          Runs on PyAI — mint a key
        </a>
        <p className="mt-1.5 text-caption text-fg-dim">
          MIT licensed · every claim links to its proof
        </p>
      </div>
    </aside>
  );
}
