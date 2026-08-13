/**
 * "These notes were not written by a model."
 *
 * This used to live on the home page only, which meant it was invisible on the one screen where
 * the stubbed notes are actually being read. It is part of the shell now, so it follows you onto
 * the call. A server component: the registry is readable directly, no client fetch needed.
 */
import { TriangleAlert } from 'lucide-react';
import { describeRegistry } from '@/lib/registry';

export function StubBanner() {
  const registry = describeRegistry();
  if (registry.extractIsRealModel) return null;

  return (
    <div className="flex items-start gap-2.5 border-b border-warn-border bg-warn-wash px-4 py-2.5 lg:px-6">
      <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden />
      <p className="text-micro leading-relaxed text-warn">
        <strong className="font-semibold">Notes on this instance come from a keyword stub, not a model.</strong>{' '}
        <span className="text-fg-muted">
          Transcripts, audio sync, the citation gate and the usage counter are all real — the notes
          are not. Active extractor:{' '}
          <span className="font-mono">{registry.extractDetail}</span>
        </span>
      </p>
    </div>
  );
}
