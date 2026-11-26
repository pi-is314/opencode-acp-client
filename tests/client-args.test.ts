import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { removeDirSync } from './remove-dir.js';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseArgs, clientArgs, findExecutable, resumeCommand, isolatedTuiRoots, resolveSessionId, epilogueSessionId, firstResolvableSessionId, epilogueLine, epilogueWordmark, newestContinueEntry, printHelp } from '../src/index.js';

function parsed(extra: string[]): ReturnType<typeof parseArgs> {
  return parseArgs([...extra, '--', 'some-agent', '--flag']);
}

describe('launched client arguments', () => {
  it('does not pass --session by default, so the client opens its home screen', () => {
    // With a session forced, the TUI skips home and drops into an empty session.
    expect(clientArgs(parsed([]), 'http://127.0.0.1:4096')).not.toContain('--session');
  });

  it('refuses --standalone before it could contradict --server', () => {
    // It asks the TUI to start a server of its own, which is exactly what the bridge
    // replaces — so parsing stops rather than filtering it out downstream.
    expect(() => parsed(['--standalone'])).toThrow(/--standalone/);
  });

  it('keeps the server url and the directory', () => {
    // The bare positional is opencode's own <directory> spelling; the bridge
    // adopts it as its workspace and the TUI receives it as its directory.
    const argv = clientArgs(parsed(['/work']), 'http://127.0.0.1:1');
    expect(argv).toContain('http://127.0.0.1:1');
    expect(argv).toContain('/work');
  });

  it('passes --session when resuming, so the TUI opens that conversation', () => {
    const argv = clientArgs(parsed([]), 'http://x', 'fc892b71-ab44');
    expect(argv).toContain('--session');
    expect(argv[argv.indexOf('--session') + 1]).toBe('fc892b71-ab44');
  });

  it('forwards unknown flags to the TUI verbatim — opencode is the only contract', () => {
    // The owner's rule: anything not ours is opencode's business. `--auto` and
    // `--prompt <text>` are opencode flags we never name in our help.
    const argv = clientArgs(parsed(['--auto', '--prompt', 'hi']), 'http://x');
    expect(argv).toContain('--auto');
    expect(argv).toContain('--prompt');
    expect(argv[argv.indexOf('--prompt') + 1]).toBe('hi');
  });

  it('forwards a subcommand; the bare directory is claimed by the bridge', () => {
    // Only the FIRST bare positional is the workspace; later bare words (a
    // subcommand like `models`) are opencode's business and forward.
    const got = parseArgs(['/work', 'models', '--', 'agent']);
    expect(got.directory).toBe('/work');
    expect(got.passThrough).toEqual(['models']);
  });

  it('refuses opencode\'s subcommands instead of forwarding them', () => {
    // ★ This tool and opencode share a name prefix and nothing else. Forwarding the words
    // meant `oc-acp-client upgrade` upgraded OPENCODE, `auth`/`mcp`/`plugin` managed
    // opencode's local state, and — because it was silent — each one looked like this
    // package answering about itself. They are refused now, with a pointer to opencode.
    // The refusal happens while parsing, before any bridge or TUI could start — that is
    // the point: the word must never reach opencode.
    for (const word of ['auth', 'mcp', 'plugin', 'run', 'session', 'models', 'api', 'serve', 'acp']) {
      expect(() => parseArgs([word, '--', 'agent']), word).toThrow(/is opencode's command/);
      expect(() => parseArgs([word, '--', 'agent']), word).toThrow(new RegExp(`opencode ${word}`));
    }
  });

  it('owns upgrade and update itself', () => {
    // The word that started this: it used to upgrade the opencode binary.
    expect(parseArgs(['upgrade']).bridgeCommand).toBe('upgrade');
    expect(parseArgs(['update']).bridgeCommand).toBe('upgrade');
    expect(parseArgs(['upgrade', '0.4.0']).upgradeTarget).toBe('0.4.0');
    expect(parseArgs(['upgrade', '--', 'agent']).bridgeCommand).toBe('upgrade');
    expect(parseArgs(['upgrade', '--check']).upgradeCheck).toBe(true);
    expect(parseArgs(['upgrade', '--nope']).unknownUpgrade).toEqual(['--nope']);
  });

  it('still claims a plain directory that is not a subcommand', () => {
    const got = parseArgs(['/work', '--', 'agent']);
    expect(got.nativeCommand).toBe(false);
    expect(got.directory).toBe('/work');
  });

describe('single entry point', () => {
  it('starts the TUI by default — one command from nothing to a working TUI', () => {
    expect(parsed([]).launch).toBe(true);
  });

  it('--no-tui serves the HTTP surface only', () => {
    expect(parsed(['--no-tui']).launch).toBe(false);
  });

  it('forwards --launch to the TUI: the passthrough rule replaced the error', () => {
    // `--launch` was once a bridge flag, removed, then an error. Under the
    // passthrough contract an unrecognized word is opencode's business — so it
    // forwards, and the TUI answers for it.
    const got = parsed(['--launch']);
    expect(got.passThrough).toContain('--launch');
  });

  it('still turns the TUI off with --no-tui', () => {
    expect(parsed(['--no-tui']).launch).toBe(false);
  });
});

});

describe('removed and renamed options', () => {
  // Where opencode and the bridge disagree on a flag's meaning, the bridge's flag
  // is bridge-qualified (the owner's rule): `--port` is opencode's own server, ours
  // is `--bridge-port`. The old unqualified bridge spellings are no longer errors —
  // they forward to the TUI — so the RENAMES are what the tests pin here.
  it("names the bridge port --bridge-port, not opencode's --port", () => {
    const got = parseArgs(['--bridge-port', '4096', '--', 'agent']);
    expect(got.port).toBe(4096);
    // opencode's --port is passthrough now: it belongs to the TUI, and its
    // value travels with it (the pair rule).
    const passthrough = parseArgs(['--port', '1234', '--', 'agent']);
    expect(passthrough.port).toBe(0);
    expect(passthrough.passThrough).toEqual(['--port', '1234']);
    expect(passthrough.directory).toBe(process.cwd());
  });

  it('--bridge-port implies server-only; --bridge-host alone is an error', () => {
    const served = parseArgs(['--bridge-port', '4096', '--', 'agent']);
    expect(served.launch).toBe(false);
    expect(served.port).toBe(4096);
    expect(served.host).toBe('127.0.0.1');
    // A host is only meaningful with a port, or with an explicit --no-tui
    // (the random-port server); alone it would silently do nothing for the TUI.
    expect(() => parseArgs(['--bridge-host', '0.0.0.0', '--', 'agent'])).toThrow(/needs --bridge-port/);
    expect(parseArgs(['--bridge-host', '0.0.0.0', '--bridge-port', '4096', '--', 'agent']).host).toBe('0.0.0.0');
    expect(parseArgs(['--bridge-host', '0.0.0.0', '--no-tui', '--', 'agent']).launch).toBe(false);
    // Order does not matter: --no-tui after the host still makes it valid.
    expect(parseArgs(['--bridge-host', '0.0.0.0', '--no-tui', '--', 'agent']).host).toBe('0.0.0.0');
  });

  it('names the bridge log --bridge-log', () => {
    const got = parseArgs(['--bridge-log', '/tmp/x.log', '--', 'agent']);
    expect(got.logPath).toBe('/tmp/x.log');
  });

  it("keeps --session/-s with opencode's exact meaning", () => {
    const long = parseArgs(['--session', 'ses_x']);
    const short = parseArgs(['-s', 'ses_x']);
    expect(long.session).toBe('ses_x');
    expect(short.session).toBe('ses_x');
  });

  it('resumes through the TUI with either spelling the user typed', () => {
    // `-s`/`--session` is consumed for the bridge-side resume AND still reaches
    // the TUI (opencode's own flag; its store loads the session list): both
    // spellings must behave identically end to end.
    const byShort = clientArgs(parseArgs(['-s', 'ses_x']), 'http://x', 'ses_x');
    const byLong = clientArgs(parseArgs(['--session', 'ses_x']), 'http://x', 'ses_x');
    expect(byShort.filter((a) => a === '--session' || a === 'ses_x')).toEqual(
      byLong.filter((a) => a === '--session' || a === 'ses_x'),
    );
    expect(byShort).toContain('ses_x');
  });

  it('forwards --continue/-c to the TUI, where the session list lives', () => {
    const got = parseArgs(['-c']);
    expect(got.continueSession).toBe(true);
    expect(got.passThrough).toContain('-c');
  });

  it('rejects an agent command with -s/-c: the session fixes the agent', () => {
    // One client = one agent. `-s`/`-c` read the agent from the map; an agent after
    // `--` would reintroduce the ambiguity this design removes.
    expect(() => parseArgs(['-s', 'ses_x', '--', 'agent'])).toThrow(/do not pass an agent command/);
    expect(() => parseArgs(['-c', '--', 'agent'])).toThrow(/do not pass an agent command/);
    expect(() => parseArgs(['-s', 'ses_x', '-c'])).toThrow(/either --session\/-s or --continue\/-c/);
    // Without an agent they parse; the agent comes from the map in main().
    expect(parseArgs(['-s', 'ses_x']).session).toBe('ses_x');
    expect(parseArgs(['-c']).continueSession).toBe(true);
  });

  it('takes the workspace from the bare positional, opencode\'s spelling', () => {
    // `opencode [flags] [<directory>]` — the directory is NOT a flag. The first
    // bare positional before `--` is the bridge's workspace and the TUI's.
    const got = parseArgs(['/work', '--', 'agent']);
    expect(got.directory).toBe('/work');
    expect(got.passThrough).toEqual([]);
  });

  it('forwards --directory/-C to the TUI: they are opencode\'s flags now', () => {
    // opencode documents --directory/-C itself; the bridge no longer claims
    // them. The pair forwards together (a flag and its value), and the
    // bridge's own directory stays the cwd.
    const got = parseArgs(['--directory', '/work', '--', 'agent']);
    expect(got.directory).toBe(process.cwd());
    expect(got.passThrough).toEqual(['--directory', '/work']);
  });

  it('does not steal a forwarded flag\'s value as the directory', () => {
    // `--port 1234` is opencode's flag with its value; `1234` must not become
    // the bridge's workspace. The pair rule: a bare word right after a
    // forwarded flag belongs to that flag.
    const got = parseArgs(['--port', '1234', '--', 'agent']);
    expect(got.directory).toBe(process.cwd());
    expect(got.passThrough).toEqual(['--port', '1234']);
    // And the directory claim resumes after the pair is complete.
    const after = parseArgs(['--port', '1234', '/work', '--', 'agent']);
    expect(after.directory).toBe('/work');
    expect(after.passThrough).toEqual(['--port', '1234']);
  });

  it('no longer invents a `latest` spelling for --session', () => {
    // opencode has no such value; neither do we. It is just an id to forward.
    const got = parseArgs(['--session', 'latest']);
    expect(got.session).toBe('latest');
  });

  it('rejects --client-arg: passthrough made it redundant', () => {
    // The old escape hatch forwarded a TUI flag explicitly; now every unknown
    // flag forwards implicitly, and --client-arg reaching the TUI would be a
    // protocol error on its side. Parse and assert it forwards — that is the
    // migration path: drop the prefix, keep the flag.
    const got = parseArgs(['--client-arg', '--auto', '--', 'agent']);
    expect(got.passThrough).toEqual(['--client-arg', '--auto']);
  });
});

describe('the exit epilogue\'s resume line', () => {
  // The TUI hardcodes `Continue  opencode -s <id>` in its binary; the bridge
  // rewrites that row after the child exits so the line the user copies
  // actually resumes this product. The shape of the rebuilt command is pure
  // string work, so it is asserted HERE, at its own layer.
  function withArgv<T>(argv: string[], cwd: string, run: () => T): T {
    const previousArgv = process.argv;
    const previousCwd = process.cwd();
    process.argv = argv;
    try {
      return run();
    } finally {
      process.argv = previousArgv;
      try { process.chdir(previousCwd); } catch { /* gone */ }
      try { process.chdir(cwd); } catch { /* ignore */ }
    }
  }

  it('replaces an existing --session id with the current session, never appending', () => {
    // Appending produced `… --session ses_old … --session ses_new` — the
    // owner's report of a doubled, over-long Continue line.
    const line = withArgv(
      ['node', '/nvm/bin/oc-acp-client', '--session', 'ses_OLD', '--', 'dsh', '--profile', 'my-profile'],
      process.cwd(),
      () => resumeCommand('ses_NOW'),
    );
    expect(line).toBe(
      'oc-acp-client -s ses_NOW',
    );
  });

  it('normalizes --continue into the explicit -s <id>', () => {
    // `-c` would reopen whatever is newest at copy-time, not necessarily the
    // conversation being handed back; the copied line must name THE session.
    const byShort = withArgv(
      ['node', '/nvm/bin/oc-acp-client', '-s', 'ses_OLD', '--', 'agent'],
      process.cwd(),
      () => resumeCommand('ses_NOW'),
    );
    expect(byShort).toBe('oc-acp-client -s ses_NOW');
    const byContinue = withArgv(
      ['node', '/nvm/bin/oc-acp-client', '-c', '--', 'agent'],
      process.cwd(),
      () => resumeCommand('ses_NOW'),
    );
    expect(byContinue).toBe('oc-acp-client -s ses_NOW');
  });

  it('appends the resume id when the invocation had none', () => {
    const line = withArgv(
      ['node', '/nvm/bin/oc-acp-client', '--', 'dsh', '--profile', 'my-profile'],
      process.cwd(),
      () => resumeCommand('ses_NOW'),
    );
    expect(line).toBe('oc-acp-client -s ses_NOW');
  });

  it('names a checkout launch as `node dist/index.js`, the bin launch by its bin name', () => {
    // The owner's rule: the line reads like how THIS process was started — the
    // installed bin by name, a checkout by its real entry file.
    const repo = process.cwd();
    const checkout = withArgv(
      ['node', repo + '/dist/index.js', '--', 'agent'],
      repo,
      () => resumeCommand('ses_NOW'),
    );
    expect(checkout).toBe('node dist/index.js -s ses_NOW');
  });
});

describe('the epilogue never names an id that cannot resume', () => {
  it('skips a provably unknown id and takes the next candidate', () => {
    // Measured by the owner (2026-10-18): the line named `ses_eb55…`, and the next start
    // answered "unknown session id" because the map had no pairing for it. The source bug
    // is fixed, but a session that never reached an agent can still be "viewed", so the
    // line is filtered by resolvability.
    const dir = mkdtempSync(join(tmpdir(), 'oac-epilogue-'));
    const mapPath = join(dir, 'sessions.json');
    writeFileSync(
      mapPath,
      JSON.stringify({ ses_known: { acpSessionId: 'agent-1', directory: dir, updatedAt: 1 } }),
    );
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      expect(firstResolvableSessionId(['ses_unknown'])).toBeUndefined();
      expect(firstResolvableSessionId(['ses_unknown', 'ses_known'])).toBe('ses_known');
      // An agent-native UUID is not ours to verify: it passes through, as `-s` allows.
      expect(firstResolvableSessionId(['0b3f0d3e-6f4e-4b7e-9d3e-3a6f0d3e6f4e'])).toBe(
        '0b3f0d3e-6f4e-4b7e-9d3e-3a6f0d3e6f4e',
      );
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      removeDirSync(dir);
    }
  });
});

