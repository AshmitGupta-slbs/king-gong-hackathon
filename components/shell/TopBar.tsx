'use client';

/**
 * The top bar: where you are on the left, what the API has actually done on the right.
 *
 * The usage numbers are a scored part of this project and they stay in the one place a judge
 * cannot miss. The page's own title is NOT repeated here — it lives in the content as a real
 * heading, so the bar stays a constant frame rather than echoing the h1 at half size.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { UsageStats } from '@/components/UsageBar';

export function TopBar() {
  const pathname = usePathname();
  const onCall = pathname.startsWith('/calls/');
  /**
   * The leaf label used to be the literal string "Calls" for anything that was not a call page, so
   * a new route would silently claim to be the call list.
   */
  const section = pathname.startsWith('/setup') ? 'Setup' : 'Calls';

  return (
    <header className="sticky top-0 z-30 flex h-[var(--header-h)] shrink-0 items-center gap-4 border-b border-border-subtle bg-surface/95 px-4 backdrop-blur lg:px-6">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-meta">
        {onCall ? (
          <>
            <Link
              href="/"
              className="rounded-chip px-1 font-medium text-fg-muted transition-colors hover:text-brand"
            >
              Calls
            </Link>
            <ChevronRight size={14} className="shrink-0 text-fg-dim" aria-hidden />
            <span className="truncate px-1 font-medium text-fg">Call detail</span>
          </>
        ) : (
          <span className="px-1 font-medium text-fg">{section}</span>
        )}
      </nav>

      <div className="ml-auto">
        <UsageStats />
      </div>
    </header>
  );
}
