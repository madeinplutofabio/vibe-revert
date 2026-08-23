// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M 0.8.0 step 0 -- session contribution schema + change-group derivation.
//
// =============================================================================
// Why the golden vectors are literals
// =============================================================================
//
// `deriveChangeGroupId` output is PERSISTED FORMAT: change-group ids land in
// contribution.json and control which changes a selective rollback mutates. So
// the vectors below are frozen literal digests, not `expect(a).toEqual(b)`
// between two calls of the same function. A round-trip assertion would stay
// green if the algorithm changed, because both sides would change together.
//
// The literals were produced by an INDEPENDENT implementation of the documented
// payload spec, not by calling the function under test. `derivePerSpec` below
// re-implements that spec a second time, so a drift between the documented
// algorithm and the shipped one fails here even if someone updates both the
// function and the literals. The independence is in where the logic came from
// -- separately written from the specification text -- not in how node:crypto
// is loaded.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CONTRIBUTION_FILE_SCHEMA_VERSION,
  ContentDeltaSchema,
  DiffHunkSchema,
  deriveChangeGroupId,
  type SessionContributionEntry,
  SessionContributionEntrySchema,
  SessionContributionFileSchema,
} from "../src/index.js";

// =============================================================================
// Fixtures
// =============================================================================

const SESSION_A = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION_B = "sess_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const CHECKPOINT = "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HEAD_A = "0".repeat(40);
const HEAD_B = "1".repeat(40);
const BLOB = "a".repeat(64);
const OID = "b".repeat(40);
const WHEN = "2026-01-01T00:00:00Z";

/** A single backslash, built without a backslash literal in a regex context. */
const BACKSLASH = String.fromCharCode(92);

/**
 * Non-ASCII vector path. Written as a plain literal for readability, with its
 * code points asserted separately: if this file's encoding is ever mangled, the
 * code-point assertion fails loudly instead of the golden digest silently
 * drifting.
 */
const NON_ASCII_PATH = "src/café/naïve.ts";

function regularState(contentRef = BLOB) {
  return {
    worktree: { kind: "regular" as const, content_ref: contentRef, executable: null },
    index: { kind: "entry" as const, mode: "100644" as const, oid: OID },
  };
}

function absentState() {
  return {
    worktree: { kind: "absent" as const },
    index: { kind: "absent" as const },
  };
}

function entry(overrides: Partial<SessionContributionEntry> = {}): SessionContributionEntry {
  const path = overrides.path ?? "src/foo.ts";
  const aliases = overrides.previous_path === undefined ? [path] : [path, overrides.previous_path];
  return {
    path,
    operation: "modified",
    facets: ["content_changed"],
    change_group_id: deriveChangeGroupId(SESSION_A, aliases),
    before: absentState(),
    after: regularState(),
    content_delta: { kind: "none" },
    ...overrides,
  } as SessionContributionEntry;
}

function contributionFile(entries: SessionContributionEntry[]) {
  return {
    schema_version: CONTRIBUTION_FILE_SCHEMA_VERSION,
    session_id: SESSION_A,
    checkpoint_id: CHECKPOINT,
    before_head_sha: HEAD_A,
    after_head_sha: HEAD_B,
    captured_at: WHEN,
    ended_at: WHEN,
    entries,
  };
}

// =============================================================================
// deriveChangeGroupId -- golden vectors
// =============================================================================

