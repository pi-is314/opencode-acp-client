import { defineConfig } from 'vitest/config';

/**
 * The unit suite drives real HTTP servers on real sockets (and, in the
 * SSE-driven cases, waits for a stream to deliver frames). Vitest's 5s default
 * is a *unit* timeout: it was short enough to fail the permission flow, which
 * is a request/response round trip through a spawned agent rather than a slow
 * assertion. Nothing here is allowed to take 20s in practice — a healthy run of
 * the whole suite is ~3s — so this is headroom, not a licence to hang.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    // The bridge writes its session-id map from inside the test process; this points it at a
    // scratch file so the suite can never touch the user's real state directory.
    setupFiles: ['tests/setup-env.ts'],
  },
});
