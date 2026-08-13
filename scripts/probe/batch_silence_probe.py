#!/usr/bin/env python3
"""Does Hear's BATCH path fabricate text from silence, like the streaming path does?

The streaming probe (hear_stream_test.py --mic) caught Hear emitting confident finals
containing sentences nobody said, from room ambience. Batch jobs are the path opengong-lite
actually ingests with, and our citation gate only checks that a quoted claim resolves to
some `segment.text` — so a fabricated segment becomes quotable evidence and passes the gate.
docs/api-truth.md records the streaming finding and flags batch as untested. This tests it.

Method: build one WAV of  speech | long digital silence | speech , submit it with
diarize:true, and check whether any returned segment overlaps the silent window. Digital
silence is the strongest possible version of the test — not quiet room tone, exact zeroes.

    ./.venv/bin/python batch_silence_probe.py            # 5s speech, 25s silence, 5s speech
    ./.venv/bin/python batch_silence_probe.py --silence 40
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hear_stream_test import (  # noqa: E402
    BASE, BYTES_PER_SAMPLE, DIM, GREEN, RED, RESET, SAMPLE_RATE, YELLOW,
    resolve_key, ssl_context, write_wav,
)

LEAD = "The pricing came in around fourteen hundred a seat."
TAIL = "So we would need approval from finance before signing."


def say(text: str, voice: str) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "t.wav"
        subprocess.run(
            ["say", "-v", voice, "-o", str(out),
             f"--data-format=LEI16@{SAMPLE_RATE}", "--file-format=WAVE", text],
            check=True, capture_output=True,
        )
        with wave.open(str(out), "rb") as w:
            return w.readframes(w.getnframes())


def wav_bytes(pcm: bytes) -> bytes:
    """PCM16 -> a real WAV container. Reuses write_wav so the header matches the probe's."""
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "probe.wav"
        write_wav(path, pcm)
        return path.read_bytes()


def multipart(fields: dict[str, str], filename: str, data: bytes,
              ctype: str = "audio/wav") -> tuple[bytes, str]:
    b = "----probe" + os.urandom(8).hex()
    out = b""
    for k, v in fields.items():
        out += f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    out += (f"--{b}\r\nContent-Disposition: form-data; name=\"audio\"; "
            f"filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
    out += data + b"\r\n" + f"--{b}--\r\n".encode()
    return out, f"multipart/form-data; boundary={b}"


def request(method: str, path: str, key: str, body: bytes | None = None,
            ctype: str | None = None) -> tuple[int, dict]:
    headers = {"Authorization": f"Bearer {key}"}
    if ctype:
        headers["Content-Type"] = ctype
    req = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, context=ssl_context()) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except ValueError:
            return e.code, {"raw": raw[:300].decode("utf-8", "replace")}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--silence", type=float, default=25.0, help="seconds of gap")
    p.add_argument("--noise", type=float, default=0.0,
                   help="fill the gap with noise at this RMS (0..1) instead of exact zeroes. "
                        "0.035 is the level of room tone that made the STREAM fabricate text; "
                        "exact zeroes are a much weaker test.")
    p.add_argument("--keep", type=Path, help="save the probe WAV here")
    p.add_argument("--diarize", default="true")
    args = p.parse_args()

    lead, tail = say(LEAD, "Alex"), say(TAIL, "Samantha")
    n_samples = int(args.silence * SAMPLE_RATE)
    if args.noise > 0:
        import random

        rng = random.Random(20260813)  # fixed seed so a rerun is comparable
        amp = args.noise * 32768 * 1.73  # uniform[-a,a] has RMS a/sqrt(3)
        gap = b"".join(
            int(max(-32768, min(32767, rng.uniform(-amp, amp)))).to_bytes(2, "little", signed=True)
            for _ in range(n_samples)
        )
    else:
        gap = b"\x00" * n_samples * BYTES_PER_SAMPLE
    pcm = lead + gap + tail

    lead_s = len(lead) / (SAMPLE_RATE * BYTES_PER_SAMPLE)
    gap_end = lead_s + args.silence
    total = len(pcm) / (SAMPLE_RATE * BYTES_PER_SAMPLE)
    print(f"probe audio: {total:.1f}s total\n"
          f"  {DIM}0.0 – {lead_s:.1f}s{RESET}    speech  “{LEAD}”\n"
          f"  {YELLOW}{lead_s:.1f} – {gap_end:.1f}s{RESET}  "
          f"{'NOISE at RMS %.3f' % args.noise if args.noise > 0 else 'DIGITAL SILENCE (exact zeroes)'}\n"
          f"  {DIM}{gap_end:.1f} – {total:.1f}s{RESET}  speech  “{TAIL}”\n")

    if args.keep:
        write_wav(args.keep, pcm)
        print(f"{DIM}wrote {args.keep}{RESET}")

    key = resolve_key()
    body, ctype = multipart(
        {"diarize": args.diarize, "numerals": "true", "output_formats": "json"},
        "silence-probe.wav",
        wav_bytes(pcm),  # a real WAV container, not raw PCM
    )
    status, job = request("POST", "/transcription/jobs", key, body, ctype)
    if status not in (200, 201, 202):
        sys.exit(f"{RED}submit failed {status}{RESET} {json.dumps(job)[:300]}")
    job_id = job.get("job_id") or job.get("id")
    print(f"job {job_id} → {job.get('status')}")

    t0 = time.monotonic()
    while job.get("status") in ("queued", "running", "processing"):
        time.sleep(1.5)
        status, job = request("GET", f"/transcription/jobs/{job_id}", key)
        if status != 200:
            sys.exit(f"{RED}poll failed {status}{RESET} {json.dumps(job)[:300]}")
    print(f"{job.get('status')} after {time.monotonic() - t0:.1f}s\n")

    result = job.get("result") or {}
    segments = result.get("segments") or []
    print(f"{DIM}audio_seconds={result.get('audio_seconds')}  "
          f"speakers={result.get('speakers')}  segments={len(segments)}{RESET}\n")

    # A segment counts as fabricated if the majority of its span sits inside the silent window.
    fabricated = []
    for s in segments:
        start, end = float(s.get("start", 0)), float(s.get("end", 0))
        overlap = max(0.0, min(end, gap_end) - max(start, lead_s))
        if end > start and overlap / (end - start) > 0.5:
            fabricated.append((s, overlap))
        mark = f"  {RED}← inside the silence{RESET}" if overlap / max(end - start, 1e-9) > 0.5 else ""
        print(f"  [{start:6.2f} – {end:6.2f}] {s.get('speaker', '?'):<10} "
              f"{s.get('text', '')[:70]}{mark}")

    print()
    if fabricated:
        print(f"{RED}FABRICATED: {len(fabricated)} segment(s) transcribed from digital "
              f"silence.{RESET}\nThe batch path has the same defect as the stream. Any segment "
              f"is quotable evidence\nto the citation gate, so dead air can manufacture a claim "
              f"that passes.")
    else:
        what = f"noise at RMS {args.noise:.3f}" if args.noise > 0 else "digital silence"
        print(f"{GREEN}CLEAN: no segment falls inside the gap.{RESET}\n"
              f"{DIM}Batch does not fabricate from {what}."
              + ("" if args.noise > 0 else
                 " Exact zeroes are the weak version of\nthis test — rerun with "
                 "--noise 0.035 to match what fooled the stream.") + f"{RESET}")
    print(f"\nfull text: {result.get('text', '')[:400]}")


if __name__ == "__main__":
    main()
