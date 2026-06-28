// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import {
  type AdapterContext,
  type ApplicablePlan,
  type FileEditOp,
  type JsonValue,
  type PathSpec,
  renderSentinelBlock,
} from "@viberevert/adapters";
import { describe, expect, it } from "vitest";

import {
  ADOPTION_HUMAN_SUMMARY,
  chooseTargetLineEnding,
  classifyOp,
  computeDesiredFullFileBytes,
  computeDesiredManagedRegionSha,
  DRIFT_REASON_CODE,
  DUPLICATE_PLAN_PATH_REASON_CODE,
  DUPLICATE_RECORD_PATH_REASON_CODE,
  EMPTY_PLAN_REASON_CODE,
  extractCurrentManagedRegionSha,
  extractRecordedSha,
  findDuplicatePlanPaths,
  KIND_MISMATCH_REASON_CODE,
  refuseAssessment,
  renderUnifiedDiff,
  SENTINEL_BLOCK_MISSING_REASON_CODE,
  sha256OfUtf8,
  TARGET_EXISTS_REASON_CODE,
  TARGET_MISSING_REASON_CODE,
} from "../src/engine-classify.js";
import type { IntegrationFileEditRecord } from "../src/integrations-schema.js";

// Fixed SHA-shaped constants. Use these in fixtures rather than ad-hoc
// "a".repeat(64) calls so accidental wrong-length inputs are impossible.
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

// ---------------------------------------------------------------------------
// Factories: each returns a fully-valid value; tests build varied/invalid
// cases by spread-and-override. No source exports are added for these tests
// -- everything is exercised via the existing public surface.
// ---------------------------------------------------------------------------

// makeCtx accepts a Partial AdapterContext BUT with options widened to
// Partial<options>. Default Partial<AdapterContext>.options would require
// the full nested shape when present, defeating per-flag overrides.
type AdapterContextOverrides = Omit<Partial<AdapterContext>, "options"> & {
  readonly options?: Partial<AdapterContext["options"]>;
};

function makeCtx(overrides: AdapterContextOverrides = {}): AdapterContext {
  const base: AdapterContext = {
    repoRoot: "/tmp/test-repo",
    now: new Date("2026-06-27T12:00:00.000Z"),
    cliVersion: "0.7.1-beta.0",
    intent: "explicit",
    options: {
      forceReinstall: false,
      migrateFromHookInstall: false,
      forceUninstall: false,
    },
  };
  return {
    ...base,
    ...overrides,
    options: {
      ...base.options,
      ...overrides.options,
    },
  };
}

function forcedCtx(): AdapterContext {
  return makeCtx({ options: { forceReinstall: true } });
}

function makePathSpec(overrides: Partial<PathSpec> = {}): PathSpec {
  return {
    scope: "repo",
    pathTemplate: "{repo}/test.json",
    pathRelative: "test.json",
    ...overrides,
  };
}

function makeBackupPathSpec(): PathSpec {
  return {
    scope: "repo",
    pathTemplate: "{repo}/.viberevert/integration-backups/test/group/file",
    pathRelative: ".viberevert/integration-backups/test/group/file",
  };
}

function makeWriteNewOp(
  overrides: Partial<Extract<FileEditOp, { kind: "write-new" }>> = {},
): FileEditOp {
  return { kind: "write-new", target: makePathSpec(), content: "hello\n", ...overrides };
}

function makeBackupAndWriteOp(
  overrides: Partial<Extract<FileEditOp, { kind: "backup-and-write" }>> = {},
): FileEditOp {
  return { kind: "backup-and-write", target: makePathSpec(), content: "hello\n", ...overrides };
}

function makeSentinelInsertOp(
  overrides: Partial<Extract<FileEditOp, { kind: "sentinel-block-insert" }>> = {},
): FileEditOp {
  return {
    kind: "sentinel-block-insert",
    target: makePathSpec(),
    blockId: "test-block",
    content: "managed-content",
    anchor: { mode: "append" },
    ...overrides,
  };
}

function makeSentinelReplaceOp(
  overrides: Partial<Extract<FileEditOp, { kind: "sentinel-block-replace" }>> = {},
): FileEditOp {
  return {
    kind: "sentinel-block-replace",
    target: makePathSpec(),
    blockId: "test-block",
    content: "managed-content",
    ...overrides,
  };
}

function makeJsonKeyMergeOp(
  overrides: Partial<Extract<FileEditOp, { kind: "json-key-merge" }>> = {},
): FileEditOp {
  return {
    kind: "json-key-merge",
    target: makePathSpec({ pathRelative: "config.json" }),
    keyPath: ["mcpServers", "viberevert"],
    value: { command: "viberevert", args: ["mcp", "serve"] } as JsonValue,
    ...overrides,
  };
}

function makeApplicablePlan(overrides: Partial<ApplicablePlan> = {}): ApplicablePlan {
  return {
    status: "applicable",
    adapterName: "test-adapter",
    humanSummary: "test plan",
    ops: [makeWriteNewOp()],
    recordKey: "cursor",
    meta: {},
    ...overrides,
  };
}

// Per-kind record factories matching the per-kind SHA discipline.

function makeWriteNewRecord(
  overrides: Partial<IntegrationFileEditRecord> = {},
): IntegrationFileEditRecord {
  return {
    kind: "write-new",
    target: makePathSpec(),
    backup: null,
    managedBlockSha256: null,
    managedValueSha256: null,
    fullFileSha256AfterWrite: SHA_A,
    blockId: null,
    jsonKeyPath: null,
    mode: null,
    ...overrides,
  };
}

