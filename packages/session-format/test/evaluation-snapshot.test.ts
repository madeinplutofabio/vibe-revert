// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M 0.8.0 step 0 -- the session-start evaluation snapshot.
//
// This artifact is a safety boundary, not a convenience cache: `.viberevert.yml`
// is a file the agent can rewrite during its own session, so session-bound
// evaluation and selective rollback read the snapshot instead of live config.
// The tests below pin the shape that makes that substitution trustworthy.
//
// Every negative case here is otherwise-valid, so that only the rule under test
// can cause the failure. A rejection test that would also fail for a missing
// required field proves nothing about the rule it names.

import { describe, expect, it } from "vitest";

import {
  EvaluationSnapshotSchema,
  type ResolvedChecks,
  ResolvedChecksSchema,
  SESSION_STATE_SCHEMA_VERSION,
  SessionStateSchema,
  SnapshotFrameworksSchema,
  VerifyCommandSchema,
} from "../src/index.js";

// =============================================================================
// Fixtures
// =============================================================================

const ALL_CHECKS: ResolvedChecks = {
  secrets: true,
  dependencies: true,
  migrations: true,
  auth: true,
  payments: false,
  infra: true,
  tests: true,
  scope_expansion: true,
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    risk_block_on: "critical",
    risk_warn_on: "medium",
    checks: ALL_CHECKS,
    frameworks: { mode: "auto", detected_at_start: ["nextjs"] },
    rollback_exclude: ["dist/**", "node_modules/**"],
    verify_commands: [{ command: "npm", args: ["test"] }],
    ...overrides,
  };
}

// =============================================================================
// Resolved checks
// =============================================================================

