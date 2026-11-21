import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  daemonsDir,
  isAlive,
  listDaemons,
  pruneDaemons,
  registerDaemon,
  unregisterDaemon,
} from '../src/daemons.js';

/**
 * The registry exists for one failure mode: a bridge killed without running its
 * shutdown path leaves its agent holding a backend's session lock, and the next
 * restore fails while our own log looks healthy. A per-process record that only
 * a CLEAN exit removes is therefore the stale signal.
 */
describe('the daemon registry', () => {
  let dir: string;
  const previous = process.env['OPENCODE_ACP_CLIENT_DAEMONS'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oac-daemons-'));
    process.env['OPENCODE_ACP_CLIENT_DAEMONS'] = dir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_DAEMONS'];
    else process.env['OPENCODE_ACP_CLIENT_DAEMONS'] = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it('records this process as alive and forgets it on shutdown', () => {
    registerDaemon({ directory: '/work', agent: 'dsh', agentArgs: ['--profile', 'acp'], url: 'http://127.0.0.1:1', version: '0.0.0' });
    const entries = listDaemons();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.record.pid).toBe(process.pid);
    expect(entries[0]!.record.agent).toBe('dsh');
    expect(entries[0]!.alive).toBe(true);

    unregisterDaemon();
    expect(listDaemons()).toEqual([]);
  });

  it('reports a dead pid as stale, and prunes it', () => {
    registerDaemon({ directory: '/work', agent: 'dsh', agentArgs: [], url: 'http://x', version: '0.0.0' }, 999_999_999);
    const entries = listDaemons();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.alive).toBe(false);

    // A clean run must NOT prune live records.
    expect(pruneDaemons()).toBe(1);
    expect(listDaemons()).toEqual([]);
  });

  it('skips a half-written record instead of failing', () => {
    writeFileSync(join(daemonsDir(), 'broken.json'), '{ not json');
    registerDaemon({ directory: '/work', agent: 'dsh', agentArgs: [], url: 'http://x', version: '0.0.0' });
    expect(listDaemons()).toHaveLength(1);
  });

  it('does not consider a nonsensical pid alive', () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(Number.NaN)).toBe(false);
    expect(isAlive(process.pid)).toBe(true);
  });
});
