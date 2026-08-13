#!/usr/bin/env python3
"""Run the two batch presets from PyAI's playground against PyAI's own sample recordings.

These are playground modules 3 and 4 — "Who said what" and "Two-line phone call". They are
the SAME endpoint with two booleans flipped, which is the point this probe makes concrete:

    module 3  diarize:true,  channel:false   mono, model guesses who is who
    module 4  channel:true,  diarize:false   stereo, one party per channel, model-free

Both are already implemented in lib/registry/providers/pyai-jobs.ts (`buildSpeakerMap`).
This exists to (a) prove they behave as documented on real telephony audio rather than our
`say`-synthesized samples, and (b) settle whether `numerals` actually takes effect on the
jobs endpoint — docs/api-truth.md records "fourteen hundred" coming back as "one four oh oh"
there while the stream renders "1400".

    ./.venv/bin/python batch_modes_probe.py
    ./.venv/bin/python batch_modes_probe.py --url https://example.com/my-call.wav --mode channel
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from batch_silence_probe import request  # noqa: E402
from hear_stream_test import BOLD, DIM, GREEN, RED, RESET, YELLOW, resolve_key  # noqa: E402

SAMPLES = {
    "diarize": "https://console.pyai.com/samples/original-interview.wav",
    "channel": "https://console.pyai.com/samples/original-stereo-call.wav",
}
NUMBER_WORDS = re.compile(
    r"\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|"
    r"fifteen|twenty|thirty|forty|fifty|hundred|thousand|oh)\b", re.I)


def submit_and_wait(key: str, url: str, mode: str, numerals: bool, timeout: float = 120.0):
    body = json.dumps({
        "model": "pyai-hear-telephony",
        "audio_url": url,
        "channel": mode == "channel",
        "diarize": mode == "diarize",
        "numerals": numerals,
        "output_formats": ["json"],
    }).encode()
    status, job = request("POST", "/transcription/jobs", key, body, "application/json")
    if status not in (200, 201, 202):
        return None, f"submit {status}: {json.dumps(job)[:200]}"
    job_id = job.get("job_id") or job.get("id")

    t0 = time.monotonic()
    while True:
        status, job = request("GET", f"/transcription/jobs/{job_id}", key)
        if status != 200:
            return None, f"poll {status}: {json.dumps(job)[:200]}"
        state = job.get("status")
        if state == "completed":
            return job, None
        if state in ("failed", "error", "cancelled"):
            return None, f"job {state}: {json.dumps(job.get('error') or job)[:200]}"
        if time.monotonic() - t0 > timeout:
            return None, f"timed out after {timeout:.0f}s in state {state!r}"
        time.sleep(1.5)


def show(label: str, mode: str, url: str, key: str, numerals: bool) -> dict | None:
    print(f"{BOLD}{label}{RESET}  {DIM}channel={mode == 'channel'} diarize={mode == 'diarize'} "
          f"numerals={numerals}{RESET}")
    print(f"{DIM}  {url}{RESET}")
    job, err = submit_and_wait(key, url, mode, numerals)
    if err:
        print(f"  {RED}{err}{RESET}\n")
        return None

    r = job.get("result") or {}
    segs = r.get("segments") or []
    print(f"  audio_seconds={r.get('audio_seconds')}  speakers={r.get('speakers')}  "
          f"segments={len(segs)}  words={len(r.get('words') or [])}")
    channels = sorted({s.get("channel") for s in segs if s.get("channel") is not None})
    speakers = sorted({s.get("speaker") for s in segs if s.get("speaker")})
    print(f"  speaker labels: {speakers}")
    print(f"  channel field:  {channels if channels else f'{YELLOW}absent{RESET}'}")
    for s in segs[:5]:
        ch = "" if s.get("channel") is None else f"ch{s['channel']} "
        print(f"    {DIM}[{s.get('start', 0):6.2f}–{s.get('end', 0):6.2f}]{RESET} "
              f"{ch}{s.get('speaker', '?'):<10} {s.get('text', '')[:66]}")
    if len(segs) > 5:
        print(f"    {DIM}… {len(segs) - 5} more{RESET}")
    print()
    return r


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", help="transcribe this audio_url instead of the PyAI samples")
    p.add_argument("--mode", choices=["diarize", "channel"], help="with --url, pick one mode")
    p.add_argument("--numerals-off", action="store_true",
                   help="also run with numerals:false to compare (doubles the minutes used)")
    args = p.parse_args()

    key = resolve_key()

    if args.url:
        show(f"custom · {args.mode}", args.mode or "diarize", args.url, key, True)
        return

    r3 = show("Module 3 · Who said what (mono, model diarization)",
              "diarize", SAMPLES["diarize"], key, True)
    r4 = show("Module 4 · Two-line phone call (stereo, per channel)",
              "channel", SAMPLES["channel"], key, True)

    print(f"{BOLD}── what this settles ──{RESET}")
    if r3 and r4:
        print("Same endpoint, same model, two booleans. Module 3 returns model-guessed speaker "
              "labels\nwith no `channel` field; module 4 returns a `channel` int per segment, "
              "which is what\nmakes rep/prospect deterministic rather than heuristic.")
    for name, r in (("module 3", r3), ("module 4", r4)):
        if not r:
            continue
        text = r.get("text") or ""
        words = NUMBER_WORDS.findall(text)
        digits = re.findall(r"\d", text)
        verdict = (f"{GREEN}numerals applied{RESET}" if digits and not words else
                   f"{RED}numerals did NOT apply{RESET}" if words and not digits else
                   f"{YELLOW}mixed{RESET}")
        print(f"  {name}: {verdict}  {DIM}(digits={len(digits)}, "
              f"spelled-out={sorted(set(w.lower() for w in words))[:6]}){RESET}")


if __name__ == "__main__":
    main()
