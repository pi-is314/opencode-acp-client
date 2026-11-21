#!/usr/bin/env bash
#
# Watch opencode's own release feed and hand a new v2 tag to the gate.
#
# Contract/trigger: a new upstream release (>= 2.0.0) must be judged by the whole
#   gate against that exact binary. Run on a timer (`--once` from cron/launchd) or
#   as a loop (`--interval <seconds>`).
# Boundary: the releases ATOM FEED (no API quota), then either a
#   `repository_dispatch` to this repo's workflow or a local gate run.
# Oracles: the tag read from the feed, the state file, the dispatch API's status,
#   and the gate's exit code.
# Negative controls: a failed gate does NOT advance the "seen" tag, so the next
#   run retries it; a pre-release or a v1 tag is ignored with a reason; a busy
#   lock skips the run instead of stacking two gates (one TUI at a time).
#
#   bash scripts/watch-opencode-releases.sh --once --dry-run
#   bash scripts/watch-opencode-releases.sh --once --dispatch   # needs GH token
#   bash scripts/watch-opencode-releases.sh --once --run        # local gate (15 min)
#   bash scripts/watch-opencode-releases.sh --interval 1800 --notify
#
set -uo pipefail

FEED_URL="${FEED_URL:-https://github.com/anomalyco/opencode/releases.atom}"
STATE_DIR="${OPENCODE_ACP_CLIENT_STATE:-$HOME/.opencode-acp-client}"
STATE_FILE="${STATE_FILE:-$STATE_DIR/opencode-release-seen}"
LOG_FILE="${LOG_FILE:-$STATE_DIR/opencode-release-watch.log}"
REPO="${GITHUB_REPOSITORY:-}"
MODE=""
ONCE=""
INTERVAL=""
DRY_RUN=""
NOTIFY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --once) ONCE=1 ;;
    --interval) INTERVAL="${2:?--interval needs seconds}"; shift ;;
    --dispatch) MODE="dispatch" ;;
    --run) MODE="run" ;;
    --dry-run) DRY_RUN=1 ;;
    --notify) NOTIFY=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$ONCE$INTERVAL" ] || { echo "choose --once or --interval <seconds>" >&2; exit 2; }
[ -n "$MODE" ] || MODE="dispatch"
mkdir -p "$STATE_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2; }

notify() {
  [ -n "$NOTIFY" ] || return 0
  command -v osascript >/dev/null 2>&1 || return 0
  osascript -e "display notification \"$1\" with title \"opencode release gate\"" >/dev/null 2>&1 || true
}

# One gate at a time: two TUI-driving runs on one machine corrupt each other.
LOCK="$STATE_DIR/watch.lock"
take_lock() {
  if mkdir "$LOCK" 2>/dev/null; then
    echo $$ > "$LOCK/pid"
    trap 'rm -rf "$LOCK"' EXIT INT TERM
    return 0
  fi
  local holder
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    log "another watcher/gate is running (pid $holder); skipping"
    return 1
  fi
  log "removing a stale lock (pid ${holder:-unknown})"
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null && echo $$ > "$LOCK/pid" && trap 'rm -rf "$LOCK"' EXIT INT TERM
}

check_once() {
  local feed tag seen newest
  feed="$(curl -fsSL --max-time 25 "$FEED_URL")" || { log "could not fetch $FEED_URL"; return 1; }
  # Newest entry first in the feed; the title is the tag (e.g. `v2.0.32`).
  tag="$(printf '%s' "$feed" | grep -o '<title>[^<]*</title>' | sed -n '2p' | sed 's/<[^>]*>//g')"
  [ -n "$tag" ] || tag="$(printf '%s' "$feed" | grep -o 'releases/tag/v[0-9][^"]*' | head -1 | sed 's#releases/tag/##')"
  [ -n "$tag" ] || { log "no release tag found in the feed"; return 1; }
  tag="${tag#v}"

  case "$tag" in
    2.*.*) ;;
    *) log "newest release is $tag, outside the supported v2 range; ignoring"; return 0 ;;
  esac
  case "$tag" in
    *-*) log "$tag looks like a pre-release; ignoring"; return 0 ;;
  esac

  seen="$(cat "$STATE_FILE" 2>/dev/null || true)"
  if [ "$tag" = "$seen" ]; then
    log "no new release (still v$tag)"
    return 0
  fi
  if [ -n "$seen" ]; then
    newest="$(printf '%s\n%s\n' "$seen" "$tag" | sort -V | tail -1)"
    if [ "$newest" != "$tag" ]; then
      log "feed has v$tag, older than the verified v$seen; ignoring"
      return 0
    fi
  fi

  log "new opencode release: v$tag (last verified: ${seen:-none}); mode=$MODE"
  if [ -n "$DRY_RUN" ]; then
    log "dry run: would $MODE v$tag"
    return 0
  fi

  if [ "$MODE" = "dispatch" ]; then
    if [ -z "$REPO" ]; then
      log "GITHUB_REPOSITORY is not set; cannot dispatch (set it, or use --run)"
      return 1
    fi
    if ! command -v gh >/dev/null 2>&1; then
      log "gh is not installed; cannot dispatch (use --run to gate locally)"
      return 1
    fi
    if gh api "repos/$REPO/dispatches" \
        -f event_type=opencode-release \
        -f "client_payload[version]=v$tag" >/dev/null 2>&1; then
      log "dispatched opencode-release for v$tag"
      printf '%s\n' "$tag" > "$STATE_FILE"
      notify "dispatched v$tag"
      return 0
    fi
    log "dispatch failed (token/permissions?); the gate will retry next run"
    return 1
  fi

  # Local gate: the same script CI runs, against that exact version.
  log "running the whole gate against v$tag (this takes ~15 minutes)"
  if bash scripts/check-opencode-version.sh "$tag" >>"$STATE_DIR/opencode-release-gate.log" 2>&1; then
    log "v$tag passed the gate"
    printf '%s\n' "$tag" > "$STATE_FILE"
    notify "v$tag passed the gate"
    return 0
  fi
  log "v$tag FAILED the gate; not advancing the seen tag, so the next run retries"
  notify "v$tag failed the gate"
  return 1
}

if [ -n "$ONCE" ]; then
  take_lock || exit 0
  check_once
  exit $?
fi

log "watching $FEED_URL every ${INTERVAL}s (mode=$MODE)"
while :; do
  if take_lock; then check_once || true; fi
  sleep "$INTERVAL"
done
