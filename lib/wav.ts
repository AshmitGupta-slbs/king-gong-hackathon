/**
 * Minimal 16-bit PCM WAV read/write, plus stereo interleaving.
 *
 * No ffmpeg. Interleaving two mono tracks into one stereo file is a few lines of byte work, and
 * a native media dependency is exactly the kind of thing that turns a five-minute setup into a
 * forty-minute one on somebody else's laptop.
 */

export type Pcm = { pcm16: Uint8Array; sampleRate: number; channels: number };

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT SNIFFING — trust the bytes, never the filename
//
// A real recording exported from a dialer arrived named `recording.mp3` and was actually
// RIFF/WAVE, 16-bit stereo 8 kHz. Extensions are metadata a human or an exporter guessed at; the
// container is a fact sitting in the first few bytes. Anything that picks a parser or declares a
// Content-Type from the extension is wrong on exactly the files people really have.
//
// We upload the bytes untranscoded either way — PyAI's jobs endpoint accepts compressed audio
// directly — so this only decides what we *claim* the payload is. Claiming `audio/wav` for an MP3
// (which is what this code used to do for every upload, unconditionally) is a lie that happens to
// work only while the server sniffs for itself.
// ─────────────────────────────────────────────────────────────────────────────

const ascii = (b: Uint8Array, o: number, n: number) =>
  String.fromCharCode(...Array.from(b.slice(o, o + n)));

/** Container detected from magic bytes, or null when we genuinely cannot tell. */
export function sniffAudioFormat(bytes: Uint8Array): { mime: string; ext: string } | null {
  if (bytes.length < 12) return null;

  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return { mime: 'audio/wav', ext: 'wav' };
  }
  // ID3-tagged MP3, or a bare MPEG audio frame (0xFF Ex/Fx).
  if (ascii(bytes, 0, 3) === 'ID3') return { mime: 'audio/mpeg', ext: 'mp3' };
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return { mime: 'audio/mpeg', ext: 'mp3' };

  // M4A / MP4 audio. The ftyp brand varies (M4A_, mp42, isom); all are served as MP4 audio.
  if (ascii(bytes, 4, 4) === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' };
  if (ascii(bytes, 0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (ascii(bytes, 0, 4) === 'fLaC') return { mime: 'audio/flac', ext: 'flac' };
  // Both AIFF brands occur on a Mac and both are served as audio/aiff: `say -o out.aiff` with no
  // format flags emits AIFF-C (`FORM…AIFC`), while /System/Library/Sounds/*.aiff are plain AIFF.
  // Recognising only AIFF would have missed the one macOS produces by default.
  if (ascii(bytes, 0, 4) === 'FORM') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'AIFF' || brand === 'AIFC') return { mime: 'audio/aiff', ext: 'aiff' };
  }
  return null;
}

/**
 * What to send for these bytes: the sniffed type, and a filename whose extension agrees with it.
 *
 * When sniffing fails we keep the caller's filename and fall back to `audio/wav` — the previous
 * unconditional behaviour — rather than blocking an upload over a container we don't recognise.
 */
export function audioUploadIdentity(
  bytes: Uint8Array,
  filename: string,
): { mime: string; filename: string; corrected: boolean } {
  const sniffed = sniffAudioFormat(bytes);
  if (!sniffed) return { mime: 'audio/wav', filename, corrected: false };

  const stem = filename.replace(/\.[^./\\]+$/, '') || 'upload';
  const claimed = /\.([^./\\]+)$/.exec(filename)?.[1]?.toLowerCase();
  const corrected = claimed !== sniffed.ext;
  return { mime: sniffed.mime, filename: `${stem}.${sniffed.ext}`, corrected };
}

/** What the `fmt `/`data` chunks say. `dataLength` is what actually arrived, not what was declared. */
export type WavHeader = {
  channels: number;
  sampleRate: number;
  bits: number;
  dataOffset: number;
  dataLength: number;
};

/**
 * Read a RIFF/WAVE header, walking the chunk list rather than assuming a 44-byte header.
 * Returns null — never throws — when the bytes are not a WAV we can describe.
 *
 * Non-throwing because the upload path needs to ask "is this stereo?" of files that are
 * legitimately mp3/m4a/flac/ogg. Wrapping a throwing parser in try/catch would collapse "this is
 * an MP3" (expected, fine) and "this WAV is corrupt" (a real problem) into one indistinguishable
 * outcome, and would use exceptions for the common case.
 */
