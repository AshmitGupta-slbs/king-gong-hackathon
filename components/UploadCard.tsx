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
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { resolveSeparation } from '@/lib/separation';

export function UploadCard() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [detected, setDetected] = useState<string | null>(null);

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

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote('Transcribing with PyAI Hear, then extracting…');
    try {
      const res = await fetch('/api/calls', { method: 'POST', body: new FormData(e.currentTarget) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      // A failed or deadlined run still produced a record — say so rather than silently redirecting.
      if (data.run_status === 'failed' || data.run_status === 'deadline') {
        setError(
          `Run ended as "${data.run_status}"${data.error ? `: ${data.error}` : ''}. ` +
            `The run was still recorded.`,
        );
        setNote(null);
        return;
      }
      router.push(`/calls/${data.callId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setNote(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-raised p-4"
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-fg-dim">Call title</span>
        <input
          name="title"
          placeholder="Acme Corp — discovery"
          className="rounded-md border border-border-strong bg-bg-inset px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-fg-dim">Audio file</span>
        <input
          type="file"
          name="audio"
          accept="audio/wav,audio/mpeg,audio/mp4,audio/flac,audio/ogg,.wav,.mp3,.m4a,.flac,.ogg"
          onChange={previewFile}
          className="rounded-md border border-border-strong bg-bg-inset px-2.5 py-1.5 text-[12px] text-fg-muted file:mr-2 file:rounded file:border-0 file:bg-border-strong file:px-2 file:py-1 file:text-[11px] file:text-fg"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-fg-dim">…or paste an https URL</span>
        <input
          name="url"
          placeholder="https://example.com/call.wav"
          className="rounded-md border border-border-strong bg-bg-inset px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
        />
      </label>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-[11px] uppercase tracking-wider text-fg-dim">
          Speaker separation
        </legend>
        <label className="flex items-start gap-2 text-[12px] text-fg-muted">
          <input type="radio" name="mode" value="auto" defaultChecked className="mt-0.5 accent-[var(--accent)]" />
          <span>
            <span className="text-fg">Auto</span> — read the file and pick. Stereo with one party
            per channel gets exact, model-free separation; anything else uses the diarizer.
          </span>
        </label>
        <label className="flex items-start gap-2 text-[12px] text-fg-muted">
          <input type="radio" name="mode" value="diarize" className="mt-0.5 accent-[var(--accent)]" />
          <span>
            <span className="text-fg">Mono</span> — diarization model splits the speakers.
          </span>
        </label>
        <label className="flex items-start gap-2 text-[12px] text-fg-muted">
          <input type="radio" name="mode" value="channel" className="mt-0.5 accent-[var(--accent)]" />
          <span>
            <span className="text-fg">Stereo</span> — one party per channel. Exact, no model
            involved. Left channel is treated as the rep.
          </span>
        </label>
        {detected && (
          <p className="mt-0.5 rounded-md border border-border bg-bg-inset px-2 py-1.5 text-[11px] leading-relaxed text-fg-muted">
            {detected}
          </p>
        )}
      </fieldset>

      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-accent px-3 py-2 text-[13px] font-semibold text-[#04150f] transition hover:brightness-110 disabled:opacity-50"
      >
        {busy ? 'Processing…' : 'Analyse call'}
      </button>

      {note && <p className="text-[11px] text-fg-dim">{note}</p>}
      {error && (
        <p className="rounded border border-bad-dim bg-bad-dim/20 px-2 py-1.5 text-[11px] text-bad">
          {error}
        </p>
      )}
      <p className="text-[10px] leading-snug text-fg-dim">
        A PyAI sandbox key mints itself on first run — no signup, no card.
      </p>
    </form>
  );
}
