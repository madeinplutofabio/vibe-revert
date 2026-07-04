// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the pure command-guard matcher (M G2 Step 1, D102.C).
//
// The matching semantics are a LOCKED v1 contract: argv.join(" ")
// normalization (shell quoting intentionally lost), literal entries,
// exact-or-boundary-prefix matching, case-sensitive, guard before
// require_confirm, first source-order entry reported.

import { describe, expect, it } from "vitest";

import { evaluateCommandPolicy, matchGuardEntry, normalizeCommand } from "../src/command-guard.js";

describe("normalizeCommand (D102.C normalization)", () => {
  it("joins argv tokens with single spaces", () => {
    expect(normalizeCommand(["rm", "-rf", "/"])).toBe("rm -rf /");
  });

  it("single token passes through unchanged", () => {
    expect(normalizeCommand(["claude"])).toBe("claude");
  });

  it("child flags are preserved as tokens", () => {
    expect(normalizeCommand(["npm", "test", "--", "--watch"])).toBe("npm test -- --watch");
  });

  it("quoted-arg contract: shell quoting is intentionally lost (documented v1 contract, not a bug)", () => {
    // ["echo", "a b"] came from `viberevert run echo "a b"` -- the
    // quoting boundary is not reconstructable and v1 does not try.
    expect(normalizeCommand(["echo", "a b"])).toBe("echo a b");
  });
});

describe("matchGuardEntry (D102.C matching rule)", () => {
  it("matches on exact equality", () => {
    expect(matchGuardEntry("rm -rf /", "rm -rf /")).toBe(true);
  });

  it("matches a prefix ending at a join boundary", () => {
    expect(matchGuardEntry("rm -rf / --no-preserve-root", "rm -rf /")).toBe(true);
  });

  it("does NOT match a near-miss that extends the last token (rm -rf /x vs rm -rf /)", () => {
    expect(matchGuardEntry("rm -rf /x", "rm -rf /")).toBe(false);
  });

  it("does NOT match when the boundary falls inside a token (rm -rff x vs rm -rf)", () => {
    expect(matchGuardEntry("rm -rff x", "rm -rf")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(matchGuardEntry("RM -RF /", "rm -rf /")).toBe(false);
    expect(matchGuardEntry("Terraform destroy", "terraform destroy")).toBe(false);
  });

  it("does NOT match when the entry is longer than the command", () => {
    expect(matchGuardEntry("rm -rf", "rm -rf /")).toBe(false);
  });
});

describe("evaluateCommandPolicy (D102.C precedence + config absence)", () => {
  const argv = ["terraform", "destroy", "-auto-approve"] as const;

  it("allows everything when the commands section is absent", () => {
    expect(evaluateCommandPolicy(argv, undefined)).toEqual({
      kind: "allow",
      normalized: "terraform destroy -auto-approve",
    });
  });

  it("allows everything when both sub-lists are absent", () => {
    expect(evaluateCommandPolicy(argv, {})).toEqual({
      kind: "allow",
      normalized: "terraform destroy -auto-approve",
    });
  });

  it("returns guard with the matched entry and normalized command", () => {
    expect(evaluateCommandPolicy(argv, { guard: ["terraform destroy"] })).toEqual({
      kind: "guard",
      entry: "terraform destroy",
      normalized: "terraform destroy -auto-approve",
    });
  });

  it("returns confirm with the matched entry when only require_confirm matches", () => {
    expect(evaluateCommandPolicy(argv, { require_confirm: ["terraform destroy"] })).toEqual({
      kind: "confirm",
      entry: "terraform destroy",
      normalized: "terraform destroy -auto-approve",
    });
  });

  it("guard wins when a command matches entries in BOTH lists (confirm can never override)", () => {
    expect(
      evaluateCommandPolicy(argv, {
        guard: ["terraform destroy"],
        require_confirm: ["terraform destroy"],
      }),
    ).toEqual({
      kind: "guard",
      entry: "terraform destroy",
      normalized: "terraform destroy -auto-approve",
    });
  });

  it("reports the FIRST matching entry in source order within a list", () => {
    const decision = evaluateCommandPolicy(argv, {
      guard: ["kubectl delete", "terraform", "terraform destroy"],
    });
    expect(decision).toEqual({
      kind: "guard",
      entry: "terraform",
      normalized: "terraform destroy -auto-approve",
    });
  });

  it("non-matching lists fall through to allow", () => {
    expect(
      evaluateCommandPolicy(["echo", "hi"], {
        guard: ["rm -rf /"],
        require_confirm: ["terraform destroy"],
      }),
    ).toEqual({ kind: "allow", normalized: "echo hi" });
  });
});
