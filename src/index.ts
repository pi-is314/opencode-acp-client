#!/usr/bin/env node
/**
 * CLI entry: `oc-acp-client -- <agent command> [args...]`
 *
 * This is the CLI of an ACP **client**: the process speaks ACP to the agent on
 * stdio and serves the opencode v2 HTTP/SSE surface, so the opencode v2 TUI can
 * be its interface. Any ACP agent works - the agent is whatever follows `--`.
 *
 * The agent command is everything after `--`, so we never have to understand
 * another tool's flag syntax:
 *
 *   oc-acp-client -- <agent command> [args...]
 *   oc-acp-client -- <agent command> [args...]
 *   oc-acp-client --port 4096 -- npx -y @agentclientprotocol/claude-agent-acp
 *
 * Prints the listening URL on stdout as a single JSON line so scripts (and the
 * e2e harness) can read it without guessing a port.
 *
 * Starting the opencode v2 TUI against this server is the default, and the only
 * path where a v2 client is *required*. `--no-tui` (or `--bridge-port`, which
 * implies it) serves the same surface to any other v2 client, the test
 * harness, or looking at the raw `/api/*` by hand. The TUI is the client verified
 * end to end here; any client attaches to the same OpenAPI surface (with the caveat noted
 * at `--bridge-port`: its state roots are its own, not ours).
 *
 * The client binary is selected by `OPENCODE_BIN` (or `opencode` on `PATH`);
 * there is no flag for it.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { accessSync, constants, createWriteStream, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { daemonsDir, isAlive, listDaemons, pruneDaemons, registerDaemon, unregisterDaemon } from './daemons.js';
import { agentBindingLabel, SessionMap, sessionMapPath } from './session-map.js';
import { PACKAGE_NAME, PACKAGE_VERSION, planUpgrade, runUpgrade } from './upgrade.js';
import {
  countSessions,
  DEFAULT_PAGE,
  listSessions,
  renderSessions,
  type SessionListOptions,
} from './sessions-command.js';
import { BridgeServer } from './server.js';
import {
  ENV_BIN,
  MIN_MAJOR_VERSION,
  describeVersion,
  installHint,
  readOpenCodeVersion,
  resolveOpenCodeBinary,
  upgradeHint,
  type OpenCodeBinary,
  type OpenCodeVersion,
} from './opencode-bin.js';

/**
 * opencode's own subcommands — `opencode --help` lists exactly these. When the
 * user's first bare word is one of them, the command means NATIVE opencode
 * behaviour (`oc-acp-client models -- …` ≡ `opencode models …`): no
 * bridge, no TUI, the argv is handed to the opencode binary as-is and the exit
 * code is its exit code. The directory claim must not touch them — the earlier
 * parser treated `models` as the workspace positional and started a bridge+TUI
 * with `models` in the TUI's argv, which is neither spelling's semantics.
 */
/**
 * Words opencode uses as subcommands, kept ONLY to explain the change.
 *
 * This tool used to forward these straight to the opencode binary: `oc-acp-client upgrade`
 * upgraded *opencode*, `auth`/`mcp`/`plugin` managed opencode's local state. That was
 * wrong — the two products share a name prefix and nothing else. `upgrade`/`update` are
 * now this package's own (see `src/upgrade.ts`), and the rest are refused with a hint
 * rather than silently running opencode. `models`, `api` and `session` used to be WRAPPED
 * (answered by the agent through the bridge); that plumbing counted on the bare word
 * reaching opencode's handler, so it is gone with it — the TUI already shows the agent's
 * models, and `/model` is the gesture that picks one.
 */
const OPENCODE_OWNED_WORDS = new Set([
  'uninstall',
  'acp',
  'api',
  'debug',
  'auth',
  'mcp',
  'plugin',
  'models',
  'stats',
  'mini',
  'run',
  'session',
  'service',
  'reload',
  'pair',
  'serve',
]);

/**
 * opencode subcommands whose ANSWER depends on which server answers them —
 * so a raw passthrough would be wrong: `models` against opencode's own daemon
 * lists the DAEMON's models, not the ACP agent's, and a user comparing that
 * list with what their TUI can actually pick would see two different worlds
 * (the agent's models arrive via the bridge's config-option plumbing). These
 * are WRAPPED: the bridge starts server-only, and the opencode binary runs
 * with `--server <bridge>` so its own official handler renders the answer —
 * same binary, same output format, but the data is the agent's. Everything
 * else (auth, mcp, plugin, upgrade, …) is the user's local opencode business
 * and stays a raw passthrough.
 */
const WRAPPED_SUBCOMMANDS = new Set(['models', 'api', 'session']);

interface ParsedArgs {
  port: number;
  host: string;
  directory: string;
  /** Undefined when the command is a native opencode subcommand. */
  agentCommand: string | undefined;
  agentArgs: string[];
  /**
   * Start the opencode v2 TUI against this server.
   *
   * **Default true** — that is what makes this one command from nothing to a
   * working TUI, which is the product. `--no-tui` turns it off: the server-only
   * mode any other v2 client attaches to (see `--bridge-port`), by the test
   * harness, and for inspecting the raw surface.
   */
  launch: boolean;
  logPath: string | undefined;
  /** opencode flags and any unknown args, passed to the TUI verbatim. */
  passThrough: string[];
  session: string | undefined;
  /** `--continue`: opencode's own semantic, forwarded as-is. */
  continueSession: boolean;
  /**
   * True when the command is a NATIVE opencode subcommand invocation: run the
   * binary with the argv as-is and do not start the bridge or the TUI.
   */
  nativeCommand: boolean;
  /** The leading subcommand itself, when nativeCommand was set. */
  nativeSubcommand: string | undefined;
  /**
   * A bridge-owned subcommand (`ps`): no agent, no TUI, no opencode binary.
   * Handled in `main` before the agent preflight, like the native ones.
   */
  bridgeCommand?: 'ps' | 'sessions' | 'upgrade';
  psJson: boolean;
  sessionsJson: boolean;
  /** 0 means every row (`--all`). */
  sessionsLimit: number;
  sessionsOffset: number;
  sessionsDirectory?: string;
  sessionsAgent?: string;
  sessionsUnknown: string[];
  refusedWord?: string;
  replacedFlags: string[];
  cliOnlyFlags: string[];
  upgradeCheck: boolean;
  upgradeTarget?: string;
  unknownUpgrade: string[];
  sessionsWidth?: number;
  psPrune: boolean;
  psKill: boolean;
}

/**
 * Run a WRAPPED opencode subcommand against a throwaway bridge.
 *
 * `models`/`api`/`session` answer from the server they are pointed at, so the
 * native daemon's answers would be a different world than the TUI the user
 * runs. The bridge starts server-only (no TUI), the opencode binary runs with
 * `--server <bridge>` — its own handler renders, byte-identical formatting —
 * and the exit code is mirrored. The agent must be ready first (`models` reads
 * the catalog the agent's initialize advertises), hence the catalog wait; a
 * user-visible delay is inherent to spawning the agent and is the same delay
 * the TUI pays at startup.
 */
/**
 * Run a WRAPPED opencode subcommand against a throwaway bridge.
 *
 * `models`/`api`/`session` answer from the server they are pointed at, so the
 * native daemon's answers would be a different world than the TUI the user
 * runs. The bridge starts SERVER-ONLY IN A CHILD PROCESS — ★ not in this
 * process: spawning the opencode binary synchronously (`execFileSync`, so the
 * exit code is ours) blocks this process's event loop, and an in-process HTTP
 * server cannot answer while blocked. Measured: opencode's 5s health probe
 * timed out against a perfectly healthy bridge — the exact bug this child
 * split fixes. The child bridge waits for the agent's catalog (models reads it),
 * then this process runs the opencode binary with `--server <child bridge>`,
 * its own official handler rendering the output, and mirrors the exit code.
 */
async function runWrappedSubcommand(
  args: ParsedArgs,
  binary: { path: string },
  argv: string[],
): Promise<void> {
  const bridgePort = await freePort();
  const entry = fileURLToPath(import.meta.url);
  const bridgeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_ACP_CLIENT_SESSION_MAP: sessionMapPath(),
    OPENCODE_ACP_CLIENT_EAGER_CATALOG: '1',
  };
  // The child bridge runs this same entry with our server-only plumbing.
  const bridge = spawn(
    process.execPath,
    [
      entry,
      '--no-tui',
      '--bridge-port',
      String(bridgePort),
      '--bridge-host',
      '127.0.0.1',
      args.directory,
      '--',
      args.agentCommand!,
      ...args.agentArgs,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], env: bridgeEnv },
  );
  const url = `http://127.0.0.1:${bridgePort}`;
  process.stderr.write(`[bridge] answering 'opencode ${args.nativeSubcommand}' from ${url}\n`);
  try {
    await waitHealthy(url, 30_000, 500);
    // Only `models` reads the catalog: its answer IS the agent's model
    // advertisement, which arrives with the agent's own startup (dsh ~8s).
    // `api` and `session` answer whatever is there the moment they ask —
    // waiting for a catalog they do not read once made `api GET /api/info`
    // sit through a 60s deadline for an agent that never advertises models
    // (measured: the probe timed out before opencode ever ran).
    if (args.nativeSubcommand === 'models') {
      await waitCatalogReady(url, 60_000, 1_000);
    }
    // The opencode argv, minus the `-- <agent>` tail, plus --server pointing
    // here. A user-typed --server must not survive: exactly one server answers.
    const dash = argv.indexOf('--');
    const userArgs = (dash === -1 ? argv : argv.slice(0, dash)).filter(
      (word, i, all) =>
        !(word === '--server' || all[i - 1] === '--server') && !/^--server=/.test(word),
    );
    execFileSync(binary.path, [...userArgs, '--server', url], {
      stdio: 'inherit',
      killSignal: 'SIGINT',
    });
    process.exitCode = 0;
  } catch (err) {
    const status = (err as { status?: number }).status;
    process.exitCode = status === undefined ? 1 : status;
  } finally {
    bridge.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const gone = setTimeout(() => {
        bridge.kill('SIGKILL');
        resolve();
      }, 3_000);
      bridge.once('exit', () => {
        clearTimeout(gone);
        resolve();
      });
    });
  }
  process.exit(process.exitCode ?? 0);
}

/** An OS-assigned free TCP port, reserved so the child can race no one. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

/** Poll until the child's model catalog is real (not the placeholder). */
async function waitCatalogReady(url: string, timeoutMs: number, stepMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${url}/api/model`);
      if (response.ok) {
        const body = (await response.json()) as {
          data?: Array<{ providerID?: string; id?: string; modelID?: string }>;
        };
        // ★ A real row, by id — not by provider. An agent that groups nothing
        // (codex-acp) publishes all of its models under the `acp` provider too, so
        // "some provider is not acp" never became true and this poll ran to its
        // deadline against an agent that had answered at once.
        const rows = body.data ?? [];
        if (rows.some((m) => (m.id ?? m.modelID) !== undefined && (m.id ?? m.modelID) !== 'default')) return;
      }
    } catch {
      // transient — the poll loop is the point
    }
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Poll the child bridge's health until it answers or the deadline passes. */
function waitHealthy(url: string, timeoutMs: number, stepMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const attempt = async (): Promise<void> => {
    try {
      const response = await fetch(`${url}/api/info`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) throw new Error(`the wrapped-bridge never came up at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    return attempt();
  };
  return attempt();
}

