import Link from 'next/link';
import { SearchX } from 'lucide-react';

/** A designed 404. There was none before — a missing share link rendered the framework default. */
export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <span className="grid size-12 place-items-center rounded-full bg-surface-inset text-fg-dim">
          <SearchX size={22} aria-hidden />
        </span>
        <h1 className="mt-4 text-title font-semibold text-fg">This call does not exist</h1>
        <p className="mt-2 text-body text-fg-muted">
          The link may have expired, or the call was never seeded on this instance.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex h-9 items-center rounded-control bg-brand px-3.5 text-meta font-medium text-on-brand transition-colors hover:bg-brand-hover"
        >
          Back to calls
        </Link>
      </div>
    </div>
  );
}
