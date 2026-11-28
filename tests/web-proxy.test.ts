import { describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { forwardStatic, HELPER_UNREACHABLE, isLoopback, passwordAccepted } from '../src/web-proxy.js';

/**
 * A request object is all `passwordAccepted` and `isLoopback` need; the two are pure decisions and
 * the cheapest place to pin them down is without a socket.
 */
function fakeRequest(headers: Record<string, string> = {}, url = '/', remoteAddress = '127.0.0.1') {
  return { headers, url, socket: { remoteAddress } } as unknown as http.IncomingMessage;
}

const basic = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('the web UI password', () => {
  it('accepts the Basic header the page sends', () => {
    expect(passwordAccepted(fakeRequest({ authorization: basic('opencode', 'pw') }), 'pw')).toBe(true);
  });

  it('accepts the ?auth_token= form the pair link uses', () => {
    // The link is the same base64, in the query — the two forms a real `opencode serve` accepts.
    const token = Buffer.from('opencode:pw').toString('base64');
    expect(passwordAccepted(fakeRequest({}, `/?auth_token=${token}`), 'pw')).toBe(true);
  });

  it('ignores the username, as the real server does', () => {
    // `ServerAuth.authorized` compares the password only; a bundle that sends any user works.
    expect(passwordAccepted(fakeRequest({ authorization: basic('anyone', 'pw') }), 'pw')).toBe(true);
  });

  it('rejects a wrong password, a missing one, and a truncated one', () => {
    expect(passwordAccepted(fakeRequest({ authorization: basic('opencode', 'nope') }), 'pw')).toBe(false);
    expect(passwordAccepted(fakeRequest({}), 'pw')).toBe(false);
    expect(passwordAccepted(fakeRequest({ authorization: basic('opencode', 'p') }), 'pw')).toBe(false);
    expect(passwordAccepted(fakeRequest({ authorization: 'Basic !!!not-base64' }), 'pw')).toBe(false);
  });

  it('reports loopback and only loopback', () => {
    // The TUI and the desktop connect over loopback and send no credentials; demanding one of them
    // would break every existing setup, which is why the rule keys on where the request came from.
    expect(isLoopback(fakeRequest({}, '/', '127.0.0.1'))).toBe(true);
    expect(isLoopback(fakeRequest({}, '/', '::1'))).toBe(true);
    expect(isLoopback(fakeRequest({}, '/', '::ffff:127.0.0.1'))).toBe(true);
    expect(isLoopback(fakeRequest({}, '/', '10.0.0.5'))).toBe(false);
    expect(isLoopback(fakeRequest({}, '/', ''))).toBe(false);
  });
});

describe('forwarding a static asset', () => {
  it('re-serves the helper body with its content type', async () => {
    // A stand-in for `opencode serve`: the point is that the bridge serves the BYTES from its own
    // origin, not that the helper is opencode.
    const helper = createServer((request, response) => {
      if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html', etag: '"abc"' });
        response.end('<html>page</html>');
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('nope');
    });
    await new Promise<void>((resolve) => helper.listen(0, '127.0.0.1', resolve));
    const port = (helper.address() as AddressInfo).port;
    try {
      const { status, headers, body } = await get('/', { base: `http://127.0.0.1:${port}` });
      expect(status).toBe(200);
      expect(headers['content-type']).toBe('text/html');
      // ★ The etag is passed through: asset filenames are content-hashed, and the helper's own
      // cache advice is the only caching that should apply.
      expect(headers.etag).toBe('"abc"');
      expect(body).toBe('<html>page</html>');
    } finally {
      helper.close();
    }
  });

  it('answers 502 with a readable line when the helper is gone', async () => {
    // ★ A missing helper must not take the bridge down: the TUI and desktop on this bridge never
    // asked for a web UI. The page gets one line saying what to start.
    const { status, body } = await get('/_assets/app.js', { base: 'http://127.0.0.1:1' });
    expect(status).toBe(502);
    expect(body).toContain('cannot reach the opencode server');
    expect(body).toBe(HELPER_UNREACHABLE + body.slice(HELPER_UNREACHABLE.length));
  });
});

/** Drive one request through `forwardStatic` against a throwaway bridge-side server. */
async function get(
  path: string,
  options: { base: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const server = createServer((request, response) => {
    void forwardStatic(request, response, options).catch(() => {
      /* forwardStatic reports everything through the response */
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${port}${path}`, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
      request.on('error', reject);
    });
  } finally {
    server.close();
  }
}
