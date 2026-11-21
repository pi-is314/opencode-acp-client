import { describe, expect, it } from 'vitest';

import { compareVersions, detectManager, installCommand, planUpgrade, PACKAGE_NAME } from '../src/upgrade.js';

/**
 * `oc-acp-client upgrade` used to be forwarded to the opencode binary, so it upgraded
 * opencode — same word, different product, different version line. These pin the parts of
 * its replacement that must not drift: which manager owns the running copy, and what "newer"
 * means.
 */
describe('the upgrade command', () => {
  it('installs by the method that installed the running copy', () => {
    // Overwriting a pnpm install with `npm install -g` leaves two copies on PATH, and the
    // one that wins depends on ordering — so the layout decides, not a default.
    // ★ An explicit empty env, not the inherited one: `pnpm test` exports
    // `npm_config_user_agent=pnpm/...`, so the "plain npm layout" case passed under
    // `npx vitest` and failed under `pnpm test` — the test was reading the runner.
    const none: NodeJS.ProcessEnv = {};
    expect(detectManager('/home/u/.local/share/pnpm/global/5/node_modules/x/index.js', none).manager).toBe('pnpm');
    expect(detectManager('/home/u/.bun/install/global/node_modules/x/index.js', none).manager).toBe('bun');
    expect(detectManager('/usr/local/lib/node_modules/x/index.js', none).manager).toBe('npm');
  });

  it('prefers the layout over a stray user-agent', () => {
    expect(detectManager('/home/u/.local/share/pnpm/global/x/index.js', { npm_config_user_agent: 'npm/10' }).manager).toBe(
      'pnpm',
    );
  });

  it('builds the argv each manager actually needs', () => {
    expect(installCommand('npm', undefined)).toEqual(['npm', 'install', '-g', PACKAGE_NAME]);
    expect(installCommand('pnpm', '0.4.0')).toEqual(['pnpm', 'add', '-g', `${PACKAGE_NAME}@0.4.0`]);
    expect(installCommand('yarn', '0.4.0')).toEqual(['yarn', 'global', 'add', `${PACKAGE_NAME}@0.4.0`]);
  });

  it('prints the command that would ACTUALLY run, with the resolved version', () => {
    // ★ Measured: looking up the latest ("0.2.0") printed a bare `npm install -g <pkg>`,
    // which installs whatever is latest WHEN IT RUNS — not the 0.2.0 the line above announced.
    // The printed command has to name the version, or it is describing a different upgrade.
    const plan = planUpgrade('0.2.0').plan;
    expect(plan.command).toContain('opencode-acp-client@0.2.0');
  });

  it('keeps the method line readable — no parentheses inside parentheses', () => {
    // "npm (default (a node_modules install, …))" read like a typo.
    const { reason } = detectManager('/usr/local/lib/node_modules/x/index.js', {});
    expect(reason).not.toMatch(/\([^)]*\)/);
    expect(reason).not.toContain('(');
  });

  it('compares versions numerically, not as strings', () => {
    // `1.10.0` > `1.9.0` as numbers and < as strings — the classic way to miss an upgrade.
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('v0.3.0', '0.3.0')).toBe(0);
    // A prerelease is older than the release it precedes.
    expect(compareVersions('0.4.0-rc.1', '0.4.0')).toBe(-1);
    expect(compareVersions('0.4.0', '0.4.0-rc.1')).toBe(1);
  });
});