function makeBackupAndWriteRecord(
  overrides: Partial<IntegrationFileEditRecord> = {},
): IntegrationFileEditRecord {
  return {
    kind: "backup-and-write",
    target: makePathSpec(),
    backup: makeBackupPathSpec(),
    managedBlockSha256: null,
    managedValueSha256: null,
    fullFileSha256AfterWrite: SHA_A,
    blockId: null,
    jsonKeyPath: null,
    mode: null,
    ...overrides,
  };
}

function makeSentinelInsertRecord(
  overrides: Partial<IntegrationFileEditRecord> = {},
): IntegrationFileEditRecord {
  return {
    kind: "sentinel-block-insert",
    target: makePathSpec(),
    backup: null,
    managedBlockSha256: SHA_A,
    managedValueSha256: null,
    fullFileSha256AfterWrite: null,
    blockId: "test-block",
    jsonKeyPath: null,
    mode: null,
    ...overrides,
  };
}

function makeSentinelReplaceRecord(
  overrides: Partial<IntegrationFileEditRecord> = {},
): IntegrationFileEditRecord {
  return {
    kind: "sentinel-block-replace",
    target: makePathSpec(),
    backup: null,
    managedBlockSha256: SHA_A,
    managedValueSha256: null,
    fullFileSha256AfterWrite: null,
    blockId: "test-block",
    jsonKeyPath: null,
    mode: null,
    ...overrides,
  };
}

function makeJsonKeyMergeRecord(
  overrides: Partial<IntegrationFileEditRecord> = {},
): IntegrationFileEditRecord {
  return {
    kind: "json-key-merge",
    target: makePathSpec({ pathRelative: "config.json" }),
    backup: null,
    managedBlockSha256: null,
    managedValueSha256: SHA_A,
    fullFileSha256AfterWrite: null,
    blockId: null,
    jsonKeyPath: ["mcpServers", "viberevert"],
    mode: null,
    ...overrides,
  };
}

// ===========================================================================
// A. Exported constants
// ===========================================================================

describe("exported constants", () => {
  it("ADOPTION_HUMAN_SUMMARY is a non-empty string", () => {
    expect(typeof ADOPTION_HUMAN_SUMMARY).toBe("string");
    expect(ADOPTION_HUMAN_SUMMARY.length).toBeGreaterThan(0);
  });
  it("all exported reason-code constants are non-empty strings", () => {
    const reasonCodes = [
      DRIFT_REASON_CODE,
      KIND_MISMATCH_REASON_CODE,
      EMPTY_PLAN_REASON_CODE,
      DUPLICATE_PLAN_PATH_REASON_CODE,
      DUPLICATE_RECORD_PATH_REASON_CODE,
      TARGET_EXISTS_REASON_CODE,
      TARGET_MISSING_REASON_CODE,
      SENTINEL_BLOCK_MISSING_REASON_CODE,
    ];
    for (const code of reasonCodes) {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
    }
  });
  it("reason-code constants are mutually distinct", () => {
    const reasonCodes = [
      DRIFT_REASON_CODE,
      KIND_MISMATCH_REASON_CODE,
      EMPTY_PLAN_REASON_CODE,
      DUPLICATE_PLAN_PATH_REASON_CODE,
      DUPLICATE_RECORD_PATH_REASON_CODE,
      TARGET_EXISTS_REASON_CODE,
      TARGET_MISSING_REASON_CODE,
      SENTINEL_BLOCK_MISSING_REASON_CODE,
    ];
    expect(new Set(reasonCodes).size).toBe(reasonCodes.length);
  });
});

// ===========================================================================
// B. Pure helpers
// ===========================================================================

