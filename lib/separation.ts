/**
 * Which speaker-separation mode to send PyAI, decided from the audio rather than from a default.
 *
 * The bug this exists to prevent: a real two-party phone recording — stereo, one party per
 * channel — was uploaded and transcribed with `diarize: true`, because the upload form's radio
 * defaulted to mono and nothing ever looked at the file. PyAI received the stereo bytes untouched;
 * only the flag was wrong. It came back as 12 segments with nearly every line attributed to one
 * speaker, where `channel: true` on the identical bytes produced 43 correctly alternating ones.
 *
 * Two rules, in this order:
 *
 *   1. An explicit request always wins. The upload form still exposes Mono and Stereo, and a
 *      caller who picks one is telling us something about the recording that the bytes may not
 *      show. We say so in `reason` when we disagree, and we obey.
 *   2. Otherwise read the bytes, and escalate to `channel` ONLY on strong positive evidence:
 *      two live channels, carrying different signal, speaking in turn. Everything else —
 *      dual-mono, one-silent, a room mix, a compressed container we cannot inspect, a format we
 *      cannot decode — resolves to `diarize`.
 *
 * That asymmetry is deliberate. `diarize` is exactly what this app did for every upload before
 * this file existed, so no input can come out worse than it does today; the only thing that
 * changes is that verified per-party stereo now gets exact, model-free separation. Guessing
 * `channel` on a mono-exported-as-stereo file would be a new failure, and a silent one — the
 * transcript would look plausible and attribute half the call to the wrong person.
 *
 * `channel: true` also never touches PyAI's diarization stage, which docs/api-truth.md records as
 * returning 500 in multi-minute windows. So detection routes verified stereo around a known-flaky
 * upstream as well as labelling it correctly.
 *
 * No imports on purpose (beyond the byte reader): this runs server-side in the upload route and
 * client-side in the upload form, so the same decision is previewed and then applied.
 */
import { detectChannelLayout, type ChannelLayout, type LayoutReport } from './wav';

/** What a caller may ask for. `auto` is a request word — it never reaches the provider or the DB. */
export type RequestedSeparation = 'auto' | 'channel' | 'diarize';

export type SeparationDecision = {
  requested: RequestedSeparation;
  /** The concrete mode to send PyAI and persist on the call. */
  mode: 'channel' | 'diarize';
  layout: ChannelLayout;
  /** True when we chose, false when the caller did. Shown in the UI, not persisted. */
  auto: boolean;
  /** One plain sentence explaining the decision, safe to show a user. */
  reason: string;
};

/** Layouts where per-channel separation is the right call. Everything else diarizes. */
const CHANNEL_LAYOUTS: ReadonlySet<ChannelLayout> = new Set<ChannelLayout>(['two-party-stereo']);

export function resolveSeparation(
  bytes: Uint8Array,
  requested: RequestedSeparation = 'auto',
): SeparationDecision {
  const report: LayoutReport = detectChannelLayout(bytes);

  if (requested !== 'auto') {
    // Obey, but say plainly when the bytes disagree — the UI shows `separation` on every call, and
    // a mismatch is the first thing worth knowing if the transcript looks wrong.
    const wouldAuto = CHANNEL_LAYOUTS.has(report.layout) ? 'channel' : 'diarize';
    const reason =
      wouldAuto === requested
        ? `You chose ${requested}, which matches the file. ${report.detail}`
        : `You chose ${requested}; the file looks like it wants ${wouldAuto}. ${report.detail}`;
    return { requested, mode: requested, layout: report.layout, auto: false, reason };
  }

  const mode = CHANNEL_LAYOUTS.has(report.layout) ? 'channel' : 'diarize';
  return { requested, mode, layout: report.layout, auto: true, reason: report.detail };
}
