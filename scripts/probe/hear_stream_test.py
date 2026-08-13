#!/usr/bin/env python3
"""
hear_stream_test.py — feed a *transcript* to PyAI Hear's streaming STT and watch it work.

The problem this solves: Hear streaming eats PCM16 audio, not text. So to "test it with a
transcript" we synthesize the transcript to 16 kHz PCM16 with macOS `say` (Speak was 503 all
of H0 — see docs/api-truth.md), stream it over the WebSocket at real-time pace, and print
every partial/final frame as it lands. Because we know what was *said*, we can score what
Hear *heard*: word error rate, first-partial latency, finalization lag.

    # 1. See the frame shape instantly, no network, no key:
    ./.venv/bin/python hear_stream_test.py sample-call.txt --mock

    # 2. Real API end to end:
    ./.venv/bin/python hear_stream_test.py sample-call.txt

    # 3. Already have audio? Skip synthesis:
    ./.venv/bin/python hear_stream_test.py --audio call.wav --reference sample-call.txt

    # 4. Your own voice, live. Ctrl-C to stop (the tail still flushes):
    ./.venv/bin/python hear_stream_test.py --mic
    ./.venv/bin/python hear_stream_test.py --mic sample-call.txt   # read it aloud, get scored
    ./.venv/bin/python hear_stream_test.py --list-devices          # pick a headset with --device

Transcript format: plain prose, or one turn per line as "speaker: text". Labelled speakers
get different `say` voices so diarization has something to separate.

Setup:  python3 -m venv .venv && ./.venv/bin/pip install websockets

── Verified stream protocol (probed live, Thu 13 Aug 2026; model reports `hear-realtime-1`) ──

    {"type":"session.created","model":"hear-realtime-1","session_id":"…"}
    {"type":"transcript.partial","text":"…","stable_text":"…","active_text":"…",
     "utterance_id":"…","revision_id":7,"t_ms":5485,"session_id":"…"}
    {"type":"turn.end","confidence":0.999998,"endpoint_reason":"silence","backchannel_prob":0.0,
     "time_to_end_ms":-21141.8,"utterance_id":"…","t_ms":4380,"session_id":"…"}
    {"type":"usage.delta","active_audio_seconds":29.7,"billed_micros":1485.0,"session_id":"…"}
    {"type":"transcript.final","text":"…","raw_text":"…","audio_ms":4400,
     "endpoint_reason":"silence","utterance_id":"…","t_ms":4822,"session_id":"…"}

`t_ms` is the server's audio-stream clock; on a final it is when the text was produced, and
`audio_ms` is that utterance's *duration*, not its end offset. The honest latency number is
`final.t_ms - turn.end.t_ms` — endpoint detected to text delivered, ~440ms in our runs.

Six things the docs snippet does not tell you, all of which bite:

1. `msg["type"]` is `transcript.partial` / `transcript.final`, NOT `partial` / `final`. The
   published example's `if msg["type"] == "partial"` never fires.
2. **Only trailing silence flushes the last utterance.** Hear endpoints on ~1.8s of silence.
   Closing the socket drops the tail, and every plausible control frame — `eos`, `flush`,
   `input_audio.commit`, `transcript.finalize`, `session.close` — is rejected with
   `unknown_message_type`. (`{"type":"end"}` is *accepted* but flushes nothing.) So we pad
   silence; see --tail-silence-ms. Without it you silently lose the end of every call.
3. **`partial.text` is a rolling window, not the utterance so far** — leading words fall off
   as it grows. Append partials and you get a mangled transcript. `stable_text` (settled) +
   `active_text` (still moving) is the pair to render; `transcript.final` is the record.
4. Utterances are force-finalized at ~30s regardless of silence, and short inter-turn gaps do
   NOT split them — so turn-level segments need --gap-ms above the endpoint threshold.
5. **`utterance_id` is not a join key.** For one spoken turn, the partials, the `turn.end`, and
   the `transcript.final` each carry a *different* utterance_id. Pair them by arrival order,
   not by id — anything keyed on the id will silently never match.
6. There is a separate `turn.end` frame with `endpoint_reason` (`silence` / `peak_te_early`),
   `confidence`, and `backchannel_prob` — the turn-taking signal you want for barge-in, and it
   lands ~440ms *before* the text. Undocumented in the snippet; easy to miss entirely.
7. **Hear fabricates fluent text from silence and room ambience** — confirmed repeatedly on a
   live mic with nobody speaking, at `confidence` 0.99+. Dead air on a real call will produce
   quotable "evidence" nobody said. Mic mode measures input RMS and flags any final whose
   window never reached speech level (--silence-floor); do the equivalent in production.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import ssl
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2
BASE = os.environ.get("PYAI_BASE_URL", "https://api.pyai.com/v1")
WS_BASE = BASE.replace("https://", "wss://").replace("http://", "ws://")
HERE = Path(__file__).resolve().parent

# Two clearly different US voices, matching lib/registry/providers/macos-say.ts.
VOICES = ["Alex", "Samantha", "Daniel", "Karen"]

DIM, BOLD, GREEN, YELLOW, RED, RESET = (
    ("\033[2m", "\033[1m", "\033[32m", "\033[33m", "\033[31m", "\033[0m")
    if sys.stdout.isatty()
    else ("", "", "", "", "", "")
)


# ---------------------------------------------------------------- transcript

def parse_transcript(path: Path) -> list[tuple[str | None, str]]:
    """-> [(speaker_or_None, text)]. Blank lines separate turns in prose mode."""
    turns: list[tuple[str | None, str]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # "rep: hello" / "Speaker 1 - hello" / "[00:12] rep: hello"
        line = re.sub(r"^\[?\d{1,2}:\d{2}(:\d{2})?\]?\s*", "", line)
        m = re.match(r"^([A-Za-z][\w .'-]{0,30}?)\s*[:\-–]\s+(.*)$", line)
        if m and len(m.group(2)) > 1:
            turns.append((m.group(1).strip(), m.group(2).strip()))
        else:
            turns.append((None, line))
    return turns


def normalize(text: str) -> list[str]:
    """Casing- and punctuation-insensitive word list. WER is about words, not formatting."""
    text = text.lower().replace("’", "'")
    text = re.sub(r"[^a-z0-9' ]+", " ", text)
    return text.split()


def wer(ref: list[str], hyp: list[str]) -> tuple[float, int, int, int]:
    """Levenshtein over words -> (rate, substitutions, deletions, insertions)."""
    n, m = len(ref), len(hyp)
    if n == 0:
        return (0.0 if m == 0 else 1.0), 0, 0, m
    # (cost, sub, del, ins) per cell; one row at a time.
    prev = [(j, 0, 0, j) for j in range(m + 1)]
    for i in range(1, n + 1):
        cur = [(i, 0, i, 0)] + [(0, 0, 0, 0)] * m
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                cur[j] = prev[j - 1]
                continue
            sub, dele, ins = prev[j - 1], prev[j], cur[j - 1]
            best = min(sub[0], dele[0], ins[0]) + 1
            if sub[0] <= dele[0] and sub[0] <= ins[0]:
                cur[j] = (best, sub[1] + 1, sub[2], sub[3])
            elif dele[0] <= ins[0]:
                cur[j] = (best, dele[1], dele[2] + 1, dele[3])
            else:
                cur[j] = (best, ins[1], ins[2], ins[3] + 1)
        prev = cur
    cost, s, d, i_ = prev[m]
    return cost / n, s, d, i_


# ---------------------------------------------------------------- audio

def sniff_format(data: bytes) -> tuple[str, str] | None:
    """Identify audio by CONTENT, not extension -> (true extension, mime). None if unrecognised.

    Necessary because files lie. A real recording handed to this probe was named `recording.mp3`
    and was in fact `RIFF … WAVE, Microsoft PCM, 16 bit, stereo 8000 Hz`. macOS trusts the
    extension, picks the MP3 parser and fails with `Couldn't open input file ('dta?')`, and any
    Content-Type derived from the name is a lie told to the server.
    """
    if len(data) < 12:
        return None
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return ".wav", "audio/wav"
    if data[:4] == b"fLaC":
        return ".flac", "audio/flac"
    if data[:4] == b"OggS":
        return ".ogg", "audio/ogg"
    if data[:4] == b"FORM" and data[8:12] in (b"AIFF", b"AIFC"):
        return ".aiff", "audio/aiff"
    if data[4:8] == b"ftyp":
        return ".m4a", "audio/mp4"
    if data[:3] == b"ID3":
        return ".mp3", "audio/mpeg"
    # Bare MPEG frame sync: 11 set bits.
    if data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return ".mp3", "audio/mpeg"
    return None


def load_audio(path: Path) -> bytes:
    """Any audio file -> 16kHz mono PCM16, decoding with macOS `afconvert` when needed.

    The WebSocket only accepts raw PCM, so unlike the batch jobs endpoint (which decodes mp3 and
    friends server-side) streaming has to decode locally. `afconvert` ships with macOS and handles
    mp3/m4a/aac/flac/ogg — no ffmpeg, which this machine does not have.

    Note macOS can DECODE mp3 but not encode it: `afconvert -f MPG3` fails with `fmt?` on every
    input and sample rate tried. So this converts one way only.
    """
    raw = path.read_bytes()
    sniffed = sniff_format(raw)
    if sniffed and sniffed[0] != path.suffix.lower():
        print(f"{YELLOW}{path.name} is really a {sniffed[0]} file, not {path.suffix or '(none)'}"
              f"{RESET} {DIM}— going by content{RESET}", file=sys.stderr)

    true_ext = sniffed[0] if sniffed else path.suffix.lower()

    if true_ext == ".wav":
        try:
            with wave.open(str(path), "rb") as w:
                if (w.getframerate() == SAMPLE_RATE and w.getsampwidth() == BYTES_PER_SAMPLE
                        and w.getnchannels() == 1):
                    return read_wav(path)  # already exactly what we need
        except wave.Error:
            pass  # compressed payload in a WAV container; let afconvert handle it

    if sys.platform != "darwin":
        sys.exit(f"{path.name} needs decoding to 16kHz mono PCM16 and `afconvert` is macOS-only.")

    work = Path(tempfile.mkdtemp(prefix="hear-decode-"))
    # afconvert dispatches on the EXTENSION, so a mislabelled file has to be given its real one or
    # it fails with 'dta?'. Copy rather than rename so the user's file is never touched.
    src = work / f"input{true_ext}"
    src.write_bytes(raw)
    out = work / "decoded.wav"
    proc = subprocess.run(
        ["afconvert", "-f", "WAVE", "-d", f"LEI16@{SAMPLE_RATE}", "-c", "1", str(src), str(out)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not out.exists():
        sys.exit(f"could not decode {path.name} (detected {true_ext or 'unknown'}):\n"
                 f"  {(proc.stderr or proc.stdout).strip()[:300]}")
    print(f"{DIM}decoded {path.name} ({true_ext}) → 16kHz mono PCM16{RESET}", file=sys.stderr)
    return read_wav(out)


def read_wav(path: Path) -> bytes:
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != BYTES_PER_SAMPLE:
            sys.exit(f"{path}: need 16-bit PCM, got {w.getsampwidth() * 8}-bit.")
        if w.getframerate() != SAMPLE_RATE:
            sys.exit(
                f"{path}: need {SAMPLE_RATE} Hz, got {w.getframerate()} Hz. "
                f"Convert with: afconvert -f WAVE -d LEI16@16000 -c 1 in.wav out.wav"
            )
        pcm = w.readframes(w.getnframes())
        if w.getnchannels() == 2:  # mono mixdown, so one stream == one conversation
            pcm = mixdown(pcm)
        return pcm


def mixdown(stereo: bytes) -> bytes:
    out = bytearray(len(stereo) // 2)
    for i in range(0, len(stereo) - 3, 4):
        left = int.from_bytes(stereo[i : i + 2], "little", signed=True)
        right = int.from_bytes(stereo[i + 2 : i + 4], "little", signed=True)
        mixed = max(-32768, min(32767, (left + right) // 2))
        out[i // 2 : i // 2 + 2] = mixed.to_bytes(2, "little", signed=True)
    return bytes(out)


def rms(pcm: bytes) -> float:
    """Rough loudness of a PCM16 block, 0..1. Cheap enough to run on every mic callback."""
    if not pcm:
        return 0.0
    total, n = 0, len(pcm) // 2
    for i in range(0, n * 2, 2):  # every 8th sample is plenty for a meter
        if i % 16 == 0:
            s = int.from_bytes(pcm[i : i + 2], "little", signed=True)
            total += s * s
    count = max(1, n // 8)
    return (total / count) ** 0.5 / 32768


async def mic_chunks(args: argparse.Namespace, col: Collector):
    """Yield PCM16 blocks from the default input device, live.

    sounddevice's wheel bundles PortAudio, so this needs no Homebrew (there is none on this
    machine — see docs/api-truth.md). The callback runs on PortAudio's own thread, so it hands
    blocks to the event loop through a threadsafe queue.
    """
    try:
        import sounddevice as sd
    except ImportError:
        sys.exit("Mic capture needs sounddevice:  ./.venv/bin/pip install sounddevice")

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=64)
    block = args.chunk_ms * SAMPLE_RATE // 1000

    def offer(item: bytes) -> None:
        """Drop audio rather than raise if the uplink falls behind — never block PortAudio."""
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:
            pass

    def callback(indata, _frames, _time, status) -> None:
        if status:  # overflow/underflow — worth seeing, it means dropped audio
            loop.call_soon_threadsafe(print, f"\r{YELLOW}mic: {status}{RESET}")
        loop.call_soon_threadsafe(offer, bytes(indata))

    dev = sd.query_devices(args.device, "input") if args.device is not None else \
        sd.query_devices(kind="input")
    print(f"{BOLD}mic{RESET} {dev['name']}  {DIM}capturing {SAMPLE_RATE}Hz mono PCM16{RESET}")
    if args.seconds:
        print(f"{DIM}recording for {args.seconds}s…{RESET}\n")
    else:
        print(f"{DIM}speak now — Ctrl-C when you're done{RESET}\n")

    stream = sd.RawInputStream(
        samplerate=SAMPLE_RATE, blocksize=block, device=args.device,
        channels=1, dtype="int16", callback=callback,
    )
    started = time.monotonic()
    with stream:
        while True:
            if args.seconds and time.monotonic() - started >= args.seconds:
                return
            try:
                chunk = await asyncio.wait_for(queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            if chunk is None:
                return
            col.set_level(rms(chunk))
            if args.save_audio:
                col.captured += chunk
            yield chunk


async def file_chunks(pcm: bytes, args: argparse.Namespace, t0: float):
    """Yield a fixed buffer paced to wall clock, so latency numbers mean something."""
    chunk = args.chunk_ms * SAMPLE_RATE // 1000 * BYTES_PER_SAMPLE
    for off in range(0, len(pcm), chunk):
        yield pcm[off : off + chunk]
        if args.speed > 0:
            target = (off + chunk) / (SAMPLE_RATE * BYTES_PER_SAMPLE) / args.speed
            await asyncio.sleep(max(0.0, target - (time.monotonic() - t0)))


def synthesize(turns: list[tuple[str | None, str]], gap_ms: int) -> bytes:
    """macOS `say` per turn -> concatenated PCM16. Distinct voice per speaker label."""
    if sys.platform != "darwin":
        sys.exit("Synthesis needs macOS `say`. Pass --audio <wav> instead.")
    speakers: dict[str, str] = {}
    silence = b"\x00" * (gap_ms * SAMPLE_RATE // 1000 * BYTES_PER_SAMPLE)
    pcm = bytearray()
    with tempfile.TemporaryDirectory(prefix="hear-say-") as tmp:
        txt, out = Path(tmp) / "turn.txt", Path(tmp) / "turn.wav"
        for idx, (speaker, text) in enumerate(turns):
            key = speaker or "_"
            if key not in speakers:
                speakers[key] = VOICES[len(speakers) % len(VOICES)]
            txt.write_text(text, encoding="utf-8")
            subprocess.run(
                ["say", "-v", speakers[key], "-f", str(txt), "-o", str(out),
                 f"--data-format=LEI16@{SAMPLE_RATE}", "--file-format=WAVE"],
                check=True, capture_output=True,
            )
            pcm += read_wav(out)
            if idx < len(turns) - 1:
                pcm += silence
            print(f"  {DIM}say[{speakers[key]}]{RESET} {text[:64]}", file=sys.stderr)
    return bytes(pcm)


# ---------------------------------------------------------------- key

def resolve_key() -> str:
    """env var -> the app's cached .pyai-key.json -> mint a fresh unauthenticated sandbox key."""
    if os.environ.get("PYAI_API_KEY"):
        return os.environ["PYAI_API_KEY"]
    for cache in (HERE / "sandbox-key.json", HERE.parents[1] / ".pyai-key.json"):
        if cache.exists():
            try:
                k = json.loads(cache.read_text())
                if k.get("api_key") and k.get("expires_at", 0) > time.time() * 1000 + 60_000:
                    print(f"{DIM}key: cached {cache.name}{RESET}", file=sys.stderr)
                    return k["api_key"]
            except (ValueError, KeyError):
                pass
    import urllib.request

    req = urllib.request.Request(
        f"{BASE}/sandbox/keys",
        data=json.dumps({"label": "hear-stream-test"}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, context=ssl_context()) as r:
        key = json.load(r)
    (HERE / "sandbox-key.json").write_text(json.dumps(key, indent=2))
    print(f"{DIM}key: minted, scopes={' '.join(key.get('scopes', []))}{RESET}", file=sys.stderr)
    return key["api_key"]


def ssl_context() -> ssl.SSLContext:
    """python.org 3.14 ships no CA bundle (docs/api-truth.md); fall back to the system one."""
    ctx = ssl.create_default_context()
    if not (ctx.cert_store_stats()["x509_ca"]):
        for bundle in ("/etc/ssl/cert.pem", os.environ.get("SSL_CERT_FILE", "")):
            if bundle and Path(bundle).exists():
                ctx.load_verify_locations(bundle)
                break
    return ctx


# ---------------------------------------------------------------- frames

def frame_text(msg: dict) -> str | None:
    """Hear's field names for stream frames aren't pinned in api-truth.md yet, so look around."""
    for key in ("text", "transcript", "delta"):
        if isinstance(msg.get(key), str):
            return msg[key]
    for container in ("alternatives", "channel", "result", "segment", "utterance"):
        inner = msg.get(container)
        if isinstance(inner, list) and inner and isinstance(inner[0], dict):
            return frame_text(inner[0])
        if isinstance(inner, dict):
            return frame_text(inner)
    return None


def frame_kind(msg: dict) -> str:
    """-> 'partial' | 'final' | 'usage' | 'session' | 'error' | 'done' | 'other'."""
    t = str(msg.get("type") or msg.get("event") or "").lower()
    if "error" in t:
        return "error"
    if t.startswith("usage"):
        return "usage"
    if t.startswith("session.created") or t == "config_ack":
        return "session"
    if t.startswith("turn."):
        return "turn"
    if t in ("done", "close", "completed", "closed"):
        return "done"
    if "partial" in t or "interim" in t or "delta" in t:
        return "partial"
    if "final" in t or "transcript" in t or "utterance" in t or "segment" in t:
        return "final"
    if msg.get("is_final") is True or msg.get("final") is True:
        return "final"
    if msg.get("is_final") is False or msg.get("partial") is True:
        return "partial"
    return "other"


class Collector:
    """Prints the live stream and keeps enough state to score it afterwards."""

    def __init__(self, t0: float, show_raw: bool, silence_floor: float = 0.02):
        self.t0, self.show_raw, self.silence_floor = t0, show_raw, silence_floor
        self.finals: list[dict] = []
        self.first_partial_ms: float | None = None
        self.partial_count = 0
        self.errors: list[str] = []
        self.unknown: list[dict] = []
        self.session: dict = {}
        self.usage: dict = {}
        self.turn_ends: list[dict] = []
        self.utterances: set[str] = set()
        self.windowed = 0  # partials that dropped leading words instead of only appending
        self.level: float | None = None
        self.peak = 0.0
        self.window_peak = 0.0  # loudest input since the last final — catches hallucinations
        self.captured = bytearray()  # only filled when --save-audio is on
        self.duplicate_finals = 0  # speech_final followed by an identical final
        self._prev_partial = ""
        self._partial_line = ""
        self._line_open = False

    def ms(self) -> float:
        return (time.monotonic() - self.t0) * 1000

    def _clear(self) -> None:
        if self._line_open:
            print("\r\033[K", end="")
            self._line_open = False

    def set_level(self, rms: float) -> None:
        """Mic input level, 0..1. Redraws the status line so a dead mic is obvious at a glance."""
        self.level = rms
        self.peak = max(self.peak, rms)
        self.window_peak = max(self.window_peak, rms)
        if not self.show_raw:
            self._render()

    def _render(self) -> None:
        """One status line shared by the level meter and the live partial."""
        meter = ""
        if self.level is not None:
            filled = min(8, int(self.level * 40))  # speech sits around 0.05-0.3 RMS
            bar = "▁▂▃▄▅▆▇█"[:filled].ljust(8, " ")
            colour = GREEN if filled >= 2 else DIM
            meter = f"{colour}[{bar}]{RESET} "
        print(f"\r\033[K{meter}{DIM}…{RESET} {self._partial_line}", end="", flush=True)
        self._line_open = True

    def handle(self, msg: dict) -> bool:
        """-> False when the server says it's done."""
        if self.show_raw:
            self._clear()
            print(f"{DIM}<< {json.dumps(msg)[:300]}{RESET}")
        kind, text = frame_kind(msg), frame_text(msg)
        at = self.ms()

        if kind == "error":
            self._clear()
            self.errors.append(json.dumps(msg.get("error", msg)))
            print(f"{RED}error{RESET} {self.errors[-1][:200]}")
            return True
        if kind == "done":
            self._clear()
            print(f"{DIM}[{at:7.0f}ms] server closed the stream{RESET}")
            return False
        if kind == "session":
            self.session = {**self.session, **msg}
            self._clear()
            detail = f"model={msg.get('model')}" if msg.get("model") else \
                f"endpointing_ms={msg.get('endpointing_ms')}"
            print(f"{DIM}{msg.get('type')} {msg.get('session_id', '')} {detail}{RESET}")
            return True
        if kind == "usage":
            # Cumulative, not additive, despite the name — keep the latest.
            self.usage = msg
            return True
        if kind == "turn":
            # Endpoint detected. The text for this turn is still ~440ms away.
            self.turn_ends.append(msg)
            self._clear()
            print(f"{DIM}[{at:7.0f}ms] turn.end  reason={msg.get('endpoint_reason')} "
                  f"conf={msg.get('confidence', 0):.3f} "
                  f"backchannel={msg.get('backchannel_prob', 0):.2f}{RESET}")
            return True
        if kind == "partial" and text:
            self.partial_count += 1
            if self.first_partial_ms is None:
                self.first_partial_ms = at
            if self._prev_partial and not text.startswith(self._prev_partial[:20]):
                self.windowed += 1
            self._prev_partial = text
            if uid := msg.get("utterance_id"):
                self.utterances.add(uid)
            if not self.show_raw:
                # Render the way a real UI should: settled text plain, moving tail dimmed.
                stable, active = msg.get("stable_text"), msg.get("active_text")
                self._partial_line = (
                    f"{stable[-90:]} {DIM}{active}{RESET}"
                    if isinstance(stable, str) and isinstance(active, str)
                    else text[-110:]
                )
                self._render()
            return True
        if kind == "final" and text:
            # On pyai-hear-v1, `final` follows `speech_final` for the same utterance. Counting
            # both would duplicate every line and double the word count in the WER score.
            if self.finals and self.finals[-1]["text"].strip() == text.strip():
                if self.show_raw:
                    print(f"{DIM}   (duplicate final for same utterance — ignored){RESET}")
                self.duplicate_finals += 1
                return True
            self._clear()
            # Pair with the turn.end by arrival order — utterance_id does NOT match across
            # frame types (see module docstring) — to get endpoint-detected -> text-delivered.
            lag_ms = None
            idx = len(self.finals)
            if idx < len(self.turn_ends):
                t_end, t_fin = self.turn_ends[idx].get("t_ms"), msg.get("t_ms")
                if isinstance(t_end, (int, float)) and isinstance(t_fin, (int, float)):
                    lag_ms = t_fin - t_end
            lag = f"+{lag_ms:.0f}ms after endpoint" if lag_ms is not None else ""
            spk = msg.get("speaker") or msg.get("channel")
            tag = f" {YELLOW}[{spk}]{RESET}" if spk is not None else ""
            # Hear invents fluent text from silence. If nothing loud enough to be speech
            # reached the mic since the last final, this "transcript" is fabricated.
            suspect = self.level is not None and self.window_peak < self.silence_floor
            mark = f" {RED}⚠ no speech-level input (peak {self.window_peak:.3f}){RESET}" if suspect else ""
            print(f"{GREEN}[{at:7.0f}ms]{RESET}{tag} {text}  {DIM}{lag}{RESET}{mark}")
            self.finals.append({"at_ms": at, "text": text, "lag_ms": lag_ms,
                                "suspect": suspect, "raw": msg})
            self.window_peak = 0.0
            self._prev_partial = ""
            self._partial_line = ""
            return True

        self.unknown.append(msg)
        return True


# ---------------------------------------------------------------- live run

async def run_live(pcm: bytes, args: argparse.Namespace) -> Collector:
    import websockets

    params = {
        "model": args.model,
        "sample_rate": str(SAMPLE_RATE),
        "encoding": "pcm16",
        "language": args.language,
        "numerals": "true",  # "fourteen hundred" -> "1400"; see docs/api-truth.md
    }
    if args.interim:
        params["interim_results"] = "true"
    if args.protocol:
        # Selects the published frame names. Omitting it appears to fall back to a legacy
        # route with `transcript.*` frames — the whole point of this flag is to prove that.
        params["protocol"] = args.protocol
    if args.endpointing_ms:
        params["endpointing_ms"] = str(args.endpointing_ms)
    url = f"{WS_BASE}/audio/transcriptions/stream?" + "&".join(
        f"{k}={v}" for k, v in params.items()
    )
    key = resolve_key()

    chunk = args.chunk_ms * SAMPLE_RATE // 1000 * BYTES_PER_SAMPLE
    if args.mic:
        print(f"{BOLD}live mic{RESET} → {DIM}{url.split('?')[0]}{RESET}\n")
    else:
        audio_s = len(pcm) / (SAMPLE_RATE * BYTES_PER_SAMPLE)
        print(
            f"{BOLD}streaming{RESET} {audio_s:.1f}s of audio in {args.chunk_ms}ms chunks "
            f"at {args.speed}x {DIM}(+{args.tail_silence_ms}ms tail silence to flush){RESET}\n"
            f"{DIM}{url.split('?')[0]}{RESET}\n"
        )

    # The docs put the key in the query string; a Bearer header is the safer default and
    # keeps the secret out of URLs/logs. Send both — whichever the gateway reads, it works.
    try:
        ws = await websockets.connect(
            f"{url}&api_key={key}",
            additional_headers={"Authorization": f"Bearer {key}"},
            ssl=ssl_context(),
            max_size=None,
            open_timeout=20,
        )
    except Exception as exc:  # noqa: BLE001 — surface the handshake failure verbatim
        detail = f"{type(exc).__name__}: {exc}"
        # A rejected upgrade carries no JSON body, so the status code is all there is to go on.
        if "429" in str(exc):
            detail += (f"\n{DIM}  429 at the handshake is almost always the daily cap — the same "
                       f"quota the REST\n  endpoints report as `daily_cap_exceeded`, which resets "
                       f"at 00:00 UTC. Nothing to do\n  with your audio. Set PYAI_API_KEY to another "
                       f"key, or wait for the reset.{RESET}")
        elif "401" in str(exc) or "403" in str(exc):
            detail += f"\n{DIM}  Key rejected — check PYAI_API_KEY or .pyai-key.json.{RESET}"
        sys.exit(f"{RED}WebSocket handshake failed:{RESET} {detail}")

    t0 = time.monotonic()
    col = Collector(t0, args.raw, args.silence_floor)

    async def receive() -> None:
        try:
            async for frame in ws:
                if isinstance(frame, bytes):
                    continue
                try:
                    msg = json.loads(frame)
                except ValueError:
                    print(f"{DIM}<< non-JSON: {frame[:120]}{RESET}")
                    continue
                if not col.handle(msg):
                    return
        except Exception as exc:  # noqa: BLE001
            col._clear()
            print(f"{DIM}receive ended: {type(exc).__name__}: {exc}{RESET}")

    source = mic_chunks(args, col) if args.mic else file_chunks(pcm, args, t0)

    async def send() -> None:
        try:
            async for block in source:
                await ws.send(block)
        except asyncio.CancelledError:
            pass  # Ctrl-C — fall through and still flush the tail below
        # Trailing silence is the ONLY thing that flushes the last utterance (see docstring).
        col._clear()
        print(f"{DIM}flushing with {args.tail_silence_ms}ms of silence…{RESET}")
        silence = b"\x00" * chunk
        for _ in range(max(1, args.tail_silence_ms // args.chunk_ms)):
            await ws.send(silence)
            await asyncio.sleep(args.chunk_ms / 1000)
        if args.eos:
            # Accepted but flushes nothing — sent only so the server sees a clean end.
            try:
                await ws.send(json.dumps({"type": args.eos}))
            except Exception:  # noqa: BLE001
                pass

    recv_task = asyncio.create_task(receive())
    send_task = asyncio.create_task(send())
    try:
        await send_task
    except (KeyboardInterrupt, asyncio.CancelledError):
        # Ctrl-C during mic capture: stop capturing, but let send() finish its flush so the
        # last thing you said still comes back.
        send_task.cancel()
        try:
            await send_task
        except asyncio.CancelledError:
            pass
    col._clear()
    print(f"{DIM}audio sent; draining finals for up to {args.drain}s…{RESET}")
    try:
        await asyncio.wait_for(recv_task, timeout=args.drain)
    except asyncio.TimeoutError:
        recv_task.cancel()
    finally:
        await ws.close()
    col._clear()
    return col


# ---------------------------------------------------------------- mock run

async def run_mock(turns: list[tuple[str | None, str]], args: argparse.Namespace) -> Collector:
    """No network. Replays the transcript as the frames Hear would emit, including its quirks."""
    print(
        f"{BOLD}mock{RESET} — synthetic frames, no API call. Reproduces Hear's documented\n"
        f"{DIM}behaviour: lowercase, unpunctuated, partials that grow then get replaced by a "
        f"final.{RESET}\n"
    )
    col = Collector(time.monotonic(), args.raw)
    col.handle({"type": "session.created", "model": "hear-realtime-1 (mock)",
                "session_id": "mock000000000000"})
    wps, clock, WINDOW = 2.6, 0.0, 16  # ~155 wpm; partials window to ~16 words like the real API
    tick = 1 / wps / max(args.speed, 0.01)
    for idx, (speaker, text) in enumerate(turns):
        words = normalize(text)  # lowercase + unpunctuated, exactly as Hear returns it
        start = clock
        for i in range(1, len(words)):
            clock += tick
            await asyncio.sleep(tick)
            win = words[max(0, i - WINDOW) : i]  # rolling window, NOT the utterance so far
            col.handle({
                "type": "transcript.partial",
                "text": " ".join(win),
                "stable_text": " ".join(win[:-3]),
                "active_text": " ".join(win[-3:]),
                "utterance_id": f"part_{idx:03d}",
                "revision_id": i,
                "t_ms": round(clock * 1000),
            })
        clock += tick
        col.handle({
            "type": "turn.end", "confidence": 0.999, "endpoint_reason": "silence",
            "backchannel_prob": 0.0, "utterance_id": f"turn_{idx:03d}",
            "t_ms": round(clock * 1000),
        })
        clock += 0.44  # measured endpoint -> text latency
        await asyncio.sleep(min(0.44 / max(args.speed, 0.01), 0.44))
        col.handle({
            "type": "transcript.final",
            "utterance_id": f"final_{idx:03d}",  # deliberately unlike the turn.end id
            "text": " ".join(words),
            "raw_text": " ".join(words),
            "speaker": speaker or f"speaker_{idx % 2 + 1}",
            "endpoint_reason": "silence",
            "audio_ms": round((clock - start) * 1000),
            "t_ms": round(clock * 1000),
        })
    return col


# ---------------------------------------------------------------- report

def report(col: Collector, reference: list[tuple[str | None, str]] | None) -> None:
    print(f"\n{BOLD}── result ──{RESET}")
    heard = " ".join(f["text"].strip() for f in col.finals)
    suspects = [f for f in col.finals if f.get("suspect")]
    if suspects:
        print(f"{RED}{len(suspects)} of {len(col.finals)} finals arrived with no speech-level "
              f"input{RESET} — Hear fabricates fluent text from silence and ambient noise.\n"
              f"{DIM}Gate on input level before trusting a segment; dead air on a real call will\n"
              f"otherwise produce quotable 'evidence' that nobody said.{RESET}\n")
    if col.level is not None and col.peak < 0.01:
        print(f"{RED}Mic captured near-silence{RESET} (peak RMS {col.peak:.4f}). Hear got nothing "
              f"to transcribe.\n{DIM}Most likely the terminal lacks mic permission: System "
              f"Settings → Privacy & Security → Microphone.\nCheck --list-devices if you meant to "
              f"use a headset or interface.{RESET}")
    if not heard:
        print(f"{RED}No final transcript frames arrived.{RESET}")
        if col.unknown:
            print(f"{YELLOW}{len(col.unknown)} unrecognised frame(s); first one:{RESET}")
            print(f"  {json.dumps(col.unknown[0])[:400]}")
            print(f"{DIM}Re-run with --raw to see every frame, then teach frame_text()/"
                  f"frame_kind() the real field names.{RESET}")
        if col.errors:
            print(f"{RED}errors:{RESET} " + "; ".join(col.errors[:3]))
        return

    print(f"\n{heard}\n")
    print(f"finals            {len(col.finals)}"
          + (f"  {DIM}({len(col.utterances)} utterance ids seen in partials){RESET}"
             if col.utterances else ""))
    print(f"partials          {col.partial_count}")
    fp = col.first_partial_ms
    print(f"first partial     {f'{fp:.0f}ms' if fp is not None else '—'}")
    if col.finals:
        print(f"last final at     {col.finals[-1]['at_ms']:.0f}ms")
    lags = [f["lag_ms"] for f in col.finals if f.get("lag_ms") is not None]
    if lags:
        print(f"endpoint → text   {sum(lags) / len(lags):.0f}ms mean "
              f"{DIM}(min {min(lags):.0f}, max {max(lags):.0f}){RESET}")
    if col.turn_ends:
        reasons: dict[str, int] = {}
        for te in col.turn_ends:
            r = str(te.get("endpoint_reason", "?"))
            reasons[r] = reasons.get(r, 0) + 1
        print(f"turn.end          {len(col.turn_ends)}  "
              + " ".join(f"{k}={v}" for k, v in sorted(reasons.items())))
    if col.usage:
        secs = col.usage.get("active_audio_seconds")
        micros = col.usage.get("billed_micros")
        print(f"billed            {secs}s active audio"
              + (f", {micros:.0f} micros (${micros / 1e6:.4f})"
                 if isinstance(micros, (int, float)) else ""))
    if col.windowed:
        print(f"\n{YELLOW}partials are windowed{RESET} — {col.windowed} of {col.partial_count} "
              f"dropped leading words rather than only appending.\n"
              f"{DIM}Never accumulate partial.text; render stable_text + active_text and treat\n"
              f"transcript.final as the record.{RESET}")

    if reference:
        ref = normalize(" ".join(t for _, t in reference))
        hyp = normalize(heard)
        rate, s, d, i_ = wer(ref, hyp)
        colour = GREEN if rate < 0.10 else YELLOW if rate < 0.25 else RED
        print(f"\nreference words   {len(ref)}")
        print(f"heard words       {len(hyp)}")
        print(f"WER               {colour}{rate * 100:.1f}%{RESET}  "
              f"{DIM}({s} sub, {d} del, {i_} ins){RESET}")
        print(f"{DIM}WER is measured after lowercasing and stripping punctuation — Hear returns\n"
              f"lowercase unpunctuated text by design, which is not an error.{RESET}")
    if col.unknown:
        print(f"\n{DIM}{len(col.unknown)} frame(s) not classified; --raw to inspect.{RESET}")


# ---------------------------------------------------------------- main

def write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(BYTES_PER_SAMPLE)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)


def save_outputs(col: Collector, args: argparse.Namespace,
                 reference: list[tuple[str | None, str]] | None) -> None:
    """Persist the run. Nothing here is required to talk to Hear — the API keeps nothing for
    you, so if you want a record of a call, this is where it comes from."""
    if args.save_audio:
        pcm = bytes(col.captured)
        if pcm:
            write_wav(args.save_audio, pcm)
            print(f"audio     → {args.save_audio}  "
                  f"({len(pcm) / (SAMPLE_RATE * BYTES_PER_SAMPLE):.1f}s)")
        else:
            print(f"{YELLOW}nothing captured to write to {args.save_audio}{RESET}")

    if not args.save:
        return
    heard = " ".join(f["text"].strip() for f in col.finals)
    out = {
        "session_id": col.session.get("session_id"),
        "model": col.session.get("model"),
        "text": heard,
        # One entry per utterance Hear finalized. `text` is verbatim — what the citation gate
        # would quote. Timings are ms from stream start.
        "segments": [
            {
                "index": i,
                "text": f["text"],
                "arrived_at_ms": round(f["at_ms"]),
                "endpoint_to_text_ms": f.get("lag_ms"),
                "low_input_level": bool(f.get("suspect")),
                "audio_ms": f["raw"].get("audio_ms"),
                "endpoint_reason": f["raw"].get("endpoint_reason"),
            }
            for i, f in enumerate(col.finals)
        ],
        "metrics": {
            "finals": len(col.finals),
            "partials": col.partial_count,
            "first_partial_ms": round(col.first_partial_ms) if col.first_partial_ms else None,
            "input_peak_rms": round(col.peak, 4) if col.level is not None else None,
        },
        "usage": {
            "active_audio_seconds": col.usage.get("active_audio_seconds"),
            "billed_micros": col.usage.get("billed_micros"),
        },
    }
    if reference:
        ref, hyp = normalize(" ".join(t for _, t in reference)), normalize(heard)
        rate, s, d, i_ = wer(ref, hyp)
        out["accuracy"] = {"wer": round(rate, 4), "substitutions": s,
                           "deletions": d, "insertions": i_, "reference_words": len(ref)}
    args.save.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"transcript → {args.save}")


def main() -> None:
    p = argparse.ArgumentParser(
        description="Drive PyAI Hear streaming STT from a transcript file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("transcript", nargs="?", type=Path, help="transcript to speak (and score against)")
    p.add_argument("--audio", type=Path, help="stream this audio file instead of synthesizing — mp3/m4a/wav/flac, decoded locally via afconvert")
    p.add_argument("--reference", type=Path, help="score --audio against this transcript")
    p.add_argument("--mic", action="store_true",
                   help="stream your live microphone instead of synthesized audio")
    p.add_argument("--device", type=int, help="input device index (--list-devices to see them)")
    p.add_argument("--list-devices", action="store_true", help="show input devices and exit")
    p.add_argument("--seconds", type=float, help="with --mic: stop after N seconds")
    p.add_argument("--silence-floor", type=float, default=0.08,
                   help="input RMS below which a final is flagged as hallucinated (mic only). "
                        "Measured: speech ~0.22, room ambience that still produced fabricated "
                        "text ~0.035. Raise it if real speech gets flagged.")
    p.add_argument("--mock", action="store_true", help="no network: show the frame shape only")
    p.add_argument("--model", default="pyai-hear")
    p.add_argument("--language", default="en")
    p.add_argument("--protocol", help="e.g. pyai-hear-v1 — selects the published frame names. "
                                      "Omit to see what the default route actually sends.")
    p.add_argument("--endpointing-ms", type=int,
                   help="minimum trailing pause before an utterance ends (50-5000)")
    p.add_argument("--speed", type=float, default=1.0, help="1.0 = real time; 4 = 4x faster")
    p.add_argument("--chunk-ms", type=int, default=100, help="audio bytes per WebSocket frame")
    p.add_argument("--gap-ms", type=int, default=1800, help="silence between turns; must clear "
                   "Hear's ~1.8s endpoint threshold or turns merge into one utterance")
    p.add_argument("--tail-silence-ms", type=int, default=2000,
                   help="trailing silence — the only thing that flushes the last utterance")
    p.add_argument("--drain", type=float, default=8.0, help="seconds to wait for trailing finals")
    p.add_argument("--eos", default="end", help="end-of-stream control type ('' to send none)")
    p.add_argument("--interim", action="store_true", help="ask for interim_results=true")
    p.add_argument("--raw", action="store_true", help="dump every frame verbatim")
    p.add_argument("--keep-wav", type=Path, help="save the synthesized audio here")
    p.add_argument("--save", type=Path, help="write the transcript + timings + usage to JSON")
    p.add_argument("--save-audio", type=Path,
                   help="write the audio that was streamed (your mic recording) to a WAV")
    args = p.parse_args()

    if args.list_devices:
        import sounddevice as sd

        for i, d in enumerate(sd.query_devices()):
            if d["max_input_channels"] > 0:
                default = " (default)" if i == sd.default.device[0] else ""
                print(f"  {i}  {d['name']}{default}")
        return

    if not args.transcript and not args.audio and not args.mic:
        p.error("give a transcript file, --audio <wav>, or --mic")

    turns = parse_transcript(args.transcript) if args.transcript else None
    ref_path = args.reference or (args.transcript if args.audio else None)
    reference = parse_transcript(ref_path) if ref_path and ref_path.exists() else turns

    if args.mock:
        if not turns:
            p.error("--mock needs a transcript file")
        col = asyncio.run(run_mock(turns, args))
        report(col, reference)
        save_outputs(col, args, reference)
        return

    if args.mic:
        pcm = b""
        if turns:
            # A transcript plus --mic means "read this aloud and score me against it".
            print(f"{BOLD}read this aloud{RESET} {DIM}(WER is scored against it){RESET}")
            for _, text in turns:
                print(f"  {text}")
            print()
    elif args.audio:
        pcm = load_audio(args.audio)
    else:
        print(f"{BOLD}synthesizing{RESET} {len(turns)} turn(s) with macOS say…")
        pcm = synthesize(turns, args.gap_ms)
        if args.keep_wav:
            with wave.open(str(args.keep_wav), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(BYTES_PER_SAMPLE)
                w.setframerate(SAMPLE_RATE)
                w.writeframes(pcm)
            print(f"{DIM}wrote {args.keep_wav}{RESET}")
        print()

    try:
        col = asyncio.run(run_live(pcm, args))
    except KeyboardInterrupt:
        print("\ninterrupted before the stream could flush.")
        return
    report(col, reference if not args.mic or turns else None)
    save_outputs(col, args, reference if not args.mic or turns else None)


if __name__ == "__main__":
    main()
