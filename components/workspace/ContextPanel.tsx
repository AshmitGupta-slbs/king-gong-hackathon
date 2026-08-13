'use client';

/**
 * The account surface: who, what deal, what happened before — and what the recording itself measures.
 *
 * Two kinds of information share this panel and they are NOT the same kind of true, so they are
 * labelled differently wherever they appear:
 *
 *   CRM records      fabricated demo data (see lib/crm/fixture.ts). Marked as demo.
 *   Call analytics   arithmetic over the real transcript. Marked as measured.
 *
 * Blurring those two would be the same failure as an uncited claim: something presented with more
 * authority than it has earned.
 */
import {
  Building2,
  CalendarClock,
  CircleDollarSign,
  Clock,
  MessageCircleQuestion,
} from 'lucide-react';
import type { CallContext, Person } from '@/lib/crm/types';
import type { CallAnalytics } from '@/lib/analytics';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { cx } from '@/components/ui/cx';
import { fmt, initialsOf, useCallMeta } from './format-context';

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

const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

export function ContextPanel({
  crm,
  analytics,
}: {
  crm: CallContext | null;
  analytics: CallAnalytics;
}) {
  return (
    <div className="flex flex-col gap-4">
      <CallAnalyticsCard analytics={analytics} />

      {crm ? (
        <>
          <DealCard crm={crm} />
          <PeopleCard crm={crm} />
          <HistoryCard crm={crm} />
        </>
      ) : (
        <Card title="Account context">
          <p className="text-meta text-fg-muted">
            No CRM record is linked to this call. Uploaded calls have no account attached — the five
            bundled samples do, so the demo data has something to hang from.
          </p>
        </Card>
      )}
    </div>
  );
}

