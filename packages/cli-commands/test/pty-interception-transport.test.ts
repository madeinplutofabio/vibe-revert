// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4b-iii-b: the real 127.0.0.1 loopback transport. Driven with real
// client sockets against a real (ephemeral) listener -- the pure isLoopbackPeer
// predicate + bind/endpoint + the event->pull accept lifecycle + fail-closed
// teardown + an end-to-end round-trip through createInterceptionService. All
// client I/O uses explicit LF bytes; every test tears its resources down.

import { connect, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createInterceptionService } from "../src/commands/pty-interception-service.js";
import {
  createLoopbackInterceptionTransport,
  isLoopbackPeer,
} from "../src/commands/pty-interception-transport.js";

const LF = 0x0a;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      await fn();
    }
  }
});

function portOf(endpoint: string): number {
  return Number(endpoint.slice(endpoint.lastIndexOf(":") + 1));
}

function connectClient(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** Write `text` followed by a single LF byte (no newline string literal). */
function writeLine(socket: Socket, text: string): void {
  socket.write(Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([LF])]));
}

/** Resolve the first LF-delimited line the socket sends; reject if it ends/closes first. */
function readFirstLine(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    function cleanup(): void {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onClose);
    }
    function onData(chunk: Buffer): void {
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      const nl = combined.indexOf(LF);
      if (nl >= 0) {
        cleanup();
        resolve(combined.subarray(0, nl).toString("utf8"));
      }
    }
    function onError(err: Error): void {
      cleanup();
      reject(err);
    }
    function onEnd(): void {
      cleanup();
      reject(new Error("stream ended before a full line"));
    }
    function onClose(): void {
      cleanup();
      reject(new Error("stream closed before a full line"));
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onClose);
  });
}

describe("isLoopbackPeer (M G4 Step 4b-iii-b)", () => {
  const cases: [string | undefined, boolean][] = [
    ["127.0.0.1", true],
    [undefined, false],
    ["::1", false],
    ["::ffff:127.0.0.1", false],
    ["localhost", false],
    ["10.0.0.1", false],
    ["0.0.0.0", false],
  ];
  it.each(cases)("isLoopbackPeer(%s) === %s", (address, expected) => {
    expect(isLoopbackPeer(address)).toBe(expected);
  });
});

