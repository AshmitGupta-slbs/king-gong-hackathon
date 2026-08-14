/**
 * The ship checklist, as code.
 *
 *   npm run check:ship
 *
 * The hackathon brief grades these pass/fail with no partial credit, so they are asserted rather
 * than remembered. Two of these checks exist specifically to stop us fooling ourselves:
 *
 *   • extraction provenance — fails while any shipped note was produced by the keyword stub
 *     rather than a model, so stub output can never quietly become the demo;
 *   • secret scan — fails if a minted PyAI key or an AWS/Anthropic credential is about to be
 *     committed to a public repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRealModelExtractor } from '@/lib/registry';
import { parseWav } from '@/lib/wav';
import { sampleManifest } from '@/lib/samples';
import type { ExtractionResult } from '@/lib/types';

const ROOT = process.cwd();
const c = {
  pass: (s: string) => `\x1b[32m✓\x1b[0m ${s}`,
  fail: (s: string) => `\x1b[31m✗\x1b[0m ${s}`,
  warn: (s: string) => `\x1b[33m!\x1b[0m ${s}`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

let failed = 0;
let warned = 0;
const ok = (name: string, detail = '') => console.log(c.pass(name) + (detail ? ' ' + c.dim(detail) : ''));
const bad = (name: string, detail = '') => {
  console.log(c.fail(name) + (detail ? ' ' + c.dim(detail) : ''));
  failed++;
};
const warn = (name: string, detail = '') => {
  console.log(c.warn(name) + (detail ? ' ' + c.dim(detail) : ''));
  warned++;
};
const assert = (cond: boolean, name: string, detail = '') => (cond ? ok(name, detail) : bad(name, detail));

const read = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);

// ── 1. MIT license, public repo ──────────────────────────────────────────────
console.log(c.b('\nShip checklist\n'));
const license = read('LICENSE');
assert(Boolean(license?.includes('MIT License')), 'MIT LICENSE present');

/**
 * MIT covers the code in this repo; it says nothing about the ~640 npm packages package.json
 * pulls in. This just checks the audit file exists and looks like a real audit (dated, names an
 * actual license category) — re-deriving the whole license tree here would mean running
 * license-checker against node_modules on every ship check, for a number that only changes when
 * a dependency does. `npm run check:licenses` is the thing to re-run by hand after that.
 */
const thirdPartyLicenses = read('THIRD_PARTY_LICENSES.md');
assert(
  Boolean(thirdPartyLicenses?.includes('Audited') && thirdPartyLicenses?.includes('MIT')),
  'third-party dependency license audit present',
);

