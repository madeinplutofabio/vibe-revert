// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { Buffer } from "node:buffer";
import { mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AdapterContext,
  ApplicablePlan,
  FileEditOp,
  JsonValue,
  PathSpec,
  RefusedPlan,
} from "@viberevert/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ADOPTION_HUMAN_SUMMARY,
  DRIFT_REASON_CODE,
  DUPLICATE_PLAN_PATH_REASON_CODE,
  DUPLICATE_RECORD_PATH_REASON_CODE,
  EMPTY_PLAN_REASON_CODE,
  sha256OfUtf8,
} from "../src/engine-classify.js";
import { preview } from "../src/engine-preview.js";
import type { RecordKey } from "../src/engine-types.js";
import {
  IntegrationsCorruptedError,
  IntegrationsSchemaVersionError,
  IntegrationTargetTooLargeError,
  SymlinkTargetRefusal,
} from "../src/errors.js";
import type {
  IntegrationFileEditRecord,
  IntegrationRecord,
  IntegrationsFile,
} from "../src/integrations-schema.js";
import { writeIntegrationsFile } from "../src/integrations-store.js";
import { MAX_MERGE_BYTES } from "../src/preflight-target.js";

import { createTempRepo, SYMLINKS_SUPPORTED } from "./helpers/temp-repo.js";

// Fixed SHA-shaped constants -- accidental wrong-length inputs are impossible.
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

let tempRepo: Awaited<ReturnType<typeof createTempRepo>>;

beforeEach(async () => {
  tempRepo = await createTempRepo();
});

