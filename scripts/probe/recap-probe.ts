/**
 * What does PyAI Recap actually return?
 *
 *   npx tsx scripts/probe/recap-probe.ts [sampleId]
 *
 * PyAI's OpenAPI types `record` as a bare `object` with no properties, and the guides only ever show
 * a three-field example. So the field names a Recap engine has to map are UNKNOWN until something
 * asks the live API. This is that something: it submits a committed sample's transcript, polls to a
 * terminal state, and prints the whole response plus a flattened key inventory of `record`.
 *
 * Written as a probe rather than a test on purpose — it costs real credit and depends on a live
 * org, so it must never run inside `npm run verify`. Its OUTPUT belongs in docs/api-truth.md; the
 * provider is written against what this prints, not against the documentation.
 *
 * Deliberately talks to lib/pyai.ts rather than raw fetch, so the key resolution and error taxonomy
 * under probe are the same ones that run in production.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// `next dev` loads .env.local; a tsx script does not. Same reasoning as check-store.ts — a probe
// that reads a different environment from the app answers a different question.
for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  try {
    process.loadEnvFile(f);
    break;
  } catch {
    /* a malformed env file should not stop us probing */
  }
}

/**
 * Imported dynamically, inside main(), rather than at the top.
 *
 * lib/pyai.ts reads `PYAI_BASE_URL` at MODULE level, and an ES import is hoisted above the
 * `loadEnvFile` loop — so a static import would resolve the base URL before .env.local had been
 * read. The key itself is read lazily per request and would have been fine either way; the base URL
 * would not.
 */
type PyaiModule = typeof import('../../lib/pyai');

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const sampleId = process.argv[2] ?? 'clean-close';
const sttPath = join('samples', `${sampleId}.stt.json`);
if (!existsSync(sttPath)) {
  console.error(c.bad(`No such sample transcript: ${sttPath}`));
  process.exit(1);
}

type Segment = { id: string; speaker: string; start_ms: number; end_ms: number; text: string };
const stt = JSON.parse(readFileSync(sttPath, 'utf8')) as {
  segments: Segment[];
  audio_seconds?: number;
};

/**
 * A throwaway call_id, so a probe can never collide with (or overwrite) a real call's Recap row.
 * Recap keys records by call_id, so reusing one would silently return the earlier record.
 */
const callId = `probe-${sampleId}-${process.pid}`;

const utterances = stt.segments.map((s) => ({
  // Recap's only speaker vocabulary is agent/customer. Ours is rep/prospect.
  speaker_role: s.speaker === 'rep' ? 'agent' : 'customer',
  text: s.text,
  offset_s: s.start_ms / 1000,
  duration_s: Math.max(0, (s.end_ms - s.start_ms) / 1000),
}));

/** Every key path in an object, so nothing in `record` goes unnoticed because it was nested. */
function keyPaths(v: unknown, prefix = ''): string[] {
  if (Array.isArray(v)) {
    // One representative element is enough to learn the element shape.
    return v.length ? keyPaths(v[0], `${prefix}[]`) : [`${prefix}[] (empty)`];
  }
  if (v && typeof v === 'object') {
    return Object.entries(v).flatMap(([k, val]) => {
      const path = prefix ? `${prefix}.${k}` : k;
      const nested = keyPaths(val, path);
      return nested.length && (Array.isArray(val) || (val && typeof val === 'object'))
        ? nested
        : [`${path}: ${val === null ? 'null' : typeof val}`];
    });
  }
  return [];
}

let pyai: PyaiModule;

async function main() {
  pyai = await import('../../lib/pyai');
  const { describeKey, pyaiGet, pyaiPostJson } = pyai;
  const key = describeKey();
  console.log(c.b('\nPyAI key'));
  console.log(`  ${key.masked}  ${c.dim(`(from ${key.source}${key.sandbox ? ', sandbox' : ', live'})`)}`);

  console.log(c.b('\nGET /recap/config'));
  const config = await pyaiGet<Record<string, unknown>>('/recap/config');
  console.log(`  ${JSON.stringify(config.data)}`);
  if (config.data.enabled !== true) {
    console.log(
      c.warn('\n  Recap is DISABLED for this org. Enable it before probing:\n') +
        c.dim(
          "    curl -X PUT https://api.pyai.com/v1/recap/config -H \"Authorization: Bearer $PYAI_API_KEY\" \\\n" +
            "      -H 'Content-Type: application/json' -d '{\"enabled\": true}'\n",
        ),
    );
    process.exit(1);
  }

  console.log(c.b(`\nPOST /recap/calls/${callId}`));
  console.log(`  ${utterances.length} utterances from ${sampleId}`);
  const submitted = await pyaiPostJson<Record<string, unknown>>(`/recap/calls/${callId}`, {
    utterances,
    call_direction: 'outbound',
    customer_name: 'Probe Co',
    ...(stt.audio_seconds ? { call_duration_s: stt.audio_seconds } : {}),
  });
  console.log(`  -> status ${c.b(String(submitted.data.status))}  pack_id=${submitted.data.pack_id}`);

  console.log(c.b('\nPolling GET /recap/calls/' + callId));
  const started = Date.now();
  let detail: Record<string, unknown> = submitted.data;
  while (Date.now() - started < 180_000) {
    await new Promise((r) => setTimeout(r, 1_200));
    detail = (await pyaiGet<Record<string, unknown>>(`/recap/calls/${callId}`)).data;
    const p = (detail.processing ?? {}) as Record<string, unknown>;
    console.log(
      `  ${((Date.now() - started) / 1000).toFixed(1)}s  status=${detail.status}` +
        (p.stage ? c.dim(`  stage=${p.stage}`) : ''),
    );
    if (detail.status === 'complete' || detail.status === 'failed') break;
  }

  const out = join(
    process.env.OPENGONG_PROBE_OUT ?? '/tmp',
    `recap-probe-${sampleId}.json`,
  );
  writeFileSync(out, JSON.stringify(detail, null, 2));

  if (detail.status !== 'complete') {
    console.log(c.bad(`\nDid not complete: status=${detail.status} error=${detail.error ?? '—'}`));
    console.log(c.dim(`Full response written to ${out}`));
    process.exit(1);
  }

  console.log(c.ok('\ncomplete.'));
  console.log(c.b('\nTop-level keys'));
  for (const k of Object.keys(detail)) console.log(`  ${k}`);

  console.log(c.b('\n`record` key inventory  <- THIS is what the provider maps'));
  const record = detail.record;
  if (!record || typeof record !== 'object') {
    console.log(c.bad('  record is absent or not an object!'));
  } else {
    for (const p of keyPaths(record)) console.log(`  ${p}`);
    console.log(c.b('\n`record` verbatim'));
    console.log(JSON.stringify(record, null, 2));
  }

  console.log(c.b('\nheadline'));
  console.log(`  ${detail.headline ?? c.dim('—')}`);
  console.log(c.b('\nprocessing'));
  console.log(`  ${JSON.stringify(detail.processing)}`);
  console.log(c.dim(`\nFull response written to ${out}\n`));
}

main().catch((err) => {
  if (pyai && err instanceof pyai.PyaiError) {
    console.error(c.bad(`\nPyAI ${err.status} ${err.code}: ${err.message}`));
    if (err.remedy) console.error(c.warn(`  ${err.remedy}`));
  } else {
    console.error(c.bad(`\n${err instanceof Error ? err.message : String(err)}`));
  }
  process.exit(1);
});