function sameDirectory(a: string, b: string): boolean {
  const normalise = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return normalise(a) === normalise(b);
}

/**
 * `-c`/`--continue`: the newest remembered session for this directory, and the agent that
 * owns it. The map is now the only source: without a session there is no way to know which
 * agent to ask, so the CLI errors instead of falling back to a blank conversation.
 */
export function newestContinueEntry(
  entries: Array<
    [string, { directory?: string; agent?: { command: string; args: string[] }; updatedAt: number }]
  >,
  directory: string,
): { visibleId: string; agent: { command: string; args: string[] } } | undefined {
  const matches = entries
    .filter(
      ([, entry]) =>
        entry.agent !== undefined &&
        entry.directory !== undefined &&
        sameDirectory(entry.directory, directory),
    )
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const top = matches[0];
  return top ? { visibleId: top[0], agent: top[1].agent! } : undefined;
}

/**
 * Translate a `--session <id>` value into the id the agent will answer to.
 *
 * Exported and pure so the startup contract is assertable at its own layer: the id
 * the TUI shows (`ses_…`) is never the agent's own id (a UUID), and sending it raw
 * to `session/load` is what made a resumed session silently restart empty — the
 * agent answered "Internal error" and the bridge opened a brand-new session under
 * the requested id. The session map holds the pairing; an unknown id passes through
 * as given (the agent's load then answers for whether it exists), so agent-native
 * ids learned elsewhere keep working.
 */
export function resolveSessionId(
  requested: string | undefined,
  log: (line: string) => void = () => {},
  launch?: { command: string; args?: readonly string[] },
): string | undefined {
  if (!requested) return undefined;
  const map = new SessionMap(() => {});
  if (launch) {
    const owner = map.agentFor(requested);
    const ownLabel = agentBindingLabel({ command: launch.command, args: [...(launch.args ?? [])] });
    if (owner && agentBindingLabel(owner) !== ownLabel) {
      throw new Error(
        `session ${requested} belongs to '${agentBindingLabel(owner)}', not '${ownLabel}'\n` +
          `  One client drives one agent: launch with '${agentBindingLabel(owner)}' ` +
          `(or use -c for this agent's newest conversation).`,
      );
    }
  }
  const acpId = map.acpIdFor(requested);
  if (acpId) {
    log(`[bridge] session map: ${requested} is the agent's ${acpId}`);
    return acpId;
  }
  // ★ A `ses_…` id with no map entry is provably unknown, not "maybe an
  // agent-native id": `ses_` is THIS bridge's namespace (the agent mints UUIDs,
  // and an agent-native id pasted from the agent's own UI passes through above).
  // Continuing anyway made the whole resume run against an id the agent has
  // never heard of: session/load answered "Internal error", the failure
  // fallback started a brand-new agent session under that id, and the tab came
  // up titled `[not resumed] <dir>` — measured end to end, twice. Failing here
  // is cheaper and honest: nothing is spawned, nothing is written to the
  // agent's store.
  if (requested.startsWith('ses_')) {
    throw new Error(
      `unknown session id: ${requested}\n` +
        `  This id is in the bridge's namespace but absent from the session map ` +
        `(~/.opencode-acp-client/sessions.json), so no agent session is known for it.\n` +
        `  List the ids this machine knows:  python3 scripts/list-sessions.py\n` +
        `  Or resume the newest conversation in this directory:  -c`,
    );
  }
  return requested;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let port = 0;
  let host = '127.0.0.1';
  /** `--bridge-port` was given: the user wants a server, not the TUI. */
  let portSpecified = false;
  /** `--bridge-host` was given (it is only meaningful with a server). */
  let hostSpecified = false;
  // The bridge's workspace: the FIRST bare positional (opencode's own
  // `opencode [flags] [<directory>]` spelling), defaulting to the cwd.
  let directory: string | undefined;
  // Whether the previous argv word was a forwarded flag that may take its value
  // as the next word — a bare word after it belongs to the flag, not to us.
  let lastWasForwardedFlag = false;
  // The first bare word decides the mode: an opencode subcommand means NATIVE
  // opencode behaviour (no bridge, no TUI, argv as-is); anything else may
  // become the workspace directory. Judged once, on the first bare word.
  let nativeCommand = false;
  /** An opencode-owned word we refuse, with a hint (see OPENCODE_OWNED_WORDS). */
  let refusedWord: string | undefined;
  /**
   * opencode flags this bridge replaces. Recorded, not forwarded: `--server` would point the
   * TUI somewhere other than the bridge (which IS the server), and `--standalone` would have
   * it start a server of its own. Silently dropping them made `--server <url>` fall through
   * to the DIRECTORY rule — measured: `chdir '…' -> 'http://example.com'`.
   */
  const replacedFlags: string[] = [];
  /** opencode CLI tools that are not TUI flags at all (see the parse branch). */
  const cliOnlyFlags: string[] = [];
  /** `upgrade --check`: look up the version and stop. */
  let upgradeCheck = false;
  /** A version to install, from `upgrade <version>`. */
  let upgradeTarget: string | undefined;
  let nativeSubcommand: string | undefined;
  let sawFirstBare = false;
  let launch = true;
  let logPath: string | undefined;
  let session: string | undefined;
  let continueSession = false;
  let bridgeCommand: 'ps' | 'sessions' | 'upgrade' | undefined;
  let psJson = false;
  let sessionsJson = false;
  /** 0 means "every row"; `--all`. */
  let sessionsLimit = DEFAULT_PAGE;
  let sessionsOffset = 0;
  let sessionsDirectory: string | undefined;
  let sessionsAgent: string | undefined;
  /** Explicit table width; `stdout.columns` is undefined when piped. */
  let sessionsWidth: number | undefined;
  /**
   * Words and flags `sessions` did not recognise. Collected, not ignored: `--director`
   * (a typo) used to be swallowed whole and the command printed every session, which
   * looked exactly like "the filter does not work".
   */
  const sessionsUnknown: string[] = [];
  const unknownUpgrade: string[] = [];
  let psPrune = false;
  let psKill = false;
  const passThrough: string[] = [];
  let index = 0;

  // The contract with the user (the owner's rule): a flag shared with opencode
  // keeps opencode's name AND meaning wherever the two agree (`--directory`,
  // `--session`, `--continue`); where they disagree, the bridge's flag gets a
  // bridge-qualified name (`--bridge-port` etc. — opencode's `--port` is its
  // own server, ours is the ACP bridge); everything unrecognized is opencode's
  // business and passed to the TUI verbatim, in order.
  for (; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      index += 1;
      break;
    }
    // Shared name, shared meaning — but the DIRECTORY is now a positional
    // argument, exactly as opencode spells it (`opencode [flags] [<directory>]`).
    // `--directory`/`-C` therefore are NOT ours either: they forward like every
    // other unrecognized word, and the TUI (opencode) consumes them itself. The
    // bridge's own directory comes from the first bare positional before `--` —
    // but only one that is NOT the value of a forwarded flag: a word right after
    // a `--something` belongs to that flag (opencode flags take their value as
    // the next argument), so claiming it as the directory would corrupt the
    // forwarded argv. The one exception is a value the TUI itself would reject:
    // we do not know which flags take values, so the pair rule is the only
    // honest guess — and a directory that follows a flag the user meant to give
    // a value to is the user's call, exactly as opencode would parse it.
    // ★ Refused, not dropped. Both are opencode's way of choosing a server, and this tool
    // IS the server — silently ignoring them is how a flag the user typed stops mattering.
    // The value is consumed first: without that, `--server <url>` left the URL to be
    // claimed as the workspace directory (measured: `chdir '/repo' -> 'http://example.com'`).
    if (arg === '--server' || arg.startsWith('--server=')) {
      if (arg === '--server') index += 1;
      replacedFlags.push('--server');
      lastWasForwardedFlag = false;
      continue;
    }
    if (arg === '--standalone') {
      replacedFlags.push('--standalone');
      lastWasForwardedFlag = false;
      continue;
    }
    // ★ CLI tools, not TUI flags. `--completions` prints a script for opencode's own
    // argument parser and `--wizard` builds a command for its own CLI; forwarding them to
    // the TUI means nothing, and with no `-- <agent>` they fell through to "print help and
    // exit 0" — which looked like success and did nothing.
    if (arg === '--completions' || arg.startsWith('--completions=') || arg === '--wizard') {
      if (arg === '--completions') index += 1;
      cliOnlyFlags.push(arg.split('=')[0]!);
      lastWasForwardedFlag = false;
      continue;
    }
    if (!arg.startsWith('-') && arg !== '' && !lastWasForwardedFlag) {
      // ★ A bare word after `upgrade` is the VERSION, never a directory. Checked before
      // the directory rule below, which claimed `0.4.0` while the flag-style branch near
      // the end of this loop never saw it — the argument is not a flag.
      if (bridgeCommand === 'upgrade') {
        upgradeTarget = arg;
        continue;
      }
      // The FIRST bare word chooses the mode. A subcommand is native opencode:
      // NO bridge, NO TUI, and every later word is the subcommand's own
      // argument (`opencode session ls`, `opencode api POST …`) — never a
      // directory claim, which an earlier version let a second bare word
      // corrupt. Everything before `--` forwards untouched.
      if (!sawFirstBare) {
        sawFirstBare = true;
        // A bridge-owned subcommand: `ps` lists the bridges this tool started.
        // opencode has no `ps`, so claiming the word cannot shadow its CLI.
        if (arg === 'ps' || arg === 'daemons') {
          bridgeCommand = 'ps';
          lastWasForwardedFlag = false;
          continue;
        }
        // `sessions` and `ls` are ours too: opencode has both words (`opencode session`),
        // so `ls` only claims the slot when nothing has been parsed as native — the
        // `OPENCODE_SUBCOMMANDS` check below still wins for the bare `opencode` words.
        if (arg === 'sessions' || (arg === 'ls' && !nativeCommand)) {
          bridgeCommand = 'sessions';
          lastWasForwardedFlag = false;
          continue;
        }
        // Our own updater. It was a passthrough once, which meant `oc-acp-client upgrade`
        // upgraded opencode — a different product on a different version line.
        if (arg === 'upgrade' || arg === 'update') {
          bridgeCommand = 'upgrade';
          lastWasForwardedFlag = false;
          continue;
        }
        if (OPENCODE_OWNED_WORDS.has(arg)) {
          // A deliberate refusal. Forwarding these ran opencode's own command — same word,
          // different product — so the failure a user saw was opencode's answer to a
          // question they had not asked. Passing the binary on still works, explicitly.
          refusedWord = arg;
          continue;
        }
      }
      if (nativeCommand) {
        lastWasForwardedFlag = false;
        passThrough.push(arg);
        continue;
      }
      if (directory === undefined) {
        // opencode's own rule: a bare positional before `--` is the directory.
        directory = arg;
        lastWasForwardedFlag = false;
        continue;
      }
      // A second bare word in bridge mode: opencode's own subcommand-style
      // usage after a directory (`opencode /work models`), so it forwards.
      lastWasForwardedFlag = false;
      passThrough.push(arg);
      continue;
    }
    // Track whether THIS word completes the value of a forwarded flag, so the
    // NEXT bare word can be judged as a directory on its own merits.
    lastWasForwardedFlag = arg.startsWith('-') && !arg.startsWith('--bridge');
    if (arg === '--session' || arg === '-s' || arg.startsWith('--session=')) {
      session =
        arg === '--session' || arg === '-s' ? String(argv[++index]) : arg.slice('--session='.length);
      continue;
    }
    if (arg === '--continue' || arg === '-c') {
      continueSession = true;
      // opencode's own flag must still reach the TUI: IT is the one that loads
      // the remembered session list into its store.
      passThrough.push(arg);
      continue;
    }
    // Bridge-only concerns, named so they cannot be confused with opencode's.
    if (arg === '--bridge-port' || arg.startsWith('--bridge-port=')) {
      port = arg === '--bridge-port' ? Number(argv[++index]) : Number(arg.slice('--bridge-port='.length));
      portSpecified = true;
      continue;
    }
    if (arg === '--bridge-host' || arg.startsWith('--bridge-host=')) {
      host = arg === '--bridge-host' ? String(argv[++index]) : arg.slice('--bridge-host='.length);
      hostSpecified = true;
      continue;
    }
    if (arg === '--bridge-log' || arg.startsWith('--bridge-log=')) {
      logPath = arg === '--bridge-log' ? String(argv[++index]) : arg.slice('--bridge-log='.length);
      continue;
    }
    if (bridgeCommand === 'upgrade') {
      if (arg === '--check') upgradeCheck = true;
      else unknownUpgrade.push(arg);
      continue;
    }
    if (bridgeCommand === 'sessions') {
      if (arg === '--json') sessionsJson = true;
      else if (arg === '--all') sessionsLimit = 0;
      else if (arg === '--limit') sessionsLimit = Number(argv[++index]) || DEFAULT_PAGE;
      else if (arg.startsWith('--limit=')) sessionsLimit = Number(arg.slice('--limit='.length)) || DEFAULT_PAGE;
      else if (arg === '--offset') sessionsOffset = Math.max(0, Number(argv[++index]) || 0);
      else if (arg.startsWith('--offset=')) sessionsOffset = Math.max(0, Number(arg.slice('--offset='.length)) || 0);
      else if (arg === '--directory' || arg === '-C') sessionsDirectory = String(argv[++index] ?? '');
      else if (arg.startsWith('--directory=')) sessionsDirectory = arg.slice('--directory='.length);
      else if (arg === '--agent' || arg === '-A') sessionsAgent = String(argv[++index] ?? '');
      else if (arg.startsWith('--agent=')) sessionsAgent = arg.slice('--agent='.length);
      else if (arg === '--width') sessionsWidth = Number(argv[++index]) || undefined;
      else if (arg.startsWith('--width=')) sessionsWidth = Number(arg.slice('--width='.length)) || undefined;
      else if (arg === '--next') sessionsOffset = -1;
      else {
        sessionsUnknown.push(arg);
      }
      continue;
    }
    if (bridgeCommand === 'ps' && (arg === '--json' || arg === '--prune' || arg === '--kill')) {
      if (arg === '--json') psJson = true;
      if (arg === '--prune') psPrune = true;
      if (arg === '--kill') psKill = true;
      continue;
    }
    if (arg === '--no-tui') {
      launch = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    // ★ `--version`/`-v` are OURS. They used to fall through to the TUI, which printed
    // nothing useful and then failed with "missing agent command" — a tool that cannot
    // state its own version. The number is this package's; the opencode binary it pairs
    // with is a separate question and deliberately not mixed in here.
    if (arg === '--version' || arg === '-v') {
      process.stdout.write(`${PACKAGE_NAME} ${PACKAGE_VERSION}\n`);
      process.exit(0);
    }
    // Anything else is opencode's: TUI flags (`--auto`, `--prompt …`,
    // `--log-level …`), `-c`-style shorts, `--flag=value`, subcommands
    // (`models`, `run`, …), or plain arguments. Forwarded verbatim; a value
    // flag followed by a bare word stays a pair because we never look ahead.
    passThrough.push(arg);
  }

  // ★ Specifying a port means "serve, do not start the TUI" (the other-v2
  // client use case). A host alone is not a server request: it only has meaning
  // with a port (or an explicit --no-tui for the random-port server).
  if (portSpecified) launch = false;
  if (hostSpecified && !portSpecified && launch) {
    throw new Error(
      '--bridge-host needs --bridge-port (or --no-tui); pass --bridge-port <n> to serve, ' +
        'or drop --bridge-host to start the TUI',
    );
  }

  const [agentCommand, ...agentArgs] = argv.slice(index);
  if (session && continueSession) {
    throw new Error('use either --session/-s or --continue/-c, not both');
  }
  // One client = one agent: a resumed session (or -c) carries its agent in the map,
  // so an agent command alongside it is either redundant or the old ambiguity —
  // refuse it. `--` is for STARTING a new session only.
  if ((session || continueSession) && agentCommand) {
    throw new Error(
      'do not pass an agent command with -s/-c: the session (or -c\'s newest session) ' +
        'fixes the agent; use -- <agent> only to start a new session',
    );
  }
  // ★ A refused opencode word fails HERE, loudly. It used to be forwarded to the opencode
  // binary instead, which answered a question about a different product — and silently, so
  // `oc-acp-client upgrade` moving opencode looked like it had upgraded this package.
  if (cliOnlyFlags.length > 0) {
    const flag = cliOnlyFlags[0]!;
    throw new Error(
      `\`${flag}\` is opencode's own CLI tool, not a flag of the TUI this tool drives. ` +
        `Run \`opencode ${flag}\` directly.`,
    );
  }
  if (replacedFlags.length > 0) {
    // ★ A refusal, not a warning. These two choose a SERVER, and this tool is one — a run
    // that ignored them would look like it honoured them, which is the same mistake
    // `--server`'s value-as-directory made in a louder way.
    const flag = replacedFlags[0]!;
    throw new Error(
      `\`${flag}\` is not accepted: this tool IS the server the TUI talks to. ` +
        `Run \`opencode ${flag} …\` directly if you want the TUI pointed somewhere else.`,
    );
  }
  if (refusedWord) {
    throw new Error(
      `\`${refusedWord}\` is opencode's command, not this tool's. ` +
        `Run \`opencode ${refusedWord}\` for it, or see \`oc-acp-client --help\` for ours ` +
        `(sessions, ps, upgrade, update).`,
    );
  }
  // A native subcommand IS opencode: no agent, no bridge, no `--`. The only
  // syntactic difference from the bridge usage, so the check must not demand
  // what that mode never has.
  if (!agentCommand && !nativeCommand && !bridgeCommand && !session && !continueSession) {
    printHelp();
    throw new Error('missing agent command (put it after --)');
  }
  return {
    port,
    host,
    directory: directory ?? process.cwd(),
    nativeCommand,
    nativeSubcommand,
    bridgeCommand,
    psJson,
    sessionsJson,
    sessionsLimit,
    sessionsOffset,
    ...(sessionsDirectory ? { sessionsDirectory } : {}),
    ...(sessionsAgent ? { sessionsAgent } : {}),
    sessionsUnknown,
    ...(refusedWord ? { refusedWord } : {}),
    replacedFlags,
    cliOnlyFlags,
    upgradeCheck,
    ...(upgradeTarget ? { upgradeTarget } : {}),
    unknownUpgrade,
    ...(sessionsWidth ? { sessionsWidth } : {}),
    psPrune,
    psKill,
    agentCommand,
    agentArgs,
    launch,
    logPath,
    passThrough,
    session,
    continueSession,
  };
}