describe('which session the epilogue names', () => {
  // Three sources, ranked by how sure we are. Each rank exists because of a
  // measured failure, so the ORDER is the contract, not an implementation
  // detail: a resume that is then typed into must name what was typed into; a
  // resume that is left without typing must name what was ASKED FOR, not
  // whichever tab the client happened to hydrate last; and a run with neither
  // must still name something (the alternative is the TUI's native
  // `opencode -s …`, which resumes nothing this product knows).
  it('prefers the session the user typed into', () => {
    expect(
      epilogueSessionId({ prompted: 'ses_typed', intent: 'ses_asked', viewed: 'ses_seen' }),
    ).toBe('ses_typed');
  });

  it('falls back to the requested session, not the last tab read', () => {
    // Measured with three restored tabs: the client hydrated every one, so
    // `viewed` was an alias tab while the user had resumed a different session.
    expect(epilogueSessionId({ intent: 'ses_asked', viewed: 'ses_seen' })).toBe('ses_asked');
  });

  it('uses the viewed session when nothing was typed or requested', () => {
    // Opening the TUI, clicking a tab and quitting: still a session worth
    // handing back, and better than the native line.
    expect(epilogueSessionId({ viewed: 'ses_seen' })).toBe('ses_seen');
  });

  it('names nothing when there is nothing to name', () => {
    // No session this run: the caller leaves the native line alone rather than
    // inventing an id.
    expect(epilogueSessionId({})).toBeUndefined();
  });
});

