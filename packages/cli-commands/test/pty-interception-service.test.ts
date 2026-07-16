// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4b: the parent-side interception SERVICE. 4b-i (I/O-free decision
// core): the envelope parser (accepts/rejects; never throws for hostile input;
// normalizes nothing) and the security decision (nonce/policy -> allow/block,
// every branch fails closed, id/version echoed, rawLine passed verbatim as one
// argv per D104.H). 4b-ii (frame kernel + port-driven lifecycle): the NDJSON
// encoder, the total line -> outcome transform, and createInterceptionService
// over an injected fake transport (no real socket) -- connection-per-request,
// fail-closed on every non-allow path, defensive teardown.

import { describe, expect, it } from "vitest";

import type { CommandsPolicyConfig } from "../src/command-guard.js";
import {
  type InterceptionDecision,
  type InterceptionRequest,
  PTY_INTERCEPTION_PROTOCOL_VERSION,
} from "../src/commands/pty-interception.js";
import {
  type AcceptedCommandAuditInput,
  type AuditAcceptedCommand,
  type AuditAcceptedCommandResult,
  PTY_INTERCEPTION_MAX_CWD_LENGTH,
} from "../src/commands/pty-interception-audit.js";
import {
  type AuditGateFailureReason,
  createInterceptionService,
  type DecideInterceptionDeps,
  decideInterception,
  encodeDecisionFrame,
  handleRequestLine,
  type InterceptionConnectionRead,
  type InterceptionServiceConnection,
  type InterceptionServiceDeps,
  type InterceptionServiceTransport,
  parseInterceptionRequest,
} from "../src/commands/pty-interception-service.js";

function makeRequest(over: Partial<InterceptionRequest> = {}): InterceptionRequest {
  return {
    protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
    nonce: "session-nonce",
    id: "req-1",
    rawLine: "echo hi",
    cwd: "/repo/pkg",
    ...over,
  };
}

function makeDecideDeps(over: Partial<DecideInterceptionDeps> = {}): DecideInterceptionDeps {
  return {
    sessionNonce: "session-nonce",
    commandsPolicy: undefined,
    evaluateCommandPolicy: () => ({ kind: "allow", normalized: "echo hi" }),
    ...over,
  };
}

function makeServiceDeps(over: Partial<InterceptionServiceDeps> = {}): InterceptionServiceDeps {
  return {
    ...makeDecideDeps(),
    auditAcceptedCommand: () => Promise.resolve({ ok: true }),
    recordAuditGateFailure: () => undefined,
    ...over,
  };
}

interface ControllableAudit {
  readonly auditAcceptedCommand: AuditAcceptedCommand;
  entered: () => boolean;
  receivedInputs: () => readonly AcceptedCommandAuditInput[];
  readonly whenEntered: Promise<void>;
  resolve: (result: AuditAcceptedCommandResult) => void;
}

/**
 * An audit hook the test drives deterministically: `auditAcceptedCommand`
 * records the raw line + entry (resolving `whenEntered`) and parks until the
 * test calls `resolve()`. Lets a test prove the frame is not sent until the gate
 * completes, and that the SERVICE re-checks `stopped` AFTER the awaited gate --
 * with no reliance on microtask-flush counts. Fails loudly on misuse (resolve
 * before entry, or a second invocation) so a broken setup cannot hang silently.
 */
function makeControllableAudit(): ControllableAudit {
  let entered = false;
  let signalEntered: (() => void) | undefined;
  const whenEntered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const received: AcceptedCommandAuditInput[] = [];
  let release: ((result: AuditAcceptedCommandResult) => void) | undefined;
  return {
    auditAcceptedCommand: (input) => {
      if (release !== undefined) {
        return Promise.reject(new Error("audit gate invoked more than once"));
      }
      entered = true;
      received.push(input);
      signalEntered?.();
      return new Promise<AuditAcceptedCommandResult>((resolve) => {
        release = resolve;
      });
    },
    entered: () => entered,
    receivedInputs: () => received,
    whenEntered,
    resolve: (result) => {
      if (release === undefined) {
        throw new Error("audit gate has not been entered");
      }
      const currentRelease = release;
      release = undefined;
      currentRelease(result);
    },
  };
}

