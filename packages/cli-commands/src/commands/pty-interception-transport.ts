// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Real 127.0.0.1 loopback interception transport (M G4 Step 4b-iii-b,
 * D104.E/H/J/O). The SOLE `node:net` file: it implements the 4b-ii
 * `InterceptionServiceTransport` port over a loopback TCP listener and adapts
 * each real `net.Socket` into the 4b-iii-a `SocketLike` consumed by
 * `createInterceptionConnection`. `createInterceptionService` (4b-ii) drives it
 * unchanged; the returned `channel` (a 4a `InterceptionChannelRef`) becomes the
 * InstalledInterception channel. The nonce is NOT the transport's concern (the
 * service validates `sessionNonce`; the 4d hook carries it).
 *
 * Security/lifecycle posture: literal 127.0.0.1 bind on an ephemeral port (never
 * localhost / 0.0.0.0 / ::1); a non-127.0.0.1 peer is destroyed on sight
 * (belt-and-suspenders atop the literal bind). The accept side is an event->pull
 * adapter with fail-closed teardown. `closeTransport()` -- shared by
 * `transport.close()` AND the permanent server-error handler -- marks stopped,
 * resolves a parked `accept()` with `null`, clears the queue, destroys every live
 * socket, and closes the listener; it is concurrent-idempotent (server closed at
 * most once) and never rejects. All real-socket ugliness stays in this adapter:
 * the `connection` handler never throws, and every socket/server failure becomes
 * null / closed / rejected-send, never an unhandled event.
 */

import { type AddressInfo, createServer, type Socket } from "node:net";
import type { InterceptionChannelRef } from "./pty-interception.js";
import {
  createInterceptionConnection,
  type InterceptionConnectionOptions,
  type SocketLike,
} from "./pty-interception-connection.js";
import type {
  InterceptionServiceConnection,
  InterceptionServiceTransport,
} from "./pty-interception-service.js";

/** Options forwarded to each connection's framing/timeout core (all optional). */
export type LoopbackInterceptionTransportOptions = InterceptionConnectionOptions;

/** The bound transport plus the opaque channel ref the installer wires into the handle. */
export interface LoopbackInterceptionTransport {
  readonly transport: InterceptionServiceTransport;
  readonly channel: InterceptionChannelRef;
}

/** Strict IPv4-loopback peer check: only the literal 127.0.0.1 passes. */
export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  return remoteAddress === "127.0.0.1";
}

/** Force-close a real socket, swallowing any error (transport still fails closed). */
function destroySocketQuietly(socket: Socket): void {
  try {
    socket.destroy();
  } catch {
    // Best-effort force-close; transport still fails closed.
  }
}

/** Derive the `127.0.0.1:<port>` endpoint from a bound TCP server address, or throw. */
function resolveEndpoint(address: AddressInfo | string | null): string {
  if (address === null || typeof address === "string") {
    throw new Error("interception transport did not bind to a TCP address");
  }
  if (address.address !== "127.0.0.1" || !Number.isInteger(address.port) || address.port <= 0) {
    throw new Error(
      `interception transport bound to an unexpected address: ${address.address}:${address.port}`,
    );
  }
  return `127.0.0.1:${address.port}`;
}

/** Adapt a real net.Socket to the minimal SocketLike the connection core consumes. */
function toSocketLike(socket: Socket): SocketLike {
  return {
    onData: (cb) => {
      socket.on("data", (chunk) => {
        cb(chunk);
      });
    },
    onEnd: (cb) => {
      socket.on("end", () => {
        cb();
      });
    },
    onError: (cb) => {
      socket.on("error", () => {
        cb();
      });
    },
    onClose: (cb) => {
      socket.on("close", () => {
        cb();
      });
    },
    // Resolve only when the frame is flushed to the OS; reject (fail closed, the
    // service swallows it) if the socket is already unwritable, errors/closes
    // first, or write throws. Temp listeners are removed on every settlement path.
    write: (data) =>
      new Promise<void>((resolve, reject) => {
        if (socket.destroyed || !socket.writable) {
          reject(new Error("socket is not writable"));
          return;
        }
        let settled = false;
        function cleanup(): void {
          socket.removeListener("error", onError);
          socket.removeListener("close", onClose);
        }
        function onError(): void {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error("socket error before write completed"));
        }
        function onClose(): void {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error("socket closed before write completed"));
        }
        socket.once("error", onError);
        socket.once("close", onClose);
        try {
          socket.write(data, (err) => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        } catch (err) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err instanceof Error ? err : new Error("socket.write threw"));
          }
        }
      }),
    destroy: () => {
      socket.destroy();
    },
  };
}

