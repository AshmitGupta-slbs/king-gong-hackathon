/**
 * CRM provider selection — the same shape as `lib/registry/`, for the same reason.
 *
 * The call page never imports a CRM vendor. It asks for `getCrm().forCall(id)` and renders a
 * `CallContext`. Today that resolves to fabricated demo records; a HubSpot adapter would implement
 * the identical interface and change no component.
 *
 * `describeCrm()` exists so the UI can say out loud which one is active. Fabricated account data
 * presented without a label would be the same sin as unlabelled model output.
 */
import { fixtureCrm } from './fixture';
import type { CrmProvider } from './types';

const PROVIDERS: Record<string, CrmProvider> = {
  fixture: fixtureCrm,
};

export function getCrm(): CrmProvider {
  const requested = process.env.CRM_PROVIDER?.trim().toLowerCase();
  if (!requested) return fixtureCrm;
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

/** Is the active CRM real customer data, or demo records? */
export const isRealCrm = (name: string) => name !== 'fixture-crm';

export function describeCrm() {
  const crm = getCrm();
  return {
    crm: crm.name,
    crmIsReal: isRealCrm(crm.name),
    crmDetail: isRealCrm(crm.name)
      ? crm.name
      : `${crm.name} · fabricated demo records, NOT a real CRM`,
  };
}

export type { CallContext, CrmProvider, Participant, Person } from './types';