// ── 2. README: screenshot, pitch, setup, PyAI line ───────────────────────────
const readme = read('README.md');
if (!readme) {
  bad('README.md present');
} else {
  ok('README.md present');
  const shot = readme.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (!shot) bad('README leads with a screenshot');
  else if (!existsSync(join(ROOT, shot[1]))) bad('README screenshot file exists', shot[1]);
  else {
    const kb = Math.round(statSync(join(ROOT, shot[1])).size / 1024);
    assert(kb > 40, 'README screenshot exists and is a real image', `${shot[1]} — ${kb}KB`);
  }
  /*
    Setup is now a one-command installer plus an interactive setup.sh, so grepping for `npm install`
    alone stopped describing it — the manual path is `npm ci` (the lockfile is committed and a
    reproducible install is the point). Widened to accept either installer, and TIGHTENED to require
    that the two entry points a stranger needs are actually named.
  */
  assert(
    /npm (install|ci)/.test(readme) && /npm run dev/.test(readme),
    'README documents how to install and run',
  );
  assert(
    /install\.sh/.test(readme) && /setup\.sh/.test(readme),
    'README points at the one-command installer and at setup.sh',
  );
  assert(existsSync(join(ROOT, 'ONBOARDING.md')), 'ONBOARDING.md exists for a first-time reader');
  for (const script of ['install.sh', 'setup.sh', 'kg']) {
    const p = join(ROOT, script);
    // Executable bit included: these are documented as `./install.sh` and `./kg`, and a committed
    // file without +x makes that instruction wrong on a fresh clone.
    assert(
      existsSync(p) && (statSync(p).mode & 0o111) !== 0,
      `${script} is committed and executable`,
    );
  }
  /*
    Guard the prompt bug, which shipped and reached a teammate's laptop.

    Every prompt in setup.sh used to be `read -r -p "..." VAR || true`. Under `curl | bash` bash reads
    the script from stdin, so stdin is spent by the time the prompts run: each read returned instantly
    at EOF and `|| true` recorded the empty answer as if a human had pressed Enter. The install then
    selected the keyword stub without asking and announced "Setup complete".

    BE HONEST ABOUT WHAT THIS CHECK IS WORTH. It asserts the PATTERN, not the behaviour: that no read
    in setup.sh takes its input from inherited stdin, and that no prompt swallows its own failure. It
    cannot tell you a prompt actually waits for a human. That is proved by driving the script on a real
    pseudo-terminal, which cannot live in this suite because it clones and installs:

        expect -c 'spawn ./setup.sh; expect "PyAI API key*" { send "x\r" }; expect eof'

    So: this catches a careless re-introduction, and the command above is what proves the fix.
  */
  /*
    The shell files must be pure ASCII, and this is a check rather than a comment because the comment
    did not hold: I wrote the rule at the top of both files and then put an em-dash in setup.sh anyway.
    It matters because it has already broken a real installer -- the kit this one is ported from carries
    a commit fixing `AIFL_TARGET: unbound variable`, caused by a Unicode ellipsis sitting after a
    "$var". A stray smart quote from an editor or a paste is silent until it is not.
  */
  for (const script of ['install.sh', 'setup.sh', 'kg']) {
    const text = readFileSync(join(ROOT, script), 'utf8');
    const bad = [...text].filter((ch) => ch.codePointAt(0)! > 127);
    assert(
      bad.length === 0,
      `${script} is pure ASCII (a stray Unicode char has broken an installer before)`,
      bad.length ? `found ${[...new Set(bad)].join(' ')}` : '',
    );
  }

  const setup = readFileSync(join(ROOT, 'setup.sh'), 'utf8');
  const promptReads = setup
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter((l) => /\bread\b/.test(l.line) && /-p\b/.test(l.line) && !l.line.startsWith('#'));
  assert(
    promptReads.length > 0 && promptReads.every((l) => l.line.includes('</dev/tty')),
    'every prompt in setup.sh reads from /dev/tty, not inherited stdin',
    promptReads.length === 0
      ? 'found no prompts at all, which means this check is testing nothing'
      : promptReads
          .filter((l) => !l.line.includes('</dev/tty'))
          .map((l) => `line ${l.n}`)
          .join(', '),
  );
  /*
    Every command setup.sh suggests must come with the directory to run it from.

    setup.sh is a child process, so it cannot change the directory of the shell that launched it. The
    installer clones into a new directory, setup.sh runs inside it, and on exit the user is still where
    they typed the install command -- so a closing message that says "npm run dev" and "./kg" is telling
    them to run commands that cannot work. A second tester pasted `npm run dev` at ~/Desktop and got a
    wall of npm ENOENT about a missing package.json, which describes the symptom and not the cause.

    Absolute (`cd "$HERE"`), not relative (`cd king-gong`): a relative path only works from the parent.
  */
  /*
    Asserted PER BLOCK, not per file, because per file is too weak to catch the actual bug. The first
    version of this check just asked whether `cd "$HERE"` appeared anywhere in setup.sh -- and there are
    several closing blocks, so deleting it from the one the user actually reads left the check green.
    I found that by negative-testing it, which is the only reason it is written this way.
  */
  const heredocs = setup.split(/cat <<'?EOF'?\n/).slice(1).map((chunk) => chunk.split(/^EOF$/m)[0]);
  const blocksSuggestingCommands = heredocs.filter((b) => /npm run dev|\.\/kg/.test(b));
  assert(
    blocksSuggestingCommands.length > 0 &&
      blocksSuggestingCommands.every((b) => b.includes('cd "$HERE"')),
    'every setup.sh message that suggests a command also says which directory to run it from',
    blocksSuggestingCommands.length === 0
      ? 'found no such block, so this check is testing nothing'
      : `${blocksSuggestingCommands.filter((b) => !b.includes('cd "$HERE"')).length} block(s) missing it`,
  );

  // Line-aware and comment-skipping, which the first version was not: it matched the comment inside
  // setup.sh that quotes the broken pattern in order to explain it, and failed the build for
  // documenting the bug. Scan code lines only, the same way the check above does.
  const swallowed = setup
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter((l) => !l.line.startsWith('#'))
    .filter((l) => /\bread\b/.test(l.line) && /-p\b/.test(l.line) && /\|\|\s*true/.test(l.line));
  assert(
    swallowed.length === 0,
    'no prompt in setup.sh discards its own failure with `|| true`',
    swallowed.map((l) => `line ${l.n}`).join(', '),
  );

  assert(/pyai/i.test(readme), 'README carries a "runs on PyAI" line with a link');
  assert(/caveat|limitation/i.test(readme), 'README states its limitations honestly');
}