export function readWavHeader(bytes: Uint8Array): WavHeader | null {
  if (bytes.length < 12) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  // Defaults matter: a `fmt ` chunk is not guaranteed present, and these are the values the
  // original parser assumed. Changing them would change what parseWav returns for such a file.
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let dataOffset = -1;
  let dataLength = 0;

  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      // Bounds-check the body, don't trust the declared size. A truncated upload can carry a
      // `fmt ` header whose 16-byte body was cut off mid-transfer; reading `body + 14` there
      // throws RangeError out of a function whose whole contract is that it never throws.
      if (body + 16 > bytes.length) return null;
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
    } else if (id === 'data') {
      // The clamp is load-bearing, not defensive habit: PyAI Speak returns a STREAMING WAV with
      // both the RIFF and data sizes set to 0xFFFFFFFF ("length unknown"). Trusting the declared
      // size would read far past the buffer; ignoring the clamp and trusting a 0 would yield
      // silence. Take whatever bytes actually arrived.
      dataOffset = body;
      dataLength = Math.min(body + size, bytes.length) - body;
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (dataOffset < 0) return null;
  return { channels, sampleRate, bits, dataOffset, dataLength };
}

/**
 * Read a RIFF/WAVE file as 16-bit PCM. Throws on anything it cannot represent as `Pcm`.
 *
 * Kept as a throwing wrapper because three callers depend on the throws to reject bad TTS output
 * and bad committed samples loudly: macos-say.ts, pyai-speak.ts, and check-ship.ts.
 */