/**
 * Our help, in opencode's own shape — DESCRIPTION, USAGE, FLAGS, SUBCOMMANDS,
 * ENVIRONMENT, two-space indent, uppercase headings, no colour (measured: opencode's
 * `--help` emits no ANSI at all).
 *
 * What differs is the CONTENT, and only where the truth differs:
 *
 *   • one FLAGS section, not FLAGS + GLOBAL FLAGS. The split upstream separates "what this
 *     command takes" from "what every opencode command takes"; here every flag has the
 *     same reader, so ours come first and opencode's follow in the same list.
 *   • opencode's own preamble and SUBCOMMANDS are not quoted: the word `upgrade` there
 *     means "Upgrade OpenCode", and the rest are commands this tool refuses.
 *   • no paragraph explaining the forwarding rules — the sections say it.
 */
/**
 * Colour for the help, when — and only when — a person is looking at it.
 *
 * `opencode --help` prints coloured headings on a real terminal (its author measures it
 * so); our capture harness could not reproduce the hues, so these are our own choice
 * rather than a copy. What matters is that they colour the same PARTS and never a pipe:
 * `--help | grep` has to stay greppable, which is why the switch is TTY-only. `NO_COLOR`
 * and `TERM=dumb` are honoured, per their conventions.
 */
interface Paint {
  heading: (text: string) => string;
  flag: (text: string) => string;
}

const PAINT_PLAIN: Paint = { heading: (t) => t, flag: (t) => t };
const PAINT_TTY: Paint = {
  // Bold cyan headings, yellow names; legible on light and dark terminals alike.
  heading: (text) => `\u001b[1;36m${text}\u001b[0m`,
  flag: (text) => `\u001b[33m${text}\u001b[0m`,
};

function helpPaint(): Paint {
  if (process.env['NO_COLOR'] !== undefined) return PAINT_PLAIN;
  if (process.env['TERM'] === 'dumb') return PAINT_PLAIN;
  return process.stdout.isTTY ? PAINT_TTY : PAINT_PLAIN;
}

/**
 * One row: a name column and a description, indented two spaces like opencode's. Padding
 * is computed on the PLAIN name, so the columns line up whatever the escapes do.
 */
function helpRow(paint: Paint, name: string, description: string, width: number): string {
  return `  ${paint.flag(name.padEnd(width))}  ${description}`;
}

/** A whole section's rows, aligned on the longest name; a null name is a continuation. */
function helpRows(paint: Paint, rows: Array<[string | null, string]>): string[] {
  const width = Math.max(...rows.map(([name]) => (name ?? '').length));
  return rows.map(([name, description]) =>
    name === null ? `  ${' '.repeat(width)}  ${description}` : helpRow(paint, name, description, width),
  );
}

/** The ENVIRONMENT rows: a name and what it does. */
function environmentRows(): Array<[string, string]> {
  return [
    [ENV_BIN, 'The opencode v2 client binary (default: opencode on PATH)'],
    ['OPENCODE_ACP_CLIENT_TRACE', 'Log every HTTP request and ACP frame'],
    ['OPENCODE_ACP_CLIENT_EVENT_LOG=1', 'Log the session each emitted event names'],
    ['OPENCODE_ACP_CLIENT_PROMPT_TIMEOUT_MS', 'Give session/prompt a clock (default: none)'],
    ['OPENCODE_ACP_CLIENT_SESSION_MAP', 'Session-id map path'],
    ['OPENCODE_ACP_CLIENT_DUMP', "Write session/new's raw response here"],
  ];
}

