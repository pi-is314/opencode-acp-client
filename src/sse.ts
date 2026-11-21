/**
 * The `/api/event` SSE hub.
 *
 * Contract (observed, including the handshake the client waits for):
 *   frame  := `data: ` + JSON + `\n\n`
 *   first  := {"id":"evt_connected","type":"server.connected","data":{}}
 *
 * A bounded ring is kept so a reconnecting client can replay what it missed —
 * without it, a client that attaches a moment after a session is created never
 * learns the session exists until the next event happens to arrive.
 */

import type { BridgeEvent } from './contract.js';

/**
 * How often an idle stream is nudged. Observed: with no traffic at all the
 * connection was reaped after roughly 45s, and each reap cost a full client
 * re-bootstrap. 15s leaves plenty of margin.
 */
const KEEPALIVE_MS = 15_000;

export interface SseClient {
  send(event: BridgeEvent): void;
  close(): void;
}

export interface SseHubOptions {
  /** How many frames to retain for `Last-Event-ID` replay. */
  replayCapacity?: number;
}

export class SseHub {
  private seq = 0;
  private readonly ring: BridgeEvent[] = [];
  private readonly clients = new Set<SseClient>();
  private readonly capacity: number;

  constructor(options: SseHubOptions = {}) {
    this.capacity = options.replayCapacity ?? 512;
  }

  private trace(line: string): void {
    if (process.env['OPENCODE_ACP_CLIENT_MESSAGE_PROBE'] === '1') {
      console.error(`[sse] ${line}`);
    }
  }

  /** Build the Response for `GET /api/event`. */
  connect(opts: { lastEventId?: string } = {}): Response {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let keepalive: ReturnType<typeof setInterval> | undefined;

    const stopKeepalive = () => {
      if (keepalive !== undefined) {
        clearInterval(keepalive);
        keepalive = undefined;
      }
    };

    const client: SseClient = {
      send: (event) => {
        try {
          controller?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The client vanished mid-write; drop it rather than crash the hub.
          this.clients.delete(client);
          stopKeepalive();
        }
      },
      close: () => {
        stopKeepalive();
        try {
          controller?.close();
        } catch {
          /* already closed */
        }
        this.clients.delete(client);
        this.trace(`client closed (clients=${this.clients.size})`);
      },
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
        this.clients.add(client);
        this.trace(
          `client connected (clients=${this.clients.size}, lastEventId=${opts.lastEventId ?? 'none'})`,
        );
        // Handshake first: the TUI treats it as "the server is live".
        client.send({ id: 'evt_connected', type: 'server.connected', data: {}, created: Date.now() });
        for (const missed of this.since(opts.lastEventId)) {
          client.send(missed);
        }
        // Keep the stream warm. With no events to send, an idle SSE connection
        // gets reaped by the HTTP stack, and the client answers a closed stream
        // with a full re-bootstrap: it re-fetches every message and reconciles
        // the store, which drops the turn the user is looking at - the reported
        // "the newest exchange disappears after a while". A comment frame is
        // ignored by the client and costs nothing.
        keepalive = setInterval(() => {
          try {
            controller?.enqueue(encoder.encode(': keepalive\n\n'));
          } catch {
            /* the stream is gone; cancel() clears the timer */
          }
        }, KEEPALIVE_MS);
        keepalive.unref?.();
      },
      cancel: () => {
        stopKeepalive();
        this.clients.delete(client);
        this.trace(`client cancelled (clients=${this.clients.size})`);
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  }

  /** Broadcast an event. Returns it with its assigned id. */
  emit(event: Omit<BridgeEvent, 'id' | 'created'> & { id?: string; created?: number }): BridgeEvent {
    const framed: BridgeEvent = {
      ...event,
      id: event.id ?? `evt_${++this.seq}`,
      created: event.created ?? Date.now(),
    };
    this.ring.push(framed);
    if (this.ring.length > this.capacity) this.ring.shift();
    // ★ Which session did this event name? Measured while chasing a report that a
    // brand-new tab showed a message belonging to an older one: the bridge log proves
    // every request reached the right session, but it says nothing about the events we
    // EMIT, so "the bridge published the wrong sessionID" and "the client drew it in the
    // active tab" look identical. `OPENCODE_ACP_CLIENT_EVENT_LOG=1` closes that gap by
    // recording the addressed session for every event; TRACE stays as it was (the
    // payload head) for the cases that need the body.
    if (process.env['OPENCODE_ACP_CLIENT_EVENT_LOG'] === '1') {
      const sid = (framed.data as { sessionID?: unknown } | undefined)?.sessionID;
      console.error(`[sse] ${framed.type} sid=${typeof sid === 'string' ? sid : '-'} -> ${this.clients.size} client(s)`);
    }
    if (process.env.OPENCODE_ACP_CLIENT_TRACE) {
      console.error(
        `[sse] ${framed.type} -> ${this.clients.size} client(s) ${JSON.stringify(framed.data).slice(0, 300)}`,
      );
    }
    for (const client of [...this.clients]) client.send(framed);
    return framed;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of [...this.clients]) client.close();
  }

  private since(lastEventId: string | undefined): BridgeEvent[] {
    if (!lastEventId) return [];
    const index = this.ring.findIndex((e) => e.id === lastEventId);
    return index < 0 ? [] : this.ring.slice(index + 1);
  }
}