describe("sha256OfUtf8", () => {
  it("returns the external known SHA-256 of empty string", () => {
    // External known value -- NOT derived from the helper under test.
    expect(sha256OfUtf8("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  it("returns 64 lowercase hex chars for any input", () => {
    expect(sha256OfUtf8("foo")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("returns different hashes for different inputs", () => {
    expect(sha256OfUtf8("foo")).not.toBe(sha256OfUtf8("bar"));
  });
});

describe("chooseTargetLineEnding", () => {
  it("returns LF for null (no existing file)", () => {
    expect(chooseTargetLineEnding(null)).toBe("LF");
  });
  it("returns LF for LF-only content", () => {
    expect(chooseTargetLineEnding("line1\nline2\nline3")).toBe("LF");
  });
  it("returns CRLF for CRLF-only content", () => {
    expect(chooseTargetLineEnding("line1\r\nline2\r\nline3")).toBe("CRLF");
  });
  it("returns LF for mixed line endings", () => {
    // detectLineEnding returns "mixed-or-unknown"; chooseTargetLineEnding
    // maps anything non-CRLF to LF.
    expect(chooseTargetLineEnding("line1\r\nline2\nline3")).toBe("LF");
  });
});

describe("renderUnifiedDiff", () => {
  it("returns a non-empty string containing the pathRelative", () => {
    const diff = renderUnifiedDiff({
      pathRelative: "config/test.json",
      currentBytes: "before\n",
      desiredBytes: "after\n",
    });
    expect(diff.length).toBeGreaterThan(0);
    expect(diff).toContain("config/test.json");
  });
  it("contains added/removed content lines for differing input", () => {
    const diff = renderUnifiedDiff({
      pathRelative: "x.txt",
      currentBytes: "old\n",
      desiredBytes: "new\n",
    });
    // Assert at least one body +/- line, distinguished from the +++/--- file
    // headers by NOT being prefixed with the doubled marker.
    const lines = diff.split("\n");
    expect(lines.some((l) => l.startsWith("+") && !l.startsWith("+++"))).toBe(true);
    expect(lines.some((l) => l.startsWith("-") && !l.startsWith("---"))).toBe(true);
  });
});

describe("findDuplicatePlanPaths", () => {
  it("returns [] for empty plan ops", () => {
    expect(findDuplicatePlanPaths(makeApplicablePlan({ ops: [] }))).toEqual([]);
  });
  it("returns [] when all paths are unique", () => {
    const ops = [
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "a.json" }) }),
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "b.json" }) }),
    ];
    expect(findDuplicatePlanPaths(makeApplicablePlan({ ops }))).toEqual([]);
  });
  it("returns the duplicate path when two ops share pathRelative (same kind)", () => {
    const ops = [
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "dup.json" }) }),
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "dup.json" }) }),
    ];
    expect(findDuplicatePlanPaths(makeApplicablePlan({ ops }))).toEqual(["dup.json"]);
  });
  it("detects duplicate pathRelative across different op kinds", () => {
    // Duplicate detection must catch same path regardless of op kind.
    // write-new + json-key-merge with same path.
    const ops = [
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "mixed.json" }) }),
      makeJsonKeyMergeOp({ target: makePathSpec({ pathRelative: "mixed.json" }) }),
    ];
    expect(findDuplicatePlanPaths(makeApplicablePlan({ ops }))).toEqual(["mixed.json"]);
  });
  it("returns all duplicate paths via arrayContaining (order not asserted here)", () => {
    const ops = [
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "a.json" }) }),
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "a.json" }) }),
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "b.json" }) }),
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "b.json" }) }),
    ];
    expect(findDuplicatePlanPaths(makeApplicablePlan({ ops }))).toEqual(
      expect.arrayContaining(["a.json", "b.json"]),
    );
  });
  it("returns duplicates in first-occurrence order (Map insertion order)", () => {
    // Single deterministic order-asserting test. Source uses
    // `Array.from(counts.entries()).filter(...).map(...)` -- counts is a
    // Map, so insertion order is the first time each path appears in
    // plan.ops.
    const ops = [
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "z.json" }) }),
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "a.json" }) }),
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "z.json" }) }),
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "a.json" }) }),
    ];
    expect(findDuplicatePlanPaths(makeApplicablePlan({ ops }))).toEqual(["z.json", "a.json"]);
  });
  it("counts triple-occurrence as a single entry in the duplicates list", () => {
    const ops = [
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "thrice.json" }) }),
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "thrice.json" }) }),
      makeWriteNewOp({ target: makePathSpec({ pathRelative: "thrice.json" }) }),
    ];
    expect(findDuplicatePlanPaths(makeApplicablePlan({ ops }))).toEqual(["thrice.json"]);
  });
});

describe("refuseAssessment", () => {
  it("constructs a would-refuse PerOpAssessment with the given fields", () => {
    const r = refuseAssessment("p.json", "write-new", DRIFT_REASON_CODE, "details here");
    expect(r.kind).toBe("would-refuse");
    if (r.kind === "would-refuse") {
      expect(r.pathRelative).toBe("p.json");
      expect(r.opKind).toBe("write-new");
      expect(r.reasonCode).toBe(DRIFT_REASON_CODE);
      expect(r.detailLine).toBe("details here");
    }
  });
});

// ===========================================================================
// C. Per-kind compute helpers
// ===========================================================================

describe("computeDesiredFullFileBytes per kind", () => {
  it("write-new: returns op.content normalized to target LF", () => {
    const op = makeWriteNewOp({ content: "line1\nline2\n" });
    expect(computeDesiredFullFileBytes({ op, currentBytes: null, targetLineEnding: "LF" })).toBe(
      "line1\nline2\n",
    );
  });
  it("write-new: normalizes LF input to CRLF when target is CRLF", () => {
    const op = makeWriteNewOp({ content: "line1\nline2\n" });
    expect(
      computeDesiredFullFileBytes({ op, currentBytes: "x\r\n", targetLineEnding: "CRLF" }),
    ).toBe("line1\r\nline2\r\n");
  });
  it("backup-and-write: returns op.content normalized to target LF", () => {
    const op = makeBackupAndWriteOp({ content: "abc\ndef\n" });
    expect(
      computeDesiredFullFileBytes({ op, currentBytes: "existing\n", targetLineEnding: "LF" }),
    ).toBe("abc\ndef\n");
  });
  it("sentinel-block-insert: appends rendered block to existing content (anchor: append)", () => {
    // Marker syntax belongs to the renderer; assert the classifier output
    // CONTAINS the renderer's verbatim output rather than hand-typing
    // marker strings here.
    const op = makeSentinelInsertOp({ blockId: "cursor-block", content: "managed" });
    const result = computeDesiredFullFileBytes({
      op,
      currentBytes: "user line\n",
      targetLineEnding: "LF",
    });
    expect(result.startsWith("user line\n")).toBe(true);
    expect(result).toContain(renderSentinelBlock("cursor-block", "managed"));
  });
  it("sentinel-block-insert: inserts after marker line when anchor mode is after-marker", () => {
    // Same principle: derive the expected block via renderSentinelBlock.
    // "# anchor-here" is the USER's marker (not a viberevert sentinel),
    // so it is the test's responsibility to spell it literally.
    const op = makeSentinelInsertOp({
      blockId: "anchored",
      content: "managed",
      anchor: { mode: "after-marker", marker: "# anchor-here" },
    });
    const result = computeDesiredFullFileBytes({
      op,
      currentBytes: "# anchor-here\nrest\n",
      targetLineEnding: "LF",
    });
    const markerIdx = result.indexOf("# anchor-here");
    const renderedIdx = result.indexOf(renderSentinelBlock("anchored", "managed"));
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(renderedIdx).toBeGreaterThan(markerIdx);
  });
  it("sentinel-block-replace: replaces existing block content with new content", () => {
    const op = makeSentinelReplaceOp({ blockId: "test-block", content: "new content" });
    const existing = `prefix\n${renderSentinelBlock("test-block", "old content")}suffix\n`;
    const result = computeDesiredFullFileBytes({
      op,
      currentBytes: existing,
      targetLineEnding: "LF",
    });
    expect(result).toContain("new content");
    expect(result).not.toContain("old content");
  });
  it("json-key-merge: returns prettyJson of merged value with trailing newline", () => {
    const op = makeJsonKeyMergeOp({
      keyPath: ["mcpServers", "viberevert"],
      value: { command: "viberevert" } as JsonValue,
    });
    const result = computeDesiredFullFileBytes({
      op,
      currentBytes: '{"mcpServers":{"other":{}}}',
      targetLineEnding: "LF",
    });
    const parsed = JSON.parse(result) as {
      mcpServers: { other: object; viberevert: { command: string } };
    };
    expect(parsed.mcpServers.viberevert).toEqual({ command: "viberevert" });
    expect(parsed.mcpServers.other).toEqual({});
    expect(result.endsWith("\n")).toBe(true);
  });
  it("json-key-merge: creates the JSON file from scratch when currentBytes is null", () => {
    const op = makeJsonKeyMergeOp({
      keyPath: ["mcpServers", "viberevert"],
      value: { command: "viberevert" } as JsonValue,
    });
    const result = computeDesiredFullFileBytes({
      op,
      currentBytes: null,
      targetLineEnding: "LF",
    });
    const parsed = JSON.parse(result) as { mcpServers: { viberevert: { command: string } } };
    expect(parsed.mcpServers.viberevert).toEqual({ command: "viberevert" });
  });
});