describe("parseInterceptionRequest (M G4 Step 4b-i)", () => {
  it("accepts a well-formed envelope, keeping only the core fields", () => {
    const raw = JSON.stringify({
      protocolVersion: 1,
      nonce: "n",
      id: "r1",
      rawLine: "echo hi",
      cwd: "/repo/a",
    });
    expect(parseInterceptionRequest(raw)).toEqual({
      kind: "ok",
      request: { protocolVersion: 1, nonce: "n", id: "r1", rawLine: "echo hi", cwd: "/repo/a" },
    });
  });

  it("ignores extra fields (forward/back compatibility)", () => {
    const raw = JSON.stringify({
      protocolVersion: 1,
      nonce: "n",
      id: "r1",
      rawLine: "echo hi",
      cwd: "/repo/a",
      future: "ignored",
    });
    expect(parseInterceptionRequest(raw)).toEqual({
      kind: "ok",
      request: { protocolVersion: 1, nonce: "n", id: "r1", rawLine: "echo hi", cwd: "/repo/a" },
    });
  });

  it("accepts an empty rawLine (an empty prompt-line observation)", () => {
    const raw = JSON.stringify({
      protocolVersion: 1,
      nonce: "n",
      id: "r1",
      rawLine: "",
      cwd: "/repo/a",
    });
    expect(parseInterceptionRequest(raw)).toEqual({
      kind: "ok",
      request: { protocolVersion: 1, nonce: "n", id: "r1", rawLine: "", cwd: "/repo/a" },
    });
  });

  it("preserves rawLine exactly (no trim / normalize)", () => {
    const raw = JSON.stringify({
      protocolVersion: 1,
      nonce: "n",
      id: "r1",
      rawLine: "  ls  -la  ",
      cwd: "/repo/a",
    });
    const result = parseInterceptionRequest(raw);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.request.rawLine).toBe("  ls  -la  ");
    }
  });

  it("preserves valid nonce and id without trimming", () => {
    const raw = JSON.stringify({
      protocolVersion: 1,
      nonce: " nonce ",
      id: " req-1 ",
      rawLine: "echo hi",
      cwd: "/repo/a",
    });
    expect(parseInterceptionRequest(raw)).toEqual({
      kind: "ok",
      request: {
        protocolVersion: 1,
        nonce: " nonce ",
        id: " req-1 ",
        rawLine: "echo hi",
        cwd: "/repo/a",
      },
    });
  });

  it("preserves an unusual cwd EXACTLY (no trim/normalize -- semantics are the gate's job)", () => {
    const cwd = "  /repo/a/../b  ";
    const raw = JSON.stringify({ protocolVersion: 1, nonce: "n", id: "r1", rawLine: "x", cwd });
    const result = parseInterceptionRequest(raw);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      // Identical to the sent value. The audit gate's resolveAuditedCwd later
      // rejects it because the string is not an absolute POSIX path as received;
      // neither layer trims.
      expect(result.request.cwd).toBe(cwd);
    }
  });

  it("preserves a cwd with escaped quotes/backslashes exactly as JSON.parse produced it", () => {
    const cwd = '/repo/quoted"dir\\name';
    const raw = JSON.stringify({ protocolVersion: 1, nonce: "n", id: "r1", rawLine: "x", cwd });
    const result = parseInterceptionRequest(raw);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.request.cwd).toBe(cwd);
    }
  });

  it("accepts cwd exactly at the parser size bound", () => {
    const cwd = `/${"a".repeat(PTY_INTERCEPTION_MAX_CWD_LENGTH - 1)}`;
    expect(cwd.length).toBe(PTY_INTERCEPTION_MAX_CWD_LENGTH);
    const result = parseInterceptionRequest(
      JSON.stringify({ protocolVersion: 1, nonce: "n", id: "r1", rawLine: "x", cwd }),
    );
    expect(result.kind).toBe("ok");
  });

  const rawRejects: [string, string][] = [
    ["non-JSON", "not json at all"],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["JSON number", "1"],
    ["JSON string", '"x"'],
    ["empty object", "{}"],
  ];
  it.each(rawRejects)("rejects %s as malformed_request (never throws)", (_label, raw) => {
    expect(parseInterceptionRequest(raw)).toEqual({
      kind: "malformed",
      reason: "malformed_request",
    });
  });

  // Every fixture carries a VALID cwd except the cwd cases themselves, so each
  // isolates exactly the defect it names (a missing cwd would otherwise make them
  // malformed for the wrong reason, and they would pass even if their intended
  // check were deleted).
  const objRejects: [string, unknown][] = [
    [
      "wrong protocolVersion",
      { protocolVersion: 2, nonce: "n", id: "r1", rawLine: "x", cwd: "/r" },
    ],
    ["missing protocolVersion", { nonce: "n", id: "r1", rawLine: "x", cwd: "/r" }],
    ["missing nonce", { protocolVersion: 1, id: "r1", rawLine: "x", cwd: "/r" }],
    ["whitespace nonce", { protocolVersion: 1, nonce: "   ", id: "r1", rawLine: "x", cwd: "/r" }],
    ["non-string nonce", { protocolVersion: 1, nonce: 5, id: "r1", rawLine: "x", cwd: "/r" }],
    ["missing id", { protocolVersion: 1, nonce: "n", rawLine: "x", cwd: "/r" }],
    ["whitespace id", { protocolVersion: 1, nonce: "n", id: "  ", rawLine: "x", cwd: "/r" }],
    ["missing rawLine", { protocolVersion: 1, nonce: "n", id: "r1", cwd: "/r" }],
    ["non-string rawLine", { protocolVersion: 1, nonce: "n", id: "r1", rawLine: 7, cwd: "/r" }],
    ["missing cwd", { protocolVersion: 1, nonce: "n", id: "r1", rawLine: "x" }],
    ["non-string cwd", { protocolVersion: 1, nonce: "n", id: "r1", rawLine: "x", cwd: 7 }],
    ["empty cwd", { protocolVersion: 1, nonce: "n", id: "r1", rawLine: "x", cwd: "" }],
    [
      "oversized cwd",
      {
        protocolVersion: 1,
        nonce: "n",
        id: "r1",
        rawLine: "x",
        cwd: `/${"a".repeat(PTY_INTERCEPTION_MAX_CWD_LENGTH)}`,
      },
    ],
  ];
  it.each(objRejects)("rejects %s as malformed_request", (_label, obj) => {
    expect(parseInterceptionRequest(JSON.stringify(obj))).toEqual({
      kind: "malformed",
      reason: "malformed_request",
    });
  });
});

