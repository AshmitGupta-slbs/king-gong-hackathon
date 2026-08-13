/**
 * PyAI client: key management + request plumbing.
 *
 * Ship-checklist item: "sandbox key mints itself on first run, no manual steps." That happens
 * here. If PYAI_API_KEY is not set, we POST /v1/sandbox/keys (which needs no auth at all) and
 * cache the result to .pyai-key.json. A stranger clones the repo, runs `npm run dev`, and the
 * live path just works — no signup, no card, no env file to fill in.
 *
 * Only lib/registry/providers/* should import this.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.PYAI_BASE_URL ?? 'https://api.pyai.com/v1';
const CACHE = join(process.cwd(), '.pyai-key.json');

type SandboxKey = {
  api_key: string;
  scopes: string[];
  expires_at: number;
  base_url?: string;
};

let cached: SandboxKey | null = null;

/**
 * Keys this process has seen return a quota 429.
 *
 * The bug this fixes: `getPyaiKey()` used to invalidate only on `expires_at`, so a
 * `daily_cap_exceeded` key stayed "valid" — unexpired, correctly scoped, and completely useless —
 * and every subsequent request re-resolved to it. A fresh clone worked (it minted); the demo
 * machine, with a cached key, was exactly the case that broke. Recording exhaustion here means the
 * resolver skips a known-dead key the same way it skips an expired one.
 */
const exhausted = new Set<string>();
/** One mint per process. `sandbox_limit_reached` means the next one fails too — do not loop. */
let mintAttempted = false;

const envKey = () => process.env.PYAI_API_KEY?.trim() || null;

/**
 * Sandbox keys are free, disposable and self-minting, so replacing a spent one costs nothing.
 * A `pyai_live_` key is prepaid and uncapped, and silently swapping it for a capped sandbox key
 * would downgrade a paid account behind the user's back — so that never happens automatically.
 */
const isSandboxKey = (key: string) => key.startsWith('pyai_test_');

/**
 * Record that a key is spent, and report whether we may mint a replacement.
 * Exported for the preflight check; the transports call it automatically.
 */
export function markKeyExhausted(key: string): boolean {
  exhausted.add(key);
  if (!isSandboxKey(key)) return false;
  if (mintAttempted) return false;
  mintAttempted = true;
  return true;
}