// ── 3. Zero-setup demo: five sample calls, fully built ────────────────────────
const manifest = sampleManifest();
assert(manifest.length >= 5, 'five sample calls in the manifest', `${manifest.length} found`);

const missing: string[] = [];
const stubbed: string[] = [];
const notExtracted: string[] = [];
for (const s of manifest) {
  if (!existsSync(join(ROOT, 'samples', `${s.id}.stt.json`))) missing.push(`${s.id}.stt.json`);
  if (!existsSync(join(ROOT, `public${s.audio_path}`))) missing.push(`public${s.audio_path}`);

  const resPath = join(ROOT, 'samples', `${s.id}.result.json`);
  if (!existsSync(resPath)) {
    notExtracted.push(s.id);
    continue;
  }
  const ex = JSON.parse(readFileSync(resPath, 'utf8')) as ExtractionResult;
  if (!ex.extracted_by || !isRealModelExtractor(ex.extracted_by)) {
    stubbed.push(`${s.id} (${ex.extracted_by ?? 'unknown'})`);
  }
}
assert(missing.length === 0, 'every sample has committed audio and a transcript', missing.join(', '));

/**
 * Audio and transcript must describe the same recording.
 *
 * This is the highest-consequence invariant in the repo and the easiest to break silently: pair a
 * transcript with a re-generated audio file and every citation still *looks* fine while jumping to
 * the wrong moment. It happened during a partial sample regeneration — audio at a different sample
 * rate, transcripts from the previous run — so it is asserted rather than remembered.
 */
const drifted: string[] = [];
for (const s of manifest) {
  const wav = join(ROOT, `public${s.audio_path}`);
  const stt = join(ROOT, 'samples', `${s.id}.stt.json`);
  if (!existsSync(wav) || !existsSync(stt)) continue;
  const { pcm16, sampleRate, channels } = parseWav(new Uint8Array(readFileSync(wav)));
  const audioMs = (pcm16.length / 2 / channels / sampleRate) * 1000;
  const { segments } = JSON.parse(readFileSync(stt, 'utf8')) as {
    segments: { end_ms: number }[];
  };
  const lastEnd = Math.max(...segments.map((x) => x.end_ms));
  const driftSec = (audioMs - lastEnd) / 1000;
  // The transcript should end just before the audio does. More than a few seconds either way means
  // they are not the same recording.
  if (!(driftSec > -4 && driftSec < 8)) {
    drifted.push(`${s.id}: audio ${(audioMs / 1000).toFixed(1)}s vs transcript ${(lastEnd / 1000).toFixed(1)}s`);
  }
}
assert(
  drifted.length === 0,
  'audio and transcript agree for every sample (citations point at the right moment)',
  drifted.join('; '),
);
assert(notExtracted.length === 0, 'every sample has notes', notExtracted.length ? `missing: ${notExtracted.join(', ')}` : '');

// ── 4. THE PROVENANCE GATE ───────────────────────────────────────────────────
if (stubbed.length > 0) {
  bad(
    'notes were produced by a real model, not the keyword stub',
    `stub-produced: ${stubbed.join(', ')}`,
  );
  console.log(
    c.dim(
      '    → Set ANTHROPIC_API_KEY (or AWS creds + AWS_REGION) and run `npm run extract:samples`.\n' +
      '    → Shipping stub notes as model output is the one thing this product argues against.',
    ),
  );
} else {
  ok('notes were produced by a real model, not the keyword stub');
}

