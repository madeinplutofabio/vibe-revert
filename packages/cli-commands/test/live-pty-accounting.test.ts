// packages/cli-commands/test/live-pty-accounting.test.ts
// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M H7 Step 2.4: narrow tests for the live-PTY accounting layer.
//   1. decideLivePtyAccounting -- the pure policy decision, exhaustively over
//      (disposition x outcome), including the locked macOS case where a missing
//      node-pty binding is a VIOLATION, not a permitted skip;
//   2. readLivePtyPlatformPolicy -- against the REAL support.yml for all three
//      logical platforms, plus the registry check that rejects an undeclared
//      reason_code and the exercised-carries-no-reason_code rule;
//   3. accountLivePtyHost's runtime guards -- unknown group / blank label throw
//      before any manifest load or policy evaluation;
//   4. the bounded suite-group registry -- locked to exactly three groups, each
//      with an on-disk suite file, so an entire live suite disappearing is caught.

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it, type TestContext } from "vitest";

import {
  decideLivePtyAccounting,
  type LivePtyHostOutcome,
  type LivePtyPlatform,
  type LivePtyPlatformPolicy,
  type LivePtyReasonCode,
  readLivePtyPlatformPolicy,
} from "../../../scripts/support-manifest-live-pty.js";
import { parseSupportManifest } from "../../../scripts/support-manifest-parser.js";
import {
  accountLivePtyHost,
  LIVE_PTY_SUITE_GROUPS,
  type LivePtySuiteGroup,
  loadLivePtyPolicyForHost,
} from "./live-pty-accounting.js";
import type { LivePtyHostResult } from "./live-pty-host.js";

const SUPPORT_MANIFEST_URL = new URL("../../../support.yml", import.meta.url);

function realManifest(): unknown {
  return parseSupportManifest(readFileSync(SUPPORT_MANIFEST_URL, "utf8"));
}

// Fail closed: an unsupported host platform is a test error, not a silent pass.
function expectedPlatformForHost(): LivePtyPlatform {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      throw new Error(`unsupported test platform: ${JSON.stringify(process.platform)}`);
  }
}

// Synthetic policies (independent of the manifest) for the pure decision table.
const EXERCISED: LivePtyPlatformPolicy = {
  platform: "linux",
  disposition: "exercised",
  permittedReasonCode: null,
};
const CAPABILITY_GATED: LivePtyPlatformPolicy = {
  platform: "macos",
  disposition: "capability_gated",
  permittedReasonCode: "pty_allocation_unavailable",
};
const NOT_APPLICABLE: LivePtyPlatformPolicy = {
  platform: "windows",
  disposition: "not_applicable",
  permittedReasonCode: "requires_posix_bash",
};

const ALL_REASON_CODES: readonly LivePtyReasonCode[] = [
  "pty_allocation_unavailable",
  "requires_posix_bash",
  "node_pty_unavailable",
  "bash_unavailable",
];

interface DecisionCase {
  readonly name: string;
  readonly policy: LivePtyPlatformPolicy;
  readonly outcome: LivePtyHostOutcome;
  readonly expected: "run" | "skip" | "violation";
}

const DECISION_CASES: DecisionCase[] = [
  // exercised: a capable host runs; ANY unavailable outcome is a violation.
  { name: "exercised + capable -> run", policy: EXERCISED, outcome: { ok: true }, expected: "run" },
  ...ALL_REASON_CODES.map(
    (reasonCode): DecisionCase => ({
      name: `exercised + ${reasonCode} -> violation`,
      policy: EXERCISED,
      outcome: { ok: false, reasonCode },
      expected: "violation",
    }),
  ),
  // capability_gated: capable runs; the permitted code skips; every other code violates.
  {
    name: "capability_gated + capable -> run",
    policy: CAPABILITY_GATED,
    outcome: { ok: true },
    expected: "run",
  },
  {
    name: "capability_gated + pty_allocation_unavailable -> skip",
    policy: CAPABILITY_GATED,
    outcome: { ok: false, reasonCode: "pty_allocation_unavailable" },
    expected: "skip",
  },
  ...ALL_REASON_CODES.filter((c) => c !== "pty_allocation_unavailable").map(
    (reasonCode): DecisionCase => ({
      name: `capability_gated + ${reasonCode} -> violation`,
      policy: CAPABILITY_GATED,
      outcome: { ok: false, reasonCode },
      expected: "violation",
    }),
  ),
  // not_applicable: a capable host is a violation; the permitted code skips; others violate.
  {
    name: "not_applicable + capable -> violation",
    policy: NOT_APPLICABLE,
    outcome: { ok: true },
    expected: "violation",
  },
  {
    name: "not_applicable + requires_posix_bash -> skip",
    policy: NOT_APPLICABLE,
    outcome: { ok: false, reasonCode: "requires_posix_bash" },
    expected: "skip",
  },
  ...ALL_REASON_CODES.filter((c) => c !== "requires_posix_bash").map(
    (reasonCode): DecisionCase => ({
      name: `not_applicable + ${reasonCode} -> violation`,
      policy: NOT_APPLICABLE,
      outcome: { ok: false, reasonCode },
      expected: "violation",
    }),
  ),
];

