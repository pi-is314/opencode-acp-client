#!/usr/bin/env bash
#
# Push the current checkout to the other machines this repo is verified on.
#
#   bash scripts/sync-to-remote.sh linux     # -> remote Linux box
#   bash scripts/sync-to-remote.sh windows   # -> the Windows VM
#   bash scripts/sync-to-remote.sh all
#
# ★ Why a bundle and not a copy. The files that matter are the ones git tracks, and the
# branch under test is usually NOT pushed (the owner runs the same branch on three machines
# before it exists anywhere else). `scp`-ing individual files — what was done by hand — puts
# the burden on the person to remember every file; one forgotten `src/*.ts` makes the other
# machine verify something else entirely, and the failure looks like a bug in the code.
# `git bundle` ships the exact commit, and the receiving side checks it out by SHA.
#
# Configuration (environment, or the defaults below):
#   LINUX_SSH   ssh target for the Linux box            (REQUIRED, no default: a personal
#                                                       username or address does not belong in
#                                                       a public repo)
#   LINUX_DIR   checkout directory there                (default: /tmp/oac)
#   WIN_SSH     ssh target for the Windows VM           (default: poet@127.0.0.1)
#   WIN_PORT    Windows ssh port                        (default: 2222)
#   WIN_DIR     checkout directory there                (default: C:/oac)
#
# Windows has no rsync and its git is the only transport we can rely on, which is another
# reason the bundle is the shape: `git bundle` + `git fetch` works identically on all three.
set -euo pipefail

LINUX_SSH="${LINUX_SSH:-}"
LINUX_DIR="${LINUX_DIR:-/tmp/oac}"
WIN_SSH="${WIN_SSH:-$(whoami)@127.0.0.1}"
WIN_PORT="${WIN_PORT:-2222}"
WIN_DIR="${WIN_DIR:-C:/oac}"

TARGET="${1:-all}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
BUNDLE="$(mktemp -t oac-sync).bundle"

cleanup() { rm -f "$BUNDLE"; }
trap cleanup EXIT

echo "▸ bundling $BRANCH @ ${SHA:0:7}"
# `HEAD` only: the receiving side needs exactly this commit, not the whole history.
git -C "$ROOT" bundle create "$BUNDLE" "$BRANCH" --quiet 2>/dev/null \
  || git -C "$ROOT" bundle create "$BUNDLE" HEAD --quiet

sync_linux() {
  if [ -z "$LINUX_SSH" ]; then
    echo "✗ LINUX_SSH is not set (e.g. LINUX_SSH=user@host bash scripts/sync-to-remote.sh linux)" >&2
    return 1
  fi
  echo "▸ linux: $LINUX_SSH:$LINUX_DIR"
  ssh -o ConnectTimeout=15 "$LINUX_SSH" "mkdir -p '$LINUX_DIR'"
  # The bundle must exist ON THE FAR SIDE before `git fetch` can read it — a path that only
  # exists locally reads as "not a git repository" there, which is exactly what happened the
  # first time.
  scp -q -o ConnectTimeout=15 "$BUNDLE" "$LINUX_SSH:$LINUX_DIR/.sync.bundle"
  ssh "$LINUX_SSH" bash -s -- "$LINUX_DIR" "$SHA" "$BRANCH" <<'REMOTE'
set -euo pipefail
cd "$1"
# A directory that arrived by rsync (no .git) or an older bundle fetch leaves tracked files in
# the way of the checkout. `checkout -f` is correct here: this directory exists to mirror a
# commit, and anything uncommitted in it is a test artefact.
if [ ! -d .git ]; then
  git init -q .
fi
# The bundle's ref is literally `HEAD`; a bare `fetch … HEAD` is rejected on older git, so
# the refspec names both sides.
git fetch -q ./.sync.bundle "+refs/heads/$3:refs/sync/incoming" \
  || git fetch -q "./.sync.bundle" "+refs/heads/$3:refs/sync/incoming"
git checkout -q -f --detach "$2"
# Files that are not in the bundle (deleted upstream, or rsync leftovers) would otherwise sit
# there and be picked up by vitest's globbing. Only untracked, ignored files are protected.
git clean -q -fd -e node_modules -e dist -e .artifacts -e .cache
echo "  ✓ linux now at $(git rev-parse --short HEAD)"
REMOTE
}

sync_windows() {
  echo "▸ windows: $WIN_SSH:$WIN_PORT  $WIN_DIR"
  # sshpass is used only because the VM has no key; `-e` keeps the password out of argv.
  local sshcmd scpcmd
  if command -v sshpass >/dev/null && [ -n "${SSHPASS:-}" ]; then
    sshcmd=(sshpass -e ssh -p "$WIN_PORT" -o StrictHostKeyChecking=no)
    scpcmd=(sshpass -e scp -P "$WIN_PORT" -o StrictHostKeyChecking=no)
  else
    sshcmd=(ssh -p "$WIN_PORT" -o StrictHostKeyChecking=no)
    scpcmd=(scp -P "$WIN_PORT" -o StrictHostKeyChecking=no)
  fi
  "${scpcmd[@]}" -q "$BUNDLE" "$WIN_SSH:$WIN_DIR/.sync.bundle"
  # Windows: `cmd /c` with an explicit PATH, because a non-interactive ssh session has none
  # of the node/git directories (the same reason every command in this repo's Windows notes
  # spells the PATH out).
  "${sshcmd[@]}" "$WIN_SSH" \
    "cmd /c \"set PATH=C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd;%APPDATA%\\npm;%PATH% && cd /d $WIN_DIR && git fetch -q ./.sync.bundle +refs/heads/$BRANCH:refs/sync/incoming && git checkout -q -f --detach $SHA && git rev-parse --short HEAD\""
}

case "$TARGET" in
  linux) sync_linux ;;
  windows) sync_windows ;;
  all) sync_linux; sync_windows ;;
  *) echo "usage: $0 [linux|windows|all]" >&2; exit 2 ;;
esac

echo "✓ done — every machine is at ${SHA:0:7} ($BRANCH)"
