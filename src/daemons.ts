/**
 * A tiny registry of bridge processes, so a user can find and reap them.
 *
 * The bridge already spawns everything by explicit PID (never a name-based
 * kill), but a bridge that is SIGKILLed — or a terminal that dies with it —
 * takes its cleanup with it, and the agent it spawned can end up orphaned. We
 * have paid for that in practice: orphaned agents hold a backend's session lock
 * and the next restore fails with "Internal error" while our own log looks
 * healthy. There is no way to list "the bridges I started" from the process
 * table alone (a manually started `dsh --profile acp` looks identical), so each
 * bridge records itself here and the `ps` command reports it.
 *
 * The file is per-process (`<pid>.json`) and removed on a clean shutdown, so a
 * stale entry IS the signal: the process is gone without cleaning up. Nothing
 * here is authoritative — `isAlive` is a `kill(pid, 0)` probe at read time, and
 * a recycled pid is possible in theory; the metadata is for the human, the pid
 * is only trusted together with it.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonRecord {
  pid: number;
  /** Milliseconds since the epoch. */
  startedAt: number;
  directory: string;
  /** The agent command as the user spelled it (e.g. `dsh`). */
  agent: string;
  agentArgs: string[];
  /** The bridge URL the TUI was pointed at. */
  url: string;
  /** This package's version, for spotting entries from an older install. */
  version: string;
}

export interface DaemonEntry {
  record: DaemonRecord;
  /** `kill(pid, 0)` said the process exists right now. */
  alive: boolean;
  file: string;
}

/**
 * Where the records live. `OPENCODE_ACP_CLIENT_DAEMONS` overrides it — the test
 * suite points it at a scratch directory, exactly like the session map.
 */
export function daemonsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['OPENCODE_ACP_CLIENT_DAEMONS'];
  return override && override.trim() !== ''
    ? override
    : join(homedir(), '.opencode-acp-client', 'daemons');
}

/** Whether a pid exists. Signal 0 does the permission check and nothing else. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (err as { code?: string }).code === 'EPERM';
  }
}

/** Record this process. Best effort: a failure here must not stop the bridge. */
export function registerDaemon(record: Omit<DaemonRecord, 'pid' | 'startedAt'>, pid = process.pid): void {
  try {
    const dir = daemonsDir();
    mkdirSync(dir, { recursive: true });
    const full: DaemonRecord = { ...record, pid, startedAt: Date.now() };
    writeFileSync(join(dir, `${pid}.json`), `${JSON.stringify(full, undefined, 2)}\n`, 'utf8');
  } catch {
    /* the bridge works without it; `ps` simply will not list this run */
  }
}

/** Drop this process's record. Safe to call more than once. */
export function unregisterDaemon(pid = process.pid): void {
  try {
    rmSync(join(daemonsDir(), `${pid}.json`), { force: true });
  } catch {
    /* nothing to do */
  }
}

/**
 * Every recorded bridge, newest first, each checked for liveness at call time.
 *
 * A malformed file is skipped rather than thrown: a half-written record must not
 * make `ps` unusable exactly when the user is trying to clean up.
 */
export function listDaemons(env: NodeJS.ProcessEnv = process.env): DaemonEntry[] {
  const dir = daemonsDir(env);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const entries: DaemonEntry[] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as DaemonRecord;
      if (typeof record.pid !== 'number') continue;
      entries.push({ record, alive: isAlive(record.pid), file });
    } catch {
      /* skip a broken record */
    }
  }
  return entries.sort((a, b) => (b.record.startedAt ?? 0) - (a.record.startedAt ?? 0));
}

/** Remove the records whose process is gone. Returns how many were dropped. */
export function pruneDaemons(env: NodeJS.ProcessEnv = process.env): number {
  let removed = 0;
  for (const entry of listDaemons(env)) {
    if (entry.alive) continue;
    try {
      rmSync(entry.file, { force: true });
      removed += 1;
    } catch {
      /* leave it for next time */
    }
  }
  return removed;
}
