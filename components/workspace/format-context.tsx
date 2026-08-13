'use client';

/**
 * Workspace-wide context: transcript formatting, and who is speaking.
 *
 * These used to sit at the top of CallWorkspace.tsx alongside the twelve components that consumed
 * them. They live here now because those components are separate modules, and a context that spans
 * modules has to have a home that isn't one of them.
 */
import { createContext, useContext } from 'react';
import type { RenderedSpan } from '@/lib/readability';
import type { Participant } from '@/lib/crm/types';

/**
 * `readable()` is casing and terminal punctuation only, and is guaranteed word-preserving by
 * lib/readability.ts. `segment.text` stays canonical; this is presentation.
 */
export const TextFmt = createContext<(s: string) => string>((s) => s);
export const useTextFmt = () => useContext(TextFmt);

/**
 * The same rendering, split into spans so the transcript can mark the one transform that changes
 * words — a spoken digit run collapsed to a number. Separate context because only the transcript
 * needs the spans; tooltips and blockquotes want a plain string.
 */
export const SpanFmt = createContext<(s: string) => RenderedSpan[]>((s) => [
  { text: s, normalized: false },
]);
export const useSpanFmt = () => useContext(SpanFmt);

/**
 * Call-level facts every claim needs: how long the call is (to place a citation on a timeline),
 * and who each transcript speaker actually is.
 *
 * Participants come from the CRM layer and are display-only — `segment.speaker` remains the literal
 * role, because extraction branches on it (`stub-heuristic.ts` decides what counts as an objection
 * with `speaker !== 'rep'`). Renaming speakers in the data would quietly change the notes.
 */
export type CallMeta = {
  durationMs: number;
  participants: Participant[];
};

export const CallMetaContext = createContext<CallMeta>({ durationMs: 0, participants: [] });
export const useCallMeta = () => useContext(CallMetaContext);

/**
 * Resolve a transcript speaker label to a person. Returns null when the call has no CRM record or
 * the label is one we were not told about (a third speaker on a diarized call) — every caller must
 * fall back to the raw label rather than rendering an empty name.
 */
export function useSpeaker(label: string): Participant | null {
  const { participants } = useCallMeta();
  return participants.find((p) => p.speaker === label) ?? null;
}

/** Initials for an avatar. "Priya Raman" → "PR". */
export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

/** mm:ss. Used by every part of the workspace that shows a position in the call. */
export const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export type GateDemoResult = {
  note: string;
  submitted: { objections: number; next_steps: number; key_moments: number };
  survived: { objections: number; next_steps: number; key_moments: number };
  run_status: string;
  rejections: import('@/lib/types').GateRejection[];
};
