import { notFound } from 'next/navigation';
import { getCall, getExtraction, getSegments } from '@/lib/db';
import { loadSamples } from '@/lib/samples';
import { getCrm } from '@/lib/crm';
import { CallWorkspace } from '@/components/CallWorkspace';
import type { CallBundle } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function CallPage({ params }: PageProps<'/calls/[id]'>) {
  const { id } = await params;

  // Deep-linking straight to a sample call has to work on a cold database.
  if (!(await getCall(id))) await loadSamples();

  const call = await getCall(id);
  if (!call) notFound();

  const bundle: CallBundle = {
    call,
    segments: await getSegments(id),
    extraction: await getExtraction(id),
  };

  /**
   * Account context is resolved on the server — `getCrm()` reads `process.env.CRM_PROVIDER`, which
   * only exists server-side, and a real adapter would be making authenticated calls here. It is
   * null whenever the call has no CRM record, and every consumer degrades rather than crashing.
   */
  const crm = await getCrm().forCall(id);

  return <CallWorkspace bundle={bundle} crm={crm} />;
}