export function parseWav(bytes: Uint8Array): Pcm {
  const h = readWavHeader(bytes);
  if (!h) {
    // Distinguish the two failures the old parser distinguished, in the same order.
    const isRiff =
      bytes.length >= 12 &&
      String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF' &&
      String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WAVE';
    throw new Error(isRiff ? 'WAV has no data chunk' : 'not a RIFF/WAVE file');
  }
  if (h.bits !== 16) throw new Error(`expected 16-bit PCM, got ${h.bits}-bit`);
  return {
    pcm16: bytes.subarray(h.dataOffset, h.dataOffset + h.dataLength),
    sampleRate: h.sampleRate,
    channels: h.channels,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL LAYOUT — "is it stereo?" is not the question worth asking
//
// A two-party phone recording with one party per channel is the case where `channel: true` gives
// exact, model-free speaker separation. But `channels === 2` does NOT imply that. A mono call
// exported as stereo — identical channels, or one channel silent — is extremely common, and
// claiming per-channel separation on one of those produces nonsense. So does a room or conference
// recording where both parties are audible on both channels.
//
// Three statistics from one strided pass separate the cases:
//
//   peak / meanAbs per channel  — is each channel carrying speech at all?
//   diffRatio                   — are the channels actually different?
//   exclusivity                 — is only one party talking at a time?
//
// `exclusivity` is the one that earns its keep. A conference recording has a respectable
// diffRatio (the two mixes are not identical) but both channels are active nearly always. A
// "silent" channel carrying DC offset or mains hum passes the alive test on peak alone. Without
// exclusivity both of those are classified as two-party stereo and transcribe to garbage.
//
// The classifier is deliberately biased toward the status quo: only strong positive evidence
// escalates to `channel`, and every other outcome resolves to `diarize`, which is what the app
// did for every upload before this existed. So no input can regress — only improve.
// ─────────────────────────────────────────────────────────────────────────────

export type ChannelLayout =
  | 'mono'
  | 'two-party-stereo'
  | 'dual-mono'
  | 'one-silent'
  | 'correlated-stereo'
  | 'multichannel'
  | 'unknown';

export type LayoutReport = {
  layout: ChannelLayout;
  /** null when we could not read a header at all (compressed container, garbage, truncated). */
  channels: number | null;
  /** One plain sentence, safe to show a user or write to a log. */
  detail: string;
  stats?: {
    framesExamined: number;
    strideFrames: number;
    peak: number[];
    meanAbs: number[];
    diffRatio: number;
    exclusivity: number;
  };
};

/** int16 full scale is 32768; ≈ −46 dBFS. Below this a channel is carrying no speech. */
const SILENT_PEAK = 164;
/** A channel this much quieter than its partner is not a second party. */
const SILENT_RELATIVE = 1 / 50;
/** Below this the channels are the same signal. Dual-mono measures exactly 0. */
const IDENTICAL_DIFF_RATIO = 0.02;
/** At or above this the channels carry different signals. True two-party measures ≥ 1. */
const DISTINCT_DIFF_RATIO = 0.1;
/** Fraction of active blocks in which only one channel is live. */
const MIN_EXCLUSIVITY = 0.5;
/** 100 ms blocks — long enough to span a syllable, short enough to catch a fast exchange. */
const BLOCK_MS = 100;
/** Too short to judge; a greeting alone tells us nothing about turn-taking. */
const MIN_ANALYSABLE_MS = 200;

/**
 * Classify a WAV's channel layout by sampling its PCM. Never throws.
 *
 * Strides uniformly across the whole file rather than reading a prefix: a party who only speaks
 * in the last thirty seconds of a two-minute call must not be classified as silent.
 */
export function detectChannelLayout(bytes: Uint8Array, maxFrames = 1_000_000): LayoutReport {
  const h = readWavHeader(bytes);
  if (!h) {
    return {
      layout: 'unknown',
      channels: null,
      detail: 'Not a readable WAV, so the channel layout cannot be determined without decoding.',
    };
  }
  if (h.channels === 1) {
    return { layout: 'mono', channels: 1, detail: 'Mono — a single channel.' };
  }
  if (h.channels > 2) {
    return {
      layout: 'multichannel',
      channels: h.channels,
      detail: `${h.channels} channels — not a two-party recording.`,
    };
  }
  if (h.bits !== 16) {
    // 8-bit here is usually µ-law/A-law telephony and 32-bit is IEEE float; decoding either needs
    // a table or a float reader we deliberately do not ship.
    return {
      layout: 'unknown',
      channels: h.channels,
      detail: `Stereo, but ${h.bits}-bit — only 16-bit PCM can be analysed without decoding.`,
    };
  }

  const totalFrames = Math.floor(h.dataLength / 4); // stereo, 2 bytes per sample
  const durationMsTotal = (totalFrames / h.sampleRate) * 1000;
  if (durationMsTotal < MIN_ANALYSABLE_MS) {
    return {
      layout: 'unknown',
      channels: 2,
      detail: 'Too short to judge whether the two channels carry different speakers.',
    };
  }

  const stride = Math.max(1, Math.ceil(totalFrames / maxFrames));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const framesPerBlock = Math.max(1, Math.round((h.sampleRate * BLOCK_MS) / 1000 / stride));
  let absL = 0;
  let absR = 0;
  let absDiff = 0;
  let peakL = 0;
  let peakR = 0;
  let examined = 0;
  let blockL = 0;
  let blockR = 0;
  let inBlock = 0;
  let activeBlocks = 0;
  let exclusiveBlocks = 0;

  for (let f = 0; f < totalFrames; f += stride) {
    const o = h.dataOffset + f * 4;
    const l = v.getInt16(o, true);
    const r = v.getInt16(o + 2, true);
    const al = l < 0 ? -l : l;
    const ar = r < 0 ? -r : r;
    absL += al;
    absR += ar;
    absDiff += Math.abs(l - r);
    if (al > peakL) peakL = al;
    if (ar > peakR) peakR = ar;
    blockL += al;
    blockR += ar;
    examined++;

    if (++inBlock >= framesPerBlock) {
      const liveL = blockL / inBlock > SILENT_PEAK / 4;
      const liveR = blockR / inBlock > SILENT_PEAK / 4;
      if (liveL || liveR) {
        activeBlocks++;
        if (liveL !== liveR) exclusiveBlocks++;
      }
      blockL = 0;
      blockR = 0;
      inBlock = 0;
    }
  }

  const meanL = examined ? absL / examined : 0;
  const meanR = examined ? absR / examined : 0;
  const meanDiff = examined ? absDiff / examined : 0;
  const loudest = Math.max(meanL, meanR);
  const diffRatio = loudest > 0 ? meanDiff / loudest : 0;
  const exclusivity = activeBlocks ? exclusiveBlocks / activeBlocks : 0;
  const stats = {
    framesExamined: examined,
    strideFrames: stride,
    peak: [peakL, peakR],
    meanAbs: [meanL, meanR],
    diffRatio,
    exclusivity,
  };

  const deadL = peakL < SILENT_PEAK || meanL < meanR * SILENT_RELATIVE;
  const deadR = peakR < SILENT_PEAK || meanR < meanL * SILENT_RELATIVE;
  if (deadL || deadR) {
    return {
      layout: 'one-silent',
      channels: 2,
      detail: `Stereo, but the ${deadL ? 'left' : 'right'} channel is effectively silent — this is a mono recording in a stereo container.`,
      stats,
    };
  }
  if (diffRatio < IDENTICAL_DIFF_RATIO) {
    return {
      layout: 'dual-mono',
      channels: 2,
      detail:
        'Stereo, but both channels carry the same audio (a mono recording exported as stereo), so per-channel separation would be meaningless.',
      stats,
    };
  }
  if (diffRatio >= DISTINCT_DIFF_RATIO && exclusivity >= MIN_EXCLUSIVITY) {
    return {
      layout: 'two-party-stereo',
      channels: 2,
      detail:
        'Stereo with two active channels that speak in turn — one party per channel, so speakers can be read off the recording exactly.',
      stats,
    };
  }
  return {
    layout: 'correlated-stereo',
    channels: 2,
    detail:
      'Stereo, but both channels are active at the same time (a room or conference mix rather than one party per channel).',
    stats,
  };
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