describe("computeDesiredManagedRegionSha per kind", () => {
  it("write-new: sha256 of full desired bytes", () => {
    const op = makeWriteNewOp();
    const bytes = "some content\n";
    expect(computeDesiredManagedRegionSha({ op, desiredFullFileBytes: bytes })).toBe(
      sha256OfUtf8(bytes),
    );
  });
  it("backup-and-write: sha256 of full desired bytes", () => {
    const op = makeBackupAndWriteOp();
    const bytes = "more content\n";
    expect(computeDesiredManagedRegionSha({ op, desiredFullFileBytes: bytes })).toBe(
      sha256OfUtf8(bytes),
    );
  });
  it("sentinel-block-insert: sha256 of op.content (NOT line-ending normalized, NOT full file)", () => {
    const op = makeSentinelInsertOp({ content: "block body" });
    expect(computeDesiredManagedRegionSha({ op, desiredFullFileBytes: "doesn't matter" })).toBe(
      sha256OfUtf8("block body"),
    );
  });
  it("sentinel-block-replace: sha256 of op.content (NOT full file)", () => {
    const op = makeSentinelReplaceOp({ content: "block body" });
    expect(computeDesiredManagedRegionSha({ op, desiredFullFileBytes: "doesn't matter" })).toBe(
      sha256OfUtf8("block body"),
    );
  });
  it("json-key-merge: stable across key-order permutations of value (canonical SHA)", () => {
    // sha256OfCanonical is internal; verify behavior by constructing two
    // value-equivalent objects with different key orders and asserting
    // their managed-region SHAs are equal. Also asserts 64-hex shape.
    const op1 = makeJsonKeyMergeOp({ value: { b: 1, a: 2 } as JsonValue });
    const op2 = makeJsonKeyMergeOp({ value: { a: 2, b: 1 } as JsonValue });
    const sha1 = computeDesiredManagedRegionSha({ op: op1, desiredFullFileBytes: "" });
    const sha2 = computeDesiredManagedRegionSha({ op: op2, desiredFullFileBytes: "" });
    expect(sha1).toMatch(/^[0-9a-f]{64}$/);
    expect(sha1).toBe(sha2);
  });
});

describe("extractCurrentManagedRegionSha per kind", () => {
  it("write-new: null currentBytes -> null", () => {
    expect(extractCurrentManagedRegionSha(makeWriteNewOp(), null)).toBeNull();
  });
  it("write-new: present currentBytes -> sha256 of bytes", () => {
    const bytes = "current content";
    expect(extractCurrentManagedRegionSha(makeWriteNewOp(), bytes)).toBe(sha256OfUtf8(bytes));
  });
  it("backup-and-write: null currentBytes -> null", () => {
    expect(extractCurrentManagedRegionSha(makeBackupAndWriteOp(), null)).toBeNull();
  });
  it("backup-and-write: present currentBytes -> sha256 of bytes", () => {
    const bytes = "current";
    expect(extractCurrentManagedRegionSha(makeBackupAndWriteOp(), bytes)).toBe(sha256OfUtf8(bytes));
  });
  it("sentinel-block-insert: null currentBytes -> null", () => {
    expect(extractCurrentManagedRegionSha(makeSentinelInsertOp(), null)).toBeNull();
  });
  it("sentinel-block-insert: no matching block in current -> null", () => {
    expect(
      extractCurrentManagedRegionSha(makeSentinelInsertOp({ blockId: "missing" }), "no block\n"),
    ).toBeNull();
  });
  it("sentinel-block-insert: matching block -> sha256 of block content", () => {
    const op = makeSentinelInsertOp({ blockId: "found" });
    const current = `prefix\n${renderSentinelBlock("found", "block-content")}suffix\n`;
    expect(extractCurrentManagedRegionSha(op, current)).toBe(sha256OfUtf8("block-content"));
  });
  it("sentinel-block-replace: null currentBytes -> null", () => {
    expect(extractCurrentManagedRegionSha(makeSentinelReplaceOp(), null)).toBeNull();
  });
  it("sentinel-block-replace: no matching block -> null", () => {
    expect(
      extractCurrentManagedRegionSha(makeSentinelReplaceOp({ blockId: "missing" }), "no block\n"),
    ).toBeNull();
  });
  it("sentinel-block-replace: matching block -> sha256 of block content", () => {
    const op = makeSentinelReplaceOp({ blockId: "found" });
    const current = renderSentinelBlock("found", "managed-text");
    expect(extractCurrentManagedRegionSha(op, current)).toBe(sha256OfUtf8("managed-text"));
  });
  it("json-key-merge: null currentBytes -> null", () => {
    expect(extractCurrentManagedRegionSha(makeJsonKeyMergeOp(), null)).toBeNull();
  });
  it("json-key-merge: missing keyPath in valid JSON -> null", () => {
    const op = makeJsonKeyMergeOp({ keyPath: ["mcpServers", "viberevert"] });
    expect(extractCurrentManagedRegionSha(op, '{"mcpServers":{"other":{}}}')).toBeNull();
  });
  it("json-key-merge: present value at keyPath -> canonical SHA matching computeDesiredManagedRegionSha", () => {
    // Cross-verify against the desired-sha helper since both use
    // sha256OfCanonical(value) -- proves both walk the same path.
    const op = makeJsonKeyMergeOp({
      keyPath: ["mcpServers", "viberevert"],
      value: { command: "vr" } as JsonValue,
    });
    const current = '{"mcpServers":{"viberevert":{"command":"vr"}}}';
    const actual = extractCurrentManagedRegionSha(op, current);
    const expected = computeDesiredManagedRegionSha({ op, desiredFullFileBytes: "" });
    expect(actual).toBe(expected);
  });
  it("json-key-merge: invalid JSON in currentBytes -> propagates SyntaxError", () => {
    expect(() => extractCurrentManagedRegionSha(makeJsonKeyMergeOp(), "not valid json {")).toThrow(
      SyntaxError,
    );
  });
});

