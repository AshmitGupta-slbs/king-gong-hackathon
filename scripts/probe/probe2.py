#!/usr/bin/env python3
"""H0 probes, round 2: two-speaker separation, model choice, Speak retry."""
import json, os, subprocess, sys, time, urllib.request, urllib.error, wave

S = os.path.dirname(os.path.abspath(__file__))
KEY = json.load(open(f"{S}/sandbox-key.json"))["api_key"]
BASE = "https://api.pyai.com/v1"

REP = [
    "Hi Sarah, thanks for making the time today. I know you've been evaluating a few options.",
    "That's fair. Most teams we talk to are in exactly that spot before they switch.",
    "I can get you a pilot on two seats so your CFO sees the number before committing.",
]
PROSPECT = [
    "Yeah, no problem. We've been looking at Gong and Chorus, honestly.",
    "The pricing is the real problem though. Fourteen hundred a seat is hard to justify.",
    "Okay, send that over and I'll take it to the finance review on Thursday.",
]


def req(method, path, body=None, headers=None, raw_body=None):
    url = path if path.startswith("http") else BASE + path
    h = {"Authorization": f"Bearer {KEY}"}
    h.update(headers or {})
    data = raw_body
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def multipart(fields, files):
    b = "----probe" + os.urandom(8).hex()
    out = b""
    for k, v in fields.items():
        out += f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    for k, (fn, data, ct) in files.items():
        out += (f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"; "
                f"filename=\"{fn}\"\r\nContent-Type: {ct}\r\n\r\n").encode() + data + b"\r\n"
    out += f"--{b}--\r\n".encode()
    return out, f"multipart/form-data; boundary={b}"


def say(text, voice, path):
    subprocess.run(["say", "-v", voice, "-o", path,
                    "--data-format=LEI16@16000", "--file-format=WAVE", text], check=True)
    with wave.open(path) as w:
        return w.readframes(w.getnframes())


def build_turns():
    """Alternate rep/prospect turns; return (left_pcm, right_pcm) padded so each
    speaker is silent while the other talks -> true one-party-per-channel stereo."""
    left, right = b"", b""
    for i in range(3):
        r = say(REP[i], "Alex", f"{S}/_r{i}.wav")
        p = say(PROSPECT[i], "Samantha", f"{S}/_p{i}.wav")
        left += r + b"\x00\x00" * (len(p) // 2)
        right += b"\x00\x00" * (len(r) // 2) + p
    return left, right


def write_wav(path, chans, pcm):
    with wave.open(path, "wb") as w:
        w.setnchannels(chans); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(pcm)


def interleave(l, r):
    out = bytearray()
    for i in range(0, min(len(l), len(r)), 2):
        out += l[i:i+2] + r[i:i+2]
    return bytes(out)


def mixdown(l, r):
    out = bytearray()
    for i in range(0, min(len(l), len(r)), 2):
        a = int.from_bytes(l[i:i+2], "little", signed=True)
        b = int.from_bytes(r[i:i+2], "little", signed=True)
        out += max(-32768, min(32767, a + b)).to_bytes(2, "little", signed=True)
    return bytes(out)


def run_job(wav_bytes, name, **fields):
    f = {"output_formats": "json"}
    f.update({k: str(v).lower() if isinstance(v, bool) else str(v) for k, v in fields.items()})
    body, ct = multipart(f, {"audio": (f"{name}.wav", wav_bytes, "audio/wav")})
    st, hdr, out = req("POST", "/transcription/jobs", raw_body=body, headers={"Content-Type": ct})
    if st != 202:
        print(f"   HTTP {st}: {out[:300].decode('utf8','replace')}")
        return None
    jid = json.loads(out)["job_id"]
    for _ in range(60):
        time.sleep(1.5)
        st, hdr, out = req("GET", f"/transcription/jobs/{jid}")
        j = json.loads(out)
        if j.get("status") in ("completed", "failed", "cancelled"):
            break
    if j.get("status") != "completed":
        print(f"   job {j.get('status')}: {j.get('error')}")
        return None
    res = j.get("result") or {}
    if not res and j.get("result_url"):
        _, _, out = req("GET", j["result_url"]); res = json.loads(out)
    return res


def show(res, label):
    if not res:
        print(f"   {label}: FAILED"); return
    segs = res.get("segments") or []
    spk = sorted({s.get("speaker") for s in segs})
    chans = sorted({s.get("channel") for s in segs if "channel" in s})
    print(f"   {label}: {len(segs)} segs · speakers={res.get('speakers')} "
          f"· distinct speaker labels={spk} · channels={chans} · {res.get('audio_seconds')}s")
    for s in segs[:6]:
        print(f"      [{s.get('speaker')}|ch{s.get('channel')}] "
              f"{s['start']:.2f}-{s['end']:.2f}  {s['text'][:78]}")


print("building two-speaker audio with macOS `say` ...")
left, right = build_turns()
write_wav(f"{S}/two_stereo.wav", 2, interleave(left, right))
write_wav(f"{S}/two_mono.wav", 1, mixdown(left, right))
stereo = open(f"{S}/two_stereo.wav", "rb").read()
mono = open(f"{S}/two_mono.wav", "rb").read()
with wave.open(f"{S}/two_stereo.wav") as w:
    print(f"stereo: {w.getnchannels()}ch {w.getnframes()/w.getframerate():.1f}s  ({len(stereo)} bytes)")

print("\n" + "=" * 72)
print("PROBE 5 — stereo + channel:true  (model-free speaker separation)")
print("=" * 72)
show(run_job(stereo, "stereo", channel=True), "channel=true")

print("\n" + "=" * 72)
print("PROBE 6 — mono mixdown + diarize:true  (Sortformer diarization)")
print("=" * 72)
show(run_job(mono, "mono", diarize=True), "diarize=true")

print("\n" + "=" * 72)
print("PROBE 7 — does model=pyai-hear punctuate? (telephony is the jobs default)")
print("=" * 72)
for m in ("pyai-hear-telephony", "pyai-hear"):
    res = run_job(mono, "mono", diarize=True, model=m)
    txt = (res or {}).get("text", "")
    has_punct = any(c in txt for c in ".,?!") and any(c.isupper() for c in txt)
    print(f"   {m:22s} punctuated+cased={has_punct}")
    print(f"      {txt[:200]}")

print("\n" + "=" * 72)
print("PROBE 8 — retry Speak (was 503)")
print("=" * 72)
st, hdr, out = req("POST", "/audio/speech", body={
    "model": "pyai-speak", "voice": "stock_amos_en_us",
    "input": "Quick retry check.", "response_format": "wav"})
print(f"   HTTP {st}  bytes={len(out)}  units={hdr.get('x-pyai-units')}")
if st != 200:
    print(f"   {out[:200].decode('utf8','replace')}")
