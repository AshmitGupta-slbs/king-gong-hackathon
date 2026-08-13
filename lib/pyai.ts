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
  if (process.env.PYAI_API_KEY) return process.env.PYAI_API_KEY;
  if (cached && cached.expires_at > Date.now() + 60_000) return cached.api_key;

  if (existsSync(CACHE)) {
    try {
      const k = JSON.parse(readFileSync(CACHE, 'utf8')) as SandboxKey;
      if (k.expires_at > Date.now() + 60_000) {
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

/** Scopes on the active key, for the UI's honesty footer. */
export async function getPyaiScopes(): Promise<string[]> {
  await getPyaiKey();
  return cached?.scopes ?? [];
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
    return (
      'This PyAI key has used its free allowance for now (it resets at 00:00 UTC). ' +
      'Transcription of new audio will fail until then. The five bundled sample calls are ' +
      'unaffected — they are pre-processed and need no API call.'
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

export async function pyaiGet<T>(path: string): Promise<PyaiResponse<T>> {
  const key = await getPyaiKey();
  const res = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw await toError(res);
  return { data: (await res.json()) as T, units: res.headers.get('x-pyai-units') };
}

export async function pyaiPostJson<T>(path: string, body: unknown): Promise<PyaiResponse<T>> {
  const key = await getPyaiKey();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
  return { data: (await res.json()) as T, units: res.headers.get('x-pyai-units') };
}

/** Raw bytes out (Speak returns audio, not JSON). */
export async function pyaiPostJsonForBytes(
  path: string,
  body: unknown,
): Promise<PyaiResponse<Uint8Array>> {
  const key = await getPyaiKey();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
  return {
    data: new Uint8Array(await res.arrayBuffer()),
    units: res.headers.get('x-pyai-units'),
  };
}

export async function pyaiPostMultipart<T>(
  path: string,
  fields: Record<string, string>,
  file: { field: string; filename: string; bytes: Uint8Array; contentType: string },
): Promise<PyaiResponse<T>> {
  const key = await getPyaiKey();
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append(
    file.field,
    new Blob([file.bytes as unknown as BlobPart], { type: file.contentType }),
    file.filename,
  );
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw await toError(res);
  return { data: (await res.json()) as T, units: res.headers.get('x-pyai-units') };
}