describe('the geometry of the rewritten Continue row', () => {
  // The rewrite moves the cursor up two rows (the epilogue ends with a blank
  // line), so the replacement MUST occupy exactly one row. An over-long line was
  // once dropped entirely, leaving the client's native `opencode -s …` on screen —
  // which the owner reported as "the rewrite does not work".
  const argv = ['node', '/nvm/bin/oc-acp-client', '-s', 'ses_OLD', '--', 'dsh', '--profile', 'acp'];
  const line = (columns: number): string | undefined => {
    const previous = process.argv;
    process.argv = argv;
    try {
      return epilogueLine('ses_NOW', columns);
    } finally {
      process.argv = previous;
    }
  };

  it('uses the full command when it fits', () => {
    // The agent tail is gone (one client = one agent; -s reads it from the map),
    // so the row is short enough for any normal terminal.
    expect(line(200)).toBe('  Continue  oc-acp-client -s ses_NOW');
    expect(line(50)).toBe('  Continue  oc-acp-client -s ses_NOW');
  });

  it('gives up only when even the short form would wrap', () => {
    // Then the caller leaves the native row alone and logs why — one honest
    // outcome, not a torn screen.
    expect(line(20)).toBeUndefined();
  });
});

describe('TUI state isolation from a native opencode install', () => {
  // Measured: both worlds write …/latest/tui/tabs.json and opencode.db keyed by
  // XDG roots; shared, a native TUI listed our tabs (whose sessions exist only
  // behind the bridge) and could not open them. The env we hand our TUI is the
  // contract, so it is asserted here as data.
  const saved = { ...process.env };
  const withEnv = <T>(overrides: Record<string, string | undefined>, run: () => T): T => {
    for (const k of ['OPENCODE_ACP_CLIENT_SHARED_STATE', 'OPENCODE_ACP_CLIENT_ISOLATED_CONFIG']) {
      delete process.env[k];
    }
    Object.assign(process.env, overrides);
    try {
      return run();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  it('isolates the state/data roots and hardens the db and self-updating', () => {
    const env = withEnv({}, () => isolatedTuiRoots());
    expect(env).toBeDefined();
    expect(env!['XDG_STATE_HOME']).toMatch(/\.opencode-acp-client[/\\]opencode[/\\]state$/);
    expect(env!['XDG_DATA_HOME']).toMatch(/\.opencode-acp-client[/\\]opencode[/\\]data$/);
    // A second belt: the db file itself, in case an XDG root is ignored.
    expect(env!['OPENCODE_DB']).toMatch(/\.opencode-acp-client[/\\]opencode[/\\]data[/\\]opencode\.db$/);
    // Our TUI must not upgrade itself mid-run (a silent bump is what produced
    // the version-mismatch warnings), and two TUIs watching one worktree
    // duplicate file events.
    expect(env!['OPENCODE_DISABLE_AUTOUPDATE']).toBe('1');
    expect(env!['OPENCODE_DISABLE_FILEWATCHER']).toBe('1');
    // Config is NOT isolated at all: tui.json / plugins / themes are shared with the
    // user's install, so one edit applies to every agent (no per-agent copies).
    expect(env!['XDG_CONFIG_HOME']).toBeUndefined();
    expect(env!['OPENCODE_CONFIG_DIR']).toBeUndefined();
  });

  it('gives each agent its own state root, so tabs never cross agents', () => {
    // Reported 2026-10-19: launching dsh in a directory with an opencode tab restored
    // the opencode tab, and its models leaked into the new tab's composer. One client
    // drives one agent; the tab layout follows the agent command.
    const a = withEnv({}, () =>
      isolatedTuiRoots({ command: '/usr/local/bin/opencode', args: ['acp'] }),
    );
    const b = withEnv({}, () =>
      isolatedTuiRoots({ command: '/usr/local/bin/dsh', args: ['--profile', 'acp'] }),
    );
    expect(a!['XDG_STATE_HOME']).toMatch(/opencode[/\\]opencode-acp-[0-9a-f]{8}[/\\]state$/);
    expect(b!['XDG_STATE_HOME']).toMatch(/opencode[/\\]dsh-profile-acp-[0-9a-f]{8}[/\\]state$/);
    expect(a!['XDG_STATE_HOME']).not.toBe(b!['XDG_STATE_HOME']);
    // Same command = same root, so a restart keeps its own tabs.
    const again = withEnv({}, () =>
      isolatedTuiRoots({ command: '/usr/local/bin/dsh', args: ['--profile', 'acp'] }),
    );
    expect(again!['XDG_STATE_HOME']).toBe(b!['XDG_STATE_HOME']);
  });

  it("refuses -s for a session owned by another agent (one client = one agent)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-resolve-'));
    const mapPath = join(dir, 'sessions.json');
    writeFileSync(
      mapPath,
      JSON.stringify({
        ses_foreign: {
          acpSessionId: 'agent-1',
          directory: dir,
          agent: { command: '/usr/bin/other-agent', args: ['acp'] },
          updatedAt: 1,
        },
      }),
    );
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      expect(() =>
        resolveSessionId('ses_foreign', () => {}, { command: '/usr/bin/launch-agent', args: [] }),
      ).toThrow(/belongs to 'other-agent acp'/);
      // The owner may resume it; the id resolves to the agent's own id.
      expect(
        resolveSessionId('ses_foreign', () => {}, { command: '/usr/bin/other-agent', args: ['acp'] }),
      ).toBe('agent-1');
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      removeDirSync(dir);
    }
  });

  it('optional private config root, and an explicit opt-out for a shared world', () => {
    const isolated = withEnv({ OPENCODE_ACP_CLIENT_ISOLATED_CONFIG: '1' }, () => isolatedTuiRoots());
    expect(isolated!['OPENCODE_CONFIG_DIR']).toMatch(/\.opencode-acp-client[/\\]opencode[/\\]config-root$/);
    expect(withEnv({ OPENCODE_ACP_CLIENT_SHARED_STATE: '1' }, () => isolatedTuiRoots())).toBeUndefined();
  });
});