describe("deriveChangeGroupId golden vectors", () => {
  it("V1: single path", () => {
    expect(deriveChangeGroupId(SESSION_A, ["src/foo.ts"])).toBe(
      "cg_5dd8ca3db21bb1f68683e4f2c88c4bec2f56f6fce36a9dc8046e7e835fa3620c",
    );
  });

  it("V2: alias order does not affect the id", () => {
    const expected = "cg_030ccea938bab04359052cb323396388a6f05d7a939088321a68f913e0e57dca";
    expect(deriveChangeGroupId(SESSION_A, ["b/second.ts", "a/first.ts"])).toBe(expected);
    expect(deriveChangeGroupId(SESSION_A, ["a/first.ts", "b/second.ts"])).toBe(expected);
  });

  it("V3: duplicates and Windows separators canonicalize to the V1 id", () => {
    expect(
      deriveChangeGroupId(SESSION_A, [`src${BACKSLASH}foo.ts`, "src/foo.ts", "./src/foo.ts"]),
    ).toBe("cg_5dd8ca3db21bb1f68683e4f2c88c4bec2f56f6fce36a9dc8046e7e835fa3620c");
  });

  it("V4: the same path in a different session yields a different id", () => {
    expect(deriveChangeGroupId(SESSION_B, ["src/foo.ts"])).toBe(
      "cg_b5e69c9d0a2d6ec860a577b0287a1e9ab7455d9d371dca61fa296e93e80c5c25",
    );
    expect(deriveChangeGroupId(SESSION_B, ["src/foo.ts"])).not.toBe(
      deriveChangeGroupId(SESSION_A, ["src/foo.ts"]),
    );
  });

  it("V5: non-ASCII path", () => {
    // Encoding tripwire: if this file's bytes are ever re-encoded, this fails
    // before the digest assertion below can drift silently.
    expect([...NON_ASCII_PATH].map((c) => c.codePointAt(0))).toEqual([
      115, 114, 99, 47, 99, 97, 102, 0xe9, 47, 110, 97, 0xef, 118, 101, 46, 116, 115,
    ]);
    expect(deriveChangeGroupId(SESSION_A, [NON_ASCII_PATH])).toBe(
      "cg_414393a574f231d67901900393f547daab8c55235771a1d1de7c78197d9ffd70",
    );
  });

  it("V6: rename group of two aliases", () => {
    expect(deriveChangeGroupId(SESSION_A, ["payments/webhook.ts", "utils/webhook.ts"])).toBe(
      "cg_7f82797b8e02555a1f8cbc1a8cef4f883846382b3dacd558d85a2be4ed764eac",
    );
  });

  it("refuses an empty alias set", () => {
    expect(() => deriveChangeGroupId(SESSION_A, [])).toThrow(/at least one path/);
  });

  it("throws on an un-canonicalizable alias rather than hashing it", () => {
    expect(() => deriveChangeGroupId(SESSION_A, ["../escape.ts"])).toThrow();
  });
});

// =============================================================================
// deriveChangeGroupId -- independent spec cross-check
// =============================================================================

describe("deriveChangeGroupId matches an independent implementation of the spec", () => {
  /**
   * Second implementation of the documented payload, written from the spec text
   * rather than from the source: SHA-256 over "viberevert-change-group-v1" +
   * NUL + session_id + NUL + JSON.stringify(sorted unique canonical aliases),
   * prefixed "cg_".
   */
  function derivePerSpec(sessionId: string, aliases: readonly string[]): string {
    const canonical = Array.from(
      new Set(
        aliases.map((p) => {
          let s = p.split(BACKSLASH).join("/");
          while (s.startsWith("./")) s = s.slice(2);
          return s.replace(/\/+/g, "/");
        }),
      ),
    ).sort();
    const hash = createHash("sha256");
    hash.update("viberevert-change-group-v1", "utf8");
    hash.update(Uint8Array.from([0]));
    hash.update(sessionId, "utf8");
    hash.update(Uint8Array.from([0]));
    hash.update(JSON.stringify(canonical), "utf8");
    return `cg_${hash.digest("hex")}`;
  }

  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    [SESSION_A, ["src/foo.ts"]],
    [SESSION_A, ["b/second.ts", "a/first.ts"]],
    [SESSION_A, [`src${BACKSLASH}foo.ts`, "./src/foo.ts"]],
    [SESSION_B, ["src/foo.ts"]],
    [SESSION_A, [NON_ASCII_PATH]],
    [SESSION_A, ["payments/webhook.ts", "utils/webhook.ts"]],
  ];

  it.each(cases)("session %s, aliases %j", (sessionId, aliases) => {
    expect(deriveChangeGroupId(sessionId, aliases)).toBe(derivePerSpec(sessionId, aliases));
  });
});

// =============================================================================
// DiffHunk coordinate + count invariants
// =============================================================================