export function printHelp(): void {
  // The forwarded half, quoted from the binary so a new opencode flag appears here without
  // a second copy to maintain. Every flag the bridge intercepts is removed first: whatever
  // survives is genuinely passed through.
  let forwarded: Array<[string, string]> = [];
  try {
    const binary = resolveOpenCodeBinary();
    // ★ Windows cannot exec a `.cmd`/`.bat` without a shell, and that is how npm installs
    // `opencode` there — `execFileSync` answered ENOENT, which the `catch` below turned into
    // an empty forwarded flag list, so `--help` silently lost its whole forwarded section
    // (measured on windows-latest and again on a real Windows 11 VM). `cmd /d /s /c` with
    // `windowsVerbatimArguments` keeps the quoting intact; `shell: true` would re-parse the
    // line and break a path containing spaces. `spawnSync` because `execFileSync`'s typings
    // do not carry that option.
    const run = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${binary.path}" --help"`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsVerbatimArguments: true,
        })
      : spawnSync(binary.path, ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (run.error) throw run.error;
    // CRLF first: `.split('\n')` on a Windows answer leaves a `\r` on every line, and
    // `/^(FLAGS|GLOBAL FLAGS)$/m` then never matches.
    const raw = String(run.stdout ?? '').replace(/\r\n/g, '\n');
    const cut = raw.search(/^SUBCOMMANDS\s*$/m);
    const body = cut >= 0 ? raw.slice(0, cut) : raw;
    const firstHeading = body.search(/^(FLAGS|GLOBAL FLAGS)\s*$/m);
    // ★ Parsed into (flag, description) PAIRS, not kept as pre-indented text. opencode pads
    // its own two sections to different widths, so pasting them verbatim left the columns
    // ragged next to ours. As pairs they go through the same `helpRows` alignment we use,
    // and the result reads as one table.
    const lines = (firstHeading >= 0 ? body.slice(firstHeading) : body).split('\n');
    const rows: Array<[string, string]> = [];
    for (const line of lines) {
      if (/^(FLAGS|GLOBAL FLAGS)\s*$/.test(line)) continue;
      if (!/^\s+--/.test(line)) continue;
      // `  --flag <arg>      Description` — the flag column ends where three or more spaces
      // begin (opencode pads with at least two, the description never starts with space).
      // opencode spells the argument as a bare word (`--server string`, `--prompt string`)
      // or in angle brackets (`--completions <bash|…>`); either way the name is everything
      // up to the two-space gap that starts the description.
      const match = /^\s+(--\S+(?:\s+(?:string|<[^>]*>))?)\s{2,}(.+)$/.exec(line);
      const name = match?.[1];
      const description = match?.[2];
      if (!name || !description) continue;
      // A flag this tool takes over never reaches the TUI, so it does not belong in the list.
      if (/^--(server|standalone|session|continue|help|version|wizard|completions)\b/.test(name)) continue;
      rows.push([name, description]);
    }
    forwarded = rows;
  } catch {
    forwarded = [['', `(opencode's flags are unavailable: no ${ENV_BIN ? `$${ENV_BIN}` : 'opencode'} on PATH)`]];
  }

  const paint = helpPaint();
  const H = (text: string): string => paint.heading(text);
  process.stdout.write(
    [
      H('DESCRIPTION'),
      '  The opencode v2 TUI, driving any ACP agent. The bridge replaces the opencode',
      '  server: the TUI talks to it, and it talks ACP to the agent given after `--`.',
      '',
      H('USAGE'),
      '  oc-acp-client [flags] [<directory>] -- <agent command> [args…]',
      '  oc-acp-client -s <session> | -c [flags]',
      '  oc-acp-client sessions | ps | upgrade | --help | --version',
      '',
      H('FLAGS'),
      ...helpRows(paint, [
        ['--help, -h', 'Show this help'],
        ['-- <cmd> [args…]', 'The ACP agent to spawn. One client drives one agent; -s/-c read the agent from the session map instead'],
        ['--continue, -c', 'Continue the most recent session this tool advanced'],
        ['--session, -s <id>', "Continue this session; the `ses_…` id is translated to the agent's own"],
        // ★ Each line says what the flag is FOR, not just what it switches off:
        // `--no-tui` is how a script gets a ready line, and `--bridge-port` is how something
        // else gets a stable address. "implies --no-tui" alone made the first look like a way
        // to pin a port.
        //
        // ★ No client is named here on purpose. Attaching a client to this bridge DOES work at
        // the protocol level, but the TUI state roots (`XDG_STATE_HOME`, `OPENCODE_DB`, …) are
        // injected into the child we spawn, and no other client can be given them — so its
        // tabs are not isolated per agent while ours are. Until that is solved, pointing
        // users at it would be advertising a trap.
        ['--bridge-port <n>', 'Pin the port instead of choosing a free one; no TUI'],
        ['--bridge-host <a>', 'Listen address (default 127.0.0.1; 0.0.0.0 accepts other machines, and the bridge has no auth)'],
        ['--bridge-log <p>', 'Bridge log path (default: stderr, or a file under TMPDIR once the TUI starts)'],
        ['--no-tui', 'Serve HTTP/SSE only; prints a ready line carrying the chosen port, for a script to read'],
        ['--version, -v', "Show this package's version"],
      ]),
      '',
      "  The flags below are opencode's and reach the TUI unchanged.",
      ...helpRows(paint, forwarded),
      '',
      '',
      H('SUBCOMMANDS'),
      ...helpRows(paint, [
        // The two read DIFFERENT stores and answer different questions: `sessions` is the
        // history (finished conversations included), `ps` is the live process table. One
        // line each that says which, because "the processes this tool started" could be
        // read as "the sessions it started".
        ['sessions', 'History: conversations this tool remembers, newest first'],
        ['ps', 'Now: bridge processes running right now (pid, port, age)'],
        ['upgrade, update', 'Move this package to a newer version'],
      ]),
      '',
      H('ENVIRONMENT'),
      ...helpRows(paint, environmentRows()),
      '',
      'The ready line (one JSON object on stdout) is printed when stdout is not a',
      'terminal — scripts read the port from it — and always with --no-tui.',
      '',
    ].join('\n'),
  );
}


/**
 * Is the agent command runnable?
 *
 * The agent is spawned lazily — on the first prompt — so without this check a
 * typo would be discovered only after the TUI had taken over the terminal, and
 * it would look like a dead composer rather than a bad command. Checking first
 * turns that into one readable line before anything starts.
 *
 * Deliberately does **not run** the command: an arbitrary ACP agent may not
 * support any probe flag, and one that ignores argv simply waits on stdin
 * (which is the trap that made `--dump-config` discovery unworkable).
 */
export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  const executable = (path: string): boolean => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  // A path (relative or absolute) is checked as given, never searched for.
  // A *relative* one is resolved against the directory the agent will run in,
  // not against wherever we happened to be started — the agent is spawned with
  // the workspace directory as its cwd, so `tests/agent.mjs` means that file
  // inside the workspace.
  // ★ A path is "contains a separator", and on Windows that is `\`, not `/` — plus a
  // drive-absolute `C:\…` names its own location. Testing only for `/` treated
  // `C:\hostedtoolcache\windows\node\22\x64\node.exe` as a COMMAND NAME, so it was
  // looked up in PATH (where it is not) and the answer was `undefined` for a file that
  // plainly exists. Measured on windows-latest in CI. `path.isAbsolute` covers the
  // drive-letter form on both platforms it matters for.
  const looksLikePath = command.includes('/') || command.includes('\\') || isAbsolute(command);
  if (looksLikePath) {
    const target = isAbsolute(command) ? command : resolve(cwd, command);
    return executable(target) ? target : undefined;
  }

  // ★ On Windows a command is a FILE NAME WITH AN EXTENSION. This loop asked for the bare
  // `node`, which does not exist — the machine has `node.exe` — so every extensionless command
  // was reported as "agent command not found" while sitting on PATH. Measured on the Windows VM:
  // `oc-acp-client -- node tests/fake-acp-agent.mjs` refused to start with `node` on PATH.
  //
  // `PATHEXT` is Windows' own list, in its own order, and the shell searches it the same way;
  // an explicit extension (`agent.exe`, `run.cmd`) is tried as given and never re-appended.
  const extensions =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0)]
      : [''];
  const hasExtension = command.includes('.');
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      if (extension !== '' && hasExtension) continue;
      const candidate = join(dir, command + extension);
      if (executable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Decide what to do about the client, then optionally start it.
 *
 * Returns the child to wait on, or undefined when we should just serve.
 * Exits the process when the answer is "you need a v2 client and we cannot get
 * one" — never silently, and never by installing anything unattended.
 */
async function handleClient(
  args: ParsedArgs,
  url: string,
  resolvedSession: string | undefined,
  epilogueTarget: () => string | undefined,
  log: (line: string) => void,
  onFatal: (message: string) => void,
): Promise<ReturnType<typeof spawn> | undefined> {
  const binary = resolveOpenCodeBinary();
  let version = await readOpenCodeVersion(binary);
  log(`[bridge] ${describeVersion(binary, version)}`);

  if (version?.supported) {
    if (!args.launch) return undefined;
    return launchClient(args, binary, url, resolvedSession, epilogueTarget, log, onFatal);
  }

  // At this point the client is missing or too old.
  const reason = version ? `found v${version.major}, need v${MIN_MAJOR_VERSION}+` : 'not found';
  // A readable way out. The URL must be the **v2** installer: the unversioned
  // one serves v1, which this gate would reject again a minute later.
  const install = version
    ? `upgrade it: ${upgradeHint(binary)} — or install opencode v2: ${installHint()}`
    : `install opencode v2: ${installHint()}`;

  if (!args.launch) {
    // Server-only: no TUI is launched here, so this is advice, not a failure.
    log(`[bridge] warning: opencode v2 ${reason} (${binary.path}); continuing as a server`);
    log(`[bridge] ${install}`);
    return undefined;
  }

  log(`[bridge] opencode v2 ${reason} (${binary.path})`);
  log(`[bridge] ${install}`);
  // No TUI exists yet (it is started at the end of this function), so the
  // terminal is free — and a missing client is exactly the case where the user
  // needs to read this line, not go hunting for the log file.
  process.stderr.write(`[bridge] ${install}\n`);

  // Nothing to upgrade when there is no binary at all.
  if (!version) process.exit(1);

  if (!process.stdin.isTTY) {
    // Never install unattended: there may be no human, and no consent.
    log('[bridge] refusing to install unattended (stdin is not a terminal)');
    process.exit(1);
  }

  const agreed = await confirm(
    `Upgrade the opencode v2 client now? (${upgradeHint(binary)}) [y/N] `,
  );
  if (!agreed) {
    log(`[bridge] aborted; run: ${upgradeHint(binary)}`);
    process.exit(1);
  }

  const code = await runToCompletion(binary.path, ['upgrade'], log);
  if (code !== 0) {
    log(`[bridge] upgrade exited with ${code}`);
    process.exit(1);
  }

  version = await readOpenCodeVersion(binary);
  log(`[bridge] after upgrade: ${describeVersion(binary, version)}`);
  if (!version?.supported) {
    log('[bridge] still not v' + MIN_MAJOR_VERSION + '+ after upgrading; giving up');
    process.exit(1);
  }
  return launchClient(args, binary, url, resolvedSession, epilogueTarget, log, onFatal);
}

/**
 * Arguments for the launched client.
 *
 * Pure and exported so the `--session` can be asserted: leaving it out looks
 * fine — the TUI still renders — but the composer then sits on
 * `session/undefined` and Enter does nothing at all.
 */
export function clientArgs(args: ParsedArgs, url: string, session?: string): string[] {
  // `--server` connects to the bridge; `--standalone` would instead ask the
  // client to run its own private server, so the two must not be combined.
  //
  // `--session`/`--continue` reach the TUI through passThrough when the user
  // passed them — opencode's own flags, opencode's own meaning. The explicit
  // `session` argument is the bridge-side resume (same spelling, resolved by
  // the caller) and wins over a stray forwarded one.
  // ★ Say it out loud. These two are NOT forwarded (the bridge is the server, and a private
  // one would compete with it), and dropping them in silence is how `--server <url>` used to
  // become the workspace directory instead of an error.
  const forwarded = args.passThrough.filter((a) => a !== '--server' && a !== '--standalone');
  const argv = ['--server', url, ...(session ? ['--session', session] : []), ...forwarded];
  // The TUI needs a directory to key its workspace state on. The user may have
  // named one themselves — a bare positional, or opencode's own --directory/-C,
  // both of which arrived via passThrough — and then the TUI takes it; the
  // bridge's own copy (which is what `--` uses as its default when nothing was
  // named) is appended only when the forwarded argv names no directory at all.
  const namesDirectory =
    forwarded.some((a, i) => a === '--directory' || a === '-C' || a?.startsWith('--directory=') || a === '--')
      ? true
      : forwarded.some((a) => a !== undefined && !a.startsWith('-'));
  if (!namesDirectory) argv.push(args.directory);
  return argv;
}


function launchClient(
  args: ParsedArgs,
  binary: OpenCodeBinary,
  url: string,
  resolvedSession: string | undefined,
  epilogueTarget: () => string | undefined,
  log: (line: string) => void,
  onFatal: (message: string) => void,
): ReturnType<typeof spawn> {
  // ★ The TUI gets the id the USER TYPED (`ses_…`), never the translated agent
  // id: the epilogue prints the TUI's session id, and handing it the UUID meant
  // the `Continue` line showed the agent's internal id — which the user should
  // not see, and which --session would refuse on the next run (it is not in the
  // map's keys). The bridge adopted the session from the map either way.
  const argv = clientArgs(args, url, args.session);
  log(`[bridge] launching: ${binary.path} ${argv.join(' ')}`);
  // ★ stdin stays a SOCKET inherited from us (a TTY): a `pipe` here strips the
  // TTY-ness the TUI probes for size and mouse support, and it rendered a small
  // window glued to the top-left corner of the terminal. The epilogue rewrite
  // therefore does NOT tap the live stream — it reads the TUI's *scrollback*
  // after exit (the frame is history by then) and rewrites only the final
  // `Continue` line, so the interactive path is untouched end to end.
  // ★ Session isolation from a native opencode install. The v2 TUI persists its tab
  // layout (and its own session db) under the XDG state/data roots; sharing them with
  // the native install meant a native TUI showed OUR tabs — and clicking one failed,
  // because those sessions live behind this bridge, not in opencode's own daemon or
  // db. Measured: ~/.local/state/opencode/latest/tui/tabs.json held both worlds.
  // Giving our TUI its own XDG roots keeps both worlds apart: our tabs stay ours,
  // the native install's tabs stay its own.
  const isolated = isolatedTuiRoots({
    command: args.agentCommand ?? binary.path,
    args: args.agentArgs,
  });
  const child = spawn(binary.path, argv, {
    stdio: 'inherit',
    ...(isolated ? { env: { ...process.env, ...isolated } } : {}),
  });
  // Attached here rather than at the call site: `spawn` reports a failure on a
  // later tick, and a caller that attached afterwards could miss it and sit
  // serving a TUI that never appeared.
  child.on('error', (err) => onFatal(`failed to launch the opencode v2 TUI: ${err.message}`));
  // The epilogue rewrite is NOT attached here: it must run after the child's
  // stdio has closed ('close', not 'exit'), and the caller owns that event.
  return child;
}

/**
 * The environment our TUI runs under, so a native `opencode` install and this
 * product never share state — and the TUI cannot disturb the native install.
 *
 * The seams, each measured against the shipped binary (`opencode debug paths`,
 * v2.0.31) rather than assumed:
 *   XDG_STATE_HOME          → `…/tui/tabs.json` (TAB LAYOUT) and locks. Shared, a
 *                             native TUI listed our tabs and could not open them
 *                             (their sessions exist only behind the bridge).
 *   XDG_DATA_HOME           → `opencode.db`, log, snapshot, shell, repos. Shared,
 *                             the two worlds' session dbs interleave.
 *   XDG_CONFIG_HOME         → deliberately NOT redirected: TUI config (tui.json,
 *                             plugins, themes) is shared with the user's install.
 *   OPENCODE_DB             → the db file outright: a second belt even if an
 *                             XDG root is ignored.  (Measured: honoured.)
 *   OPENCODE_DISABLE_AUTOUPDATE → our TUI must not upgrade itself mid-run; a
 *                             silent version bump is what produced the "Server at
 *                             … has version X; this client is Y" warnings.
 *   OPENCODE_DISABLE_FILEWATCHER → two TUIs watching one worktree duplicate file
 *                             events; ours need not watch at all.
 *   OPENCODE_CONFIG_DIR     → ONLY when OPENCODE_ACP_CLIENT_ISOLATED_CONFIG=1: a
 *                             private config root. Off by default on purpose —
 *                             it would also hide the user's own providers/plugins
 *                             from OUR TUI, which is not what "isolation" should
 *                             cost. Measured nuance: `OPENCODE_CONFIG_DIR` adds a
 *                             config root but does not stop the user-level one
 *                             from loading, so this is a containment, not a wall.
 * ★ The root is named after the agent command (see `agentStateSlug`): two agents
 * never share a tabs.json, so a dsh launch cannot restore an opencode tab (reported
 * 2026-10-19 — the mixed tabs also mixed model catalogs). One client = one agent;
 * another agent is another launch, with its own tab set.
 *
 * `OPENCODE_ACP_CLIENT_SHARED_STATE=1` restores the old shared behaviour for anyone
 * who wants one opencode world.
 *
 * Not used, each checked: `OPENCODE_TUI_CHANNEL` (the channel is a BUILD constant;
 * setting it changed no path), `OPENCODE_TEST_HOME` (moves only `home`, not data or
 * state), `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT` (append/override, not a root).
 */
export function agentStateSlug(command: string, args: readonly string[] = []): string {
  const hash = createHash('sha256').update(JSON.stringify([command, ...args])).digest('hex').slice(0, 8);
  // `node /path/agent.mjs …` should read as the script, not as a path: the root
  // directory is user-visible and a full path would be truncated to noise.
  const runner = basename(command);
  const script =
    ['node', 'bun', 'deno', 'python', 'python3', 'npx'].includes(runner) && args[0]
      ? basename(args[0]).replace(/\.[^.]+$/, '')
      : undefined;
  const words = `${script ?? runner}-${(script ? args.slice(1) : args).join('-')}`
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${words || 'agent'}-${hash}`;
}

export function isolatedTuiRoots(binding?: {
  command: string;
  args?: readonly string[];
}): Record<string, string> | undefined {
  if (process.env['OPENCODE_ACP_CLIENT_SHARED_STATE'] === '1') return undefined;
  // ★ One client = one agent: the TUI's tab layout (tabs.json), db and locks live
  // under a root named after the agent command. Sharing one root let a dsh launch
  // restore an opencode tab, and the model picker then answered with the wrong
  // agent's catalog (reported 2026-10-19). Separate roots make that impossible:
  // each agent's TUI only ever sees the tabs it created.
  const base = join(homedir(), '.opencode-acp-client', 'opencode');
  const root = binding ? join(base, agentStateSlug(binding.command, binding.args)) : base;
  const env: Record<string, string> = {
    XDG_STATE_HOME: join(root, 'state'),
    XDG_DATA_HOME: join(root, 'data'),
    // ★ Config is SHARED with the user's install (the same tui.json, plugins and
    // themes a native opencode uses): redirecting XDG_CONFIG_HOME made every
    // per-agent root carry its own copy, so changing one setting meant editing N
    // files. State/data stay per agent; the optional isolated config root below
    // is the only containment. No symlinks: not redirecting is the one-source-of-
    // truth version of "link them all to ~/.config/opencode/tui.json".
    OPENCODE_DB: join(root, 'data', 'opencode.db'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_FILEWATCHER: '1',
  };
  if (process.env['OPENCODE_ACP_CLIENT_ISOLATED_CONFIG'] === '1') {
    env['OPENCODE_CONFIG_DIR'] = join(root, 'config-root');
  }
  return env;
}

/**
 * The command the user ran, rebuilt for the TUI's exit epilogue.
 *
 * The owner's rule: the `Continue` line must read like the invocation that
 * started THIS process — `oc-acp-client …` when installed as the bin,
 * `node dist/index.js …` when run from a checkout (the actual entry file, not
 * some invented wrapper). process.argv carries resolved paths; the shapes are:
 *   - bin:    argv[1] = <prefix>/bin/oc-acp-client  → basename
 *   - node:   argv[1] = <...>/dist/index.js               → `node <path>`
 *             (relative to cwd when the entry sits under it — how a checkout
 *              is normally launched — absolute otherwise)
 * The remaining words are the user's own argv, verbatim.
 */
export function invocationCommand(): string {
  const entry = process.argv[1] ?? 'oc-acp-client';
  if (/\.m?js$/.test(entry)) {
    const cwd = process.cwd();
    const rel = entry.startsWith(cwd + '/') ? entry.slice(cwd.length + 1) : entry;
    return `node ${rel}`;
  }
  return basename(entry);
}

/**
 * The user's typed command with the resume id in place: an existing
 * `--session <id>` / `-s <id>` value is REPLACED (never appended — appending
 * produced `… --session ses_x … --session ses_y`, the owner's report), and a
 * `-c`/`--continue` becomes `--session <id>` too, because "continue" would
 * reopen whatever is newest at copy-time, not necessarily THIS conversation.
 * The id is the VISIBLE one (`ses_…`): the bridge translates it on the next
 * run. The TUI's own epilogue id cannot be used — on a resumed session it is
 * the AGENT's id (the bridge hands the TUI the translated UUID), which the
 * user should not have to see or copy.
 */
export function resumeCommand(sessionId: string): string {
  // Bridge plumbing flags are dropped from the rebuilt line: they are
  // environment details (a --bridge-log carries an absolute temp path that
  // alone can push the line past the terminal's width), and a hand-typed
  // resume never includes them.
  const BRIDGE_FLAGS = new Set([
    '--bridge-port',
    '--bridge-host',
    '--bridge-log',
    '--no-tui',
  ]);
  const typed = process.argv.slice(2).filter(
    (word, i, all) =>
      !BRIDGE_FLAGS.has(word) &&
      !(i > 0 && BRIDGE_FLAGS.has(all[i - 1] ?? '')) &&
      !/^--bridge-(port|host|log)=/.test(word),
  );
  // One client = one agent: the resume line does NOT carry `-- <agent>` — `-s`
  // infers the agent from the session map. Drop the separator and everything after
  // it; the remaining words are our own flags and opencode pass-throughs.
  const dash = typed.indexOf('--');
  const words = [invocationCommand(), ...(dash === -1 ? typed : typed.slice(0, dash))];
  const out: string[] = [];
  let resumed = false;
  // `-s`, not `--session`: the owner's ask — the Continue line reads like a
  // hand-typed command, and the short spelling is what one actually types.
  const RESUME_FLAG = '-s';
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if (word === '--session' || word === '-s') {
      out.push(RESUME_FLAG, sessionId);
      resumed = true;
      i += 1; // drop the old id
      continue;
    }
    const eq = /^--session=(.*)$/.exec(word);
    if (eq) {
      out.push(RESUME_FLAG, sessionId);
      resumed = true;
      continue;
    }
    if (word === '-c' || word === '--continue') {
      out.push(RESUME_FLAG, sessionId);
      resumed = true;
      continue;
    }
    if (word === '--' && !resumed) {
      // No resume flag in the invocation (the common case: the user started a
      // fresh conversation). Insert one before the agent separator so the
      // copied line reopens THIS session instead of a blank new one.
      out.push(RESUME_FLAG, sessionId, '--');
      resumed = true;
      continue;
    }
    out.push(word);
  }
  // No `--` at all (a native-style argv) — append at the end.
  if (!resumed) out.push(RESUME_FLAG, sessionId);
  return out.join(' ');
}

/**
 * The exit wordmark that replaces opencode's own.
 *
 * The TUI prints its epilogue as `wordmark(4 rows) + blank + Session + Continue
 * + blank`, so the four rows above the trailing blank are its logo. We are not
 * allowed to change opencode's binary, but we CAN overwrite those rows on the
 * way out — the same technique the `Continue` rewrite already uses, just eight
 * rows up instead of two. The result is that the screen the user comes back to
 * names THIS product.
 *
 * Width budget: 8 + 10 glyphs at 3 columns each joined by one space is 73
 * columns with the two-space indent; anything narrower gets a single styled
 * line (the four logo rows are cleared either way).
 */
/**
 * The exit wordmark: the TUI's own "opencode" rows, VERBATIM, plus our product
 * name in the same alphabet.
 *
 * Copying the glyph grammar but redrawing the letters was not enough — the owner
 * could not recognize `opencode` any more ("at least keep those letters
 * unchanged", with screenshots). So the first half is the TUI's own `logo.left`
 * and `logo.right` strings and its own `wordmark()` painter, byte for byte; the
 * second half spells `acp client` with the same 4-column alphabet (interior `_`
 * cells for the shadow, `^`/`~` accents), in the bright half's palette.
 */
const NATIVE_OPEN = [
  '                   ',
  '█▀▀█ █▀▀█ █▀▀█ █▀▀▄',
  '█__█ █__█ █^^^ █__█',
  '▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀',
];
const NATIVE_CODE = [
  '             ▄     ',
  '█▀▀▀ █▀▀█ █▀▀█ █▀▀█',
  '█___ █__█ █__█ █^^^',
  '▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀',
];
/** The letters the native logo does not have, in the same 4-column grammar. */
const EXTRA_GLYPHS: Record<string, string[]> = {
  a: ['    ', '▀▀▀█', '█__█', '▀▀▀▀'],
  c: ['    ', '█▀▀▀', '█___', '▀▀▀▀'],
  p: ['    ', '█▀▀█', '█__█', '▀▀▀ '],
  l: ['    ', '█   ', '█   ', '▀▀▀▀'],
  i: [' ▄  ', ' █  ', ' █  ', ' ▀▀ '],
  e: ['    ', '█▀▀█', '█^^^', '▀▀▀▀'],
  n: ['    ', '█▀▀▄', '█__█', '▀~~▀'],
  t: ['    ', '███ ', ' █  ', ' ▀▀ '],
  ' ': ['    ', '    ', '    ', '    '],
};
const WORDMARK_ACP = 'acp';
const WORDMARK_CLIENT = 'client';
const WORDMARK_FG = '\x1b[90m';
const WORDMARK_BRIGHT = '\x1b[39m';
const WORDMARK_SHADOW = '\x1b[38;5;235m';
const WORDMARK_BG = '\x1b[48;5;235m';
const WORDMARK_SHADOW_BRIGHT = '\x1b[38;5;238m';
const WORDMARK_BG_BRIGHT = '\x1b[48;5;238m';
const WORDMARK_RESET = '\x1b[0m';

/** The TUI's own `wordmark()` painter, character for character. */
function drawGlyph(line: string, fg: string, shadow: string, bg: string): string {
  return [...line]
    .map((char) => {
      if (char === '_') return `${bg} ${WORDMARK_RESET}`;
      if (char === '^') return `${fg}${bg}▀${WORDMARK_RESET}`;
      if (char === '~') return `${shadow}▀${WORDMARK_RESET}`;
      if (char === ' ') return ' ';
      return `${fg}${char}${WORDMARK_RESET}`;
    })
    .join('');
}

function glyphRow(text: string, row: number): string {
  return [...text].map((char) => EXTRA_GLYPHS[char]?.[row] ?? '    ').join(' ');
}

/**
 * Four rows: the native wordmark, a space, then `acp client`. 91 columns with
 * the indent; a narrower terminal gets one plain line instead (the rows would
 * wrap and the cursor arithmetic would land somewhere else).
 */
export function epilogueWordmark(columns: number): string[] {
  // `open` (19) + a space + `code` (19) + gap + `acp` (14) + gap + `client` (29),
  // plus the two-space indent. The two gaps are the SAME width — a one-space gap
  // after the bright `code` read as no gap at all, while the 4-column space glyph
  // the first version used made `acp  client` look like two words apart.
  const gap = '  ';
  const width =
    2 +
    (NATIVE_OPEN[1]!.length * 2 + 1) +
    gap.length +
    (WORDMARK_ACP.length * 5 - 1) +
    gap.length +
    (WORDMARK_CLIENT.length * 5 - 1);
  if (columns < width + 1) {
    return [`  ${WORDMARK_BRIGHT}opencode acp client${WORDMARK_RESET}`];
  }
  return [0, 1, 2, 3].map(
    (row) =>
      `  ${drawGlyph(NATIVE_OPEN[row]!, WORDMARK_FG, WORDMARK_SHADOW, WORDMARK_BG)} ` +
      `${drawGlyph(NATIVE_CODE[row]!, WORDMARK_BRIGHT, WORDMARK_SHADOW_BRIGHT, WORDMARK_BG_BRIGHT)}` +
      gap +
      // `acp` in the dark half's palette (the owner's ask: same as `open`), and
      // `client` in the bright one, keeping the native dark/bright rhythm.
      `${drawGlyph(glyphRow(WORDMARK_ACP, row), WORDMARK_FG, WORDMARK_SHADOW, WORDMARK_BG)}` +
      gap +
      `${drawGlyph(glyphRow(WORDMARK_CLIENT, row), WORDMARK_BRIGHT, WORDMARK_SHADOW_BRIGHT, WORDMARK_BG_BRIGHT)}`,
  );
}

function formatAge(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** This package's version, for the daemon registry (best effort). */
function productVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * `oc-acp-client ps` — every bridge this tool recorded, newest first.
 *
 * Stale entries (a pid that no longer exists) are exactly the cleanup signal:
 * a bridge that exits cleanly removes its own record, so a leftover means
 * something killed it without running the shutdown path — and its agent may
 * still be alive holding a backend's session lock. `--prune` forgets those
 * records; `--kill` is the explicit, never-automatic way to stop live ones.
 */
/**
 * `sessions` — every remembered conversation, newest first.
 *
 * Reads the same map the bridge writes, so it works with no bridge and no agent running.
 * `--limit`/`--offset` page it (`--next` is sugar for "offset by one page"); `--all`
 * prints everything and `--json` gives the rows unformatted.
 */
function runSessionsCommand(args: ParsedArgs): void {
  if (args.sessionsUnknown.length > 0) {
    // ★ Not a warning and not a silent default. `--director` (one letter short) used to be
    // swallowed and the command printed every session, which reads exactly like "the
    // filter does not work" — the failure hides the flag AND the feature.
    process.stderr.write(
      `  unknown option${args.sessionsUnknown.length > 1 ? 's' : ''} for \`sessions\`: ` +
        `${args.sessionsUnknown.join(' ')}\n` +
        '  known: --limit N, --offset N, --all, --directory S, --agent A, --width N, --json\n',
    );
    process.exitCode = 2;
    return;
  }
  const map = new SessionMap(() => {});
  const filter: SessionListOptions = {
    ...(args.sessionsDirectory ? { directory: args.sessionsDirectory } : {}),
    ...(args.sessionsAgent ? { agent: args.sessionsAgent } : {}),
  };
  const total = countSessions(map, filter);
  const limit = args.sessionsLimit === 0 ? Math.max(total, 1) : args.sessionsLimit;
  const offset = args.sessionsOffset >= 0 ? args.sessionsOffset : 0;
  const rows = listSessions(map, { ...filter, limit, offset });

  if (args.sessionsJson) {
    process.stdout.write(`${JSON.stringify({ total, offset, limit, sessions: rows }, null, 2)}\n`);
    return;
  }
  if (total === 0) {
    process.stdout.write('  no sessions remembered yet.\n');
    return;
  }
  if (rows.length === 0) {
    process.stdout.write(`  nothing at offset ${offset} (${total} remembered)\n`);
    return;
  }
  // `stdout.columns` is undefined whenever the output is piped, which is exactly when a
  // wide table is most useful; `--width` covers that.
  const width = args.sessionsWidth ?? process.stdout.columns ?? 100;
  process.stdout.write(`${renderSessions(rows, { width })}\n\n`);
  const shown = `${offset + 1}-${offset + rows.length} of ${total}`;
  if (offset + rows.length < total) {
    process.stdout.write(`  ${shown}  —  next page: --offset ${offset + rows.length}\n`);
  } else {
    process.stdout.write(`  ${shown}\n`);
  }
}

