import { rmSync } from 'node:fs';

/**
 * Remove a temp directory, waiting out Windows' brief lock on it.
 *
 * ★ On Windows a directory stays locked for a moment after the process that used it as its
 * working directory exits, so an immediate recursive removal answers `EBUSY`. That failed
 * tests **after** they had already passed: the assertions were fine, the cleanup threw. It
 * bit five different fixtures in the first Windows run — one bespoke retry was not enough,
 * because every cleanup site has the same exposure.
 *
 * `force` already makes "not there" harmless; this only adds patience, and stays synchronous
 * so the existing `try/finally` blocks can keep calling it as they did.
 *
 * Call it from a `finally`, never from a test's happy path: the sleep is real time.
 */
export function removeDirSync(dir: string, attempts = 6, waitMs = 200): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      // Only EBUSY/EPERM are "someone still holds it"; anything else is a real problem and
      // retrying it six times would only hide it behind a slower failure.
      const code = (err as { code?: string }).code;
      if ((code !== 'EBUSY' && code !== 'EPERM') || attempt >= attempts - 1) throw err;
      sleepMs(waitMs);
    }
  }
}

/** A synchronous nap — `Atomics.wait` on a throwaway buffer blocks without a busy loop. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
