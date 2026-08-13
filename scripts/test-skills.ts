/**
 * Prove the skills corpus loads, selects correctly, and does not poison the citation gate.
 *
 *   npm run test:skills
 *
 * The last of those is the point. Skills are instructions injected into every extraction, and the
 * gate scores a claim by how much of it appears in the line it cites — so a skill that supplies
 * vocabulary rather than judgement makes true claims look unsupported, everywhere, at once. That
 * failure is invisible: the notes still read well, they just quietly carry more `unverified` badges.
 *
 * So the corpus is checked mechanically for the words that would cause it, and the prompt is
 * checked for the banner that tells the model what these instructions are not. No model is called —
 * this suite runs on a clean clone with no credential.
 */
import { existsSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  try {
    process.loadEnvFile(f);
    break;
  } catch {
    /* a malformed env file should not stop the suite */
  }
}

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? c.ok('PASS') : c.bad('FAIL')}  ${name}${detail ? c.dim(` — ${detail}`) : ''}`);
  if (!cond) failures++;
};
const head = (s: string) => console.log(`\n${c.b(s)}`);

/** Tokens the gate would strip anyway, so their presence in a skill is harmless. */
const threw = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

async function main() {
  const { loadSkills, enabledSkills, parseFrontmatter, selectSkills, skillApplies } = await import(
    '@/lib/skills'
  );
  const { EXTRACT_SYSTEM, buildExtractUserMessage, extractPromptText } = await import(
    '@/lib/registry/providers/extract-shared'
  );
  const { estimateTokens } = await import('@/lib/harness/budget');

  console.log(`\n${c.b('Skills')}\n`);

  // ── the corpus ─────────────────────────────────────────────────────────────
  head('Corpus');
  const all = loadSkills();
  check('skills load from disk', all.length > 0, `${all.length} found: ${all.map((s) => s.id).join(', ')}`);
  check('every skill has all three frontmatter keys',
    all.every((s) => s.name && s.description && s.applies_to));
  check('every skill has instructions under the frontmatter', all.every((s) => s.body.length > 100));
  check('ids are unique', new Set(all.map((s) => s.id)).size === all.length);
  check('ids are stably sorted', all.map((s) => s.id).join() === [...all.map((s) => s.id)].sort().join(),
    'an unstable order would make two runs over one corpus impossible to diff');

  // ── frontmatter parsing ────────────────────────────────────────────────────
  head('Frontmatter');
  const good = parseFrontmatter('---\nname: A\ndescription: B\napplies_to: always\n---\nbody here', 't');
  check('flat scalars parse', good.meta.name === 'A' && good.body === 'body here');
  check('quotes are stripped',
    parseFrontmatter('---\nname: "A"\n---\nb', 't').meta.name === 'A');
  check('a missing block throws, not returns empty', threw(() => parseFrontmatter('no frontmatter', 't')) !== null,
    'silently accepting an unparseable skill would run the extraction without it');
  check('a non `key: value` line throws',
    threw(() => parseFrontmatter('---\nname: A\n- a list item\n---\nb', 't')) !== null,
    'the flat-scalar restriction is the contract; guessing at YAML would be worse than refusing');
  check('an empty value throws', threw(() => parseFrontmatter('---\nname:\n---\nb', 't')) !== null);

  // ── selection ──────────────────────────────────────────────────────────────
  head('Selection');
  const always = all.filter((s) => s.applies_to === 'always');
  check('some skills apply to every call', always.length > 0, `${always.length} always-on`);

  const staged = all.filter((s) => s.applies_to.startsWith('stage:'));
  check('some skills are stage-scoped', staged.length > 0, staged.map((s) => s.applies_to).join(', '));
  if (staged.length) {
    const s = staged[0];
    const stage = s.applies_to.split(':')[1];
    check('a stage skill applies at its stage', skillApplies(s, { stage, companyId: 'x' }));
    check('...and not at another', !skillApplies(s, { stage: 'Closed Lost', companyId: 'x' }));
    check('...and not when the stage is unknown', !skillApplies(s, { stage: null, companyId: 'x' }));
  }
  check('an unparseable applies_to throws',
    threw(() => skillApplies({ ...all[0], applies_to: 'whenever' }, {})) !== null);

  const prevEnv = process.env.OPENGONG_SKILLS;
  process.env.OPENGONG_SKILLS = 'none';
  check('OPENGONG_SKILLS=none loads nothing', enabledSkills(all).length === 0);
  process.env.OPENGONG_SKILLS = all[0].id;
  check('a named subset loads only that', enabledSkills(all).map((s) => s.id).join() === all[0].id);
  process.env.OPENGONG_SKILLS = 'no-such-skill';
  check('an unknown name THROWS rather than loading nothing', threw(() => enabledSkills(all)) !== null,
    'a typo must not silently mean "analysed without it"');
  process.env.OPENGONG_SKILLS = prevEnv ?? 'all';

  // ── the contamination rule ─────────────────────────────────────────────────
  head('Gate contamination');
  const { contentTokens, supportScore } = await import('@/lib/harness/gate');

  /*
    The measurable version of "instructions, not vocabulary".

    A skill is allowed to name things a rep would say out loud on a call — "pricing", "security
    review", "board". It is NOT allowed to hand the model a phrase to describe findings in, because
    that phrase then appears in a claim and not in the transcript line the claim cites.

    Approximated here as: no skill may contain a directive that supplies output wording. Checked by
    forbidding the imperative forms that introduce one.
  */
  const banned = /\b(describe (?:it|them|these|those) as|call (?:it|them) a|use the (?:phrase|term|word)|refer to (?:it|them) as|label (?:it|them) )/i;
  const offenders = all.filter((s) => banned.test(s.body));
  check('no skill supplies output vocabulary', offenders.length === 0,
    offenders.length ? offenders.map((s) => s.id).join(', ')
      : 'skills say what to look for, never what to call it');

  const jargon = ['meddic', 'bant', 'spiced', 'champion', 'economic buyer', 'pain point'];
  const found = all.flatMap((s) =>
    jargon.filter((j) => s.body.toLowerCase().includes(j)).map((j) => `${s.id}:${j}`),
  );
  check('no framework jargon a prospect would never say', found.length === 0, found.join(', ') ||
    'jargon in a claim scores zero against a transcript that never used it');

  /*
    A worked example of the failure this is all guarding against, so the number is on the record
    rather than asserted. Same claim, one written in the transcript's words and one in borrowed
    vocabulary, scored against the line each would cite.
  */
  const line = 'honestly the price is the thing my boss keeps pushing back on every time i bring it up';
  const grounded = supportScore('Price is what her boss keeps pushing back on.', line);
  const borrowed = supportScore('The economic buyer presents a budget-constrained blocker.', line);
  check('a claim in the call\'s words clears the threshold', grounded >= 0.18, grounded.toFixed(2));
  check('the same claim in borrowed vocabulary does NOT', borrowed < 0.18,
    `${borrowed.toFixed(2)} — this is exactly what a badly written skill would cause`);
  check('the gate tokeniser is what scored it', contentTokens('price').has('price'));

  // ── the prompt ─────────────────────────────────────────────────────────────
  head('Prompt');
  const segments = [
    { id: 'seg_000', speaker: 'rep', start_ms: 0, end_ms: 1000, text: 'hello there' },
    { id: 'seg_001', speaker: 'prospect', start_ms: 1000, end_ms: 2000, text: 'hi' },
  ];
  const withSkills = buildExtractUserMessage({ callTitle: 'T', segments, skillContext: 'LOOK FOR X' });
  const without = buildExtractUserMessage({ callTitle: 'T', segments });

  check('the skill block reaches the prompt', withSkills.includes('LOOK FOR X'));
  check('it is banner\'d as instructions, not facts', withSkills.includes('HOW TO READ THIS CALL'));
  check('the banner says it is not citable', /never citable|nothing here is citable/i.test(withSkills));
  check('it sits ABOVE the transcript',
    withSkills.indexOf('LOOK FOR X') < withSkills.indexOf('TRANSCRIPT (cite these ids'),
    'below it, the model reads instructions as a continuation of the call');
  check('no block appears when no skills are selected', !without.includes('HOW TO READ THIS CALL'));
  check('the system prompt states the instruction-is-not-evidence rule',
    /instruction to look for something is NEVER evidence/i.test(EXTRACT_SYSTEM));

  // ── the budget ─────────────────────────────────────────────────────────────
  head('Budget');
  const bare = estimateTokens(extractPromptText({ callTitle: 'T', segments }));
  const loaded = estimateTokens(
    extractPromptText({ callTitle: 'T', segments, skillContext: 'x'.repeat(20_000) }),
  );
  check('the estimate counts the system prompt', bare > estimateTokens(renderOnly(segments)),
    `${bare} tokens for a 2-line call — the transcript alone is ~${estimateTokens(renderOnly(segments))}`);
  check('the estimate GROWS with loaded skills', loaded > bare + 5_000, `${bare} → ${loaded}`,
  );
  check('...by roughly the text added', Math.abs(loaded - bare - 20_000 / 3.6) < 50,
    'the old estimate counted the transcript only, so a 20KB skill moved it by zero');

  // ── end to end ─────────────────────────────────────────────────────────────
  head('Selection end to end');
  const sel = selectSkills({ companyId: 'co-x', stage: 'Negotiation' });
  check('selecting for a real call returns ids and text', sel.ids.length > 0 && Boolean(sel.text),
    sel.ids.join(', '));
  check('a stage-scoped skill is included at that stage',
    staged.length === 0 || sel.ids.some((id) => staged.some((s) => s.id === id && s.applies_to === 'stage:Negotiation')));
  const other = selectSkills({ companyId: 'co-x', stage: 'Closed Lost' });
  check('...and excluded at another stage', other.ids.length < sel.ids.length,
    `${sel.ids.length} at Negotiation vs ${other.ids.length} at Closed Lost`);

  console.log(
    failures === 0 ? `\n${c.ok('ALL SKILL CHECKS PASS')}\n` : `\n${c.bad(`${failures} FAILED`)}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

const renderOnly = (segs: { id: string; speaker: string; text: string }[]) =>
  segs.map((s) => `[${s.id}] ${s.speaker}: ${s.text}`).join('\n');

main().catch((e) => {
  console.error(c.bad(`\ntest:skills failed: ${e instanceof Error ? e.stack : String(e)}\n`));
  process.exit(1);
});