describe('which session -c continues', () => {
  // `-c` is now resolved from the session map: the newest remembered session in this
  // directory, together with the agent that owns it. No agent is asked, so no `--` is
  // needed — and an empty map is an error, not a blank conversation.
  const binding = { command: 'dsh', args: ['--profile', 'acp'] };
  const at = (
    visibleId: string,
    agent: { command: string; args: string[] } | undefined,
    updatedAt: number,
    directory = '/work/project',
  ): [string, { directory?: string; agent?: { command: string; args: string[] }; updatedAt: number }] => [
    visibleId,
    { directory, ...(agent ? { agent } : {}), updatedAt },
  ];

  it('takes the newest entry in this directory, with its agent', () => {
    const picked = newestContinueEntry(
      [at('ses_old', binding, 1), at('ses_new', binding, 2)],
      '/work/project',
    );
    expect(picked?.visibleId).toBe('ses_new');
    expect(picked?.agent).toEqual(binding);
  });

  it('skips entries without an agent (they cannot be launched)', () => {
    const picked = newestContinueEntry([at('ses_legacy', undefined, 9), at('ses_ok', binding, 1)], '/work/project');
    expect(picked?.visibleId).toBe('ses_ok');
  });

  it('ignores other directories, even newer ones', () => {
    const picked = newestContinueEntry(
      [at('ses_elsewhere', binding, 9, '/work/other'), at('ses_here', binding, 1)],
      '/work/project',
    );
    expect(picked?.visibleId).toBe('ses_here');
  });

  it('matches the directory through realpath, so /var and /private/var are one place', () => {
    const logical = tmpdir();
    const physical = realpathSync(logical);
    const picked = newestContinueEntry([at('ses_physical', binding, 1, physical)], logical);
    expect(picked?.visibleId).toBe('ses_physical');
  });

  it('names nothing when there is no remembered session here', () => {
    expect(newestContinueEntry([at('ses_elsewhere', binding, 9, '/work/other')], '/work/project')).toBeUndefined();
    expect(newestContinueEntry([], '/work/project')).toBeUndefined();
  });
});

