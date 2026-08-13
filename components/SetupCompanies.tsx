'use client';

/**
 * Manage the accounts, and the context that grounds their notes.
 *
 * The notes field is the point of this page. Everything else is filing — `notes` is what a rep
 * knows going into the call and what the model gets told before it reads the transcript, so it is
 * given the most room and the clearest explanation of what it does.
 *
 * Posts `FormData` to `/api/companies`, matching the only form pattern in this repo
 * (`UploadCard.tsx`). No server actions — there are none anywhere here, and this is not the place
 * to introduce the first one.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Building2, Check, Loader2, Pencil, Plus, X } from 'lucide-react';
import type { Company } from '@/lib/companies';
import { DealStageSchema } from '@/lib/crm/types';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, FieldLabel, inputStyles } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { cx } from '@/components/ui/cx';

const STAGE_TONE: Record<string, BadgeTone> = {
  Discovery: 'neutral',
  Evaluation: 'brand',
  Negotiation: 'warn',
  'Closed Won': 'ok',
  'Closed Lost': 'bad',
  Stalled: 'bad',
};

export function SetupCompanies({ companies }: { companies: Company[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/companies', {
        method: 'POST',
        body: new FormData(e.currentTarget),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let message = `HTTP ${res.status}`;
        if ((res.headers.get('content-type') ?? '').includes('application/json')) {
          try {
            message = (JSON.parse(text) as { error?: string }).error ?? message;
          } catch {
            /* a lying content-type is not the user's problem */
          }
        }
        throw new Error(message);
      }
      setAdding(false);
      setEditingId(null);
      // The list is server-rendered from SQLite, so ask the server for it again.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="Accounts"
        count={companies.length}
        actions={
          !adding && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus size={14} aria-hidden />
              New company
            </Button>
          )
        }
        bodyClassName={companies.length && !adding ? 'p-0' : undefined}
      >
        {adding && (
          <CompanyForm
            onSubmit={submit}
            busy={busy}
            onCancel={() => {
              setAdding(false);
              setError(null);
            }}
          />
        )}

        {!adding && companies.length === 0 && (
          <p className="py-6 text-center text-meta text-fg-dim">
            No accounts yet. Add one and its context will ground the notes for every call you link
            to it.
          </p>
        )}

        {!adding && companies.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {companies.map((c) =>
              editingId === c.id ? (
                <li key={c.id} className="px-4 py-4">
                  <CompanyForm
                    company={c}
                    onSubmit={submit}
                    busy={busy}
                    onCancel={() => {
                      setEditingId(null);
                      setError(null);
                    }}
                  />
                </li>
              ) : (
                <li key={c.id} className="flex items-start gap-4 px-4 py-3.5">
                  <span
                    aria-hidden
                    className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-control bg-brand-wash text-brand"
                  >
                    <Building2 size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-body font-medium text-fg">{c.name}</p>
                      <Badge tone={STAGE_TONE[c.stage] ?? 'neutral'} dot>
                        {c.stage}
                      </Badge>
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption text-fg-dim">
                      {c.industry && <span>{c.industry}</span>}
                      {c.size_band && <span>· {c.size_band}</span>}
                      {c.website && <span className="font-mono">· {c.website}</span>}
                    </p>
                    {c.notes ? (
                      <p className="mt-2 rounded-control border border-border-subtle bg-surface-inset px-2.5 py-2 text-caption leading-relaxed text-fg-muted">
                        {c.notes}
                      </p>
                    ) : (
                      <p className="mt-2 text-caption text-fg-dim italic">
                        No context yet — notes here are given to the model before it reads the call.
                      </p>
                    )}
                  </div>
                  <Button variant="secondary" onClick={() => setEditingId(c.id)}>
                    <Pencil size={13} aria-hidden />
                    Edit
                  </Button>
                </li>
              ),
            )}
          </ul>
        )}
      </Card>

      {error && (
        <p className="rounded-control border border-bad-border bg-bad-wash px-3 py-2 text-caption text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

function CompanyForm({
  company,
  onSubmit,
  busy,
  onCancel,
}: {
  company?: Company;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {company && <input type="hidden" name="id" value={company.id} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Company name"
          name="name"
          required
          defaultValue={company?.name ?? ''}
          placeholder="Acme Corp"
        />
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Deal stage</FieldLabel>
          <select
            name="stage"
            defaultValue={company?.stage ?? 'Discovery'}
            className={cx(inputStyles, 'appearance-none')}
          >
            {DealStageSchema.options.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Industry"
          name="industry"
          defaultValue={company?.industry ?? ''}
          placeholder="Healthcare Technology"
        />
        <Field
          label="Size"
          name="size_band"
          defaultValue={company?.size_band ?? ''}
          placeholder="201–1,000"
        />
      </div>

      <Field
        label="Website"
        name="website"
        defaultValue={company?.website ?? ''}
        placeholder="acme.example"
      />

      <Textarea
        label="What you already know going in"
        name="notes"
        rows={4}
        defaultValue={company?.notes ?? ''}
        placeholder="Evaluating after a failed vendor rollout last year; price-sensitive."
        hint="Given to the model as background before it reads the transcript, so it knows what to listen for. It can never be cited as evidence — every claim still needs a real line from the call."
      />

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="md" disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} aria-hidden />}
          {company ? 'Save changes' : 'Add company'}
        </Button>
        <Button type="button" variant="ghost" size="md" onClick={onCancel} disabled={busy}>
          <X size={14} aria-hidden />
          Cancel
        </Button>
      </div>
    </form>
  );
}
