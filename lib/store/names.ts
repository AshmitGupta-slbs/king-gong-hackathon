/**
 * Collection names, built once from the configured prefix.
 *
 * Constants rather than string literals at call sites, because isolation inside a shared cluster is
 * only real if the prefix is applied EVERYWHERE. One forgotten literal writes into an unprefixed
 * collection another app may own.
 */
import { storeConfig } from './config';

export function collections() {
  const { prefix } = storeConfig();
  return {
    calls: `${prefix}calls`,
    segments: `${prefix}segments`,
    extractions: `${prefix}extractions`,
    runs: `${prefix}runs`,
    gateRejections: `${prefix}gate_rejections`,
    usageEvents: `${prefix}usage_events`,
    companies: `${prefix}companies`,
    callCompanies: `${prefix}call_companies`,
    companyLearnings: `${prefix}company_learnings`,
  } as const;
}

export type CollectionName = ReturnType<typeof collections>[keyof ReturnType<typeof collections>];
