#!/usr/bin/env node
/**
 * The `prepare` step: wire the git hooks, and build `dist/` when installing from a source tree.
 *
 * ★ This was a shell one-liner, and it broke every `pnpm install` on Windows:
 *
 *   • `2>/dev/null` is not cmd.exe syntax;
 *   • `chmod +x` does not exist there at all — the file came out unreadable as a program;
 *   • the `&&`/`||` chain mixed "install the build tools" with "build", so a failure in the
 *     first half still ended up running the second.
 *
 * Measured on a Windows 11 VM: `pnpm install` exited 1 before installing anything, which
 * meant nobody on Windows could get the client from source at all. Node is the one runtime
 * this step can rely on — it is running the step — so the work happens here instead of in a
 * syntax that differs per platform.
 */
import { chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const run = (command, args, options = {}) =>
  spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options });

// 1. The git hooks, where there is a git checkout. Never fatal: a tarball install has no .git.
run('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });

// 2. A published tarball ships `dist/` already built; only a source checkout needs the build.
if (existsSync('dist/index.js')) process.exit(0);

// 3. A fresh clone has no node_modules, so the compiler may be missing. Install it without
//    saving: it is a build-time tool, not a dependency of the thing being installed.
if (!existsSync('node_modules/typescript')) {
  const install = run('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'typescript', '@types/node']);
  if (install.status !== 0) {
    console.error('[prepare] could not install the TypeScript compiler; run `pnpm install` in the checkout first');
    process.exit(1);
  }
}

// 4. Build. `tsc` writes the file; the executable bit is POSIX-only, and Node's own `chmod`
//    is a no-op on Windows, so this needs no platform branch.
const build = run('npx', ['tsc', '-p', 'tsconfig.json']);
if (build.status !== 0) process.exit(build.status ?? 1);
try {
  chmodSync('dist/index.js', 0o755);
} catch {
  /* FAT/network shares: the shebang still works where it matters */
}
