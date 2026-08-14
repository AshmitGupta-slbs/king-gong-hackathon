'use client';

/**
 * Upload a file or paste an https link.
 *
 * The separation-mode choice stays exposed rather than hidden, because it changes how trustworthy
 * the speaker labels are: stereo telephony recordings give exact one-party-per-channel separation,
 * while mono needs a diarization model. Hiding that would mean presenting a model's guess with the
 * same confidence as a fact, which is the habit this whole product argues against.
 *
 * What changed: the DEFAULT no longer guesses. It used to be "Mono", so a stereo two-party
 * recording uploaded without touching this fieldset was transcribed by the diarizer and came back
 * with nearly every line on one speaker. "Auto" reads the file instead — and says what it found
 * before you submit, so the choice is informed rather than merely available.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Info, KeyRound, Loader2 } from 'lucide-react';
import { resolveSeparation } from '@/lib/separation';
import { readNdjson } from '@/lib/ndjson';
import { applyStage, INITIAL_STAGES } from '@/lib/harness/progress';
import type { StageView, UploadEvent } from '@/lib/harness/progress';
import { UploadProgress } from '@/components/UploadProgress';
import { Button } from '@/components/ui/Button';
import { Field, FieldLabel, inputStyles } from '@/components/ui/Field';
import { cx } from '@/components/ui/cx';


const MODES = [
  {
    value: 'auto',
    name: 'Auto',
    desc: 'Read the file and pick. Stereo with one party per channel gets exact, model-free separation; anything else uses the diarizer.',
  },
  {
    value: 'diarize',
    name: 'Mono',
    desc: 'A diarization model splits the speakers.',
  },
  {
    value: 'channel',
    name: 'Stereo',
    desc: 'One party per channel. Exact, no model involved. Left channel is treated as the rep.',
  },
] as const;

/**
 * The engines a user may pick per upload, and what changes if they do.
 *
 * Recap's description says the two things that actually differ for the reader — no playbooks, and
 * citations matched here rather than cited by the engine — because a picker that only listed vendor
 * names would make them look interchangeable, and they are not.
 */
const ENGINES = [
  {
    value: 'default',
    name: 'Configured default',
    desc: 'Whatever this deployment is set up for.',
  },
  {
    value: 'claude',
    name: 'Claude (Anthropic API)',
    desc: 'Reads the call under your playbooks and account context, and cites its own lines. Needs ANTHROPIC_API_KEY.',
  },
  {
    value: 'bedrock',
    name: 'Claude (AWS Bedrock)',
    desc: 'The same prompt and the same schema, on Bedrock. Needs AWS credentials and model access.',
  },
  {
    value: 'recap',
    name: 'PyAI Recap',
    desc: 'PyAI writes the notes. It takes no instructions, so playbooks and account context are not applied, and each claim is matched back to a transcript line here rather than cited by the engine. Needs a PyAI key with recap:read.',
  },
] as const;

export type EngineOption = {
  name: string;
  usable: boolean;
  reason: string | null;
  remedy: string | null;
};

