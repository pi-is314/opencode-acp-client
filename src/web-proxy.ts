import * as http from 'node:http';
import * as https from 'node:https';

/**
 * Serving the opencode web UI from the bridge's own origin.
 *
 * The web UI and the desktop are the same client: both resolve their API as `location.origin`, and
 * the bundle's CSP is `connect-src 'self'`. A page served from one origin therefore cannot be
 * pointed at an API on another — no setting, no CORS, nothing. So the page has to come from the
 * bridge, and the bridge does not contain one: it is a compiled bundle that changes with every
 * opencode release, and shipping a copy would pin this package to one of them.
 *
 * The bundle is instead borrowed from a real `opencode serve` and re-served here, which is what
 * `WebProxy` does. Everything under `/api/` is OURS and is never proxied — that is the whole point
 * of the product; only static bytes are taken from the helper. `docs/WEB-UI.md` records the
 * measurements behind each decision.
 */

/** Headers the browser needs back verbatim; everything else is decided by the bridge. */
const PASS_THROUGH = [
  'content-type',
  'content-encoding',
  'content-language',
  'cache-control',
  'etag',
  'last-modified',
  'content-length',
];

/**
 * What a request for the page itself answers when the helper cannot be reached.
 *
 * ★ A missing helper must not take the bridge down: the TUI and desktop clients on this bridge
 * never asked for a web UI, and the proxy is the only part of it that depends on another process.
 */
export const HELPER_UNREACHABLE =
  'The bridge cannot reach the opencode server that serves the web UI.\n\n' +
  'Start one and point `--web-proxy` at it, for example:\n' +
  '  opencode serve --hostname 127.0.0.1 --port 4096\n' +
  '  oc-acp-client --bridge-port 8765 --web-proxy http://127.0.0.1:4096 . -- <agent>\n';

export interface WebProxyOptions {
  /** Base URL of a running `opencode serve`, e.g. `http://127.0.0.1:4096`. */
  readonly base: string;
  /** Seconds to wait for the helper before giving up on one request. */
  readonly timeoutMs?: number;
}

/**
 * Fetch a static asset from the helper and write it to the bridge's response.
 *
 * Returns the upstream status so the caller can log it; the body is already sent. The bridge keeps
 * no cache: asset filenames are content-hashed, so the helper's own `cache-control` is the only
 * caching that matters, and a cached copy here would survive an opencode upgrade and mix two
 * builds in one page.
 */
export async function forwardStatic(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: WebProxyOptions,
): Promise<number> {
  const url = new URL(request.url ?? '/', 'http://placeholder');
  let target: URL;
  try {
    target = new URL(url.pathname + url.search, options.base);
  } catch {
    // A malformed `--web-proxy` is caught at startup; this is the belt-and-braces path so a bad
    // value can never throw out of a request handler.
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`${HELPER_UNREACHABLE}\n(--web-proxy ${JSON.stringify(options.base)} is not a URL)\n`);
    return 502;
  }
  const client = target.protocol === 'https:' ? https : http;

  return await new Promise<number>((resolve) => {
    const upstream = client.request(
      target,
      {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        // The helper is on loopback and has no password; the browser's credentials belong to the
        // BRIDGE and must not leak to it. Only the path is forwarded, never `authorization`.
        headers: { accept: String(request.headers.accept ?? '*/*') },
        timeout: options.timeoutMs ?? 15_000,
      },
      (answer) => {
        const status = answer.statusCode ?? 502;
        const headers: Record<string, string> = {};
        for (const name of PASS_THROUGH) {
          const value = answer.headers[name];
          // A compressed body must stay compressed and keep its encoding header; anything else we
          // hand over with the length the helper reported, so browsers get an honest answer.
          if (typeof value === 'string') headers[name] = value;
        }
        // The helper sets `content-security-policy` with `connect-src 'self'`; the page is served
        // from OUR origin, so 'self' already covers our API — nothing to rewrite.
        const csp = answer.headers['content-security-policy'];
        if (typeof csp === 'string') headers['content-security-policy'] = csp;
        const xfo = answer.headers['x-content-type-options'];
        if (typeof xfo === 'string') headers['x-content-type-options'] = xfo;
        response.writeHead(status, headers);
        answer.pipe(response);
        answer.on('end', () => resolve(status));
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('helper timed out')));
    upstream.on('error', (error) => {
      // ★ One line of text, not a stack trace: this is read in a browser.
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`${HELPER_UNREACHABLE}\n(${String(error)})`);
      }
      resolve(502);
    });
    upstream.end();
  });
}

/**
 * Whether a password satisfies the bridge's own authentication.
 *
 * Two forms, both of which the web UI already uses against a real `opencode serve`
 * (`packages/server/src/middleware/authorization.ts`): `Authorization: Basic <base64>` and
 * `?auth_token=<the same base64>`. Accepting both means a bundle that works against opencode works
 * here unchanged — and the pair link the UI writes is just the query form.
 *
 * ★ Constant-time-ish comparison: same-length strings compared with a fold that does not
 * short-circuit. This is a loopback tool, not a hardened daemon, but a password compared with `===`
 * is the kind of thing that gets copied into somewhere that matters.
 */
export function passwordAccepted(request: http.IncomingMessage, password: string): boolean {
  const url = new URL(request.url ?? '/', 'http://placeholder');
  const token = url.searchParams.get('auth_token');
  let presented: string | undefined;
  if (token) {
    const decoded = decodeBase64(token);
    if (decoded !== undefined) presented = decoded.slice(decoded.indexOf(':') + 1);
  } else {
    const header = request.headers.authorization ?? '';
    const match = /^Basic\s+(.+)$/i.exec(header);
    if (match?.[1]) {
      const decoded = decodeBase64(match[1]);
      if (decoded !== undefined) presented = decoded.slice(decoded.indexOf(':') + 1);
    }
  }
  if (presented === undefined) return false;
  if (presented.length !== password.length) return false;
  let difference = 0;
  for (let index = 0; index < password.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ password.charCodeAt(index);
  }
  return difference === 0;
}

function decodeBase64(input: string): string | undefined {
  try {
    return Buffer.from(input, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Whether a request came from this machine.
 *
 * The TUI and the desktop connect over loopback and send no credentials; requiring one of them
 * would break every existing setup. The moment the bridge accepts another machine the page can be
 * reached by anything that can route to the port, and that is where a password has to be demanded.
 * The same line `--bridge-host` already draws.
 */
export function isLoopback(request: http.IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}
