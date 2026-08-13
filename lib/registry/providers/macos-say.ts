/**
 * TTS provider: macOS built-in `say`.
 *
 * Only used by scripts/make-samples.ts to build the committed sample calls — never on the
 * request path. It exists because PyAI Speak returned 503 upstream_error throughout H0
 * (docs/api-truth.md), and waiting on somebody else's outage is not a plan.
 *
 * Because the generated WAVs are committed to the repo, nobody cloning it needs `say`, macOS,
 * or any TTS at all. Swap REGISTRY_CONFIG.tts to 'pyai-speak' when the service recovers.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWav } from '@/lib/wav';
import type { TTSProvider, TTSRequest, TTSResult } from '../types';

const SAMPLE_RATE = 16000;

export function macosSayTTS(): TTSProvider {
  return {
    name: 'macos-say',
    // Two clearly different-sounding US voices so diarization has a fair chance.
    voices: { rep: 'Alex', prospect: 'Samantha' },

    async synthesize(req: TTSRequest): Promise<TTSResult> {
      if (process.platform !== 'darwin') {
        throw new Error(
          "The 'macos-say' TTS provider needs macOS. Sample audio is already committed to " +
            'samples/, so you only need this to regenerate it.',
        );
      }
      const dir = mkdtempSync(join(tmpdir(), 'opengong-say-'));
      const out = join(dir, 'turn.wav');
      try {
        execFileSync(
          'say',
          [
            '-v',
            req.voice,
            '-o',
            out,
            `--data-format=LEI16@${SAMPLE_RATE}`,
            '--file-format=WAVE',
            req.text,
          ],
          { stdio: 'pipe' },
        );
        const { pcm16, sampleRate } = parseWav(readFileSync(out));
        return { pcm16, sampleRate, usage: {} };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
