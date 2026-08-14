/**
 * Where uploaded call audio lives on disk.
 *
 * One definition, because two places need it — the route that writes a file and the route that
 * streams it back — and a mismatch between them is a call that transcribes perfectly and then plays
 * silence.
 *
 * Configurable because audio is the one thing MongoDB does NOT make durable: a call's record,
 * transcript and notes all survive in Mongo, but the WAV is a filesystem object and a container
 * filesystem is ephemeral. Pointing this at a mounted volume is what makes uploaded audio survive a
 * redeploy. The default keeps it under `data/`, which is already gitignored runtime state, so a
 * clean clone needs no configuration at all.
 *
 * Note it is deliberately NOT `public/`: Next serves that directory as it existed at build time, so
 * a file written there at runtime is invisible to a production server — every local test passes and
 * the hosted demo plays nothing.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function uploadDir(): string {
  const configured = process.env.OPENGONG_UPLOAD_DIR?.trim();
  return configured || join(process.cwd(), 'data', 'uploads');
}

/**
 * Removes an uploaded call's audio file, when there is one to remove.
 *
 * Same whitelist shape `app/api/audio/[file]/route.ts` uses to serve a file — a call's
 * `audio_path` is either `/api/audio/<8-hex>.wav` (an upload, lives under `uploadDir()`) or
 * `/samples/*.wav` (a bundled, committed sample, served from `public/`). This is a no-op for
 * anything that is not the first shape, so a sample's file is never touched, and a missing file
 * (already gone, e.g. after a redeploy on an ephemeral filesystem) is not an error.
 */
export function deleteUpload(audioPath: string): void {
  const m = /^\/api\/audio\/([0-9a-f]{8}\.wav)$/.exec(audioPath);
  if (!m) return;
  const path = join(uploadDir(), m[1]);
  if (existsSync(path)) unlinkSync(path);
}
