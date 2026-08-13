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
import { db } from './db';
import type { CallContext, DealStage, Meeting, Participant, Person } from './crm/types';

/** Detail that rides along as a JSON blob rather than as its own columns. */
export type CompanyDetail = {
  domain?: string;
  employees?: string;
  location?: string;
  deal?: {
    name: string;
    amount: number;
    currency: 'USD';
    close_date: string;
    owner: string;
    days_in_stage: number;
  };
  participants?: Participant[];
  associated?: Person[];
  history?: Meeting[];
  next_meeting?: { date: string; title: string } | null;
};

export type Company = {
  id: string;
  name: string;
  industry: string | null;
  size_band: string | null;
  website: string | null;
  notes: string | null;
  stage: DealStage;
  created_at: number;
  detail: CompanyDetail | null;
};

/**
 * `node:sqlite` returns rows with a NULL PROTOTYPE, which React Server Components refuse to
 * serialize. Every read rebuilds a plain object field by field — the same rule as `toCall`.
 */
function toCompany(r: Record<string, unknown>): Company {
  let detail: CompanyDetail | null = null;
  if (typeof r.detail === 'string' && r.detail) {
    try {
      detail = JSON.parse(r.detail) as CompanyDetail;
    } catch {
      detail = null; // a corrupt blob must not take down the page that lists it
    }
  }
  return {
    id: r.id as string,
    name: r.name as string,
    industry: (r.industry as string | null) ?? null,
    size_band: (r.size_band as string | null) ?? null,
    website: (r.website as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    stage: (r.stage as DealStage) ?? 'Discovery',
    created_at: r.created_at as number,
    detail,
  };
}

export function listCompanies(): Company[] {
  return (
    db().prepare(`SELECT * FROM companies ORDER BY name COLLATE NOCASE`).all() as Record<
      string,
      unknown
    >[]
  ).map(toCompany);
}

export function getCompany(id: string): Company | null {
  const r = db().prepare(`SELECT * FROM companies WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? toCompany(r) : null;
}

export function upsertCompany(c: Company): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO companies
         (id,name,industry,size_band,website,notes,stage,created_at,detail)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      c.id,
      c.name,
      c.industry,
      c.size_band,
      c.website,
      c.notes,
      c.stage,
      c.created_at,
      c.detail ? JSON.stringify(c.detail) : null,
    );
}

/** Edit the fields a user can actually change from /setup. Absent fields are left alone. */
export function updateCompany(
  id: string,
  patch: Partial<Pick<Company, 'name' | 'industry' | 'size_band' | 'website' | 'notes' | 'stage'>>,
): Company | null {
  const existing = getCompany(id);
  if (!existing) return null;
  const merged: Company = { ...existing, ...patch };
  upsertCompany(merged);
  return merged;
}

// ── call ↔ company link ──────────────────────────────────────────────────────

export function linkCallToCompany(callId: string, companyId: string): void {
  db()
    .prepare(`INSERT OR REPLACE INTO call_companies (call_id, company_id) VALUES (?,?)`)
    .run(callId, companyId);
}

export function companyForCall(callId: string): Company | null {
  const r = db().prepare(`SELECT company_id FROM call_companies WHERE call_id = ?`).get(callId) as
    | { company_id?: string }
    | undefined;
  return r?.company_id ? getCompany(r.company_id) : null;
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