describe("extractRecordedSha per kind", () => {
  it("write-new -> recordOp.fullFileSha256AfterWrite", () => {
    expect(
      extractRecordedSha(makeWriteNewOp(), makeWriteNewRecord({ fullFileSha256AfterWrite: SHA_A })),
    ).toBe(SHA_A);
  });
  it("backup-and-write -> recordOp.fullFileSha256AfterWrite", () => {
    expect(
      extractRecordedSha(
        makeBackupAndWriteOp(),
        makeBackupAndWriteRecord({ fullFileSha256AfterWrite: SHA_A }),
      ),
    ).toBe(SHA_A);
  });
  it("sentinel-block-insert -> recordOp.managedBlockSha256", () => {
    expect(
      extractRecordedSha(
        makeSentinelInsertOp(),
        makeSentinelInsertRecord({ managedBlockSha256: SHA_A }),
      ),
    ).toBe(SHA_A);
  });
  it("sentinel-block-replace -> recordOp.managedBlockSha256", () => {
    expect(
      extractRecordedSha(
        makeSentinelReplaceOp(),
        makeSentinelReplaceRecord({ managedBlockSha256: SHA_A }),
      ),
    ).toBe(SHA_A);
  });
  it("json-key-merge -> recordOp.managedValueSha256", () => {
    expect(
      extractRecordedSha(
        makeJsonKeyMergeOp(),
        makeJsonKeyMergeRecord({ managedValueSha256: SHA_A }),
      ),
    ).toBe(SHA_A);
  });
});

// ===========================================================================
// D. classifyOp per-kind matrix
// Coverage per kind: adoption / apply / noop / safe-update / drift-refuse /
// force-overrides-drift. Plus per-kind structural refusals where the
// classifier defines them.
// ===========================================================================

describe("classifyOp -- write-new", () => {
  const op = makeWriteNewOp({
    content: "hello\n",
    target: makePathSpec({ pathRelative: "test.txt" }),
  });

  it("no record + current matches desired -> would-adopt", () => {
    const result = classifyOp({ op, ctx: makeCtx(), recordOp: null, currentBytes: "hello\n" });
    expect(result.kind).toBe("would-adopt");
    if (result.kind === "would-adopt") {
      expect(result.pathRelative).toBe("test.txt");
      expect(result.opKind).toBe("write-new");
    }
  });
  it("no record + currentBytes null -> would-apply (with pathRelative + opKind + non-empty diff)", () => {
    // Representative would-apply assertion: full shape verification.
    const result = classifyOp({ op, ctx: makeCtx(), recordOp: null, currentBytes: null });
    expect(result.kind).toBe("would-apply");
    if (result.kind === "would-apply") {
      expect(result.pathRelative).toBe("test.txt");
      expect(result.opKind).toBe("write-new");
      expect(result.unifiedDiff.length).toBeGreaterThan(0);
    }
  });
  it("no record + current differs from desired -> TARGET_EXISTS refusal (structural)", () => {
    const result = classifyOp({
      op,
      ctx: makeCtx(),
      recordOp: null,
      currentBytes: "different content\n",
    });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(TARGET_EXISTS_REASON_CODE);
      expect(result.pathRelative).toBe("test.txt");
      expect(result.opKind).toBe("write-new");
    }
  });
  it("record + current matches recorded + desired matches recorded -> would-noop", () => {
    const recordOp = makeWriteNewRecord({ fullFileSha256AfterWrite: sha256OfUtf8("hello\n") });
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: "hello\n" });
    expect(result.kind).toBe("would-noop");
  });
  it("record + current matches recorded + desired differs -> would-safe-update (with pathRelative + opKind + non-empty diff)", () => {
    // Representative would-safe-update assertion: full shape verification.
    const recordOp = makeWriteNewRecord({ fullFileSha256AfterWrite: sha256OfUtf8("old\n") });
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: "old\n" });
    expect(result.kind).toBe("would-safe-update");
    if (result.kind === "would-safe-update") {
      expect(result.pathRelative).toBe("test.txt");
      expect(result.opKind).toBe("write-new");
      expect(result.unifiedDiff.length).toBeGreaterThan(0);
    }
  });
  it("record + current drifts from recorded + force=false -> would-refuse DRIFT", () => {
    const recordOp = makeWriteNewRecord({ fullFileSha256AfterWrite: SHA_B });
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: "drifted\n" });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(DRIFT_REASON_CODE);
    }
  });
  it("record + current drifts from recorded + force=true -> would-apply", () => {
    const recordOp = makeWriteNewRecord({ fullFileSha256AfterWrite: SHA_B });
    const result = classifyOp({ op, ctx: forcedCtx(), recordOp, currentBytes: "drifted\n" });
    expect(result.kind).toBe("would-apply");
  });
});