describe("decideInterception (M G4 Step 4b-i)", () => {
  it("blocks on a nonce mismatch, echoing id + version", () => {
    const decision = decideInterception(
      makeRequest({ nonce: "wrong", id: "r7" }),
      makeDecideDeps({ sessionNonce: "session-nonce" }),
    );
    expect(decision).toEqual({
      protocolVersion: 1,
      id: "r7",
      kind: "block",
      reason: "nonce_mismatch",
    });
  });

  it("blocks a nonce mismatch BEFORE evaluating policy", () => {
    let policyCalls = 0;
    const decision = decideInterception(
      makeRequest({ nonce: "wrong" }),
      makeDecideDeps({
        evaluateCommandPolicy: () => {
          policyCalls += 1;
          return { kind: "allow", normalized: "echo hi" };
        },
      }),
    );
    expect(decision).toEqual({
      protocolVersion: 1,
      id: "req-1",
      kind: "block",
      reason: "nonce_mismatch",
    });
    expect(policyCalls).toBe(0);
  });

  it("blocks with policy_error when evaluateCommandPolicy throws", () => {
    const decision = decideInterception(
      makeRequest({ id: "r8" }),
      makeDecideDeps({
        evaluateCommandPolicy: () => {
          throw new Error("policy blew up");
        },
      }),
    );
    expect(decision).toEqual({
      protocolVersion: 1,
      id: "r8",
      kind: "block",
      reason: "policy_error",
    });
  });

  it("blocks with policy_error for an unexpected policy decision kind", () => {
    const decision = decideInterception(
      makeRequest({ id: "r10" }),
      makeDecideDeps({
        evaluateCommandPolicy: () =>
          ({ kind: "future_kind", normalized: "echo hi" }) as unknown as ReturnType<
            DecideInterceptionDeps["evaluateCommandPolicy"]
          >,
      }),
    );
    expect(decision).toEqual({
      protocolVersion: 1,
      id: "r10",
      kind: "block",
      reason: "policy_error",
    });
  });

  it("blocks with policy_error for a malformed policy decision object", () => {
    const decision = decideInterception(
      makeRequest({ id: "r11" }),
      makeDecideDeps({
        evaluateCommandPolicy: () =>
          null as unknown as ReturnType<DecideInterceptionDeps["evaluateCommandPolicy"]>,
      }),
    );
    expect(decision).toEqual({
      protocolVersion: 1,
      id: "r11",
      kind: "block",
      reason: "policy_error",
    });
  });

  it("blocks a guard match as blocked_by_policy", () => {
    const decision = decideInterception(
      makeRequest(),
      makeDecideDeps({
        evaluateCommandPolicy: () => ({ kind: "guard", entry: "rm -rf /", normalized: "rm -rf /" }),
      }),
    );
    expect(decision).toEqual({
      protocolVersion: 1,
      id: "req-1",
      kind: "block",
      reason: "blocked_by_policy",
    });
  });

  it("blocks a require_confirm match as blocked_by_policy (no interactive confirm in v1)", () => {
    const decision = decideInterception(
      makeRequest(),
      makeDecideDeps({
        evaluateCommandPolicy: () => ({
          kind: "confirm",
          entry: "git push",
          normalized: "git push",
        }),
      }),
    );
    expect(decision).toEqual({
      protocolVersion: 1,
      id: "req-1",
      kind: "block",
      reason: "blocked_by_policy",
    });
  });

  it("allows a non-matching command, echoing id + version", () => {
    const decision = decideInterception(
      makeRequest({ id: "r9" }),
      makeDecideDeps({ evaluateCommandPolicy: () => ({ kind: "allow", normalized: "echo hi" }) }),
    );
    expect(decision).toEqual({ protocolVersion: 1, id: "r9", kind: "allow" });
  });

  it("evaluates the raw prompt line as ONE synthetic argv, verbatim (D104.H)", () => {
    let receivedArgv: readonly string[] | undefined;
    let receivedPolicy: CommandsPolicyConfig | undefined;
    const policy: CommandsPolicyConfig = { guard: ["rm -rf /"] };

    decideInterception(
      makeRequest({ rawLine: "  ls  -la  " }),
      makeDecideDeps({
        commandsPolicy: policy,
        evaluateCommandPolicy: (argv, p) => {
          receivedArgv = argv;
          receivedPolicy = p;
          return { kind: "allow", normalized: "  ls  -la  " };
        },
      }),
    );

    expect(receivedArgv).toEqual(["  ls  -la  "]); // one element, no tokenizing / trimming
    expect(receivedPolicy).toBe(policy);
  });
});

// --- 4b-ii: frame kernel + fake-transport lifecycle -------------------------

/** Parse a wire frame (one NDJSON line, trailing newline tolerated) back to a decision. */
function decodeFrame(frame: string): InterceptionDecision {
  return JSON.parse(frame) as InterceptionDecision;
}

