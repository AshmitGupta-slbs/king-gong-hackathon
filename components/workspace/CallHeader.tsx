'use client';

/**
 * Call identity: which account, which deal, who was on it, and the actions.
 *
 * The deal strip only renders when full account context was passed. The public share route passes
 * participants without it, so a recipient sees who spoke and nothing about pipeline.
 */
import { Download, ShieldAlert, Share2, Trash2 } from 'lucide-react';
import type { CallContext, Participant } from '@/lib/crm/types';
import type { CallBundle } from '@/lib/types';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { cx } from '@/components/ui/cx';
import { RunStatusBadge } from '@/components/RunStatusBadge';
import { fmt, initialsOf } from './format-context';

const STAGE_TONE: Record<string, BadgeTone> = {
  Discovery: 'neutral',
  Evaluation: 'brand',
  Negotiation: 'warn',
  'Closed Won': 'ok',
  'Closed Lost': 'bad',
  Stalled: 'bad',
};

const money = (n: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);

export function CallHeader({
  bundle,
  crm,
  participants,
  onGateDemo,
  gateBusy,
  onDelete,
  deleteBusy,
}: {
  bundle: CallBundle;
  crm: CallContext | null;
  participants: Participant[];
  onGateDemo?: () => void;
  gateBusy: boolean;
  /** Undefined on the public share route, same as onGateDemo — a viewer never gets either. */
  onDelete?: () => void;
  deleteBusy?: boolean;
}) {
  const { call, segments, extraction } = bundle;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          {crm && (
            <p className="mb-1 flex items-center gap-2 text-caption font-medium text-fg-dim">
              <span className="grid size-4 place-items-center rounded-[4px] bg-brand text-[9px] font-bold text-on-brand">
                {initialsOf(crm.account.name)}
              </span>
              {crm.account.name}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="min-w-0 truncate text-title font-semibold text-fg">{call.title}</h1>
            {extraction && <RunStatusBadge status={extraction.run_status} />}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-micro text-fg-dim">
            <span className="font-mono tabular-nums">{fmt(call.duration_ms)}</span>
            <Dot />
            <span>{segments.length} segments</span>
            <Dot />
            <span>{call.separation} separation</span>
            {extraction?.extracted_by && (
              <>
                <Dot />
                <span>
                  extracted by <span className="font-mono">{extraction.extracted_by}</span>
                </span>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink href={`/api/calls/${call.id}/export?format=md`}>
            <Download size={14} aria-hidden />
            Export .md
          </ButtonLink>
          <ButtonLink href={`/api/calls/${call.id}/export?format=json`}>.json</ButtonLink>
          {call.share_id && (
            <ButtonLink href={`/s/${call.share_id}`}>
              <Share2 size={14} aria-hidden />
              Share link
            </ButtonLink>
          )}
          {onGateDemo && (
            <Button
              variant="danger"
              onClick={onGateDemo}
              disabled={gateBusy}
              title="Feed hand-written claims — some citing segments that do not exist — through the real citation gate"
            >
              <ShieldAlert size={14} aria-hidden />
              {gateBusy ? 'Testing gate…' : 'Test the gate'}
            </Button>
          )}
          {/*
            `danger` styling used to belong only to "Test the gate" above -- destructive-LOOKING,
            not a destructive action. This one actually is: it removes the call, its transcript
            and its notes for good. Same variant, since it's still the only destructive-styled
            option this app has, but worth the note now that the styling means it for real too.
          */}
          {onDelete && (
            <Button variant="danger" onClick={onDelete} disabled={deleteBusy} title="Delete this call">
              <Trash2 size={14} aria-hidden />
              {deleteBusy ? 'Deleting…' : 'Delete call'}
            </Button>
          )}
        </div>
      </div>

      {/* Deal strip — internal only. */}
      {crm && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-card border border-border-subtle bg-surface px-4 py-2.5 shadow-card">
          <Badge tone={STAGE_TONE[crm.deal.stage] ?? 'neutral'} dot>
            {crm.deal.stage}
          </Badge>
          <Fact k="Amount" v={money(crm.deal.amount, crm.deal.currency)} />
          <Fact k="Close" v={crm.deal.close_date} />
          <Fact k="Owner" v={crm.deal.owner} />
          <div className="ml-auto flex items-center gap-2">
            <People participants={participants} />
          </div>
        </div>
      )}

      {/* Share route: who spoke, and nothing else. */}
      {!crm && participants.length > 0 && (
        <div className="flex items-center gap-2">
          <People participants={participants} withNames />
        </div>
      )}
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <span className="flex items-baseline gap-1.5 text-micro">
      <span className="text-fg-dim">{k}</span>
      <span className="font-medium text-fg">{v}</span>
    </span>
  );
}

function People({
  participants,
  withNames = false,
}: {
  participants: Participant[];
  withNames?: boolean;
}) {
  if (participants.length === 0) return null;
  return (
    <span className="flex items-center gap-2">
      <span className="flex -space-x-1.5">
        {participants.map((p) => (
          <span
            key={p.id}
            title={`${p.name} — ${p.title}`}
            className={cx(
              'grid size-6 place-items-center rounded-full text-[9px] font-bold ring-2 ring-surface',
              p.side === 'internal' ? 'bg-rep-wash text-rep' : 'bg-prospect-wash text-prospect',
            )}
          >
            {initialsOf(p.name)}
          </span>
        ))}
      </span>
      <span className="text-micro text-fg-dim">
        {withNames ? participants.map((p) => p.name).join(' · ') : `${participants.length} on the call`}
      </span>
    </span>
  );
}

const Dot = () => (
  <span aria-hidden className="text-border-strong">
    •
  </span>
);
