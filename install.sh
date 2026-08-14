#!/usr/bin/env bash
# One-command bootstrap for King Gong.
#
#   curl -fsSL https://raw.githubusercontent.com/AshmitGupta-slbs/king-gong-hackathon/main/install.sh | bash
#
# Installs prerequisites (a new-enough Node), fetches the repo, installs dependencies, and runs
# setup.sh -- which asks for your keys and then proves the whole pipeline on a real call.
# Safe to re-run: it updates instead of reinstalling. macOS is first-class; Linux works; on Windows
# use WSL.
#
# Override defaults with env vars:
#   KIT_REPO=<git url>   where the code lives
#   TARGET=<dir>         where to clone it (default ./king-gong in the current directory)
#   BRANCH=<name>        which branch to check out (default main)
#
# NOTE FOR EDITORS: keep this file pure ASCII. The reference installer this is ported from shipped a
# bug where a Unicode ellipsis sitting after a "$var" made bash report "unbound variable" partway
# through a run. No smart quotes, no ellipses, no arrows.
set -euo pipefail

# --- robustness for `curl | bash` -------------------------------------------
# When piped, this script's own body arrives on stdin. Anything that reads stdin later -- our
# interactive prompts, or nvm's installer -- would consume the rest of the script instead of the
# keyboard, and the run dies halfway through with a confusing error. Re-download to a temp file and
# re-exec with the terminal as stdin, so reads come from a human and the script comes from a file.
SELF_URL="${SELF_URL:-https://raw.githubusercontent.com/AshmitGupta-slbs/king-gong-hackathon/main/install.sh}"
if [ -z "${KG_REEXEC:-}" ] && [ ! -t 0 ] && [ -r /dev/tty ]; then
  _self="$(mktemp 2>/dev/null || mktemp -t kg-install)"
  if curl -fsSL "$SELF_URL" -o "$_self" 2>/dev/null && [ -s "$_self" ]; then
    KG_REEXEC=1 exec bash "$_self" </dev/tty
  fi
  rm -f "$_self"
fi

KG_REPO="${KIT_REPO:-https://github.com/AshmitGupta-slbs/king-gong-hackathon.git}"
KG_TARGET="${TARGET:-$PWD/king-gong}"
KG_BRANCH="${BRANCH:-main}"

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m%s %s\033[0m\n' "OK" "$*"; }
warn() { printf '\033[1;33m%s %s\033[0m\n' "!" "$*"; }
die()  { printf '\033[1;31m%s %s\033[0m\n' "x" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux)  OS=linux ;;
  *) die "Unsupported OS '$(uname -s)'. On Windows, run this inside WSL (Ubuntu)." ;;
esac
ok "Platform: $OS"

# --- git: fatal, and genuinely needed later ---------------------------------
# Not just for cloning: scripts/check-ship.ts shells out to `git check-ignore` rather than parsing
# .gitignore itself, so git is a runtime dependency of the checks too.
if ! have git; then
  if [ "$OS" = mac ]; then
    die "git is required. Run 'xcode-select --install' (it installs git), then re-run this."
  fi
  die "git is required. Install it ('sudo apt install git' on Debian/Ubuntu) and re-run this."
fi

# Deliberately NOT required, and worth saying so because both are easy to assume:
#   python3 - only used by docs/site/build.py, which regenerates docs that are committed anyway.
#   ffmpeg  - never used. All audio work is 16-bit PCM handled in pure Node (lib/wav.ts).

# --- fetch or update the repo ------------------------------------------------
if [ -d "$KG_TARGET/.git" ]; then
  say "Updating the existing checkout at $KG_TARGET"
  git -C "$KG_TARGET" pull --ff-only \
    || warn "Could not fast-forward $KG_TARGET (local changes?). Continuing with what is there."
elif [ -e "$KG_TARGET" ] && [ -n "$(ls -A "$KG_TARGET" 2>/dev/null || true)" ]; then
  die "$KG_TARGET exists and is not a git checkout. Move it aside, or set TARGET=<dir> and re-run."
else
  say "Cloning into $KG_TARGET"
  git clone --branch "$KG_BRANCH" "$KG_REPO" "$KG_TARGET" \
    || die "Clone failed. Check KIT_REPO ($KG_REPO), BRANCH ($KG_BRANCH), and your network."
fi
ok "Code ready at $KG_TARGET"

cd "$KG_TARGET"

# --- Node ------------------------------------------------------------------
# The repo ships its own capability check (scripts/node-check.cjs) and that is the authority here, not
# a version comparison in bash. It asks Node whether `node:sqlite` actually loads, because the version
# number alone is misleading: node:sqlite appeared in 22.5.0 but stayed behind --experimental-sqlite
# until 22.13.0, so 22.5 through 22.12 look fine and fail at the first database call.
#
# Duplicating that logic here would give us two answers that could disagree. Instead: make sure SOME
# node exists, then let the repo's own check rule on it.
node_ok() { have node && node scripts/node-check.cjs >/dev/null 2>&1; }

