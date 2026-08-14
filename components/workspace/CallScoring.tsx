'use client';

/**
 * Deal score — MEDPICC by default, switchable to BANT / SPICED / CHAMP / ANUM.
 *
 * Scored entirely from this call's own already-cited notes (summary, objections, next steps, key
 * moments, the follow-up email, outcomes) — never a fresh read of the transcript. Every citation
 * shown here is therefore inherited proof: a segment some other claim already earned through the
 * real citation gate, not a new one this component or its data invents on its own. See
 * lib/scoring/score.ts.
 *
 * All five methodologies are computed once, at ingestion (lib/harness/loop.ts) — so switching the
 * dropdown here is instant, with no loading state and no new request.
 */
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { MethodologyId, ScoringBundle } from '@/lib/types';
import { METHODOLOGIES } from '@/lib/scoring/methodologies';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { inputStyles, FieldLabel } from '@/components/ui/Field';
import { cx } from '@/components/ui/cx';
import { CiteChips } from './Insights';

function scoreTone(score: number): BadgeTone {
  if (score >= 70) return 'ok';
  if (score >= 40) return 'warn';
  return 'bad';
}

export function CallScoring({
  scoring,
  onCite,
}: {
  scoring: ScoringBundle;
  onCite: (id: string) => void;
}) {
  const [methodology, setMethodology] = useState<MethodologyId>('medpicc');
  const [open, setOpen] = useState(false);

  const current =
    scoring.methodologies.find((m) => m.methodology === methodology) ?? scoring.methodologies[0];
  if (!current) return null;
  const def = METHODOLOGIES.find((d) => d.id === current.methodology);

  return (
    <Card
      title="Deal score"
      actions={
        <label className="flex items-center gap-2">
          <FieldLabel>Methodology</FieldLabel>
          <select
            value={current.methodology}
            onChange={(e) => setMethodology(e.target.value as MethodologyId)}
            className={cx(inputStyles, 'appearance-none')}
          >
            {scoring.methodologies.map((m) => (
              <option key={m.methodology} value={m.methodology}>
                {METHODOLOGIES.find((d) => d.id === m.methodology)?.name ?? m.methodology}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <div className="flex items-center gap-3">
        <Badge tone={scoreTone(current.overall)}>{Math.round(current.overall)}/100 overall</Badge>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="ml-auto flex items-center gap-1 rounded-chip px-1 text-caption font-medium text-fg-dim transition-colors hover:text-brand"
        >
          {current.criteria.length} {current.criteria.length === 1 ? 'criterion' : 'criteria'}
          <ChevronDown
            size={13}
            aria-hidden
            className={cx('transition-transform', open && 'rotate-180')}
          />
        </button>
      </div>

      {open && (
        <ul className="mt-3 flex flex-col gap-3 border-t border-border-subtle pt-3">
          {current.criteria.map((c) => {
            const label = def?.criteria.find((cc) => cc.key === c.key)?.label ?? c.key;
            return (
              <li key={c.key}>
                <div className="flex items-center gap-2">
                  <span className="text-body font-medium text-fg">{label}</span>
                  <Badge tone={scoreTone(c.score)}>{Math.round(c.score)}</Badge>
                </div>
                <p className="mt-1 text-meta text-fg-muted">{c.rationale}</p>
                <div className="mt-1.5">
                  <CiteChips evidence={c.evidence} onCite={onCite} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
