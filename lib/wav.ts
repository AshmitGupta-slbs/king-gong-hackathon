/**
 * Minimal 16-bit PCM WAV read/write, plus stereo interleaving.
 *
 * No ffmpeg. Interleaving two mono tracks into one stereo file is a few lines of byte work, and
 * a native media dependency is exactly the kind of thing that turns a five-minute setup into a
 * forty-minute one on somebody else's laptop.
 */

export type Pcm = { pcm16: Uint8Array; sampleRate: number; channels: number };

/** Read a RIFF/WAVE file, walking the chunk list rather than assuming a 44-byte header. */
export function parseWav(bytes: Uint8Array): Pcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');

  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let data: Uint8Array | null = null;

  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
    } else if (id === 'data') {
      // The clamp is load-bearing, not defensive habit: PyAI Speak returns a STREAMING WAV with
      // both the RIFF and data sizes set to 0xFFFFFFFF ("length unknown"). Trusting the declared
      // size would read far past the buffer; ignoring the clamp and trusting a 0 would yield
      // silence. Take whatever bytes actually arrived.
      data = bytes.subarray(body, Math.min(body + size, bytes.length));
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!data) throw new Error('WAV has no data chunk');
  if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}-bit`);
  return { pcm16: data, sampleRate, channels };
}

export function buildWav({ pcm16, sampleRate, channels }: Pcm): Uint8Array {
  const out = new Uint8Array(44 + pcm16.length);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  const byteRate = sampleRate * channels * 2;
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + pcm16.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, channels * 2, true); // block align
  v.setUint16(34, 16, true); // bits
  ascii(36, 'data');
  v.setUint32(40, pcm16.length, true);
  out.set(pcm16, 44);
  return out;
}

export const silence = (ms: number, sampleRate: number) =>
  new Uint8Array(Math.round((sampleRate * ms) / 1000) * 2);

export function concat(chunks: Uint8Array[]): Uint8Array {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** L/R frame interleave. Shorter side is zero-padded so both channels stay time-aligned. */
export function interleaveStereo(left: Uint8Array, right: Uint8Array): Uint8Array {
  const frames = Math.max(left.length, right.length) >> 1;
  const out = new Uint8Array(frames * 4);
  for (let f = 0; f < frames; f++) {
    const i = f * 2;
    const o = f * 4;
    out[o] = left[i] ?? 0;
    out[o + 1] = left[i + 1] ?? 0;
    out[o + 2] = right[i] ?? 0;
    out[o + 3] = right[i + 1] ?? 0;
  }
  return out;
}

export const durationMs = ({ pcm16, sampleRate, channels }: Pcm) =>
  Math.round((pcm16.length / 2 / channels / sampleRate) * 1000);
