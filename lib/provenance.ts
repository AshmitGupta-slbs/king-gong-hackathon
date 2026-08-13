/**
 * Who produced a set of notes, and whether that counts as real model output.
 *
 * This lives in its own dependency-free module for two reasons. It is the single definition of
 * "is this real output?" — `lib/registry` re-exports it so there is no second opinion — and it has
 * to be importable from a client component, which `lib/registry` is not: that module pulls in the
 * provider files, and with them the vendor SDKs.
 */
export const REAL_MODEL_EXTRACTORS = ['claude', 'bedrock'] as const;

export const isRealModelExtractor = (provider: string) =>
  (REAL_MODEL_EXTRACTORS as readonly string[]).includes(provider);

/**
 * How to describe an extractor to a reader.
 *
 * Every non-model extractor gets its OWN wording. The previous version said "deterministic
 * keywords, NOT a model" for anything that was not `claude` or `bedrock` — so once notes were
 * hand-authored for the demo, the interface confidently described them as keyword output. Both
 * are "not a model", but only one of them was true, and being approximately honest about
 * provenance is the failure this product exists to argue against.
 */
export function describeExtractor(name: string | undefined): {
  isReal: boolean;
  label: string;
  detail: string;
} {
  if (!name) {
    return { isReal: false, label: 'unknown', detail: 'provenance was not recorded for these notes' };
  }
  if (isRealModelExtractor(name)) {
    return { isReal: true, label: name, detail: 'produced by a model' };
  }
  if (name === 'demo-fixture') {
    return {
      isReal: false,
      label: 'demo-fixture',
      detail:
        'the claims were hand-authored for the demo — every citation is real and was resolved by ' +
        'the citation gate, but no model wrote the text',
    };
  }
  if (name === 'stub-heuristic') {
    return {
      isReal: false,
      label: 'stub-heuristic',
      detail: 'deterministic keyword rules, not a model',
    };
  }
  return { isReal: false, label: name, detail: 'not a model' };
}
