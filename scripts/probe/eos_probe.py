#!/usr/bin/env python3
"""Which end-of-stream signal makes Hear streaming flush its last utterance?

Sends 4s of speech, then one candidate control message, then waits 6s for a final.
The winner is whatever produces transcript.final fastest without an error frame.
"""
import asyncio, json, subprocess, sys, tempfile, time, wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hear_stream_test import WS_BASE, resolve_key, ssl_context, SAMPLE_RATE  # noqa: E402

import websockets

CANDIDATES = [
    ("end", {"type": "end"}),
    ("eos", {"type": "eos"}),
    ("commit", {"type": "input_audio.commit"}),
    ("done", {"type": "input_audio.done"}),
    ("finalize", {"type": "transcript.finalize"}),
    ("flush", {"type": "flush"}),
    ("session.close", {"type": "session.close"}),
    ("silence-2s", None),          # 2s of digital silence, no control frame
    ("close-frame", "CLOSE"),      # just close the socket
]


def clip() -> bytes:
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "c.wav"
        subprocess.run(["say", "-v", "Alex", "-o", str(out),
                        f"--data-format=LEI16@{SAMPLE_RATE}", "--file-format=WAVE",
                        "the pricing came in around fourteen hundred a seat"],
                       check=True, capture_output=True)
        with wave.open(str(out), "rb") as w:
            return w.readframes(w.getnframes())


async def probe(name, control, pcm, key):
    url = (f"{WS_BASE}/audio/transcriptions/stream?model=pyai-hear&sample_rate={SAMPLE_RATE}"
           f"&encoding=pcm16&language=en&numerals=true&api_key={key}")
    t0 = time.monotonic()
    final, err, partials = None, None, 0
    try:
        async with websockets.connect(url, ssl=ssl_context(), max_size=None) as ws:
            async def recv():
                nonlocal final, err, partials
                async for f in ws:
                    if isinstance(f, bytes):
                        continue
                    m = json.loads(f)
                    t = m.get("type", "")
                    if t == "transcript.final":
                        final = ((time.monotonic() - t0) * 1000, m.get("text", ""))
                        return
                    if t == "transcript.partial":
                        partials += 1
                    elif "error" in t:
                        err = json.dumps(m)[:120]
                        return

            task = asyncio.create_task(recv())
            step = SAMPLE_RATE // 10 * 2
            for off in range(0, len(pcm), step):
                await ws.send(pcm[off:off + step])
                await asyncio.sleep(0.1)
            sent_at = time.monotonic()

            if control == "CLOSE":
                await ws.close()
            elif control is None:
                for _ in range(20):
                    await ws.send(b"\x00" * step)
                    await asyncio.sleep(0.1)
            else:
                await ws.send(json.dumps(control))
            try:
                await asyncio.wait_for(task, timeout=6)
            except (asyncio.TimeoutError, Exception):
                task.cancel()
    except Exception as exc:
        err = err or f"{type(exc).__name__}: {exc}"[:120]

    after = f"{final[0] - (sent_at - t0) * 1000:+.0f}ms after send" if final else ""
    status = "FINAL" if final else ("ERR" if err else "no final")
    print(f"  {name:<14} {status:<9} {after:<18} partials={partials:<3} "
          f"{(final[1][:60] if final else (err or ''))}")
    return name, bool(final)


async def main():
    pcm, key = clip(), resolve_key()
    print(f"clip = {len(pcm) / (SAMPLE_RATE * 2):.1f}s speech\n")
    wins = []
    for name, control in CANDIDATES:
        n, ok = await probe(name, control, pcm, key)
        if ok:
            wins.append(n)
        await asyncio.sleep(0.5)
    print(f"\nflushes the tail: {', '.join(wins) if wins else 'NONE'}")


asyncio.run(main())
