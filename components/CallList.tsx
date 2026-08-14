'use client';

/**
 * The call list, with the controls needed once there is more than a demo's worth of calls in it.
 *
 * Filtering happens HERE, over rows the server already sent, rather than by re-querying per change.
 * The page fetches every call regardless — there is no pagination — so a round trip per keystroke
 * would buy nothing, and against the REST gateway it would cost roughly 300ms each.
 *
 * The state is mirrored into the URL with `history.replaceState` rather than `router.replace`. Both
 * make the view reloadable and shareable; only the latter re-runs the server component on every
 * keystroke. The URL here is a record of what you are looking at, not a navigation.
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, Search, Trash2, X } from 'lucide-react';
import type { CallSummary } from '@/lib/db';
import { RunStatusBadge } from '@/components/RunStatusBadge';
import { inputStyles, FieldLabel } from '@/components/ui/Field';
import { cx } from '@/components/ui/cx';

export type CallListRow = CallSummary & { company_name: string | null };

const SORTS = {
  newest: { label: 'Newest first', cmp: (a: CallListRow, b: CallListRow) => b.created_at - a.created_at },
  oldest: { label: 'Oldest first', cmp: (a: CallListRow, b: CallListRow) => a.created_at - b.created_at },
  longest: { label: 'Longest first', cmp: (a: CallListRow, b: CallListRow) => b.duration_ms - a.duration_ms },
  shortest: { label: 'Shortest first', cmp: (a: CallListRow, b: CallListRow) => a.duration_ms - b.duration_ms },
  title: { label: 'Title A–Z', cmp: (a: CallListRow, b: CallListRow) => a.title.localeCompare(b.title) },
} as const;

type SortKey = keyof typeof SORTS;
const isSort = (v: string): v is SortKey => v in SORTS;

/**
 * The status vocabulary the FILTER offers, which is the vocabulary RunStatusBadge already renders.
 * `not-extracted` is the sentinel for a call that transcribed but was never extracted — a real
 * state, and the one an interrupted upload leaves behind.
 */