describe("classifyOp -- backup-and-write", () => {
  const op = makeBackupAndWriteOp({
    content: "hello\n",
    target: makePathSpec({ pathRelative: "test.txt" }),
  });

  it("no record + currentBytes null -> TARGET_MISSING refusal (structural)", () => {
    const result = classifyOp({ op, ctx: makeCtx(), recordOp: null, currentBytes: null });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(TARGET_MISSING_REASON_CODE);
      expect(result.pathRelative).toBe("test.txt");
      expect(result.opKind).toBe("backup-and-write");
    }
  });
  it("no record + current matches desired -> would-adopt", () => {
    const result = classifyOp({ op, ctx: makeCtx(), recordOp: null, currentBytes: "hello\n" });
    expect(result.kind).toBe("would-adopt");
  });
  it("no record + current differs from desired -> would-apply", () => {
    const result = classifyOp({
      op,
      ctx: makeCtx(),
      recordOp: null,
      currentBytes: "existing\n",
    });
    expect(result.kind).toBe("would-apply");
  });
  it("record + current matches recorded + desired matches recorded -> would-noop", () => {
    const recordOp = makeBackupAndWriteRecord({
      fullFileSha256AfterWrite: sha256OfUtf8("hello\n"),
    });
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: "hello\n" });
    expect(result.kind).toBe("would-noop");
  });
  it("record + current matches recorded + desired differs -> would-safe-update", () => {
    const recordOp = makeBackupAndWriteRecord({
      fullFileSha256AfterWrite: sha256OfUtf8("old\n"),
    });
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: "old\n" });
    expect(result.kind).toBe("would-safe-update");
  });
  it("record + drift + force=false -> would-refuse DRIFT", () => {
    const recordOp = makeBackupAndWriteRecord({ fullFileSha256AfterWrite: SHA_B });
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: "drifted\n" });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(DRIFT_REASON_CODE);
    }
  });
  it("record + drift + force=true -> would-apply", () => {
    const recordOp = makeBackupAndWriteRecord({ fullFileSha256AfterWrite: SHA_B });
    const result = classifyOp({ op, ctx: forcedCtx(), recordOp, currentBytes: "drifted\n" });
    expect(result.kind).toBe("would-apply");
  });
});

describe("classifyOp -- sentinel-block-insert", () => {
  const op = makeSentinelInsertOp({ blockId: "test-block", content: "managed" });

  it("no record + matching block + content matches -> would-adopt", () => {
    const current = renderSentinelBlock("test-block", "managed");
    const result = classifyOp({ op, ctx: makeCtx(), recordOp: null, currentBytes: current });
    expect(result.kind).toBe("would-adopt");
  });
  it("no record + currentBytes null -> would-apply (base='' + append)", () => {
    const result = classifyOp({ op, ctx: makeCtx(), recordOp: null, currentBytes: null });
    expect(result.kind).toBe("would-apply");
  });
  it("no record + no matching block in existing content -> would-apply", () => {
    const result = classifyOp({
      op,
      ctx: makeCtx(),
      recordOp: null,
      currentBytes: "user line\n",
    });
    expect(result.kind).toBe("would-apply");
  });
  it("record + matching block + content matches recorded + desired matches -> would-noop", () => {
    const recordOp = makeSentinelInsertRecord({ managedBlockSha256: sha256OfUtf8("managed") });
    const current = renderSentinelBlock("test-block", "managed");
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: current });
    expect(result.kind).toBe("would-noop");
  });
  it("record + matching block + content matches recorded + desired differs -> would-safe-update", () => {
    const recordOp = makeSentinelInsertRecord({ managedBlockSha256: sha256OfUtf8("old-content") });
    const current = renderSentinelBlock("test-block", "old-content");
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: current });
    expect(result.kind).toBe("would-safe-update");
  });
  it("record + drift + force=false -> would-refuse DRIFT", () => {
    const recordOp = makeSentinelInsertRecord({ managedBlockSha256: SHA_B });
    const current = renderSentinelBlock("test-block", "drifted-content");
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: current });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(DRIFT_REASON_CODE);
    }
  });
  it("record + drift + force=true -> would-apply", () => {
    const recordOp = makeSentinelInsertRecord({ managedBlockSha256: SHA_B });
    const current = renderSentinelBlock("test-block", "drifted-content");
    const result = classifyOp({ op, ctx: forcedCtx(), recordOp, currentBytes: current });
    expect(result.kind).toBe("would-apply");
  });
});

