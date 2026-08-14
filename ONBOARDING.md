# Get King Gong running on your Mac

One command, two prompts, about five minutes. You do not need to know anything about the codebase.

```bash
curl -fsSL https://raw.githubusercontent.com/AshmitGupta-slbs/king-gong-hackathon/main/install.sh | bash
```

That checks your Node, installs a newer one if you need it, clones the repo into `./king-gong`,
installs dependencies, and then runs `setup.sh`, which asks for your keys and proves the whole pipeline
on a real call before it tells you it worked.

Then pick a surface:

```bash
cd king-gong
npm run dev      # the web app, at http://localhost:3000
./kg             # the terminal UI
```

Already cloned it? Skip the curl and just run `./setup.sh`.

Want it somewhere specific? `TARGET=~/code/king-gong` before the curl.

---

## What it will ask you

**One key, ideally.** Get a `pyai_live_` key from [console.pyai.com](https://console.pyai.com). If it
carries the `recap:read` scope, that single key runs the entire app — PyAI transcribes the call *and*
writes the notes. Setup reads the scopes off your key and tells you which case you are in, so you do
not have to work it out.

If your key cannot write notes, it will ask for an `ANTHROPIC_API_KEY` instead, or pick up AWS
credentials for Bedrock if you already have them exported.

**You can also just press Enter twice.** With no keys at all the app still runs and the five bundled
sample calls are fully analysed and real — audio, transcripts, notes, citations. That is enough to see
the whole product. You only need a key to analyse a call of your own.

> **If you are setting several laptops up on the same wifi, get real keys first.** PyAI's free sandbox
> keys mint themselves, but the mint allowance is budgeted **per network**, not per key — so the third
> or fourth person on the same connection gets `429 sandbox_limit_reached`, and minting another key
> cannot fix it. A `pyai_live_` key sidesteps this entirely.

Re-running `./setup.sh` is safe at any time. It keeps every answer you already gave and only asks about
what is missing.

---

## The five-minute tour

Start here, because it needs no credentials and shows the point of the thing:

```bash
./kg                       # pick a call from the list
```

Open one and you get the summary, the intent, the objections, the next steps — and under **every
claim, the transcript lines that prove it**, with timestamps. Then:

- **type a number** next to any citation to *hear that exact moment* of the call;
- **type `t`** for the full transcript;
- scroll to **"What the citation gate rejected"** — the claims that did not survive, and why.

That last section is the product. Every notes tool writes you a confident summary; this one shows you
what it threw away because it could not prove it.

Then analyse something of your own:

```bash
./kg analyse ~/Downloads/some-call.wav
./kg analyse ~/Downloads/some-call.wav --engine recap    # or claude, or bedrock
```

Stereo recordings with one person per channel give exact, model-free speaker separation. Mono works
too, via diarization. You do not have to choose — it reads the file and decides.

---

## When something is wrong

```bash
./kg doctor
```

It prints what Node you are on, which env file was read, which credentials are set, what your PyAI key
is actually allowed to do, whether `data/` is writable, and which engine a new upload would use. If
something is misconfigured it also tells you the fix.

Other useful checks:

| Command | Answers |
|---|---|
| `npm run check:key` | Is my PyAI key live, and is it rate-limited right now? |
| `npm run check:model` | Which Bedrock model ids does my AWS account actually accept? |
| `npm run test:gate` | Is the citation gate really enforcing "no proof, no claim"? |
| `node scripts/node-check.cjs` | Is my Node new enough, and why not? |

### Things that actually go wrong

**"This Node cannot run King Gong."** You need 22.13 or newer. Not 22.5, even though that is where
`node:sqlite` first appeared — it stayed behind an experimental flag until 22.13, so 22.5 through 22.12
look fine and then fail the moment the app opens its database. The check tests whether Node can really
do it rather than trusting the version number, and prints three ways to fix it.

**Notes appear but nothing was analysed by a model.** With no model credential the app falls back to a
keyword stub. It is labelled everywhere it appears, and `./kg doctor` says so plainly. Add a credential
and it goes away.

**`429 sandbox_limit_reached` on your first upload.** The per-network mint budget, above. Get a live
key.

**`npm run verify` has one red line.** That is deliberate and documented: the bundled sample notes were
hand-authored for the demo, so the provenance check refuses to call them model output. It is not a
broken install, and setup does not treat it as one.

---

## What you actually installed

Nothing global, and nothing that needs admin rights unless you asked for Homebrew:

```
king-gong/
  .env.local        your keys (gitignored, chmod 600, never committed)
  data/             SQLite database + uploaded audio (gitignored, created on first use)
  samples/          the five bundled calls: transcripts and notes
  public/samples/   their audio
  kg                the terminal UI
  setup.sh          re-runnable setup
```

No database server, no Docker, no ffmpeg, no Python. Node's built-in SQLite is the storage, and all the
audio handling is plain 16-bit PCM in JavaScript.

To move on: [`README.md`](README.md) for what the product is and how it works,
[`docs/`](docs/) for the architecture and the API findings behind it.
