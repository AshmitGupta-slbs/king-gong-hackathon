/**
 * Setup: the accounts, and the context that grounds their notes.
 *
 * This is the primary way context gets entered — a rep keeps their account list current here,
 * before or between calls, rather than remembering to fill something in at upload time. The upload
 * screen keeps a quick-add as a fallback, but this is the real one.
 */
import { listCompanies } from '@/lib/companies';
import { learningsForCompany } from '@/lib/learnings';
import { loadSamples } from '@/lib/samples';
import { describeCrm } from '@/lib/crm';
import { SetupCompanies } from '@/components/SetupCompanies';
import { Badge } from '@/components/ui/Badge';

export const dynamic = 'force-dynamic';

export default function SetupPage() {
  // Seeds the demo accounts on a cold database, exactly as the home page does for calls.
  loadSamples();
  const companies = listCompanies();
  // Keyed by company so the client component can render each account's ledger without a fetch.
  const learnings = Object.fromEntries(companies.map((c) => [c.id, learningsForCompany(c.id, 20)]));
  const crm = describeCrm();

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 lg:px-6 lg:py-8">
      <header className="max-w-2xl">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-display font-semibold text-fg">Setup</h1>
          {!crm.crmIsReal && (
            <Badge tone="neutral" hint={crm.crmDetail}>
              demo records
            </Badge>
          )}
        </div>
        <p className="mt-2.5 text-body text-fg-muted">
          Context is per account, not global — every call is with a different company. What you put
          here is given to the model as background before it reads the transcript, so it knows what
          to listen for. It never becomes evidence: every claim still has to cite a real line from
          the call.
        </p>
      </header>

      <div className="mt-7">
        <SetupCompanies companies={companies} learnings={learnings} />
      </div>
    </div>
  );
}
