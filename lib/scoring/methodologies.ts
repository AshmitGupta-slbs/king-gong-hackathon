/**
 * The five deal-qualification methodologies this feature scores a call against, and their
 * criteria — pure data, no model call here.
 *
 * Deliberately NOT under `skills/`: `npm run test:skills` scans every file in that directory for
 * framework jargon ('bant', 'spiced', 'champion', 'economic buyer', ...) because that vocabulary
 * would poison the CITATION GATE's word-overlap scoring if it leaked into a gated claim. This file
 * never goes near the gate — it only labels criteria for the UI and for the scoring prompt in
 * score.ts — so it can name methodologies and criteria as plainly as a rep would recognise them.
 */
import type { MethodologyId } from '@/lib/types';

export type CriterionDef = {
  key: string;
  label: string;
  hint: string;
};

export type MethodologyDef = {
  id: MethodologyId;
  name: string;
  criteria: CriterionDef[];
};

export const METHODOLOGIES: MethodologyDef[] = [
  {
    id: 'medpicc',
    name: 'MEDPICC',
    criteria: [
      { key: 'metrics', label: 'Metrics', hint: 'A measurable business outcome the prospect wants to hit.' },
      { key: 'economic_buyer', label: 'Economic Buyer', hint: 'The person who controls budget and can approve the purchase.' },
      { key: 'decision_criteria', label: 'Decision Criteria', hint: 'What the prospect will judge the choice on.' },
      { key: 'decision_process', label: 'Decision Process', hint: 'The steps and approvals the deal has to pass through.' },
      { key: 'identify_pain', label: 'Identify Pain', hint: 'A specific problem the prospect is trying to solve.' },
      { key: 'champion', label: 'Champion', hint: 'Someone inside the account actively selling on your behalf.' },
      { key: 'competition', label: 'Competition', hint: 'Other options the prospect is weighing against this one.' },
    ],
  },
  {
    id: 'bant',
    name: 'BANT',
    criteria: [
      { key: 'budget', label: 'Budget', hint: 'Money set aside or approved for this purchase.' },
      { key: 'authority', label: 'Authority', hint: 'Whether the people on the call can actually decide.' },
      { key: 'need', label: 'Need', hint: 'A real problem this purchase would solve.' },
      { key: 'timeline', label: 'Timeline', hint: 'When the prospect wants or needs this in place.' },
    ],
  },
  {
    id: 'spiced',
    name: 'SPICED',
    criteria: [
      { key: 'situation', label: 'Situation', hint: 'The prospect\'s current setup and context.' },
      { key: 'pain', label: 'Pain', hint: 'What is actually going wrong for them today.' },
      { key: 'impact', label: 'Impact', hint: 'What that problem costs them if it stays unsolved.' },
      { key: 'critical_event', label: 'Critical Event', hint: 'A deadline or event forcing a decision.' },
      { key: 'decision', label: 'Decision', hint: 'How and by whom the final call gets made.' },
    ],
  },
  {
    id: 'champ',
    name: 'CHAMP',
    criteria: [
      { key: 'challenges', label: 'Challenges', hint: 'The problems the prospect is facing.' },
      { key: 'authority', label: 'Authority', hint: 'Who on the call can actually approve this.' },
      { key: 'money', label: 'Money', hint: 'Budget reality for solving the challenge.' },
      { key: 'prioritization', label: 'Prioritization', hint: 'How urgent this is relative to their other work.' },
    ],
  },
  {
    id: 'anum',
    name: 'ANUM',
    criteria: [
      { key: 'authority', label: 'Authority', hint: 'Whether a real decision-maker is engaged.' },
      { key: 'need', label: 'Need', hint: 'A genuine problem this purchase would address.' },
      { key: 'urgency', label: 'Urgency', hint: 'Why this needs to happen soon rather than eventually.' },
      { key: 'money', label: 'Money', hint: 'Whether budget realistically exists for this.' },
    ],
  },
];

export function methodologyName(id: MethodologyId): string {
  return METHODOLOGIES.find((m) => m.id === id)?.name ?? id;
}
