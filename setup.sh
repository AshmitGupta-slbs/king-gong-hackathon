#!/usr/bin/env bash
# King Gong local setup. Asks for the least it can, then proves the pipeline on a real call.
#
#   ./setup.sh
#
# Idempotent: re-running keeps every answer you already gave and only asks about what is missing.
# Writes .env.local (gitignored) and nothing else.
#
# NOTE FOR EDITORS: keep this file pure ASCII. A Unicode ellipsis after a "$var" once made bash report
# "unbound variable" halfway through the reference version of this script.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m%s %s\033[0m\n' "OK" "$*"; }
warn() { printf '\033[1;33m%s %s\033[0m\n' "!" "$*"; }
die()  { printf '\033[1;31m%s %s\033[0m\n' "x" "$*" >&2; exit 1; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
head2() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# --- 0. Node, before anything else ------------------------------------------
# The repo's own capability check is the authority: it asks Node whether node:sqlite actually loads
# rather than comparing version numbers, because the numbers are misleading (see the file).
node scripts/node-check.cjs || die "Fix Node first, then re-run ./setup.sh"

# --- 1. dependencies --------------------------------------------------------
if [ ! -d node_modules ]; then
  say "Installing dependencies (npm ci)"
  npm ci --no-audit --no-fund >/dev/null || die "npm ci failed. Run it directly to see why."
  ok "Dependencies installed"
fi

# --- 2. keep prior answers --------------------------------------------------
# Sourced so a re-run only asks about what is still missing. `set -a` exports each assignment so the
# child processes below (node, npm) see them too.
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
  dim "Read existing .env.local"
fi

head2 "1. PyAI key (transcription, and optionally the notes too)"
cat <<'EOF'
  Every upload is transcribed by PyAI Hear. A key with the recap:read scope can ALSO write the notes,
  which means one credential runs the whole app.

  Get one at https://console.pyai.com (a pyai_live_ key). Leave this blank and a free sandbox key
  mints itself -- but note the sandbox mint budget is measured PER NETWORK, not per key, so on shared
  wifi it can already be spent before you start. The five bundled sample calls need no key at all.

EOF

if [ -z "${PYAI_API_KEY:-}" ]; then
  read -r -p "  PyAI API key (Enter to skip): " PYAI_API_KEY || true
  PYAI_API_KEY="${PYAI_API_KEY:-}"
else
  dim "  Using the PYAI_API_KEY already in your environment."
fi

# --- 3. ask the key what it can do ------------------------------------------
# Rather than asking the user which of four credential paths they have, read the scopes off the key and
# recommend from that. Parsed with an explicit allowlist instead of `eval`, because this is the output
# of a network call.
PY_OK=0; PY_TIER=""; PY_RECAP=0; PY_TRANSCRIBE=0; PY_CAPPED=1
PY_MSG=""; PY_STATUS=""; PY_CODE=""
if [ -n "$PYAI_API_KEY" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      ok)         PY_OK="$v" ;;
      tier)       PY_TIER="$v" ;;
      recap)      PY_RECAP="$v" ;;
      transcribe) PY_TRANSCRIBE="$v" ;;
      capped)     PY_CAPPED="$v" ;;
      message)    PY_MSG="$v" ;;
      status)     PY_STATUS="$v" ;;
      code)       PY_CODE="$v" ;;
    esac
  done < <(PYAI_API_KEY="$PYAI_API_KEY" node scripts/pyai-identity.cjs 2>/dev/null || true)

  if [ "$PY_OK" = "1" ]; then
    ok "Key accepted: $PY_TIER tier$([ "$PY_CAPPED" = "1" ] && printf ' (daily cap applies)' || true)"
    [ "$PY_TRANSCRIBE" = "1" ] && ok "Can transcribe (hear:transcribe + transcribe:jobs)" \
      || warn "This key CANNOT transcribe -- it lacks hear:transcribe/transcribe:jobs. Uploads will fail."
    [ "$PY_RECAP" = "1" ] && ok "Can write notes (recap:read) -- one key runs the whole app" \
      || dim "  No recap:read on this key, so the notes need a model of your own (next question)."
  else
    warn "Key rejected: ${PY_CODE:-unknown}${PY_STATUS:+ (HTTP $PY_STATUS)} -- ${PY_MSG:-no detail}"
    dim "  Saving it anyway so you can fix it in .env.local without re-running everything."
  fi
fi

# --- 4. which engine writes the notes ---------------------------------------
head2 "2. Which engine writes the notes"

ENGINE=""
if [ "$PY_RECAP" = "1" ]; then
  cat <<'EOF'
  Your PyAI key can do this itself (recap), so no second credential is needed. Recap is a finished
  notes product: hand it the transcript, it returns the summary, action items and call signals.

  Trade-offs, because they are real: Recap takes no prompt, so the skills/ playbooks and account
  context are not applied; and it returns no citations, so each claim is matched back to a transcript
  line by this repo rather than asserted by the engine. The interface says so on every call it writes.

  Alternatives: anthropic (needs ANTHROPIC_API_KEY) or anthropic_bedrock (needs AWS credentials).

EOF
  read -r -p "  Notes engine [recap]: " ENGINE || true
  ENGINE="${ENGINE:-recap}"