afterEach(async () => {
  await tempRepo.cleanup();
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function viberevertPath(): string {
  return join(tempRepo.repoRoot, ".viberevert");
}

function integrationsJsonPath(): string {
  return join(viberevertPath(), "integrations.json");
}

// ---------------------------------------------------------------------------
// AdapterContext factory with options-deep-merge (preserves the 2J.d1
// pattern: per-flag overrides without dropping the other defaults).
// ---------------------------------------------------------------------------

type AdapterContextOverrides = Omit<Partial<AdapterContext>, "options"> & {
  readonly options?: Partial<AdapterContext["options"]>;
};

function makeCtx(overrides: AdapterContextOverrides = {}): AdapterContext {
  const base: AdapterContext = {
    repoRoot: tempRepo.repoRoot,
    now: new Date("2026-06-27T12:00:00.000Z"),
    cliVersion: "0.7.1-beta.0",
    intent: "explicit",
    options: { forceReinstall: false, migrateFromHookInstall: false, forceUninstall: false },
  };
  return {
    ...base,
    ...overrides,
    options: { ...base.options, ...overrides.options },
  };
}

function forcedCtx(): AdapterContext {
  return makeCtx({ options: { forceReinstall: true } });
}

// ---------------------------------------------------------------------------
// Plan + op factories
// ---------------------------------------------------------------------------

function makePathSpec(pathRelative: string): PathSpec {
  return {
    scope: "repo",
    pathTemplate: `{repo}/${pathRelative}`,
    pathRelative,
  };
}

function makeWriteNewOp(
  pathRelative: string,
  overrides: Partial<Extract<FileEditOp, { kind: "write-new" }>> = {},
): FileEditOp {
  return {
    kind: "write-new",
    target: makePathSpec(pathRelative),
    content: "hello\n",
    ...overrides,
  };
}

function makeJsonKeyMergeOp(
  pathRelative: string,
  overrides: Partial<Extract<FileEditOp, { kind: "json-key-merge" }>> = {},
): FileEditOp {
  return {
    kind: "json-key-merge",
    target: makePathSpec(pathRelative),
    keyPath: ["mcpServers", "viberevert"],
    value: { command: "viberevert" } as JsonValue,
    ...overrides,
  };
}

function makeApplicablePlan(overrides: Partial<ApplicablePlan> = {}): ApplicablePlan {
  return {
    status: "applicable",
    adapterName: "test-adapter",
    humanSummary: "test plan summary",
    ops: [makeWriteNewOp("test.json")],
    recordKey: "cursor",
    meta: {},
    ...overrides,
  };
}

function makeRefusedPlan(overrides: Partial<RefusedPlan> = {}): RefusedPlan {
  return {
    status: "refused",
    adapterName: "test-adapter",
    reasonCode: "adapter-refused-test",
    message: "refused for test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// IntegrationsFile + record factories
// ---------------------------------------------------------------------------

function makeIntegrationsFile(overrides: Partial<IntegrationsFile> = {}): IntegrationsFile {
  return {
    schemaVersion: 1,
    createdByVersion: "0.7.1-beta.0",
    updatedByVersion: "0.7.1-beta.0",
    records: {},
    history: [],
    ...overrides,
  };
}

function makeIntegrationRecord(
  recordKey: RecordKey,
  ops: ReadonlyArray<IntegrationFileEditRecord>,
  overrides: Partial<IntegrationRecord> = {},
): IntegrationRecord {
  return {
    recordKey,
    adapterName: `${recordKey}-test`,
    installedAt: "2026-06-27T12:00:00.000Z",
    installedByVersion: "0.7.1-beta.0",
    ops: [...ops],
    meta: {},
    ...overrides,
  };
}

/**
 * Path-aware record factory. Produces an IntegrationFileEditRecord whose
 * `target` (and `blockId` / `jsonKeyPath` where applicable) matches the
 * plan op, so the orchestrator's `record.ops.filter(r => r.target.pathRelative
 * === op.target.pathRelative)` actually matches. Tests pass only SHA
 * overrides for noop / drift fixtures.
 */
function makeRecordOpFor(
  planOp: FileEditOp,
  overrides: Partial<IntegrationFileEditRecord> = {},
): IntegrationFileEditRecord {
  const target = planOp.target;
  switch (planOp.kind) {
    case "write-new":
      return {
        kind: "write-new",
        target,
        backup: null,
        managedBlockSha256: null,
        managedValueSha256: null,
        fullFileSha256AfterWrite: SHA_A,
        blockId: null,
        jsonKeyPath: null,
        mode: null,
        ...overrides,
      };
    case "backup-and-write":
      return {
        kind: "backup-and-write",
        target,
        backup: makePathSpec(".viberevert/integration-backups/test/group/file"),
        managedBlockSha256: null,
        managedValueSha256: null,
        fullFileSha256AfterWrite: SHA_A,
        blockId: null,
        jsonKeyPath: null,
        mode: null,
        ...overrides,
      };
    case "sentinel-block-insert":
    case "sentinel-block-replace":
      return {
        kind: planOp.kind,
        target,
        backup: null,
        managedBlockSha256: SHA_A,
        managedValueSha256: null,
        fullFileSha256AfterWrite: null,
        blockId: planOp.blockId,
        jsonKeyPath: null,
        mode: null,
        ...overrides,
      };
    case "json-key-merge":
      return {
        kind: "json-key-merge",
        target,
        backup: null,
        managedBlockSha256: null,
        managedValueSha256: SHA_A,
        fullFileSha256AfterWrite: null,
        blockId: null,
        jsonKeyPath: [...planOp.keyPath],
        mode: null,
        ...overrides,
      };
  }
}

// ===========================================================================
// A. Refused-plan passthrough
// ===========================================================================

describe("preview -- refused-plan passthrough", () => {
  it("forwards refused plan verbatim when manualSnippet is present", async () => {
    const plan = makeRefusedPlan({
      adapterName: "cursor",
      reasonCode: "config-shape-bad",
      message: "manual install required",
      manualSnippet: "echo 'paste this'",
    });
    const result = await preview(plan, makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.adapterName).toBe("cursor");
      expect(result.reasonCode).toBe("config-shape-bad");
      expect(result.manualSnippet).toBe("echo 'paste this'");
    }
  });

  it("omits manualSnippet property when adapter plan did not supply one (exactOptionalPropertyTypes-faithful)", async () => {
    // Source spread is conditional: `...(plan.manualSnippet !== undefined
    // ? { manualSnippet: plan.manualSnippet } : {})`. Result must NOT have
    // a manualSnippet key at all -- not `manualSnippet: undefined`.
    const plan = makeRefusedPlan({ adapterName: "claude" });
    const result = await preview(plan, makeCtx());
    expect(result.status).toBe("refused");
    expect(result).not.toHaveProperty("manualSnippet");
  });

  it("does not create .viberevert/ during refused-plan passthrough", async () => {
    // Early return must precede preflight, store reads, and target reads.
    // If .viberevert/ ever appears after a refused-plan preview, the
    // top-of-function passthrough has regressed.
    const plan = makeRefusedPlan();
    await preview(plan, makeCtx());
    await expect(stat(viberevertPath())).rejects.toThrow();
  });
});

// ===========================================================================
// B. Empty applicable plan
// ===========================================================================

describe("preview -- empty applicable plan", () => {
  it("returns refused with EMPTY_PLAN_REASON_CODE when plan.ops is empty", async () => {
    const plan = makeApplicablePlan({ ops: [] });
    const result = await preview(plan, makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reasonCode).toBe(EMPTY_PLAN_REASON_CODE);
    }
  });
});

// ===========================================================================
// C. Duplicate plan target paths
// ===========================================================================

describe("preview -- duplicate plan target paths", () => {
  it("refuses the whole plan with DUPLICATE_PLAN_PATH_REASON_CODE", async () => {
    const plan = makeApplicablePlan({
      ops: [makeWriteNewOp("dup.json"), makeWriteNewOp("dup.json")],
    });
    const result = await preview(plan, makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reasonCode).toBe(DUPLICATE_PLAN_PATH_REASON_CODE);
      // Detail surfaces the duplicate path so users can locate it.
      expect(result.message).toContain("dup.json");
    }
  });
});

// ===========================================================================
// D. Preflight error propagation
// ===========================================================================

describe.skipIf(!SYMLINKS_SUPPORTED)("preview -- symlinked target propagation", () => {
  it("propagates SymlinkTargetRefusal when the op target itself is a symlink", async () => {
    // Create a real backing file, then make the would-be target a symlink
    // to it. assertSafeTarget must refuse before any classification work.
    const realFile = join(tempRepo.repoRoot, "real-backing");
    await writeFile(realFile, "backing\n");
    const symlinkedTarget = join(tempRepo.repoRoot, "linked.json");
    await symlink(realFile, symlinkedTarget, "file");

    const plan = makeApplicablePlan({ ops: [makeWriteNewOp("linked.json")] });
    await expect(preview(plan, makeCtx())).rejects.toBeInstanceOf(SymlinkTargetRefusal);
  });
});

describe("preview -- merge-target size limit propagation", () => {
  it("propagates IntegrationTargetTooLargeError for json-key-merge target > MAX_MERGE_BYTES", async () => {
    // json-key-merge resolves to a 'merge' preflight op which size-checks.
    // write-new / backup-and-write use 'write' preflight which intentionally
    // skips the size check.
    const targetPath = join(tempRepo.repoRoot, "big.json");
    await writeFile(targetPath, Buffer.alloc(MAX_MERGE_BYTES + 1, "x"));

    const plan = makeApplicablePlan({
      ops: [makeJsonKeyMergeOp("big.json")],
    });
    await expect(preview(plan, makeCtx())).rejects.toBeInstanceOf(IntegrationTargetTooLargeError);
  });
});

// ===========================================================================
// E. Store error propagation (hand-written invalid stores)
// ===========================================================================

describe("preview -- store error propagation", () => {
  it("propagates IntegrationsCorruptedError from hand-written invalid-JSON store", async () => {
    // Hand-written rather than writeIntegrationsFile: corruption fixtures
    // must bypass the valid-only serializer.
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), "not valid json {");
    const plan = makeApplicablePlan();
    await expect(preview(plan, makeCtx())).rejects.toBeInstanceOf(IntegrationsCorruptedError);
  });

  it("propagates IntegrationsSchemaVersionError from hand-written wrong-version store", async () => {
    await mkdir(viberevertPath());
    await writeFile(integrationsJsonPath(), JSON.stringify({ schemaVersion: 2 }));
    const plan = makeApplicablePlan();
    await expect(preview(plan, makeCtx())).rejects.toBeInstanceOf(IntegrationsSchemaVersionError);
  });
});

