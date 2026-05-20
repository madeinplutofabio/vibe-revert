// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Regression tests for path-classifier-check.ts emission discipline.
//
// REGRESSION CONTEXT (M C Step 4 follow-up):
// Step 4 (secrets detector) surfaced a bug CLASS where a detector's
// matcher correctly normalizes input paths for matching, but the
// emission code uses raw `file.path` in `evidence.file` and `message`.
// When `file.path` contains backslash separators (Windows CLI, MCP
// adapter, third-party caller), the engine's per-finding
// CheckResultSchema.parse step (D28 layer 2) rejects the finding via
// `safeStoredRelativePath` schema validation, and the detector output
// is dropped entirely (or throws).
//
// path-classifier-check.ts had the SAME latent bug:
//   - `match.ts::normalizeClassifierPath` normalizes for glob matching
//     (so classification works on Windows-shaped paths)
//   - BUT `path-classifier-check.ts` previously emitted the RAW
//     `file.path` into `evidence.file` and `message`
//
// These tests lock the post-fix behavior: paths MUST be POSIX-
// normalized end-to-end. The matcher AND the emission must accept
// backslash input, AND the emitted evidence.file must be POSIX.
//
// FINDING RESOLUTION VIA .find():
// Both tests resolve the path-classifier finding by stable id
// `path-classifier.generic.gh-actions` rather than `results[0]`. This
// keeps the assertions stable if a future PATH_RULES addition also
// matches `.github/workflows/deploy.yml` and contributes an additional
// finding (different id, different category) to the same input — the
// regression assertions are specifically about THIS rule's emission,
// not about being the only finding.

import { describe, expect, it } from "vitest";

import { pathClassifierCheck } from "../../src/classifiers/path-classifier-check.js";
import type { ChangedFileInput, CheckContext, ChecksToggleConfig } from "../../src/index.js";
import { runChecks } from "../../src/index.js";

function pathOnly(path: string): ChangedFileInput {
  return {
    path,
    status: "modified",
    addedLines: [],
    removedLines: [],
    isBinary: false,
  };
}

/**
 * Enable ALL toggle categories so D28 layer 1 never short-circuits the
 * check based on configChecks. path-classifier is an umbrella check;
 * its `emittedCategories` spans 7 categories. Per-category gating is
 * tested elsewhere (path-classifier-toggle.test.ts) — these tests
 * focus on emission shape, not toggle behavior, so all-on keeps the
 * setup cognitively simple.
 */
const ALL_TOGGLES_ON: ChecksToggleConfig = {
  auth: true,
  payments: true,
  migrations: true,
  secrets: true,
  dependencies: true,
  infra: true,
  tests: true,
  scope_expansion: true,
};

function ctxFor(files: readonly ChangedFileInput[]): CheckContext {
  return {
    changedFiles: files,
    detectedFrameworks: [],
    configChecks: ALL_TOGGLES_ON,
  };
}

describe("pathClassifierCheck — emission path normalization", () => {
  it("Windows-style backslash path (.github\\\\workflows\\\\deploy.yml) → POSIX-normalized evidence.file passes schema validation end-to-end", () => {
    // generic.gh-actions matches `.github/workflows/**`. No framework
    // gating needed (it's a generic always-on rule). After the fix:
    // matcher normalizes backslashes for glob match AND emission
    // normalizes backslashes for evidence.file + message. Pre-fix:
    // matcher works but emission fails CheckResultSchema.parse via
    // safeStoredRelativePath (rejects backslash separators) — runChecks
    // throws a ZodError before this test's expects can run.
    const file = pathOnly(".github\\workflows\\deploy.yml");
    const result = runChecks([pathClassifierCheck], ctxFor([file]));

    expect(result.results.length).toBeGreaterThan(0);
    const finding = result.results.find((r) => r.id === "path-classifier.generic.gh-actions");
    expect(finding).toBeDefined();
    if (!finding) return;
    // Finding semantics preserved (id/category/level intact through normalization).
    expect(finding.id).toBe("path-classifier.generic.gh-actions");
    expect(finding.category).toBe("deployment");
    expect(finding.level).toBe("high");
    // Emission-path properties — the actual regression assertions.
    expect(finding.evidence[0]?.file).toBe(".github/workflows/deploy.yml");
    expect(finding.evidence[0]?.file).not.toContain("\\");
    expect(finding.message).toContain(".github/workflows/deploy.yml");
    expect(finding.message).not.toContain("\\");
  });

  it("POSIX-shaped input (.github/workflows/deploy.yml) → evidence.file emitted verbatim (no double-normalization)", () => {
    // Non-regression / round-trip: a path that's already POSIX must
    // pass through the normalization unchanged. Catches a hypothetical
    // regression that double-normalizes or mangles forward slashes.
    const file = pathOnly(".github/workflows/deploy.yml");
    const result = runChecks([pathClassifierCheck], ctxFor([file]));

    expect(result.results.length).toBeGreaterThan(0);
    const finding = result.results.find((r) => r.id === "path-classifier.generic.gh-actions");
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.evidence[0]?.file).toBe(".github/workflows/deploy.yml");
  });
});