/**
 * Bind a loopback interception listener and return the transport + channel ref.
 * Rejects if the bind fails. The accept loop, teardown, and fail-closed error
 * handling are described in the module doc.
 */
export async function createLoopbackInterceptionTransport(
  options: LoopbackInterceptionTransportOptions = {},
): Promise<LoopbackInterceptionTransport> {
  const server = createServer();

  const pending: InterceptionServiceConnection[] = [];
  const liveSockets = new Set<Socket>();
  let waiter: ((connection: InterceptionServiceConnection | null) => void) | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  // Synchronous fail-closed teardown of the ACCEPT side. Idempotent.
  function shutdown(): void {
    closed = true;
    if (waiter !== undefined) {
      const resolve = waiter;
      waiter = undefined;
      resolve(null);
    }
    pending.length = 0;
    for (const socket of liveSockets) {
      destroySocketQuietly(socket);
    }
    liveSockets.clear();
  }

  // Memoized full close (accept-side teardown + listener close). Shared by
  // transport.close() and the permanent server-error handler. Never rejects.
  function closeTransport(): Promise<void> {
    if (closePromise === undefined) {
      shutdown();
      closePromise = new Promise<void>((resolve) => {
        try {
          server.close(() => {
            resolve();
          });
        } catch {
          // ERR_SERVER_NOT_RUNNING or any close error: still resolve.
          resolve();
        }
      });
    }
    return closePromise;
  }

  server.on("connection", (socket) => {
    if (closed || !isLoopbackPeer(socket.remoteAddress)) {
      destroySocketQuietly(socket);
      return;
    }
    try {
      socket.setNoDelay(true);
    } catch {
      destroySocketQuietly(socket);
      return;
    }
    // Track the socket BEFORE queueing/handoff so close() always destroys it.
    liveSockets.add(socket);
    socket.once("close", () => {
      liveSockets.delete(socket);
    });
    let connection: InterceptionServiceConnection;
    try {
      connection = createInterceptionConnection(toSocketLike(socket), options);
    } catch {
      liveSockets.delete(socket);
      destroySocketQuietly(socket);
      return;
    }
    if (waiter !== undefined) {
      const resolve = waiter;
      waiter = undefined;
      resolve(connection);
    } else {
      pending.push(connection);
    }
  });

  await new Promise<void>((resolve, reject) => {
    function onStartupError(error: Error): void {
      server.removeListener("listening", onListening);
      void closeTransport();
      reject(error);
    }
    function onListening(): void {
      server.removeListener("error", onStartupError);
      // Install the permanent handler BEFORE resolving so there is no window in
      // which a server error is unhandled. A post-startup error fails closed.
      server.on("error", () => {
        void closeTransport();
      });
      resolve();
    }
    server.once("error", onStartupError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  let endpoint: string;
  try {
    endpoint = resolveEndpoint(server.address());
  } catch (error) {
    await closeTransport();
    throw error;
  }
  const channel: InterceptionChannelRef = { endpoint };

  const transport: InterceptionServiceTransport = {
    accept: () => {
      if (closed) {
        return Promise.resolve(null); // closed wins over any queued connection
      }
      const next = pending.shift();
      if (next !== undefined) {
        return Promise.resolve(next);
      }
      if (waiter !== undefined) {
        // A read is already parked -- a concurrent second accept fails closed
        // rather than stranding the first waiter.
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    close: closeTransport,
  };

  return { transport, channel };
}