/**
 * `upgrade` / `update` — move this package, not opencode.
 *
 * `--check` reports what it found and stops; without it the installer runs, with the same
 * method that installed the current copy (see `detectManager`).
 */
async function runUpgradeCommand(args: ParsedArgs): Promise<void> {
  if (args.unknownUpgrade.length > 0) {
    process.stderr.write(
      `  unknown option${args.unknownUpgrade.length > 1 ? 's' : ''} for \`upgrade\`: ` +
        `${args.unknownUpgrade.join(' ')}\n  usage: upgrade [<version>] [--check]\n`,
    );
    process.exitCode = 2;
    return;
  }
  const { plan, found } = planUpgrade(args.upgradeTarget);
  if (!found) {
    process.stderr.write(
      `  ${PACKAGE_NAME} is not published to the registry this npm points at, so there is\n` +
        `  nothing to upgrade to from here. Install from the repo to track its main branch.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`  ${PACKAGE_NAME} ${plan.current} → ${plan.latest}\n`);
  process.stdout.write(`  method: ${plan.manager} (${plan.reason})\n`);
  if (plan.upToDate) {
    process.stdout.write(`  already up to date\n`);
    return;
  }
  if (args.upgradeCheck) {
    process.stdout.write(`  would run: ${plan.command.join(' ')}\n`);
    return;
  }
  process.exitCode = await runUpgrade(plan, (line) => process.stdout.write(`${line}\n`));
}

function runPsCommand(args: ParsedArgs): void {
  const entries = listDaemons();
  const alive = entries.filter((entry) => entry.alive);
  const stale = entries.filter((entry) => !entry.alive);

  if (args.psKill) {
    for (const entry of alive) {
      try {
        process.kill(entry.record.pid, 'SIGTERM');
        process.stdout.write(`  sent SIGTERM to ${entry.record.pid}\n`);
      } catch (err) {
        process.stdout.write(`  could not signal ${entry.record.pid}: ${String(err)}\n`);
      }
    }
  }

  if (args.psJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          daemons: entries.map((entry) => ({ ...entry.record, alive: entry.alive })),
          alive: alive.length,
          stale: stale.length,
        },
        undefined,
        2,
      )}\n`,
    );
  } else if (entries.length === 0) {
    process.stdout.write('  no bridge processes recorded.\n');
  } else {
    const header = ['PID', 'STATE', 'AGE', 'AGENT', 'DIRECTORY', 'URL'];
    const rows = entries.map((entry) => [
      String(entry.record.pid),
      entry.alive ? 'alive' : 'stale',
      formatAge(entry.record.startedAt),
      [entry.record.agent, ...(entry.record.agentArgs ?? [])].join(' '),
      entry.record.directory,
      entry.record.url,
    ]);
    const widths = header.map((title, index) =>
      Math.max(title.length, ...rows.map((row) => (row[index] ?? '').length)),
    );
    const render = (row: string[]): string =>
      '  ' + row.map((cell, index) => (cell ?? '').padEnd(widths[index]!)).join('  ').trimEnd();
    process.stdout.write(`${render(header)}\n`);
    for (const row of rows) process.stdout.write(`${render(row)}\n`);
    process.stdout.write(
      `\n  ${alive.length} alive, ${stale.length} stale` +
        (stale.length > 0 ? ' (--prune forgets stale records)' : '') +
        '\n',
    );
  }

  if (args.psPrune) {
    const removed = pruneDaemons();
    process.stdout.write(`  pruned ${removed} stale record(s)\n`);
  }
}

