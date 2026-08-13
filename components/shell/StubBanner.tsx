/**
 * "A new upload would not be analysed by a model."
 *
 * This describes the CONFIGURED extractor, which is a statement about what happens next — not about
 * the notes currently on screen. Those carry their own provenance (`extraction.extracted_by`) and
 * say so themselves, because a committed sample can have been produced by something other than
 * whatever this instance is configured with right now.
 *
 * The earlier wording — "notes on this instance come from a keyword stub" — was true only while the
 * two happened to coincide, and became false the moment they did not.
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
        <strong className="font-semibold">
          No model credential is configured, so a new upload would not be analysed by a model.
        </strong>{' '}
        <span className="text-fg-muted">
          Transcription, audio sync, the citation gate and the usage counter are all real. Each set
          of notes states its own origin. Configured extractor:{' '}
          <span className="font-mono">{registry.extractDetail}</span>
        </span>
      </p>
    </div>
  );
}