/** A well-formed request line whose nonce matches makeDecideDeps()'s session nonce. */
function requestLine(over: Partial<InterceptionRequest> = {}): string {
  return JSON.stringify(makeRequest(over));
}

type FakeReadBehavior = InterceptionConnectionRead | "throw" | "hang" | "deferred";

interface FakeConnectionOptions {
  read?: FakeReadBehavior;
  sendThrows?: boolean;
  closeThrows?: boolean;
}

interface FakeConnection {
  connection: InterceptionServiceConnection;
  sent: () => readonly string[];
  sendCalls: () => number;
  closeCalls: () => number;
  resolveRead: (read: InterceptionConnectionRead) => void;
}

/**
 * A scripted single-request connection: `read` resolves to one outcome (or
 * throws, hangs until closed, or -- in "deferred" mode -- waits until the test
 * calls resolveRead()), `send` records frames (or throws if `sendThrows`),
 * `close` counts calls (and, for a hung read, unblocks it).
 */
function makeFakeConnection(options: FakeConnectionOptions = {}): FakeConnection {
  const sent: string[] = [];
  let sendCalls = 0;
  let closeCalls = 0;
  let releaseHang: (() => void) | undefined;
  let resolveDeferredRead: ((read: InterceptionConnectionRead) => void) | undefined;

  const connection: InterceptionServiceConnection = {
    read: () => {
      if (options.read === "throw") {
        return Promise.reject(new Error("read failed"));
      }
      if (options.read === "hang") {
        return new Promise<InterceptionConnectionRead>((resolve) => {
          releaseHang = () => {
            resolve({ kind: "closed" });
          };
        });
      }
      if (options.read === "deferred") {
        return new Promise<InterceptionConnectionRead>((resolve) => {
          resolveDeferredRead = resolve;
        });
      }
      return Promise.resolve(options.read ?? { kind: "closed" });
    },
    send: (frame) => {
      sendCalls += 1;
      if (options.sendThrows) {
        return Promise.reject(new Error("send failed"));
      }
      sent.push(frame);
      return Promise.resolve();
    },
    close: () => {
      closeCalls += 1;
      releaseHang?.();
      releaseHang = undefined;
      if (options.closeThrows) {
        return Promise.reject(new Error("close failed"));
      }
      return Promise.resolve();
    },
  };

  return {
    connection,
    sent: () => sent,
    sendCalls: () => sendCalls,
    closeCalls: () => closeCalls,
    resolveRead: (read) => {
      resolveDeferredRead?.(read);
      resolveDeferredRead = undefined;
    },
  };
}

interface FakeTransportOptions {
  connections?: readonly InterceptionServiceConnection[];
  blockWhenDrained?: boolean;
  acceptThrowsAt?: number;
  closeThrows?: boolean;
}

interface FakeTransport {
  transport: InterceptionServiceTransport;
  acceptCalls: () => number;
  closeCalls: () => number;
}

/**
 * A scripted transport: `accept` yields the queued connections in order, then
 * either `null` (finite) or a pending promise resolved to `null` by `close`
 * (blockWhenDrained -- models a real listener). `acceptThrowsAt` makes the Nth
 * accept reject. `close` records calls and unblocks a pending accept with null.
 */
function makeFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const queue = [...(options.connections ?? [])];
  let acceptCalls = 0;
  let closeCalls = 0;
  let closed = false;
  let releaseAccept: ((value: InterceptionServiceConnection | null) => void) | undefined;

  const transport: InterceptionServiceTransport = {
    accept: () => {
      const call = acceptCalls;
      acceptCalls += 1;
      if (options.acceptThrowsAt === call) {
        return Promise.reject(new Error("accept failed"));
      }
      if (closed) {
        return Promise.resolve(null);
      }
      const next = queue.shift();
      if (next !== undefined) {
        return Promise.resolve(next);
      }
      if (options.blockWhenDrained) {
        return new Promise<InterceptionServiceConnection | null>((resolve) => {
          releaseAccept = resolve;
        });
      }
      return Promise.resolve(null);
    },
    close: () => {
      closeCalls += 1;
      closed = true;
      releaseAccept?.(null);
      releaseAccept = undefined;
      if (options.closeThrows) {
        return Promise.reject(new Error("transport close failed"));
      }
      return Promise.resolve();
    },
  };

  return {
    transport,
    acceptCalls: () => acceptCalls,
    closeCalls: () => closeCalls,
  };
}