export function UploadCard({
  companies = [],
  defaultEngine,
  engines = [],
}: {
  companies?: { id: string; name: string }[];
  /** The resolved `LLM_PROVIDER`, so "Configured default" can say what it actually means. */
  defaultEngine?: string;
  /**
   * Which engines can actually work here, from `describeRegistry()`. Plain data computed on the
   * server by the same function the harness gates on, so this cannot disagree with what a run does.
   */
  engines?: EngineOption[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Actionable guidance for a failure the user can do something about (e.g. an exhausted key). */
  const [remedy, setRemedy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  const [mode, setMode] = useState<string>('auto');
  /**
   * Held in state only so the description under the picker tracks the selection.
   *
   * Defaults to PyAI Recap when this deployment can actually use it — falling back to
   * "Configured default" otherwise, so a clone without a `recap:read` key doesn't default to an
   * engine the picker itself would grey out. Still just a default: every other engine is one
   * click away in the same dropdown.
   */
  const [engine, setEngine] = useState<string>(() =>
    engines.find((e) => e.name === 'recap')?.usable ? 'recap' : 'default',
  );
  /**
   * `default` has no availability of its own -- it resolves to whatever LLM_PROVIDER picked, so it
   * borrows that engine's status. Without this, choosing "Configured default" on a machine where the
   * default cannot work would look fine.
   */
  const statusFor = (value: string) =>
    engines.find((e) => e.name === (value === 'default' ? defaultEngine : value));
  const selectedStatus = statusFor(engine);
  const [stages, setStages] = useState<StageView[] | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [expectedMs, setExpectedMs] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Preview the decision client-side with the SAME function the route uses, so what the user reads
   * here is what actually happens. `lib/separation.ts` and `lib/wav.ts` have no dependencies, so
   * this costs nothing to bundle. The server re-runs it on the full upload and is authoritative.
   */
  async function previewFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    if (!file) return setDetected(null);
    try {
      // A few MB is plenty to classify turn-taking, and keeps a large file from stalling the UI.
      const head = new Uint8Array(await file.slice(0, 8_000_000).arrayBuffer());
      const d = resolveSeparation(head, 'auto');
      setDetected(`${d.reason} (Auto will use ${d.mode}.)`);
    } catch {
      setDetected(null); // a preview that fails is not worth an error banner
    }
  }

  /**
   * Turn an HTTP failure into something a person can act on.
   *
   * `await res.json()` used to run unguarded, so a proxy's HTML 504 page surfaced to the user as
   * `Unexpected token '<'` — the least intelligible message at the most likely moment to fail.
   */
  async function describeHttpFailure(res: Response): Promise<string> {
    const text = await res.text().catch(() => '');
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      try {
        const j = JSON.parse(text) as { error?: string };
        if (typeof j.error === 'string') return j.error;
      } catch {
        /* a lying content-type is not the user's problem */
      }
    }
    const looksLikeAPage = text.trimStart().startsWith('<');
    return (
      `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}` +
      (looksLikeAPage
        ? ' — the server returned a web page instead of a result, which usually means a proxy timed out.'
        : '')
    );
  }

  function stopWatching() {
    abortRef.current?.abort();
    setStages(null);
    setNote(null);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const controller = new AbortController();
    abortRef.current = controller;

    setBusy(true);
    setError(null);
    setRemedy(null);
    setNote(null);
    setExpectedMs(null);
    setStartedAt(Date.now());
    setStages(INITIAL_STAGES);

    try {
      const res = await fetch('/api/calls', {
        method: 'POST',
        body: new FormData(e.currentTarget),
        // Opt in to streamed progress. Without this header the route replies with a single JSON
        // object exactly as it always did.
        headers: { Accept: 'application/x-ndjson' },
        signal: controller.signal,
      });

      // The status is still meaningful here: the server only commits to 200 after validation.
      if (!res.ok || !res.body) throw new Error(await describeHttpFailure(res));

      let terminal: UploadEvent | null = null;
      for await (const ev of readNdjson<UploadEvent>(res.body)) {
        if (ev.t === 'expect') setExpectedMs(ev.totalMs);
        if (ev.t === 'stage') setStages((prev) => applyStage(prev ?? INITIAL_STAGES, ev));
        if (ev.t === 'result' || ev.t === 'error') terminal = ev;
      }

      if (!terminal) {
        throw new Error(
          'The connection closed before the run finished. The run is still recorded — check the call list.',
        );
      }
      if (terminal.t === 'error') throw new Error(terminal.message);

      const data = terminal.outcome;
      // A failed or deadlined run still produced a record — say so rather than silently redirecting.
      // Not navigating is deliberate: insertCall only runs after STT succeeds, so a run that failed
      // during transcription has no calls row and /calls/<id> would 404.
      if (data.run_status === 'failed' || data.run_status === 'deadline') {
        setError(
          `Run ended as "${data.run_status}"${data.error ? `: ${data.error}` : ''}. ` +
            `The run was still recorded.`,
        );
        // `PyaiError.remedy` was written long ago and never rendered anywhere. This is its consumer.
        setRemedy(data.remedy ?? null);
        setStages(null);
        return;
      }
      router.push(`/calls/${data.callId}`);
    } catch (err) {
      // The user pressed "Stop watching" — not an error, and they already know.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
      setStages(null);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  if (stages) {
    return (
      <UploadProgress
        stages={stages}
        startedAt={startedAt}
        expectedMs={expectedMs}
        onStopWatching={stopWatching}
      />
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field label="Call title" name="title" placeholder="Acme Corp — discovery" />

      {/*
        Optional by design. Setup is where accounts are really managed; this picker exists so a
        call can be attached to one without leaving the upload, and an unattached upload is a
        perfectly valid outcome rather than a validation error.
      */}
      <label className="flex flex-col gap-1.5">
        <FieldLabel>Account</FieldLabel>
        <select name="companyId" defaultValue="" className={cx(inputStyles, 'appearance-none')}>
          <option value="">No account — analyse without context</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="text-caption leading-relaxed text-fg-dim">
          {companies.length > 0 ? (
            <>
              What you noted about this account in{' '}
              <Link href="/setup" className="text-brand hover:underline">
                Setup
              </Link>{' '}
              is given to the model as background — never as evidence.
            </>
          ) : (
            <>
              No accounts yet.{' '}
              <Link href="/setup" className="text-brand hover:underline">
                Add one in Setup
              </Link>{' '}
              to ground the notes in what you already know.
            </>
          )}
        </span>
      </label>

      <label className="flex flex-col gap-1.5">
        <FieldLabel>Audio file</FieldLabel>
        <input
          type="file"
          name="audio"
          accept="audio/wav,audio/mpeg,audio/mp4,audio/flac,audio/ogg,.wav,.mp3,.m4a,.flac,.ogg"
          onChange={previewFile}
          className={cx(
            inputStyles,
            'py-1.5 text-micro text-fg-muted',
            'file:mr-2.5 file:rounded-chip file:border-0 file:bg-brand-wash file:px-2.5 file:py-1.5',
            'file:text-caption file:font-medium file:text-brand hover:file:bg-brand-border',
          )}
        />
      </label>

      <Field label="…or paste an https URL" name="url" placeholder="https://example.com/call.wav" />

      {/*
        Per-upload, and it does NOT change the deployment default — so one call can be run through
        Recap for comparison without every later upload silently following it.
      */}
      <label className="flex flex-col gap-1.5">
        <FieldLabel>Notes engine</FieldLabel>
        <select
          name="engine"
          value={engine}
          onChange={(e) => setEngine(e.currentTarget.value)}
          className={cx(inputStyles, 'appearance-none')}
        >
          {ENGINES.map((e) => {
            const status = statusFor(e.value);
            return (
              <option key={e.value} value={e.value} disabled={status ? !status.usable : false}>
                {e.value === 'default' && defaultEngine ? `${e.name} — ${defaultEngine}` : e.name}
                {status && !status.usable ? ' (not available here)' : ''}
              </option>
            );
          })}
        </select>
        <span className="text-caption leading-relaxed text-fg-dim">
          {ENGINES.find((e) => e.value === engine)?.desc}
        </span>
        {/*
          Why an engine cannot be used, said where the choice is made rather than after a failed run.
          A tester selected PyAI Recap with a self-minted sandbox key, waited through transcription, and
          got a 403 for a scope sandbox keys never carry -- six times. The option is disabled rather than
          hidden, because the capability is real and someone with a live key should still learn it exists.
        */}
        {selectedStatus && !selectedStatus.usable && selectedStatus.remedy && (
          <span className="text-caption leading-relaxed text-fg-muted">{selectedStatus.remedy}</span>
        )}
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-micro font-medium text-fg-muted">Speaker separation</legend>
        {MODES.map((m) => {
          const active = mode === m.value;
          return (
            <label
              key={m.value}
              className={cx(
                'flex cursor-pointer items-start gap-2.5 rounded-control border p-2.5 transition-colors',
                active
                  ? 'border-brand-border bg-brand-wash'
                  : 'border-border-subtle hover:bg-surface-inset',
              )}
            >
              <input
                type="radio"
                name="mode"
                value={m.value}
                checked={active}
                onChange={() => setMode(m.value)}
                className="mt-0.5 shrink-0 accent-[var(--brand)]"
              />
              <span className="min-w-0">
                <span
                  className={cx(
                    'block text-micro font-semibold',
                    active ? 'text-brand' : 'text-fg',
                  )}
                >
                  {m.name}
                </span>
                <span className="mt-0.5 block text-caption leading-relaxed text-fg-muted">
                  {m.desc}
                </span>
              </span>
            </label>
          );
        })}
        {detected && (
          <p className="flex items-start gap-2 rounded-control border border-border-subtle bg-surface-inset px-2.5 py-2 text-caption leading-relaxed text-fg-muted">
            <Info size={13} className="mt-0.5 shrink-0 text-fg-dim" aria-hidden />
            {detected}
          </p>
        )}
      </fieldset>

      <Button type="submit" variant="primary" size="md" disabled={busy}>
        {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
        {busy ? 'Processing…' : 'Analyse call'}
      </Button>

      {note && <p className="text-caption text-fg-dim">{note}</p>}
      {remedy && (
        <p className="flex items-start gap-2 rounded-control border border-warn-border bg-warn-wash px-2.5 py-2 text-caption leading-relaxed text-warn">
          <KeyRound size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>{remedy}</span>
        </p>
      )}
      {error && (
        <p className="rounded-control border border-bad-border bg-bad-wash px-2.5 py-2 text-caption leading-relaxed text-bad">
          {error}
        </p>
      )}
      <p className="text-caption leading-snug text-fg-dim">
        {/* Only true when no key is configured — with PYAI_API_KEY set (the deployed case) nothing
            is minted, and claiming otherwise sent people looking for a key that was never created. */}
        With no key configured, a free PyAI sandbox key mints itself on first run — no signup, no
        card. Set PYAI_API_KEY to use your own.
      </p>
    </form>
  );
}