describe("ResolvedChecksSchema", () => {
  it("accepts the full resolved toggle set", () => {
    expect(ResolvedChecksSchema.safeParse(ALL_CHECKS).success).toBe(true);
  });

  it("requires every toggle, because this is the RESOLVED view", () => {
    // A sparse snapshot would reintroduce the ambiguity resolution removes: a
    // reader could not tell "explicitly disabled" from "not mentioned".
    const { payments, ...missing } = ALL_CHECKS;
    expect(ResolvedChecksSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects an unknown toggle name", () => {
    expect(ResolvedChecksSchema.safeParse({ ...ALL_CHECKS, licenses: true }).success).toBe(false);
  });

  it("rejects a non-boolean toggle", () => {
    expect(ResolvedChecksSchema.safeParse({ ...ALL_CHECKS, secrets: "on" }).success).toBe(false);
  });
});

// =============================================================================
// Frameworks
// =============================================================================

describe("SnapshotFrameworksSchema", () => {
  it("accepts an explicit non-empty list", () => {
    expect(
      SnapshotFrameworksSchema.safeParse({ mode: "explicit", values: ["laravel", "nextjs"] })
        .success,
    ).toBe(true);
  });

  it("rejects an explicit EMPTY list", () => {
    // `mergeChecksConfig` treats an omitted or empty `frameworks` as
    // auto-detect, so an empty explicit set describes a resolution that cannot
    // occur. Recording it would misrepresent what actually ran.
    expect(SnapshotFrameworksSchema.safeParse({ mode: "explicit", values: [] }).success).toBe(
      false,
    );
  });

  it("rejects an unsorted explicit list", () => {
    expect(
      SnapshotFrameworksSchema.safeParse({ mode: "explicit", values: ["nextjs", "laravel"] })
        .success,
    ).toBe(false);
  });

  it("accepts auto mode with an empty detection", () => {
    // Detecting no frameworks is a legitimate outcome, unlike an empty explicit
    // list.
    expect(
      SnapshotFrameworksSchema.safeParse({ mode: "auto", detected_at_start: [] }).success,
    ).toBe(true);
  });

  it("accepts auto mode with detections", () => {
    expect(
      SnapshotFrameworksSchema.safeParse({ mode: "auto", detected_at_start: ["laravel"] }).success,
    ).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(SnapshotFrameworksSchema.safeParse({ mode: "inferred", values: ["x"] }).success).toBe(
      false,
    );
  });

  it("rejects mixing the two modes' fields", () => {
    // The auto branch is otherwise COMPLETE here, so the only possible cause of
    // failure is the foreign `values` field. Omitting `detected_at_start` would
    // make this test pass for the wrong reason and let the strict-branch
    // invariant regress unnoticed.
    expect(
      SnapshotFrameworksSchema.safeParse({
        mode: "auto",
        detected_at_start: [],
        values: ["laravel"],
      }).success,
    ).toBe(false);
  });
});

// =============================================================================
// Verify commands
// =============================================================================

describe("VerifyCommandSchema", () => {
  it("accepts structured argv", () => {
    expect(
      VerifyCommandSchema.safeParse({ command: "npm", args: ["run", "typecheck"] }).success,
    ).toBe(true);
  });

  it("requires args, but allows it to be empty", () => {
    expect(VerifyCommandSchema.safeParse({ command: "make" }).success).toBe(false);
    expect(VerifyCommandSchema.safeParse({ command: "make", args: [] }).success).toBe(true);
  });

  it("allows an empty-string argument", () => {
    // `--flag=` is a legitimate argument; args are not nonBlankString.
    expect(VerifyCommandSchema.safeParse({ command: "tool", args: ["--flag="] }).success).toBe(
      true,
    );
    expect(VerifyCommandSchema.safeParse({ command: "tool", args: [""] }).success).toBe(true);
  });

  it("rejects a blank command", () => {
    expect(VerifyCommandSchema.safeParse({ command: "   ", args: [] }).success).toBe(false);
  });

  it("rejects a bare command string instead of structured argv", () => {
    // The whole point of the object form: with no shell, "npm test" is not an
    // executable and something would have to tokenize it.
    expect(VerifyCommandSchema.safeParse("npm test").success).toBe(false);
  });
});

// =============================================================================
// Sequence versus set -- the asymmetry, tested as a pair
// =============================================================================

describe("verify_commands is a sequence; rollback_exclude is a set", () => {
  it("preserves verify_commands order rather than sorting it", () => {
    const ordered = snapshot({
      verify_commands: [
        { command: "npm", args: ["run", "typecheck"] },
        { command: "npm", args: ["test"] },
        { command: "npm", args: ["run", "build"] },
      ],
    });
    const parsed = EvaluationSnapshotSchema.parse(ordered);
    expect(parsed.verify_commands.map((c) => c.args.join(" "))).toEqual([
      "run typecheck",
      "test",
      "run build",
    ]);
  });

  it("accepts verify_commands in non-alphabetical order", () => {
    // Sorting them would silently change execution behavior.
    expect(
      EvaluationSnapshotSchema.safeParse(
        snapshot({
          verify_commands: [
            { command: "zzz", args: [] },
            { command: "aaa", args: [] },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts a duplicated verify command", () => {
    // Running the same command twice is unusual but legitimate.
    expect(
      EvaluationSnapshotSchema.safeParse(
        snapshot({
          verify_commands: [
            { command: "npm", args: ["test"] },
            { command: "npm", args: ["test"] },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts an empty verify_commands", () => {
    expect(EvaluationSnapshotSchema.safeParse(snapshot({ verify_commands: [] })).success).toBe(
      true,
    );
  });

  it("rejects an UNSORTED rollback_exclude", () => {
    // Unordered deny-list per D3, so it is canonical, unlike the command list.
    expect(
      EvaluationSnapshotSchema.safeParse(
        snapshot({ rollback_exclude: ["node_modules/**", "dist/**"] }),
      ).success,
    ).toBe(false);
  });

  it("rejects a DUPLICATED rollback_exclude entry", () => {
    expect(
      EvaluationSnapshotSchema.safeParse(snapshot({ rollback_exclude: ["dist/**", "dist/**"] }))
        .success,
    ).toBe(false);
  });
});

// =============================================================================
// The snapshot as a whole
// =============================================================================

describe("EvaluationSnapshotSchema", () => {
  it("accepts a complete snapshot", () => {
    expect(EvaluationSnapshotSchema.safeParse(snapshot()).success).toBe(true);
  });

  it.each([
    "risk_block_on",
    "risk_warn_on",
    "checks",
    "frameworks",
    "rollback_exclude",
    "verify_commands",
  ])("requires %s", (field) => {
    const partial: Record<string, unknown> = snapshot();
    delete partial[field];
    expect(EvaluationSnapshotSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      EvaluationSnapshotSchema.safeParse(snapshot({ config_digest: "a".repeat(64) })).success,
    ).toBe(false);
  });

  it("rejects an invalid risk level", () => {
    expect(EvaluationSnapshotSchema.safeParse(snapshot({ risk_block_on: "severe" })).success).toBe(
      false,
    );
  });
});

// =============================================================================
// Integration with SessionState
// =============================================================================

describe("SessionState carries the snapshot from session start", () => {
  const base = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    checkpoint_id: "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    started_at: "2026-01-01T00:00:00Z",
    before_status_path: ".viberevert/sessions/s/before-status.txt",
    commands_log_path: ".viberevert/sessions/s/commands.log",
  };

  it("accepts a snapshot on an IN-FLIGHT session", () => {
    // Written at `viberevert start`, so unlike the contribution it is
    // legitimately present before the session ends.
    expect(SessionStateSchema.safeParse({ ...base, evaluation_snapshot: snapshot() }).success).toBe(
      true,
    );
  });

  it("accepts a session with no snapshot at all", () => {
    // Pre-0.8.0 sessions have none, and stay valid.
    expect(SessionStateSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a malformed snapshot", () => {
    expect(
      SessionStateSchema.safeParse({
        ...base,
        evaluation_snapshot: snapshot({ checks: { secrets: true } }),
      }).success,
    ).toBe(false);
  });
});
