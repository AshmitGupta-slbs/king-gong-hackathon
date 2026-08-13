# Deploying OpenGong Lite

Two services from this one repo: the app, and the documentation site. Both are plain Node — no
Docker, no build plugins, nothing to compile.

## Service 1 — the app

| Setting | Value |
|---|---|
| Build | `npm run build` |
| Start | `npm start` |
| Node | pinned by `engines` + `.nvmrc` (see below) |
| Env vars | none required to demo; see the PyAI key section below before uploading audio |

**The Node version is not optional.** `lib/db.ts` uses Node's built-in `node:sqlite`, which needs
**Node ≥ 22.5**. `package.json` declares `"engines": { "node": ">=22.5.0" }` and `.nvmrc` pins `24`.
If a host ignores both and runs an older LTS, the import fails on the first database call. Check the
build log for the Node version if the app boots and then 500s.

No environment variable is required to serve the bundled demo: the five sample calls are committed,
and a PyAI sandbox key mints itself on first use. To get real model-written notes rather than the
labelled keyword stub, set **either** `ANTHROPIC_API_KEY` **or** `AWS_ACCESS_KEY_ID` +
`AWS_SECRET_ACCESS_KEY` + `AWS_REGION` (with Bedrock model access enabled). See `.env.example` for
every option.

### The PyAI key, and what to do when it caps

Uploading **new** audio is the only thing that needs a live PyAI key. The five bundled sample calls
are pre-processed and make no API call, so a capped key never blocks a demo of those.

```bash
npm run check:key   # source, tier, expiry, and whether it answers requests right now
```

Two tiers, and the difference matters on a deployed service:

| | `pyai_test_` (sandbox) | `pyai_live_` (console account) |
|---|---|---|
| How you get it | mints itself, no signup | https://console.pyai.com, prepaid credit |
| Daily cap | **yes** — resets 00:00 UTC | no |
| Minting limit | **per network, not per key** | n/a |

**Rotating the key on a host like Railway.** Set `PYAI_API_KEY` as a service variable. When a
sandbox key caps, the app will mint a replacement in-process automatically — but a `pyai_live_` key
is never replaced automatically, because silently swapping a paid uncapped key for a capped sandbox
one would be a downgrade nobody asked for. To rotate manually, update the variable and redeploy.

**Do not rely on `.pyai-key.json` in a deployment.** The container filesystem is ephemeral (see
below), so a minted key does not survive a redeploy — each one re-mints, and every mint draws on the
same per-network budget.

**When the cap is hit**, the app now says so in words rather than surfacing `PyAI 429
daily_cap_exceeded`: it reports when the cap lifts and points at the console-key option. Minting
another sandbox key does **not** work around a `sandbox_limit_reached`, because that limit is on the
network rather than the key.

### Storage: SQLite by default, MongoDB when you want it to last

```bash
npm run check:store   # which backend is live, and — on Mongo — a real round-trip test
```

With **no `MONGODB_URI`** the app uses local SQLite at `data/opengong.db`. That is the zero-setup
path: nothing to install, nothing to run, and the whole demo works. It is also ephemeral (see
below).

Set **`MONGODB_URI`** and everything — calls, transcripts, notes, accounts and the learning ledger —
is stored in MongoDB instead. The backend is inferred from the prefix, so moving from a shared REST
gateway to a real Atlas cluster is one variable and no code change:

| `MONGODB_URI` | Backend |
|---|---|
| `mongodb+srv://…` or `mongodb://…` | the real driver — native, atomic |
| any other URL | HTTP gateway via a compatibility shim |
| unset | local SQLite |

`MONGODB_DB` names the database and `MONGO_COLLECTION_PREFIX` is prepended to every collection, so
several apps can share one cluster without colliding.

> **The REST gateway shim is unverified.** Its URL paths are implemented as specified, but the
> request/response body shape was never documented, so it has not been proven against a live
> gateway. Prefer a `mongodb+srv://` URI, and if you must use the gateway, run `npm run check:store`
> first — it round-trips a document rather than trusting configuration.

#### Audio is a filesystem object, and Mongo does not fix that

Worth being plain about, because it is easy to assume otherwise: **MongoDB makes the call *record*
durable, not the audio**. Uploaded WAVs are written to `data/uploads/` and streamed back by
`app/api/audio/[file]/route.ts`. After a redeploy the call, its transcript and its notes all come
back — and the player has nothing to play.

If uploaded audio needs to survive, mount a volume and point `OPENGONG_UPLOAD_DIR` at it. That
covers the audio on either backend and is the only option that does not depend on which store is
configured.

### Recommended Railway setup: Mongo **and** a volume

They solve different halves of the same problem, and neither covers the other — Mongo keeps the
records, the volume keeps the bytes.

