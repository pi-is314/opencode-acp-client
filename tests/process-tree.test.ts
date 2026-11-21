/**
 * An agent's helpers die with it.
 *
 * `child.kill()` reaches only the direct child. An agent that forks helpers (shells,
 * watchers) used to leave them behind as `ppid=1` orphans — measured twice with dsh,
 * where the survivors kept the workspace lock and every later `session/load` failed
 * with the bridge's log looking perfectly healthy. The client now spawns the agent as
 * its own process group and signals the group, so a test can watch a forked helper
 * disappear when the client is disposed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient, windowsKillArgs } from '../src/acp/client.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));

const clients: AcpClient[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  while (clients.length) await clients.pop()?.dispose();
});

describe('process tree', () => {
  it('builds the Windows tree-kill arguments, force only for the kill step', () => {
    // Windows has no signalable process groups; `taskkill /T` is the tree walk.
    // The graceful step asks the app to close, the force step adds /F.
    expect(windowsKillArgs(42, 'SIGTERM')).toEqual(['/PID', '42', '/T']);
    expect(windowsKillArgs(42, 'SIGKILL')).toEqual(['/PID', '42', '/T', '/F']);
  });

  it("kills the agent's forked helpers with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-tree-'));
    const pidFile = join(dir, 'helper.pid');
    try {
      const client = new AcpClient({
        command: process.execPath,
        args: [FAKE_AGENT],
        env: { FAKE_ACP_SPAWN_CHILD: pidFile },
        onLog: () => {},
      });
      clients.push(client);
      await client.initialize();
      await client.newSession(process.cwd());

      const deadline = Date.now() + 5_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await sleep(50);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(alive(pid)).toBe(true);

      await client.dispose();
      const until = Date.now() + 5_000;
      while (alive(pid) && Date.now() < until) await sleep(50);
      expect(alive(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
