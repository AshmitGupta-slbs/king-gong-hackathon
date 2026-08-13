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
import { join } from 'node:path';

export function uploadDir(): string {
  const configured = process.env.OPENGONG_UPLOAD_DIR?.trim();
  return configured || join(process.cwd(), 'data', 'uploads');
}