// ===========================================================================
// F. Aggregation outcomes
// ===========================================================================

describe("preview -- aggregation: all would-noop -> outcome noop", () => {
  it("returns noop when every op classifies as would-noop", async () => {
    const path1 = "noop-a.json";
    const path2 = "noop-b.json";
    const content1 = "noop-content-a\n";
    const content2 = "noop-content-b\n";
    await writeFile(join(tempRepo.repoRoot, path1), content1);
    await writeFile(join(tempRepo.repoRoot, path2), content2);

    const op1 = makeWriteNewOp(path1, { content: content1 });
    const op2 = makeWriteNewOp(path2, { content: content2 });

    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op1, { fullFileSha256AfterWrite: sha256OfUtf8(content1) }),
      makeRecordOpFor(op2, { fullFileSha256AfterWrite: sha256OfUtf8(content2) }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const plan = makeApplicablePlan({ ops: [op1, op2] });
    const result = await preview(plan, makeCtx());
    expect(result.status).toBe("noop");
    if (result.status === "noop") {
      expect(result.recordKey).toBe("cursor");
      expect(result.adapterName).toBe("test-adapter");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("preview -- aggregation: only noop+adopt with at least one adopt -> applicable adoption", () => {
  it("returns applicable with empty diff.perFile and ADOPTION_HUMAN_SUMMARY", async () => {
    // op A: record exists + current matches recorded + desired matches -> noop
    // op B: NO record + current already matches desired -> adopt
    const noopPath = "noop.json";
    const adoptPath = "adopt.json";
    const noopContent = "noop-content\n";
    const adoptContent = "adopt-content\n";
    await writeFile(join(tempRepo.repoRoot, noopPath), noopContent);
    await writeFile(join(tempRepo.repoRoot, adoptPath), adoptContent);

    const noopOp = makeWriteNewOp(noopPath, { content: noopContent });
    const adoptOp = makeWriteNewOp(adoptPath, { content: adoptContent });

    // Record covers ONLY the noop op; adoptOp gets no matching record entry
    // -> classifier's no-record adoption path fires.
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(noopOp, { fullFileSha256AfterWrite: sha256OfUtf8(noopContent) }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const plan = makeApplicablePlan({ ops: [noopOp, adoptOp] });
    const result = await preview(plan, makeCtx());
    expect(result.status).toBe("applicable");
    if (result.status === "applicable") {
      expect(result.diff.perFile).toEqual([]);
      expect(result.humanSummary).toBe(ADOPTION_HUMAN_SUMMARY);
    }
  });
});

describe("preview -- aggregation: mixed apply+noop -> applicable with per-op diff", () => {
  it("returns applicable carrying plan.humanSummary and diff entries for apply ops only", async () => {
    // op A: no record + missing target -> would-apply (contributes diff)
    // op B: record + current matches recorded + desired matches -> noop (no diff)
    const applyPath = "apply.json";
    const noopPath = "noop.json";
    const noopContent = "noop-content\n";
    await writeFile(join(tempRepo.repoRoot, noopPath), noopContent);

    const applyOp = makeWriteNewOp(applyPath, { content: "new-content\n" });
    const noopOp = makeWriteNewOp(noopPath, { content: noopContent });

    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(noopOp, { fullFileSha256AfterWrite: sha256OfUtf8(noopContent) }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const plan = makeApplicablePlan({
      humanSummary: "install adapter",
      ops: [applyOp, noopOp],
    });
    const result = await preview(plan, makeCtx());
    expect(result.status).toBe("applicable");
    if (result.status === "applicable") {
      expect(result.humanSummary).toBe("install adapter");
      expect(result.diff.perFile).toHaveLength(1);
      const entry = result.diff.perFile[0];
      expect(entry).toBeDefined();
      if (entry !== undefined) {
        expect(entry.pathRelative).toBe(applyPath);
        expect(entry.opKind).toBe("write-new");
        expect(entry.unifiedDiff.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("preview -- aggregation: single applicable write-new -> one diff entry", () => {
  it("returns applicable with one perFile entry for a new file", async () => {
    const plan = makeApplicablePlan({
      ops: [makeWriteNewOp("fresh.json", { content: "x\n" })],
    });
    const result = await preview(plan, makeCtx());
    expect(result.status).toBe("applicable");
    if (result.status === "applicable") {
      expect(result.diff.perFile).toHaveLength(1);
      const entry = result.diff.perFile[0];
      expect(entry).toBeDefined();
      if (entry !== undefined) {
        expect(entry.pathRelative).toBe("fresh.json");
        expect(entry.opKind).toBe("write-new");
        expect(entry.unifiedDiff.length).toBeGreaterThan(0);
      }
    }
  });
});

// ===========================================================================
// G. Aggregated per-op refusals
// ===========================================================================

describe("preview -- aggregation: per-op refusals collected", () => {
  it("returns refused with first reasonCode + both target paths surfaced in the message", async () => {
    // Two drifting ops, DISTINCT paths to avoid the duplicate-plan-path
    // short-circuit. Both write-new so SHA extraction never throws.
    const path1 = "drift-a.json";
    const path2 = "drift-b.json";
    const current1 = "user-edit-a\n";
    const current2 = "user-edit-b\n";
    await writeFile(join(tempRepo.repoRoot, path1), current1);
    await writeFile(join(tempRepo.repoRoot, path2), current2);

    const op1 = makeWriteNewOp(path1, { content: "desired-a\n" });
    const op2 = makeWriteNewOp(path2, { content: "desired-b\n" });

    // Record SHAs deliberately mismatch the on-disk current bytes -> drift.
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op1, { fullFileSha256AfterWrite: SHA_B }),
      makeRecordOpFor(op2, { fullFileSha256AfterWrite: SHA_B }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const plan = makeApplicablePlan({ ops: [op1, op2] });
    const result = await preview(plan, makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      // First refusal in plan.ops order sets the top-level reasonCode.
      expect(result.reasonCode).toBe(DRIFT_REASON_CODE);
      // Resilient: assert both target paths appear in the message; do not
      // require exact prose.
      expect(result.message).toContain(path1);
      expect(result.message).toContain(path2);
    }
  });
});

// ===========================================================================
// H. Duplicate-record-path refusal
// ===========================================================================

describe("preview -- duplicate record path for plan target", () => {
  it("returns refused with DUPLICATE_RECORD_PATH_REASON_CODE when integrations record has 2+ ops on the same plan-target path", async () => {
    // Plan has ONE op; record has TWO ops on that same path. Schema permits
    // duplicate ops in `ops: z.array(...).min(1)` (no uniqueness refinement),
    // so this writes cleanly via the real serializer.
    const targetPath = "shared.json";
    const op = makeWriteNewOp(targetPath, { content: "x\n" });

    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op, { fullFileSha256AfterWrite: SHA_A }),
      makeRecordOpFor(op, { fullFileSha256AfterWrite: SHA_B }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const plan = makeApplicablePlan({ ops: [op] });
    const result = await preview(plan, makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reasonCode).toBe(DUPLICATE_RECORD_PATH_REASON_CODE);
    }
  });
});

// ===========================================================================
// I. Force scope at the preview boundary
// ===========================================================================

describe("preview -- force scope at the preview boundary", () => {
  // Same fixture twice: prove forceReinstall=true is the ONLY thing that
  // flips drift refusal to applicable.

  async function setupDriftFixture(): Promise<{ readonly plan: ApplicablePlan }> {
    const targetPath = "drift.json";
    await writeFile(join(tempRepo.repoRoot, targetPath), "user-edited\n");
    const op = makeWriteNewOp(targetPath, { content: "desired\n" });
    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(op, { fullFileSha256AfterWrite: SHA_B }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });
    return { plan: makeApplicablePlan({ ops: [op] }) };
  }

  it("default ctx (forceReinstall=false) -> refused with DRIFT_REASON_CODE", async () => {
    const { plan } = await setupDriftFixture();
    const result = await preview(plan, makeCtx());
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reasonCode).toBe(DRIFT_REASON_CODE);
    }
  });

  it("forcedCtx (forceReinstall=true) -> applicable", async () => {
    const { plan } = await setupDriftFixture();
    const result = await preview(plan, forcedCtx());
    expect(result.status).toBe("applicable");
  });
});

// ===========================================================================
// J. Read-only contract
// ===========================================================================

describe("preview -- read-only contract", () => {
  it("does not create .viberevert/, lock, journal, integrations.json, target parent, or target on applicable plan", async () => {
    // Fresh repo: NO pre-existing .viberevert/. Plan targets a nested path
    // that does not exist. Preview should classify as would-apply and
    // aggregate as applicable WITHOUT mutating the filesystem -- not even
    // a parent directory.
    const targetPath = "nested/file.json";
    const plan = makeApplicablePlan({
      ops: [makeWriteNewOp(targetPath, { content: "x\n" })],
    });

    const result = await preview(plan, makeCtx());
    expect(result.status).toBe("applicable");

    // .viberevert/ and every artifact path under it must NOT exist.
    await expect(stat(viberevertPath())).rejects.toThrow();
    await expect(stat(join(viberevertPath(), "integrations.lock"))).rejects.toThrow();
    await expect(stat(join(viberevertPath(), "integration-journal"))).rejects.toThrow();
    await expect(stat(integrationsJsonPath())).rejects.toThrow();

    // Target's parent dir AND the target itself must NOT have been created.
    await expect(stat(join(tempRepo.repoRoot, "nested"))).rejects.toThrow();
    await expect(stat(join(tempRepo.repoRoot, "nested", "file.json"))).rejects.toThrow();
  });
});

// ===========================================================================
// K. Diff ordering (apply+noop+safe-update)
// ===========================================================================

describe("preview -- diff ordering preserves plan.ops order, omits noop/adopt entries", () => {
  it("emits apply and safe-update entries in plan.ops order; noop contributes no entry", async () => {
    // op A (apply): no record + missing target -> would-apply
    // op B (noop): record + current matches recorded + desired matches
    // op C (safe-update): record + current matches recorded + desired differs
    const applyPath = "ordering-a-apply.json";
    const noopPath = "ordering-b-noop.json";
    const safeUpdatePath = "ordering-c-safeupdate.json";

    const noopContent = "noop-content\n";
    const safeUpdateOldContent = "old\n";

    await writeFile(join(tempRepo.repoRoot, noopPath), noopContent);
    await writeFile(join(tempRepo.repoRoot, safeUpdatePath), safeUpdateOldContent);

    const applyOp = makeWriteNewOp(applyPath, { content: "new\n" });
    const noopOp = makeWriteNewOp(noopPath, { content: noopContent });
    const safeUpdateOp = makeWriteNewOp(safeUpdatePath, { content: "new\n" });

    const record = makeIntegrationRecord("cursor", [
      makeRecordOpFor(noopOp, { fullFileSha256AfterWrite: sha256OfUtf8(noopContent) }),
      makeRecordOpFor(safeUpdateOp, {
        fullFileSha256AfterWrite: sha256OfUtf8(safeUpdateOldContent),
      }),
    ]);
    await writeIntegrationsFile({
      repoRoot: tempRepo.repoRoot,
      next: makeIntegrationsFile({ records: { cursor: record } }),
      backupGroupId: "init",
    });

    const plan = makeApplicablePlan({ ops: [applyOp, noopOp, safeUpdateOp] });
    const result = await preview(plan, makeCtx());

    expect(result.status).toBe("applicable");
    if (result.status === "applicable") {
      // Noop omitted; apply + safe-update remain in plan.ops order.
      expect(result.diff.perFile).toHaveLength(2);
      expect(result.diff.perFile[0]?.pathRelative).toBe(applyPath);
      expect(result.diff.perFile[1]?.pathRelative).toBe(safeUpdatePath);
    }
  });
});

// ===========================================================================
// L. SyntaxError propagation from json-key-merge classifier
// ===========================================================================

describe("preview -- json-key-merge with invalid-JSON target propagates SyntaxError", () => {
  it("does not swallow SyntaxError raised by extractCurrentManagedRegionSha", async () => {
    const targetPath = "config.json";
    await writeFile(join(tempRepo.repoRoot, targetPath), "not valid json {");
    const plan = makeApplicablePlan({
      ops: [makeJsonKeyMergeOp(targetPath)],
    });
    await expect(preview(plan, makeCtx())).rejects.toThrow(SyntaxError);
  });
});
