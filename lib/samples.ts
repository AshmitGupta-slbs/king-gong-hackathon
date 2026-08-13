/**
 * Load the committed sample calls into the database.
 *
 * This is the zero-setup demo path: no PyAI call, no Claude call, no key, no network. It reads
 * the JSON that scripts/make-samples.ts produced and inserts it, so a stranger who clones the
 * repo and runs `npm run dev` sees five fully-analysed calls immediately.
 *
 * Because replay burns nothing, it records NO usage — the minutes counter must only ever show
 * work that actually happened.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCall, insertCall, replaceSegments, saveExtraction } from './db';
import { seedCompanies } from './crm/db';
import type { ExtractionResult, TranscriptSegment } from './types';

const DIR = join(process.cwd(), 'samples');

export type SampleManifestEntry = {
  id: string;
  title: string;
  audio_path: string;
  duration_ms: number;
  segments: number;
  speakers: number;
  separation: 'channel' | 'diarize' | 'fixture';
  run_status: string;
  /** Registry provider that produced the extraction — 'claude' | 'bedrock' | 'stub-heuristic'. */
  extracted_by?: string;
};

export function sampleManifest(): SampleManifestEntry[] {
  const p = join(DIR, 'index.json');
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')) as SampleManifestEntry[];
}

function readJson<T>(name: string): T | null {
  const p = join(DIR, name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
}

/** Idempotent: safe to call on every boot. Returns the ids that are now present. */
/**
 * Seeding is idempotent, so it only needs to succeed ONCE per process.
 *
 * Without this memo the five presence checks here plus the five in `seedCompanies` run on every
 * page render. Against SQLite that is free and nobody noticed; against a REST gateway it is ten
 * sequential HTTPS round trips before anything is drawn — measured at roughly three seconds on the
 * home page. `force` still bypasses it, and a process restart re-checks, so nothing can get stuck.
 */
let seededThisProcess = false;

export async function loadSamples(
  force = false,
): Promise<{ loaded: string[]; skipped: string[]; missingExtraction: string[] }> {
  if (seededThisProcess && !force) {
    return { loaded: [], skipped: [], missingExtraction: [] };
  }
  // The account records these calls belong to. Idempotent and skip-if-present, so a user's
  // edits in /setup are never overwritten by a reseed.
  await seedCompanies();
  seededThisProcess = true;

  const loaded: string[] = [];
  const skipped: string[] = [];
  const missingExtraction: string[] = [];

  for (const s of sampleManifest()) {
    if (!force && (await getCall(s.id))) {
      skipped.push(s.id);
      continue;
    }
    const stt = readJson<{ segments: TranscriptSegment[]; audio_seconds: number }>(`${s.id}.stt.json`);
    if (!stt) continue;

    await insertCall({
      id: s.id,
      title: s.title,
      audio_path: s.audio_path,
      duration_ms: s.duration_ms,
      separation: s.separation,
      created_at: Date.now(),
      share_id: s.id,
    });
    await replaceSegments(s.id, stt.segments);

    const ex = readJson<ExtractionResult>(`${s.id}.result.json`);
    if (ex) await saveExtraction(s.id, ex);
    else missingExtraction.push(s.id);

    loaded.push(s.id);
  }
  return { loaded, skipped, missingExtraction };
}