describe("classifyOp -- sentinel-block-replace", () => {
  const op = makeSentinelReplaceOp({ blockId: "test-block", content: "managed" });

  it("no record + no matching block -> SENTINEL_BLOCK_MISSING refusal (structural)", () => {
    const result = classifyOp({
      op,
      ctx: makeCtx(),
      recordOp: null,
      currentBytes: "no block here\n",
    });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(SENTINEL_BLOCK_MISSING_REASON_CODE);
      expect(result.opKind).toBe("sentinel-block-replace");
    }
  });
  it("no record + matching block + content matches -> would-adopt", () => {
    const current = renderSentinelBlock("test-block", "managed");
    const result = classifyOp({ op, ctx: makeCtx(), recordOp: null, currentBytes: current });
    expect(result.kind).toBe("would-adopt");
  });
  it("record + matching block + content matches recorded + desired matches -> would-noop", () => {
    const recordOp = makeSentinelReplaceRecord({ managedBlockSha256: sha256OfUtf8("managed") });
    const current = renderSentinelBlock("test-block", "managed");
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: current });
    expect(result.kind).toBe("would-noop");
  });
  it("record + matching block + content matches recorded + desired differs -> would-safe-update", () => {
    const recordOp = makeSentinelReplaceRecord({ managedBlockSha256: sha256OfUtf8("old") });
    const current = renderSentinelBlock("test-block", "old");
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: current });
    expect(result.kind).toBe("would-safe-update");
  });
  it("record + drift + force=false -> would-refuse DRIFT", () => {
    const recordOp = makeSentinelReplaceRecord({ managedBlockSha256: SHA_B });
    const current = renderSentinelBlock("test-block", "drifted");
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: current });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(DRIFT_REASON_CODE);
    }
  });
  it("record + drift + force=true -> would-apply", () => {
    const recordOp = makeSentinelReplaceRecord({ managedBlockSha256: SHA_B });
    const current = renderSentinelBlock("test-block", "drifted");
    const result = classifyOp({ op, ctx: forcedCtx(), recordOp, currentBytes: current });
    expect(result.kind).toBe("would-apply");
  });
});

describe("classifyOp -- json-key-merge", () => {
  const op = makeJsonKeyMergeOp({
    keyPath: ["mcpServers", "viberevert"],
    value: { command: "vr" } as JsonValue,
  });

  it("no record + currentBytes null -> would-apply", () => {
    const result = classifyOp({ op, ctx: makeCtx(), recordOp: null, currentBytes: null });
    expect(result.kind).toBe("would-apply");
  });
  it("no record + present value at keyPath matches desired -> would-adopt", () => {
    const result = classifyOp({
      op,
      ctx: makeCtx(),
      recordOp: null,
      currentBytes: '{"mcpServers":{"viberevert":{"command":"vr"}}}',
    });
    expect(result.kind).toBe("would-adopt");
  });
  it("record + value matches recorded + desired matches recorded -> would-noop", () => {
    const recordedSha = computeDesiredManagedRegionSha({ op, desiredFullFileBytes: "" });
    const recordOp = makeJsonKeyMergeRecord({ managedValueSha256: recordedSha });
    const result = classifyOp({
      op,
      ctx: makeCtx(),
      recordOp,
      currentBytes: '{"mcpServers":{"viberevert":{"command":"vr"}}}',
    });
    expect(result.kind).toBe("would-noop");
  });
  it("record + value matches recorded + desired differs -> would-safe-update", () => {
    // Recorded SHA covers the OLD value; current still has old value;
    // op carries the new desired value.
    const oldOp = makeJsonKeyMergeOp({
      keyPath: ["mcpServers", "viberevert"],
      value: { command: "old" } as JsonValue,
    });
    const oldSha = computeDesiredManagedRegionSha({ op: oldOp, desiredFullFileBytes: "" });
    const recordOp = makeJsonKeyMergeRecord({ managedValueSha256: oldSha });
    const result = classifyOp({
      op,
      ctx: makeCtx(),
      recordOp,
      currentBytes: '{"mcpServers":{"viberevert":{"command":"old"}}}',
    });
    expect(result.kind).toBe("would-safe-update");
  });
  it("record + drift + force=false -> would-refuse DRIFT", () => {
    const recordOp = makeJsonKeyMergeRecord({ managedValueSha256: SHA_B });
    const result = classifyOp({
      op,
      ctx: makeCtx(),
      recordOp,
      currentBytes: '{"mcpServers":{"viberevert":{"command":"user-edited"}}}',
    });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(DRIFT_REASON_CODE);
    }
  });
  it("record + drift + force=true -> would-apply", () => {
    const recordOp = makeJsonKeyMergeRecord({ managedValueSha256: SHA_B });
    const result = classifyOp({
      op,
      ctx: forcedCtx(),
      recordOp,
      currentBytes: '{"mcpServers":{"viberevert":{"command":"user-edited"}}}',
    });
    expect(result.kind).toBe("would-apply");
  });
});

// ===========================================================================
// D''. Cross-kind KIND_MISMATCH (table-driven)
// ===========================================================================

describe("classifyOp -- cross-kind KIND_MISMATCH", () => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly op: FileEditOp;
    readonly recordOp: IntegrationFileEditRecord;
  }> = [
    {
      label: "write-new vs recorded backup-and-write",
      op: makeWriteNewOp(),
      recordOp: makeBackupAndWriteRecord(),
    },
    {
      label: "backup-and-write vs recorded write-new",
      op: makeBackupAndWriteOp(),
      recordOp: makeWriteNewRecord(),
    },
    {
      label: "sentinel-block-insert vs recorded write-new",
      op: makeSentinelInsertOp(),
      recordOp: makeWriteNewRecord(),
    },
    {
      label: "sentinel-block-replace vs recorded json-key-merge",
      op: makeSentinelReplaceOp(),
      recordOp: makeJsonKeyMergeRecord(),
    },
    {
      label: "json-key-merge vs recorded sentinel-block-insert",
      op: makeJsonKeyMergeOp(),
      recordOp: makeSentinelInsertRecord(),
    },
  ];

  it.each(cases)("$label -> KIND_MISMATCH refusal", ({ op, recordOp }) => {
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: "{}" });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(KIND_MISMATCH_REASON_CODE);
    }
  });
});

// ===========================================================================
// E. Force scope -- force=true does NOT override structural / cross-kind
// refusals. Only DRIFT is overrideable.
// ===========================================================================