describe("createLoopbackInterceptionTransport (M G4 Step 4b-iii-b)", () => {
  it("binds 127.0.0.1 on an ephemeral port and exposes the endpoint", async () => {
    const { transport, channel } = await createLoopbackInterceptionTransport();
    cleanups.push(() => transport.close());
    expect(channel.endpoint).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(portOf(channel.endpoint)).toBeGreaterThan(0);
  });

  it("accepts a real connection and reads its request line as a frame", async () => {
    const { transport, channel } = await createLoopbackInterceptionTransport();
    cleanups.push(() => transport.close());
    const client = await connectClient(portOf(channel.endpoint));
    cleanups.push(() => {
      client.destroy();
    });
    writeLine(client, "hello");
    const conn = await transport.accept();
    expect(conn).not.toBeNull();
    if (conn) {
      expect(await conn.read()).toEqual({ kind: "frame", line: "hello" });
    }
  });

  it("end-to-end: a client receives the allow decision frame before close", async () => {
    const { transport, channel } = await createLoopbackInterceptionTransport();
    const service = createInterceptionService(transport, {
      sessionNonce: "session-nonce",
      commandsPolicy: undefined,
      evaluateCommandPolicy: () => ({ kind: "allow", normalized: "echo hi" }),
    });
    cleanups.push(() => service.stop());

    const client = await connectClient(portOf(channel.endpoint));
    cleanups.push(() => {
      client.destroy();
    });
    const responseP = readFirstLine(client);
    writeLine(
      client,
      JSON.stringify({ protocolVersion: 1, nonce: "session-nonce", id: "r1", rawLine: "echo hi" }),
    );

    expect(JSON.parse(await responseP)).toEqual({ protocolVersion: 1, id: "r1", kind: "allow" });
  });

  it("times out a connection that sends nothing (short readTimeoutMs)", async () => {
    const { transport, channel } = await createLoopbackInterceptionTransport({ readTimeoutMs: 30 });
    cleanups.push(() => transport.close());
    const client = await connectClient(portOf(channel.endpoint));
    cleanups.push(() => {
      client.destroy();
    });
    const conn = await transport.accept();
    expect(conn).not.toBeNull();
    if (conn) {
      expect(await conn.read()).toEqual({ kind: "timeout" });
    }
  });

  it("fails closed on overflow (small maxLineBytes)", async () => {
    const { transport, channel } = await createLoopbackInterceptionTransport({ maxLineBytes: 4 });
    cleanups.push(() => transport.close());
    const client = await connectClient(portOf(channel.endpoint));
    cleanups.push(() => {
      client.destroy();
    });
    client.write("abcdefghij"); // > 4 bytes, no LF
    const conn = await transport.accept();
    expect(conn).not.toBeNull();
    if (conn) {
      expect(await conn.read()).toEqual({ kind: "closed" });
    }
  });

  it("resolves a parked accept() with null when close() is called", async () => {
    const { transport } = await createLoopbackInterceptionTransport();
    const parked = transport.accept();
    await transport.close();
    expect(await parked).toBeNull();
  });

  it("returns null from accept() after close()", async () => {
    const { transport } = await createLoopbackInterceptionTransport();
    await transport.close();
    expect(await transport.accept()).toBeNull();
  });

  it("fails a concurrent second accept() closed without stranding the first", async () => {
    const { transport, channel } = await createLoopbackInterceptionTransport();
    cleanups.push(() => transport.close());
    const first = transport.accept(); // parks the waiter
    expect(await transport.accept()).toBeNull(); // concurrent second -> null
    const client = await connectClient(portOf(channel.endpoint));
    cleanups.push(() => {
      client.destroy();
    });
    expect(await first).not.toBeNull(); // the first waiter still resolves
  });

  it("close() is concurrent-idempotent and resolves without rejecting", async () => {
    const { transport } = await createLoopbackInterceptionTransport();
    const a = transport.close();
    const b = transport.close();
    expect(a).toBe(b); // memoized: server closed at most once
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
  });

  it("close() destroys a live connection's socket and then accept() returns null", async () => {
    const { transport, channel } = await createLoopbackInterceptionTransport();
    const acceptP = transport.accept(); // park the waiter
    const client = await connectClient(portOf(channel.endpoint));
    cleanups.push(() => {
      client.destroy();
    });
    const conn = await acceptP; // resolving proves the socket is now tracked in liveSockets
    expect(conn).not.toBeNull();

    const clientClosed = new Promise<void>((resolve) => {
      client.once("close", () => {
        resolve();
      });
    });
    await transport.close();
    await clientClosed; // the tracked socket was destroyed by teardown
    expect(await transport.accept()).toBeNull();
  });

  it("close() clears a queued accepted connection so later accept() returns null", async () => {
    const { transport, channel } = await createLoopbackInterceptionTransport();
    cleanups.push(() => transport.close());

    const client = await connectClient(portOf(channel.endpoint));
    cleanups.push(() => {
      client.destroy();
    });

    const clientClosed = new Promise<void>((resolve) => {
      client.once("close", () => {
        resolve();
      });
    });

    // Let the server's connection handler run and queue the connection before any accept().
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    await transport.close();
    await clientClosed;

    expect(await transport.accept()).toBeNull();
  });

  it("send rejects when the underlying socket has already closed", async () => {
    const { transport, channel } = await createLoopbackInterceptionTransport();
    cleanups.push(() => transport.close());

    const client = await connectClient(portOf(channel.endpoint));
    cleanups.push(() => {
      client.destroy();
    });

    const conn = await transport.accept();
    expect(conn).not.toBeNull();

    if (conn) {
      const readP = conn.read();
      client.destroy();

      expect(await readP).toEqual({ kind: "closed" });
      await expect(conn.send("data")).rejects.toThrow();
    }
  });
});
