/**
 * Setup: the accounts, and the context that grounds their notes.
 *
 * This is the primary way context gets entered — a rep keeps their account list current here,
 * before or between calls, rather than remembering to fill something in at upload time. The upload
 * screen keeps a quick-add as a fallback, but this is the real one.
 */
import { listCompanies } from '@/lib/companies';
import { learningsForCompany, suggestedNotes } from '@/lib/learnings';
import { actionItemsForCompany, followThrough } from '@/lib/action-items';
import type { FollowThrough } from '@/lib/action-item-types';
import { loadSamples } from '@/lib/samples';
import { describeCrm } from '@/lib/crm';
import { SetupCompanies } from '@/components/SetupCompanies';
import { Badge } from '@/components/ui/Badge';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  // Seeds the demo accounts on a cold database, exactly as the home page does for calls.
  await loadSamples();
  const companies = await listCompanies();
  // Keyed by company so the client component can render each account's ledger without a fetch.
  // The suggestion is composed over the FULL ledger (500 rows), not the 20 listed as evidence —
  // it speaks for everything not yet in the notes, so a narrower window would quietly drop facts.
  const [learnings, suggestions, follow] = await Promise.all([
    Object.fromEntries(
      await Promise.all(
        companies.map(async (c) => [c.id, await learningsForCompany(c.id, 20)] as const),
      ),
    ) as Record<string, Awaited<ReturnType<typeof learningsForCompany>>>,
    Object.fromEntries(
      await Promise.all(companies.map(async (c) => [c.id, await suggestedNotes(c.id)] as const)),
    ) as Record<string, Awaited<ReturnType<typeof suggestedNotes>>>,
    // How well each account keeps its word — derived from the ledger on read, like everything else
    // here, so it cannot go stale against the items it counts.
    Object.fromEntries(
      await Promise.all(
        companies.map(
          async (c) => [c.id, followThrough(await actionItemsForCompany(c.id))] as const,
        ),
      ),
    ) as Record<string, FollowThrough>,
  ]);
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
        <SetupCompanies
          companies={companies}
          learnings={learnings}
          suggestions={suggestions}
          followThrough={follow}
        />
      </div>
    </div>
  );
}
