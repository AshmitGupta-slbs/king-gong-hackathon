/**
 * Public share page — the "send the notes to your manager" surface.
 *
 * Read-only: no upload, and no gate-test button, because this is the link you hand to someone who
 * was not on the call. The receipts still work, which is the whole reason the link is worth
 * sending: the recipient can click any claim and hear the moment it came from.
 *
 * It deliberately sits OUTSIDE the `(app)` route group, so it inherits the bare document layout
 * and none of the sender's navigation, usage counters or upload affordances. A recipient should
 * see the call and one honest way in — not somebody else's workspace.
 */
import { notFound } from 'next/navigation';
import { AudioLines, Share2 } from 'lucide-react';
import { getCallByShareId, getExtraction, getSegments } from '@/lib/db';
import { loadSamples } from '@/lib/samples';
import { getCrm } from '@/lib/crm';
import { CallWorkspace } from '@/components/CallWorkspace';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
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

  /**
   * A share link goes to someone outside the company. They get the names of the people who spoke,
   * so the transcript reads properly — and nothing else from the CRM.
   *
   * Note this deliberately extracts `participants` instead of passing the context and hiding the
   * rest in the UI: everything handed to a client component is serialized into the page, so the
   * deal value would sit in the HTML of a forwarded link even if no component ever drew it.
   */
  const participants = getCrm().forCall(call.id)?.participants ?? [];

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex h-[var(--header-h)] shrink-0 items-center gap-3 border-b border-border-subtle bg-surface px-4 lg:px-6">
        <span className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-control bg-brand text-on-brand">
            <AudioLines size={17} strokeWidth={2.25} aria-hidden />
          </span>
          <span className="text-body font-semibold text-fg">OpenGong Lite</span>
        </span>
        <Badge tone="neutral">
          <Share2 size={12} aria-hidden />
          Shared read-only
        </Badge>
        <span className="ml-auto flex items-center gap-3">
          <span className="hidden text-micro text-fg-dim md:inline">
            Every claim links to the moment that supports it
          </span>
          <ButtonLink href="/" variant="primary">
            Analyse your own call
          </ButtonLink>
        </span>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <CallWorkspace bundle={bundle} participants={participants} readOnly />
      </main>
    </div>
  );
}