**Variables** (service → Variables):

```
MONGODB_URI=mongodb+srv://…        # your cluster
MONGODB_DB=opengong                # optional, this is the default
MONGO_COLLECTION_PREFIX=opengong_  # optional; isolates this app inside a shared cluster
OPENGONG_UPLOAD_DIR=/app/data/uploads
PYAI_API_KEY=pyai_live_…           # already set
```

**Volume** (service → Volumes): mount at **`/app/data/uploads`**.

Mount the uploads directory specifically, not `/app/data`. Mounting the parent would also persist
`data/opengong.db`, leaving a stale SQLite file beside the live Mongo data — two stores with
different contents and nothing to say which one the app read. With `MONGODB_URI` set the SQLite file
is never opened, and this keeps it from existing at all.

Collections are created on first write and indexes on first use, so there is nothing to provision by
hand. Verify after the first deploy:

```bash
npm run check:store   # backend, and a real insert/read/$set/$inc/sort/count/delete round trip
```

### What survives a redeploy, and what does not

The container filesystem is ephemeral. Two things live on it:

- `data/opengong.db` — calls, segments, notes, run history, usage totals.
- `data/uploads/` — audio for calls you uploaded.

Both are wiped on every redeploy **unless `MONGODB_URI` is set** (which moves everything except the
audio into Mongo — see above). For the bundled demo this is fine either way: `loadSamples()` is idempotent
and runs on the home page render, so a cold container re-seeds the five sample calls on first
request. Verified against a production build with the database deleted — the home page listed all
five.

What you lose is run history, usage totals, and uploaded calls. If that matters, attach a volume
mounted at `/app/data` and both survive, because both live under `data/`.

## Service 2 — the documentation

| Setting | Value |
|---|---|
| Build | none |
| Start | `npm run start:docs` (or `node docs/serve.mjs`) |

`docs/serve.mjs` is a dependency-free static server for `docs/site/`. It exists rather than dropping
the HTML into `public/` for two reasons: Next makes no promise about mapping a directory request to
`index.html`, so `/docs/` could 404 while `/docs/index.html` worked; and serving from `public/` would
have hit the same post-build invisibility described below.

The pages fetch Google Fonts and Mermaid from CDNs. That is fine on any host with outbound internet;
offline they fall back to system fonts and show diagram source rather than diagrams. Note that
`fonts.gstatic.com` intermittently 404s one Inter Tight variant — a Google-side flake, not a bug
here. The effect is a slightly different font on an unlucky page load.

## A bug worth knowing about, because it only appears once deployed

Uploaded audio used to be written to `public/uploads/` and served as a static path. Next serves
`public/` **as it existed at build time**, so a file written there at runtime does not exist as far
as the production server is concerned:

```
next dev    → GET /uploads/x.wav → 200
next start  → GET /uploads/x.wav → 404      # same file, same code
```

An uploaded call would transcribe correctly, display its citations, and play silence — on the hosted
app only, with every local test green. Uploads now go to `data/uploads/` and are streamed by
`app/api/audio/[file]/route.ts`, which also implements Range requests, since seeking to a cited
moment is the core interaction and Safari will not seek without them.

If you add any other runtime-written file, do not put it in `public/`.

## Before you call it deployed

- Home page lists five calls — proves cold-container seeding.
- Click a citation chip: audio seeks to that moment.
- **Test the gate** on any call: 3 dropped, 2 flagged, status `partial`.
- Export Markdown: it downloads and ends with the digit-substitution footnote.
- Docs: the bare domain serves the index, all 11 pages load, both diagrams render.
- Upload one short call, then click one of its citations — the fix above is what makes that work.

### If a live upload fails, check this before your audio

PyAI's `diarize` stage returns `500` in **multi-minute windows**, server-side and independent of the
payload: the job is accepted, transcription succeeds, and only diarization fails. This was pinned
down by interleaved A/B testing — MP3 vs WAV, `numerals`, multipart field order and our own encoder
were each ruled out, and identical bytes succeed minutes later.

Two consequences worth knowing before you stand in front of an audience:

- **`channel: true` never touches that stage.** If mono upload is failing, upload stereo audio and
  pick channel separation — it is also the more accurate mode.
- Retry cannot save you here. `lib/harness/retry.ts` caps at 2 attempts by design; the budget
  governor exists to stop runs, not to hammer a broken upstream for minutes. The run ends `failed`
  with the upstream error preserved, which is the correct outcome.

And do not sequentially A/B test it — the windows are long enough that whichever variant lands in a
good window looks like the fix. Two false conclusions were reached that way before interleaving
settled it. The reason the demo leads with the five committed samples is exactly this: they need no
API call at all.
