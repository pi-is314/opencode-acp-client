/**
 * `oc-acp-client sessions` — every conversation this tool remembers, newest first.
 *
 * The map file is the only place a session outlives a run (`sessions.json`: visible id →
 * the agent's own id, its directory, its title and the command that created it). Until
 * now the only way to read it was to open the file, and the TUI's own session list shows
 * one directory at a time. This prints the whole thing.
 *
 * Paging rather than a pager: the output is a table that should survive being piped or
 * captured, and a program that takes over the terminal cannot be asserted on in a test.
 * `--limit`/`--offset` page it; `--json` gives the raw rows.
 */

import { isAbsolute, resolve } from 'node:path';

import { agentBindingLabel, SessionMap, type SessionMapEntry } from './session-map.js';

/** The session's agent as one line, which is what both the table and the filter compare. */
const agentOf = (entry: SessionMapEntry): string | undefined =>
  entry.agent ? agentBindingLabel(entry.agent) : undefined;

export interface SessionRow {
  /** The id a client (the TUI) knows this conversation by. */
  id: string;
  /** The agent's own session id. */
  acpSessionId: string;
  directory?: string;
  title?: string;
  /** The agent command that created it (`dsh --profile acp`, `opencode acp`, …). */
  agent?: string;
  /** Last advanced (a prompt that ran). */
  updatedAt: number;
  /** First remembered; absent on rows written before the field existed. */
  createdAt?: number;
}

export interface SessionListOptions {
  limit?: number;
  offset?: number;
  /**
   * Only sessions in this directory. Accepted as an absolute path, a path relative to the
   * current directory, a `~`-prefixed one, or a bare fragment (`webapp`) — see
   * `matchesDirectory`.
   */
  directory?: string;
  /** Only sessions created by this agent command; a bare fragment matches too. */
  agent?: string;
}

/**
 * Does a session's directory match what the user typed?
 *
 * A person typing `--directory webapp` means "the one I work in", not "a path ending in
 * webapp", and they type `~/projects/webapp` or `./webapp` just as readily as
 * the full path. So three forms are accepted:
 *
 *   1. a path (absolute, relative, or `~`-prefixed) is resolved and compared for EQUALITY;
 *   2. a bare word that cannot be a path (no separator, not `.`/`..`) is a substring match,
 *      which is what makes `--directory webapp` work from anywhere;
 *   3. `~` expands first, so `~/x` and `/Users/me/x` are the same answer.
 */
export function matchesDirectory(sessionDirectory: string | undefined, wanted: string): boolean {
  if (!sessionDirectory) return false;
  const query = wanted.trim();
  if (!query) return true;
  // ★ `HOME` first, then Windows' `USERPROFILE` — measured in CI: windows-latest sets no
  // `HOME`, so `~` never expanded there and `--directory ~/projects/webapp` compared
  // literally. The trailing part is kept verbatim rather than sliced at a fixed index,
  // because the separator after `~` is `\` on Windows.
  const home = process.env['HOME'] ?? process.env['USERPROFILE'];
  const expand = (value: string): string => {
    if (!home) return value;
    if (value === '~') return home;
    if (/^~[/\\]/.test(value)) return `${home}${value.slice(1)}`;
    return value;
  };

  const asPath = expand(query);
  const absolute = isAbsolute(asPath) ? asPath : resolve(process.cwd(), asPath);
  // `resolve` also normalises `./x`, `a/../b` and a trailing slash.
  if (resolve(sessionDirectory) === resolve(absolute)) return true;

  // Not a path at all: a fragment. A query with a separator is a path and must not fall
  // through to substring matching — `--directory a/b` should not match `/x/a/bc`.
  const looksLikePath = /[/\\]/.test(asPath) || asPath === '.' || asPath === '..';
  if (looksLikePath) return false;
  return sessionDirectory.toLowerCase().includes(asPath.toLowerCase());
}

/** Same shape for the agent: a path-like query matches exactly, a word matches anywhere. */
export function matchesAgent(agent: string | undefined, wanted: string): boolean {
  const query = wanted.trim().toLowerCase();
  if (!query) return true;
  if (!agent) return false;
  const label = agent.toLowerCase();
  if (label === query) return true;
  // `dsh --profile acp` typed whole, or just `<profile>` — both should find it, and a
  // longer command that merely contains the word is a fragment match by design.
  return label.includes(query);
}

export const DEFAULT_PAGE = 20;