describe("classifyOp -- force scope (force=true does NOT override non-DRIFT refusals)", () => {
  it("force does NOT override KIND_MISMATCH", () => {
    const op = makeWriteNewOp();
    const recordOp = makeBackupAndWriteRecord();
    const result = classifyOp({ op, ctx: forcedCtx(), recordOp, currentBytes: "anything\n" });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(KIND_MISMATCH_REASON_CODE);
    }
  });
  it("force does NOT override TARGET_MISSING (backup-and-write + no record + no current)", () => {
    const op = makeBackupAndWriteOp();
    const result = classifyOp({ op, ctx: forcedCtx(), recordOp: null, currentBytes: null });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(TARGET_MISSING_REASON_CODE);
    }
  });
  it("force does NOT override TARGET_EXISTS (write-new + no record + current differs)", () => {
    const op = makeWriteNewOp({ content: "desired\n" });
    const result = classifyOp({
      op,
      ctx: forcedCtx(),
      recordOp: null,
      currentBytes: "different\n",
    });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(TARGET_EXISTS_REASON_CODE);
    }
  });
  it("force does NOT override SENTINEL_BLOCK_MISSING (sentinel-block-replace + no record + no block)", () => {
    const op = makeSentinelReplaceOp({ blockId: "missing" });
    const result = classifyOp({
      op,
      ctx: forcedCtx(),
      recordOp: null,
      currentBytes: "no block here\n",
    });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(SENTINEL_BLOCK_MISSING_REASON_CODE);
    }
  });
});

// ===========================================================================
// F. Documented unusual behaviors (from engine-classify.ts top comment)
// ===========================================================================

describe("classifyOp -- documented unusual behaviors", () => {
  it("sentinel-block-replace + no record + block present + content DIFFERS -> would-apply (adapter takeover)", () => {
    const op = makeSentinelReplaceOp({ blockId: "test-block", content: "new-managed" });
    const current = renderSentinelBlock("test-block", "previously-unmanaged");
    const result = classifyOp({ op, ctx: makeCtx(), recordOp: null, currentBytes: current });
    expect(result.kind).toBe("would-apply");
  });
  it("sentinel-block-replace + record exists + block missing -> would-refuse via DRIFT (currentSha=null vs recordedSha non-null)", () => {
    const op = makeSentinelReplaceOp({ blockId: "missing-block" });
    const recordOp = makeSentinelReplaceRecord({
      managedBlockSha256: SHA_A,
      blockId: "missing-block",
    });
    const result = classifyOp({
      op,
      ctx: makeCtx(),
      recordOp,
      currentBytes: "no block here at all\n",
    });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      // DRIFT (NOT SENTINEL_BLOCK_MISSING) because Step 3's structural
      // refusal fires only when recordOp === null. With a record present,
      // Step 6 detects SHA mismatch (null vs hex) and emits DRIFT.
      expect(result.reasonCode).toBe(DRIFT_REASON_CODE);
    }
  });
  it("json-key-merge + no record + value at keyPath differs from desired -> would-apply (overwrite semantic)", () => {
    const op = makeJsonKeyMergeOp({
      keyPath: ["mcpServers", "viberevert"],
      value: { command: "new" } as JsonValue,
    });
    const current = '{"mcpServers":{"viberevert":{"command":"old"}}}';
    const result = classifyOp({ op, ctx: makeCtx(), recordOp: null, currentBytes: current });
    expect(result.kind).toBe("would-apply");
  });
  it("json-key-merge + invalid JSON in currentBytes -> SyntaxError propagates", () => {
    const op = makeJsonKeyMergeOp();
    expect(() =>
      classifyOp({ op, ctx: makeCtx(), recordOp: null, currentBytes: "not valid json {" }),
    ).toThrow(SyntaxError);
  });
});

// ===========================================================================
// G. Purity -- classifyOp does not mutate its inputs
// ===========================================================================

describe("classifyOp -- purity", () => {
  it("does not mutate op, ctx, recordOp, or currentBytes during classification", () => {
    const op = makeWriteNewOp({ content: "hello\n" });
    const ctx = makeCtx();
    const recordOp = makeWriteNewRecord({ fullFileSha256AfterWrite: SHA_A });
    const currentBytes = "current\n";

    // For ctx, convert the Date field to an ISO string before comparison
    // to sidestep Date-equality runtime quirks.
    const opBefore = structuredClone(op);
    const ctxBefore = { ...ctx, now: ctx.now.toISOString() };
    const recordOpBefore = structuredClone(recordOp);
    const currentBytesBefore = currentBytes;

    classifyOp({ op, ctx, recordOp, currentBytes });

    expect(structuredClone(op)).toEqual(opBefore);
    expect({ ...ctx, now: ctx.now.toISOString() }).toEqual(ctxBefore);
    expect(structuredClone(recordOp)).toEqual(recordOpBefore);
    expect(currentBytes).toBe(currentBytesBefore);
  });
});

// ===========================================================================
// H. makeCtx() default verification (proves forceReinstall defaults to false
// across the suite -- if this test ever drifts, every "drift refuses" test
// above is suspect).
// ===========================================================================

describe("makeCtx() default ctx options", () => {
  it("drift with default ctx refuses (proves forceReinstall defaults to false)", () => {
    const op = makeWriteNewOp({ content: "hello\n" });
    const recordOp = makeWriteNewRecord({ fullFileSha256AfterWrite: SHA_B });
    const result = classifyOp({ op, ctx: makeCtx(), recordOp, currentBytes: "drifted\n" });
    expect(result.kind).toBe("would-refuse");
    if (result.kind === "would-refuse") {
      expect(result.reasonCode).toBe(DRIFT_REASON_CODE);
    }
  });
});