# `nvm.sh` cannot be sourced under `set -euo pipefail`, and this cost a real debugging session.
#
# nvm's own script reads variables it has not set, which `set -u` treats as fatal -- and an unbound
# variable kills the shell even inside an `||` chain, where errexit would have been suppressed. The
# symptom is the worst kind: the installer printed "Getting Node" and then vanished with a bare exit
# code, no message, nothing to search for. (The reference installer this is ported from carries a
# commit fixing an "unbound variable" of a different origin; same class of trap.)
#
# So both options are relaxed around the source and restored immediately after.
load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] || return 1
  set +eu
  # shellcheck disable=SC1090,SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  set -eu
  command -v nvm >/dev/null 2>&1
}

install_via_nvm() {
  if ! load_nvm; then
    say "Installing nvm (no admin rights needed)"
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      git clone --depth 1 https://github.com/nvm-sh/nvm.git "$NVM_DIR" >/dev/null 2>&1 || return 1
    fi
    load_nvm || return 1
  fi
  # No argument on purpose: run from the repo root, `nvm install` reads .nvmrc, so the version the
  # repo asks for is the version installed. One source of truth.
  say "Installing the Node version this repo asks for (.nvmrc: $(cat .nvmrc 2>/dev/null || echo '?'))"
  # nvm's subcommands are as hostile to `set -e` as its loader is to `set -u`.
  set +eu
  nvm install </dev/null >/dev/null 2>&1
  nvm use </dev/null >/dev/null 2>&1
  set -eu
  command -v node >/dev/null 2>&1 || return 1
  return 0
}

install_via_brew() {
  have brew || return 1
  say "Installing Node via Homebrew"
  brew install node@24 >/dev/null 2>&1 || return 1
  brew link --overwrite --force node@24 >/dev/null 2>&1 || true
  return 0
}

install_via_tarball() {
  [ "$OS" = mac ] || return 1
  have curl || return 1
  case "$(uname -m)" in
    arm64) ARCH=darwin-arm64 ;;
    x86_64) ARCH=darwin-x64 ;;
    *) return 1 ;;
  esac
  # Resolve the newest 24.x filename from the directory listing, so this does not rot against a
  # hardcoded patch version. Grep rather than jq, because jq is another thing to install.
  say "Fetching the official Node tarball ($ARCH) into ~/.local"
  local file
  file="$(curl -fsSL "https://nodejs.org/dist/latest-v24.x/" 2>/dev/null \
    | grep -o "node-v24\.[0-9.]*-${ARCH}\.tar\.xz" | head -1)" || return 1
  [ -n "$file" ] || return 1
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/${file}" -o "$tmp/node.tar.xz" || return 1
  mkdir -p "$HOME/.local"
  tar -xJf "$tmp/node.tar.xz" -C "$HOME/.local" --strip-components=1 || return 1
  rm -rf "$tmp"
  export PATH="$HOME/.local/bin:$PATH"
  return 0
}

if node_ok; then
  ok "Node is new enough ($(node -v))"
else
  if have node; then
    warn "Node $(node -v) is present but too old for this app. Getting a newer one."
  else
    say "Node is not installed. Getting it."
  fi
  # nvm first: no admin rights, honours .nvmrc, and does not touch a system Node someone else's work
  # depends on. Homebrew second -- it is absent on plenty of Macs, so leading with it would mean
  # installing a package manager in order to install a runtime. Tarball last, always works.
  install_via_nvm || install_via_brew || install_via_tarball || true

  if ! node_ok; then
    printf '\n'
    have node && node scripts/node-check.cjs || true
    die "Could not get a usable Node automatically. Follow one of the options above, then re-run: cd $KG_TARGET && ./setup.sh"
  fi
  ok "Node ready ($(node -v))"
fi

# --- dependencies -----------------------------------------------------------
# `npm ci` rather than `npm install`: package-lock.json is committed, and a reproducible install is
# the whole point of a one-command setup. No native modules and no postinstall hook, so this runs no
# project code.
say "Installing dependencies (npm ci)"
npm ci --no-audit --no-fund || die "npm ci failed. Scroll up for the reason; then re-run this script."
ok "Dependencies installed"

# --- hand off to the interactive part ---------------------------------------
chmod +x ./setup.sh ./kg 2>/dev/null || true
printf '\n'
say "Running setup: it asks for your keys, then proves the pipeline on a real call."
printf '\n'
./setup.sh