// ── 4b. The upload path decides separation from the audio ────────────────────
// This is the check that would have caught the shipped bug: a stereo two-party recording was
// transcribed with `diarize: true` because the form defaulted to mono and nothing read the file.
// Asserting the wiring rather than remembering it — the same habit as the sandbox-key check below.
const uploadRoute = read('app/api/calls/route.ts');
assert(
  Boolean(uploadRoute?.includes('resolveSeparation')),
  'the upload path consults the bytes before choosing a separation mode',
);
// Strip comments before testing: the fix's own explanatory comment quotes the old cast, and a
// check that trips on prose describing the bug it prevents punishes documenting it.
const uploadCode = (uploadRoute ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
assert(
  !/as SeparationMode/.test(uploadCode),
  'the mode form field is validated, not cast (an unchecked cast silently diarizes)',
);

// ── 5. Sandbox key self-mints, and no secrets are committed ──────────────────
const pyai = read('lib/pyai.ts');
assert(
  Boolean(pyai?.includes('/sandbox/keys')),
  'auto-mint path present: no manual key step in the happy case',
);
// The mint allowance is budgeted per NETWORK and we have exhausted it once, so auto-mint can fail
// on a machine that has done nothing wrong. A 429 there must produce an instruction, not a stack
// trace — that is the difference between "unlucky" and "broken" for someone cloning this.
assert(
  Boolean(pyai?.includes('OPENGONG_STT=fixture') && pyai?.includes('sandbox_limit_reached')),
  'a used-up mint allowance fails with a remedy, not a stack trace',
);

/** Scan tracked source for credential-shaped strings. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/pyai_test_[A-Za-z0-9._-]{12,}/, 'a minted PyAI sandbox key'],
  [/pyai_live_[A-Za-z0-9._-]{12,}/, 'a live PyAI key'],
  [/sk-ant-[A-Za-z0-9._-]{12,}/, 'an Anthropic API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  // Added with the Mongo backend: a connection string carries its own username and password, so
  // committing one leaks a whole database rather than just a key. It matches only URIs that
  // actually carry credentials, so `mongodb+srv://cluster.example.net` in prose is fine — but note
  // .env.example is the ONLY file skipped below, so a credentialed example anywhere else (README,
  // DEPLOY.md) will correctly fail this check.
  [/mongodb(\+srv)?:\/\/[^\s:@/]+:[^\s:@/]+@/, 'a MongoDB connection string with credentials'],
];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'data', 'public']);

/**
 * The question is "would this be COMMITTED?", not "does this file exist on disk?" — so ASK GIT.
 *
 * This check used to parse .gitignore itself, and the parser did `raw.split('#')[0]` to strip
 * comments. Git does not: `#` only starts a comment at the START of a line, so a trailing
 * `pattern    # note` is one literal pattern containing spaces and a hash, matching nothing.
 *
 * The consequence was the worst kind. Four rules in .gitignore were written that way and were all
 * dead, including the one for `.pyai-key.json` — which holds a live minted key. This scanner, being
 * MORE permissive than git, concluded the file was ignored, skipped it, and reported "no credentials
 * would be committed" while a real key sat staged for a public repo.
 *
 * A gate that reimplements the thing it is checking will eventually disagree with it, and the
 * disagreement is silent. So we shell out to `git check-ignore`, which is by definition correct,
 * and if git cannot be consulted we FAIL rather than fall back to guessing.
 */
const inGitWorkTree = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() === 'true';
  } catch {
    return false;
  }
})();

/**
 * Does git ignore this path? Exit 0 = ignored, exit 1 = would be committed. Asking per-path keeps
 * the answer unambiguous, which matters more here than the cost of a few extra processes.
 */
