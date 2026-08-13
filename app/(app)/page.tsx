/**
 * Home: pick a sample call, or bring your own.
 *
 * The sample calls are seeded on first load so a stranger who clones this repo and runs
 * `npm run dev` lands on five fully-analysed calls with no key, no signup and no network.
 */
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { listCalls, reconcileOrphanRuns } from '@/lib/db';
import { loadSamples, sampleManifest } from '@/lib/samples';
import { describeRegistry } from '@/lib/registry';
import { listCompanies } from '@/lib/companies';
import { UploadCard } from '@/components/UploadCard';
import { RunStatusBadge } from '@/components/RunStatusBadge';
import { Card } from '@/components/ui/Card';

export const dynamic = 'force-dynamic';

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default async function Home() {
  // Idempotent seed of the committed samples.
  await loadSamples();
  // Failure invariant: any run left 'running' by a killed process becomes a failed record.
  await reconcileOrphanRuns();

  const calls = await listCalls();
  const manifest = new Map(sampleManifest().map((m) => [m.id, m]));
  const registry = describeRegistry();
  const companies = (await listCompanies()).map((c) => ({ id: c.id, name: c.name }));

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
        <Card title="Sample calls" count={calls.length} bodyClassName="p-0">
          {calls.length === 0 ? (
            <p className="px-4 py-10 text-center text-meta text-fg-dim">
              No calls yet. Run <span className="font-mono text-fg">npm run samples</span> to build
              the bundled five.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {calls.map((c) => {
                const m = manifest.get(c.id);
                return (
                  <li key={c.id}>
                    <Link
                      href={`/calls/${c.id}`}
                      className="group flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-surface-inset"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-body font-medium text-fg group-hover:text-brand">
                          {c.title}
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-micro text-fg-dim">
                          <span className="font-mono">{fmt(c.duration_ms)}</span>
                          <span aria-hidden className="text-border-strong">
                            •
                          </span>
                          <span>{m?.segments ?? '—'} segments</span>
                          <span aria-hidden className="text-border-strong">
                            •
                          </span>
                          <span>{c.separation} separation</span>
                          {m?.extracted_by && (
                            <>
                              <span aria-hidden className="text-border-strong">
                                •
                              </span>
                              <span className="font-mono">{m.extracted_by}</span>
                            </>
                          )}
                        </p>
                      </div>
                      {m?.run_status && <RunStatusBadge status={m.run_status} />}
                      <ChevronRight
                        size={16}
                        aria-hidden
                        className="shrink-0 text-fg-dim transition-colors group-hover:text-brand"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
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
