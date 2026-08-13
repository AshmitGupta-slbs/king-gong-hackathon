'use client';

/**
 * The CRM payload, on screen.
 *
 * A tab rather than a download, because the question this answers — "what would actually land in
 * HubSpot?" — is one you ask while looking at the call, and an answer you have to open a file to
 * read is an answer most people never look at.
 *
 * Fetched on demand rather than passed down from the server component. The payload is only
 * interesting when somebody asks for it, and building it on every call page render would put an
 * account lookup and an action-item read in front of every visit for a panel usually not opened.
 */
import { useState } from 'react';
import { Check, Copy, Loader2, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

export function CrmPayload({ callId }: { callId: string }) {
  const [json, setJson] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/calls/${callId}/crm-payload`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setJson(JSON.stringify(await res.json(), null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!json) return;
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card
      title="What would go to HubSpot"
      actions={
        json && (
          <Button variant="secondary" onClick={copy}>
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            {copied ? 'Copied' : 'Copy JSON'}
          </Button>
        )
      }
    >
      <p className="flex items-start gap-2 rounded-control border border-border-subtle bg-surface-inset px-3 py-2 text-caption leading-relaxed text-fg-muted">
        <ShieldOff size={13} className="mt-0.5 shrink-0 text-fg-dim" aria-hidden />
        <span>
          <strong className="font-semibold text-fg">Nothing is sent.</strong> This app has no
          HubSpot client and no credential — there is no code path that could reach a CRM. What
          follows is the document a push would post, built from the same property names, types and
          units a live portal reports.
        </span>
      </p>

      {!json && (
        <div className="mt-3">
          <Button onClick={load} disabled={busy}>
            {busy && <Loader2 size={13} className="animate-spin" aria-hidden />}
            {busy ? 'Building…' : 'Show the payload'}
          </Button>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-control border border-bad-border bg-bad-wash px-3 py-2 text-caption text-bad">
          {error}
        </p>
      )}

      {json && (
        // Its own horizontal scroller: a long HTML note body would otherwise push the whole page
        // sideways, which is the one thing the layout rules forbid.
        <pre className="mt-3 max-h-[60vh] overflow-auto rounded-control border border-border-subtle bg-surface-inset p-3 text-caption leading-relaxed text-fg-muted">
          <code>{json}</code>
        </pre>
      )}
    </Card>
  );
}
