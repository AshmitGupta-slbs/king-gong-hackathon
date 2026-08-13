/**
 * TTS provider: PyAI Speak (`POST /v1/audio/speech`).
 *
 * The PREFERRED sample-generation provider — it burns Speak minutes, which is the point of
 * building on PyAI. It is not the default only because the service returned
 * `503 upstream_error "Speech synthesis is unavailable"` for every request throughout H0, across
 * three model ids and two response formats (docs/api-truth.md).
 *
 * To use it once it recovers:  OPENGONG_TTS=pyai-speak npm run samples
 */
import { pyaiPostJsonForBytes } from '@/lib/pyai';
import { parseWav } from '@/lib/wav';
import { REGISTRY_CONFIG } from '..';
import type { TTSProvider, TTSRequest, TTSResult } from '../types';

export function pyaiSpeakTTS(): TTSProvider {
  return {
    name: 'pyai-speak',
    // From GET /v1/voices (144 stock voices available).
    voices: { rep: 'stock_amos_en_us', prospect: 'stock_amelia_en_gb' },

    async synthesize(req: TTSRequest): Promise<TTSResult> {
      const { data, units } = await pyaiPostJsonForBytes('/audio/speech', {
        // `pyai-voice` is the real Speak model id per GET /v1/models — NOT `pyai-speak`.
        model: 'pyai-voice',
        voice: req.voice,
        input: req.text,
        response_format: 'wav',
      });
      const { pcm16, sampleRate } = parseWav(data);
      return {
        pcm16,
        sampleRate,
        usage: { units: units ?? undefined },
      };
    },
  };
}

/** Exported so make-samples can report which provider actually ran. */
export const speakConfigured = () => REGISTRY_CONFIG.tts === 'pyai-speak';