/** Measured, not generated. The distinction is the point, so it is stated on the card. */
function CallAnalyticsCard({ analytics }: { analytics: CallAnalytics }) {
  const { shares, longestMonologue, questions, competitors, totalSpokenMs } = analytics;
  const { participants } = useCallMeta();
  /** Speakers are roles in the data; show the person when the CRM knows one. */
  const nameFor = (speaker: string) =>
    participants.find((p) => p.speaker === speaker)?.name.split(/\s+/)[0] ?? speaker;
  return (
    <Card
      title="Call analytics"
      actions={
        <Badge tone="ok" hint="computed directly from the transcript — no model involved">
          measured
        </Badge>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div>
          <p className="mb-1.5 text-caption font-medium text-fg-muted">Talk ratio</p>
          {totalSpokenMs > 0 ? (
            <>
              <div className="flex h-2 overflow-hidden rounded-full bg-surface-inset">
                {shares.map((s, i) => (
                  <div
                    key={s.speaker}
                    title={`${nameFor(s.speaker)} — ${s.pct}%`}
                    className={cx('h-full', i === 0 ? 'bg-rep' : 'bg-prospect')}
                    style={{ width: `${s.pct}%` }}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                {shares.map((s, i) => (
                  <span key={s.speaker} className="flex items-center gap-1.5 text-caption">
                    <span
                      aria-hidden
                      className={cx('size-2 rounded-full', i === 0 ? 'bg-rep' : 'bg-prospect')}
                    />
                    <span className="text-fg-muted">{nameFor(s.speaker)}</span>
                    <span className="font-semibold text-fg tabular-nums">{s.pct}%</span>
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="text-caption text-fg-dim">No timed segments.</p>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-3">
          <Metric
            icon={<Clock size={13} aria-hidden />}
            label="Longest monologue"
            value={longestMonologue ? fmt(longestMonologue.ms) : '—'}
            sub={longestMonologue ? nameFor(longestMonologue.speaker) : undefined}
          />
          <Metric
            icon={<MessageCircleQuestion size={13} aria-hidden />}
            label="Questions asked"
            value={String(questions)}
            /* Honest about the method: Hear returns unpunctuated text, so there is no '?' to count. */
            sub="detected from phrasing"
          />
        </dl>

        {competitors.length > 0 && (
          <div>
            <p className="mb-1.5 text-caption font-medium text-fg-muted">Competitors named</p>
            <div className="flex flex-wrap gap-1.5">
              {competitors.map((c) => (
                <Badge key={c.name} tone="warn">
                  <span className="capitalize">{c.name}</span>
                  <span className="opacity-70">×{c.mentions}</span>
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function Metric({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-control border border-border-subtle bg-surface-inset px-2.5 py-2">
      <dt className="flex items-center gap-1.5 text-caption text-fg-dim">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 text-heading font-semibold text-fg tabular-nums">
        {value}
        {sub && <span className="ml-1.5 text-caption font-normal text-fg-dim">{sub}</span>}
      </dd>
    </div>
  );
}

function DealCard({ crm }: { crm: CallContext }) {
  const { deal, account, next_meeting } = crm;
  return (
    <Card
      title="Deal"
      actions={
        <Badge tone="neutral" hint="fabricated records for the demo — not a real CRM">
          demo data
        </Badge>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-body font-medium text-fg">{deal.name}</p>
            <p className="mt-0.5 text-caption text-fg-dim">Owner · {deal.owner}</p>
          </div>
          <Badge tone={STAGE_TONE[deal.stage] ?? 'neutral'} dot>
            {deal.stage}
          </Badge>
        </div>

        <dl className="grid grid-cols-2 gap-3">
          <Metric
            icon={<CircleDollarSign size={13} aria-hidden />}
            label="Amount"
            value={money(deal.amount, deal.currency)}
          />
          <Metric
            icon={<CalendarClock size={13} aria-hidden />}
            label="Close date"
            value={day(deal.close_date)}
          />
        </dl>

        <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-3 text-caption">
          <Row icon={<Building2 size={13} aria-hidden />} k={account.name} v={account.industry} />
          <Row k="Size" v={`${account.employees} employees`} />
          <Row k="Location" v={account.location} />
          <Row k="Domain" v={account.domain} mono />
          <Row k="Days in stage" v={String(deal.days_in_stage)} />
          <Row
            k="Next meeting"
            v={next_meeting ? `${day(next_meeting.date)} — ${next_meeting.title}` : 'None scheduled'}
            tone={next_meeting ? undefined : 'warn'}
          />
        </div>
      </div>
    </Card>
  );
}

function Row({
  icon,
  k,
  v,
  mono,
  tone,
}: {
  icon?: React.ReactNode;
  k: string;
  v: string;
  mono?: boolean;
  tone?: 'warn';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex shrink-0 items-center gap-1.5 text-fg-dim">
        {icon}
        {k}
      </dt>
      <dd
        className={cx(
          'min-w-0 text-right',
          mono && 'font-mono',
          tone === 'warn' ? 'font-medium text-warn' : 'text-fg-muted',
        )}
      >
        {v}
      </dd>
    </div>
  );
}

function PeopleCard({ crm }: { crm: CallContext }) {
  return (
    <Card title="People" count={crm.participants.length + crm.associated.length}>
      <p className="mb-2 text-caption font-medium text-fg-muted">On this call</p>
      <ul className="flex flex-col gap-2">
        {crm.participants.map((p) => (
          <PersonRow key={p.id} p={p} onCall />
        ))}
      </ul>

      {crm.associated.length > 0 && (
        <>
          <p className="mt-4 mb-2 text-caption font-medium text-fg-muted">
            Also on the account
          </p>
          <ul className="flex flex-col gap-2">
            {crm.associated.map((p) => (
              <PersonRow key={p.id} p={p} />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function PersonRow({ p, onCall = false }: { p: Person; onCall?: boolean }) {
  const internal = p.side === 'internal';
  return (
    <li className="flex items-center gap-2.5">
      <span
        aria-hidden
        className={cx(
          'grid size-7 shrink-0 place-items-center rounded-full text-caption font-bold',
          internal ? 'bg-rep-wash text-rep' : 'bg-prospect-wash text-prospect',
          !onCall && 'opacity-60',
        )}
      >
        {initialsOf(p.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-meta font-medium text-fg">{p.name}</span>
        <span className="block truncate text-caption text-fg-dim">{p.title}</span>
      </span>
      {internal && <Badge tone="neutral">internal</Badge>}
    </li>
  );
}

function HistoryCard({ crm }: { crm: CallContext }) {
  return (
    <Card title="Previous activity" count={crm.history.length}>
      <ol className="flex flex-col">
        {crm.history.map((m, i) => (
          <li key={m.id} className="flex gap-3">
            {/* A spine, so the list reads as a timeline rather than rows. */}
            <div className="flex flex-col items-center">
              <span
                aria-hidden
                className={cx(
                  'mt-1 size-2 shrink-0 rounded-full',
                  i === 0 ? 'bg-brand' : 'bg-border-strong',
                )}
              />
              {i < crm.history.length - 1 && <span aria-hidden className="w-px flex-1 bg-border-subtle" />}
            </div>
            <div className={cx('min-w-0 flex-1', i < crm.history.length - 1 && 'pb-3.5')}>
              <div className="flex items-baseline justify-between gap-2">
                <p className="min-w-0 truncate text-meta font-medium text-fg">{m.title}</p>
                <span className="shrink-0 text-caption text-fg-dim">{day(m.date)}</span>
              </div>
              <p className="mt-0.5 text-caption leading-relaxed text-fg-muted">{m.summary}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
