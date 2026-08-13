/**
 * Home: pick a sample call, or bring your own.
 *
 * The sample calls are seeded on first load so a stranger who clones this repo and runs
 * `npm run dev` lands on five fully-analysed calls with no key, no signup and no network.
 */
import { Suspense } from 'react';
import { listCallSummaries, reconcileOrphanRuns } from '@/lib/db';
import { loadSamples } from '@/lib/samples';
import { describeRegistry } from '@/lib/registry';
import { listCompanies } from '@/lib/companies';
import { UploadCard } from '@/components/UploadCard';
import { CallList, type CallListRow } from '@/components/CallList';
import { Card } from '@/components/ui/Card';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // Idempotent seed of the committed samples.
  await loadSamples();
  // Failure invariant: any run left 'running' by a killed process becomes a failed record.
  await reconcileOrphanRuns();

  /*
    `listCallSummaries` rather than `listCalls` + the sample manifest.

    The manifest is a BUILD ARTEFACT listing the five bundled samples, so joining against it meant
    an uploaded call had no status badge at all, and re-analysing a sample could not change what the
    list said about it. The status now comes from the extraction, which is the thing that decides it.
  */
  const [summaries, allCompanies] = await Promise.all([listCallSummaries(), listCompanies()]);
  const registry = describeRegistry();
  const companies = allCompanies.map((c) => ({ id: c.id, name: c.name }));

  const names = new Map(companies.map((c) => [c.id, c.name]));
  const calls: CallListRow[] = summaries.map((c) => ({
    ...c,
    company_name: c.company_id ? (names.get(c.company_id) ?? null) : null,
  }));

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 lg:px-6 lg:py-8">
      <header className="max-w-2xl">
        <h1 className="text-display font-semibold text-fg">
          Deal notes with <span className="text-brand">receipts</span>
        </h1>
        <p className="mt-2.5 text-body text-fg-muted">
          Every claim points at the exact line in the call that proves it. Claims that cannot be
          traced to a real line are dropped, not softened.
        </p>
      </header>

      <div className="mt-7 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Calls" count={calls.length} bodyClassName="p-0">
          {calls.length === 0 ? (
            <p className="px-4 py-10 text-center text-meta text-fg-dim">
              No calls yet. Run <span className="font-mono text-fg">npm run samples</span> to build
              the bundled five.
            </p>
          ) : (
            // useSearchParams reads request-time state, so it needs a boundary to suspend at.
            <Suspense fallback={<p className="px-4 py-10 text-center text-meta text-fg-dim">Loading calls…</p>}>
              <CallList calls={calls} companies={companies} />
            </Suspense>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <div id="upload" className="scroll-mt-24">
            <Card title="Analyse your own call">
              <UploadCard companies={companies} />
            </Card>
          </div>

          <Card title="What actually ran">
            <dl className="flex flex-col gap-2.5">
              <Row k="Speech-to-text" v={registry.stt} />
              <Row k="Extraction" v={registry.extractDetail} />
              <Row k="Support threshold" v={String(registry.supportThreshold)} />
              <Row
                k="Budget caps"
                v={`${registry.budget.maxInputTokens} in · $${registry.budget.maxUsd} · ${
                  registry.budget.maxWallClockMs / 1000
                }s`}
              />
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-micro">
      <dt className="shrink-0 text-fg-dim">{k}</dt>
      <dd className="min-w-0 text-right font-mono break-words text-fg-muted">{v}</dd>
    </div>
  );
}
