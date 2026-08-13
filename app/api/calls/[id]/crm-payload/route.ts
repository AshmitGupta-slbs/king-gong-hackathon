/**
 * GET /api/calls/[id]/crm-payload — the document a HubSpot push would post.
 *
 * A sibling of `export/`, and deliberately a GET that returns JSON rather than a POST that does
 * something: there is no push. The whole point is that the payload can be inspected, diffed and
 * argued with before anybody wires a credential to it.
 *
 * `node:sqlite` means the Node runtime, not Edge.
 */
import { NextResponse } from 'next/server';
import { getCall, getExtraction, getSegments } from '@/lib/db';
import { companyForCall } from '@/lib/companies';
import { actionItemsForCompany } from '@/lib/action-items';
import { toHubspotPayload } from '@/lib/crm/payload';
import type { CallBundle } from '@/lib/types';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const call = await getCall(id);
  if (!call) return NextResponse.json({ error: 'No such call.' }, { status: 404 });

  const [segments, extraction, company] = await Promise.all([
    getSegments(id),
    getExtraction(id),
    companyForCall(id),
  ]);
  const actionItems = company ? await actionItemsForCompany(company.id) : [];
  const bundle: CallBundle = { call, segments, extraction };

  /**
   * The origin of THIS deployment, taken from the request rather than configured.
   *
   * Citation links have to resolve for someone reading the note inside HubSpot, and this app runs
   * on localhost, on Railway and on whatever a fork deploys to. A configured base URL would be one
   * more thing to get wrong in an environment where getting it wrong produces links that look fine
   * and go nowhere.
   */
  const baseUrl = new URL(req.url).origin;

  return NextResponse.json(toHubspotPayload({ bundle, company, actionItems, baseUrl }), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
