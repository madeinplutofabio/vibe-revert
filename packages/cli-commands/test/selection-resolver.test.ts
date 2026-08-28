// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for the selective-rollback selection algebra (M 0.8.0 step 9).
//
// Pure in, pure out: no filesystem, no git, no schema parsing. `resolveSelection`
// accepts already-loaded artifacts, so fixtures are typed literals.
//
// Change-group ids ARE really derived, via `deriveChangeGroupId`, because the
// id is a function of the group's complete alias set and a hand-written one
// would describe a group that could not exist.
//
// Finding ids are NOT derived. `deriveFindingId` produces SHA-256 values, and
// prefix ambiguity requires two ids that share a leading substring, which no
// derivation will yield on demand. The resolver treats `finding_id` as an
// opaque key -- derivation is `SessionReportSchema`'s concern and is tested in
// session-format -- so constructing ids here exercises exactly the relation
// under test and nothing else.
//
// Six groups, 24 tests:
//   1. Mode dispatch (full vs selective, missing contribution)      3 tests
//   2. Alias relation (--only / --except)                           3 tests
//   3. --finding resolution and refusals                            6 tests
//   4. --risk threshold and group risk                              4 tests
//   5. Report requirement                                           2 tests
//   6. Algebra (intersection, subtraction, unions, empty)           6 tests

