/**
 * Home: pick a sample call, or bring your own.
 *
 * The sample calls are seeded on first load so a stranger who clones this repo and runs
 * `npm run dev` lands on five fully-analysed calls with no key, no signup and no network.
 */
import Link from 'next/link';
import { listCalls, reconcileOrphanRuns } from '@/lib/db';
import { loadSamples, sampleManifest } from '@/lib/samples';
import { describeRegistry } from '@/lib/registry';
import { UploadCard } from '@/components/UploadCard';

export const dynamic = 'force-dynamic';

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function Home() {
  // Idempotent seed of the committed samples.
  loadSamples();
  // Failure invariant: any run left 'running' by a killed process becomes a failed record.
  reconcileOrphanRuns();

  const calls = listCalls();
  const manifest = new Map(sampleManifest().map((m) => [m.id, m]));
  const registry = describeRegistry();

  return (
    <div className="mx-auto max-w-[1100px] px-5 py-10">
      <section className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight">
          Deal notes with <span className="text-accent">receipts</span>.
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">
          Upload a sales call. Get a transcript with speaker names, a summary, objections, intent,
          next steps and a follow-up email — where <strong className="text-fg">every claim points
          at the exact line in the call that proves it</strong>. Claims that cannot be traced to a
          real line are dropped, not softened.
        </p>
      </section>

      {!registry.extractIsRealModel && (
        <div className="mt-6 rounded-xl border border-warn-dim bg-warn-dim/15 p-4">
          <h2 className="text-sm font-semibold text-warn">
            Extraction is running on the keyword stub, not a model
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
            No model credential is configured, so notes are being produced by deterministic keyword
            rules. Transcripts, audio sync, the citation gate and the usage counter are all real —
            the notes are not. This banner disappears when a credential is present.
          </p>
          <p className="mt-2 font-mono text-[11px] text-fg-dim">
            active: {registry.extractDetail}
          </p>
        </div>
      )}

      <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-dim">
            Sample calls · no setup required
          </h2>
          <ul className="flex flex-col gap-2">
            {calls.map((c) => {
              const m = manifest.get(c.id);
              return (
                <li key={c.id}>
                  <Link
                    href={`/calls/${c.id}`}
                    className="group flex items-center gap-3 rounded-xl border border-border-subtle bg-bg-raised px-4 py-3 transition hover:border-accent/60"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-fg group-hover:text-accent">
                        {c.title}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-fg-dim">
                        {fmt(c.duration_ms)} · {m?.segments ?? '—'} segments · {c.separation}
                        {m?.extracted_by ? ` · ${m.extracted_by}` : ''}
                      </p>
                    </div>
                    {m?.run_status && <StatusDot status={m.run_status} />}
                  </Link>
                </li>
              );
            })}
            {calls.length === 0 && (
              <li className="rounded-xl border border-border-subtle bg-bg-raised px-4 py-6 text-center text-[13px] text-fg-dim">
                No calls yet. Run <span className="font-mono text-fg-muted">npm run samples</span> to
                build the bundled five.
              </li>
            )}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-dim">
            Or analyse your own
          </h2>
          <UploadCard />
        </section>
      </div>

      <section className="mt-10 border-t border-border-subtle pt-5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-fg-dim">
          What actually ran
        </h2>
        <dl className="mt-2 grid gap-x-8 gap-y-1 font-mono text-[11px] sm:grid-cols-2">
          <Row k="speech-to-text" v={registry.stt} />
          <Row k="extraction" v={registry.extractDetail} />
          <Row k="citation support threshold" v={String(registry.supportThreshold)} />
          <Row
            k="budget caps"
            v={`${registry.budget.maxInputTokens} in · $${registry.budget.maxUsd} · ${registry.budget.maxWallClockMs / 1000}s`}
          />
        </dl>
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-fg-dim">{k}</dt>
      <dd className="ml-auto text-right text-fg-muted">{v}</dd>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const cls =
    status === 'shipped'
      ? 'bg-accent'
      : status === 'partial'
        ? 'bg-warn'
        : status === 'not-extracted'
          ? 'bg-border-strong'
          : 'bg-bad';
  return <span title={status} className={`size-2 shrink-0 rounded-full ${cls}`} />;
}