function gitIgnores(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', path], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

// The two rules that would leak something real. Asserted against git's own answer, because the
// previous version of these checks asked whether the PATTERN APPEARED IN THE FILE — which it did,
// with a trailing comment that made it inert. Both passed while both rules were dead.
if (inGitWorkTree) {
  assert(gitIgnores('.pyai-key.json'), 'git ignores the minted PyAI key');
  assert(gitIgnores('data/opengong.db'), 'git ignores the local database');
  assert(!gitIgnores('.env.example'), 'git DOES ship .env.example (the README tells you to copy it)');
} else {
  warn('cannot verify ignore rules — not a git work tree');
}

/**
 * The exact set of files a commit would include: tracked, plus untracked-and-not-ignored. This is
 * what `git add -A` would stage, straight from git, with no interpretation on our part.
 */
function filesGitWouldCommit(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024,
  })
    .toString()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Fallback for a zip download with no git: walk everything and scan it all. */
function filesOnDisk(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name).replace(/^\.\//, '');
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(rel);
        continue;
      }
      out.push(rel);
    }
  };
  walk('.');
  return out;
}

const candidates = inGitWorkTree ? filesGitWouldCommit() : filesOnDisk();
const hits: string[] = [];
for (const rel of candidates) {
  if (!/\.(ts|tsx|js|mjs|json|md|css|example|ya?ml)$/.test(rel)) continue;
  // The example env file and this scanner legitimately contain the patterns as documentation.
  if (rel.endsWith('.env.example') || rel.endsWith('check-ship.ts')) continue;
  let body: string;
  try {
    body = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue; // deleted-but-still-tracked, or unreadable
  }
  for (const [re, what] of SECRET_PATTERNS) {
    if (re.test(body)) hits.push(`${rel}: ${what}`);
  }
}
assert(
  hits.length === 0,
  inGitWorkTree
    ? `no credentials in the ${candidates.length} files a commit would include`
    : `no credentials on disk (NOT a git work tree — scanned everything, ignore rules unverified)`,
  hits.join('; '),
);

/**
 * And the key file itself. Not "is it mentioned in .gitignore" — whether GIT would commit it. The
 * old version asked the first question and got a reassuring answer to the wrong one.
 */
if (existsSync(join(ROOT, '.pyai-key.json'))) {
  assert(
    inGitWorkTree && !candidates.includes('.pyai-key.json'),
    'git would not commit the minted sandbox key',
    inGitWorkTree ? '.pyai-key.json exists locally and is excluded' : 'cannot verify — no git work tree',
  );
}

// ── 6. The harness is visibly present ────────────────────────────────────────
const harness = [
  ['lib/harness/loop.ts', 'named loop + exit status'],
  ['lib/harness/gate.ts', 'blocking gate'],
  ['lib/harness/retry.ts', 'bounded aimed retry'],
  ['lib/harness/budget.ts', 'budget governor'],
  ['lib/harness/parallel.ts', 'safe parallelism'],
  ['lib/db.ts', 'failure invariant (run log)'],
  ['lib/registry/index.ts', 'capability registry'],
] as const;
const absent = harness.filter(([p]) => !existsSync(join(ROOT, p)));
assert(absent.length === 0, 'all seven harness parts present', absent.map(([, n]) => n).join(', '));

// Verification suites must exist (and are expected to be run — see the note below).
assert(existsSync(join(ROOT, 'scripts/test-gate.ts')), 'gate verification suite present');
assert(existsSync(join(ROOT, 'scripts/test-harness.ts')), 'harness verification suite present');

// ── 7. No vendor SDK imported outside the registry ───────────────────────────
const leaks: string[] = [];
const scanImports = (dir: string) => {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) scanImports(rel);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (rel.startsWith('lib/registry/providers')) continue; // the one place that may
    const body = readFileSync(join(ROOT, rel), 'utf8');
    /**
     * Vendor SDKs, not just Anthropic's. This pattern used to match only `@anthropic-ai/`, and it
     * therefore said nothing when AWS signing packages were imported into `lib/` — the same boundary
     * violation, invisible to the check meant to prevent it. Dynamic `import()` counts too, since
     * that is how a lazily-loaded SDK would sneak in.
     */
    if (/(from|import\()\s*'(@anthropic-ai|@aws-sdk|@aws-crypto|@smithy)\//.test(body)) leaks.push(rel);
  }
};
for (const d of ['app', 'lib', 'components', 'scripts']) if (existsSync(join(ROOT, d))) scanImports(d);
assert(
  leaks.length === 0,
  'no vendor SDK imported outside lib/registry/providers',
  leaks.join(', '),
);

