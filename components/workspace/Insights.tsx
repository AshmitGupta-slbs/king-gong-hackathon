'use client';

/**
 * The notes column — and the receipts.
 *
 * Every claim here carries the moments that prove it, and the section that publishes what the gate
 * REJECTED is a first-class panel rather than an error state. Notes you cannot audit are a guess;
 * publishing our own rejections is the argument.
 */
import { CircleX, Info, TriangleAlert } from 'lucide-react';
import type { CitedClaim, Evidence, ExtractionResult, GateRejection } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { CiteChip, NoCiteChip } from '@/components/ui/CiteChip';
import { cx } from '@/components/ui/cx';
import { describeExtractor } from '@/lib/provenance';
import { EvidenceTrail } from './EvidenceTrail';
import { fmt, useTextFmt, type GateDemoResult } from './format-context';

/**
 * Inline receipts, for the places where evidence is supporting context rather than the main event
 * (intent, the follow-up email). Claims themselves use `EvidenceTrail`.
 */
export function CiteChips({
  evidence,
  onCite,
}: {
  evidence: Evidence[];
  onCite: (id: string) => void;
}) {
  const display = useTextFmt();
  if (evidence.length === 0) return <NoCiteChip />;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {evidence.map((e, i) => (
        <CiteChip
          // Keyed on more than segment_id: a claim may legitimately cite the same segment twice,
          // and a duplicate React key silently drops the second chip.
          key={`${e.segment_id}-${e.start_ms}-${i}`}
          onClick={() => onCite(e.segment_id)}
          title={`${e.speaker} at ${fmt(e.start_ms)} — ${display(e.text)}`}
        >
          {e.segment_id} · {fmt(e.start_ms)}
        </CiteChip>
      ))}
    </span>
  );
}