/**
 * Fix the TUI's exit epilogue so the `Continue` line resumes THIS product.
 *
 * ★ Why not a stdout pipe: the TUI probes the stdio it is handed for TTY-ness
 * (terminal size, mouse). A piped stdout is not a TTY, and the measured result
 * was a small window glued to the terminal's top-left corner — the full-screen
 * layout collapsed to a fallback size. stdio therefore stays inherited, and the
 * rewrite happens AFTER the child exits.
 *
 * ★ The geometry is exact: the epilogue ends with `Continue …\n\n` (a trailing
 * blank line), so when the TUI finishes the cursor sits TWO rows below the
 * `Continue` row. `ESC[2A` lands on it, `CR + ESC[2K` clears the row, and the
 * replacement is printed with the blank restored.
 *
 * ★ The four logo rows sit ABOVE the Session row, i.e. eight rows above the
 * cursor, and they are replaced in the same pass (`ESC[8A`, four rows, then
 * `ESC[4B` back to the cursor's original row). Every opencode v2 build we
 * support prints that wordmark; the version gate already refuses <2.
 *
 * ★ Guards: only on a TTY, and only when the bridge served a session (the
 * epilogue exists). The line must not wrap — a wrapped row breaks the two-row
 * geometry — so an over-long one is SHORTENED, not abandoned: the full command
 * first, then a form without the agent tail (`oc-acp-client -s ses_…`).
 * Abandoning it (an earlier shape) left the native `opencode -s …` line, which
 * the owner reported as the rewrite "not working" — measured on a 130-column
 * terminal where the full line was 149 columns.
 */
