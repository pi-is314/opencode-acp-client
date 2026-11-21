import { describe, expect, it } from 'vitest';

import {
  countSessions,
  DEFAULT_PAGE,
  listSessions,
  matchesAgent,
  matchesDirectory,
  relativeTime,
  renderSessions,
  truncateMiddle,
} from '../src/sessions-command.js';
import type { SessionMap, SessionMapEntry } from '../src/session-map.js';

/** The listing only reads `entries()`, so the map can be a stub. */
const fakeMap = (rows: Record<string, Partial<SessionMapEntry>>): SessionMap =>
  ({
    entries: () =>
      Object.entries(rows).map(([id, entry]) => [
        id,
        { acpSessionId: `acp-${id}`, updatedAt: 0, ...entry } as SessionMapEntry,
      ]),
  }) as unknown as SessionMap;

describe('the sessions list', () => {
  const map = fakeMap({
    ses_old: { directory: '/w/a', title: 'older', updatedAt: 1_000, agent: { command: 'dsh', args: ['--profile', 'acp'] } },
    ses_new: { directory: '/w/b', title: 'newer', updatedAt: 3_000 },
    ses_mid: { directory: '/w/others', updatedAt: 2_000 },
  });

  it('lists newest first, whatever order the file is in', () => {
    expect(listSessions(map).map((row) => row.id)).toEqual(['ses_new', 'ses_mid', 'ses_old']);
  });

  it('pages with limit and offset, and counts the whole map', () => {
    expect(listSessions(map, { limit: 2, offset: 1 }).map((row) => row.id)).toEqual(['ses_mid', 'ses_old']);
    expect(countSessions(map)).toBe(3);
    expect(DEFAULT_PAGE).toBeGreaterThan(0);
  });

  it('filters by directory, and the count follows the filter', () => {
    // A bare word is a fragment; a path is compared whole (see `matchesDirectory`).
    expect(listSessions(map, { directory: 'a' }).map((row) => row.id)).toEqual(['ses_old']);
    expect(countSessions(map, { directory: 'a' })).toBe(1);
    expect(listSessions(map, { directory: '/w/a' }).map((row) => row.id)).toEqual(['ses_old']);
    expect(listSessions(map, { directory: '/w' })).toEqual([]);
  });

  it('names the agent from the command that created the session', () => {
    const [newest] = listSessions(map);
    expect(newest?.agent).toBeUndefined(); // the entry carried no binding
    const old = listSessions(map).find((row) => row.id === 'ses_old');
    expect(old?.agent).toBe('dsh --profile acp');
  });
});

describe('the sessions table', () => {
  it('puts the bounded agent column before the title, which takes the rest', () => {
    const text = renderSessions(
      [
        {
          id: 'ses_abcdefgh12345678',
          acpSessionId: 'x',
          directory: '/Users/x/projects/thing',
          title: 'a title',
          agent: 'dsh --profile acp',
          updatedAt: 0,
        },
      ],
      { width: 120, now: 60_000 },
    );
    const [header, row] = text.split('\n');
    // Two stamps, then the agent BEFORE the title: the title is what a person reads, so
    // it gets the slack and the agent column is capped.
    // The session id is shown in full (people copy it for `-s`), and the title is last
    // so it takes whatever the terminal has left over.
    expect(header).toMatch(/^CREATED\s+UPDATED\s+SESSION\s+DIRECTORY\s+AGENT\s+TITLE$/);
    // 12 columns, middle-truncated: the head and the tail both survive.
    expect(row).toContain('ses_abcdefgh12345678');
    expect(row).toContain('dsh --profile acp');
    expect(row).toContain('a title');
  });

  it('leaves the creation column blank rather than inventing one', () => {
    const text = renderSessions(
      [{ id: 'ses_a', acpSessionId: 'x', directory: '/w', updatedAt: 1_000, agent: 'a' }],
      { width: 120, now: 121_000 },
    );
    const row = text.split('\n')[1]!;
    // Rows written before the field existed have no creation time. Deriving one from
    // `updatedAt` would claim something nobody measured, so the cell stays empty.
    expect(row.startsWith('-')).toBe(true);
    expect(row).toContain('2m ago');
  });

  it('cuts a long path in the middle, because its tail is what identifies it', () => {
    expect(truncateMiddle('/Users/x/very/long/path/webapp', 20)).toMatch(/^\/Users.*webapp$/);
    expect(truncateMiddle('short', 20)).toBe('short');
  });

  it('stamps times relatively, and never invents one', () => {
    const now = 100_000_000;
    expect(relativeTime(now - 30_000, now)).toBe('30s ago');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
    // An entry written before `updatedAt` existed sorts last and says so.
    expect(relativeTime(0, now)).toBe('      ?');
  });
});

describe('the directory and agent filters', () => {
  const home = process.env['HOME'] ?? '/Users/x';
  const sessionDirectory = `${home}/projects/webapp`;

  it('accepts an absolute path, a ~ path, and a path relative to where we run', () => {
    expect(matchesDirectory(sessionDirectory, sessionDirectory)).toBe(true);
    expect(matchesDirectory(sessionDirectory, `~${sessionDirectory.slice(home.length)}`)).toBe(true);
    // A bare relative name resolves against the CURRENT directory, so it only matches when
    // the session lives there — that is what "relative" has to mean.
    expect(matchesDirectory(sessionDirectory, '.')).toBe(false);
  });

  it('takes a bare word as a fragment, which is how people actually type it', () => {
    expect(matchesDirectory(sessionDirectory, 'webapp')).toBe(true);
    expect(matchesDirectory(sessionDirectory, 'Webapp')).toBe(true);
    expect(matchesDirectory(sessionDirectory, 'other')).toBe(false);
  });

  it('does NOT treat a path-shaped query as a fragment', () => {
    // `a/b` must not match `/x/a/bc`: once a query has a separator it is a path, and a
    // path is compared whole.
    expect(matchesDirectory('/x/a/bc', 'a/b')).toBe(false);
    expect(matchesDirectory('/x/a/bc', '/x/a/bc')).toBe(true);
  });

  it('ignores the filter when nothing was asked for', () => {
    expect(matchesDirectory('/anything', '')).toBe(true);
    expect(matchesAgent('dsh --profile acp', '')).toBe(true);
  });

  it('matches the agent by command or by a fragment of it', () => {
    expect(matchesAgent('dsh --profile my-profile', 'my-profile')).toBe(true);
    expect(matchesAgent('dsh --profile my-profile', 'dsh --profile my-profile')).toBe(true);
    expect(matchesAgent('dsh --profile my-profile', 'opencode')).toBe(false);
    // A session with no recorded agent never matches a filter.
    expect(matchesAgent(undefined, 'dsh')).toBe(false);
  });
});