/** Newest first. Ties break on id so the order is stable across runs. */
export function listSessions(map: SessionMap, options: SessionListOptions = {}): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const [id, entry] of map.entries()) {
    if (options.directory && !matchesDirectory(entry.directory, options.directory)) continue;
    if (options.agent && !matchesAgent(agentOf(entry), options.agent)) continue;
    rows.push({
      id,
      acpSessionId: entry.acpSessionId,
      ...(entry.directory ? { directory: entry.directory } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.agent ? { agent: agentBindingLabel(entry.agent) } : {}),
      updatedAt: entry.updatedAt,
      ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
    });
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? DEFAULT_PAGE);
  return rows.slice(offset, offset + limit);
}

/** How many sessions the map holds (after the `--directory` filter). */
export function countSessions(map: SessionMap, options: SessionListOptions = {}): number {
  let total = 0;
  for (const [, entry] of map.entries()) {
    if (options.directory && !matchesDirectory(entry.directory, options.directory)) continue;
    if (options.agent && !matchesAgent(agentOf(entry), options.agent)) continue;
    total += 1;
  }
  return total;
}

/** `2h ago`, `3d ago` — a relative stamp reads faster than an absolute one in a list. */
export function relativeTime(updatedAt: number, now = Date.now()): string {
  if (!updatedAt) return '      ?';
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Truncate in the MIDDLE: the tail of a directory is what tells two of them apart. */
export function truncateMiddle(text: string, width: number): string {
  if (width <= 1) return '…'.slice(0, width);
  if (text.length <= width) return text;
  if (width <= 3) return `${text.slice(0, width - 1)}…`;
  const keep = width - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

export interface RenderOptions {
  /** Terminal width, default 100. */
  width?: number;
  now?: number;
}

/** The table. One row per session, columns identical to the header. */
export function renderSessions(rows: SessionRow[], options: RenderOptions = {}): string {
  const width = Math.max(60, options.width ?? 100);
  const now = options.now ?? Date.now();
  const home = process.env['HOME'] ?? '';
  const short = (path: string | undefined): string => {
    if (!path) return '-';
    // `~` is what a person types; the full path only adds noise to every row.
    return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  };
  // Column widths: the id and the relative time are fixed-width, so the title takes the
  // slack and the directory the rest. Titles are cut before directories, because a title
  // is the part a person can reconstruct from the directory + the time.
  // Two stamps: when the conversation started, and when it was last advanced. They are
  // different facts — a session created three days ago and used a minute ago is the
  // common case — and only the second is what `-c` ranks by.
  const when = 9;
  // The session id is NEVER truncated: it is the one value a person copies out of this
  // table (`-s <id>`), and an abbreviated id cannot be pasted anywhere. Measured on 197
  // real rows: 13 to 47 characters, and only the `ses_acp_session<uuid>` shape reaches the
  // long end.
  const id = Math.max(13, ...rows.map((row) => row.id.length));
  // The id is fixed and can be 47 wide, so on a narrow terminal something has to give.
  // The directory yields first (its tail still identifies it), then the title; both keep
  // a floor, and a terminal narrower than the floor simply wraps.
  const fixed = when * 2 + id + 26 + 5;
  const slack = width - fixed;
  const dir = Math.max(16, Math.min(36, Math.floor(slack * 0.5)));
  // The agent is a bounded column: a profile-style command is the longest we see, and
  // letting it size itself would push the title — the part a person reads — off the right
  // edge. Everything left over belongs to the title.
  const agent = 26;
  const title = Math.max(10, width - fixed - dir);
  const lines: string[] = [];
  // The title is last and takes the slack: it is the column a person reads first, and the
  // one that benefits from whatever the terminal has left over.
  lines.push(
    [
      'CREATED'.padEnd(when),
      'UPDATED'.padEnd(when),
      'SESSION'.padEnd(id),
      'DIRECTORY'.padEnd(dir),
      'AGENT'.padEnd(agent),
      'TITLE',
    ].join(' '),
  );
  for (const row of rows) {
    lines.push(
      [
        // Rows written before the field existed have no creation time and get a blank:
        // filling it from `updatedAt` would claim something nobody measured. New sessions
        // are stamped from now on (see `SessionMap.remember`).
        (row.createdAt !== undefined ? relativeTime(row.createdAt, now) : '-').padEnd(when),
        relativeTime(row.updatedAt, now).padEnd(when),
        row.id.padEnd(id),
        truncateMiddle(short(row.directory), dir).padEnd(dir),
        truncateMiddle(row.agent ?? '-', agent).padEnd(agent),
        truncateMiddle(row.title ?? '-', title),
      ].join(' '),
    );
  }
  return lines.join('\n');
}