/** Let queued microtasks drain so the accept loop can advance (e.g. park in read). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("encodeDecisionFrame (M G4 Step 4b-ii)", () => {
  it("encodes an allow decision as one newline-terminated JSON line", () => {
    const decision: InterceptionDecision = {
      protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
      id: "r1",
      kind: "allow",
    };
    const frame = encodeDecisionFrame(decision);
    expect(frame.endsWith("\n")).toBe(true);
    expect(frame.slice(0, -1)).not.toContain("\n"); // no embedded newline
    expect(decodeFrame(frame)).toEqual({ protocolVersion: 1, id: "r1", kind: "allow" });
  });

  it("encodes a block decision, preserving reason, and round-trips", () => {
    const decision: InterceptionDecision = {
      protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
      id: "r2",
      kind: "block",
      reason: "blocked_by_policy",
    };
    const frame = encodeDecisionFrame(decision);
    expect(decodeFrame(frame)).toEqual({
      protocolVersion: 1,
      id: "r2",
      kind: "block",
      reason: "blocked_by_policy",
    });
  });

  it("emits exactly one trailing newline", () => {
    const frame = encodeDecisionFrame({
      protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
      id: "r3",
      kind: "allow",
    });
    expect(frame.indexOf("\n")).toBe(frame.length - 1);
  });
});

describe("handleRequestLine (M G4 Step 4b-ii)", () => {
  it("returns an allow outcome for a non-matching command, carrying the frame + audit input", () => {
    const outcome = handleRequestLine(
      requestLine({ id: "r1", rawLine: "echo hi", cwd: "/repo/pkg" }),
      makeDecideDeps(),
    );
    expect(outcome.kind).toBe("allow");
    if (outcome.kind === "allow") {
      expect(outcome.auditInput).toEqual({ rawLine: "echo hi", cwd: "/repo/pkg" });
      expect(decodeFrame(outcome.frame)).toEqual({ protocolVersion: 1, id: "r1", kind: "allow" });
    }
  });

  it("responds with a blocked_by_policy frame for a guard match", () => {
    const outcome = handleRequestLine(
      requestLine({ id: "r2" }),
      makeDecideDeps({
        evaluateCommandPolicy: () => ({ kind: "guard", entry: "rm -rf /", normalized: "rm -rf /" }),
      }),
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(decodeFrame(outcome.frame)).toEqual({
        protocolVersion: 1,
        id: "r2",
        kind: "block",
        reason: "blocked_by_policy",
      });
    }
  });

  it("responds with a blocked_by_policy frame for a require_confirm match", () => {
    const outcome = handleRequestLine(
      requestLine({ id: "r3" }),
      makeDecideDeps({
        evaluateCommandPolicy: () => ({
          kind: "confirm",
          entry: "git push",
          normalized: "git push",
        }),
      }),
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(decodeFrame(outcome.frame)).toEqual({
        protocolVersion: 1,
        id: "r3",
        kind: "block",
        reason: "blocked_by_policy",
      });
    }
  });

  it("responds with a nonce_mismatch block frame (a valid request denied, id echoed)", () => {
    const outcome = handleRequestLine(
      requestLine({ nonce: "wrong", id: "r4" }),
      makeDecideDeps({ sessionNonce: "session-nonce" }),
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(decodeFrame(outcome.frame)).toEqual({
        protocolVersion: 1,
        id: "r4",
        kind: "block",
        reason: "nonce_mismatch",
      });
    }
  });

  it("responds with a policy_error frame when policy throws", () => {
    const outcome = handleRequestLine(
      requestLine({ id: "r5" }),
      makeDecideDeps({
        evaluateCommandPolicy: () => {
          throw new Error("policy blew up");
        },
      }),
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(decodeFrame(outcome.frame)).toEqual({
        protocolVersion: 1,
        id: "r5",
        kind: "block",
        reason: "policy_error",
      });
    }
  });

  it("responds with a policy_error frame for a null policy decision", () => {
    const outcome = handleRequestLine(
      requestLine({ id: "r6" }),
      makeDecideDeps({
        evaluateCommandPolicy: () =>
          null as unknown as ReturnType<DecideInterceptionDeps["evaluateCommandPolicy"]>,
      }),
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(decodeFrame(outcome.frame)).toEqual({
        protocolVersion: 1,
        id: "r6",
        kind: "block",
        reason: "policy_error",
      });
    }
  });

  it("responds with a policy_error frame for an unexpected policy kind", () => {
    const outcome = handleRequestLine(
      requestLine({ id: "r7" }),
      makeDecideDeps({
        evaluateCommandPolicy: () =>
          ({ kind: "future_kind", normalized: "x" }) as unknown as ReturnType<
            DecideInterceptionDeps["evaluateCommandPolicy"]
          >,
      }),
    );
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(decodeFrame(outcome.frame)).toEqual({
        protocolVersion: 1,
        id: "r7",
        kind: "block",
        reason: "policy_error",
      });
    }
  });

  const malformedLines: [string, string][] = [
    ["non-JSON", "not json at all"],
    ["empty object", "{}"],
    ["JSON array", "[]"],
    ["wrong version", JSON.stringify({ protocolVersion: 2, nonce: "n", id: "r", rawLine: "x" })],
  ];
  it.each(malformedLines)("closes a malformed line (%s) with NO frame", (_label, line) => {
    expect(handleRequestLine(line, makeDecideDeps())).toEqual({ kind: "close" });
  });

  it("never throws on hostile input (returns allow, block, or close)", () => {
    const hostile = ["", "\u0000", "{", "999", '"str"', "null", "[1,2,3]"];
    for (const line of hostile) {
      const outcome = handleRequestLine(line, makeDecideDeps());
      expect(["allow", "block", "close"]).toContain(outcome.kind);
    }
  });
});

describe("createInterceptionService (M G4 Step 4b-ii)", () => {
  it("serves a well-formed request: sends the decision frame, then closes", async () => {
    const conn = makeFakeConnection({ read: { kind: "frame", line: requestLine({ id: "r1" }) } });
    const { transport, closeCalls } = makeFakeTransport({ connections: [conn.connection] });
    const service = createInterceptionService(transport, makeServiceDeps());

    await service.done;

    const frames = conn.sent();
    expect(frames).toHaveLength(1);
    expect(decodeFrame(frames[0] ?? "")).toEqual({ protocolVersion: 1, id: "r1", kind: "allow" });
    expect(conn.closeCalls()).toBeGreaterThanOrEqual(1);
    expect(closeCalls()).toBe(0); // finite transport: loop ended on accept()->null
  });

  it("closes a malformed request WITHOUT ever calling send (no id-less decision)", async () => {
    const conn = makeFakeConnection({
      read: { kind: "frame", line: "not json at all" },
      sendThrows: true, // would reject if the service ever tried to respond
    });
    const { transport } = makeFakeTransport({ connections: [conn.connection] });
    const service = createInterceptionService(transport, makeServiceDeps());

    await service.done; // resolves; a stray send() never happens

    expect(conn.sendCalls()).toBe(0);
    expect(conn.sent()).toHaveLength(0);
    expect(conn.closeCalls()).toBeGreaterThanOrEqual(1);
  });

  const nonFrameReads: [string, FakeReadBehavior][] = [
    ["timeout", { kind: "timeout" }],
    ["peer close", { kind: "closed" }],
    ["read error", "throw"],
  ];
  it.each(nonFrameReads)("closes with no frame when the read is %s", async (_label, read) => {
    const conn = makeFakeConnection({ read, sendThrows: true });
    const { transport } = makeFakeTransport({ connections: [conn.connection] });
    const service = createInterceptionService(transport, makeServiceDeps());

    await service.done;

    expect(conn.sendCalls()).toBe(0);
    expect(conn.closeCalls()).toBeGreaterThanOrEqual(1);
  });

  it("fails closed when send throws: connection closed, done still resolves", async () => {
    const conn = makeFakeConnection({
      read: { kind: "frame", line: requestLine() },
      sendThrows: true,
    });
    const { transport } = makeFakeTransport({ connections: [conn.connection] });
    const service = createInterceptionService(transport, makeServiceDeps());

    await service.done;

    expect(conn.sendCalls()).toBe(1); // it tried to send
    expect(conn.sent()).toHaveLength(0); // but nothing was recorded (it threw)
    expect(conn.closeCalls()).toBeGreaterThanOrEqual(1);
  });

  it("swallows a connection.close error and keeps serving later connections", async () => {
    const first = makeFakeConnection({
      read: { kind: "frame", line: requestLine({ id: "a" }) },
      closeThrows: true,
    });
    const second = makeFakeConnection({ read: { kind: "frame", line: requestLine({ id: "b" }) } });
    const { transport } = makeFakeTransport({
      connections: [first.connection, second.connection],
    });
    const service = createInterceptionService(transport, makeServiceDeps());

    await service.done;

    expect(decodeFrame(first.sent()[0] ?? "").id).toBe("a");
    expect(decodeFrame(second.sent()[0] ?? "").id).toBe("b");
  });

  it("resolves done when accept returns null with no connection (ALSO-4)", async () => {
    const { transport, closeCalls } = makeFakeTransport({ connections: [] });
    const service = createInterceptionService(transport, makeServiceDeps());

    await service.done; // resolves with no connection served, no teardown needed

    expect(closeCalls()).toBe(0);
  });

  it("starts the accept loop immediately (live on creation, no start())", async () => {
    const { transport, acceptCalls } = makeFakeTransport({
      connections: [],
      blockWhenDrained: true,
    });
    const service = createInterceptionService(transport, makeServiceDeps());

    expect(acceptCalls()).toBe(1); // accept() was called synchronously on creation

    await service.stop(); // unblock + tear down so the test does not hang
  });

  it("stop() closes the transport, resolves done, and is concurrent-idempotent", async () => {
    const { transport, closeCalls } = makeFakeTransport({
      connections: [],
      blockWhenDrained: true,
    });
    const service = createInterceptionService(transport, makeServiceDeps());

    const first = service.stop();
    const second = service.stop();
    expect(first).toBe(second); // same shutdown path

    await first;
    await service.done;

    expect(closeCalls()).toBe(1); // transport.close invoked once by stop()
  });

  it("stop() swallows transport.close errors and still resolves", async () => {
    const { transport, closeCalls } = makeFakeTransport({
      connections: [],
      blockWhenDrained: true,
      closeThrows: true,
    });
    const service = createInterceptionService(transport, makeServiceDeps());

    await expect(service.stop()).resolves.toBeUndefined();
    await expect(service.done).resolves.toBeUndefined();

    expect(closeCalls()).toBe(1);
  });

  it("closes a connection accepted after stop began WITHOUT reading or serving it", async () => {
    const conn = makeFakeConnection({
      read: { kind: "frame", line: requestLine() },
      sendThrows: true, // would reject if it were ever served
    });
    const { transport } = makeFakeTransport({
      connections: [conn.connection],
      blockWhenDrained: true,
    });
    const service = createInterceptionService(transport, makeServiceDeps());

    // stop() synchronously, before the loop resumes from its first accept.
    await service.stop();
    await service.done;

    expect(conn.sendCalls()).toBe(0);
    expect(conn.closeCalls()).toBeGreaterThanOrEqual(1);
  });

  it("stop() closes a stalled in-flight connection to unblock its read", async () => {
    const conn = makeFakeConnection({ read: "hang" }); // read() never resolves on its own
    const { transport } = makeFakeTransport({
      connections: [conn.connection],
      blockWhenDrained: true,
    });
    const service = createInterceptionService(transport, makeServiceDeps());

    await flushMicrotasks(); // let accept -> serveConnection park in the hung read

    await service.stop(); // closes the active connection -> read unblocks -> loop ends
    await service.done;

    expect(conn.sendCalls()).toBe(0);
    expect(conn.closeCalls()).toBeGreaterThanOrEqual(1);
  });

  it("stop() after a frame is read but before the service resumes -> no send", async () => {
    const conn = makeFakeConnection({ read: "deferred", sendThrows: true });
    const { transport } = makeFakeTransport({
      connections: [conn.connection],
      blockWhenDrained: true,
    });
    const service = createInterceptionService(transport, makeServiceDeps());

    await flushMicrotasks(); // loop parks in the deferred read

    // The read yields a frame, then stop() begins BEFORE the service resumes.
    // stop() sets state.stopped synchronously, so the post-read re-check skips
    // the send: no decision may be emitted once teardown has started.
    conn.resolveRead({ kind: "frame", line: requestLine() });
    await service.stop();
    await service.done;

    expect(conn.sendCalls()).toBe(0);
    expect(conn.closeCalls()).toBeGreaterThanOrEqual(1);
  });

  it("stops the loop without retrying when accept() throws (no hot loop)", async () => {
    const { transport, acceptCalls, closeCalls } = makeFakeTransport({ acceptThrowsAt: 0 });
    const service = createInterceptionService(transport, makeServiceDeps());

    await service.done;

    expect(acceptCalls()).toBe(1); // called once, not retried
    expect(closeCalls()).toBe(1); // best-effort transport close in the catch
  });

  it("accept failure plus transport.close failure still resolves done", async () => {
    const { transport, acceptCalls, closeCalls } = makeFakeTransport({
      acceptThrowsAt: 0,
      closeThrows: true,
    });
    const service = createInterceptionService(transport, makeServiceDeps());

    await expect(service.done).resolves.toBeUndefined();

    expect(acceptCalls()).toBe(1);
    expect(closeCalls()).toBe(1);
  });
});

describe("createInterceptionService -- accepted-command audit gate (M G4 Step 5b)", () => {
  it("waits for the audit gate before sending an allow frame (audit-before-send ordering)", async () => {
    const audit = makeControllableAudit();
    const conn = makeFakeConnection({
      read: {
        kind: "frame",
        line: requestLine({ id: "r1", rawLine: "echo hi", cwd: "/repo/pkg" }),
      },
    });
    const { transport } = makeFakeTransport({ connections: [conn.connection] });
    const service = createInterceptionService(
      transport,
      makeServiceDeps({ auditAcceptedCommand: audit.auditAcceptedCommand }),
    );

    await audit.whenEntered;
    expect(conn.sendCalls()).toBe(0); // no frame until the gate completes
    // the EXACT bound {rawLine, cwd} reached the gate
    expect(audit.receivedInputs()).toEqual([{ rawLine: "echo hi", cwd: "/repo/pkg" }]);

    audit.resolve({ ok: true });
    await service.done;

    expect(conn.sendCalls()).toBe(1);
    expect(decodeFrame(conn.sent()[0] ?? "")).toEqual({
      protocolVersion: 1,
      id: "r1",
      kind: "allow",
    });
  });

  it("does NOT run the audit gate for a block, and sends the block frame", async () => {
    let auditCalls = 0;
    const conn = makeFakeConnection({ read: { kind: "frame", line: requestLine({ id: "r2" }) } });
    const { transport } = makeFakeTransport({ connections: [conn.connection] });
    const service = createInterceptionService(
      transport,
      makeServiceDeps({
        evaluateCommandPolicy: () => ({ kind: "guard", entry: "rm -rf /", normalized: "rm -rf /" }),
        auditAcceptedCommand: () => {
          auditCalls += 1;
          return Promise.resolve({ ok: true });
        },
      }),
    );

    await service.done;

    expect(auditCalls).toBe(0);
    expect(decodeFrame(conn.sent()[0] ?? "")).toEqual({
      protocolVersion: 1,
      id: "r2",
      kind: "block",
      reason: "blocked_by_policy",
    });
  });

  it("does NOT run the audit gate for a malformed request", async () => {
    let auditCalls = 0;
    const conn = makeFakeConnection({
      read: { kind: "frame", line: "not json at all" },
      sendThrows: true,
    });
    const { transport } = makeFakeTransport({ connections: [conn.connection] });
    const service = createInterceptionService(
      transport,
      makeServiceDeps({
        auditAcceptedCommand: () => {
          auditCalls += 1;
          return Promise.resolve({ ok: true });
        },
      }),
    );

    await service.done;

    expect(auditCalls).toBe(0);
    expect(conn.sendCalls()).toBe(0);
  });

  it("fails closed on an audit ok:false: records the reason, sends no frame, closes", async () => {
    let auditCalls = 0;
    const recorded: AuditGateFailureReason[] = [];
    const conn = makeFakeConnection({
      read: { kind: "frame", line: requestLine() },
      sendThrows: true,
    });
    const { transport } = makeFakeTransport({ connections: [conn.connection] });
    const service = createInterceptionService(
      transport,
      makeServiceDeps({
        auditAcceptedCommand: () => {
          auditCalls += 1;
          return Promise.resolve({ ok: false, reason: "session_changed" });
        },
        recordAuditGateFailure: (reason) => recorded.push(reason),
      }),
    );

    await service.done;

    expect(auditCalls).toBe(1);
    expect(conn.sendCalls()).toBe(0);
    expect(conn.sent()).toHaveLength(0);
    expect(recorded).toEqual(["session_changed"]);
    expect(conn.closeCalls()).toBeGreaterThanOrEqual(1);
  });

  it("fails closed when the audit hook throws: records audit_hook_threw, no frame", async () => {
    let auditCalls = 0;
    const recorded: AuditGateFailureReason[] = [];
    const conn = makeFakeConnection({
      read: { kind: "frame", line: requestLine() },
      sendThrows: true,
    });
    const { transport } = makeFakeTransport({ connections: [conn.connection] });
    const service = createInterceptionService(
      transport,
      makeServiceDeps({
        auditAcceptedCommand: () => {
          auditCalls += 1;
          return Promise.reject(new Error("hook blew up"));
        },
        recordAuditGateFailure: (reason) => recorded.push(reason),
      }),
    );

    await service.done;

    expect(auditCalls).toBe(1);
    expect(conn.sendCalls()).toBe(0);
    expect(recorded).toEqual(["audit_hook_threw"]);
    expect(conn.closeCalls()).toBeGreaterThanOrEqual(1);
  });

  it("audit success then a send failure closes with NO audit diagnostic (transport != audit failure)", async () => {
    let auditCalls = 0;
    const recorded: AuditGateFailureReason[] = [];
    const conn = makeFakeConnection({
      read: { kind: "frame", line: requestLine() },
      sendThrows: true,
    });
    const { transport } = makeFakeTransport({ connections: [conn.connection] });
    const service = createInterceptionService(
      transport,
      makeServiceDeps({
        auditAcceptedCommand: () => {
          auditCalls += 1;
          return Promise.resolve({ ok: true });
        },
        recordAuditGateFailure: (reason) => recorded.push(reason),
      }),
    );

    await service.done;

    expect(auditCalls).toBe(1); // gate ran once, no retry
    expect(conn.sendCalls()).toBe(1); // it tried to send the allow frame
    expect(conn.sent()).toHaveLength(0); // send threw -> nothing on the wire
    expect(recorded).toEqual([]); // audit SUCCEEDED -> no audit-failure diagnostic
    expect(conn.closeCalls()).toBeGreaterThanOrEqual(1);
  });

  it("a throwing recordAuditGateFailure does not weaken the fail-closed close", async () => {
    const conn = makeFakeConnection({
      read: { kind: "frame", line: requestLine() },
      sendThrows: true,
    });
    const { transport } = makeFakeTransport({ connections: [conn.connection] });
    const service = createInterceptionService(
      transport,
      makeServiceDeps({
        auditAcceptedCommand: () => Promise.resolve({ ok: false, reason: "append_failed" }),
        recordAuditGateFailure: () => {
          throw new Error("recorder blew up");
        },
      }),
    );

    await expect(service.done).resolves.toBeUndefined();
    expect(conn.sendCalls()).toBe(0);
    expect(conn.closeCalls()).toBeGreaterThanOrEqual(1);
  });

  it("stop() entered but before the audit resolves -> no allow frame (post-await stopped check)", async () => {
    const audit = makeControllableAudit();
    const recorded: AuditGateFailureReason[] = [];
    const conn = makeFakeConnection({
      read: { kind: "frame", line: requestLine() },
      sendThrows: true,
    });
    const { transport } = makeFakeTransport({
      connections: [conn.connection],
      blockWhenDrained: true,
    });
    const service = createInterceptionService(
      transport,
      makeServiceDeps({
        auditAcceptedCommand: audit.auditAcceptedCommand,
        recordAuditGateFailure: (reason) => recorded.push(reason),
      }),
    );

    await audit.whenEntered;
    expect(audit.entered()).toBe(true);

    // stop() sets state.stopped SYNCHRONOUSLY; only THEN does the audit resolve ok.
    const stopping = service.stop();
    audit.resolve({ ok: true });
    await stopping;
    await service.done;

    expect(audit.receivedInputs()).toHaveLength(1); // gate entered exactly once, no retry
    expect(conn.sendCalls()).toBe(0);
    expect(recorded).toEqual([]); // audit SUCCEEDED; a shutdown-blocked send is NOT an audit failure
    expect(conn.closeCalls()).toBeGreaterThanOrEqual(1);
  });
});
