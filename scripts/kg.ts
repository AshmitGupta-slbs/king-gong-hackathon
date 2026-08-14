/**
 * King Gong in the terminal.
 *
 *   ./kg                    interactive
 *   ./kg calls              list analysed calls
 *   ./kg show <id>          cited notes, transcript, and what the gate rejected
 *   ./kg analyse <file>     transcribe and analyse a call
 *   ./kg doctor             what is configured, and what is wrong
 *
 * Reads go DIRECT to the database so browsing works with nothing running; `analyse` goes over HTTP so
 * the dev server stays the only writer (the reasoning is in kg/http.ts). Every import of an
 * env-dependent module is dynamic and happens after loadEnv(), because REGISTRY_CONFIG and
 * lib/pyai.ts both read process.env at module level and ES imports hoist above everything.
 */
import { createInterface } from 'node:readline/promises';
import { loadEnv, credentialSummary } from './_env';
import { c, heading, mark, mmss, padVisible, row } from './_ui';

type Db = typeof import('@/lib/db');

const USAGE = `
${c.b('kg')} - King Gong in the terminal

  ${c.mono('./kg')}                          interactive: browse calls, read notes, hear the moment
  ${c.mono('./kg calls')}                    list every analysed call
  ${c.mono('./kg show <id>')}                cited notes + transcript + what the gate rejected
  ${c.mono('./kg show <id> --md')}           the same call as Markdown (identical to the web export)
  ${c.mono('./kg analyse <file|https url>')} transcribe and analyse a call
  ${c.mono('./kg doctor')}                   what is configured, and what is wrong

  Options for ${c.mono('analyse')}:
    --engine <claude|bedrock|recap>   override the configured notes engine for this call
    --title  <text>                   name the call
    --account <id>                    attach it to an account, so its context grounds the notes
    --mode <auto|channel|diarize>     speaker separation (default auto: read from the audio)
`;

/** Flags parsed here rather than by a dependency; there are five and they are all `--k v`. */
function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);

async function cmdCalls(db: Db) {
  const calls = await db.listCalls();
  if (!calls.length) {
    console.log(`\n  ${c.warn('No calls yet.')}`);
    console.log(
      `  ${c.dim('Expected five bundled samples here. If samples/index.json is missing, this is a')}\n` +
        `  ${c.dim('partial checkout - re-run')} ${c.mono('./setup.sh')}${c.dim('.')}`,
    );
    return;
  }
  heading(`Calls (${calls.length})`);
  const rows = await Promise.all(
    calls.map(async (call) => ({ call, ex: await db.getExtraction(call.id) })),
  );
  /*
    Column widths measured from the data, not guessed.

    Ids here are two different shapes: an 8-char uuid slice for uploads, and a human slug for the
    committed samples ("competitor-named"). A fixed width sized for one wrecks the other, and
    `padVisible` pads but does not truncate, so a long id simply pushes every later column right.
  */
  const idW = Math.max(...rows.map((r) => r.call.id.length), 4);
  const byW = Math.max(...rows.map((r) => (r.ex?.extracted_by ?? '-').length), 7);
  for (const { call, ex } of rows) {
    const status = !ex
      ? c.dim('not analysed')
      : ex.run_status === 'shipped'
        ? c.ok('shipped')
        : ex.run_status === 'partial'
          ? c.warn('partial')
          : c.bad(ex.run_status);
    console.log(
      `  ${c.mono(padVisible(call.id, idW))}  ${padVisible(status, 12)} ` +
        `${c.dim(padVisible(mmss(call.duration_ms), 6))} ` +
        `${c.dim(padVisible(ex?.extracted_by ?? '-', byW))}  ${call.title}`,
    );
  }
  console.log(`\n  ${c.dim('./kg show <id>')}`);
}

async function loadBundle(db: Db, id: string) {
  const call = await db.getCall(id);
  if (!call) return null;
  const [segments, extraction] = await Promise.all([db.getSegments(id), db.getExtraction(id)]);
  return { call, segments, extraction };
}

