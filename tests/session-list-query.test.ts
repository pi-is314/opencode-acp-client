import { describe, expect, it } from 'vitest';

import { sessionListQuery } from '../src/server.js';

/** The shape the route hands in: our own `Session` records. */
const session = (
  id: string,
  extra: { title?: string; parentID?: string; updated?: number; archived?: number } = {},
) => ({
  id,
  time: {
    updated: extra.updated ?? 0,
    ...(extra.archived !== undefined ? { archived: extra.archived } : {}),
  },
  ...(extra.title !== undefined ? { title: extra.title } : {}),
  ...(extra.parentID !== undefined ? { parentID: extra.parentID } : {}),
});

const q = (query: string): URLSearchParams => new URLSearchParams(query);

/**
 * `GET /api/session` used to answer with every session it held, whatever was asked. That is
 * invisible with one session per workspace and wrong as soon as there are more — the TUI's
 * own list opens with `parentID=null&archived=false`.
 */
describe('the session list query', () => {
  const rows = [
    session('ses_a', { title: 'Refactor the parser', updated: 100 }),
    session('ses_b', { title: 'Fix login', updated: 300 }),
    session('ses_c', { title: 'Refactor the scheduler', updated: 200 }),
    session('ses_child', { title: 'Refactor sub', updated: 400, parentID: 'ses_a' }),
    session('ses_archived', { title: 'Old refactor', updated: 500, archived: 1 }),
  ];

  it('searches the TITLE, the way the published store does', () => {
    expect(sessionListQuery(rows, q('search=refactor')).map((r) => r.id)).toEqual([
      'ses_archived',
      'ses_child',
      'ses_c',
      'ses_a',
    ]);
  });

  it('does NOT search the id — a client searching an id correctly finds nothing', () => {
    // Measured: the e2e script typed a session id into the list's search box and expected a
    // row. Upstream matches titles only (`like(SessionTable.title, …)`), so this returned
    // nothing and the script had been passing for an unrelated reason.
    expect(sessionListQuery(rows, q('search=ses_a'))).toEqual([]);
  });

  it('keeps root sessions only for parentID=null, and one parent\'s children for an id', () => {
    expect(sessionListQuery(rows, q('parentID=null')).map((r) => r.id)).not.toContain('ses_child');
    expect(sessionListQuery(rows, q('parentID=ses_a')).map((r) => r.id)).toEqual(['ses_child']);
    // No parentID at all means "do not filter".
    expect(sessionListQuery(rows, q('')).map((r) => r.id)).toContain('ses_child');
  });

  it('drops archived sessions for archived=false and keeps only them for true', () => {
    expect(sessionListQuery(rows, q('archived=false')).map((r) => r.id)).not.toContain('ses_archived');
    expect(sessionListQuery(rows, q('archived=true')).map((r) => r.id)).toEqual(['ses_archived']);
  });

  it('orders by the updated time, newest first unless asc is asked for', () => {
    expect(sessionListQuery(rows, q('')).map((r) => r.id)[0]).toBe('ses_archived');
    expect(sessionListQuery(rows, q('order=asc')).map((r) => r.id)[0]).toBe('ses_a');
  });

  it('applies limit AFTER ordering, so it takes the newest', () => {
    expect(sessionListQuery(rows, q('limit=2')).map((r) => r.id)).toEqual(['ses_archived', 'ses_child']);
  });

  it('combines the filters the TUI actually sends', () => {
    expect(sessionListQuery(rows, q('parentID=null&archived=false&search=refactor&order=desc&limit=50')).map((r) => r.id)).toEqual([
      'ses_c',
      'ses_a',
    ]);
  });
});
