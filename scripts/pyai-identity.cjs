/**
 * What can this PyAI key actually do? Machine-readable, for setup.sh.
 *
 *   PYAI_API_KEY=... node scripts/pyai-identity.cjs
 *
 * Prints `key=value` lines on stdout and nothing else, so bash can `eval` or grep it:
 *
 *   ok=1
 *   tier=live
 *   scopes=hear:transcribe transcribe:jobs recap:read recap:configure
 *   recap=1
 *
 * On failure: `ok=0`, plus `status=` and `code=` and a human `message=` on ONE line.
 *
 * ── Why this exists rather than reusing lib/pyai.ts ──
 *
 * `setup.sh` needs the key's scopes to decide which notes engine to recommend, and it needs them at a
 * point where the only thing guaranteed to exist is Node itself. `lib/pyai.ts` is TypeScript behind
 * `tsx`, which is a devDependency -- fine after `npm ci`, not before it, and setup.sh is also meant to
 * be runnable on a half-finished checkout to tell you what is wrong. Plain CommonJS with no imports is
 * the only thing that always works.
 *
 * It deliberately does NOT mint a key. Minting is budgeted per network (see README), so a diagnostic
 * that quietly spends that budget would be the wrong kind of helpful.
 */
'use strict';

const BASE = (process.env.PYAI_BASE_URL || 'https://api.pyai.com/v1').replace(/\/+$/, '');
const KEY = (process.env.PYAI_API_KEY || '').trim();

/** One line, no newlines inside values, so bash line-reading stays simple. */
function emit(obj) {
  for (const [k, v] of Object.entries(obj)) {
    console.log(`${k}=${String(v).replace(/[\r\n]+/g, ' ')}`);
  }
}

async function main() {
  if (!KEY) {
    emit({ ok: 0, code: 'no_key', message: 'No PYAI_API_KEY set.' });
    process.exit(2);
  }

  let res;
  try {
    res = await fetch(`${BASE}/me`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    // Network, DNS, timeout. Distinguished from an auth failure because the remedies are different.
    emit({
      ok: 0,
      code: 'unreachable',
      message: `Could not reach ${BASE}: ${(err && err.message) || err}`,
    });
    process.exit(3);
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body; handled below by status */
  }

  if (!res.ok) {
    const e = (body && body.error) || {};
    emit({
      ok: 0,
      status: res.status,
      code: e.code || 'http_error',
      message: e.message || `HTTP ${res.status}`,
    });
    process.exit(4);
  }

  const scopes = Array.isArray(body.scopes) ? body.scopes : [];
  const has = (s) => (scopes.includes(s) ? 1 : 0);

  emit({
    ok: 1,
    tier: body.env === 'live' ? 'live' : 'sandbox',
    org: body.org_id || '',
    scopes: scopes.join(' '),
    // The three capabilities setup.sh branches on, pre-computed so bash does not have to parse a list.
    transcribe: has('hear:transcribe') && has('transcribe:jobs') ? 1 : 0,
    recap: has('recap:read'),
    speak: has('speak:synthesize'),
    // A live key has no daily cap; a sandbox one does, and its mint budget is per network.
    capped: body.env === 'live' ? 0 : 1,
  });
}

main().catch((err) => {
  emit({ ok: 0, code: 'crash', message: (err && err.message) || String(err) });
  process.exit(1);
});
