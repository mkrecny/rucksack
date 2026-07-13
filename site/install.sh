#!/usr/bin/env bash
# rucksack installer — https://rucksack.sh
# Keeps your local coding agents running while your MacBook rides in the bag.
#
#   curl -fsSL https://rucksack.sh/install | bash
#
# Overrides:
#   RUCKSACK_REPO  git URL to install from (default: the canonical repo)
#   RUCKSACK_HOME  where to keep the checkout (default: ~/.rucksack/app)
#   RUCKSACK_REF   git tag/branch to pin (default: main). Pin a release, e.g.
#                  curl -fsSL https://rucksack.sh/install | RUCKSACK_REF=v0.2.0 bash

set -euo pipefail

REPO_URL="${RUCKSACK_REPO:-https://github.com/mkrecny/rucksack.git}"
INSTALL_DIR="${RUCKSACK_HOME:-$HOME/.rucksack/app}"
REF="${RUCKSACK_REF:-}"

say()  { printf '  \033[36m\xe2\x96\x9e\xe2\x96\x9a rucksack\033[0m \xc2\xb7 %s\n' "$*"; }
fail() { printf '  \033[31m\xe2\x96\x9e\xe2\x96\x9a rucksack\033[0m \xc2\xb7 %s\n' "$*" >&2; exit 1; }

printf '\n'
say "packing up..."

HOST_OS="$(uname -s)"
if [ "$HOST_OS" = "Darwin" ]; then
  say "checking macOS ............ OK"
elif [ "$HOST_OS" = "Linux" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  say "checking WSL .............. OK (experimental Windows backend)"
else
  fail "Rucksack needs macOS or Windows-under-WSL (found $HOST_OS)."
fi

command -v node >/dev/null 2>&1 || fail "Node.js 20+ is required. Install from https://nodejs.org or: brew install node"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20+ is required (found $(node -v))."
say "checking node >= 20 ....... OK ($(node -v))"

command -v git >/dev/null 2>&1 || fail "git is required (xcode-select --install)."

if [ -d "$INSTALL_DIR/.git" ]; then
  say "updating existing install in $INSTALL_DIR${REF:+ ($REF)}"
  if [ -n "$REF" ]; then
    git -C "$INSTALL_DIR" fetch --depth 1 --quiet origin "$REF" \
      && git -C "$INSTALL_DIR" checkout --quiet FETCH_HEAD \
      || fail "could not update $INSTALL_DIR to $REF"
  else
    git -C "$INSTALL_DIR" pull --ff-only --quiet || fail "could not update $INSTALL_DIR"
  fi
else
  say "fetching into $INSTALL_DIR${REF:+ ($REF)}"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ -n "$REF" ]; then
    git clone --depth 1 --branch "$REF" --quiet "$REPO_URL" "$INSTALL_DIR" \
      || fail "could not clone $REPO_URL at $REF — check RUCKSACK_REF, or set RUCKSACK_REPO if the repo moved."
  else
    git clone --depth 1 --quiet "$REPO_URL" "$INSTALL_DIR" \
      || fail "could not clone $REPO_URL — if the repo moved, set RUCKSACK_REPO and re-run."
  fi
fi

npm install --global --silent "$INSTALL_DIR" \
  || fail "npm install -g failed. See https://docs.npmjs.com/resolving-eacces-permissions-errors"
say "installing CLI ............ OK"

printf '\n'
say "packed. try:"
printf '\n'
printf '      rucksack init --hotspot "My iPhone"\n'
printf '      rucksack doctor\n'
printf '      rucksack pack --lid-closed --yes --watch\n'
printf '\n'