function ClaimRow({
  c,
  onCite,
  onHoverSegments,
}: {
  c: CitedClaim;
  onCite: (id: string) => void;
  onHoverSegments?: (ids: string[] | null) => void;
}) {
  const display = useTextFmt();
  const verified = c.verdict === 'verified';
  return (
    <li className="border-t border-border-subtle py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className={cx(
            'mt-1.5 size-2 shrink-0 rounded-full',
            verified ? 'bg-ok-solid' : 'bg-warn-solid',
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-body text-fg">{display(c.claim)}</p>
          {!verified && (
            <div className="mt-2">
              <Badge
                tone="warn"
                hint={`content-overlap support ${c.support.toFixed(
                  2,
                )} is below the threshold — the cited line exists but does not visibly back this claim`}
              >
                unverified · support {c.support.toFixed(2)}
              </Badge>
            </div>
          )}
          {/*
           * The receipts. This replaces a chip row plus a single blockquote — which showed only
           * `evidence[0]`, so a claim the gate had backed with three lines looked exactly like one
           * backed by a single remark.
           */}
          <EvidenceTrail evidence={c.evidence} onCite={onCite} onHoverSegments={onHoverSegments} />
          {c.evidence.length === 0 && (
            <div className="mt-2">
              <NoCiteChip />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export function Insights({
  ex,
  onCite,
  gateDemo,
  onHoverSegments,
}: {
  ex: ExtractionResult;
  onCite: (id: string) => void;
  gateDemo: GateDemoResult | null;
  /** Hovering a claim lights up every line it cites, so multi-source is visible without expanding. */
  onHoverSegments?: (ids: string[] | null) => void;
}) {
  const provenance = describeExtractor(ex.extracted_by);

  return (
    <div className="flex flex-col gap-4">
      {/*
       * Where THESE notes came from. The shell banner describes the configured extractor, which is
       * a claim about future uploads; this is a claim about the text directly beneath it.
       */}
      {!provenance.isReal && (
        <p className="flex items-start gap-2 rounded-control border border-warn-border bg-warn-wash px-3 py-2 text-caption leading-relaxed text-warn">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">These notes were not written by a model.</span>{' '}
            <span className="text-fg-muted">
              Source <span className="font-mono">{provenance.label}</span> — {provenance.detail}.
            </span>
          </span>
        </p>
      )}
      {/*
       * Written by a model, but not by the path the rest of this interface describes. Deliberately
       * NOT styled as a warning: nothing is wrong with these notes, they were just produced under
       * different rules, and dressing that as an alert would train people to dismiss it.
       */}
      {provenance.isReal && provenance.caveated && (
        <p className="flex items-start gap-2 rounded-control border border-border-subtle bg-surface-inset px-3 py-2 text-caption leading-relaxed text-fg-muted">
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold text-fg">
              These notes came from a different engine.
            </span>{' '}
            Source <span className="font-mono">{provenance.label}</span> — {provenance.detail}.
          </span>
        </p>
      )}

      <Card title="Summary">
        <p className="text-body text-fg-muted">{ex.summary}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
          <span className="text-caption font-semibold tracking-wider text-fg-dim uppercase">
            Intent
          </span>
          <Badge tone="brand">{ex.intent.label}</Badge>
          <CiteChips evidence={ex.intent.evidence} onCite={onCite} />
        </div>
      </Card>

      <Card title="Objections" count={ex.objections.length}>
        {ex.objections.length ? (
          <ul>
            {ex.objections.map((c, i) => (
              <ClaimRow key={i} c={c} onCite={onCite} onHoverSegments={onHoverSegments} />
            ))}
          </ul>
        ) : (
          <p className="text-meta text-fg-dim">None raised on this call.</p>
        )}
      </Card>

      <Card title="Next steps" count={ex.next_steps.length}>
        {ex.next_steps.length ? (
          <ul>
            {ex.next_steps.map((c, i) => (
              <ClaimRow key={i} c={c} onCite={onCite} onHoverSegments={onHoverSegments} />
            ))}
          </ul>
        ) : (
          <p className="text-meta text-fg-dim">Nothing agreed on this call.</p>
        )}
      </Card>

      {ex.key_moments.length > 0 && (
        <Card title="Flagged moments" count={ex.key_moments.length}>
          <ul className="flex flex-col gap-2">
            {ex.key_moments.map((m, i) => (
              <li key={i} className="flex items-center gap-2 text-meta">
                <CiteChip onClick={() => onCite(m.evidence.segment_id)}>
                  {fmt(m.evidence.start_ms)}
                </CiteChip>
                <Badge tone="neutral">{m.type.replace('_', ' ')}</Badge>
                <span className="min-w-0 truncate text-fg-muted">{m.note}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Follow-up email"
        tone={ex.follow_up_email.verdict === 'unverified' ? 'warn' : 'default'}
      >
        {ex.follow_up_email.verdict === 'unverified' && (
          <p className="mb-3 flex items-start gap-2 rounded-control border border-warn-border bg-warn-wash px-2.5 py-2 text-micro leading-relaxed text-warn">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
            Could not be grounded in a specific line of the call — read it before sending.
          </p>
        )}
        <p className="text-micro text-fg-dim">
          <span className="font-semibold tracking-wider uppercase">Subject</span>{' '}
          <span className="text-body font-medium text-fg">{ex.follow_up_email.subject}</span>
        </p>
        <p className="mt-2 text-body whitespace-pre-wrap text-fg-muted">
          {ex.follow_up_email.body}
        </p>
        <div className="mt-3">
          <CiteChips evidence={ex.follow_up_email.evidence} onCite={onCite} />
        </div>
      </Card>

      {/* Publishing our own rejections is the argument. Notes you cannot audit are a guess. */}
      {(ex.rejections.length > 0 || gateDemo) && (
        <Card
          title="What the citation gate rejected"
          count={(gateDemo?.rejections.length ?? 0) + ex.rejections.length}
          tone="bad"
        >
          {gateDemo && (
            <p className="mb-3 rounded-control border border-border-subtle bg-surface-inset px-2.5 py-2 text-micro leading-relaxed text-fg-muted">
              {gateDemo.note} Submitted {gateDemo.submitted.objections} objections and{' '}
              {gateDemo.submitted.next_steps} next steps;{' '}
              <span className="font-semibold text-ok">{gateDemo.survived.objections}</span> and{' '}
              <span className="font-semibold text-ok">{gateDemo.survived.next_steps}</span>{' '}
              survived. Run status: <span className="font-mono text-warn">{gateDemo.run_status}</span>.
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {[...(gateDemo?.rejections ?? []), ...ex.rejections].map((r, i) => (
              <RejectionRow key={i} r={r} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function RejectionRow({ r }: { r: GateRejection }) {
  return (
    <li className="flex items-start gap-2.5 rounded-control border border-border-subtle bg-surface-inset px-2.5 py-2">
      <Badge tone={r.dropped ? 'bad' : 'warn'}>
        {r.dropped ? <CircleX size={12} aria-hidden /> : <TriangleAlert size={12} aria-hidden />}
        {r.dropped ? 'dropped' : 'flagged'}
      </Badge>
      <span className="min-w-0 flex-1">
        <span className="text-meta text-fg-muted">{r.claim}</span>
        <span className="mt-1 block text-caption text-fg-dim">
          <span className="font-mono">{r.field}</span> — {r.detail}
        </span>
      </span>
    </li>
  );
}

export function EmptyNotes() {
  return (
    <Card tone="warn">
      <div className="flex items-start gap-3">
        <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warn" aria-hidden />
        <div>
          <h2 className="text-heading font-semibold text-fg">Extraction offline</h2>
          <p className="mt-1.5 text-meta text-fg-muted">
            This call has been transcribed and its segments are real, but no notes were produced —
            there is no model credential configured. The transcript, the audio sync and the citation
            gate all work; only the notes are missing.
          </p>
          <p className="mt-2.5 text-caption text-fg-dim">
            Set ANTHROPIC_API_KEY, or AWS_REGION + AWS credentials for Bedrock, then run{' '}
            <span className="font-mono text-fg-muted">npm run extract:samples</span>. With no model
            of your own, a PYAI_API_KEY carrying{' '}
            <span className="font-mono text-fg-muted">recap:read</span> also works —{' '}
            <span className="font-mono text-fg-muted">LLM_PROVIDER=recap</span> has PyAI write the
            notes instead.
          </p>
        </div>
      </div>
    </Card>
  );
}
