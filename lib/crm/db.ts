/**
 * CRM backed by the `companies` table.
 *
 * This is what makes a company profile and a CRM record the same object: /setup writes a row, the
 * call page reads the same row through the interface it already used for the fixture, and no
 * component changed. The fixture still exists as the SEED for these rows — see `seedCompanies()` —
 * rather than as a second, parallel source of account data.
 */
import { companyForCall, companyToCallContext, getCompany, upsertCompany } from '@/lib/companies';
import type { Company } from '@/lib/companies';
import { fixtureCrm } from './fixture';
import type { CallContext, CrmProvider } from './types';

/** Sample call ids the fixture carries context for. Also the ids of the seeded companies. */
const SEEDED_CALL_IDS = [
  'clean-close',
  'heavy-objections',
  'competitor-named',
  'pricing-pushback',
  'no-decision',
] as const;

const companyIdFor = (callId: string) => `co-${callId}`;

/**
 * Turn the committed fixture into editable company rows, once.
 *
 * Idempotent and skip-if-present, matching `loadSamples()` — re-running must not overwrite notes a
 * user has since typed into /setup. Seeded values keep the fixture's own rules: every detail is
 * anchored in something actually said on the call, and dates are fixed strings rather than anything
 * derived from `Date.now()`, so the demo reads identically tomorrow.
 */
export async function seedCompanies(): Promise<{ seeded: string[]; skipped: string[] }> {
  const seeded: string[] = [];
  const skipped: string[] = [];

  for (const callId of SEEDED_CALL_IDS) {
    const id = companyIdFor(callId);
    if (await getCompany(id)) {
      skipped.push(id);
      continue;
    }
    const ctx = await fixtureCrm.forCall(callId);
    if (!ctx) continue;

    const company: Company = {
      id,
      name: ctx.account.name,
      industry: ctx.account.industry,
      size_band: ctx.account.employees,
      website: ctx.account.domain,
      notes: seedNotes[callId] ?? null,
      stage: ctx.deal.stage,
      // Fixed, not Date.now(): ordering in /setup must not depend on when someone first ran the app.
      created_at: Date.parse('2026-08-01T00:00:00Z'),
      detail: {
        domain: ctx.account.domain,
        employees: ctx.account.employees,
        location: ctx.account.location,
        deal: {
          name: ctx.deal.name,
          amount: ctx.deal.amount,
          currency: 'USD',
          close_date: ctx.deal.close_date,
          owner: ctx.deal.owner,
          days_in_stage: ctx.deal.days_in_stage,
        },
        participants: ctx.participants,
        associated: ctx.associated,
        history: ctx.history,
        next_meeting: ctx.next_meeting,
      },
    };
    await upsertCompany(company);
    seeded.push(id);
  }
  return { seeded, skipped };
}

/**
 * What a rep would have typed into /setup before each of these calls.
 *
 * Written from what the account context genuinely was going in — not from what the call revealed,
 * which would make the grounding demo circular.
 */
const seedNotes: Record<string, string> = {
  'clean-close':
    'Security review was the last open item. Procurement has a budget line reserved; Elena handles vendor forms.',
  'heavy-objections':
    'Rolled out a call-recording tool two years ago and it failed on adoption. Anything touching patient data must clear the privacy office. Team is stretched across two regions.',
  'competitor-named':
    'Evaluating us against Gong and Chorus. Their VP used Gong at a previous company and trusts it. Price-sensitive on suite bloat.',
  'pricing-pushback':
    'Price-sensitive: CFO requires new spend to displace existing spend, not add to it. Finance committee approval needed above their threshold.',
  'no-decision':
    'Hiring paused; original driver was ramping new reps. Enablement lead left and nobody picked the initiative up.',
};

export const dbCrm: CrmProvider = {
  name: 'db-crm',
  async forCall(callId: string): Promise<CallContext | null> {
    // An explicit link wins; otherwise fall back to the seeded company for a sample call, so
    // deep-linking a bundled call still shows its account without a link row existing.
    const linked = (await companyForCall(callId)) ?? (await getCompany(companyIdFor(callId)));
    return linked ? companyToCallContext(linked) : null;
  },
};
