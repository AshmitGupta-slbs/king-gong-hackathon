/**
 * What the calls taught us about this account — the EVIDENCE behind the suggested notes above.
 *
 * Rendered as a distinct section below the editable notes, never merged into them. The two look
 * different because they are different: the notes box is what a person asserted, and this is what
 * the system concluded from a recording — each item showing the exact line it concluded it from.
 *
 * Read-only, and no longer a client component. Each row used to carry its own "Promote to notes"
 * button, which meant an account with eight learnings asked the same question eight times. The one
 * bridge into notes is now the single draft in `NotesSuggestion`; this list is what you check it
 * against.
 */
import Link from 'next/link';
import { Quote, Sparkles } from 'lucide-react';
import type { Learning } from '@/lib/learnings';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { cx } from '@/components/ui/cx';

const KIND: Record<string, { label: string; tone: BadgeTone }> = {
  objection: { label: 'objection', tone: 'warn' },
  next_step: { label: 'next step', tone: 'brand' },
  intent: { label: 'read', tone: 'neutral' },
  competitor: { label: 'competitor', tone: 'bad' },
};

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function CompanyLearnings({ learnings }: { learnings: Learning[] }) {
  if (learnings.length === 0) {
    return (
      <p className="text-caption leading-relaxed text-fg-dim italic">
        Nothing learned yet — analyse a call linked to this account and what it establishes will be
        listed here, each item citing the line it came from.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2.5">
      {learnings.map((l) => {
        const kind = KIND[l.kind] ?? { label: l.kind, tone: 'neutral' as BadgeTone };
        const unverified = l.verdict === 'unverified';
        return (
          <li
            key={l.id}
            className={cx(
              'rounded-control border px-3 py-2.5',
              unverified ? 'border-warn-border bg-warn-wash' : 'border-border-subtle bg-surface',
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={kind.tone}>{kind.label}</Badge>
              {unverified && (
                <Badge
                  tone="warn"
                  hint="the cited line exists but does not visibly back this — kept for the record, and never fed back into a later call"
                >
                  unverified
                </Badge>
              )}
              {l.promoted && (
                <Badge tone="ok" hint="a person copied this into the account's own notes">
                  in notes
                </Badge>
              )}
              <span className="ml-auto text-caption text-fg-dim">
                {new Date(l.created_at).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                })}
              </span>
            </div>

            <p className="mt-1.5 text-meta text-fg">{l.text}</p>

            {l.quote && l.segment_id && (
              <Link
                href={`/calls/${l.call_id}`}
                className="mt-1.5 flex items-start gap-1.5 rounded-control border-l-2 border-brand-border bg-brand-wash/60 py-1 pl-2 text-caption leading-relaxed text-fg-muted transition-colors hover:bg-brand-wash"
              >
                <Quote size={11} className="mt-0.5 shrink-0 text-brand" aria-hidden />
                <span className="min-w-0">
                  “{l.quote}”
                  <span className="mt-0.5 block font-mono text-brand">
                    {l.segment_id}
                    {l.start_ms !== null && ` · ${mmss(l.start_ms)}`}
                  </span>
                </span>
              </Link>
            )}

            <p className="mt-2 flex items-center gap-1 text-caption text-fg-dim">
              <Sparkles size={11} aria-hidden />
              {l.extracted_by ?? 'unknown extractor'}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
