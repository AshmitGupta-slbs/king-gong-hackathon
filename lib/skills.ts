/**
 * Skills — the instructions that shape an extraction, kept as files rather than string literals.
 *
 * A skill is a folder under `skills/` holding a `SKILL.md`: frontmatter naming it, then prose
 * telling the model how to read a call. They exist because the parts of the prompt most worth
 * iterating on — what counts as a real objection, when a commitment is verifiable, how to judge
 * whether last call's promise happened — are the parts a salesperson can improve and a programmer
 * cannot. A file can be edited, reviewed and diffed by someone who will never open TypeScript.
 *
 * WHAT A SKILL MAY AND MAY NOT SAY. This is the whole discipline, and it is not stylistic:
 *
 *   A skill may say what to LOOK FOR and how to JUDGE.
 *   A skill may NOT supply vocabulary to DESCRIBE findings in.
 *
 * The citation gate scores every claim by how much of it appears in the transcript line it cites.
 * A skill that says "describe pricing pushback as budget-constrained" hands the model words that
 * are nowhere in the call, so a true claim comes back under-supported and gets flagged unverified.
 * The extraction prompt already warns about this for account context; skills are a bigger version
 * of the same hazard because they apply to every call at once. `npm run test:skills` measures it.
 *
 * NOT the Anthropic Agent Skills runtime. There is no progressive disclosure, no tool use, no
 * model-initiated loading — the model never chooses a skill. Selection happens here, in code, before
 * the call, and everything selected is in the prompt. That is deliberate: this pipeline has a fixed
 * budget and a gate that has to be able to explain what shaped a claim, and both need the set of
 * instructions to be knowable before the request rather than discovered during it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Skill = {
  /** Directory-derived id, e.g. `playbooks/enterprise`. Unique, and what the env var names. */
  id: string;
  name: string;
  description: string;
  /** `always` | `stage:<DealStage>` | `account:<companyId>` */
  applies_to: string;
  body: string;
};

/** Where the corpus lives. Overridable so a deployment can mount its own without a rebuild. */
export const skillsDir = () =>
  process.env.OPENGONG_SKILLS_DIR?.trim() || join(process.cwd(), 'skills');

/**
 * Frontmatter, restricted to flat `key: value` scalars.
 *
 * Not YAML, and not a YAML dependency for three string keys. The restriction is the feature: a
 * skill file that reaches for nesting, lists or anchors is doing something this loader will not
 * silently half-understand — it throws instead, the same way an unrecognised LLM_PROVIDER throws
 * rather than quietly resolving to the keyword stub.
 */
export function parseFrontmatter(src: string, where: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error(`${where}: missing --- frontmatter block at the top of the file.`);

  const meta: Record<string, string> = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at < 1) {
      throw new Error(`${where}: frontmatter line is not \`key: value\` — ${JSON.stringify(raw)}`);
    }
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
    if (!value) throw new Error(`${where}: frontmatter key "${key}" has no value.`);
    meta[key] = value;
  }
  return { meta, body: m[2].trim() };
}

/**
 * Every skill on disk.
 *
 * A skill's id is the directory holding its SKILL.md, relative to `skills/` — so nesting is free
 * and `playbooks/enterprise` reads as what it is. Sorted, because the prompt should be
 * byte-identical between two runs over the same corpus; an unstable order would make a cached
 * prefix miss and make two runs impossible to diff.
 */
export function loadSkills(): Skill[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];

  const out: Skill[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.name === 'SKILL.md') {
        out.push(readSkill(dir, rel, child));
      }
    }
  };
  walk('');
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function readSkill(dir: string, id: string, file: string): Skill {
  const where = `skills/${file}`;
  const { meta, body } = parseFrontmatter(readFileSync(join(dir, file), 'utf8'), where);
  for (const key of ['name', 'description', 'applies_to'] as const) {
    if (!meta[key]) throw new Error(`${where}: frontmatter is missing required key "${key}".`);
  }
  if (!body) throw new Error(`${where}: has frontmatter but no instructions under it.`);
  if (!id) throw new Error(`${where}: a skill needs its own folder — skills/<id>/SKILL.md.`);
  return { id, name: meta.name, description: meta.description, applies_to: meta.applies_to, body };
}

/**
 * Which skills the env var allows.
 *
 * `all` (default) | `none` | a comma-separated list of ids. An id that matches nothing THROWS —
 * a typo'd skill name must not silently mean "run without it", because the resulting notes would
 * look fine and be shaped by a different set of instructions than the operator believed.
 */
export function enabledSkills(all: Skill[]): Skill[] {
  const raw = process.env.OPENGONG_SKILLS?.trim().toLowerCase() ?? 'all';
  if (raw === 'none') return [];
  if (raw === 'all') return all;

  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const known = new Set(all.map((s) => s.id.toLowerCase()));
  const unknown = wanted.filter((w) => !known.has(w));
  if (unknown.length) {
    throw new Error(
      `OPENGONG_SKILLS names ${unknown.length > 1 ? 'skills' : 'a skill'} that does not exist: ` +
        `${unknown.join(', ')}.\nAvailable: ${all.map((s) => s.id).join(', ')} — or "all" / "none".`,
    );
  }
  return all.filter((s) => wanted.includes(s.id.toLowerCase()));
}

/** Does this skill apply to the call in front of us? */
export function skillApplies(skill: Skill, ctx: { companyId?: string | null; stage?: string | null }) {
  const rule = skill.applies_to.trim();
  if (rule === 'always') return true;
  const [kind, value] = rule.split(':').map((s) => s?.trim());
  if (kind === 'stage') return Boolean(ctx.stage) && ctx.stage === value;
  if (kind === 'account') return Boolean(ctx.companyId) && ctx.companyId === value;
  throw new Error(
    `skills/${skill.id}: applies_to must be "always", "stage:<DealStage>" or "account:<companyId>" ` +
      `— got ${JSON.stringify(skill.applies_to)}.`,
  );
}

export type SelectedSkills = { ids: string[]; text: string | null };

/**
 * The skills for one call, and the block that goes in the prompt.
 *
 * Returns ids alongside the text so the run can record what shaped it. A note produced under a
 * playbook and one produced without it are different outputs, and "which instructions were live"
 * has to be answerable after the fact, the same way `extracted_by` answers "which model".
 */
export function selectSkills(ctx: { companyId?: string | null; stage?: string | null }): SelectedSkills {
  const chosen = enabledSkills(loadSkills()).filter((s) => skillApplies(s, ctx));
  if (chosen.length === 0) return { ids: [], text: null };

  const text = chosen
    .map((s) => `## ${s.name}\n${s.description}\n\n${s.body}`)
    .join('\n\n---\n\n');
  return { ids: chosen.map((s) => s.id), text };
}
