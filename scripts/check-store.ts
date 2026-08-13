/**
 * Which storage backend is active, and does it actually work?
 *
 *   npm run check:store
 *
 * The sibling of `check:key` and `check:model`. A misconfigured store is silent in the worst way:
 * with no `MONGODB_URI` the app runs happily on SQLite and everything looks fine until a redeploy
 * wipes the container and takes the user's account notes with it. This prints which backend is
 * live, and on Mongo it round-trips a document so "configured" and "working" are not confused.
 */
import { existsSync } from 'node:fs';

// `next dev` loads .env.local; a tsx script does not. Same reasoning as check-key.ts — a checker
// that reads a different environment from the app answers a different question.
for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  try {
    process.loadEnvFile(f);
    break;
  } catch {
    /* a malformed env file should not stop us reporting */
  }
}

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const row = (k: string, v: string) => console.log(`  ${k.padEnd(12)} ${v}`);

async function main() {
  const { backend, describeStore, ensureIndexes, getDatabase, collections, storeConfig } =
    await import('@/lib/store');

  console.log(`\n${c.b('Storage')}\n`);
  const info = describeStore();
  row('backend', info.backend === 'none' ? c.warn(info.backend) : c.ok(info.backend));
  row('detail', info.detail);

  if (backend() === 'none') {
    console.log(
      `\n  ${c.warn('Running on local SQLite.')}\n  ` +
        c.dim(
          'Fine for development and for the whole demo — but a container filesystem is ephemeral,\n  ' +
            'so on a host like Railway everything typed into /setup or uploaded is wiped on the next\n  ' +
            'redeploy. Set MONGODB_URI to store durably.\n',
        ),
    );
    process.exit(0);
  }

  const { prefix } = storeConfig();
  row('prefix', prefix);

  process.stdout.write(`  ${'round trip'.padEnd(12)} `);
  const probe = `${prefix}_store_probe`;
  const id = `probe-${Date.now()}`;
  try {
    const db = getDatabase();
    const coll = db.collection(probe);

    await coll.insertOne({ _id: id, n: 1, at: new Date(), tag: 'check-store' });
    const read = await coll.findOne({ _id: id });
    if (!read) throw new Error('inserted a document and could not read it back');

    await coll.updateOne({ _id: id }, { $set: { tag: 'updated' }, $inc: { n: 2 } });
    const after = await coll.findOne({ _id: id });
    if (after?.tag !== 'updated') throw new Error('$set did not apply');
    if (Number(after?.n) !== 3) throw new Error(`$inc did not apply (n=${String(after?.n)})`);

    const sorted = await coll.find({ tag: 'updated' }).sort('at', -1).limit(1).toArray();
    if (sorted.length !== 1) throw new Error('find/sort/limit returned nothing');

    const count = await coll.countDocuments({ _id: id });
    if (count !== 1) throw new Error(`countDocuments returned ${count}`);

    await coll.deleteMany({ _id: id });
    console.log(c.ok('OK — insert, read, $set, $inc, sort, count, delete'));
  } catch (err) {
    console.log(c.bad('FAILED'));
    console.log(`\n  ${c.bad(err instanceof Error ? err.message : String(err))}\n`);
    if (backend() === 'rest') {
      console.log(
        c.dim(
          '  The REST gateway shim is written to the documented PATHS but its request/response\n' +
            '  BODY shape is unverified — see the header of lib/store/rest.ts, where REQUEST_SHAPE and\n' +
            '  readRows() are isolated so they are a small fix once the real contract is known.\n',
        ),
      );
    }
    process.exit(1);
  }

  const idx = await ensureIndexes();
  row('indexes', idx.skipped ? c.dim('skipped (not the direct backend)') : c.ok(`${idx.created} ensured`));

  console.log(`\n  ${c.ok('Storage is working. Data survives a redeploy.')}`);
  console.log(
    c.dim(`  Collections in use: ${Object.values(collections()).join(', ')}\n`),
  );

  // Scripts must not hang on an open pool.
  const { closeDirect } = await import('@/lib/store/direct');
  await closeDirect();
  process.exit(0);
}

main().catch((e) => {
  console.error(c.bad(`\ncheck:store failed: ${e instanceof Error ? e.stack : String(e)}\n`));
  process.exit(1);
});
