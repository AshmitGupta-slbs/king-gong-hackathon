/**
 * CRM provider selection — the same shape as `lib/registry/`, for the same reason.
 *
 * The call page never imports a CRM vendor. It asks for `getCrm().forCall(id)` and renders a
 * `CallContext`. Today that resolves to locally-held records seeded from fabricated demo data; a
 * HubSpot adapter would implement the identical interface and change no component.
 *
 * `describeCrm()` exists so the UI can say out loud which one is active. Fabricated account data
 * presented without a label would be the same sin as unlabelled model output.
 */
import { dbCrm } from './db';
import { fixtureCrm } from './fixture';
import type { CrmProvider } from './types';

const PROVIDERS: Record<string, CrmProvider> = {
  /** Editable rows in SQLite, seeded from the fixture. The default — /setup writes to this. */
  db: dbCrm,
  /** The committed fixture, read-only. Kept for a deterministic demo with no database state. */
  fixture: fixtureCrm,
};

export function getCrm(): CrmProvider {
  const requested = process.env.CRM_PROVIDER?.trim().toLowerCase();
  if (!requested) return dbCrm;
  const found = PROVIDERS[requested];
  if (!found) {
    /**
     * Throw rather than fall back, matching `lib/registry/index.ts`'s handling of `LLM_PROVIDER`.
     * A silent fallback would mean `CRM_PROVIDER=hubspot` on a build without the adapter renders
     * fabricated contacts under a real customer's name — indistinguishable from the real thing.
     */
    throw new Error(
      `CRM_PROVIDER="${requested}" is not a known provider. Known: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return found;
}

/**
 * Providers whose contents are demo data rather than a real customer system.
 *
 * This used to be `name !== 'fixture-crm'`, which quietly became a lie the moment a second local
 * provider appeared: `db-crm` serves the same fabricated five, seeded into SQLite, and would have
 * been labelled a REAL CRM — dropping the disclaimer exactly where it still applies. An allowlist
 * of the real ones is the version that cannot rot in that direction; a new local provider defaults
 * to "demo", and only something genuinely connected to a customer system gets to claim otherwise.
 */
const REAL_CRM_PROVIDERS = new Set<string>(['hubspot']);

export const isRealCrm = (name: string) => REAL_CRM_PROVIDERS.has(name);

export function describeCrm() {
  const crm = getCrm();
  return {
    crm: crm.name,
    crmIsReal: isRealCrm(crm.name),
    crmDetail: isRealCrm(crm.name)
      ? crm.name
      : `${crm.name} · locally-held demo records, NOT a real CRM`,
  };
}

export type { CallContext, CrmProvider, Participant, Person } from './types';