else
  echo "  No recap:read on your PyAI key, so the notes need a model."
  echo "  Get a key at https://console.anthropic.com, or leave blank to use AWS Bedrock or the stub."
  echo ""
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    read -r -p "  Anthropic API key (Enter to skip): " ANTHROPIC_API_KEY || true
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
  else
    dim "  Using the ANTHROPIC_API_KEY already in your environment."
  fi
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    ENGINE="anthropic"
  elif [ -n "${AWS_REGION:-${AWS_DEFAULT_REGION:-}}" ] && [ -n "${AWS_ACCESS_KEY_ID:-${AWS_PROFILE:-}}" ]; then
    ENGINE="anthropic_bedrock"
    ok "Found AWS credentials -- using Claude on Bedrock"
  else
    ENGINE="stub"
  fi
fi
ENGINE="$(printf '%s' "$ENGINE" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

case "$ENGINE" in
  recap|pyai|pyai_recap) ENGINE=recap ;;
  anthropic|claude|anthropic_api) ENGINE=anthropic ;;
  bedrock|anthropic_bedrock|aws_bedrock) ENGINE=anthropic_bedrock ;;
  stub|none|"") ENGINE=stub ;;
  *) die "Unknown engine '$ENGINE'. Choose: recap | anthropic | anthropic_bedrock | stub" ;;
esac

if [ "$ENGINE" = "recap" ] && [ "$PY_RECAP" != "1" ]; then
  warn "You chose recap but this PyAI key has no recap:read scope. Notes will fail until it does."
fi
if [ "$ENGINE" = "anthropic" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  read -r -p "  Anthropic API key: " ANTHROPIC_API_KEY || true
fi

# --- 5. write .env.local ----------------------------------------------------
# Values are quoted so anything containing a space survives being sourced on the next run.
#
# LLM_PROVIDER is deliberately LEFT OUT for the stub: an unrecognised value throws by design, and more
# importantly, pinning "stub" here would keep overriding credential auto-detection later -- so someone
# who added an Anthropic key next week would silently still get keyword notes.
{
  echo "# Written by ./setup.sh. Safe to edit by hand; re-running setup keeps what is here."
  echo "# Never commit this file (it is gitignored)."
  echo "PYAI_API_KEY=\"${PYAI_API_KEY:-}\""
  [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_API_KEY=\"${ANTHROPIC_API_KEY}\""
  if [ "$ENGINE" != "stub" ]; then
    echo "LLM_PROVIDER=\"${ENGINE}\""
  else
    echo "# LLM_PROVIDER left unset on purpose: with no model credential the app falls back to a"
    echo "# clearly-labelled keyword stub, and leaving this blank means adding a key later just works."
  fi
  [ -n "${PYAI_BASE_URL:-}" ] && echo "PYAI_BASE_URL=\"${PYAI_BASE_URL}\""
  [ -n "${MONGODB_URI:-}" ] && echo "MONGODB_URI=\"${MONGODB_URI}\""
} > .env.local
chmod 600 .env.local 2>/dev/null || true
ok "Wrote .env.local (engine: $ENGINE)"

if [ "$ENGINE" = "stub" ]; then
  warn "No model credential, so notes come from a keyword stub -- NOT a model."
  dim "  It is labelled everywhere it appears. The five bundled sample calls are real and unaffected."
fi

# --- 6. verify ---------------------------------------------------------------
# Deliberately NOT `npm run verify` or `check:ship`: that suite fails on a clean clone on purpose,
# because the committed sample notes are hand-authored fixtures. Gating setup on it would report a
# broken install on a perfectly good machine. These are the checks that are genuinely green.
head2 "3. Checking the install"

npm run --silent check:key || warn "PyAI key check failed (above). Uploads will not work until fixed."

if [ "$ENGINE" = "anthropic_bedrock" ]; then
  npm run --silent check:model || warn "No Bedrock model resolved (above)."
fi

if npm run --silent test:gate >/tmp/kg-gate.log 2>&1; then
  ok "Citation gate verified ($(grep -c 'PASS' /tmp/kg-gate.log) checks)"
else
  warn "The citation gate suite FAILED. See /tmp/kg-gate.log -- this is the core guarantee, so stop here."
fi
rm -f /tmp/kg-gate.log

# --- 7. prove it on a real call ---------------------------------------------
head2 "4. Proving it end to end"

if [ "$PY_OK" = "1" ] && [ "$PY_TRANSCRIBE" = "1" ] && [ "$ENGINE" != "stub" ]; then
  echo "  This transcribes one bundled call with PyAI Hear and writes notes with '$ENGINE', for real."
  echo "  It costs a few cents of your own credit. Nothing else in setup spends anything."
  echo ""
  read -r -p "  Run it now? [Y/n]: " RUN_E2E || true
  case "${RUN_E2E:-y}" in
    [Nn]*) dim "  Skipped. Run it later with:  ./kg analyse public/samples/clean-close.wav" ;;
    *)
      ./kg analyse public/samples/clean-close.wav --title "Setup check" \
        && ok "End to end works: transcribed, analysed, and every claim cited." \
        || warn "The end-to-end run failed (above). The bundled samples still work; see ./kg doctor."
      ;;
  esac
else
  dim "  Skipped: needs a working PyAI key with transcription scopes and a real notes engine."
  dim "  The five bundled sample calls still demo the whole product with no credential."
fi

# --- 8. what next -----------------------------------------------------------
head2 "Setup complete"
cat <<EOF
  Two ways to use it:

    npm run dev            the web app, at http://localhost:3000
    ./kg                   the terminal UI (browse calls, read cited notes, hear the moment)

  Useful:

    ./kg analyse <file>    transcribe and analyse a call from the terminal
    ./kg doctor            what is configured, and what is wrong
    ./setup.sh             re-run this; it keeps every answer you gave

  Start with the five bundled calls -- they are fully analysed and need no key.
EOF
