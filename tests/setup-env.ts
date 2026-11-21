/**
 * Keep the suite out of the user's real state directory.
 *
 * The bridge writes one file — the session-id map — and it does so from inside this process,
 * so a test that never sets `OPENCODE_ACP_CLIENT_SESSION_MAP` writes to
 * `$XDG_STATE_HOME/oc-acp-client/sessions.json`. A first fix pointed one test at a temp
 * file; every other test still wrote to the real one, which is how the owner's map filled up
 * with `fake-session-*` entries. Pointing it here, once, for the whole suite is the version
 * that cannot be forgotten per test.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'oac-test-state-'));
process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = join(dir, 'sessions.json');
