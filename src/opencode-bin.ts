/**
 * Locating and version-gating the opencode v2 client.
 *
 * The bridge is a *server*: it never launches the client unless asked (the
 * default), and the client may well live on another machine. So this module
 * separates two concerns:
 *
 *  - **Resolution** — which opencode v2 binary we would use, from
 *    `OPENCODE_BIN`, then `PATH`. There is deliberately no flag for this: one
 *    environment variable is the whole selection surface, so a launcher can
 *    point the bridge at a client without teaching it another flag.
 *  - **Gating** — whether that binary speaks the v2 surface this bridge serves.
 *    v1 speaks an entirely different event vocabulary and would fail silently,
 *    so the check exists to turn that silence into one loud line.
 *
 * The gate is only *fatal* when we are about to launch the client ourselves.
 * A server that refuses to start because a client is missing from the local
 * PATH would break headless and remote use for no reason.
 */

import { execFile } from 'node:child_process';

/** The oldest client whose protocol this bridge implements. */
export const MIN_MAJOR_VERSION = 2;

/**
 * Where a user without the client can get one. The `/v2/` matters: without it
 * the same host serves the **v1** installer, which would install a binary this
 * bridge then rejects.
 */
export const V2_INSTALL_URL = 'https://opencode.ai/v2/install';

export interface OpenCodeBinary {
  /** Absolute or PATH-resolved command we would run. */
  path: string;
  /** Where it came from, for the diagnostics line. */
  source: 'env' | 'path';
}

export interface OpenCodeVersion {
  /** The full reported string, e.g. `opencode v2.0.26`. */
  raw: string;
  major: number;
  minor: number;
  patch: number;
  supported: boolean;
}

/** The environment variable that selects the client binary. */
export const ENV_BIN = 'OPENCODE_BIN';

/**
 * Resolve the client binary without running it: `OPENCODE_BIN` if it is set to
 * something non-empty, otherwise `opencode` on `PATH`.
 */
export function resolveOpenCodeBinary(env: NodeJS.ProcessEnv = process.env): OpenCodeBinary {
  const fromEnv = env[ENV_BIN];
  if (fromEnv) return { path: fromEnv, source: 'env' };
  return { path: 'opencode', source: 'path' };
}

/**
 * Run `<binary> --version` and parse the major version.
 *
 * Both real spellings occur in the wild and are handled:
 *   `opencode v2.0.26`  (the standalone installer)
 *   `1.14.40`           (the npm package)
 *
 * Returns undefined when the binary is missing or unparseable — the caller
 * decides whether that is fatal.
 */
export async function readOpenCodeVersion(
  binary: OpenCodeBinary,
  timeoutMs = 10_000,
): Promise<OpenCodeVersion | undefined> {
  const raw = await runVersion(binary.path, timeoutMs);
  if (raw === undefined) return undefined;
  // First `N.N.N` anywhere in the output; the `v` prefix is optional.
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return undefined;
  const major = Number(match[1]);
  return {
    raw: raw.trim(),
    major,
    minor: Number(match[2]),
    patch: Number(match[3]),
    supported: major >= MIN_MAJOR_VERSION,
  };
}

function runVersion(command: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: timeoutMs }, (err, stdout, stderr) => {
      // A non-zero exit with version output is still usable; a spawn failure is not.
      const text = `${stdout}${stderr}`.trim();
      if (text) resolve(text);
      else resolve(err ? undefined : text);
    });
  });
}

/** The exact command a user can run to upgrade the binary we resolved. */
export function upgradeHint(binary: OpenCodeBinary): string {
  if (binary.source === 'path') return 'opencode upgrade';
  return `${binary.path} upgrade`;
}

/**
 * A readable install hint for a machine that has no usable v2 client.
 *
 * The URL is the **v2** installer; `https://opencode.ai/install` serves the v1
 * installer, which would install a binary the version gate then rejects.
 */
export function installHint(): string {
  return `curl -fsSL ${V2_INSTALL_URL} | sh`;
}

/**
 * One line describing what we found, for the startup log. Kept here so the
 * wording stays consistent between the fatal and the advisory path.
 */
export function describeVersion(binary: OpenCodeBinary, version: OpenCodeVersion | undefined): string {
  const where = binary.source === 'path' ? 'PATH' : ENV_BIN;
  if (!version) return `opencode v2 not found via ${where} ("${binary.path}")`;
  // Both spellings occur; normalise them to one readable line rather than
  // printing "opencode opencode v2.0.26".
  const label = /^opencode\b/i.test(version.raw) ? version.raw : `opencode ${version.raw}`;
  const state = version.supported ? 'ok' : `unsupported (need v${MIN_MAJOR_VERSION}+)`;
  return `${label} via ${where} — ${state}`;
}
