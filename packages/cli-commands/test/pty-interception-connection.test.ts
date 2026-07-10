// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4b-iii-a: the interception CONNECTION core over a socket-like. The
// pure framing helper (takeFirstLine: LF split, one-CR-before-LF drop, raw-byte
// cap even with an LF present, byte-copy) and the connection state machine
// (eager framing + cached first terminal outcome, fatal UTF-8, per-read timeout,
// fail-closed teardown, reentrancy-safe settle-before-destroy). Driven by a fake
// SocketLike + a fake clock -- no real socket, no real timer.

import { describe, expect, it } from "vitest";

import {
  type CancelTimer,
  createInterceptionConnection,
  type SocketLike,
  takeFirstLine,
} from "../src/commands/pty-interception-connection.js";

const LF = 0x0a;
const CR = 0x0d;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function ascii(s: string): Uint8Array {
  return encoder.encode(s);
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** ASCII string followed by a single LF byte. */
function line(s: string): Uint8Array {
  return joinBytes(ascii(s), Uint8Array.of(LF));
}

interface FakeSocketOptions {
  destroyEmitsCloseSync?: boolean; // destroy() synchronously fires onClose (reentrancy race)
  writeRejects?: boolean;
  destroyThrows?: boolean;
}

interface FakeSocket {
  socket: SocketLike;
  emitData(chunk: Uint8Array): void;
  emitEnd(): void;
  emitError(): void;
  emitClose(): void;
  writes(): readonly string[];
  destroyCount(): number;
}

function makeFakeSocket(options: FakeSocketOptions = {}): FakeSocket {
  let dataCb: ((chunk: Uint8Array) => void) | undefined;
  let endCb: (() => void) | undefined;
  let errorCb: (() => void) | undefined;
  let closeCb: (() => void) | undefined;
  const writes: string[] = [];
  let destroyCount = 0;

  const socket: SocketLike = {
    onData: (cb) => {
      dataCb = cb;
    },
    onEnd: (cb) => {
      endCb = cb;
    },
    onError: (cb) => {
      errorCb = cb;
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    write: (data) => {
      writes.push(data);
      return options.writeRejects ? Promise.reject(new Error("write failed")) : Promise.resolve();
    },
    destroy: () => {
      destroyCount += 1;
      if (options.destroyEmitsCloseSync) {
        closeCb?.();
      }
      if (options.destroyThrows) {
        throw new Error("destroy failed");
      }
    },
  };

  return {
    socket,
    emitData: (chunk) => dataCb?.(chunk),
    emitEnd: () => endCb?.(),
    emitError: () => errorCb?.(),
    emitClose: () => closeCb?.(),
    writes: () => writes,
    destroyCount: () => destroyCount,
  };
}

interface FakeClock {
  scheduleTimeout: (onTimeout: () => void, ms: number) => CancelTimer;
  fire(): void;
  fireIgnoringCancel(): void;
  scheduleCount(): number;
  cancelCount(): number;
}

function makeFakeClock(): FakeClock {
  let pending: (() => void) | undefined;
  let active = false;
  let scheduleCount = 0;
  let cancelCount = 0;

  return {
    scheduleTimeout: (onTimeout, _ms) => {
      scheduleCount += 1;
      pending = onTimeout;
      active = true;
      return () => {
        cancelCount += 1;
        active = false;
      };
    },
    fire: () => {
      if (active) {
        pending?.();
      }
    },
    fireIgnoringCancel: () => {
      pending?.();
    },
    scheduleCount: () => scheduleCount,
    cancelCount: () => cancelCount,
  };
}

describe("takeFirstLine (M G4 Step 4b-iii-a)", () => {
  it("extracts a line split on LF", () => {
    const result = takeFirstLine(line("abc"), 100);
    expect(result.kind).toBe("line");
    if (result.kind === "line") {
      expect(decoder.decode(result.lineBytes)).toBe("abc");
    }
  });

  it("drops a single CR immediately before LF (CRLF framing)", () => {
    const result = takeFirstLine(joinBytes(ascii("abc"), Uint8Array.of(CR, LF)), 100);
    expect(result.kind).toBe("line");
    if (result.kind === "line") {
      expect(decoder.decode(result.lineBytes)).toBe("abc");
    }
  });

  it("drops only one CR before LF (abc\\r\\r\\n -> abc\\r)", () => {
    const result = takeFirstLine(joinBytes(ascii("abc"), Uint8Array.of(CR, CR, LF)), 100);
    expect(result.kind).toBe("line");
    if (result.kind === "line") {
      expect(decoder.decode(result.lineBytes)).toBe(
        decoder.decode(joinBytes(ascii("abc"), Uint8Array.of(CR))),
      );
    }
  });

  it("keeps a CR that is not immediately before LF", () => {
    const bytes = joinBytes(ascii("abc"), Uint8Array.of(CR), ascii("x"), Uint8Array.of(LF));
    const result = takeFirstLine(bytes, 100);
    expect(result.kind).toBe("line");
    if (result.kind === "line") {
      expect(decoder.decode(result.lineBytes)).toBe(
        decoder.decode(joinBytes(ascii("abc"), Uint8Array.of(CR), ascii("x"))),
      );
    }
  });

  it("returns an empty line for a lone LF", () => {
    const result = takeFirstLine(Uint8Array.of(LF), 100);
    expect(result.kind).toBe("line");
    if (result.kind === "line") {
      expect(result.lineBytes.length).toBe(0);
    }
  });

  it("reports incomplete when there is no LF yet and the buffer is under the cap", () => {
    expect(takeFirstLine(ascii("abc"), 100)).toEqual({ kind: "incomplete" });
  });

  it("reports overflow when the buffer exceeds the cap with no LF", () => {
    expect(takeFirstLine(ascii("abcde"), 4)).toEqual({ kind: "overflow" });
  });

  it("reports overflow when the line before an LF exceeds the cap (single chunk)", () => {
    // "abcde\n": 5 line bytes > cap 4 -- the cap is checked even though an LF is present.
    expect(takeFirstLine(line("abcde"), 4)).toEqual({ kind: "overflow" });
  });

  it("accepts a line exactly at the cap", () => {
    const result = takeFirstLine(line("abcde"), 5);
    expect(result.kind).toBe("line");
  });

  it("returns copied bytes, not a view into the caller's buffer", () => {
    const buffer = line("ab");
    const result = takeFirstLine(buffer, 100);
    buffer[0] = 0x58; // mutate the source after extraction
    expect(result.kind).toBe("line");
    if (result.kind === "line") {
      expect(decoder.decode(result.lineBytes)).toBe("ab");
    }
  });
});

describe("createInterceptionConnection (M G4 Step 4b-iii-a)", () => {
  it("delivers a single line as a frame", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket);
    sock.emitData(line("hello"));
    expect(await conn.read()).toEqual({ kind: "frame", line: "hello" });
  });

  it("delivers only the first line; trailing bytes are ignored", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket);
    sock.emitData(joinBytes(line("first"), ascii("junk-without-newline")));
    expect(await conn.read()).toEqual({ kind: "frame", line: "first" });
  });

  it("delivers an empty line as an empty-string frame (transport stays dumb)", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket);
    sock.emitData(Uint8Array.of(LF));
    expect(await conn.read()).toEqual({ kind: "frame", line: "" });
  });

  it("reassembles a line split across chunks", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket);
    sock.emitData(ascii("he"));
    sock.emitData(line("llo"));
    expect(await conn.read()).toEqual({ kind: "frame", line: "hello" });
  });

  it("decodes a multibyte character split across chunks", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket);
    sock.emitData(Uint8Array.of(0xc3)); // first byte of a 2-byte UTF-8 sequence
    sock.emitData(Uint8Array.of(0xa9, LF)); // second byte + LF
    const result = await conn.read();
    expect(result.kind).toBe("frame");
    if (result.kind === "frame") {
      expect(result.line).toBe(decoder.decode(Uint8Array.of(0xc3, 0xa9)));
    }
  });

  it("fails closed on overflow with no newline", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket, { maxLineBytes: 4 });
    sock.emitData(ascii("abcde"));
    expect(await conn.read()).toEqual({ kind: "closed" });
    expect(sock.destroyCount()).toBeGreaterThanOrEqual(1);
  });

  it("fails closed on invalid UTF-8 before the LF", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket);
    sock.emitData(Uint8Array.of(0xff, LF)); // 0xff is not a valid UTF-8 start byte
    expect(await conn.read()).toEqual({ kind: "closed" });
    expect(sock.destroyCount()).toBeGreaterThanOrEqual(1);
  });

  const goneEmitters: [string, (s: FakeSocket) => void][] = [
    ["end", (s) => s.emitEnd()],
    ["error", (s) => s.emitError()],
    ["close", (s) => s.emitClose()],
  ];
  it.each(
    goneEmitters,
  )("fails closed when the socket is %s with no full line", async (_label, emit) => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket);
    sock.emitData(ascii("partial"));
    emit(sock);
    expect(await conn.read()).toEqual({ kind: "closed" });
  });

  it("resolves timeout when no line arrives before the deadline", async () => {
    const sock = makeFakeSocket();
    const clock = makeFakeClock();
    const conn = createInterceptionConnection(sock.socket, {
      scheduleTimeout: clock.scheduleTimeout,
    });
    const readP = conn.read();
    clock.fire();
    expect(await readP).toEqual({ kind: "timeout" });
    expect(sock.destroyCount()).toBeGreaterThanOrEqual(1);
  });

  it("resolves timeout even when socket.destroy throws", async () => {
    const sock = makeFakeSocket({ destroyThrows: true });
    const clock = makeFakeClock();
    const conn = createInterceptionConnection(sock.socket, {
      scheduleTimeout: clock.scheduleTimeout,
    });

    const readP = conn.read();

    expect(() => clock.fire()).not.toThrow();
    expect(await readP).toEqual({ kind: "timeout" });
    expect(sock.destroyCount()).toBeGreaterThanOrEqual(1);
  });

  it("ignores a late timeout fire after a line already settled", async () => {
    const sock = makeFakeSocket();
    const clock = makeFakeClock();
    const conn = createInterceptionConnection(sock.socket, {
      scheduleTimeout: clock.scheduleTimeout,
    });
    const readP = conn.read(); // pending; timer scheduled
    sock.emitData(line("ok")); // delivers a frame; cancels the timer
    clock.fireIgnoringCancel(); // a scheduler that ignored cancellation must be a no-op now
    expect(await readP).toEqual({ kind: "frame", line: "ok" });
    expect(sock.destroyCount()).toBe(0);
    expect(clock.cancelCount()).toBeGreaterThanOrEqual(1);
  });

  it("settles a frame even when the timer canceller throws", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket, {
      scheduleTimeout: () => {
        return () => {
          throw new Error("cancel failed");
        };
      },
    });

    const readP = conn.read();

    expect(() => sock.emitData(line("ok"))).not.toThrow();
    expect(await readP).toEqual({ kind: "frame", line: "ok" });
  });

  it("ignores a late timeout fire after close settled", async () => {
    const sock = makeFakeSocket();
    const clock = makeFakeClock();
    const conn = createInterceptionConnection(sock.socket, {
      scheduleTimeout: clock.scheduleTimeout,
    });
    const readP = conn.read();
    await conn.close();
    clock.fireIgnoringCancel();
    expect(await readP).toEqual({ kind: "closed" });
  });

  it("close() wins over a cached frame", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket);
    sock.emitData(line("ok")); // cached frame
    await conn.close();
    expect(await conn.read()).toEqual({ kind: "closed" });
    expect(sock.destroyCount()).toBeGreaterThanOrEqual(1);
  });

  it("is single-shot: a second read returns closed and later data is ignored", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket);
    sock.emitData(line("first"));
    expect(await conn.read()).toEqual({ kind: "frame", line: "first" });
    sock.emitData(line("second")); // post-settlement data must not change state
    expect(await conn.read()).toEqual({ kind: "closed" });
  });

  it("returns closed for a concurrent second read while one is in flight", async () => {
    const sock = makeFakeSocket();
    const clock = makeFakeClock();
    const conn = createInterceptionConnection(sock.socket, {
      scheduleTimeout: clock.scheduleTimeout,
    });
    const first = conn.read(); // pending
    expect(await conn.read()).toEqual({ kind: "closed" }); // second, while first is in flight
    sock.emitData(line("ok"));
    expect(await first).toEqual({ kind: "frame", line: "ok" });
  });

  it("send() writes exactly the frame it is given, adding nothing", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket);
    await conn.send("frame-data");
    expect(sock.writes()).toEqual(["frame-data"]);
  });

  it("keeps timeout as timeout even if destroy synchronously emits close", async () => {
    const sock = makeFakeSocket({ destroyEmitsCloseSync: true });
    const clock = makeFakeClock();
    const conn = createInterceptionConnection(sock.socket, {
      scheduleTimeout: clock.scheduleTimeout,
    });
    const readP = conn.read();
    clock.fire();
    expect(await readP).toEqual({ kind: "timeout" });
  });

  it("keeps overflow as closed even if destroy synchronously emits close (no recursion)", async () => {
    const sock = makeFakeSocket({ destroyEmitsCloseSync: true });
    const conn = createInterceptionConnection(sock.socket, { maxLineBytes: 4 });
    sock.emitData(line("abcdef"));
    expect(await conn.read()).toEqual({ kind: "closed" });
    expect(sock.destroyCount()).toBeGreaterThanOrEqual(1);
  });

  it("keeps invalid-UTF-8 as closed even if destroy synchronously emits close (no recursion)", async () => {
    const sock = makeFakeSocket({ destroyEmitsCloseSync: true });
    const conn = createInterceptionConnection(sock.socket);
    sock.emitData(Uint8Array.of(0xff, LF));
    expect(await conn.read()).toEqual({ kind: "closed" });
    expect(sock.destroyCount()).toBeGreaterThanOrEqual(1);
  });

  it("fails closed without throwing when the scheduler throws", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket, {
      scheduleTimeout: () => {
        throw new Error("scheduler failed");
      },
    });
    expect(await conn.read()).toEqual({ kind: "closed" });
    expect(sock.destroyCount()).toBeGreaterThanOrEqual(1);
  });

  it("resolves timeout when the scheduler fires synchronously", async () => {
    const sock = makeFakeSocket();
    const conn = createInterceptionConnection(sock.socket, {
      scheduleTimeout: (onTimeout) => {
        onTimeout();
        return () => {};
      },
    });
    expect(await conn.read()).toEqual({ kind: "timeout" });
  });
});