async function cmdShow(db: Db, id: string, asMarkdown: boolean) {
  const bundle = await loadBundle(db, id);
  if (!bundle) {
    console.log(`\n  ${c.bad(`No call with id "${id}".`)} ${c.dim('Try ./kg calls')}`);
    process.exitCode = 1;
    return;
  }

  if (asMarkdown) {
    // The same renderer the web export uses, so there is one definition of "this call as a document".
    const { toMarkdown } = await import('@/lib/export');
    console.log(toMarkdown(bundle));
    return;
  }

  const { renderCall, renderTranscript, rule } = await import('./kg/render');
  const index = renderCall(bundle);

  if (!process.stdin.isTTY) {
    // Piped or redirected: print the transcript and stop. Prompting into a pipe hangs forever.
    renderTranscript(bundle.segments, bundle.call.title);
    return;
  }

  if (index.length === 0) return;

  const { playSegment, reportPlay } = await import('./kg/audio');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(rule());
  console.log(
    `  ${c.dim('Type a number to hear that line')} ${c.mono('[1-' + index.length + ']')}` +
      `${c.dim(', ')}${c.mono('t')}${c.dim(' for the transcript, Enter to leave.')}`,
  );
  try {
    for (;;) {
      const answer = (await rl.question('  > ')).trim().toLowerCase();
      if (!answer) break;
      if (answer === 't') {
        const cited = new Set(index.map((e) => e.segment_id));
        renderTranscript(bundle.segments, bundle.call.title, cited);
        continue;
      }
      const n = Number(answer);
      const hit = index.find((e) => e.n === n);
      if (!hit) {
        console.log(`  ${c.warn(`No citation [${answer}]. Pick 1-${index.length}, t, or Enter.`)}`);
        continue;
      }
      reportPlay(
        playSegment(bundle.call.audio_path, hit.start_ms, hit.end_ms),
        `${hit.segment_id} at ${mmss(hit.start_ms)}`,
      );
    }
  } finally {
    rl.close();
  }
}

