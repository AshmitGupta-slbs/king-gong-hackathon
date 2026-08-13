/**
 * Companies: the account record, the CRM record, and the source of extraction context.
 *
 * One entity, not three. A "company profile" and a "deal" are the same object here — the spec is
 * explicit about not building two parallel structures — so `stage` sits on the company row and the
 * CRM provider projects the same row into the `CallContext` shape the call page already renders.
 *
 * What a company is FOR, beyond display: `renderAccountContext()` turns the user-entered fields
 * into the block that gets injected into the extraction prompt, so notes for a price-sensitive
 * healthcare account are read with that in mind. See the hard rule in `extract-shared.ts` — context
 * may sharpen what the model looks for, but it can never be the source of a cited claim.
 */
import { store } from './db';
import { renderLearnedContext } from './learnings';
import type { CallContext } from './crm/types';
import type { Company, CompanyDetail } from './company-types';

export type { Company, CompanyDetail };

export const listCompanies = () => store().listCompanies();
export const getCompany = (id: string) => store().getCompany(id);
export const upsertCompany = (c: Company) => store().upsertCompany(c);

/** Edit the fields a user can actually change from /setup. Absent fields are left alone. */
export async function updateCompany(
  id: string,
  patch: Partial<Pick<Company, 'name' | 'industry' | 'size_band' | 'website' | 'notes' | 'stage'>>,
): Promise<Company | null> {
  const existing = await getCompany(id);
  if (!existing) return null;
  const merged: Company = { ...existing, ...patch };
  await upsertCompany(merged);
  return merged;
}

// ── call ↔ company link ──────────────────────────────────────────────────────

export const linkCallToCompany = (callId: string, companyId: string) =>
  store().linkCallToCompany(callId, companyId);

export async function companyForCall(callId: string): Promise<Company | null> {
  const id = await store().companyIdForCall(callId);
  return id ? getCompany(id) : null;
}

// ── the extraction context block ─────────────────────────────────────────────

/**
 * Render the account context exactly as the model will see it.
 *
 * Returns null when there is nothing worth saying — a company with only a name adds no grounding,
 * and an empty labelled block is just tokens that dilute the transcript. Every line is a fact a
 * human typed into /setup; nothing here is inferred.
 */
export function renderAccountContext(c: Company | null): string | null {
  if (!c) return null;
  const lines: string[] = [];
  if (c.industry) lines.push(`industry: ${c.industry}`);
  if (c.size_band) lines.push(`size: ${c.size_band}`);
  if (c.stage) lines.push(`deal stage: ${c.stage}`);
  if (c.notes) lines.push(`notes: ${c.notes}`);
  if (lines.length === 0) return null;
  return [`company: ${c.name}`, ...lines].join('\n');
}

/**
 * What earlier calls with this account established, for the next call's prompt.
 *
 * Deliberately a SEPARATE function from `renderAccountContext` rather than more lines inside it.
 * The two are different kinds of true — one is what a person asserted, the other is what this
 * system inferred from a recording — and the prompt banners them differently. Merging them here
 * would quietly collapse that distinction at the one point where it matters most.
 */
export async function renderLearnedForCompany(c: Company | null): Promise<string | null> {
  return c ? renderLearnedContext(c.id) : null;
}

// ── projection into the shape the call page already renders ──────────────────

/**
 * A company IS the account and the deal, so this fills in the `CallContext` the UI expects without
 * a second entity behind it. Fields the user never entered get honest placeholders rather than
 * invented values.
 */
export function companyToCallContext(c: Company): CallContext {
  const d = c.detail ?? {};
  return {
    account: {
      id: c.id,
      name: c.name,
      domain: d.domain ?? c.website ?? '—',
      industry: c.industry ?? '—',
      employees: d.employees ?? c.size_band ?? '—',
      location: d.location ?? '—',
    },
    deal: {
      id: `${c.id}-deal`,
      name: d.deal?.name ?? `${c.name} — opportunity`,
      stage: c.stage,
      amount: d.deal?.amount ?? 0,
      currency: 'USD',
      close_date: d.deal?.close_date ?? '—',
      owner: d.deal?.owner ?? '—',
      days_in_stage: d.deal?.days_in_stage ?? 0,
    },
    participants: d.participants ?? [],
    associated: d.associated ?? [],
    history: d.history ?? [],
    next_meeting: d.next_meeting ?? null,
  };
}
