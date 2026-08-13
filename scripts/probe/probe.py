#!/usr/bin/env python3
"""H0 API-truth probes. Speak -> WAV -> transcription job with diarize."""
import json, os, sys, time, urllib.request, urllib.error, wave

S = os.path.dirname(os.path.abspath(__file__))
KEY = json.load(open(f"{S}/sandbox-key.json"))["api_key"]
BASE = "https://api.pyai.com/v1"
UNITS = []


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
            u = resp.headers.get("x-pyai-units")
            if u:
                UNITS.append((path, u))
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def multipart(fields, files):
    """fields: dict[str,str]; files: dict[name,(filename,bytes,ctype)]"""
    b = "----probe" + os.urandom(8).hex()
    out = b""
    for k, v in fields.items():
        out += f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    for k, (fn, data, ct) in files.items():
        out += (f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"; "
                f"filename=\"{fn}\"\r\nContent-Type: {ct}\r\n\r\n").encode() + data + b"\r\n"
    out += f"--{b}--\r\n".encode()
    return out, f"multipart/form-data; boundary={b}"


print("=" * 70)
print("PROBE 1 — Speak: synthesize a WAV (scope voice:synthesize)")
print("=" * 70)
LINE = ("So look, I like the product, but honestly the pricing is a real problem for us. "
        "We're already paying Gong fourteen hundred a seat and my CFO is asking hard questions.")
st, hdr, audio = req("POST", "/audio/speech", body={
    "model": "pyai-speak", "voice": "stock_amos_en_us",
    "input": LINE, "response_format": "wav",
})
print(f"HTTP {st}  bytes={len(audio)}  content-type={hdr.get('content-type')}")
print(f"x-pyai-units: {hdr.get('x-pyai-units')}")
if st != 200:
    print("BODY:", audio[:300].decode("utf8", "replace"))
    print("\n--> Speak unavailable. Falling back to macOS `say` for probe audio")
    print("    (Speak only matters for sample generation; retry it later.)")
    import subprocess
    subprocess.run(["say", "-v", "Alex", "-o", f"{S}/probe.wav",
                    "--data-format=LEI16@16000", "--file-format=WAVE", LINE], check=True)
    audio = open(f"{S}/probe.wav", "rb").read()
    print(f"    say produced {len(audio)} bytes")
else:
    with open(f"{S}/probe.wav", "wb") as f:
        f.write(audio)
try:
    with wave.open(f"{S}/probe.wav") as w:
        print(f"WAV: {w.getnchannels()}ch {w.getframerate()}Hz "
              f"{w.getsampwidth()*8}-bit  {w.getnframes()/w.getframerate():.2f}s")
except Exception as e:
    print("not a parseable WAV:", e, "| first bytes:", audio[:16])

print()
print("=" * 70)
print("PROBE 2 — THE DECISIVE ONE: POST /transcription/jobs (scope transcribe:jobs)")
print("=" * 70)
body, ct = multipart(
    {"diarize": "true", "output_formats": "json", "numerals": "true"},
    {"audio": ("probe.wav", audio, "audio/wav")},
)
st, hdr, out = req("POST", "/transcription/jobs", raw_body=body,
                   headers={"Content-Type": ct})
print(f"HTTP {st}   x-pyai-units: {hdr.get('x-pyai-units')}")
print(out[:900].decode("utf8", "replace"))
if st not in (200, 201, 202):
    print("\n>>> FALLBACK PATH REQUIRED (stream-per-channel)")
    sys.exit(0)

job = json.loads(out)
jid = job["job_id"]
print(f"\npolling job {jid} ...")
for i in range(40):
    time.sleep(1.5)
    st, hdr, out = req("GET", f"/transcription/jobs/{jid}")
    j = json.loads(out)
    if j.get("status") in ("completed", "failed", "cancelled"):
        print(f"  status={j['status']} after {i+1} polls")
        break
    print(f"  [{i+1}] status={j.get('status')}")
else:
    print("  TIMED OUT")
    sys.exit(1)

print()
print("=" * 70)
print("PROBE 3 — the segments[] shape our whole data contract depends on")
print("=" * 70)
res = j.get("result") or {}
if not res and j.get("result_url"):
    print("result offloaded to result_url; fetching")
    st, hdr, out = req("GET", j["result_url"])
    res = json.loads(out)
print("result keys:", sorted(res.keys()))
print("speakers:", res.get("speakers"), " audio_seconds:", res.get("audio_seconds"))
segs = res.get("segments") or []
print(f"segments: {len(segs)}")
for s in segs[:6]:
    print("  ", json.dumps(s)[:220])
print("\nwords[0]:", json.dumps((res.get("words") or [{}])[0])[:220])
print("formats:", res.get("formats"))

print()
print("=" * 70)
print("PROBE 4 — flat /audio/transcriptions with verbose_json: any timestamps?")
print("=" * 70)
body, ct = multipart({"response_format": "verbose_json"},
                     {"file": ("probe.wav", audio, "audio/wav")})
st, hdr, out = req("POST", "/audio/transcriptions", raw_body=body,
                   headers={"Content-Type": ct})
print(f"HTTP {st}  x-pyai-units: {hdr.get('x-pyai-units')}")
try:
    d = json.loads(out)
    print("keys:", sorted(d.keys()))
    print(json.dumps(d)[:400])
except Exception:
    print(out[:400].decode("utf8", "replace"))

print()
print("=" * 70)
print("x-pyai-units observed (drives the usage counter)")
print("=" * 70)
for p, u in UNITS:
    print(f"  {p:34s} {u}")
