/**
 * One mapping from run status to a badge, shared by the call list and the call header.
 *
 * Previously these were two unrelated treatments of the same fact: an 8px unlabelled dot on the
 * home page and a differently-coloured pill on the call page. Same status, two vocabularies.
 */
import { Badge, type BadgeTone } from '@/components/ui/Badge';

const STATUS: Record<string, { tone: BadgeTone; label: string; hint: string }> = {
  shipped: { tone: 'ok', label: 'Verified', hint: 'every claim survived the citation gate' },
  partial: { tone: 'warn', label: 'Partial', hint: 'some claims were dropped or flagged' },
  failed: { tone: 'bad', label: 'Failed', hint: 'nothing survived the gate' },
  deadline: { tone: 'bad', label: 'Deadline', hint: 'stopped by the budget governor' },
  'not-extracted': { tone: 'neutral', label: 'No notes', hint: 'transcribed, but not yet extracted' },
};

export function RunStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: 'neutral' as BadgeTone, label: status, hint: '' };
  return (
    <Badge tone={s.tone} dot hint={s.hint || undefined}>
      {s.label}
    </Badge>
  );
}
