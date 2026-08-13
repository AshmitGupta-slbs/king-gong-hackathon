'use client';

/**
 * Transcript display formatting, shared across the workspace.
 *
 * These contexts used to sit at the top of CallWorkspace.tsx alongside the twelve components that
 * consumed them. They live here now because those components are separate modules, and a context
 * that spans modules has to have a home that isn't one of them.
 *
 * `readable()` is casing and terminal punctuation only, and is guaranteed word-preserving by
 * lib/readability.ts. `segment.text` stays canonical; this is presentation.
 */
import { createContext, useContext } from 'react';
import type { RenderedSpan } from '@/lib/readability';

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
