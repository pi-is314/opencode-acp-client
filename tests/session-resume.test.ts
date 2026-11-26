import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { removeDirSync } from './remove-dir.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveSessionId } from '../src/index.js';

const lines: string[] = [];
afterEach(() => {
  lines.length = 0;
});

function withMap(entries: Record<string, { acpSessionId: string }>, run: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'oac-resume-'));
  const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
  process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = join(dir, 'sessions.json');
  writeFileSync(process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'], JSON.stringify(entries), 'utf8');
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
    removeDirSync(dir);
  }
}

describe('--session id translation at startup', () => {
  it('translates the visible id to the agent id through the map', () => {
    // The owner resumed with the id the TUI printed and got an empty history: the
    // bridge had sent the VISIBLE id (`ses_…`) to session/load, the agent answered
    // "Internal error" for a session it never named, and the bridge silently
    // started a fresh session under that id. The map is the visible→agent pairing.
    withMap({ ses_visible: { acpSessionId: 'agent-uuid-1' } }, () => {
      const resolved = resolveSessionId('ses_visible', (line) => lines.push(line));
      expect(resolved).toBe('agent-uuid-1');
      expect(lines.some((line) => line.includes('ses_visible is the agent\'s agent-uuid-1'))).toBe(true);
    });
  });

  it('passes an unknown id through as given — the agent answers for its existence', () => {
    // Ids learned elsewhere (the agent's web UI shows agent-native ids) keep
    // working: no map entry, no invention, session/load says whether it exists.
    withMap({ ses_visible: { acpSessionId: 'agent-uuid-1' } }, () => {
      const resolved = resolveSessionId('some-agent-native-id', () => lines.push(line));
      expect(resolved).toBe('some-agent-native-id');
    });
  });

  it('returns undefined for no session, changing nothing', () => {
    withMap({}, () => {
      expect(resolveSessionId(undefined)).toBeUndefined();
    });
  });
});
