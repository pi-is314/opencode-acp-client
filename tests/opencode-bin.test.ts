import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { removeDirSync } from './remove-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  ENV_BIN,
  MIN_MAJOR_VERSION,
  describeVersion,
  installHint,
  readOpenCodeVersion,
  resolveOpenCodeBinary,
  upgradeHint,
} from '../src/opencode-bin.js';

/**
 * A stand-in for the client binary: a script that prints whatever version we
 * tell it to. Using real processes keeps `readOpenCodeVersion` honest about its
 * parsing and its failure modes, which is the whole point of the module.
 */
const dir = mkdtempSync(join(tmpdir(), 'opencode-bin-'));
afterAll(() => removeDirSync(dir));

// The resolver probes the binary with `execFileSync`, and Node cannot launch a
// `.bat`/`.cmd` shim that way (it needs a shell). On Windows the binary npm
// installs IS such a shim, so these spawn-based tests are POSIX-only; the
// parsing logic they exercise is still covered by the pure tests above/below.
// The Windows shim path is a documented gap (docs/COMPAT-OPENCODE.md), not a
// silent skip.
let seq = 0;
function fakeBinary(output: string, exitCode = 0): string {
  const path = join(dir, `fake-opencode-${seq++}`);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('resolveOpenCodeBinary', () => {
  it('reads the binary from the environment variable', () => {
    const resolved = resolveOpenCodeBinary({
      [ENV_BIN]: '/env/opencode',
    } as NodeJS.ProcessEnv);
    expect(resolved).toEqual({ path: '/env/opencode', source: 'env' });
  });

  it('prefers the environment over PATH', () => {
    expect(
      resolveOpenCodeBinary({ [ENV_BIN]: '/env/opencode', PATH: '/bin' } as NodeJS.ProcessEnv),
    ).toEqual({ path: '/env/opencode', source: 'env' });
  });

  it('defaults to PATH lookup', () => {
    expect(resolveOpenCodeBinary({} as NodeJS.ProcessEnv)).toEqual({
      path: 'opencode',
      source: 'path',
    });
  });

  it('treats an empty environment value as absent rather than selecting nothing', () => {
    expect(resolveOpenCodeBinary({ [ENV_BIN]: '' } as NodeJS.ProcessEnv)).toEqual({
      path: 'opencode',
      source: 'path',
    });
  });
});

describe('readOpenCodeVersion', () => {
  it.skipIf(process.platform === 'win32')('parses the standalone installer spelling', async () => {
    const binary = fakeBinary('opencode v2.0.26');
    const version = await readOpenCodeVersion({ path: binary, source: 'env' });
    expect(version).toMatchObject({ major: 2, minor: 0, patch: 26, supported: true });
  });

  it.skipIf(process.platform === 'win32')('parses the bare npm spelling', async () => {
    const binary = fakeBinary('1.14.40');
    const version = await readOpenCodeVersion({ path: binary, source: 'path' });
    expect(version).toMatchObject({ major: 1, minor: 14, patch: 40, supported: false });
  });

  it.skipIf(process.platform === 'win32')('rejects v1, which speaks a different event vocabulary', async () => {
    const binary = fakeBinary('opencode v1.18.18');
    const version = await readOpenCodeVersion({ path: binary, source: 'path' });
    expect(version?.supported).toBe(false);
    expect(version?.major).toBeLessThan(MIN_MAJOR_VERSION);
  });

  it.skipIf(process.platform === 'win32')('accepts a future major version', async () => {
    const binary = fakeBinary('opencode v3.1.0');
    expect((await readOpenCodeVersion({ path: binary, source: 'path' }))?.supported).toBe(true);
  });

  it('returns undefined for a missing binary instead of throwing', async () => {
    const version = await readOpenCodeVersion({
      path: join(dir, 'does-not-exist'),
      source: 'env',
    });
    expect(version).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('returns undefined when the output carries no version', async () => {
    const binary = fakeBinary('something went wrong');
    expect(await readOpenCodeVersion({ path: binary, source: 'path' })).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('still reads a version printed alongside a non-zero exit', async () => {
    // Some wrappers print the version and exit 1; that is still better than
    // concluding "not installed".
    const binary = fakeBinary('opencode v2.0.26', 1);
    expect((await readOpenCodeVersion({ path: binary, source: 'path' }))?.major).toBe(2);
  });
});

describe('describeVersion', () => {
  it('names the source so a wrong binary is obvious', () => {
    expect(describeVersion({ path: '/x/opencode', source: 'env' }, undefined)).toContain(ENV_BIN);
    expect(describeVersion({ path: 'opencode', source: 'path' }, undefined)).toContain('PATH');
  });

  it.skipIf(process.platform === 'win32')('says unsupported rather than ok for v1', async () => {
    const binary = fakeBinary('1.14.40');
    const version = await readOpenCodeVersion({ path: binary, source: 'path' });
    expect(describeVersion({ path: binary, source: 'path' }, version)).toContain('unsupported');
  });
});

describe('upgradeHint', () => {
  it('upgrades the resolved binary, not a guessed one', () => {
    expect(upgradeHint({ path: '/opt/oc', source: 'env' })).toBe('/opt/oc upgrade');
    expect(upgradeHint({ path: 'opencode', source: 'path' })).toBe('opencode upgrade');
  });
});

describe('installHint', () => {
  it('points at the v2 installer, not the v1 one served at /install', () => {
    expect(installHint()).toContain('https://opencode.ai/v2/install');
    expect(installHint()).not.toContain('https://opencode.ai/install');
  });
});