describe("DiffHunkSchema", () => {
  it("accepts a new-file hunk with a zero old side", () => {
    expect(
      DiffHunkSchema.safeParse({
        old_start: 0,
        old_lines: 0,
        new_start: 1,
        new_lines: 1,
        lines: [{ kind: "add", text: "hello" }],
      }).success,
    ).toBe(true);
  });

  it("accepts a zero-length old side with a positive start (insertion under -U0)", () => {
    expect(
      DiffHunkSchema.safeParse({
        old_start: 5,
        old_lines: 0,
        new_start: 6,
        new_lines: 2,
        lines: [
          { kind: "add", text: "a" },
          { kind: "add", text: "b" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a zero start on a non-empty old side", () => {
    expect(
      DiffHunkSchema.safeParse({
        old_start: 0,
        old_lines: 1,
        new_start: 1,
        new_lines: 1,
        lines: [
          { kind: "remove", text: "a" },
          { kind: "add", text: "b" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a zero start on a non-empty new side", () => {
    expect(
      DiffHunkSchema.safeParse({
        old_start: 1,
        old_lines: 1,
        new_start: 0,
        new_lines: 1,
        lines: [
          { kind: "remove", text: "a" },
          { kind: "add", text: "b" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects header counts that contradict the lines", () => {
    expect(
      DiffHunkSchema.safeParse({
        old_start: 10,
        old_lines: 99,
        new_start: 10,
        new_lines: 1,
        lines: [
          { kind: "remove", text: "a" },
          { kind: "add", text: "b" },
        ],
      }).success,
    ).toBe(false);
  });

  it("counts context lines against both sides", () => {
    expect(
      DiffHunkSchema.safeParse({
        old_start: 1,
        old_lines: 2,
        new_start: 1,
        new_lines: 2,
        lines: [
          { kind: "context", text: "keep" },
          { kind: "remove", text: "a" },
          { kind: "add", text: "b" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a context-only hunk", () => {
    expect(
      DiffHunkSchema.safeParse({
        old_start: 1,
        old_lines: 1,
        new_start: 1,
        new_lines: 1,
        lines: [{ kind: "context", text: "keep" }],
      }).success,
    ).toBe(false);
  });

  it("allows an empty line text", () => {
    expect(
      DiffHunkSchema.safeParse({
        old_start: 0,
        old_lines: 0,
        new_start: 1,
        new_lines: 1,
        lines: [{ kind: "add", text: "" }],
      }).success,
    ).toBe(true);
  });
});

// =============================================================================
// ContentDelta
// =============================================================================

describe("ContentDeltaSchema", () => {
  const hunk = (oldStart: number, newStart: number) => ({
    old_start: oldStart,
    old_lines: 0,
    new_start: newStart,
    new_lines: 1,
    lines: [{ kind: "add" as const, text: "x" }],
  });

  it("rejects a text delta with no hunks", () => {
    expect(ContentDeltaSchema.safeParse({ kind: "text", hunks: [] }).success).toBe(false);
  });

  it("accepts hunks in canonical file order", () => {
    expect(
      ContentDeltaSchema.safeParse({ kind: "text", hunks: [hunk(1, 2), hunk(5, 6)] }).success,
    ).toBe(true);
  });

  it("rejects hunks out of file order", () => {
    expect(
      ContentDeltaSchema.safeParse({ kind: "text", hunks: [hunk(5, 6), hunk(1, 2)] }).success,
    ).toBe(false);
  });

  it("rejects duplicate hunk coordinates", () => {
    expect(
      ContentDeltaSchema.safeParse({ kind: "text", hunks: [hunk(1, 2), hunk(1, 2)] }).success,
    ).toBe(false);
  });

  it("accepts binary and none without hunks", () => {
    expect(ContentDeltaSchema.safeParse({ kind: "binary" }).success).toBe(true);
    expect(ContentDeltaSchema.safeParse({ kind: "none" }).success).toBe(true);
  });
});

// =============================================================================
// Entry-level invariants
// =============================================================================

describe("SessionContributionEntrySchema", () => {
  it("requires previous_path on a rename", () => {
    const bad = { ...entry(), operation: "renamed" as const };
    expect(SessionContributionEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects previous_path on a non-rename", () => {
    const bad = { ...entry(), previous_path: "old/foo.ts" };
    expect(SessionContributionEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects previous_path equal to path", () => {
    const bad = {
      ...entry(),
      operation: "renamed" as const,
      previous_path: "src/foo.ts",
    };
    expect(SessionContributionEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unsorted facets", () => {
    const bad = { ...entry(), facets: ["mode_changed", "content_changed"] };
    expect(SessionContributionEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate facets", () => {
    const bad = { ...entry(), facets: ["content_changed", "content_changed"] };
    expect(SessionContributionEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("accepts an empty facet set", () => {
    expect(SessionContributionEntrySchema.safeParse({ ...entry(), facets: [] }).success).toBe(true);
  });
});

// =============================================================================
// File-level invariants
// =============================================================================

describe("SessionContributionFileSchema", () => {
  it("accepts an empty contribution", () => {
    expect(SessionContributionFileSchema.safeParse(contributionFile([])).success).toBe(true);
  });

  it("accepts entries sorted by path", () => {
    const file = contributionFile([entry({ path: "a.ts" }), entry({ path: "b.ts" })]);
    expect(SessionContributionFileSchema.safeParse(file).success).toBe(true);
  });

  it("rejects entries out of path order", () => {
    const file = contributionFile([entry({ path: "b.ts" }), entry({ path: "a.ts" })]);
    expect(SessionContributionFileSchema.safeParse(file).success).toBe(false);
  });

  it("rejects duplicate entry paths", () => {
    const file = contributionFile([entry({ path: "a.ts" }), entry({ path: "a.ts" })]);
    expect(SessionContributionFileSchema.safeParse(file).success).toBe(false);
  });

  it("rejects a change_group_id that is not the derived value", () => {
    const file = contributionFile([
      { ...entry({ path: "a.ts" }), change_group_id: `cg_${"0".repeat(64)}` },
    ]);
    expect(SessionContributionFileSchema.safeParse(file).success).toBe(false);
  });

  it("rejects a group id derived from the wrong session", () => {
    const file = contributionFile([
      { ...entry({ path: "a.ts" }), change_group_id: deriveChangeGroupId(SESSION_B, ["a.ts"]) },
    ]);
    expect(SessionContributionFileSchema.safeParse(file).success).toBe(false);
  });

  it("accepts a rename group whose id covers both aliases", () => {
    const file = contributionFile([
      entry({
        path: "utils/webhook.ts",
        operation: "renamed",
        previous_path: "payments/webhook.ts",
      }),
    ]);
    expect(SessionContributionFileSchema.safeParse(file).success).toBe(true);
  });

  it("rejects a rename group whose id omits the previous_path alias", () => {
    const file = contributionFile([
      {
        ...entry({
          path: "utils/webhook.ts",
          operation: "renamed",
          previous_path: "payments/webhook.ts",
        }),
        change_group_id: deriveChangeGroupId(SESSION_A, ["utils/webhook.ts"]),
      },
    ]);
    expect(SessionContributionFileSchema.safeParse(file).success).toBe(false);
  });

  it("rejects one alias claimed by two different change groups", () => {
    // `shared.ts` is the rename origin of one entry and the path of another,
    // so it would belong to two independently selectable groups.
    const renameEntry = entry({
      path: "moved.ts",
      operation: "renamed",
      previous_path: "shared.ts",
    });
    const ownEntry = entry({ path: "shared.ts" });
    const file = contributionFile(
      [ownEntry, renameEntry].sort((a, b) => (a.path < b.path ? -1 : 1)),
    );
    expect(SessionContributionFileSchema.safeParse(file).success).toBe(false);
  });

  it("rejects a malformed session id", () => {
    const file = { ...contributionFile([]), session_id: "sess_nope" };
    expect(SessionContributionFileSchema.safeParse(file).success).toBe(false);
  });

  it("rejects a non-hex head sha", () => {
    const file = { ...contributionFile([]), before_head_sha: "not-a-sha" };
    expect(SessionContributionFileSchema.safeParse(file).success).toBe(false);
  });

  it("rejects unsorted detected_frameworks_at_end", () => {
    const file = { ...contributionFile([]), detected_frameworks_at_end: ["nextjs", "laravel"] };
    expect(SessionContributionFileSchema.safeParse(file).success).toBe(false);
  });
});
