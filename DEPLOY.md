# Deploying OpenGong Lite

Two services from this one repo: the app, and the documentation site. Both are plain Node — no
Docker, no build plugins, nothing to compile.

## Service 1 — the app

| Setting | Value |
|---|---|
| Build | `npm run build` |
| Start | `npm start` |
| Node | pinned by `engines` + `.nvmrc` (see below) |
| Env vars | none required |

**The Node version is not optional.** `lib/db.ts` uses Node's built-in `node:sqlite`, which needs
**Node ≥ 22.5**. `package.json` declares `"engines": { "node": ">=22.5.0" }` and `.nvmrc` pins `24`.
If a host ignores both and runs an older LTS, the import fails on the first database call. Check the
build log for the Node version if the app boots and then 500s.

No environment variable is required to serve the bundled demo: the five sample calls are committed,
and a PyAI sandbox key mints itself on first use. To get real model-written notes rather than the
labelled keyword stub, set **either** `ANTHROPIC_API_KEY` **or** `AWS_ACCESS_KEY_ID` +
`AWS_SECRET_ACCESS_KEY` + `AWS_REGION` (with Bedrock model access enabled). See `.env.example` for
every option.

### What survives a redeploy, and what does not

The container filesystem is ephemeral. Two things live on it:

- `data/opengong.db` — calls, segments, notes, run history, usage totals.
- `data/uploads/` — audio for calls you uploaded.

Both are wiped on every redeploy, and **that is fine for the demo**: `loadSamples()` is idempotent
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
