/**
 * Is the PyAI key usable right now, and if not, what do I do about it?
 *
 *   npm run check:key
 *
 * There was no way to answer that without starting an upload and watching it fail — `check:model`
 * exists for Bedrock, but nothing existed for the credential the live path actually depends on.
 * A capped key is indistinguishable from a working one until you spend audio on it: it is
 * unexpired, correctly scoped, and returns 429 for everything.
 *
 * Costs exactly one request (GET /me) — which itself counts against the daily cap, so this prints
 * the answer rather than polling.
 */
import { describeKey, hoursUntilUtcMidnight, pyaiPreflight, PyaiError } from '@/lib/pyai';

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const row = (k: string, v: string) => console.log(`  ${k.padEnd(12)} ${v}`);

async function main() {
  console.log(`\n${c.b('PyAI key')}\n`);

  const info = describeKey();

  if (info.source === 'none') {
    row('source', c.dim('none — a sandbox key will be minted on first use'));
    console.log(
      `\n  ${c.warn('No key configured.')}\n  ` +
        c.dim(
          'That is fine for a fresh clone (one mints itself), but note the sandbox mint budget is\n  ' +
            'per NETWORK, so it can be exhausted before you start. The five bundled samples need no key.\n',
        ),
    );
    process.exit(0);
  }

  row('source', info.source === 'env' ? 'PYAI_API_KEY (environment)' : '.pyai-key.json (minted)');
  row('key', info.masked ?? '—');
  row('tier', info.sandbox ? c.warn('sandbox — daily capped') : c.ok('live — no daily cap'));
  if (info.expiresAt) {
    const days = (info.expiresAt - Date.now()) / 86_400_000;
    row(
      'expires',
      `${new Date(info.expiresAt).toISOString()} ${
        days < 0 ? c.bad('(EXPIRED)') : c.dim(`(${days.toFixed(1)} days)`)
      }`,
    );
  }

  process.stdout.write(`  ${'live check'.padEnd(12)} `);
  const pre = await pyaiPreflight();

  if (pre.ok) {
    console.log(c.ok('OK — the key answers requests'));
    console.log(`\n  ${c.ok('Uploads will work.')}\n`);
    process.exit(0);
  }

  const err: PyaiError = pre.error;
  console.log(c.bad(`FAILED — ${err.code}`));
  console.log(`\n  ${c.bad(err.message)}`);

  if (err.remedy) {
    console.log(`\n  ${c.b('What to do')}\n  ${err.remedy.split('. ').join('.\n  ')}\n`);
  } else if (err.status === 401 || err.status === 403) {
    console.log(
      `\n  ${c.b('What to do')}\n  ` +
        'The key was rejected outright rather than rate-limited — it is wrong, revoked, or lacks\n  ' +
        'the transcription scopes. Check PYAI_API_KEY, or unset it to mint a fresh sandbox key.\n',
    );
  } else {
    console.log('');
  }

  if (err.quotaExhausted) {
    console.log(c.dim(`  Cap lifts in ${hoursUntilUtcMidnight()}.\n`));
  }
  console.log(
    c.dim('  Meanwhile: the five bundled sample calls need no key and demo end to end.\n'),
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(c.bad(`\ncheck:key failed: ${e instanceof Error ? e.stack : String(e)}\n`));
  process.exit(1);
});
