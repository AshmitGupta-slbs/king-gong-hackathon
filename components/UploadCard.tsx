'use client';

/**
 * Upload a file or paste an https link.
 *
 * The separation-mode choice is exposed rather than guessed, because it changes how trustworthy
 * the speaker labels are: stereo telephony recordings give exact one-party-per-channel separation,
 * while mono needs a diarization model. Hiding that would mean presenting a model's guess with the
 * same confidence as a fact, which is the habit this whole product argues against.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function UploadCard() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
          <input type="radio" name="mode" value="diarize" defaultChecked className="mt-0.5 accent-[var(--accent)]" />
          <span>
            <span className="text-fg">Mono</span> — diarization model splits the speakers. Use this
            for most recordings.
          </span>
        </label>
        <label className="flex items-start gap-2 text-[12px] text-fg-muted">
          <input type="radio" name="mode" value="channel" className="mt-0.5 accent-[var(--accent)]" />
          <span>
            <span className="text-fg">Stereo</span> — one party per channel. Exact, no model
            involved. Left channel is treated as the rep.
          </span>
        </label>
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
