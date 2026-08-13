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

  /**
   * Fetched together rather than one after another. These three are independent, and against a
   * remote store each sequential await is a full network round trip — measured at ~2s for this page
   * on the REST gateway, versus ~0.7s in parallel. On SQLite it makes no measurable difference,
   * which is exactly why the sequential version looked fine.
   *
   * Account context is resolved on the server — `getCrm()` reads `process.env.CRM_PROVIDER`, which
   * only exists server-side, and a real adapter would be making authenticated calls here. It is
   * null whenever the call has no CRM record, and every consumer degrades rather than crashing.
   */
  const [segments, extraction, crm] = await Promise.all([
    getSegments(id),
    getExtraction(id),
    getCrm().forCall(id),
  ]);

  const bundle: CallBundle = { call, segments, extraction };

  return <CallWorkspace bundle={bundle} crm={crm} />;
}
