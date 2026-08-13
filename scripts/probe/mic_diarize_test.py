#!/usr/bin/env python3
"""Record two people on ONE microphone, then ask Hear who said what.

Why this is a separate script from hear_stream_test.py: **Hear's live stream does not diarize.**
Probed four ways — no parameter, `diarize=true`, `diarize=true&channels=2`, `speaker_labels=true` —
and every `speech_final` came back with the same fields and no speaker on any of them. The params
are accepted and ignored. Speaker separation exists only on the batch jobs path (`diarize: true`),
which needs a finished recording.

So the flow is: record → upload → get speaker_1 / speaker_2. Not live, but it is the real thing.

    ./.venv/bin/python mic_diarize_test.py                  # record until Ctrl-C, then diarize
    ./.venv/bin/python mic_diarize_test.py --seconds 60     # fixed length
    ./.venv/bin/python mic_diarize_test.py --file call.wav  # diarize a recording you already have
    ./.venv/bin/python mic_diarize_test.py --keep out.wav   # also save the recording

Getting a good result from one mic in one room is the hardest case for diarization. Tips are
printed at the end of a poor run rather than buried here.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from batch_silence_probe import multipart, request, wav_bytes  # noqa: E402
from hear_stream_test import (  # noqa: E402
    BOLD, BYTES_PER_SAMPLE, DIM, GREEN, RED, RESET, SAMPLE_RATE, YELLOW,
    read_wav, resolve_key, rms, write_wav,
)

# Colour per speaker, so a transcript is scannable at a glance.
SPEAKER_COLOURS = ["\033[36m", "\033[35m", "\033[33m", "\033[32m"] if sys.stdout.isatty() else [""] * 4


def record(args: argparse.Namespace) -> bytes:
    """Block on the mic, showing a live level meter, until Ctrl-C or --seconds."""
    try:
        import sounddevice as sd
    except ImportError:
        sys.exit("Needs sounddevice:  ./.venv/bin/pip install sounddevice")

    blocks: list[bytes] = []
    peak = 0.0

    def callback(indata, _frames, _time, status) -> None:
        nonlocal peak
        block = bytes(indata)
        blocks.append(block)
        level = rms(block)
        peak = max(peak, level)
        filled = min(20, int(level * 60))
        bar = ("█" * filled).ljust(20)
        secs = sum(len(b) for b in blocks) / (SAMPLE_RATE * BYTES_PER_SAMPLE)
        colour = GREEN if filled >= 3 else DIM
        print(f"\r\033[K  {colour}[{bar}]{RESET} {secs:5.1f}s", end="", flush=True)

    dev = sd.query_devices(args.device, "input") if args.device is not None else \
        sd.query_devices(kind="input")
    print(f"{BOLD}recording{RESET} from {dev['name']}  {DIM}{SAMPLE_RATE}Hz mono{RESET}")
    print(f"{DIM}Both of you speak, taking clear turns. "
          f"{'Stops after %gs.' % args.seconds if args.seconds else 'Ctrl-C when done.'}{RESET}\n")

    stream = sd.RawInputStream(
        samplerate=SAMPLE_RATE, blocksize=SAMPLE_RATE // 10, device=args.device,
        channels=1, dtype="int16", callback=callback,
    )
    started = time.monotonic()
    try:
        with stream:
            while not args.seconds or time.monotonic() - started < args.seconds:
                time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    print()

    pcm = b"".join(blocks)
    secs = len(pcm) / (SAMPLE_RATE * BYTES_PER_SAMPLE)
    if peak < 0.01:
        print(f"{RED}The mic captured near-silence (peak {peak:.4f}).{RESET} Nothing to separate.\n"
              f"{DIM}Check System Settings → Privacy & Security → Microphone.{RESET}")
    print(f"{DIM}captured {secs:.1f}s, loudest input {peak:.3f}{RESET}\n")
    return pcm


# Content types the jobs endpoint accepts directly — no local decoding needed. Verified: an MP3
# uploaded as-is transcribes fine, and its text matches a locally decoded WAV of the same audio.
CONTENT_TYPES = {
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
    ".mp4": "audio/mp4", ".flac": "audio/flac", ".ogg": "audio/ogg",
    ".aac": "audio/aac", ".aiff": "audio/aiff", ".aif": "audio/aiff",
}


def _submit_once(data: bytes, filename: str, ctype: str, key: str,
                 timeout: float) -> tuple[dict | None, str | None]:
    """One upload + poll cycle. Returns (result, error-description)."""
    body, mime = multipart({"diarize": "true", "numerals": "true"}, filename, data, ctype)
    status, job = request("POST", "/transcription/jobs", key, body, mime)
    if status not in (200, 201, 202):
        return None, f"upload returned {status}: {json.dumps(job)[:200]}"
    job_id = job.get("job_id") or job.get("id")
    print(f"{DIM}uploaded, job {job_id} — separating speakers…{RESET}")

    t0 = time.monotonic()
    while job.get("status") in ("queued", "running", "processing"):
        if time.monotonic() - t0 > timeout:
            return None, f"still {job.get('status')} after {timeout:.0f}s"
        time.sleep(1.5)
        status, job = request("GET", f"/transcription/jobs/{job_id}", key)
        if status != 200:
            return None, f"poll returned {status}: {json.dumps(job)[:200]}"
    if job.get("status") != "completed":
        return None, f"job {job.get('status')}: {job.get('error') or '(no detail)'}"
    print(f"{DIM}done in {time.monotonic() - t0:.1f}s{RESET}\n")
    return job.get("result") or {}, None


def diarize(data: bytes, filename: str, key: str, timeout: float = 180.0,
            attempts: int = 4) -> dict | None:
    """Upload with diarize:true and wait, retrying transient server-side failures.

    The retry is not defensive padding: a job was observed failing with
    `diarize: HTTP 500: Internal Server Error` and then succeeding on the identical bytes minutes
    later. PyAI's jobs path has intermittent 5xx windows (docs/api-truth.md), so a single failure
    says nothing about your audio.
    """
    ctype = CONTENT_TYPES.get(Path(filename).suffix.lower(), "application/octet-stream")
    for attempt in range(1, attempts + 1):
        result, err = _submit_once(data, filename, ctype, key, timeout)
        if result is not None:
            return result
        last = attempt == attempts
        print(f"{YELLOW}attempt {attempt}/{attempts} failed{RESET} — {err}")
        if last:
            print(f"{RED}giving up.{RESET} {DIM}A 5xx here is PyAI's side, not your file; the same "
                  f"bytes often succeed minutes later.{RESET}")
            return None
        # Observed bursts of `diarize: HTTP 500` lasting tens of seconds, with the identical
        # bytes succeeding immediately after. Back off far enough to outlast one.
        delay = (5, 15, 30)[min(attempt - 1, 2)]
        print(f"{DIM}retrying in {delay}s…{RESET}")
        time.sleep(delay)
    return None


def report(result: dict, recorded_s: float) -> None:
    segments = result.get("segments") or []
    speakers = sorted({s.get("speaker") for s in segments if s.get("speaker")})

    print(f"{BOLD}── who said what ──{RESET}\n")
    colour_of = {sp: SPEAKER_COLOURS[i % len(SPEAKER_COLOURS)] for i, sp in enumerate(speakers)}
    for s in segments:
        sp = s.get("speaker") or "?"
        start = float(s.get("start", 0))
        mm, ss = divmod(int(start), 60)
        print(f"  {DIM}{mm}:{ss:02d}{RESET}  {colour_of.get(sp, '')}{sp:<10}{RESET} {s.get('text', '')}")

    # Talk-time split — the first metric a conversation-intelligence product computes, and the
    # quickest way to see whether the separation is plausible or nonsense.
    print(f"\n{BOLD}── talk time ──{RESET}")
    total = 0.0
    per: dict[str, float] = {}
    for s in segments:
        d = max(0.0, float(s.get("end", 0)) - float(s.get("start", 0)))
        per[s.get("speaker") or "?"] = per.get(s.get("speaker") or "?", 0.0) + d
        total += d
    for sp, d in sorted(per.items(), key=lambda kv: -kv[1]):
        share = d / total * 100 if total else 0
        bar = "█" * int(share / 4)
        print(f"  {colour_of.get(sp, '')}{sp:<10}{RESET} {d:5.1f}s  {share:5.1f}%  {DIM}{bar}{RESET}")

    found = len(speakers)
    print(f"\n{BOLD}verdict:{RESET} Hear reported "
          f"{GREEN if found >= 2 else YELLOW}{found} speaker(s){RESET} across "
          f"{len(segments)} segment(s) of {recorded_s:.0f}s.")
    if found >= 2:
        print(f"{DIM}Check the labels against what actually happened — the count being right does\n"
              f"not mean every line is attributed to the right person.{RESET}")
    else:
        print(f"{YELLOW}It merged you into one speaker.{RESET} Things that genuinely help, in order:\n"
              f"  1. Take clear turns — leave ~1s of silence between speakers, and don't talk over\n"
              f"     each other. Overlapping speech is the single biggest cause of merging.\n"
              f"  2. Speak for longer. A few seconds each is not enough to model two voices;\n"
              f"     aim for 30s+ total per person.\n"
              f"  3. Sit at similar distances from the mic, but don't swap places mid-recording.\n"
              f"  4. Two voices of similar pitch are genuinely hard on one mic. If you need\n"
              f"     exact separation, record each person on their own channel and use\n"
              f"     `channel:true` instead — that is deterministic and needs no model.")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--file", type=Path,
                   help="diarize this audio file instead of recording — mp3, m4a, wav, flac, ogg. "
                        "Sent to PyAI as-is; no conversion needed.")
    p.add_argument("--seconds", type=float, help="stop recording after N seconds")
    p.add_argument("--device", type=int, help="input device index")
    p.add_argument("--keep", type=Path, help="save the recording to this WAV")
    args = p.parse_args()

    if args.file:
        if not args.file.exists():
            sys.exit(f"no such file: {args.file}")
        suffix = args.file.suffix.lower()
        if suffix not in CONTENT_TYPES:
            print(f"{YELLOW}Unrecognised extension {suffix or '(none)'}{RESET} — sending anyway. "
                  f"{DIM}Known-good: {', '.join(sorted(CONTENT_TYPES))}{RESET}")
        # Uploaded byte-for-byte. PyAI decodes server-side, so there is no local conversion step
        # and no re-encoding loss. Duration comes back in result.audio_seconds.
        data, filename = args.file.read_bytes(), args.file.name
        print(f"{BOLD}{args.file.name}{RESET}  {DIM}{len(data) / 1e6:.2f} MB, "
              f"uploaded as-is ({CONTENT_TYPES.get(suffix, 'unknown type')}){RESET}\n")
        known_s = None
    else:
        pcm = record(args)
        if not pcm:
            sys.exit("no audio")
        known_s = len(pcm) / (SAMPLE_RATE * BYTES_PER_SAMPLE)
        if known_s < 5:
            print(f"{YELLOW}Only {known_s:.1f}s of audio — diarization needs more than that to "
                  f"model two voices.{RESET}\n")
        if args.keep:
            write_wav(args.keep, pcm)
            print(f"{DIM}saved {args.keep}{RESET}")
        data, filename = wav_bytes(pcm), "mic-diarize.wav"

    result = diarize(data, filename, resolve_key())
    if result is None:
        sys.exit(1)
    # For an uploaded file we only learn the duration from the API.
    report(result, known_s if known_s is not None else float(result.get("audio_seconds") or 0))


if __name__ == "__main__":
    main()
