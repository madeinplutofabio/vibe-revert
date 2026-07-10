// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Interception CONNECTION core (M G4 Step 4b-iii-a, D104.E/H/J/O). Wraps a
 * minimal socket-like into the 4b-ii `InterceptionServiceConnection` port
 * (read/send/close) and owns the wire framing -- NDJSON line extraction, the
 * raw-byte cap, fatal UTF-8 decoding, the per-read timeout, and fail-closed
 * teardown. This slice is SOCKET-FREE: it never imports `node:net`. The real
 * 127.0.0.1 loopback adapter (net.Server bind + the InterceptionChannelRef
 * endpoint + wrapping real sockets into SocketLike) is 4b-iii-b.
 *
 * Input is processed EAGERLY -- each chunk is framed/capped/decoded as it
 * arrives, even before `read()` is called; the FIRST terminal outcome (a line ->
 * frame, or overflow / invalid-UTF-8 / peer-gone -> closed) is CACHED and every
 * later chunk is ignored (bounded memory; "first LF-delimited line wins, trailing
 * bytes discarded" is a real property, not just a read-time one). `read()`
 * returns the cache immediately, starting the timeout ONLY when it must wait for
 * a result. `close()` fails closed and WINS over any cached frame.
 *
 * Reentrancy-safe: because a socket-like's `destroy()` may synchronously emit
 * `onClose`, every terminal path SETTLES/CACHES its outcome BEFORE destroying
 * the socket, so a synchronous close cannot win the once-only settlement or
 * re-enter processing. Every timer/socket call is wrapped so settlement, `read()`
 * and `close()` never throw even against a misbehaving scheduler or socket-like.
 * Once a read has settled (via a frame, timeout, or close), no further input can
 * grow the buffer or change state.
 */

import { PTY_INTERCEPTION_DECISION_TIMEOUT_MS } from "./pty-interception.js";
import type {
  InterceptionConnectionRead,
  InterceptionServiceConnection,
} from "./pty-interception-service.js";

/** Default raw-byte cap for one request line (64 KiB: ample for a prompt line). */
export const PTY_INTERCEPTION_MAX_LINE_BYTES = 64 * 1024;

const LF = 0x0a;
const CR = 0x0d;

/** Fatal decoder: invalid UTF-8 throws (fail closed) rather than emitting U+FFFD. */
const lineDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The minimal socket surface the connection core needs. The real net.Socket is
 * adapted to this in 4b-iii-b; tests drive it with a fake. `write` resolves when
 * the frame is flushed (so the response is not lost when close() destroys the
 * socket); `destroy` is a forceful, idempotent close; the `onError` Error value
 * is unused (any error fails closed).
 */
export interface SocketLike {
  onData(cb: (chunk: Uint8Array) => void): void;
  onEnd(cb: () => void): void;
  onError(cb: () => void): void;
  onClose(cb: () => void): void;
  write(data: string): Promise<void>;
  destroy(): void;
}

/** Result of extracting the first LF-delimited line from an accumulating buffer. */
export type TakeFirstLineResult =
  | { readonly kind: "line"; readonly lineBytes: Uint8Array }
  | { readonly kind: "incomplete" }
  | { readonly kind: "overflow" };

/**
 * Pure: extract the first LF-delimited line's RAW BYTES from `buffer` (a COPY,
 * not a view). Splits on the LF byte only; if a single CR immediately precedes
 * the LF it is dropped (CRLF framing), nothing else is trimmed. The cap is
 * applied to the resulting raw byte length (after CR removal), NOT to a decoded
 * string -- and it is checked even when an LF is present, so `maxLineBytes + 1`
 * bytes followed by an LF in one chunk still overflows. No LF yet + buffer
 * already over the cap -> overflow; otherwise incomplete.
 */
export function takeFirstLine(buffer: Uint8Array, maxLineBytes: number): TakeFirstLineResult {
  const lf = buffer.indexOf(LF);
  if (lf >= 0) {
    const end = lf > 0 && buffer[lf - 1] === CR ? lf - 1 : lf;
    const lineBytes = buffer.slice(0, end);
    if (lineBytes.length > maxLineBytes) {
      return { kind: "overflow" };
    }
    return { kind: "line", lineBytes };
  }
  if (buffer.length > maxLineBytes) {
    return { kind: "overflow" };
  }
  return { kind: "incomplete" };
}

/** A no-argument timer canceller. */
export type CancelTimer = () => void;

/** Options for the connection core (all defaulted; scheduleTimeout is injected for a fake clock). */
export interface InterceptionConnectionOptions {
  readonly maxLineBytes?: number;
  readonly readTimeoutMs?: number;
  readonly scheduleTimeout?: (onTimeout: () => void, ms: number) => CancelTimer;
}

/** Default timer: a self-unref'd setTimeout so a pending decision timer never holds the loop open. */
function defaultScheduleTimeout(onTimeout: () => void, ms: number): CancelTimer {
  const timer = setTimeout(onTimeout, ms);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
}

/** Cancel a timer, swallowing any error (settlement must never throw). */
function cancelTimerQuietly(cancel: CancelTimer): void {
  try {
    cancel();
  } catch {
    // Best-effort timer cleanup; settlement must not throw.
  }
}

/** Force-close a socket-like, swallowing any error (the connection still fails closed). */
function destroySocketQuietly(socket: SocketLike): void {
  try {
    socket.destroy();
  } catch {
    // Best-effort force-close; the connection still fails closed.
  }
}

/** Concatenate two byte arrays into a fresh Uint8Array (never aliases the caller's chunk). */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Wrap a socket-like into an `InterceptionServiceConnection`. See the module doc
 * for the eager-processing/cache model and the reentrancy guarantees. `read()`
 * is single-shot: after it has resolved once (or while one read is in flight) it
 * returns `{ closed }`.
 */
export function createInterceptionConnection(
  socket: SocketLike,
  options: InterceptionConnectionOptions = {},
): InterceptionServiceConnection {
  const maxLineBytes = options.maxLineBytes ?? PTY_INTERCEPTION_MAX_LINE_BYTES;
  const readTimeoutMs = options.readTimeoutMs ?? PTY_INTERCEPTION_DECISION_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;

  let buffer: Uint8Array = new Uint8Array(0);
  let socketGone = false;
  let inputComplete = false; // we have a cached terminal outcome; ignore later chunks
  let cachedRead: InterceptionConnectionRead | undefined;
  let settled = false; // read() has resolved (single-shot)
  let readResolve: ((read: InterceptionConnectionRead) => void) | undefined;
  let cancelTimer: CancelTimer | undefined;
  let closedByUs = false;

  function settle(read: InterceptionConnectionRead): void {
    if (settled) {
      return;
    }
    settled = true;
    if (cancelTimer !== undefined) {
      const cancel = cancelTimer;
      cancelTimer = undefined;
      cancelTimerQuietly(cancel);
    }
    const resolve = readResolve;
    readResolve = undefined;
    resolve?.(read);
  }

  function deliver(): void {
    if (settled || readResolve === undefined) {
      return;
    }
    if (closedByUs) {
      settle({ kind: "closed" }); // close wins over any cached frame
      return;
    }
    if (cachedRead !== undefined) {
      settle(cachedRead);
    }
  }

  function setCached(read: InterceptionConnectionRead): void {
    inputComplete = true;
    cachedRead = read;
    buffer = new Uint8Array(0); // stop holding input
    deliver();
  }

  function processInput(): void {
    if (inputComplete || settled || closedByUs) {
      return;
    }
    const taken = takeFirstLine(buffer, maxLineBytes);
    if (taken.kind === "overflow") {
      // Cache BEFORE destroy: a synchronous onClose must not re-enter processing.
      setCached({ kind: "closed" });
      destroySocketQuietly(socket);
      return;
    }
    if (taken.kind === "line") {
      let line: string;
      try {
        line = lineDecoder.decode(taken.lineBytes);
      } catch {
        setCached({ kind: "closed" });
        destroySocketQuietly(socket);
        return;
      }
      setCached({ kind: "frame", line });
      return;
    }
    // incomplete: a peer that is gone with no full line fails closed
    if (socketGone) {
      setCached({ kind: "closed" });
    }
  }

  socket.onData((chunk) => {
    if (inputComplete || settled || closedByUs) {
      return;
    }
    buffer = concatBytes(buffer, chunk);
    processInput();
  });
  const markGone = (): void => {
    socketGone = true;
    processInput();
  };
  socket.onEnd(markGone);
  socket.onError(markGone);
  socket.onClose(markGone);

  return {
    read(): Promise<InterceptionConnectionRead> {
      if (settled || readResolve !== undefined) {
        return Promise.resolve({ kind: "closed" }); // single-shot
      }
      if (closedByUs) {
        settled = true;
        return Promise.resolve({ kind: "closed" });
      }
      if (cachedRead !== undefined) {
        settled = true;
        return Promise.resolve(cachedRead);
      }
      return new Promise((resolve) => {
        readResolve = resolve;
        try {
          const cancel = scheduleTimeout(() => {
            // No-op if already settled (a scheduler that ignored cancellation must
            // not destroy a socket that already delivered its frame).
            if (settled) {
              return;
            }
            // Settle BEFORE destroy so a synchronous onClose cannot win as closed.
            settle({ kind: "timeout" });
            destroySocketQuietly(socket);
          }, readTimeoutMs);
          if (settled) {
            // The scheduler fired synchronously and already settled; drop the timer.
            cancelTimerQuietly(cancel);
          } else {
            cancelTimer = cancel;
          }
        } catch {
          // A misbehaving scheduler must not break the read() contract.
          settle({ kind: "closed" });
          destroySocketQuietly(socket);
        }
      });
    },
    send(frame: string): Promise<void> {
      return socket.write(frame);
    },
    close(): Promise<void> {
      closedByUs = true;
      // Settle BEFORE destroy: close wins, and a synchronous onClose cannot flip
      // the outcome or re-enter processing.
      settle({ kind: "closed" });
      destroySocketQuietly(socket);
      return Promise.resolve();
    },
  };
}