import type {
  CheckResult,
  PathState,
  RiskLevel,
  SessionContributionEntry,
  SessionContributionFile,
  SessionReport,
} from "@viberevert/session-format";
import {
  CONTRIBUTION_FILE_SCHEMA_VERSION,
  deriveChangeGroupId,
  SCHEMA_VERSION,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import {
  resolveSelection,
  type SelectionResolution,
  type SelectionSelectors,
} from "../src/selection-resolver.js";

// =============================================================================
// Fixtures
// =============================================================================

const SESSION_ID = "sess_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const CHECKPOINT_ID = "cp_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const ABSENT: PathState = { worktree: { kind: "absent" }, index: { kind: "absent" } };

const FND_A = `fnd_${"a".repeat(64)}`;
const FND_B = `fnd_${"b".repeat(64)}`;
// Share the prefix "fnd_cc"; diverge at the third hex character.
const FND_C1 = `fnd_cc1${"0".repeat(61)}`;
const FND_C2 = `fnd_cc2${"0".repeat(61)}`;

/**
 * One contribution entry.
 *
 * `groupAliases` defaults to this entry's own alias set. Pass it explicitly
 * when several entries share a group, since the id derives from the group's
 * COMPLETE alias set -- deriving from one member's aliases would produce an id
 * the schema's group-integrity refine rejects.
 */
function makeEntry(
  path: string,
  opts: { previousPath?: string; groupAliases?: readonly string[] } = {},
): SessionContributionEntry {
  const ownAliases = opts.previousPath !== undefined ? [path, opts.previousPath] : [path];
  return {
    path,
    ...(opts.previousPath !== undefined ? { previous_path: opts.previousPath } : {}),
    operation: opts.previousPath !== undefined ? "renamed" : "modified",
    facets: [],
    change_group_id: deriveChangeGroupId(SESSION_ID, opts.groupAliases ?? ownAliases),
    before: ABSENT,
    after: ABSENT,
    content_delta: { kind: "none" },
  };
}

/** Entries are sorted by path, matching the schema's canonical entry order. */
function makeContribution(entries: readonly SessionContributionEntry[]): SessionContributionFile {
  return {
    schema_version: CONTRIBUTION_FILE_SCHEMA_VERSION,
    session_id: SESSION_ID,
    checkpoint_id: CHECKPOINT_ID,
    before_head_sha: "0".repeat(40),
    after_head_sha: "1".repeat(40),
    captured_at: "2026-05-04T10:30:11Z",
    ended_at: "2026-05-04T11:00:00Z",
    entries: [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

function makeFinding(opts: {
  findingId: string;
  level: RiskLevel;
  affectedPaths: readonly string[];
  ruleId?: string;
}): CheckResult {
  return {
    id: opts.ruleId ?? "secrets.regex",
    finding_id: opts.findingId,
    title: "finding",
    level: opts.level,
    confidence: "high",
    category: "secrets",
    message: "message",
    evidence: [{ detail: "detail" }],
    affected_paths: [...opts.affectedPaths],
    recommendation: "do the thing",
  };
}

function makeReport(results: readonly CheckResult[]): SessionReport {
  return {
    schema_version: SCHEMA_VERSION,
    session_id: SESSION_ID,
    started_at: "2026-05-04T10:30:11Z",
    detected_frameworks: [],
    risk_level: "low",
    changed_files: [],
    results: [...results],
    rollback_available: true,
  };
}

function sel(overrides: Partial<SelectionSelectors> = {}): SelectionSelectors {
  return { only: [], except: [], finding: [], ...overrides };
}

/** Unwrap a resolved selective result, failing loudly with the actual shape. */
function resolvedIds(resolution: SelectionResolution): readonly string[] {
  if (resolution.mode !== "selective" || resolution.outcome !== "resolved") {
    throw new Error(`expected a resolved selective result, got ${JSON.stringify(resolution)}`);
  }
  return resolution.changeGroupIds;
}

// The standard world: four groups, one of them a rename out of payments/ and
// one of them holding two entries.
const ENTRY_A = makeEntry("src/a.ts");
const ENTRY_B = makeEntry("src/b.ts");
const ENTRY_RENAME = makeEntry("utils/webhook.ts", { previousPath: "payments/webhook.ts" });
const PKG_ALIASES = ["pkg/one.ts", "pkg/two.ts"] as const;
const ENTRY_PKG_ONE = makeEntry("pkg/one.ts", { groupAliases: PKG_ALIASES });
const ENTRY_PKG_TWO = makeEntry("pkg/two.ts", { groupAliases: PKG_ALIASES });

const GROUP_A = ENTRY_A.change_group_id;
const GROUP_B = ENTRY_B.change_group_id;
const GROUP_RENAME = ENTRY_RENAME.change_group_id;
const GROUP_PKG = ENTRY_PKG_ONE.change_group_id;

const WORLD = makeContribution([ENTRY_A, ENTRY_B, ENTRY_RENAME, ENTRY_PKG_ONE, ENTRY_PKG_TWO]);

// =============================================================================
// 1. Mode dispatch
// =============================================================================

describe("resolveSelection -- mode dispatch", () => {
  it("returns full mode with NO contribution when no selector is supplied", () => {
    // The structural point: discovering that full rollback applies must not
    // require loading selective-recovery evidence full rollback never uses.
    expect(resolveSelection({ selectors: sel() })).toEqual({ mode: "full" });
  });

  it("--except alone enters selective mode and starts from the whole universe", () => {
    const result = resolveSelection({
      contribution: WORLD,
      selectors: sel({ except: ["src/a.ts"] }),
    });
    // Everything except group A: --except alone is a selector, so this is
    // selective mode, not full.
    expect(new Set(resolvedIds(result))).toEqual(new Set([GROUP_B, GROUP_RENAME, GROUP_PKG]));
  });

  it("refuses with CONTRIBUTION_REQUIRED when a selector is supplied without one", () => {
    expect(resolveSelection({ selectors: sel({ only: ["**"] }) })).toEqual({
      mode: "selective",
      outcome: "invalid",
      reason: { code: "CONTRIBUTION_REQUIRED" },
    });
  });
});

// =============================================================================
// 2. Alias relation
// =============================================================================

describe("resolveSelection -- alias relation (--only / --except)", () => {
  it("--only matches a group through its previous_path alias", () => {
    // The file now lives at utils/webhook.ts, but it was renamed OUT of
    // payments/. Selecting payments/** must still reach it: this is exactly
    // where rename aliases belong.
    const result = resolveSelection({
      contribution: WORLD,
      selectors: sel({ only: ["payments/**"] }),
    });
    expect(resolvedIds(result)).toEqual([GROUP_RENAME]);
  });

  it("is group-atomic: matching one entry selects the whole multi-entry group", () => {
    const result = resolveSelection({
      contribution: WORLD,
      selectors: sel({ only: ["pkg/one.ts"] }),
    });
    // pkg/two.ts was never named, but it shares the group.
    expect(resolvedIds(result)).toEqual([GROUP_PKG]);
  });

  it("unions repeated --only patterns", () => {
    const result = resolveSelection({
      contribution: WORLD,
      selectors: sel({ only: ["src/a.ts", "src/b.ts"] }),
    });
    expect(new Set(resolvedIds(result))).toEqual(new Set([GROUP_A, GROUP_B]));
  });
});

// =============================================================================
// 3. --finding
// =============================================================================

describe("resolveSelection -- --finding", () => {
  const report = makeReport([
    makeFinding({ findingId: FND_A, level: "critical", affectedPaths: ["src/a.ts"] }),
    makeFinding({ findingId: FND_B, level: "low", affectedPaths: ["src/b.ts"] }),
  ]);

  it("resolves a full finding id to the group owning its affected path", () => {
    const result = resolveSelection({
      contribution: WORLD,
      report,
      selectors: sel({ finding: [FND_A] }),
    });
    expect(resolvedIds(result)).toEqual([GROUP_A]);
  });

  it("resolves an unambiguous prefix", () => {
    const result = resolveSelection({
      contribution: WORLD,
      report,
      selectors: sel({ finding: ["fnd_aaaa"] }),
    });
    expect(resolvedIds(result)).toEqual([GROUP_A]);
  });

  it("refuses an ambiguous prefix and reports every match", () => {
    const ambiguous = makeReport([
      makeFinding({ findingId: FND_C1, level: "low", affectedPaths: ["src/a.ts"] }),
      makeFinding({ findingId: FND_C2, level: "low", affectedPaths: ["src/b.ts"] }),
    ]);
    expect(
      resolveSelection({
        contribution: WORLD,
        report: ambiguous,
        selectors: sel({ finding: ["fnd_cc"] }),
      }),
    ).toEqual({
      mode: "selective",
      outcome: "invalid",
      reason: { code: "FINDING_PREFIX_AMBIGUOUS", selector: "fnd_cc", matches: [FND_C1, FND_C2] },
    });
  });

  it("refuses an unknown selector", () => {
    expect(
      resolveSelection({
        contribution: WORLD,
        report,
        selectors: sel({ finding: ["fnd_zzzz"] }),
      }),
    ).toEqual({
      mode: "selective",
      outcome: "invalid",
      reason: { code: "FINDING_NOT_FOUND", selector: "fnd_zzzz" },
    });
  });

  it("refuses an identified but PATHLESS finding", () => {
    // A real, advisory-only finding: it names no changed-file identity, so
    // there is nothing to restore. Refusing beats silently selecting nothing
    // for something the user explicitly asked for.
    const pathless = makeReport([
      makeFinding({ findingId: FND_A, level: "low", affectedPaths: [] }),
    ]);
    expect(
      resolveSelection({
        contribution: WORLD,
        report: pathless,
        selectors: sel({ finding: [FND_A] }),
      }),
    ).toEqual({
      mode: "selective",
      outcome: "invalid",
      reason: { code: "FINDING_HAS_NO_RESTORABLE_PATH", findingId: FND_A },
    });
  });

  it("invalidates the WHOLE resolution when one of several selectors is bad", () => {
    // Dropping the bad member would make `--finding typo` indistinguishable
    // from a finding that legitimately selects nothing.
    expect(
      resolveSelection({
        contribution: WORLD,
        report,
        selectors: sel({ finding: [FND_A, "fnd_zzzz"] }),
      }),
    ).toEqual({
      mode: "selective",
      outcome: "invalid",
      reason: { code: "FINDING_NOT_FOUND", selector: "fnd_zzzz" },
    });
  });
});

// =============================================================================
// 4. --risk
// =============================================================================

describe("resolveSelection -- --risk", () => {
  it("selects at-or-above the threshold, not exact matches", () => {
    const report = makeReport([
      makeFinding({ findingId: FND_A, level: "critical", affectedPaths: ["src/a.ts"] }),
      makeFinding({ findingId: FND_B, level: "high", affectedPaths: ["src/b.ts"] }),
      makeFinding({
        findingId: FND_C1,
        level: "medium",
        affectedPaths: ["utils/webhook.ts"],
      }),
    ]);
    const result = resolveSelection({
      contribution: WORLD,
      report,
      selectors: sel({ risk: "high" }),
    });
    // high AND critical; medium excluded.
    expect(new Set(resolvedIds(result))).toEqual(new Set([GROUP_A, GROUP_B]));
  });

  it("does NOT select a group no finding touches, even at --risk low", () => {
    // A group with no finding has NO risk, not "low". Otherwise the weakest
    // threshold would silently become equivalent to --only '**'.
    const report = makeReport([
      makeFinding({ findingId: FND_A, level: "low", affectedPaths: ["src/a.ts"] }),
    ]);
    const result = resolveSelection({
      contribution: WORLD,
      report,
      selectors: sel({ risk: "low" }),
    });
    expect(resolvedIds(result)).toEqual([GROUP_A]);
  });

  it("takes the MAX level over every finding touching the group", () => {
    // Adversarial order: neither first-wins nor last-wins produces critical.
    const report = makeReport([
      makeFinding({ findingId: FND_A, level: "high", affectedPaths: ["src/a.ts"] }),
      makeFinding({ findingId: FND_B, level: "low", affectedPaths: ["src/a.ts"] }),
      makeFinding({ findingId: FND_C1, level: "critical", affectedPaths: ["src/a.ts"] }),
      makeFinding({ findingId: FND_C2, level: "medium", affectedPaths: ["src/a.ts"] }),
    ]);
    const result = resolveSelection({
      contribution: WORLD,
      report,
      selectors: sel({ risk: "critical" }),
    });
    expect(resolvedIds(result)).toEqual([GROUP_A]);
  });

  it("reaches a rename group through its CURRENT path, needing no alias help", () => {
    // The finding records the NEW path, because that is the identity a
    // contribution group is addressed by. No alias lookup is involved.
    const report = makeReport([
      makeFinding({
        findingId: FND_A,
        level: "critical",
        affectedPaths: ["utils/webhook.ts"],
      }),
    ]);
    const result = resolveSelection({
      contribution: WORLD,
      report,
      selectors: sel({ risk: "critical" }),
    });
    expect(resolvedIds(result)).toEqual([GROUP_RENAME]);
  });
});

// =============================================================================
// 5. Report requirement
// =============================================================================

describe("resolveSelection -- report requirement", () => {
  it("--risk without a report is INVALID, not empty", () => {
    // Empty would read as "there are no critical groups"; the truth is "I have
    // no evidence from which to determine group risk".
    expect(resolveSelection({ contribution: WORLD, selectors: sel({ risk: "critical" }) })).toEqual(
      {
        mode: "selective",
        outcome: "invalid",
        reason: { code: "REPORT_REQUIRED" },
      },
    );
  });

  it("--finding without a report is INVALID, not empty", () => {
    expect(resolveSelection({ contribution: WORLD, selectors: sel({ finding: [FND_A] }) })).toEqual(
      {
        mode: "selective",
        outcome: "invalid",
        reason: { code: "REPORT_REQUIRED" },
      },
    );
  });
});

// =============================================================================
// 6. Algebra
// =============================================================================

describe("resolveSelection -- algebra", () => {
  const report = makeReport([
    makeFinding({ findingId: FND_A, level: "critical", affectedPaths: ["src/a.ts"] }),
    makeFinding({ findingId: FND_B, level: "critical", affectedPaths: ["src/b.ts"] }),
  ]);

  it("intersects different positive families", () => {
    // critical changes INSIDE src/a.ts, never src/a.ts plus unrelated criticals.
    const result = resolveSelection({
      contribution: WORLD,
      report,
      selectors: sel({ only: ["src/a.ts"], risk: "critical" }),
    });
    expect(resolvedIds(result)).toEqual([GROUP_A]);
  });

  it("a SUPPLIED family that resolves to nothing still intersects", () => {
    // Presence gates participation, not resolved size. Skipping an empty
    // family would silently widen a selection the user deliberately narrowed.
    expect(
      resolveSelection({
        contribution: WORLD,
        report,
        selectors: sel({ only: ["does/not/exist/**"], risk: "critical" }),
      }),
    ).toEqual({ mode: "selective", outcome: "empty" });
  });

  it("subtracts --except last and group-atomically", () => {
    // Excluding pkg/two.ts removes the whole group, including pkg/one.ts which
    // --only explicitly selected.
    const result = resolveSelection({
      contribution: WORLD,
      selectors: sel({ only: ["pkg/**", "src/a.ts"], except: ["pkg/two.ts"] }),
    });
    expect(resolvedIds(result)).toEqual([GROUP_A]);
  });

  it("unions repeated --finding selectors", () => {
    // Separate implementation from --only: iterative id resolution
    // accumulating into a Set, which could overwrite rather than accumulate.
    const result = resolveSelection({
      contribution: WORLD,
      report,
      selectors: sel({ finding: [FND_A, FND_B] }),
    });
    expect(new Set(resolvedIds(result))).toEqual(new Set([GROUP_A, GROUP_B]));
  });

  it("unions repeated --except patterns", () => {
    const result = resolveSelection({
      contribution: WORLD,
      selectors: sel({ except: ["src/**", "pkg/**"] }),
    });
    // Both exclusions applied, leaving only the rename group.
    expect(resolvedIds(result)).toEqual([GROUP_RENAME]);
  });

  it("reports empty as its own outcome, carrying no changeGroupIds", () => {
    const result = resolveSelection({
      contribution: WORLD,
      selectors: sel({ only: ["nothing/matches/**"] }),
    });
    expect(result).toEqual({ mode: "selective", outcome: "empty" });
    // Absent, not an empty array: the caller must branch on the outcome rather
    // than treat this as a short resolved list. Dry-run and --apply diverge
    // here.
    expect("changeGroupIds" in result).toBe(false);
  });
});
