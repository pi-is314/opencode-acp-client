#!/usr/bin/env node
/**
 * A stand-in for the opencode TUI, so the **single entry point** can be
 * exercised end to end without a real opencode install.
 *
 * It answers `--version` exactly the way the real binary does (that is what the
 * v2 gate parses) and otherwise behaves like a TUI that has opened:
 *
 *   FAKE_TUI_SLEEP_MS=<ms>  stay in the foreground this long (default 0 = quit at once)
 *   FAKE_TUI_EXIT=<code>    exit with this code (default 0)
 *   FAKE_TUI_ARGS=<path>    write our argv there, to assert what we were launched with
 *
 * The point of the sleep mode is the shutdown half of the contract: killed by
 * PID, it must exit, and the process that launched it must not be left behind.
 */

import { writeFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('opencode v2.0.26\n');
  process.exit(0);
}

if (process.env.FAKE_TUI_ARGS) {
  try {
    writeFileSync(process.env.FAKE_TUI_ARGS, JSON.stringify(process.argv.slice(2), null, 2));
  } catch {
    /* diagnostics only */
  }
}

const exitCode = Number(process.env.FAKE_TUI_EXIT ?? '0');
const sleepMs = Number(process.env.FAKE_TUI_SLEEP_MS ?? '0');

if (!Number.isFinite(sleepMs) || sleepMs <= 0) {
  process.exit(Number.isFinite(exitCode) ? exitCode : 0);
}

// An idle TUI: it leaves when asked, and reports the code it was told to.
const leave = (code) => process.exit(Number.isFinite(code) ? code : 0);
process.on('SIGTERM', () => leave(exitCode));
process.on('SIGINT', () => leave(exitCode));
setTimeout(() => leave(exitCode), sleepMs);