/** Mint a fresh sandbox key. Unauthenticated by design — see docs/api-truth.md. */
async function mint(): Promise<SandboxKey> {
  const res = await fetch(`${BASE}/sandbox/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'opengong-lite' }),
  });
  if (!res.ok) {
    // The sandbox-key limit is per NETWORK, not per key, and it is reachable: once hit, every
    // further mint from this machine returns 429 sandbox_limit_reached. Auto-mint is therefore a
    // convenience that can genuinely run out, so say so rather than implying a transient blip.
    let detail = '';
    try {
      const body = (await res.json()) as { detail?: string; title?: string };
      detail = body.detail ?? body.title ?? '';
    } catch {
      /* non-JSON error body */
    }
    const exhausted = res.status === 429;
    throw new Error(
      `Could not mint a PyAI sandbox key (HTTP ${res.status})${detail ? `: ${detail}` : ''}.\n` +
        (exhausted
          ? 'The free sandbox-key allowance for this network is used up. Either set PYAI_API_KEY ' +
            'to an existing key, create an account at https://console.pyai.com, or run the ' +
            'offline demo with OPENGONG_STT=fixture (the five bundled calls need no key at all).'
          : 'Set PYAI_API_KEY manually, or use OPENGONG_STT=fixture for the offline demo.'),
    );
  }
  const key = (await res.json()) as SandboxKey;
  try {
    writeFileSync(CACHE, JSON.stringify(key, null, 2));
  } catch {
    /* read-only fs is fine — we just re-mint next time */
  }
  return key;
}

/**
 * Resolve a usable key: explicit env var → cached file (if unexpired) → freshly minted.
 * Never log the key; it is an opaque secret.
 */
export async function getPyaiKey(): Promise<string> {
  const usable = (key: string) => !exhausted.has(key);
  const fresh = (k: SandboxKey) => k.expires_at > Date.now() + 60_000;

  const env = envKey();
  if (env && usable(env)) return env;
  if (cached && usable(cached.api_key) && fresh(cached)) return cached.api_key;

  if (existsSync(CACHE)) {
    try {
      const k = JSON.parse(readFileSync(CACHE, 'utf8')) as SandboxKey;
      if (usable(k.api_key) && fresh(k)) {
        cached = k;
        return k.api_key;
      }
    } catch {
      /* corrupt cache — fall through and re-mint */
    }
  }
  cached = await mint();
  return cached.api_key;
}

/** Where the active key came from, for `check:key` and the UI. Never returns the key itself. */
export function describeKey(): {
  source: 'env' | 'file' | 'none';
  masked: string | null;
  sandbox: boolean;
  expiresAt: number | null;
} {
  const env = envKey();
  const mask = (k: string) => `${k.slice(0, 12)}…${k.slice(-4)}`;
  if (env) {
    return { source: 'env', masked: mask(env), sandbox: isSandboxKey(env), expiresAt: null };
  }
  if (existsSync(CACHE)) {
    try {
      const k = JSON.parse(readFileSync(CACHE, 'utf8')) as SandboxKey;
      return {
        source: 'file',
        masked: mask(k.api_key),
        sandbox: isSandboxKey(k.api_key),
        expiresAt: k.expires_at ?? null,
      };
    } catch {
      /* corrupt cache reads as absent */
    }
  }
  return { source: 'none', masked: null, sandbox: true, expiresAt: null };
}

/**
 * Cheap liveness check. Costs one request, which is the point: an over-quota key rejects a
 * multipart upload MID-BODY after ~1MB and closes the socket, so a large upload surfaces as a
 * broken pipe rather than the real 429 (measured — docs/api-truth.md). Asking first turns that
 * into an accurate message before any audio is sent.
 */
export async function pyaiPreflight(): Promise<{ ok: true } | { ok: false; error: PyaiError }> {
  try {
    await pyaiGet('/me');
    return { ok: true };
  } catch (err) {
    if (err instanceof PyaiError) return { ok: false, error: err };
    throw err;
  }
}

/** Scopes on the active key, for the UI's honesty footer. */
export async function getPyaiScopes(): Promise<string[]> {
  const key = await getPyaiKey();
  // An env-supplied key has no scope metadata — only minted keys carry it.
  return cached?.api_key === key ? cached.scopes : [];
}

/** "5h 20m" — so the remedy says when the cap lifts rather than leaving arithmetic to the reader. */
export function hoursUntilUtcMidnight(now = new Date()): string {
  const reset = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  const mins = Math.max(0, Math.round((reset - now.getTime()) / 60_000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

export class PyaiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds the server asked us to wait, from the Retry-After header. */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'PyaiError';
  }
  /**
   * 429 and 5xx are worth another attempt; 4xx (bad scope, bad request) never is.
   *
   * Exception: a *quota* 429 is not worth retrying inside a run. `daily_cap_exceeded` survives
   * minutes of backoff (measured — see docs/api-truth.md), so retrying just burns the run's wall
   * clock before failing anyway. Treated as terminal so the caller gets an actionable error fast.
   */
  get retryable() {
    if (this.status === 429) return !this.quotaExhausted;
    return this.status >= 500;
  }

  /** A cap rather than a rate limit: waiting inside this run will not clear it. */
  get quotaExhausted() {
    return this.code === 'daily_cap_exceeded' || this.code === 'sandbox_limit_reached';
  }

  /**
   * Guidance for a human, because "429" on a self-minting key is genuinely confusing: the key is
   * valid, the scopes are right, and it still will not work.
   */
  get remedy(): string | null {
    if (!this.quotaExhausted) return null;

    const hours = hoursUntilUtcMidnight();
    const resets = `It resets at 00:00 UTC, about ${hours} from now.`;

    if (this.code === 'sandbox_limit_reached') {
      // Worth distinguishing: this is the NETWORK's key-minting budget, not one key's usage. Telling
      // someone to "mint a new key" here would send them round a loop that cannot terminate.
      return (
        `This network has used up its free allowance for minting new sandbox keys. ${resets} ` +
        'Minting another key will not help — the limit is per network, not per key. ' +
        'For an uncapped key, create an account at https://console.pyai.com and set PYAI_API_KEY ' +
        'to the pyai_live_ key it gives you. The five bundled sample calls still work either way — ' +
        'they are pre-processed and need no API call.'
      );
    }
    return (
      `This PyAI key has used its daily allowance. ${resets} ` +
      'Transcription of new audio will fail until then. For a key with no daily cap, create an ' +
      'account at https://console.pyai.com and set PYAI_API_KEY to the pyai_live_ key. ' +
      'The five bundled sample calls are unaffected — they are pre-processed and need no API call.'
    );
  }
}

async function toError(res: Response): Promise<PyaiError> {
  let code = 'unknown';
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    /* non-JSON error body */
  }
  const ra = Number(res.headers.get('retry-after'));
  return new PyaiError(
    res.status,
    code,
    `PyAI ${res.status} ${code}: ${message}`,
    Number.isFinite(ra) && ra > 0 ? ra : undefined,
  );
}

export type PyaiResponse<T> = { data: T; units: string | null };

/**
 * Every PyAI request goes through here, so key recovery is not something a call site can forget.
 *
 * On a quota 429 it records the key as spent and, if a replacement is permitted (sandbox key, and
 * we have not already minted this process), resolves a fresh one and retries exactly once. If the
 * mint itself is refused — `sandbox_limit_reached`, the per-NETWORK budget — the original error
 * propagates with its remedy intact rather than being masked by a mint failure.
 */
async function send<T>(
  doFetch: (key: string) => Promise<Response>,
  parse: (res: Response) => Promise<T>,
): Promise<PyaiResponse<T>> {
  for (let attempt = 0; ; attempt++) {
    const key = await getPyaiKey();
    const res = await doFetch(key);
    if (res.ok) return { data: await parse(res), units: res.headers.get('x-pyai-units') };

    const err = await toError(res);
    if (attempt === 0 && err.quotaExhausted && markKeyExhausted(key)) {
      try {
        await getPyaiKey(); // mints a replacement; throws if the network budget is spent
        continue;
      } catch {
        throw err; // the cap is the real problem, not our failure to mint around it
      }
    }
    throw err;
  }
}

const asJson = <T,>(res: Response) => res.json() as Promise<T>;

export async function pyaiGet<T>(path: string): Promise<PyaiResponse<T>> {
  return send<T>(
    (key) =>
      fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
        headers: { Authorization: `Bearer ${key}` },
      }),
    asJson<T>,
  );
}

export async function pyaiPostJson<T>(path: string, body: unknown): Promise<PyaiResponse<T>> {
  return send<T>(
    (key) =>
      fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    asJson<T>,
  );
}

/** Raw bytes out (Speak returns audio, not JSON). */
export async function pyaiPostJsonForBytes(
  path: string,
  body: unknown,
): Promise<PyaiResponse<Uint8Array>> {
  return send<Uint8Array>(
    (key) =>
      fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    async (res) => new Uint8Array(await res.arrayBuffer()),
  );
}

export async function pyaiPostMultipart<T>(
  path: string,
  fields: Record<string, string>,
  file: { field: string; filename: string; bytes: Uint8Array; contentType: string },
): Promise<PyaiResponse<T>> {
  return send<T>(
    (key) => {
      // Rebuilt per attempt: a FormData carrying a Blob is not safely reusable after a failed send.
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append(
        file.field,
        new Blob([file.bytes as unknown as BlobPart], { type: file.contentType }),
        file.filename,
      );
      return fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
    },
    asJson<T>,
  );
}