async function cmdAnalyse(db: Db, source: string, flags: Record<string, string | true>) {
  /*
    Checked before the dev server is even started, let alone before any audio is sent. The harness
    gates on this too (loop.ts), so this is not the enforcement -- it is just not making someone wait
    for Next to boot in order to be told their key cannot do the thing they asked for.
  */
  const engineFlag = str(flags.engine);
  if (engineFlag) {
    const { engineAvailability } = await import('@/lib/engine-availability');
    const a = engineAvailability(engineFlag);
    if (a.available === false) {
      console.log(`\n  ${c.bad(`Cannot analyse with "${engineFlag}".`)}`);
      console.log(`  ${a.message}`);
      console.log(`\n  ${c.dim(a.remedy)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const { ensureServer, analyse } = await import('./kg/http');
  const up = await ensureServer();
  if (!up.ok) {
    console.log(`  ${c.bad('The app did not come up. Run `npm run dev` in another terminal and retry.')}`);
    process.exitCode = 1;
    return;
  }

  const outcome = await analyse({
    source,
    title: str(flags.title),
    engine: str(flags.engine),
    companyId: str(flags.account),
    mode: str(flags.mode),
  });
  if (!outcome) {
    process.exitCode = 1;
    return;
  }

  console.log('');
  const verdict =
    outcome.run_status === 'shipped'
      ? c.ok('shipped')
      : outcome.run_status === 'partial'
        ? c.warn('partial')
        : c.bad(outcome.run_status);
  console.log(`  ${verdict} ${c.dim(`- ${outcome.segments} segments, ${outcome.rejections} rejected`)}`);
  if (outcome.error) console.log(`  ${c.bad(outcome.error)}`);
  if (outcome.remedy) console.log(`  ${c.warn(outcome.remedy)}`);

  const bundle = await loadBundle(db, outcome.callId);
  if (bundle?.extraction) {
    const { renderCall } = await import('./kg/render');
    renderCall(bundle);
    console.log(`\n  ${c.dim(`./kg show ${outcome.callId}`)}  ${c.dim('to come back to this')}`);
  }
}

/**
 * One command that says what is wrong.
 *
 * Checks the things that actually break a fresh install, in the order they break it. Deliberately does
 * NOT run `check:ship` or `npm run verify`: that suite fails on a clean clone on purpose, because the
 * committed sample notes are hand-authored fixtures, so treating its exit code as a health signal would
 * report a broken install on a perfectly good machine.
 */
async function cmdDoctor(db: Db, envFile: string | null) {
  const { existsSync, accessSync, constants } = await import('node:fs');
  const { join } = await import('node:path');

  heading('Environment');
  row('node', process.versions.node);
  row('cwd', process.cwd());
  row('env file', envFile ?? c.warn('none - run ./setup.sh'));

  heading('Credentials');
  const cred = credentialSummary();
  row('PyAI key', cred.pyai ? c.ok('set') : c.warn('unset - uploads will self-mint a capped key'));
  row('Anthropic', cred.anthropic ? c.ok('set') : c.dim('unset'));
  row('Bedrock', cred.bedrock ? c.ok('set') : c.dim('unset'));
  row('LLM_PROVIDER', cred.llmProvider ? c.ok(cred.llmProvider) : c.dim('unset - auto-detect'));
  row('storage', cred.mongo ? c.ok('MongoDB') : c.dim('SQLite (data/opengong.db)'));

  /** Remembered so the "what would run" section below can turn two facts into one remedy. */
  let keyCanRecap = false;
  if (cred.pyai) {
    heading('PyAI key scopes');
    const { execFileSync } = await import('node:child_process');
    try {
      const out = execFileSync('node', ['scripts/pyai-identity.cjs'], { encoding: 'utf8' });
      const kv = new Map(
        out
          .trim()
          .split('\n')
          .map((l) => l.split('=') as [string, string]),
      );
      if (kv.get('ok') === '1') {
        keyCanRecap = kv.get('recap') === '1';
        row('tier', kv.get('tier') === 'live' ? c.ok('live') : c.warn('sandbox - daily capped'));
        row('transcribe', kv.get('transcribe') === '1' ? c.ok('yes') : c.bad('NO'));
        row('recap', keyCanRecap ? c.ok('yes - can write notes') : c.dim('no'));
      } else {
        row('status', c.bad(`${kv.get('code') ?? 'failed'} - ${kv.get('message') ?? ''}`));
      }
    } catch {
      row('status', c.bad('the key was rejected; run npm run check:key for detail'));
    }
  }

  heading('Writable state');
  const dataDir = join(process.cwd(), 'data');
  /*
    Worth its own check: db() does mkdirSync then opens SQLite in WAL mode, which needs to create
    `-wal` and `-shm` files beside the database. A read-only `data/` therefore throws EACCES during the
    first page render and surfaces as a bare 500 on `/` with nothing catching it.
  */
  try {
    if (existsSync(dataDir)) {
      accessSync(dataDir, constants.W_OK);
      row('data/', c.ok('writable'));
    } else {
      row('data/', c.dim('absent - created on first use'));
    }
  } catch {
    row('data/', c.bad('NOT writable - the app will 500 on first render'));
  }

  heading('Engines');
  /*
    The same function the harness gates on and the picker greys out with, so all three agree. `doctor`
    can be more precise than the no-network check when a live key is present, because pyai-identity.cjs
    above already spent one request to learn the real scopes -- so use that when we have it.
  */
  const { engineAvailability } = await import('@/lib/engine-availability');
  for (const name of ['claude', 'bedrock', 'recap'] as const) {
    const a = engineAvailability(name);
    if (name === 'recap' && a.available === 'unknown' && keyCanRecap) {
      row(name, c.ok('usable') + c.dim('  recap:read confirmed on this key'), 14);
      continue;
    }
    row(
      name,
      a.available === false
        ? `${c.bad('unusable')}  ${c.dim(a.message)}`
        : a.available === 'unknown'
          ? `${c.warn('probably')}  ${c.dim(a.note)}`
          : c.ok('usable'),
      14,
    );
  }

  heading('What would run');
  const { describeRegistry } = await import('@/lib/registry');
  const reg = describeRegistry();
  row('speech-to-text', reg.stt);
  row('notes', reg.extractDetail, 14);
  // Same distinction the web home page draws: the corpus is loaded either way, but a prompt-blind
  // engine never receives it, and "skills: six of them" would read as "six are in effect".
  row(
    'skills',
    !reg.skills.length
      ? c.dim('none')
      : reg.extractTakesPrompt
        ? reg.skills.join(', ')
        : `${reg.skills.join(', ')}\n${' '.repeat(17)}${c.warn(`loaded, but not applied: ${reg.extract} takes no prompt`)}`,
    14,
  );
  if (!reg.extractIsRealModel) {
    console.log(`\n  ${c.warn('A new upload would NOT be analysed by a model.')}`);
    /*
      Two facts this function already knows, joined into the one line the reader needs. Reporting "no
      model configured" while separately reporting "your key has recap:read" and leaving the reader to
      connect them is the kind of diagnostic that is technically complete and practically useless.
    */
    if (keyCanRecap) {
      console.log(
        `  ${c.dim('But your PyAI key can write the notes itself. Either:')}\n` +
          `    ${c.mono('echo \'LLM_PROVIDER="recap"\' >> .env.local')}\n` +
          `    ${c.mono('./setup.sh')} ${c.dim('(walks you through it)')}`,
      );
    } else {
      console.log(
        `  ${c.dim('Set ANTHROPIC_API_KEY, or AWS credentials for Bedrock, or use a PyAI key with')}\n` +
          `  ${c.dim('recap:read and LLM_PROVIDER=recap. ')}${c.mono('./setup.sh')} ${c.dim('walks you through it.')}`,
      );
    }
  }

  heading('Data');
  const calls = await db.listCalls();
  console.log(`  ${calls.length ? mark.pass(`${calls.length} calls`) : mark.warn('no calls yet')}`);
  const { serverUp, BASE } = await import('./kg/http');
  console.log(`  ${(await serverUp()) ? mark.pass(`app is up at ${BASE}`) : mark.info('app not running')}`);
  console.log('');
}

async function cmdInteractive(db: Db) {
  const calls = await db.listCalls();
  console.log(`\n${c.b('King Gong')} ${c.dim('- deal notes with receipts')}`);
  if (!calls.length) {
    console.log(`\n  ${c.warn('No calls yet, and the bundled samples did not load.')}`);
    console.log(`  ${c.dim('Run')} ${c.mono('./kg doctor')} ${c.dim('to see what is wrong.')}`);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      console.log('');
      calls.forEach((call, i) => {
        console.log(`  ${c.mono(padVisible(String(i + 1), 3))} ${call.title}`);
      });
      console.log(`  ${c.mono(padVisible('d', 3))} ${c.dim('doctor - what is configured')}`);
      console.log(`  ${c.mono(padVisible('q', 3))} ${c.dim('quit')}`);
      const answer = (await rl.question('\n  > ')).trim().toLowerCase();
      if (!answer || answer === 'q') break;
      if (answer === 'd') {
        await cmdDoctor(db, null);
        continue;
      }
      const n = Number(answer);
      if (!Number.isFinite(n) || n < 1 || n > calls.length) {
        console.log(`  ${c.warn(`Pick 1-${calls.length}, d, or q.`)}`);
        continue;
      }
      // Close our prompt before `show` opens its own, or two readlines fight over stdin.
      rl.close();
      await cmdShow(db, calls[n - 1].id, false);
      return cmdInteractive(db);
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? '';

  if (flags.help || command === 'help') {
    console.log(USAGE);
    return;
  }

  const envFile = loadEnv().file;
  const db: Db = await import('@/lib/db');

  /*
    Seed the bundled samples, exactly as the web app does on its first render.

    Without this, a fresh install was self-contradicting: setup.sh ends by saying "start with the five
    bundled calls" and `./kg calls` then reported none, because seeding only happened when someone
    opened the browser. The terminal UI has to stand on its own.

    This is the one write the CLI does directly, and it is a deliberate exception to "reads direct,
    writes over HTTP": it inserts committed fixtures rather than running the pipeline, so there is no
    run row to strand, it is idempotent and memoised, and it touches no network. Wrapped because a
    simultaneous seed from the dev server could lose a race on a UNIQUE share_id, and a browsing
    session should not die over rows that are about to exist anyway.
  */
  try {
    const { loadSamples } = await import('@/lib/samples');
    await loadSamples();
  } catch {
    /* the sample manifest is optional; an empty list is reported honestly below */
  }

  switch (command) {
    case '':
      return cmdInteractive(db);
    case 'calls':
      return cmdCalls(db);
    case 'show': {
      const id = positional[1];
      if (!id) {
        console.log(`  ${c.bad('Which call? ./kg show <id> - see ./kg calls')}`);
        process.exitCode = 1;
        return;
      }
      return cmdShow(db, id, flags.md === true);
    }
    case 'analyse':
    case 'analyze': {
      const source = positional[1];
      if (!source) {
        console.log(`  ${c.bad('What should I analyse? ./kg analyse <file|https url>')}`);
        process.exitCode = 1;
        return;
      }
      return cmdAnalyse(db, source, flags);
    }
    case 'doctor':
      return cmdDoctor(db, envFile);
    default:
      console.log(`  ${c.bad(`Unknown command "${command}".`)}`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n  ${c.bad(err instanceof Error ? err.message : String(err))}\n`);
  if (process.env.KG_DEBUG && err instanceof Error) console.error(err.stack);
  else console.error(c.dim('  KG_DEBUG=1 for a stack trace.\n'));
  process.exit(1);
});