describe("decideLivePtyAccounting", () => {
  it.each(DECISION_CASES)("$name", ({ policy, outcome, expected }) => {
    const verdict = decideLivePtyAccounting(policy, outcome);
    expect(verdict.action).toBe(expected);
    if (verdict.action === "skip") {
      // A permitted skip reports the (permitted) reason code that triggered it.
      expect(verdict.reasonCode).toBe(policy.permittedReasonCode);
    }
  });

  it("treats a macOS node-pty absence as a violation, not a permitted skip", () => {
    const verdict = decideLivePtyAccounting(CAPABILITY_GATED, {
      ok: false,
      reasonCode: "node_pty_unavailable",
    });
    expect(verdict.action).toBe("violation");
  });
});

describe("readLivePtyPlatformPolicy (real support.yml)", () => {
  const EXPECTED: ReadonlyArray<[LivePtyPlatform, LivePtyPlatformPolicy]> = [
    ["linux", { platform: "linux", disposition: "exercised", permittedReasonCode: null }],
    [
      "macos",
      {
        platform: "macos",
        disposition: "capability_gated",
        permittedReasonCode: "pty_allocation_unavailable",
      },
    ],
    [
      "windows",
      {
        platform: "windows",
        disposition: "not_applicable",
        permittedReasonCode: "requires_posix_bash",
      },
    ],
  ];

  it.each(EXPECTED)("resolves the %s policy", (platform, expected) => {
    expect(readLivePtyPlatformPolicy(realManifest(), platform)).toEqual(expected);
  });

  it("rejects a reason_code that is not declared in reason_codes", () => {
    // biome-ignore lint/suspicious/noExplicitAny: mutating a nested manifest field for a negative fixture
    const manifest = structuredClone(realManifest()) as any;
    // node_pty_unavailable is a valid RUNTIME code but is NOT a registered manifest reason_code.
    manifest.features.live_pty_interception.platforms.macos.reason_code = "node_pty_unavailable";
    expect(() => readLivePtyPlatformPolicy(manifest, "macos")).toThrow();
  });

  it("rejects an exercised platform that declares a reason_code", () => {
    // biome-ignore lint/suspicious/noExplicitAny: mutating a nested manifest field for a negative fixture
    const manifest = structuredClone(realManifest()) as any;
    manifest.features.live_pty_interception.platforms.linux.reason_code =
      "pty_allocation_unavailable";
    expect(() => readLivePtyPlatformPolicy(manifest, "linux")).toThrow();
  });

  it("binds loadLivePtyPolicyForHost to the running platform", () => {
    expect(loadLivePtyPolicyForHost()).toEqual(
      readLivePtyPlatformPolicy(realManifest(), expectedPlatformForHost()),
    );
  });
});

describe("accountLivePtyHost guards", () => {
  const ctx = {
    skip: () => {
      throw new Error("unexpected skip");
    },
  } as unknown as TestContext;

  const host = {
    ok: true,
    pty: {},
    bashPath: "/bin/bash",
  } as unknown as LivePtyHostResult;

  it("rejects an unknown suite group", () => {
    expect(() =>
      accountLivePtyHost(
        { ctx, group: "unknown-live-suite" as LivePtySuiteGroup, label: "case" },
        host,
      ),
    ).toThrow(/unknown live-PTY suite group/);
  });

  it("rejects a blank evidence label", () => {
    expect(() =>
      accountLivePtyHost({ ctx, group: "pty-interception-hook-live", label: "   " }, host),
    ).toThrow(/label must be non-blank/);
  });
});

describe("LIVE_PTY_SUITE_GROUPS registry", () => {
  it("is locked to exactly the three live-PTY suite groups", () => {
    expect([...LIVE_PTY_SUITE_GROUPS]).toEqual([
      "shell-pty-live-smoke",
      "pty-interception-compound-live",
      "pty-interception-hook-live",
    ]);
  });

  it.each([...LIVE_PTY_SUITE_GROUPS])("has an on-disk suite file for %s", (group) => {
    expect(existsSync(new URL(`./${group}.test.ts`, import.meta.url))).toBe(true);
  });
});
