/**
 * Public share page — the "send the notes to your manager" surface.
 *
 * Read-only: no upload, and no gate-test button, because this is the link you hand to someone who
 * was not on the call. The receipts still work, which is the whole reason the link is worth
 * sending: the recipient can click any claim and hear the moment it came from.
 */
import { notFound } from 'next/navigation';
import { getCallByShareId, getExtraction, getSegments } from '@/lib/db';
import { loadSamples } from '@/lib/samples';
import { CallWorkspace } from '@/components/CallWorkspace';
import type { CallBundle } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function SharePage({ params }: PageProps<'/s/[shareId]'>) {
  const { shareId } = await params;

  if (!getCallByShareId(shareId)) loadSamples();

  const call = getCallByShareId(shareId);
  if (!call) notFound();

  const bundle: CallBundle = {
    call,
    segments: getSegments(call.id),
    extraction: getExtraction(call.id),
  };

  return (
    <>
      <div className="border-b border-border-subtle bg-bg-inset px-5 py-2">
        <p className="mx-auto max-w-[1600px] text-[11px] text-fg-dim">
          Shared read-only · every claim below links to the moment in the recording that supports it
        </p>
      </div>
      <CallWorkspace bundle={bundle} readOnly />
    </>
  );
}
