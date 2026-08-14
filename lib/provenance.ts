/**
 * Who produced a set of notes, and whether that counts as real model output.
 *
 * This lives in its own dependency-free module for two reasons. It is the single definition of
 * "is this real output?" — `lib/registry` re-exports it so there is no second opinion — and it has
 * to be importable from a client component, which `lib/registry` is not: that module pulls in the
 * provider files, and with them the vendor SDKs.
 */
/**
 * `recap` belongs here: PyAI Recap's notes ARE written by a model, and answering "no" would put the
 * "these notes were not written by a model" banner over text a model wrote. It is not the same
 * *kind* of real as the other two, though — it takes no prompt and cites nothing — and that is what
 * `describeExtractor` exists to spell out rather than flatten into a boolean.
 */
export const REAL_MODEL_EXTRACTORS = ['claude', 'bedrock', 'recap'] as const;

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
  /**
   * Real model output that still needs its `detail` read — a third state, because the boolean alone
   * cannot express it. Without this, an engine that is genuinely a model but works differently would
   * either be libelled by the "not written by a model" banner or, worse, silently pass as identical
   * to the Claude path. The UI shows the detail neutrally rather than as a warning.
   */
  caveated?: boolean;
} {
  if (!name) {
    return { isReal: false, label: 'unknown', detail: 'provenance was not recorded for these notes' };
  }
  /**
   * Checked BEFORE the generic real-model answer, because "produced by a model" is true of Recap and
   * also the least useful true thing to say about it. Three differences change how these notes should
   * be read, and a reader who is told only "a model wrote this" would assume all three the other way.
   */
  if (name === 'recap') {
    return {
      isReal: true,
      caveated: true,
      label: 'recap',
      detail:
        'written by PyAI Recap, an external notes API. Three differences from the Claude path: ' +
        'Recap takes no instructions, so skills and account context were not applied; it returns no ' +
        'citations, so each claim was matched back to a transcript line here (by Recap\'s own quote ' +
        'where it gave one, otherwise by best word overlap); and because a matched citation always ' +
        'resolves, an unsupported claim ships flagged on a partial run rather than being deleted',
    };
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
