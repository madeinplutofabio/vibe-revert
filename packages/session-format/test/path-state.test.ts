// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M 0.8.0 step 0 -- PathState two-axis contract.
//
// PathState is nested inside the session contribution and never written
// standalone, but it is persisted-format substrate: selective restore compares
// these structures to decide what to mutate, and 1.1.0 subtraction reads them
// as historical evidence. So the axis independence, the closed enums, and the
// canonical unmerged form are all contract, and are tested directly here rather
// than only incidentally through contribution.test.ts.

import { describe, expect, it } from "vitest";

import {
  IndexEntryModeSchema,
  IndexStateSchema,
  PathStateSchema,
  UnsupportedFsKindSchema,
  WorktreeStateSchema,
} from "../src/index.js";

// A 40-hex SHA-1 and a 64-hex SHA-256 Git object id. Both are accepted by the
// oid validator because Git supports both object formats.
const OID_SHA1 = "0".repeat(40);
const OID_SHA256 = "c".repeat(64);

// A content-addressed object-store reference. Note this is 64 hex like
// OID_SHA256 and would pass the oid validator too -- the two are NOT
// interchangeable semantically (a Git blob oid hashes a header-prefixed
// payload, this hashes raw bytes), which is exactly why they are separate atoms.
const BLOB = "a".repeat(64);

// =============================================================================
// Worktree axis
// =============================================================================