// ── 8. Setup is reproducible from a clean checkout ────────────────────────────
const pkg = JSON.parse(read('package.json') ?? '{}') as {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
};
assert(Boolean(pkg.scripts?.dev), 'npm run dev exists');
/**
 * Does `.env.example` actually document every option the code reads?
 *
 * This check used to assert only that the file EXISTS, under the label ".env.example documents every
 * option" — a label promising something it never tested. That gap has now bitten three times in this
 * repo (a gitignore rule that matched nothing, a mint check that proved a runtime guarantee it never
 * exercised, and this), so it is derived rather than asserted: scan lib/** for every `process.env.X`
 * the code reads and require each name to appear in the file.
 *
 * Vendor credential names (the AWS_ and ANTHROPIC_ prefixes) are excluded — they are resolved by the
 * SDKs' own chains and documented in prose rather than as knobs of ours.
 */
{
  const envExample = read('.env.example') ?? '';
  const referenced = new Set<string>();
  const walkLib = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkLib(rel);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      for (const m of readFileSync(join(ROOT, rel), 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        if (!/^(AWS_|ANTHROPIC_|NODE_ENV$)/.test(m[1])) referenced.add(m[1]);
      }
    }
  };
  walkLib('lib');
  const undocumented = [...referenced].filter((name) => !envExample.includes(name)).sort();
  assert(
    existsSync(join(ROOT, '.env.example')) && undocumented.length === 0,
    `.env.example documents all ${referenced.size} options the code reads`,
    undocumented.length ? `missing: ${undocumented.join(', ')}` : '',
  );
}
if (pkg.dependencies && 'better-sqlite3' in pkg.dependencies) {
  warn('a native dependency crept in (better-sqlite3) — it adds a compile step to a clean clone');
}

// ── 9. The CRM payload is a preview, and stays one ───────────────────────────
/**
 * The feature's promise is that nothing can reach a CRM: no client, no credential, no code path.
 * That promise is worth exactly as much as it is enforced, and "we did not write one" is the kind
 * of thing that stops being true the first time somebody adds a convenience.
 *
 * So it is derived, not asserted: scan for an outbound call to a HubSpot host and for any HubSpot
 * credential being read. Either would mean the app can now write to a live pipeline, which is a
 * different product with different risks and should not arrive quietly.
 */
{
  const offenders: string[] = [];
  const scanEgress = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) scanEgress(rel);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const body = readFileSync(join(ROOT, rel), 'utf8');
      // A URL pointing at HubSpot, or a credential named for it. Comments and prose are fine —
      // the payload explains itself at length — so this looks for code shapes, not the word.
      if (/https?:\/\/[^'"\s]*hubapi\.com|https?:\/\/[^'"\s]*hubspot\.com/i.test(body)) {
        offenders.push(`${rel} (hubspot host)`);
      }
      if (/process\.env\.HUBSPOT[A-Z0-9_]*/.test(body)) offenders.push(`${rel} (hubspot credential)`);
    }
  };
  for (const d of ['app', 'lib', 'components', 'scripts']) {
    if (existsSync(join(ROOT, d))) scanEgress(d);
  }
  assert(
    offenders.length === 0,
    'the CRM payload cannot be sent — no HubSpot client, no credential',
    offenders.join(', '),
  );
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log(
  '\n' +
    (failed === 0
      ? c.b('\x1b[32mSHIP CHECKLIST PASSES\x1b[0m') +
        (warned ? c.dim(` (${warned} warning${warned === 1 ? '' : 's'})`) : '')
      : c.b(`\x1b[31m${failed} CHECK${failed === 1 ? '' : 'S'} FAILED\x1b[0m`)),
);
console.log(
  c.dim(
    'Not covered by this script, and still required before demoing:\n' +
    '  • run `npm run test:gate` and `npm run test:harness` and see them green\n' +
    '  • time the setup on a machine you have not touched, from a clean clone\n' +
    '  • run the demo twice, on the real setup path\n',
  ),
);
process.exit(failed === 0 ? 0 : 1);
