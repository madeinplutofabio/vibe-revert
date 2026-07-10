// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4b-i: the pure DECISION CORE. Exhaustive, I/O-free -- the envelope
// parser (accepts/rejects; never throws for hostile input; normalizes nothing)
// and the security decision (nonce/policy -> allow/block, every branch fails
// closed, id/version echoed, rawLine passed verbatim as one argv per D104.H).

import { describe, expect, it } from "vitest";

import type { CommandsPolicyConfig } from "../src/command-guard.js";
import {
  type InterceptionRequest,
  PTY_INTERCEPTION_PROTOCOL_VERSION,
} from "../src/commands/pty-interception.js";
import {
  type DecideInterceptionDeps,
  decideInterception,
  parseInterceptionRequest,
} from "../src/commands/pty-interception-service.js";

function makeRequest(over: Partial<InterceptionRequest> = {}): InterceptionRequest {
  return {
    protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
    nonce: "session-nonce",
    id: "req-1",
    rawLine: "echo hi",
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

describe("parseInterceptionRequest (M G4 Step 4b-i)", () => {
  it("accepts a well-formed envelope, keeping only the core fields", () => {
    const raw = JSON.stringify({ protocolVersion: 1, nonce: "n", id: "r1", rawLine: "echo hi" });
    expect(parseInterceptionRequest(raw)).toEqual({
      kind: "ok",
      request: { protocolVersion: 1, nonce: "n", id: "r1", rawLine: "echo hi" },
    });
  });

  it("ignores extra fields (forward/back compatibility)", () => {
    const raw = JSON.stringify({
      protocolVersion: 1,
      nonce: "n",
      id: "r1",
      rawLine: "echo hi",
      future: "ignored",
    });
    expect(parseInterceptionRequest(raw)).toEqual({
      kind: "ok",
      request: { protocolVersion: 1, nonce: "n", id: "r1", rawLine: "echo hi" },
    });
  });

  it("accepts an empty rawLine (an empty prompt-line observation)", () => {
    const raw = JSON.stringify({ protocolVersion: 1, nonce: "n", id: "r1", rawLine: "" });
    expect(parseInterceptionRequest(raw)).toEqual({
      kind: "ok",
      request: { protocolVersion: 1, nonce: "n", id: "r1", rawLine: "" },
    });
  });

  it("preserves rawLine byte-for-byte (no trim / normalize)", () => {
    const raw = JSON.stringify({
      protocolVersion: 1,
      nonce: "n",
      id: "r1",
      rawLine: "  ls  -la  ",
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
    });
    expect(parseInterceptionRequest(raw)).toEqual({
      kind: "ok",
      request: { protocolVersion: 1, nonce: " nonce ", id: " req-1 ", rawLine: "echo hi" },
    });
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

  const objRejects: [string, unknown][] = [
    ["wrong protocolVersion", { protocolVersion: 2, nonce: "n", id: "r1", rawLine: "x" }],
    ["missing protocolVersion", { nonce: "n", id: "r1", rawLine: "x" }],
    ["missing nonce", { protocolVersion: 1, id: "r1", rawLine: "x" }],
    ["whitespace nonce", { protocolVersion: 1, nonce: "   ", id: "r1", rawLine: "x" }],
    ["non-string nonce", { protocolVersion: 1, nonce: 5, id: "r1", rawLine: "x" }],
    ["missing id", { protocolVersion: 1, nonce: "n", rawLine: "x" }],
    ["whitespace id", { protocolVersion: 1, nonce: "n", id: "  ", rawLine: "x" }],
    ["missing rawLine", { protocolVersion: 1, nonce: "n", id: "r1" }],
    ["non-string rawLine", { protocolVersion: 1, nonce: "n", id: "r1", rawLine: 7 }],
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
