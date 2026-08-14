/**
 * Terminal output, in one place.
 *
 * Every script here hand-rolled the same ANSI escape block — nine copies in three dialects, plus a
 * `row()` helper duplicated twice. That was harmless while the scripts were only ever read by whoever
 * wrote them. It stopped being harmless once `setup.sh` and `./kg` started calling several of them in
 * sequence in front of a new user, because "consistent" is a property of the whole sequence and no
 * single copy could provide it.
 *
 * Two dialects survive here on purpose, because they say different things:
 *   `c.*`     colours a string. Use for values, labels, prose.
 *   `mark.*`  prefixes a glyph AND colours it. Use for verdicts, one per line.
 *
 * Kept dependency-free (no chalk, no picocolors) for the same reason the rest of the repo is: a clean
 * clone must install nothing to run a check.
 */

/**
 * Whether to emit escape codes at all.
 *
 * Nothing in this repo checked before, so `npm run check:key > log.txt` wrote escape codes into the
 * file and `./kg calls | grep` matched invisible characters. The three signals, in precedence order:
 *
 *   NO_COLOR      set to anything non-empty -> never colour. The de facto standard (no-color.org).
 *   FORCE_COLOR   set to anything non-empty -> always colour, even when piped. Needed because CI and
 *                 `script`-wrapped runs are not TTYs but do render colour.
 *   isTTY         the default question: is a human looking at this?
 */
const colourEnabled = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
})();

/** Exported so a caller can decide between a box-drawing layout and a plain one. */
export const isColour = colourEnabled;

const wrap = (open: string, s: string) => (colourEnabled ? `\x1b[${open}m${s}\x1b[0m` : s);

/** Colour only. The dialect used by check-key, check-model, check-store and the generators. */
export const c = {
  ok: (s: string) => wrap('32', s),
  bad: (s: string) => wrap('31', s),
  warn: (s: string) => wrap('33', s),
  dim: (s: string) => wrap('2', s),
  b: (s: string) => wrap('1', s),
  /** For values a reader may need to copy exactly: keys, ids, paths, commands. */
  mono: (s: string) => wrap('36', s),
};

/**
 * Glyph + colour. The dialect used by check-ship.
 *
 * The glyph carries the meaning and the colour only reinforces it, so these still read correctly with
 * NO_COLOR set or through a pipe — which is the whole point of not using colour alone as a signal.
 */
export const mark = {
  pass: (s: string) => `${c.ok('✓')} ${s}`,
  fail: (s: string) => `${c.bad('✗')} ${s}`,
  warn: (s: string) => `${c.warn('!')} ${s}`,
  info: (s: string) => `${c.dim('·')} ${s}`,
};

/** `  label        value` — the key/value line check-key and check-store both defined themselves. */
export const row = (k: string, v: string, width = 12) =>
  console.log(`  ${k.padEnd(width)} ${v}`);

/** A section heading with a blank line above it, so long outputs stay scannable. */
export const heading = (s: string) => console.log(`\n${c.b(s)}`);

/**
 * A pass/fail counter with the assertion shape every test script re-invented.
 *
 * Returns an object rather than using module state so two independent suites in one process cannot
 * corrupt each other's count — `./kg doctor` runs several.
 */
export function checker() {
  let failures = 0;
  let passes = 0;
  return {
    check(name: string, cond: boolean, detail = '') {
      const tail = detail ? ` ${c.dim(`— ${detail}`)}` : '';
      console.log(`  ${cond ? mark.pass(name) : mark.fail(name)}${tail}`);
      if (cond) passes++;
      else failures++;
      return cond;
    },
    warn(name: string, detail = '') {
      console.log(`  ${mark.warn(name)}${detail ? ` ${c.dim(`— ${detail}`)}` : ''}`);
    },
    get failures() {
      return failures;
    },
    get passes() {
      return passes;
    },
  };
}

/** mm:ss. Three copies of this existed (export.ts, crm/payload.ts, workspace/format-context.tsx). */
export function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Truncate to a column budget WITHOUT counting escape codes as width.
 *
 * Padding a coloured string with `padEnd` is the classic terminal-table bug: `\x1b[32m` is five
 * invisible characters that `String.length` counts and the terminal does not, so every column after
 * the first coloured cell drifts. Measure on the stripped string, pad on the original.
 */
const ESCAPES = /\x1b\[[0-9;]*m/g;
export const visibleWidth = (s: string) => s.replace(ESCAPES, '').length;

export function padVisible(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function truncVisible(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  // Only safe on strings without escapes; coloured cells should be coloured AFTER truncation.
  return `${s.slice(0, Math.max(0, width - 1))}…`;
}

/** Terminal width, with a sane floor so a narrow window degrades rather than wraps into noise. */
export const termWidth = () => Math.max(60, process.stdout.columns || 100);
