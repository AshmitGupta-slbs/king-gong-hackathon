/**
 * Rebuild samples/index.json from whatever is actually on disk.
 *
 *   npm run reindex:samples
 *
 * `make-samples` writes the manifest last, so a run that dies partway — a provider outage, a
 * daily API cap — leaves the manifest describing the *previous* state while the files describe the
 * new one. The UI then reports stale segment counts.
 *
 * This reads the files as the source of truth and regenerates the manifest, so a half-finished
 * regeneration is recoverable without re-burning API quota.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLE_SCRIPTS } from './sample-scripts';
import type { ExtractionResult, TranscriptSegment } from '@/lib/types';

const SAMPLES = join(process.cwd(), 'samples');
const PUBLIC = join(process.cwd(), 'public', 'samples');
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const titleFor = (id: string) => SAMPLE_SCRIPTS.find((s) => s.id === id)?.title ?? id;

console.log(c.b('\nRebuilding samples/index.json from files on disk\n'));

const manifest = readdirSync(SAMPLES)
  .filter((f) => f.endsWith('.stt.json'))
  .map((f) => f.replace('.stt.json', ''))
  .sort((a, b) => SAMPLE_SCRIPTS.findIndex((s) => s.id === a) - SAMPLE_SCRIPTS.findIndex((s) => s.id === b))
  .map((id) => {
    const stt = JSON.parse(readFileSync(join(SAMPLES, `${id}.stt.json`), 'utf8')) as {
      segments: TranscriptSegment[];
      audio_seconds: number;
      speakers: number;
    };
    const resPath = join(SAMPLES, `${id}.result.json`);
    const ex = existsSync(resPath)
      ? (JSON.parse(readFileSync(resPath, 'utf8')) as ExtractionResult)
      : null;

    const audioOk = existsSync(join(PUBLIC, `${id}.wav`));
    const lastSeg = stt.segments[stt.segments.length - 1];

    // Trust the transcript's own end timestamp over a stored duration: after a partial
    // regeneration those can disagree, and the transcript is what the player is synced to.
    const duration_ms = Math.max(
      Math.round(stt.audio_seconds * 1000),
      lastSeg ? lastSeg.end_ms : 0,
    );

    console.log(
      `  ${id.padEnd(20)} ${String(stt.segments.length).padStart(2)} segs · ` +
        `${(duration_ms / 1000).toFixed(0)}s · ${ex?.run_status ?? c.warn('no notes')}` +
        c.dim(` · ${ex?.extracted_by ?? '—'}`) +
        (audioOk ? '' : c.warn('  ⚠ audio missing')),
    );

    return {
      id,
      title: titleFor(id),
      audio_path: `/samples/${id}.wav`,
      duration_ms,
      segments: stt.segments.length,
      speakers: stt.speakers,
      separation: 'channel' as const,
      run_status: ex?.run_status ?? 'not-extracted',
      extracted_by: ex?.extracted_by,
    };
  });

writeFileSync(join(SAMPLES, 'index.json'), JSON.stringify(manifest, null, 2));
console.log(c.ok(`\n  wrote samples/index.json (${manifest.length} calls)\n`));
console.log(
  c.dim('  Note: the DB caches calls by id. Reload the home page — loadSamples() re-seeds it.\n'),
);