describe("WorktreeStateSchema", () => {
  it("accepts absent", () => {
    expect(WorktreeStateSchema.safeParse({ kind: "absent" }).success).toBe(true);
  });

  it("accepts a regular file with an observed executable bit", () => {
    expect(
      WorktreeStateSchema.safeParse({
        kind: "regular",
        content_ref: BLOB,
        executable: true,
      }).success,
    ).toBe(true);
    expect(
      WorktreeStateSchema.safeParse({
        kind: "regular",
        content_ref: BLOB,
        executable: false,
      }).success,
    ).toBe(true);
  });

  it("accepts a regular file whose executable bit is unobservable (null)", () => {
    expect(
      WorktreeStateSchema.safeParse({
        kind: "regular",
        content_ref: BLOB,
        executable: null,
      }).success,
    ).toBe(true);
  });

  it("requires executable to be present even when unknown", () => {
    // Nullable, not optional: a producer must state what it observed. Omitting
    // the key would let "not observed" and "forgot to record" look identical.
    expect(WorktreeStateSchema.safeParse({ kind: "regular", content_ref: BLOB }).success).toBe(
      false,
    );
  });

  it("keeps null distinct from false", () => {
    const unknown = WorktreeStateSchema.parse({
      kind: "regular",
      content_ref: BLOB,
      executable: null,
    });
    const notExecutable = WorktreeStateSchema.parse({
      kind: "regular",
      content_ref: BLOB,
      executable: false,
    });
    // null must never be coerced to false: "unknown" is not an assertion that
    // the file is non-executable.
    expect(unknown).not.toEqual(notExecutable);
  });

  it("rejects a non-sha256 content_ref", () => {
    expect(
      WorktreeStateSchema.safeParse({
        kind: "regular",
        content_ref: "nope",
        executable: null,
      }).success,
    ).toBe(false);
  });

  it("accepts a symlink carrying its raw target digest", () => {
    expect(WorktreeStateSchema.safeParse({ kind: "symlink", target_ref: BLOB }).success).toBe(true);
  });

  it("accepts a directory", () => {
    expect(WorktreeStateSchema.safeParse({ kind: "directory" }).success).toBe(true);
  });

  it.each([
    "fifo",
    "socket",
    "block_device",
    "character_device",
    "unknown",
  ])("accepts unsupported fs_kind %s", (fsKind) => {
    expect(WorktreeStateSchema.safeParse({ kind: "unsupported", fs_kind: fsKind }).success).toBe(
      true,
    );
  });

  it("rejects an fs_kind outside the closed set", () => {
    expect(WorktreeStateSchema.safeParse({ kind: "unsupported", fs_kind: "quantum" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown worktree kind", () => {
    expect(WorktreeStateSchema.safeParse({ kind: "hardlink" }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      WorktreeStateSchema.safeParse({ kind: "absent", mtime: "2026-01-01T00:00:00Z" }).success,
    ).toBe(false);
  });
});

// =============================================================================
// Index axis
// =============================================================================

describe("IndexStateSchema", () => {
  it("accepts absent", () => {
    expect(IndexStateSchema.safeParse({ kind: "absent" }).success).toBe(true);
  });

  it.each(["100644", "100755", "120000", "160000"])("accepts index mode %s", (mode) => {
    expect(IndexStateSchema.safeParse({ kind: "entry", mode, oid: OID_SHA1 }).success).toBe(true);
  });

  it("rejects a tree mode as a path entry", () => {
    expect(
      IndexStateSchema.safeParse({ kind: "entry", mode: "040000", oid: OID_SHA1 }).success,
    ).toBe(false);
  });

  it("accepts both Git object formats", () => {
    expect(
      IndexStateSchema.safeParse({ kind: "entry", mode: "100644", oid: OID_SHA1 }).success,
    ).toBe(true);
    expect(
      IndexStateSchema.safeParse({ kind: "entry", mode: "100644", oid: OID_SHA256 }).success,
    ).toBe(true);
  });

  it("rejects a wrong-width oid", () => {
    expect(
      IndexStateSchema.safeParse({ kind: "entry", mode: "100644", oid: "0".repeat(39) }).success,
    ).toBe(false);
    expect(
      IndexStateSchema.safeParse({ kind: "entry", mode: "100644", oid: "0".repeat(41) }).success,
    ).toBe(false);
  });

  it("rejects an uppercase-hex oid", () => {
    expect(
      IndexStateSchema.safeParse({ kind: "entry", mode: "100644", oid: "A".repeat(40) }).success,
    ).toBe(false);
  });

  const stage = (n: 1 | 2 | 3) => ({ stage: n, mode: "100644" as const, oid: OID_SHA1 });

  it("accepts canonical unmerged stages", () => {
    expect(IndexStateSchema.safeParse({ kind: "unmerged", entries: [stage(1)] }).success).toBe(
      true,
    );
    expect(
      IndexStateSchema.safeParse({ kind: "unmerged", entries: [stage(2), stage(3)] }).success,
    ).toBe(true);
    expect(
      IndexStateSchema.safeParse({
        kind: "unmerged",
        entries: [stage(1), stage(2), stage(3)],
      }).success,
    ).toBe(true);
  });

  it("rejects unmerged stages out of ascending order", () => {
    expect(
      IndexStateSchema.safeParse({ kind: "unmerged", entries: [stage(2), stage(1)] }).success,
    ).toBe(false);
  });

  it("rejects duplicate unmerged stages", () => {
    expect(
      IndexStateSchema.safeParse({ kind: "unmerged", entries: [stage(1), stage(1)] }).success,
    ).toBe(false);
  });

  it("rejects an empty unmerged entry list", () => {
    expect(IndexStateSchema.safeParse({ kind: "unmerged", entries: [] }).success).toBe(false);
  });

  it("rejects more than three unmerged stages", () => {
    expect(
      IndexStateSchema.safeParse({
        kind: "unmerged",
        entries: [stage(1), stage(2), stage(3), stage(3)],
      }).success,
    ).toBe(false);
  });

  it("rejects a stage number outside 1..3", () => {
    expect(
      IndexStateSchema.safeParse({
        kind: "unmerged",
        entries: [{ stage: 0, mode: "100644", oid: OID_SHA1 }],
      }).success,
    ).toBe(false);
  });
});

// =============================================================================
// PathState -- the two axes are independent
// =============================================================================

describe("PathStateSchema", () => {
  it("requires both axes", () => {
    expect(PathStateSchema.safeParse({ worktree: { kind: "absent" } }).success).toBe(false);
    expect(PathStateSchema.safeParse({ index: { kind: "absent" } }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      PathStateSchema.safeParse({
        worktree: { kind: "absent" },
        index: { kind: "absent" },
        head: OID_SHA1,
      }).success,
    ).toBe(false);
  });

  it("represents an unstaged deletion", () => {
    // HEAD has it, index has it, worktree does not. A single discriminant
    // would have to drop one of these facts.
    expect(
      PathStateSchema.safeParse({
        worktree: { kind: "absent" },
        index: { kind: "entry", mode: "100644", oid: OID_SHA1 },
      }).success,
    ).toBe(true);
  });

  it("represents a staged deletion with a file present on disk", () => {
    // The mirror image of the case above, and the reason the axes are separate.
    expect(
      PathStateSchema.safeParse({
        worktree: { kind: "regular", content_ref: BLOB, executable: null },
        index: { kind: "absent" },
      }).success,
    ).toBe(true);
  });

  it("represents an untracked file", () => {
    expect(
      PathStateSchema.safeParse({
        worktree: { kind: "regular", content_ref: BLOB, executable: false },
        index: { kind: "absent" },
      }).success,
    ).toBe(true);
  });

  it("represents a fully absent path", () => {
    expect(
      PathStateSchema.safeParse({
        worktree: { kind: "absent" },
        index: { kind: "absent" },
      }).success,
    ).toBe(true);
  });

  it("represents a gitlink recorded but not restorable", () => {
    expect(
      PathStateSchema.safeParse({
        worktree: { kind: "directory" },
        index: { kind: "entry", mode: "160000", oid: OID_SHA1 },
      }).success,
    ).toBe(true);
  });
});

// =============================================================================
// Exported enums
// =============================================================================

describe("exported enums are closed", () => {
  it("IndexEntryModeSchema admits exactly the four file modes", () => {
    expect(IndexEntryModeSchema.options).toEqual(["100644", "100755", "120000", "160000"]);
  });

  it("UnsupportedFsKindSchema admits exactly the five observed kinds", () => {
    expect(UnsupportedFsKindSchema.options).toEqual([
      "fifo",
      "socket",
      "block_device",
      "character_device",
      "unknown",
    ]);
  });
});
