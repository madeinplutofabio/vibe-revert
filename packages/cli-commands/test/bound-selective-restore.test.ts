// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Construction guarantees of the selective-restore transaction root.
//
// Five sections:
//   A. mode independence                    (1-2)
//   B. identity and canonical authorization (3-5)
//   C. report provenance                    (6-11)
//   D. failures stay failures               (12)
//   E. resolution passthrough               (13)
//
// Selector ALGEBRA is proven in selection-resolver.test.ts; nothing here
// re-tests it. Every case targets something only the composer can guarantee:
// what it requires, what it verifies, and what it refuses to trust.
//
// Fixtures are deliberately minimal. Entries carry ABSENT before/after states,
// so stage A classifies them `already_at_before` and the planner returns a
// `noop` plan. The composer returns `resolved` for any plan outcome, and
// `selectedChangeGroupIds` is computed before the planner branches, so no case
// needs a repository with restorable content.
//
// The report fixture is fuller than selection-resolver.test.ts's, deliberately.
// That suite hands reports straight to the pure resolver, so its fixtures never
// parse; ours pass through `ReportFileSchema`, which enforces `affected_paths`
// being a subset of `changed_files[].path` AND enforces `finding_id` equalling
// its normative derivation. Every id here is therefore DERIVED from the same
// inputs the schema re-derives from: a hand-written `fnd_<64 hex>` is not
// merely unrealistic, it is rejected.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ContributionDigestMismatchError, type SessionContributionBinding } from "@viberevert/core";
import {
  CONTRIBUTION_FILE_SCHEMA_VERSION,
  deriveChangeGroupId,
  deriveFindingId,
  type PathState,
  REPORT_FILE_SCHEMA_VERSION,
  type ReportFile,
  SCHEMA_VERSION,
  type SessionContributionEntry,
  type SessionContributionFile,
  type SessionReport,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { prepareBoundSelectiveRestore } from "../src/bound-selective-restore.js";
import { resolveSelection, type SelectionSelectors } from "../src/selection-resolver.js";

const execFileAsync = promisify(execFile);

const SESSION_ID = "sess_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const CHECKPOINT_ID = "cp_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const ENDED_AT = "2026-05-04T11:00:00Z";
const CONTRIBUTION_REL = ".viberevert/sessions/contribution.json";
const OTHER_SHA = "9".repeat(64);
const RISKY_PATH = "src/a.ts";
/** The finding's `CheckResult.id`, which is an input to its derived identity. */
const RULE_ID = "secrets.regex";

const ABSENT: PathState = { worktree: { kind: "absent" }, index: { kind: "absent" } };

const NO_SELECTORS: SelectionSelectors = { only: [], except: [], finding: [] };
const ONLY_SRC: SelectionSelectors = { only: ["src/**"], except: [], finding: [] };
const RISK_HIGH: SelectionSelectors = { only: [], except: [], finding: [], risk: "high" };

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

function makeEntry(path: string): SessionContributionEntry {
  return {
    path,
    operation: "modified",
    facets: [],
    change_group_id: deriveChangeGroupId(SESSION_ID, [path]),
    before: ABSENT,
    after: ABSENT,
    content_delta: { kind: "none" },
  };
}

/** Two groups, in the schema's canonical path-sorted entry order. */
const CONTRIBUTION: SessionContributionFile = {
  schema_version: CONTRIBUTION_FILE_SCHEMA_VERSION,
  session_id: SESSION_ID,
  checkpoint_id: CHECKPOINT_ID,
  before_head_sha: "0".repeat(40),
  after_head_sha: "1".repeat(40),
  captured_at: "2026-05-04T10:30:11Z",
  ended_at: ENDED_AT,
  entries: [makeEntry("docs/readme.md"), makeEntry(RISKY_PATH)],
};

/** The group `--risk` selection must land on. */
const SRC_GROUP = deriveChangeGroupId(SESSION_ID, [RISKY_PATH]);

interface Fixture {
  readonly repoRoot: string;
  readonly binding: SessionContributionBinding;
  readonly cleanup: () => Promise<void>;
}

/**
 * A real repository plus a contribution written to disk, with the binding
 * derived from the EXACT bytes written. The digest is computed rather than
 * declared, so the fixture cannot drift from the artifact.
 */
async function setup(corruptDigest = false): Promise<Fixture> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-boundfixture-"));
  const repoRoot = join(tmp, "repo");
  await mkdir(join(repoRoot, ".viberevert", "sessions"), { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);

  const bytes = Buffer.from(JSON.stringify(CONTRIBUTION, null, 2), "utf8");
  await writeFile(join(repoRoot, ...CONTRIBUTION_REL.split("/")), bytes);

  return {
    repoRoot,
    binding: {
      path: CONTRIBUTION_REL,
      sha256: corruptDigest ? OTHER_SHA : createHash("sha256").update(bytes).digest("hex"),
      expected: { sessionId: SESSION_ID, checkpointId: CHECKPOINT_ID, endedAt: ENDED_AT },
    },
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

/**
 * A schema-VALID session report.
 *
 * `changed_files` must contain the finding's affected path: `SessionReportSchema`
 * refines `affected_paths` to be a subset of it, and unlike the resolver suite's
 * fixtures this one really is parsed.
 *
 * `finding_id` is DERIVED through the exported contract rather than written by
 * hand, because the same schema re-derives it from `(session_id, id,
 * affected_paths)` and rejects any mismatch. Deriving it also keeps the fixture
 * correct if any of those three inputs is edited later.
 */
const innerReport = (): SessionReport => ({
  schema_version: SCHEMA_VERSION,
  session_id: SESSION_ID,
  started_at: "2026-05-04T10:30:11Z",
  detected_frameworks: [],
  risk_level: "high",
  changed_files: [{ path: RISKY_PATH, status: "modified", risk_tags: [], risk_level: "high" }],
  results: [
    {
      id: RULE_ID,
      finding_id: deriveFindingId(SESSION_ID, RULE_ID, [RISKY_PATH]),
      title: "finding",
      level: "high",
      confidence: "high",
      category: "secrets",
      message: "message",
      evidence: [{ detail: "detail" }],
      affected_paths: [RISKY_PATH],
      recommendation: "do the thing",
    },
  ],
  rollback_available: true,
});

/**
 * A session-bound ReportFile wrapper; `digest` controls its provenance.
 *
 * `staged_only` is deliberately absent: it is optional, and the schema refines
 * `staged_only === true` to require `kind: "ad_hoc"`, so setting it here would
 * make the fixture invalid rather than more complete.
 */
const reportFile = (digest?: string): ReportFile => ({
  schema_version: REPORT_FILE_SCHEMA_VERSION,
  kind: "session_bound",
  report_id: SESSION_ID,
  since_kind: "session_id",
  since_ref: SESSION_ID,
  since_resolved_sha: "2".repeat(40),
  ...(digest !== undefined ? { source_contribution_sha256: digest } : {}),
  written_at: "2026-05-04T11:05:00Z",
  report: innerReport(),
});

// =============================================================================
// Section A: mode independence
// =============================================================================

describe("prepareBoundSelectiveRestore: mode", () => {
  it("1: no selectors means full mode WITHOUT any contribution binding", async () => {
    // The legacy path must stay reachable for a session that has no
    // contribution at all. A required binding would make this uncallable.
    const result = await prepareBoundSelectiveRestore({
      repoRoot: join(tmpdir(), "viberevert-bound-unused-repo"),
      selectors: NO_SELECTORS,
    });
    expect(result).toEqual({ mode: "full" });
  });

  it("2: selective selectors without a binding reuse the resolver's refusal", async () => {
    const result = await prepareBoundSelectiveRestore({
      repoRoot: join(tmpdir(), "viberevert-bound-unused-repo"),
      selectors: ONLY_SRC,
    });
    // Step 9's own code, not a composer-invented equivalent.
    expect(result).toEqual({
      mode: "selective",
      outcome: "invalid",
      reason: { code: "CONTRIBUTION_REQUIRED" },
    });
  });
});

// =============================================================================
// Section B: identity and canonical authorization
// =============================================================================

describe("prepareBoundSelectiveRestore: the bound object", () => {
  it("3: carries the verified transaction identity", async () => {
    const fx = await setup();
    try {
      const result = await prepareBoundSelectiveRestore({
        repoRoot: fx.repoRoot,
        contributionBinding: fx.binding,
        selectors: ONLY_SRC,
      });
      if (result.mode !== "selective" || result.outcome !== "resolved") {
        throw new Error(`expected resolved, got ${JSON.stringify(result)}`);
      }

      // These equal the binding's expectations by construction, since
      // `loadVerifiedSessionContribution` refuses otherwise. So this asserts the
      // identity is correct and bound, not which equal expression was read. That
      // it is DERIVED is enforced by the API having no such parameters.
      expect(result.bound.sessionId).toBe(SESSION_ID);
      expect(result.bound.checkpointId).toBe(CHECKPOINT_ID);
      expect(result.bound.contributionSha256).toBe(fx.binding.sha256);
      expect(result.bound.contribution.session_id).toBe(SESSION_ID);
    } finally {
      await fx.cleanup();
    }
  });

  it("4: retains the selectors resolution discards", async () => {
    const fx = await setup();
    try {
      const result = await prepareBoundSelectiveRestore({
        repoRoot: fx.repoRoot,
        contributionBinding: fx.binding,
        selectors: ONLY_SRC,
      });
      if (result.mode !== "selective" || result.outcome !== "resolved") {
        throw new Error("expected resolved");
      }
      // `SelectionResolution` carries only group ids; the receipt needs intent.
      expect(result.bound.selectors).toEqual(ONLY_SRC);
    } finally {
      await fx.cleanup();
    }
  });

  it("5: the plan holds the sole canonical authorization, preserving the set", async () => {
    const fx = await setup();
    try {
      const result = await prepareBoundSelectiveRestore({
        repoRoot: fx.repoRoot,
        contributionBinding: fx.binding,
        selectors: ONLY_SRC,
      });
      if (result.mode !== "selective" || result.outcome !== "resolved") {
        throw new Error("expected resolved");
      }
      const groups = result.bound.plan.selectedChangeGroupIds;

      expect([...groups]).toEqual([...groups].sort());
      expect(new Set(groups).size).toBe(groups.length);

      // Independently derived rather than read back from the same object: the
      // resolver's authorization must survive canonicalization exactly.
      const independent = resolveSelection({
        contribution: CONTRIBUTION,
        selectors: ONLY_SRC,
      });
      if (independent.mode !== "selective" || independent.outcome !== "resolved") {
        throw new Error("fixture: expected the selectors to resolve");
      }
      expect(new Set(groups)).toEqual(new Set(independent.changeGroupIds));

      // The noncanonical array must not survive anywhere on the bound object.
      expect(Object.keys(result.bound)).not.toContain("resolvedChangeGroupIds");
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section C: report provenance
// =============================================================================

describe("prepareBoundSelectiveRestore: report provenance", () => {
  const staleCases: readonly [string, unknown][] = [
    ["no report at all", undefined],
    ["a valid report with no source digest", reportFile()],
    ["a report bound to another contribution", reportFile(OTHER_SHA)],
  ];

  for (const [label, report] of staleCases) {
    it(`6-8: ${label} is STALE_OR_MISSING_REPORT`, async () => {
      const fx = await setup();
      try {
        const result = await prepareBoundSelectiveRestore({
          repoRoot: fx.repoRoot,
          contributionBinding: fx.binding,
          selectors: RISK_HIGH,
          ...(report !== undefined ? { report } : {}),
        });
        if (result.mode !== "selective" || result.outcome !== "invalid") {
          throw new Error(`expected invalid, got ${JSON.stringify(result)}`);
        }
        expect(result.reason.code).toBe("STALE_OR_MISSING_REPORT");
      } finally {
        await fx.cleanup();
      }
    });
  }

  it("9: a report bound to THIS contribution is consulted", async () => {
    const fx = await setup();
    try {
      const result = await prepareBoundSelectiveRestore({
        repoRoot: fx.repoRoot,
        contributionBinding: fx.binding,
        selectors: RISK_HIGH,
        report: reportFile(fx.binding.sha256),
      });
      if (result.mode !== "selective" || result.outcome !== "resolved") {
        throw new Error(`expected resolved, got ${JSON.stringify(result)}`);
      }
      // The finding's affected path belongs to the src group, so risk selection
      // genuinely consumed the report's evidence.
      expect(result.bound.plan.selectedChangeGroupIds).toEqual([SRC_GROUP]);
    } finally {
      await fx.cleanup();
    }
  });

  it("10: a CONSULTED malformed report throws rather than refusing", async () => {
    const fx = await setup();
    try {
      // A malformed artifact and a valid-but-unbound artifact are different
      // facts; only the second is a selector refusal.
      await expect(
        prepareBoundSelectiveRestore({
          repoRoot: fx.repoRoot,
          contributionBinding: fx.binding,
          selectors: RISK_HIGH,
          report: { not: "a report" },
        }),
      ).rejects.toThrow();
    } finally {
      await fx.cleanup();
    }
  });

  it("11: an UNCONSULTED garbage report is never parsed and cannot block", async () => {
    const fx = await setup();
    try {
      // `--only` consults no report, so provenance must not bind and the
      // artifact must never reach the schema. This fails the moment anyone
      // parses unconditionally.
      const result = await prepareBoundSelectiveRestore({
        repoRoot: fx.repoRoot,
        contributionBinding: fx.binding,
        selectors: ONLY_SRC,
        report: { not: "a report" },
      });
      if (result.mode !== "selective") throw new Error("expected selective");
      expect(result.outcome).toBe("resolved");
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section D: failures stay failures
// =============================================================================

describe("prepareBoundSelectiveRestore: evidence integrity", () => {
  it("12: a contribution whose bytes betray its digest throws that exact error", async () => {
    const fx = await setup(true);
    try {
      // Evidence-integrity failure must never collapse into selection
      // semantics, exactly as a malformed report does not. Asserted by CLASS so
      // an unrelated exception cannot satisfy the case.
      await expect(
        prepareBoundSelectiveRestore({
          repoRoot: fx.repoRoot,
          contributionBinding: fx.binding,
          selectors: ONLY_SRC,
        }),
      ).rejects.toBeInstanceOf(ContributionDigestMismatchError);
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section E: resolution passthrough
// =============================================================================

describe("prepareBoundSelectiveRestore: passthrough", () => {
  it("13: selectors matching nothing are empty, not an error", async () => {
    const fx = await setup();
    try {
      const result = await prepareBoundSelectiveRestore({
        repoRoot: fx.repoRoot,
        contributionBinding: fx.binding,
        selectors: { only: ["nothing/matches/**"], except: [], finding: [] },
      });
      expect(result).toEqual({ mode: "selective", outcome: "empty" });
    } finally {
      await fx.cleanup();
    }
  });
});
