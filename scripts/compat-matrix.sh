#!/usr/bin/env bash
#
# The compatibility matrix, in one command: which opencode versions, on which
# platforms, driving which agents.
#
# The full product would be 3 platforms × 15 releases × 8 agents = 360 cells, and
# most of them would re-test the same thing. The three axes are INDEPENDENT, so each
# one gets its own layer instead of a cross product:
#
#   layer 1  unit tests     every platform × the version BOUNDARIES      (~15 min, no tokens)
#   layer 2  real TUI       the platforms WITH a terminal × boundaries   (~40 min, no tokens)
#   layer 3  real agents    the newest release, one machine              (~1 h, spends tokens)
#
# Boundaries, not all fifteen releases: 2.0.0 is the declared floor, 2.1.0 added the todo
# event vocabulary, 2.2.7 is newest. The twelve in between are covered by the per-release
# diff recorded in docs/COMPAT-OPENCODE.md — a full gate per release would spend five
# hours re-proving that HTTP still works.
#
# Windows gets layer 1 and no more, which is what opencode itself does: its TUI tests are
# component tests (`.test.tsx`), its e2e is Playwright against the WEB app, and it has no
# terminal-level TUI automation on any platform. We add the terminal layer on the
# platforms that have one, because the risk WE carry — does the bridge's event stream
# render — is exactly what component tests cannot see.
#
# Usage:
#   bash scripts/compat-matrix.sh                  # layers 1 and 2 (no tokens)
#   bash scripts/compat-matrix.sh --with-agents    # + layer 3 (SPENDS TOKENS)
#   LAYERS=1 bash scripts/compat-matrix.sh         # just the quick one
#   VERSIONS="2.0.0 2.2.7" bash scripts/compat-matrix.sh
#   AGENTS=openclaude,dsh bash scripts/compat-matrix.sh --with-agents
#
# Exit status: 0 only if every cell that ran passed.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

# Our own tmux socket: nothing else on this machine uses it, so the cleanup can be total
# without touching a run that is still going.
TMUX_SOCK="oac-e2e-matrix-$$"

LAYERS="${LAYERS:-1,2}"
VERSIONS="${VERSIONS:-2.0.0 2.1.0 2.2.7}"
AGENTS="${AGENTS:-opencode,dsh,dsh-acp,qwen,claude,codex,gemini}"
WITH_AGENTS=0
for arg in "$@"; do
  case "$arg" in
    --with-agents) WITH_AGENTS=1 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[ "$WITH_AGENTS" = 1 ] && LAYERS="1,2,3"

ART="$REPO/.artifacts/compat-matrix"
mkdir -p "$ART"
STAMP="$(date +%Y%m%d-%H%M%S)"
SUMMARY="$ART/summary-$STAMP.txt"
: > "$SUMMARY"

has() { case ",$LAYERS," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# ★ Kill what this script started, however it ends. Measured the hard way: a run that died
# mid-cell left `tmux -L oac-e2e-… new-session` reparented to pid 1 with its bridge still
# holding a port and a workspace lock — invisible in `tmux ls` (that socket only lists while
# a client is attached), and it blocked the next run's `session/load`.
#
# Scoped to OUR socket prefix and OUR port range: never `pkill tmux`, which would take the
# user's own sessions, and never a name-based kill of anything else.
CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return
  CLEANED=1
  # Our own tmux socket only. Globbing `/tmp/tmux-*/oac-e2e-*` killed every CONCURRENT run's
  # server, and that run then died with "no server running on …" at its first pane capture.
  tmux -L "$TMUX_SOCK" kill-server 2>/dev/null || true
  # Every descendant of this script. Walked from our own pid rather than pattern-matched on
  # the bridge's command line, because that also matched a bridge another run was using.
  #
  # The pid list is collected FIRST and killed second: if the `while` that kills is itself
  # part of the ps|awk|while pipeline, it kills its own reader and the shell prints
  # "Killed: 9" right after "compat matrix passed" — noise that reads like a failure.
  local victims
  victims="$(ps -o pid= -o ppid= -ax 2>/dev/null | awk -v root="$$" '
    { ppid[$1] = $2 }
    END {
      ours[root] = 1; changed = 1
      while (changed) {
        changed = 0
        for (p in ppid) if (!(p in ours) && (ppid[p] in ours)) { ours[p] = 1; changed = 1 }
      }
      for (p in ours) if (p != root) print p
    }')"
  local pid
  for pid in $victims; do
    kill -9 "$pid" 2>/dev/null || true
  done
}
# ★ TERM/INT must EXIT, not just run cleanup: a handler that returns lets the script carry
# on after the signal, and the children it already spawned keep the port. Measured — killing
# the matrix with SIGTERM left `node dist/index.js --bridge-port 4811` listening, which then
# made the NEXT run's bridge die with EADDRINUSE and every cell after it fail on a bridge
# that was never this run's.
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

record() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }

# ★ Reuse the one gate script rather than reimplementing it: it already knows how to install
# a release privately (never touching ~/.opencode), how to point the real-TUI step at that
# binary, and what a pass means. This script only decides WHICH cells to run.
gate() {  # $1 = version, or a path to a binary
  local version="$1"; shift
  local label="v$version" log
  case "$version" in
    /*|./*|../*)
      # A path is labelled by the version it REPORTS, not by its directory: `.../bin/opencode`
      # came out as "vbin" in the first smoke run, which tells a reader nothing.
      label="$("$version" --version 2>/dev/null | head -1)"
      [ -n "$label" ] || label="$(basename "$version")"
      log="$ART/path.log" ;;
    *) log="$ART/v$version.log" ;;
  esac
  # `label` is already "opencode v2.2.7" for a path and "v2.2.7" for a version string;
  # prefixing both produced "▸ opencode opencode v2.2.7" in the first run.
  case "$label" in
    opencode*) record "▸ $label" ;;
    *) record "▸ opencode $label" ;;
  esac
  if env "$@" bash scripts/check-opencode-version.sh "$version" >"$log" 2>&1; then
    record "  ✓ $label"
    return 0
  fi
  record "  ✗ $label  (log: $log)"
  grep -E '^ +✗' "$log" | head -5 | sed 's/^/    /' | tee -a "$SUMMARY"
  return 1
}

FAILED=0
RAN=0
cell() { RAN=$((RAN + 1)); "$@" || FAILED=$((FAILED + 1)); }

record "▸ compat matrix — layers $LAYERS"
record "  versions: $VERSIONS"
record "  artifacts: $ART"
record ""

# ── layer 1: unit tests on every platform, at the version boundaries ────────────────
# This layer answers "does the code run here at all" — quoting, signals, paths. The real
# TUI cannot run on Windows (no tmux), so a Windows cell here is the whole of Windows.
if has 1 || has 2; then
  record "── layers 1+2: unit tests AND the real TUI in tmux, per version"
  record "   (one gate run covers both: the gate script runs typecheck, unit tests, the"
  record "    OpenAPI surface, then the real TUI. Splitting them would install each version"
  record "    twice to prove the same thing.)"
  for v in $VERSIONS; do
    cell gate "$v"
  done
  record ""
fi

# ── layer 3: real agents, newest release, this machine only ─────────────────────────
# ★ Deliberately NOT crossed with versions: an agent's behaviour is its own. Crossing them
# would multiply the token cost and teach nothing.
#
# ★ Deliberately NOT in CI: it needs real model credentials, and putting them in a CI
# secret would expose them to every workflow run.
if has 3; then
  record "── layer 3: real agents against v2.2.7 (SPENDS TOKENS)"
  record "  agents: $AGENTS"
  if ONLY="$AGENTS" bash scripts/e2e-agent-matrix.sh >"$ART/agents.log" 2>&1; then
    cell true
    record "  ✓ agents"
  else
    cell false
    record "  ✗ agents  (log: $ART/agents.log)"
    grep -E '^\s*✗' "$ART/agents.log" | head -8 | sed 's/^/    /' | tee -a "$SUMMARY"
  fi
  record ""
fi

record "── $RAN cell(s), $FAILED failed"
record "   summary: $SUMMARY"
[ "$FAILED" = 0 ] || exit 1
echo "✓ compat matrix passed"