const STATUSES = [
  ['shipped', 'Verified'],
  ['partial', 'Partial'],
  ['failed', 'Failed'],
  ['deadline', 'Deadline'],
  ['not-extracted', 'No notes'],
] as const;

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function CallList({
  calls,
  companies,
}: {
  calls: CallListRow[];
  companies: { id: string; name: string }[];
}) {
  const params = useSearchParams();
  const router = useRouter();

  // Read once, on mount: after that this component owns the state and writes the URL, so re-reading
  // would fight its own updates.
  const [q, setQ] = useState(() => params.get('q') ?? '');
  const [account, setAccount] = useState(() => params.get('account') ?? '');
  const [status, setStatus] = useState(() => params.get('status') ?? '');
  const [sort, setSort] = useState<SortKey>(() => {
    const s = params.get('sort') ?? '';
    return isSort(s) ? s : 'newest';
  });

  // Removed locally the moment the DELETE call succeeds, so the row disappears immediately
  // rather than waiting on a server round trip; `router.refresh()` still runs alongside it so the
  // next server render (and this page's own `count`) agrees with what actually happened.
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function handleDelete(id: string, title: string) {
    if (!window.confirm(`Delete "${title}"? This removes the call, its transcript and its notes. This cannot be undone.`)) {
      return;
    }
    setPendingId(id);
    try {
      const res = await fetch(`/api/calls/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        window.alert(body?.error ?? `Could not delete this call (HTTP ${res.status}).`);
        return;
      }
      setDeletedIds((prev) => new Set(prev).add(id));
      router.refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not delete this call.');
    } finally {
      setPendingId(null);
    }
  }

  useEffect(() => {
    const next = new URLSearchParams();
    if (q) next.set('q', q);
    if (account) next.set('account', account);
    if (status) next.set('status', status);
    if (sort !== 'newest') next.set('sort', sort);
    const qs = next.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [q, account, status, sort]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return calls
      .filter((c) => {
        if (deletedIds.has(c.id)) return false;
        if (needle && !c.title.toLowerCase().includes(needle)) return false;
        // 'none' is a filter in its own right — "which calls did I analyse with no account
        // context?" is the question that finds the ones missing their CRM link.
        if (account === 'none' && c.company_id) return false;
        if (account && account !== 'none' && c.company_id !== account) return false;
        if (status && (c.run_status ?? 'not-extracted') !== status) return false;
        return true;
      })
      .sort(SORTS[sort].cmp);
  }, [calls, q, account, status, sort, deletedIds]);

  const filtered = Boolean(q || account || status);

  return (
    <>
      <div className="flex flex-col gap-3 border-b border-border-subtle px-4 py-3">
        <label className="relative flex items-center">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-3 text-fg-dim" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search calls by title"
            aria-label="Search calls by title"
            className={cx(inputStyles, 'pl-8')}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Account" value={account} onChange={setAccount}>
            <option value="">All accounts</option>
            <option value="none">No account</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>

          <Select label="Status" value={status} onChange={setStatus}>
            <option value="">Any status</option>
            {STATUSES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>

          <Select label="Sort" value={sort} onChange={(v) => isSort(v) && setSort(v)}>
            {Object.entries(SORTS).map(([v, s]) => (
              <option key={v} value={v}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>

        {filtered && (
          <div className="flex items-center gap-2 text-caption text-fg-dim">
            <span>
              {shown.length} of {calls.length} calls
            </span>
            <button
              type="button"
              onClick={() => {
                setQ('');
                setAccount('');
                setStatus('');
              }}
              className="flex items-center gap-1 text-brand transition-colors hover:underline"
            >
              <X size={11} aria-hidden />
              Clear filters
            </button>
          </div>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-10 text-center text-meta text-fg-dim">
          No calls match these filters.
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {shown.map((c) => (
            <li key={c.id} className="group flex items-center">
              {/* Delete lives OUTSIDE the Link, as a sibling, not a descendant -- a button nested
                  inside an <a> would fire the navigation on any click that lands on the row at all. */}
              <Link
                href={`/calls/${c.id}`}
                className="flex min-w-0 flex-1 items-center gap-4 px-4 py-3.5 transition-colors hover:bg-surface-inset"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium text-fg group-hover:text-brand">
                    {c.title}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-micro text-fg-dim">
                    <span className="font-mono">{fmt(c.duration_ms)}</span>
                    {c.company_name && (
                      <>
                        <Dot />
                        <span className="text-fg-muted">{c.company_name}</span>
                      </>
                    )}
                    <Dot />
                    <span>{c.separation} separation</span>
                    {c.extracted_by && (
                      <>
                        <Dot />
                        <span className="font-mono">{c.extracted_by}</span>
                      </>
                    )}
                  </p>
                </div>
                {/* Read from the extraction itself, so an upload gets the same badge a sample does,
                    and a call that never got as far as extraction says so. */}
                <RunStatusBadge status={c.run_status ?? 'not-extracted'} />
                <ChevronRight
                  size={16}
                  aria-hidden
                  className="shrink-0 text-fg-dim transition-colors group-hover:text-brand"
                />
              </Link>
              <button
                type="button"
                onClick={() => handleDelete(c.id, c.title)}
                disabled={pendingId === c.id}
                aria-label={`Delete ${c.title}`}
                title="Delete this call"
                className="mr-3 shrink-0 rounded-control p-1.5 text-fg-dim opacity-0 transition-colors hover:bg-bad-wash hover:text-bad focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
              >
                <Trash2 size={15} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const Dot = () => (
  <span aria-hidden className="text-border-strong">
    •
  </span>
);

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(inputStyles, 'appearance-none')}
      >
        {children}
      </select>
    </label>
  );
}