function rewriteEpilogue(epilogueTarget: () => string | undefined, log: (line: string) => void): void {
  const out = process.stdout;
  if (!out.isTTY) {
    log('[bridge] epilogue left as-is: stdout is not a TTY');
    return;
  }
  // A probe for the geometry itself: leave the TUI's epilogue untouched so a
  // capture shows exactly what it printed (used while measuring the wordmark
  // rows; harmless otherwise, and cheaper than guessing).
  if (process.env['OPENCODE_ACP_CLIENT_EPILOGUE_PROBE'] === '1') {
    log('[bridge] epilogue left as-is: probe mode');
    return;
  }
  const sessionId = epilogueTarget();
  if (!sessionId) {
    // Nothing to resume, so there is no Continue line to write — but the TUI has still
    // printed its own epilogue, and on a screen with no transcript it lands on top of
    // whatever was there before the client started (measured in tmux: the native TUI
    // exits from the welcome screen leaving its block over the user's old prompt lines).
    // Clear from the cursor down so the terminal is tidy; this only touches the visible
    // area, never the scrollback.
    out.write('\r\x1b[J');
    log('[bridge] epilogue cleared: no session was named this run');
    return;
  }
  const columns = out.columns ?? 80;
  const line = epilogueLine(sessionId, columns);
  if (!line) {
    log(`[bridge] epilogue left as-is: even '${shortResumeCommand(sessionId)}' would wrap in ${columns} columns`);
    return;
  }
  // ★ Replace the wordmark above the `Continue` row too. The TUI's epilogue is
  // `logo(4 rows) + blank + Session + Continue + blank`, so the logo is exactly
  // eight rows above where the cursor sits now. We cannot change opencode's
  // binary, but overwriting its own rows is the same trick this function already
  // uses for the Continue line — and it makes the screen the user returns to
  // name THIS product instead of the TUI it borrowed.
  const wordmark = epilogueWordmark(columns);
  // ★ Anchored on the Continue row, never on an absolute offset. The epilogue is
  // `logo + blank + Session + Continue + blank`, and the TUI's logo is four rows
  // whose FIRST is all spaces — the row that scrolls away when the block sits at
  // the bottom of the screen. Measured in tmux: moving up eight rows from the
  // cursor landed on the blank row in a tall screen but one row ABOVE the top in
  // a 42-row pane, which lost our first row and shifted everything up. The three
  // visible logo rows are always `cursor-7 .. cursor-5`, so those are the rows we
  // write, and `cursor-2` is always the Continue row.
  // One write for the whole block: it cannot interleave with itself, and it ends
  // on the Continue line (no trailing newlines, which could scroll a bottom-row
  // block).
  const logoRows = [...wordmark];
  // The TUI's block is four rows; the top row is mostly blank, so if the screen
  // scrolled it is the row that went off (and clipping it is what the native logo
  // does too). Pad regardless: the cursor arithmetic must not depend on the
  // fallback having produced fewer rows.
  while (logoRows.length < 4) logoRows.push('');
  // ★ Ends with a newline: without it the user's shell prompt was printed on the
  // same line as `Continue` (owner's screenshot). The two newlines restore the
  // blank line the TUI itself leaves after the block.
  out.write(
    `\x1b[8A${logoRows.map((row) => `\r\x1b[2K${row}\n`).join('')}\x1b[2B` +
      `\r\x1b[2K${line}\n`,
  );
  log(`[bridge] epilogue rewritten: ${line}`);
}

/**
 * The replacement `Continue` row, or undefined when even the shortest form would
 * wrap.
 *
 * Exported and pure because the width rule has a measured history: an over-long
 * line was once ABANDONED (leaving the TUI's native `opencode -s …` — read by the
 * owner as "the rewrite is broken"), and the fix was to shorten it instead. A
 * wrapped row also breaks the `ESC[2A` geometry, which is why the length check is
 * a hard filter rather than best effort. `  Continue  ` is the client's own
 * prefix and is part of the measurement.
 */
export function epilogueLine(sessionId: string, columns: number): string | undefined {
  const command = [resumeCommand(sessionId), shortResumeCommand(sessionId)].find(
    (candidate) => `  Continue  ${candidate}`.length < columns,
  );
  return command ? `  Continue  ${command}` : undefined;
}

/** The narrow-terminal fallback: the launcher and the id, nothing else. */
function shortResumeCommand(sessionId: string): string {
  return `${invocationCommand()} -s ${sessionId}`;
}

/**
 * The id the exit epilogue's `Continue` line should name, in order of how sure
 * we are about it. Pure and exported so the ordering itself can be tested; the
 * three sources and why they rank this way:
 *
 *   1. `prompted` — the session the user actually TYPED into this run. The one
 *      signal the bridge owns outright (it is set at the top of the prompt
 *      handler), so nothing outranks it.
 *   2. `intent` — the session the user ASKED to resume (`--session <id>`, or the
 *      id `-c` resolved to). This is intent, not inference. Measured: with
 *      several restored tabs the client hydrates each one in turn, and the
 *      last-read heuristic named a DIFFERENT tab than the one the user resumed.
 *   3. `viewed` — the last session the client hydrated/read. A resume with no
 *      typing and no flag lands here; it beats leaving the TUI's native
 *      `opencode -s <id>` line in place (which names neither this product nor
 *      an id the native daemon knows), but a prefetch can end up last, so it
 *      never outranks intent.
 */
export function epilogueSessionCandidates(sources: {
  prompted?: string | undefined;
  intent?: string | undefined;
  viewed?: string | undefined;
}): string[] {
  return [sources.prompted, sources.intent, sources.viewed].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
}

export function epilogueSessionId(sources: {
  prompted?: string | undefined;
  intent?: string | undefined;
  viewed?: string | undefined;
}): string | undefined {
  return epilogueSessionCandidates(sources)[0];
}

/**
 * The epilogue may only name an id the NEXT start can resolve.
 *
 * Measured by the owner (2026-10-18): after a real conversation the line said
 * `-s ses_eb55…`, and the next start answered "unknown session id" — the session had a
 * record, but its map pairing was filed under a different (pre-adoption) id. That
 * particular bug is fixed at the source, but a session that never reached an agent (a
 * POST with no prompt) still has no pairing, and the `viewed` tier can name it. So the
 * candidate list is filtered by `resolveSessionId`: never print a line that cannot work.
 */
export function firstResolvableSessionId(
  candidates: Array<string | undefined>,
  resolve: (id: string) => string | undefined = (id) => resolveSessionId(id),
): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      resolve(candidate);
      return candidate;
    } catch {
      // Provably unknown (`ses_…` with no map entry): try the next tier instead of
      // printing a Continue line that is guaranteed to fail.
    }
  }
  return undefined;
}

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function runToCompletion(command: string, argv: string[], log: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { stdio: 'inherit' });
    child.on('error', (err) => {
      log(`[bridge] ${command} failed: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Where our own logs go.
 *
 * When the TUI is started (the default) it takes over the terminal, and any
 * stray write — even one log line — tears its rendering. So in that mode the
 * default sink is a file rather than stderr, and the path is printed once,
 * before the TUI starts, while the terminal is still ours.
 */
function makeLogSink(args: ParsedArgs): { log: (line: string) => void; where: string } {
  const path = args.logPath ?? (args.launch ? join(mkdtempSync(join(tmpdir(), 'acp-bridge-')), 'bridge.log') : undefined);
  if (!path) return { log: (line) => process.stderr.write(`${line}\n`), where: 'stderr' };
  const stream = createWriteStream(path, { flags: 'a' });
  // Everything that writes to the terminal must go through here, or it tears the TUI's
  // rendering. `sse.ts` logs its frames with `console.error` directly, and the default sink
  // in server.ts is `process.stderr`: in the single-entry mode both land on the same
  // terminal the TUI is drawing on, and every broadcast damages the screen — which is what
  // made a shell card's content disappear while the rest of the row survived. The split
  // setups never showed it because their bridge wrote to another window. Redirecting the
  // console here covers those two and anything added later.
  const forward = (level: string, parts: unknown[]): void => {
    stream.write(`${level} ${parts.map((p) => (typeof p === 'string' ? p : String(p))).join(' ')}\n`);
  };
  console.error = (...parts: unknown[]) => forward('[stderr]', parts);
  console.log = (...parts: unknown[]) => forward('[stdout]', parts);
  return { log: (line) => stream.write(`${line}\n`), where: path };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // `ps`: no agent, no TUI, no opencode binary — just the registry.
  if (args.bridgeCommand === 'upgrade') {
    await runUpgradeCommand(args);
    return;
  }
  if (args.bridgeCommand === 'sessions') {
    runSessionsCommand(args);
    return;
  }
  if (args.bridgeCommand === 'ps') {
    runPsCommand(args);
    return;
  }

  // A NATIVE opencode subcommand (`models`, `acp`, `api`, `plugin`, `run`, …):
  // the command means opencode itself, so behave as the binary would — argv
  // as-is, the binary's own output on our stdio, its exit code as ours. No
  // bridge is started (nothing speaks ACP), no TUI (the subcommand is not the
  // TUI), no agent requirement (that is why this check precedes the agent
  // preflight: `oc-acp-client models` must work without an `-- <agent>`
  // argument at all).
  if (args.nativeCommand) {
    const binary = resolveOpenCodeBinary();
    const dashIndex = process.argv.indexOf('--');
    const argv = process.argv.slice(2, dashIndex === -1 ? undefined : dashIndex);
    if (args.nativeSubcommand && WRAPPED_SUBCOMMANDS.has(args.nativeSubcommand) && args.agentCommand) {
      // A WRAPPED subcommand: the answer must come from THIS product's server —
      // the agent's models, the agent's sessions — not opencode's own daemon.
      // Start the bridge server-only, run the opencode binary with --server
      // pointing at it (its own official handler renders the output), mirror
      // the exit code, shut the bridge down. No TUI: the subcommand is not
      // the TUI. An agent is REQUIRED here — without `-- <agent>` there is
      // nothing to answer about, and the raw passthrough below handles that.
      await runWrappedSubcommand(args, binary, argv);
    }
    try {
      execFileSync(binary.path, argv, { stdio: 'inherit', killSignal: 'SIGINT' });
      process.exit(0);
    } catch (err) {
      // execFileSync throws on a non-zero exit; the child's stdio is already
      // ours, so only the exit code is left to mirror.
      const status = (err as { status?: number }).status;
      process.exit(status === undefined ? 1 : status);
    }
  }

  const { log, where } = makeLogSink(args);
  // Machine-facing noise ON A TERMINAL: the launch path inherits the terminal,
  // and this line (like the ready JSON) was left on the primary screen, where it
  // reappeared under the TUI on exit. Print it only when something is capturing
  // the stream (a script, a log) or when serving without a TUI.
  if (!args.launch || !process.stderr.isTTY) process.stderr.write(`[bridge] logs: ${where}\n`);

  // One client = one agent: with -s the session's map entry names the agent; with -c
  // the newest remembered session for this directory does. No `--` is needed (or
  // accepted) in either case. A new session still needs `-- <agent>`.
  if (args.session || args.continueSession) {
    const map = new SessionMap(() => undefined);
    if (args.session) {
      const owner = map.agentFor(args.session);
      if (!owner) {
        const known = map.acpIdFor(args.session) !== undefined;
        throw new Error(
          known
            ? `session ${args.session} predates the agent binding; start a new session with -- <agent>`
            : `cannot infer the agent for ${args.session}: it is not in the session map; ` +
                `start a new session with -- <agent>`,
        );
      }
      args.agentCommand = owner.command;
      args.agentArgs = [...owner.args];
    } else {
      const entry = newestContinueEntry(map.entries(), args.directory);
      if (!entry) {
        throw new Error(
          `no session to continue in ${args.directory}; start a new one with -- <agent>`,
        );
      }
      args.agentCommand = entry.agent.command;
      args.agentArgs = [...entry.agent.args];
      args.session = entry.visibleId;
      log(`[bridge] -c -> ${entry.visibleId} (${agentBindingLabel(entry.agent)})`);
    }
  }
  // Fail fast on an agent command that cannot run (see findExecutable). Fatal
  // when we are about to start the TUI — there is a human waiting for one — and
  // advice-only when serving, where the operator may be wiring things up.
  if (args.agentCommand === undefined) {
    throw new Error('missing agent command (put it after --)');
  }
  if (!findExecutable(args.agentCommand, process.env, args.directory)) {
    const problem = `agent command not found: ${args.agentCommand}`;
    if (args.launch) {
      throw new Error(`${problem} (put a runnable command after --, or pass --no-tui to serve without one)`);
    }
    log(`[bridge] warning: ${problem}; continuing as a server`);
  }

  // `--session <id>` takes the id the TUI shows (`ses_…`) — but the agent only
  // answers to its OWN id (a UUID), and the two never match. The session map is
  // exactly the visible→agent pairing, written on every session this bridge
  // serves, so translate before resuming. An id the map does not know is
  // passed through as given: the agent's session/load answers for whether it
  // exists — that keeps `--session <agent-uuid>` working for ids learned
  // elsewhere (dsh's web UI shows those).
  const launchBinding = args.agentCommand
    ? { command: args.agentCommand, args: args.agentArgs }
    : undefined;
  const resolvedSession = resolveSessionId(args.session, log, launchBinding);

  // Resolve the client version before the bridge starts so `/api/info` reports the
  // same version the TUI will compare against itself. The fallback (direct
  // BridgeServer construction) is only for tests/desktop with no launcher.
  const clientBinary = resolveOpenCodeBinary();
  const clientVersion = await readOpenCodeVersion(clientBinary);
  const clientVersionLabel = clientVersion
    ? `${clientVersion.major}.${clientVersion.minor}.${clientVersion.patch}`
    : undefined;
  const server = new BridgeServer({
    command: args.agentCommand!,
    args: args.agentArgs,
    directory: args.directory,
    host: args.host,
    port: args.port,
    clientVersion: clientVersionLabel,
    resumeSession: resolvedSession,
    resumeVisibleSessionId: args.session,
    eagerCatalog: process.env['OPENCODE_ACP_CLIENT_EAGER_CATALOG'] === '1',
    continueMode: false,
    onLog: log,
  });

  const { host, port } = await server.listen();
  const url = `http://${host}:${port}`;
  // Same rule as the log line: the ready line is for scripts that need the port.
  // On a terminal the user never reads it, and it was part of the exit noise.
  if (!args.launch || !process.stdout.isTTY) {
    process.stdout.write(
      `${JSON.stringify({
        type: 'ready',
        url,
        directory: args.directory,
        agent: args.agentCommand,
      })}\n`,
    );
  }

  // Record this bridge so `ps` can find it even if the process is killed later
  // (the record is removed on a clean shutdown; a leftover IS the stale signal).
  registerDaemon({
    directory: args.directory,
    agent: args.agentCommand!,
    agentArgs: args.agentArgs ?? [],
    url,
    version: productVersion(),
  });

  // Shutdown discipline. Installed before anything that can take real time:
  // a Ctrl-C during a slow (or broken) agent startup must still stop us, or the
  // agent child is orphaned with nobody left to dispose it.
  //
  // `client` is the opencode v2 TUI and the only child this process spawns itself;
  // every agent and shell the server owns is disposed by `server.close()`. Both
  // go through explicit PIDs — never a name-based kill.
  let client: ReturnType<typeof spawn> | undefined;
  let shuttingDown = false;
  let signalGrace: NodeJS.Timeout | undefined;
  const shutdown = async (
    reason: string,
    code = 0,
    options: { keepClient?: boolean } = {},
  ): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signalGrace) {
      clearTimeout(signalGrace);
      signalGrace = undefined;
    }
    log(`[bridge] ${reason}, shutting down`);
    if (!options.keepClient) client?.kill(reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    await server.close();
    unregisterDaemon();
    process.exit(code);
  };
  // ★ A signal reaches the TUI too (same process group), and the TUI exits through
  // its own quit path — the path that prints the `Continue` epilogue this product
  // rewrites. Exiting here first raced that: measured on Ctrl-C, the native
  // `Continue  opencode -s …` line appeared with no rewrite. Wait for the child's
  // 'close' (which owns the rewrite), with a grace period so a TUI that ignores
  // the signal cannot leave us serving forever.
  const onSignal = (reason: string): void => {
    if (shuttingDown) return;
    if (!client) {
      void shutdown(reason);
      return;
    }
    log(`[bridge] ${reason}, waiting for the TUI to exit`);
    if (signalGrace) return;
    signalGrace = setTimeout(() => {
      signalGrace = undefined;
      void shutdown(reason);
    }, 5_000);
  };
  // The shutdown path covers SIGINT/SIGTERM and the TUI exiting; this covers any
  // other orderly exit (a throw, `process.exit` from a wrapped subcommand path).
  process.on('exit', () => unregisterDaemon());
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  // SIGHUP is how a terminal session ends (closing the window, tmux kill-session,
  // the parent shell dying). Without a handler the bridge dies INSTANTLY and its
  // agent children are orphaned — measured: 14 orphaned dsh processes held the
  // workspace's one-writer lock and every later session/load answered "Internal
  // error", so resumed conversations came up blank until the orphans were
  // reaped by hand. The handler gives the same orderly teardown as Ctrl-C.
  process.on('SIGHUP', () => onSignal('SIGHUP'));

  // Give ACP a moment to advertise its models before the TUI can read them,
  // otherwise it submits the placeholder and the session breaks.
  if (args.launch) await server.waitForCatalog();

  // What the exit epilogue names: see `epilogueSessionId` for the ordering and
  // the measurements behind it. `args.session` is the id the USER typed (the
  // visible one), and `continueSession.visibleId` is the visible pair for the id
  // `-c` resolved to; both are what `--session` accepts on the next run.
  const resumeTarget = args.session;
  // Kept in a named binding because the close handler below (which owns the
  // epilogue rewrite) needs the same closure.
  const epilogueTarget = () =>
    firstResolvableSessionId(
      epilogueSessionCandidates({
        prompted: server.promptedSessionId(),
        intent: resumeTarget,
        viewed: server.viewedSessionId(),
      }),
    );
  client = await handleClient(
    args,
    url,
    resolvedSession,
    epilogueTarget,
    log,
    (message) => {
      // A TUI that never started must not leave us serving nothing.
      log(`[bridge] ${message}`);
      void shutdown('TUI launch failed', 1);
    },
  );

  if (client) {
    // The TUI owns the session: when it exits, so do we, and its exit code is
    // the useful one. This is what leaves no adapter behind.
    // ★ 'close' (stdio drained), not 'exit': the epilogue is written by the TUI's
    // own scrollback writer, and rewriting on 'exit' interleaved with it —
    // measured: the first wordmark row was lost and the block shifted up by one.
    client.on('close', (code) => {
      rewriteEpilogue(epilogueTarget, log);
      void shutdown('the TUI exited', code ?? 0);
    });
  }
}

/**
 * Whether this file is the program being run.
 *
 * `process.argv[1]` is a *symlink* path when the command is installed as a bin
 * (`/…/bin/oc-acp-client`), while `import.meta.url` is the real file, so
 * comparing the strings directly makes the CLI a no-op that exits 0. Resolve
 * both sides before comparing.
 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A missing entry (e.g. `node -e`) is simply not a direct invocation.
    return false;
  }
}

const invokedDirectly = isDirectInvocation();

if (invokedDirectly || process.env.OPENCODE_ACP_CLIENT_RUN === '1') {
  main().catch((err) => {
    process.stderr.write(`oc-acp-client: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
