/**
 * `upgrade` / `update` — move THIS package to a newer version.
 *
 * Deliberately not opencode's updater. `oc-acp-client upgrade` used to forward the word to
 * the opencode binary, so it upgraded opencode — a different product, on a different
 * version line, installed by a different method. The two commands only looked alike.
 *
 * How the new version is installed: by the SAME method that installed the current one.
 * Detect-first, never assume npm-global:
 *
 *   • this package is not the one running from a global prefix → the user works from a
 *     checkout, and overwriting that with a registry copy would be destructive. Say so.
 *   • the binary's path says `pnpm`, `bun`, `yarn`, `volta`, … → use that manager, so a
 *     pnpm/pnpm layout is not turned into a second, npm-owned copy alongside it.
 *
 * Nothing here runs an installer without first reporting what it found and what it will
 * run, and `--check` stops after the lookup.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, sep } from 'node:path';

import { readFileSync } from 'node:fs';

/** This package's own version, read the same way `index.ts` does (no JSON import). */
export const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const PACKAGE_NAME = 'opencode-acp-client';

export type PackageManager = 'npm' | 'pnpm' | 'bun' | 'yarn';

export interface Plan {
  current: string;
  latest?: string;
  upToDate: boolean;
  manager: PackageManager;
  /** The argv an upgrade would run (without a version), for the `--check` output. */
  command: string[];
  /** Why the manager was chosen — printed, so a surprising choice is visible. */
  reason: string;
}

const which = (name: string): string | undefined => {
  const path = process.env['PATH'] ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of [name, `${name}.cmd`, `${name}.exe`]) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
};

/**
 * Which package manager owns the code that is running.
 *
 * The path of THIS file is the only honest answer: `__dirname` sits inside the install
 * prefix, and each manager's layout is recognisable (`node_modules/.pnpm`, `~/.bun/install`,
 * `Yarn/berry`, `Cellar` for brew — which we do not support and say so).
 */
export function detectManager(from: string, env: NodeJS.ProcessEnv = process.env): { manager: PackageManager; reason: string } {
  const path = from.replaceAll(sep, '/');
  if (path.includes('/.pnpm/') || path.includes('/pnpm/global/')) {
    return { manager: 'pnpm', reason: 'installed under pnpm\'s layout' };
  }
  if (path.includes('/.bun/') || path.includes('/bun/install/')) {
    return { manager: 'bun', reason: 'installed under bun\'s layout' };
  }
  if (path.includes('/.yarn/') || path.includes('/Yarn/')) {
    return { manager: 'yarn', reason: 'installed under yarn\'s layout' };
  }
  if (env['npm_config_user_agent']?.startsWith('pnpm/')) {
    return { manager: 'pnpm', reason: 'npm_config_user_agent says pnpm' };
  }
  // ★ No brackets inside brackets: this string is printed inside `method: npm (…)`, and
  // "npm (default (a node_modules install, …))" reads like a typo.
  return { manager: 'npm', reason: 'no manager-specific layout found' };
}

/** The argv that installs `version` with `manager`. `null` version means "the latest". */
export function installCommand(manager: PackageManager, version: string | undefined): string[] {
  const spec = version ? `${PACKAGE_NAME}@${version}` : PACKAGE_NAME;
  switch (manager) {
    case 'pnpm':
      return ['pnpm', 'add', '-g', spec];
    case 'bun':
      return ['bun', 'add', '-g', spec];
    case 'yarn':
      return ['yarn', 'global', 'add', spec];
    case 'npm':
    default:
      return ['npm', 'install', '-g', spec];
  }
}

/** Ask the registry what is published. Undefined when it cannot be reached or is absent. */
export function latestPublished(): string | undefined {
  try {
    const raw = execFileSync('npm', ['view', PACKAGE_NAME, 'version', '--json'], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    // Unpublished (E404), offline, or no npm — all the same answer: no version to offer.
    return undefined;
  }
}

/** `1.2.3` < `1.10.0`; prereleases sort before the release they precede. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { parts: number[]; pre: string } => {
    const [core, pre = ''] = value.replace(/^v/, '').split('-', 2) as [string, string?];
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const delta = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  // A prerelease is older than the plain release: `1.0.0-rc.1` < `1.0.0`.
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** Build the plan without running anything. */
export function planUpgrade(target?: string): { plan: Plan; found: boolean } {
  const from = realpathSync(process.argv[1] ?? __dirname);
  const { manager, reason } = detectManager(from);
  const latest = target ?? latestPublished();
  return {
    found: latest !== undefined,
    plan: {
      current: PACKAGE_VERSION,
      ...(latest !== undefined ? { latest } : {}),
      upToDate: latest !== undefined && compareVersions(PACKAGE_VERSION, latest) >= 0,
      manager,
      // ★ Pass the RESOLVED version, not the user's `target`. With no explicit version we
      // looked one up; printing a bare `npm install -g <pkg>` promised "latest", which is a
      // moving target — the next publish would make this line describe a different upgrade.
      command: installCommand(manager, latest),
      reason,
    },
  };
}

/** Run the installer, streaming its output through so the user sees what happened. */
export function runUpgrade(plan: Plan, log: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    log(`  upgrading ${PACKAGE_NAME} ${plan.current} → ${plan.latest} with ${plan.manager} (${plan.reason})`);
    log(`  $ ${plan.command.join(' ')}`);
    // `spawn`, not `execFile`: the installer's output must reach the terminal as it is
    // produced (`stdio: inherit`), which also keeps ANSI progress bars intact.
    const child = spawn(plan.command[0]!, plan.command.slice(1), { stdio: 'inherit' });
    child.on('error', (error) => {
      log(`  ✗ could not run ${plan.command[0]}: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}
