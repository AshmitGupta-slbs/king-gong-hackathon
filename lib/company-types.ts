/**
 * The Company shape, in its own module.
 *
 * Split out purely to break a cycle: the storage contract (`db-types.ts`) names these types, and
 * `companies.ts` calls the storage layer. Keeping the shapes here lets both import them without
 * importing each other.
 */
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

export type { CallContext, DealStage, Meeting, Participant, Person };
