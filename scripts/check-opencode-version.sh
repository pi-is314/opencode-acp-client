#!/usr/bin/env bash
#
# Verify this bridge against one specific opencode v2 build.
#
#   scripts/check-opencode-version.sh --path ~/.opencode/bin/opencode
#   scripts/check-opencode-version.sh 2.0.27        # installs that release, privately
#   scripts/check-opencode-version.sh latest-v2     # newest release >= 2.0.0
#
# Versions come from the **npm registry** (`@opencode/cli`), which has no rate
# limit and no token requirement, and which is the channel v2 itself publishes
# to. The releases atom feed is the fallback. Two traps this avoids, both hit
# while writing it:
#   - the GitHub API rate-limits an unauthenticated host, and a rate-limited
#     watcher sees "no releases" and stays green forever;
#   - `opencode.ai/install` (no `/v2/`) is the **v1** installer: it resolves
#     `latest` for the v1 line and its release assets do not exist for v2, so it
#     fails with an unzip error rather than a clear "wrong channel".
#
# The install never touches your `~/.opencode`: npm installs into a temporary
# prefix, and the fallback installer runs with `HOME` pointed at a temporary
# directory (its `INSTALL_DIR` is hard-coded to `$HOME/.opencode/bin`). Writing
# next to your own binary would be a rude thing for a test script to do.
#
# CI is only a timer around this script — see
# .github/workflows/opencode-release.yml — so the version gate can always be
# reproduced locally, byte for byte.
#
# Exit status: 0 only if the binary reports a supported major AND `pnpm verify`
# passes against it.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FEED="https://github.com/anomalyco/opencode/releases.atom"
INSTALLER="https://opencode.ai/v2/install"
NPM_PACKAGE="@opencode/cli"
MIN_MAJOR=2

REQUEST="${1:-latest-v2}"
MODE=install
BIN=""
case "$REQUEST" in
  --path) MODE=path; BIN="${2:-}" ;;
  --path=*) MODE=path; BIN="${REQUEST#--path=}" ;;
  /*|./*|../*) MODE=path; BIN="$REQUEST" ;;
esac

die() { printf '✗ %s\n' "$1" >&2; exit 1; }
note() { printf '  %s\n' "$1"; }

# Newest published version whose major is >= MIN_MAJOR. npm first (no quota,
# no token, and it is what v2 actually publishes to); the release feed after that.
newest_supported_tag() {
  local from_npm
  from_npm="$(npm view "$NPM_PACKAGE" versions --json 2>/dev/null \
    | tr -d '[]" ' | tr ',' '\n' \
    | awk -F. -v min="$MIN_MAJOR" 'NF >= 3 && $1+0 >= min' \
    | sort -V | tail -1)"
  if [ -n "$from_npm" ]; then
    printf '%s\n' "$from_npm"
    return 0
  fi
  curl -fsSL "$FEED" \
    | grep -o '<title>v[0-9][0-9.]*</title>' \
    | sed 's/<[^>]*>//g; s/^v//' \
    | awk -F. -v min="$MIN_MAJOR" '$1+0 >= min' \
    | sort -V \
    | tail -1
}

major_of() {
  "$1" --version 2>/dev/null | sed -n 's/.*v\([0-9][0-9]*\)\..*/\1/p' | head -1
}

if [ "$MODE" = "path" ]; then
  [ -n "$BIN" ] || die "--path needs a binary"
  [ -x "$BIN" ] || die "not executable: $BIN"
  note "using $BIN as given (nothing installed)"
else
  if [ "$REQUEST" = "latest-v2" ]; then
    REQUEST="$(newest_supported_tag)"
    [ -n "$REQUEST" ] || die "no release >= ${MIN_MAJOR}.0.0 in $FEED"
    note "newest supported release: v$REQUEST"
  fi
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  note "installing $NPM_PACKAGE@$REQUEST into $WORK — your ~/.opencode is untouched"
  if npm install -g --prefix "$WORK" "$NPM_PACKAGE@$REQUEST" >"$WORK/npm.log" 2>&1; then
    BIN="$WORK/bin/opencode"
  else
    note "npm could not install it; falling back to the official v2 installer"
    HOME="$WORK" bash -c "curl -fsSL '$INSTALLER' | bash -s -- --version '$REQUEST'" \
      || die "neither npm nor the official installer could provide v$REQUEST (see $WORK/npm.log)"
    BIN="$WORK/.opencode/bin/opencode"
  fi
  [ -x "$BIN" ] || die "installation produced no runnable binary at $BIN"
fi

note "binary: $BIN"
RAW="$("$BIN" --version 2>&1 | head -1)"
note "reports: $RAW"
MAJOR="$(major_of "$BIN")"
[ -n "$MAJOR" ] || die "could not read a version out of: $RAW"
[ "$MAJOR" -ge "$MIN_MAJOR" ] \
  || die "v$MAJOR is below the supported major ($MIN_MAJOR) — v1 speaks a different event vocabulary, so nothing below would mean anything"

# The real-TUI step must use this binary, not whatever is first on PATH.
export OC="$BIN"
export OPENCODE_BIN="$BIN"

printf '\n▸ verifying against %s\n' "$RAW"
bash "$REPO/scripts/verify.sh" || die "verify failed against $RAW"

printf '\n✓ %s passes the whole gate\n' "$RAW"
