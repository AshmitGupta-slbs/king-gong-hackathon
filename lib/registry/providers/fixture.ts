/**
 * STT provider: replay committed sample transcripts. No network, no key, no cost.
 *
 * This is what makes "sample data included, demo needs zero setup" true rather than aspirational
 * — and it is only possible because ingestion talks to the registry instead of to PyAI directly.
 *
 * Resolves samples/<basename>.stt.json from the request's filename.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { TranscriptSegment } from '@/lib/types';
import type { STTProvider, STTRequest, STTResult } from '../types';

type Fixture = {
  segments: TranscriptSegment[];
  audio_seconds: number;
  speakers: number;
};

export function fixtureSTT(): STTProvider {
  return {
    name: 'fixture',

    async transcribe(req: STTRequest): Promise<STTResult> {
      const id = basename(req.filename).replace(/\.[^.]+$/, '');
      const path = join(process.cwd(), 'samples', `${id}.stt.json`);
      if (!existsSync(path)) {
        throw new Error(
          `No committed transcript for "${id}" (looked in samples/${id}.stt.json). ` +
            `Fixture mode can only replay the bundled sample calls; use OPENGONG_STT=pyai-jobs ` +
            `to transcribe new audio.`,
        );
      }
      const f = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
      return {
        segments: f.segments,
        audio_seconds: f.audio_seconds,
        speakers: f.speakers,
        // Replay burns nothing, and says so. Reporting fake minutes here would make the usage
        // counter a lie, which is the one thing this product cannot afford.
        usage: {},
      };
    },
  };
}
