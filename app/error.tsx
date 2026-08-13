'use client';

/**
 * The error boundary. There was none, so a throw anywhere in a page rendered the framework's
 * default overlay in production — which, on a demo machine, is the worst possible screen.
 *
 * It shows the real message rather than a friendly euphemism: this app's whole argument is that
 * you should be able to see what actually happened.
 */
import { RotateCcw, TriangleAlert } from 'lucide-react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="flex max-w-lg flex-col items-center text-center">
        <span className="grid size-12 place-items-center rounded-full bg-bad-wash text-bad">
          <TriangleAlert size={22} aria-hidden />
        </span>
        <h1 className="mt-4 text-title font-semibold text-fg">Something broke</h1>
        <p className="mt-2 text-body text-fg-muted">
          The run was still recorded. Here is what the app actually threw:
        </p>
        <pre className="mt-3 w-full overflow-x-auto rounded-control border border-border-subtle bg-surface-inset px-3 py-2 text-left font-mono text-micro text-fg-muted">
          {error.message}
          {error.digest ? `\n\ndigest: ${error.digest}` : ''}
        </pre>
        <button
          onClick={reset}
          className="mt-5 inline-flex h-9 items-center gap-2 rounded-control bg-brand px-3.5 text-meta font-medium text-on-brand transition-colors hover:bg-brand-hover"
        >
          <RotateCcw size={14} aria-hidden />
          Try again
        </button>
      </div>
    </div>
  );
}