describe('--session id provenance', () => {
  // A `ses_…` id is THIS bridge's namespace; the agent mints UUIDs. So a `ses_`
  // id with no map entry is provably unknown, and continuing produced the
  // owner's worst failure chain: session/load "Internal error" → the fallback
  // started a NEW agent session under that id → the tab came up titled
  // `[not resumed] <dir>` and the run left junk in the agent's own store.
  const saved = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
  afterEach(() => {
    if (saved === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = saved;
  });

  it('refuses a ses_ id the map does not know, and says how to find real ones', () => {
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = join(mkdtempSync(join(tmpdir(), 'oac-ses-')), 'sessions.json');
    expect(() => resolveSessionId('ses_eb6a73180ffeFfFcEFvUBlM8A9')).toThrow(/unknown session id/);
    expect(() => resolveSessionId('ses_eb6a73180ffeFfFcEFvUBlM8A9')).toThrow(/list-sessions\.py/);
  });

  it('still passes an agent-native UUID through (the agent-UI case)', () => {
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = join(mkdtempSync(join(tmpdir(), 'oac-ses-')), 'sessions.json');
    const native = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';
    expect(resolveSessionId(native)).toBe(native);
  });

  it('translates a known ses_ id through the map, unchanged', () => {
    const mapPath = join(mkdtempSync(join(tmpdir(), 'oac-ses-')), 'sessions.json');
    writeFileSync(
      mapPath,
      JSON.stringify({ ses_known: { acpSessionId: 'agent-uuid-1', directory: '/w', updatedAt: Date.now() } }),
    );
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    expect(resolveSessionId('ses_known')).toBe('agent-uuid-1');
  });
});

describe('agent command preflight', () => {
  function withTempBin<T>(run: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'oac-preflight-'));
    try {
      return run(dir);
    } finally {
      removeDirSync(dir);
    }
  }

  it('searches PATH for a bare command name', () => {
    withTempBin((dir) => {
      const bin = join(dir, 'my-agent');
      writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
      expect(findExecutable('my-agent', { PATH: dir })).toBe(bin);
      // An unusable entry earlier in PATH must not stop the search.
      expect(findExecutable('my-agent', { PATH: `${join(dir, 'missing')}${delimiter}${dir}` })).toBe(bin);
      expect(findExecutable('my-agent', { PATH: '/nonexistent' })).toBeUndefined();
    });
  });

  // ★ On Windows a command is a FILE NAME WITH AN EXTENSION, and the search must try
  // `PATHEXT` the way the shell does. Asking for the bare name meant an extensionless command
  // (`node`) was reported as "agent command not found" while `node.exe` sat on PATH — measured
  // on the Windows VM with `oc-acp-client -- node tests/fake-acp-agent.mjs`.
  it('finds a bare command name through PATHEXT', () => {
    // `process.platform` decides whether PATHEXT is consulted, so the Windows expectation is
    // asserted ON Windows: here, on macOS/Linux, the same lookup must NOT match `node.exe`.
    const dir = mkdtempSync(join(tmpdir(), 'path-'));
    try {
      // The file carries the extension on BOTH platforms, so the POSIX run really does prove
      // that a bare name does not match it there.
      const withExtension = join(dir, 'probe-agent.EXE');
      writeFileSync(withExtension, 'binary', { mode: 0o755 });
      const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
      if (process.platform === 'win32') {
        expect(findExecutable('probe-agent', env)).toBe(withExtension);
        // An explicit extension is tried as given and never re-appended.
        expect(findExecutable('probe-agent.EXE', env)).toBe(withExtension);
      } else {
        // No PATHEXT on POSIX: the bare name must resolve to nothing when only `.EXE` exists.
        expect(findExecutable('probe-agent', { PATH: dir })).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ★ Windows has no executable bit: `access(X_OK)` succeeds on any existing file, so a
  // plain text file IS "runnable" there. The POSIX expectation is asserted on POSIX only;
  // on Windows the same fixture asserts the thing that actually matters — a name that is
  // not there resolves to nothing.
  it('rejects a file that is not executable', () => {
    withTempBin((dir) => {
      writeFileSync(join(dir, 'plain-file'), 'not a program\n');
      if (process.platform === 'win32') {
        expect(findExecutable('plain-file', { PATH: dir })).toBeDefined();
        expect(findExecutable('no-such-file', { PATH: dir })).toBeUndefined();
      } else {
        expect(findExecutable('plain-file', { PATH: dir })).toBeUndefined();
      }
    });
  });

  it('checks a path as given instead of searching PATH for it', () => {
    expect(findExecutable(process.execPath)).toBe(process.execPath);
    expect(findExecutable('/definitely/not/here/agent')).toBeUndefined();
  });

  it('resolves a relative path against the directory the agent will run in', () => {
    withTempBin((dir) => {
      writeFileSync(join(dir, 'agent.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
      // The agent is spawned with the workspace directory as its cwd, so a
      // relative path must be judged there — not against our own cwd, which is
      // what let a broken command through to a confusing failure.
      expect(findExecutable('./agent.mjs', {}, dir)).toBe(join(dir, 'agent.mjs'));
      expect(findExecutable('./agent.mjs', {}, join(dir, 'elsewhere'))).toBeUndefined();
      // A bare name is a PATH lookup, exactly as `spawn` treats it — never a
      // file in the working directory.
      expect(findExecutable('agent.mjs', {}, dir)).toBeUndefined();
    });
  });

  it('reports a command that exists nowhere', () => {
    expect(findExecutable('definitely-not-a-real-agent-xyz')).toBeUndefined();
  });
});


describe('the bridge-owned `ps` command', () => {
  it('is a command, not a directory claim', () => {
    const args = parseArgs(['ps']);
    expect(args.bridgeCommand).toBe('ps');
    expect(args.agentCommand).toBeUndefined();
    // `daemons` is the long spelling of the same thing.
    expect(parseArgs(['daemons']).bridgeCommand).toBe('ps');
  });

  it('takes its own flags without demanding an agent', () => {
    const args = parseArgs(['ps', '--json', '--prune', '--kill']);
    expect(args.psJson).toBe(true);
    expect(args.psPrune).toBe(true);
    expect(args.psKill).toBe(true);
  });
});

describe('the exit wordmark', () => {
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '');

  it('draws the native four-row alphabet, not a narrow font', () => {
    // The TUI's mark is four rows of 4-column glyphs using `_` (background cell)
    // and `^`/`~`; an earlier version used 3-column glyphs and read as a totally
    // different font (owner's screenshots).
    const lines = epilogueWordmark(120);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(strip(line).length).toBeLessThanOrEqual(120);
    // Every row must be the same width: the epilogue rewrite clears whole rows.
    const widths = lines.map((line) => strip(line).length);
    expect(new Set(widths).size).toBe(1);
  });

  it('degrades to one styled line when the terminal is too narrow', () => {
    // 88 columns is the block form's width; below that the four rows would wrap
    // and break the cursor arithmetic.
    expect(epilogueWordmark(88)).toHaveLength(1);
    expect(epilogueWordmark(88)[0]).toContain('opencode acp client');
  });
});

describe('the help output', () => {
  // ★ `printHelp()` quotes the binary's OWN `--help`, so these assertions depend on a
  // concrete answer. They used to depend on whatever `opencode` this machine happened to
  // have — and CI's windows-latest has none, so three of them failed there for a reason
  // that had nothing to do with the code under test. The fixture is the answer.
  // ★ The fixture is a `.mjs`. A shebang script is executable on POSIX and NOT on Windows,
  // where launching one directly fails with ENOENT — and `printHelp()` turns that into an
  // empty forwarded list, so the three tests below failed there for a reason that had
  // nothing to do with what they assert. A generated shim (`opencode` / `opencode.cmd`)
  // that invokes `node` explicitly runs on both.
  const realBin = process.env['OPENCODE_BIN'];
  const shimDir = mkdtempSync(join(tmpdir(), 'oac-ocbin-'));
  const shim = join(shimDir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  beforeAll(() => {
    const fixture = fileURLToPath(new URL('./fake-opencode-tui.mjs', import.meta.url));
    writeFileSync(
      shim,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
      { mode: 0o755 },
    );
    process.env['OPENCODE_BIN'] = shim;
  });
  afterAll(() => {
    if (realBin === undefined) delete process.env['OPENCODE_BIN'];
    else process.env['OPENCODE_BIN'] = realBin;
    rmSync(shimDir, { recursive: true, force: true });
  });

  /** What `--help` would print, assembled the same way the command does. */
  const help = (): string => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      printHelp();
    } finally {
      (process.stdout as unknown as { write: typeof original }).write = original;
    }
    return chunks.join('');
  };

  it('never colours a pipe, and colours a terminal', () => {
    // ★ Under vitest stdout is not a TTY, which is exactly the `--help | grep` case:
    // escapes here would break every script that reads this output.
    const piped = help();
    expect(piped).not.toContain('\u001b[');

    const wasTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    try {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      vi.stubEnv('NO_COLOR', undefined as unknown as string);
      vi.stubEnv('TERM', 'xterm-256color');
      const coloured = help();
      expect(coloured).toContain('\u001b[1;36m'); // headings
      expect(coloured).toContain('\u001b[33m'); // flag names
      // Padding is computed on the plain name, so the columns still line up.
      expect(coloured).toContain('--help, -h');
    } finally {
      vi.unstubAllEnvs();
      if (wasTTY) Object.defineProperty(process.stdout, 'isTTY', wasTTY);
      else delete (process.stdout as unknown as { isTTY?: unknown }).isTTY;
    }
  });

  it('honours NO_COLOR even on a terminal', () => {
    const wasTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    try {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      vi.stubEnv('NO_COLOR', '1');
      expect(help()).not.toContain('\u001b[');
    } finally {
      vi.unstubAllEnvs();
      if (wasTTY) Object.defineProperty(process.stdout, 'isTTY', wasTTY);
      else delete (process.stdout as unknown as { isTTY?: unknown }).isTTY;
    }
  });

  it('uses opencode\'s own section layout', () => {
    const text = help();
    // opencode: uppercase headings, two-space indent, no colour. Measured against
    // `opencode --help`, which emits no ANSI at all.
    for (const heading of ['DESCRIPTION', 'USAGE', 'FLAGS', 'SUBCOMMANDS', 'ENVIRONMENT']) {
      expect(text, heading).toMatch(new RegExp(`^${heading}$`, 'm'));
    }
    // One FLAGS section, not FLAGS + GLOBAL FLAGS: every flag has the same reader here.
    expect(text.match(/^FLAGS$/gm)).toHaveLength(1);
    expect(text).not.toContain('GLOBAL FLAGS');
  });

  it('describes THIS tool, not opencode\'s command set', () => {
    const text = help();
    expect(text).not.toContain('OpenCode command line interface');
    expect(text).not.toContain('opencode <subcommand>');
    // The paragraph explaining the forwarding rules is gone — the sections say it.
    expect(text).not.toContain('Flags and bare arguments forward');
  });

  it('lists its own subcommands and does NOT advertise the ones it refuses', () => {
    const text = help();
    expect(text).toMatch(/sessions\s+History: conversations this tool remembers/);
    // `ps` reads the live process table, not the session map — the two used to be described
    // so alike that a reader could not tell which answered which question.
    expect(text).toMatch(/ps\s+Now: bridge processes running right now/);
    expect(text).toMatch(/upgrade, update\s+Move this package/);
    for (const refused of ['manage integrations and credentials', 'Manage MCP', 'Start the v2 API and web server']) {
      expect(text, refused).not.toContain(refused);
    }
    expect(text).not.toContain('Upgrade OpenCode to the latest');
  });

  it('keeps the flags it takes over OUT of the forwarded list, in one FLAGS section', () => {
    const text = help();
    const flags = text.slice(text.indexOf('FLAGS'), text.indexOf('SUBCOMMANDS'));
    // Ours first…
    const ours = flags.indexOf('--bridge-port');
    const forwardedAt = flags.indexOf('Auto-approve permissions');
    expect(ours).toBeGreaterThan(-1);
    expect(forwardedAt).toBeGreaterThan(ours);
    // …and the two the bridge replaces are not advertised at all: the help lists what the
    // command ACCEPTS, and it ignores both of them.
    expect(flags).not.toMatch(/^ {2}--server/m);
    expect(flags).not.toMatch(/^ {2}--standalone/m);
    expect(flags).not.toMatch(/^ {2}--standalone {2,}Run with a private/m);
    expect(flags).not.toMatch(/^ {2}--session, -s string/m);
  });

  it('orders our flags by how often they are used', () => {
    const text = help();
    const section = text.slice(text.indexOf('FLAGS'), text.indexOf('The flags below'));
    // ★ Matched at the START of a row, not anywhere on the line: `-- <cmd>`'s description
    // mentions `-s/-c`, and `--help`'s neighbours mention other flags — a plain `indexOf`
    // finds the prose and reports the wrong order.
    const row = (flag: string): number => {
      const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // No `\b` after the flag: for `-- <cmd>` the next character is a space, and a word
      // boundary needs word-vs-nonword — it never matches there.
      const match = new RegExp(`^ {2}${escaped}(?=[ ,<\n])`, 'm').exec(section);
      return match ? match.index : -1;
    };
    const order = ['--help', '-- <cmd>', '--continue', '--session', '--bridge-port', '--bridge-host', '--bridge-log', '--no-tui', '--version'];
    const positions = order.map(row);
    // Every one present, and strictly increasing: a flag list is read top-down and
    // abandoned early, so the everyday ones must not sit under the bridge's knobs.
    expect(positions.every((at) => at >= 0), String(positions)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("re-renders opencode's flags in OUR format, not their original padding", () => {
    const text = help();
    // ★ Locate by the FIRST forwarded flag, not by the sentence above it: the sentence is
    // prose that has already been rewritten once, and the test broke reading it as a
    // structural marker.
    const body = text.slice(text.indexOf('--auto'));
    const rows = body.split('\n').filter((line) => /^ {2}--/.test(line));
    const gaps = new Set<number>();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // ★ opencode pads its own two sections to different widths, so pasting the block
    // verbatim left the columns ragged next to ours. Every row here must be
    // `  <flag><gap><description>` with a gap of AT LEAST two spaces and no long runs of
    // spaces inside the flag — i.e. rendered by the same aligner as the rest of the help.
    for (const row of rows) {  // collect the gap before each description
      expect(row, row).toMatch(/^ {2}--\S.*? {2,}\S/);
      // ★ The gap width must be the SAME on every row: that is what "one aligner" means.
      // opencode's original text padded `--auto` to 24 columns and `--log-level` to 68, so
      // a verbatim paste produced two different gaps in one list.
      // ★ Measured from the RIGHT: `--log-level <all|trace|…|none>` contains spaces of its
      // own, so scanning from the left finds a gap inside the flag and calls it the column
      // separator. The description is the last run of two-or-more spaces on the line.
      const tail = / {2,}(\S[^]*)$/.exec(row);
      expect(tail, row).not.toBeNull();
      const beforeDescription = row.length - tail![0].length;
      gaps.add(beforeDescription);
    }
    // One width for the whole section.
    expect([...gaps]).toHaveLength(1);
  });

  it('refuses the two opencode CLI tools instead of pretending to run them', () => {
    // `--completions`/`--wizard` are opencode's ARGUMENT-PARSER tools, not TUI flags. With
    // no `-- <agent>` they used to fall through to "print help and exit 0" — success that
    // did nothing.
    expect(() => parseArgs(['--completions', 'bash'])).toThrow(/opencode's own CLI tool/);
    expect(() => parseArgs(['--wizard'])).toThrow(/opencode's own CLI tool/);
    expect(() => parseArgs(['--completions', 'bash'])).toThrow(/opencode --completions/);
    // And they are not advertised as TUI flags.
    const text = help();
    expect(text).not.toMatch(/^ {2}--wizard/m);
    expect(text).not.toMatch(/^ {2}--completions/m);
  });

  it('states its own version instead of deferring to opencode', () => {
    const text = help();
    expect(text).toMatch(/--version, -v\s+Show this package's version/);
    expect(text).not.toContain('Show version information');
  });

  it('still documents opencode flags, because those really are forwarded', () => {
    const text = help();
    expect(text).toContain('--auto');
    expect(text).toContain('--prompt');
    expect(text).toMatch(/reach the TUI unchanged/);
  });
});

describe('the flags the bridge refuses', () => {
  it('refuses --server and --standalone instead of dropping them', () => {
    // ★ Dropping a flag the user typed, silently, is how they believe the TUI talks to a
    // server they chose. These two choose a SERVER and this tool is one, so the only honest
    // answer is "no".
    expect(() => parseArgs(['--server', 'http://x.test', '--', 'a'])).toThrow(/--server.*not accepted/);
    expect(() => parseArgs(['--standalone', '--', 'a'])).toThrow(/--standalone.*not accepted/);
    // The refusal points at the command that WOULD honour it.
    expect(() => parseArgs(['--standalone', '--', 'a'])).toThrow(/opencode --standalone/);
  });

  it('does not let --server\'s URL become the workspace', () => {
    // Measured bug: `--server http://example.com` was dropped from the forwarded argv but its
    // VALUE fell through to the directory rule — `chdir '/repo' -> 'http://example.com'`.
    // The fix went further than consuming the value: the flag is refused now. What this
    // still pins is that the URL is never mistaken for the workspace on the way out.
    expect(() => parseArgs(['--server', 'http://example.com', '/work', '--', 'echo', 'hi'])).toThrow(
      /--server.*not accepted/,
    );
    expect(() => parseArgs(['--server', 'http://example.com', '/work', '--', 'echo', 'hi'])).not.toThrow(
      /chdir|directory/,
    );
  });

  it('refuses the joined form too', () => {
    // `--server=<url>` never reached the directory rule, but it must be refused all the same.
    expect(() => parseArgs(['--server=http://x.test', '/work', '--', 'a'])).toThrow(/--server/);
  });

  it('leaves a run that names neither untouched', () => {
    expect(parseArgs(['--', 'a']).replacedFlags).toEqual([]);
  });

  it('never forwards either flag to the TUI', () => {
    // They never get that far — parsing stops — which is stronger than filtering them out.
    expect(() => parseArgs(['--standalone', '/work', '--', 'a'])).toThrow();
  });
});
