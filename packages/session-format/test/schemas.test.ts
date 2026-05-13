// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { describe, expect, it } from "vitest";
import {
  ActiveSessionLockJsonSchema,
  ActiveSessionLockSchema,
  ChangedFileJsonSchema,
  ChangedFileSchema,
  CheckResultJsonSchema,
  CheckResultSchema,
  EvidenceJsonSchema,
  EvidenceSchema,
  isSafeStoredRelativePath,
  isSortedUniqueStringArray,
  ManifestJsonSchema,
  ManifestSchema,
  normalizePathArray,
  normalizeRelativePath,
  normalizeStringArray,
  SCHEMA_VERSION,
  SESSION_STATE_SCHEMA_VERSION,
  SessionReportJsonSchema,
  SessionReportSchema,
  SessionStateJsonSchema,
  SessionStateSchema,
  type SessionStateSchemaVersion,
} from "../src/index.js";

// Type-level assertion: locks that SessionStateSchemaVersion is exported and
// equal to the literal "1.0". If the type alias is removed from the barrel or
// changes value, this fails to compile (caught by `pnpm typecheck`, not just
// runtime tests).
const _SCHEMA_VERSION_TYPE_CHECK: SessionStateSchemaVersion = "1.0";
void _SCHEMA_VERSION_TYPE_CHECK;

describe("SCHEMA_VERSION", () => {
  it("is the string '1.0'", () => {
    expect(SCHEMA_VERSION).toBe("1.0");
  });
});

describe("SESSION_STATE_SCHEMA_VERSION", () => {
  it("is the string '1.0'", () => {
    expect(SESSION_STATE_SCHEMA_VERSION).toBe("1.0");
  });
});

describe("isSafeStoredRelativePath", () => {
  it.each([
    "rollback/unstaged.patch",
    "app/Http/Controllers/BillingController.php",
    "a",
    "a/b",
    "deeply/nested/path/file.ts",
  ])("accepts canonical %s", (input) => {
    expect(isSafeStoredRelativePath(input)).toBe(true);
  });

  it.each([
    "",
    "foo\\bar",
    "/abs",
    "//unc/foo",
    "C:/abs",
    "c:foo",
    "./foo",
    "foo/./bar",
    "foo/../bar",
    "../foo",
    "foo//bar",
    "foo/",
    "/foo/",
    ".",
    "..",
  ])("rejects non-canonical %s", (input) => {
    expect(isSafeStoredRelativePath(input)).toBe(false);
  });
});

describe("normalizeRelativePath", () => {
  it.each([
    ["foo/bar", "foo/bar"],
    ["foo\\bar", "foo/bar"],
    ["./foo/bar", "foo/bar"],
    ["foo//bar", "foo/bar"],
    ["./foo\\\\bar", "foo/bar"],
  ])("canonicalizes %s -> %s", (input, expected) => {
    expect(normalizeRelativePath(input)).toBe(expected);
  });

  it.each([
    "",
    "/abs",
    "C:/abs",
    "foo/../bar",
    "../foo",
    "./",
    ".",
    "..",
  ])("throws on %s", (input) => {
    expect(() => normalizeRelativePath(input)).toThrow();
  });
});

describe("normalizePathArray", () => {
  it("returns empty array for empty input", () => {
    expect(normalizePathArray([])).toEqual([]);
  });

  it("canonicalizes, dedupes, and sorts a mixed array", () => {
    // ./foo/bar -> foo/bar; src\\baz -> src/baz.
    expect(normalizePathArray(["./foo/bar", "src\\baz"])).toEqual(["foo/bar", "src/baz"]);
  });

  it("sorts ASCII-ascending after canonicalization", () => {
    expect(normalizePathArray(["zoo.ts", "alpha.ts", "mid.ts"])).toEqual([
      "alpha.ts",
      "mid.ts",
      "zoo.ts",
    ]);
  });

  it("dedupes paths that canonicalize to the same value", () => {
    // All three canonicalize to "foo/bar".
    expect(normalizePathArray(["foo/bar", "foo\\bar", "./foo/bar"])).toEqual(["foo/bar"]);
  });

  it("throws on un-canonicalizable input (parent traversal)", () => {
    expect(() => normalizePathArray(["foo", "../escape"])).toThrow();
  });

  it("throws on un-canonicalizable input (absolute path)", () => {
    expect(() => normalizePathArray(["/abs/foo"])).toThrow();
  });

  it("throws on un-canonicalizable input (empty string)", () => {
    expect(() => normalizePathArray([""])).toThrow();
  });

  // Load-bearing: locks the divergence from normalizeStringArray.
  // Pathnames with leading/trailing whitespace are unusual but legitimate
  // filenames on most filesystems; trimming them at the manifest boundary
  // would silently rewrite the captured set and break the trust-preserving
  // principle that what we capture is what we restore.
  it("does NOT trim leading whitespace from path entries", () => {
    // " foo" sorts BEFORE "bar" because space (0x20) < 'b' (0x62).
    // If the helper trimmed, " foo" would collapse to "foo" and the result
    // would be ["bar", "foo"] — that's exactly the bug we're guarding against.
    expect(normalizePathArray([" foo", "bar"])).toEqual([" foo", "bar"]);
  });

  it("does NOT trim trailing whitespace from path entries", () => {
    // "foo " stays "foo "; sorts AFTER "bar" because b < f. If the helper
    // trimmed, "foo " would collapse to "foo" and the result would still be
    // ["bar", "foo"] — but the entry would have lost its trailing space,
    // which is the silent-rewrite we're preventing.
    expect(normalizePathArray(["foo ", "bar"])).toEqual(["bar", "foo "]);
  });
});

describe("isSortedUniqueStringArray", () => {
  it.each([[[]], [["a"]], [["a", "b"]], [["auth", "payments"]]])("accepts %j", (input) => {
    expect(isSortedUniqueStringArray(input)).toBe(true);
  });

  it.each([[["b", "a"]], [["a", "a"]], [["b", "a", "c"]]])("rejects %j", (input) => {
    expect(isSortedUniqueStringArray(input)).toBe(false);
  });
});

describe("normalizeStringArray", () => {
  it("returns empty for empty input", () => {
    expect(normalizeStringArray([])).toEqual([]);
  });

  it("trims, dedupes, drops empties and whitespace-only entries, sorts", () => {
    expect(normalizeStringArray(["payments", "  auth  ", "auth", "", "  "])).toEqual([
      "auth",
      "payments",
    ]);
  });
});

describe("EvidenceSchema", () => {
  it("accepts minimal valid", () => {
    expect(EvidenceSchema.parse({ detail: "missing test" })).toEqual({
      detail: "missing test",
    });
  });

  it("accepts with file and line", () => {
    const v = { detail: "x", file: "app/foo.ts", line: 12 };
    expect(EvidenceSchema.parse(v)).toEqual(v);
  });

  it("rejects line without file", () => {
    expect(() => EvidenceSchema.parse({ detail: "x", line: 12 })).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() => EvidenceSchema.parse({ detail: "x", extra: 1 })).toThrow();
  });
});

describe("ChangedFileSchema", () => {
  const baseAdded = {
    path: "src/foo.ts",
    status: "added" as const,
    risk_tags: ["payments"],
    risk_level: "low" as const,
  };

  it("accepts valid added", () => {
    expect(ChangedFileSchema.parse(baseAdded)).toEqual(baseAdded);
  });

  it("accepts renamed with previous_path", () => {
    const v = {
      ...baseAdded,
      status: "renamed" as const,
      previous_path: "src/old.ts",
      path: "src/new.ts",
    };
    expect(ChangedFileSchema.parse(v)).toEqual(v);
  });

  it("rejects renamed without previous_path", () => {
    expect(() => ChangedFileSchema.parse({ ...baseAdded, status: "renamed" })).toThrow();
  });

  it("rejects added with previous_path", () => {
    expect(() => ChangedFileSchema.parse({ ...baseAdded, previous_path: "src/old.ts" })).toThrow();
  });

  it("rejects renamed with previous_path === path", () => {
    expect(() =>
      ChangedFileSchema.parse({
        ...baseAdded,
        status: "renamed",
        previous_path: baseAdded.path,
      }),
    ).toThrow();
  });

  it("rejects unsorted risk_tags", () => {
    expect(() =>
      ChangedFileSchema.parse({
        ...baseAdded,
        risk_tags: ["payments", "auth"],
      }),
    ).toThrow();
  });

  it("rejects duplicate risk_tags", () => {
    expect(() => ChangedFileSchema.parse({ ...baseAdded, risk_tags: ["auth", "auth"] })).toThrow();
  });

  it("rejects empty-string risk_tags", () => {
    expect(() => ChangedFileSchema.parse({ ...baseAdded, risk_tags: [""] })).toThrow();
  });

  it("rejects whitespace-only risk_tags", () => {
    expect(() => ChangedFileSchema.parse({ ...baseAdded, risk_tags: ["   "] })).toThrow();
  });
});

describe("CheckResultSchema", () => {
  const baseLow = {
    id: "test-1",
    title: "Title",
    level: "low" as const,
    confidence: "medium" as const,
    category: "auth",
    message: "msg",
    evidence: [{ detail: "evidence detail" }],
  };

  it("accepts low without recommendation", () => {
    expect(CheckResultSchema.parse(baseLow)).toEqual(baseLow);
  });

  it("accepts medium without recommendation", () => {
    const v = { ...baseLow, level: "medium" as const };
    expect(CheckResultSchema.parse(v)).toEqual(v);
  });

  // Locks the contract-wide rule that nonBlankString rejects whitespace-only
  // scalar strings. Protects against a future "simplification" back to .min(1).
  it("rejects whitespace-only scalar strings via nonBlankString", () => {
    expect(() =>
      CheckResultSchema.parse({
        ...baseLow,
        id: "   ",
      }),
    ).toThrow();
  });

  it("rejects empty evidence array", () => {
    expect(() => CheckResultSchema.parse({ ...baseLow, evidence: [] })).toThrow();
  });

  it.each(["high", "critical"] as const)("rejects %s without recommendation", (level) => {
    expect(() => CheckResultSchema.parse({ ...baseLow, level })).toThrow();
  });

  it.each(["high", "critical"] as const)("accepts %s with recommendation", (level) => {
    const v = { ...baseLow, level, recommendation: "fix it" };
    expect(CheckResultSchema.parse(v)).toEqual(v);
  });
});

describe("ManifestSchema", () => {
  const validManifest = {
    schema_version: "1.0" as const,
    session_id: "session-1",
    captured_at: "2026-04-30T18:00:00Z",
    git: {
      head_sha: "abc123",
      branch: "main",
      porcelain_v1: "",
    },
    diffs: {
      unstaged_patch_path: "rollback/unstaged.patch",
      staged_patch_path: "rollback/staged.patch",
    },
    snapshots: {
      tracked_dirty_archive_path: "rollback/tracked-dirty.tar.gz",
      tracked_dirty_paths: ["src/foo.ts"],
      file_hashes: {
        "src/foo.ts": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    },
    untracked: {
      archive_path: "rollback/untracked.tar.gz",
      exclude_patterns: [],
      file_hashes: {},
    },
    rollback_target_description: "Restore to pre-session state",
  };

  it("accepts a valid manifest", () => {
    expect(ManifestSchema.parse(validManifest)).toEqual(validManifest);
  });

  it("rejects wrong schema_version", () => {
    expect(() => ManifestSchema.parse({ ...validManifest, schema_version: "2.0" })).toThrow();
  });

  it("rejects timestamp without offset", () => {
    expect(() =>
      ManifestSchema.parse({
        ...validManifest,
        captured_at: "2026-04-30T18:00:00",
      }),
    ).toThrow();
  });

  it("rejects timestamp with fractional seconds", () => {
    expect(() =>
      ManifestSchema.parse({
        ...validManifest,
        captured_at: "2026-04-30T18:00:00.123Z",
      }),
    ).toThrow();
  });

  it("rejects non-canonical path in diffs", () => {
    expect(() =>
      ManifestSchema.parse({
        ...validManifest,
        diffs: {
          ...validManifest.diffs,
          unstaged_patch_path: "../escape.patch",
        },
      }),
    ).toThrow();
  });

  it("rejects non-sha256 hash value", () => {
    expect(() =>
      ManifestSchema.parse({
        ...validManifest,
        snapshots: {
          ...validManifest.snapshots,
          file_hashes: { "src/foo.ts": "not-a-sha256" },
        },
      }),
    ).toThrow();
  });

  it("rejects unknown top-level field (strict)", () => {
    expect(() => ManifestSchema.parse({ ...validManifest, extra_field: "nope" })).toThrow();
  });

  // D15: optional `name` field added in M B.
  describe("name field (D15)", () => {
    it("accepts manifest WITHOUT name (backward-compatible)", () => {
      // The base validManifest has no name; round-trip equality already proves
      // the optional field is truly optional.
      expect(ManifestSchema.parse(validManifest)).toEqual(validManifest);
    });

    it("accepts manifest WITH name and round-trips it", () => {
      const v = { ...validManifest, name: "release-ready" };
      expect(ManifestSchema.parse(v)).toEqual(v);
    });

    it("rejects empty-string name", () => {
      expect(() => ManifestSchema.parse({ ...validManifest, name: "" })).toThrow();
    });

    it("rejects whitespace-only name", () => {
      expect(() => ManifestSchema.parse({ ...validManifest, name: "   " })).toThrow();
    });
  });

  // M B step-13 amendment: snapshots.tracked_dirty_paths is required and
  // captures the FULL tracked-dirty path set (including deletions, symlink
  // changes, mode-only changes — anything `git diff --name-only` reports),
  // NOT just the regular-file subset captured in snapshots.file_hashes.
  // Restore uses this for exact set-parity verification of the tracked-dirty
  // surface, closing the soundness hole where a tampered patch could
  // smuggle an unauthorized tracked deletion past file_hashes-only checks.
  describe("snapshots.tracked_dirty_paths field", () => {
    it("rejects manifest missing snapshots.tracked_dirty_paths", () => {
      const { tracked_dirty_paths: _omitted, ...snapshotsWithout } = validManifest.snapshots;
      void _omitted;
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          snapshots: snapshotsWithout,
        }),
      ).toThrow();
    });

    it("accepts an empty tracked_dirty_paths array (clean tracked tree)", () => {
      const v = {
        ...validManifest,
        snapshots: {
          ...validManifest.snapshots,
          tracked_dirty_paths: [],
          file_hashes: {},
        },
      };
      expect(ManifestSchema.parse(v)).toEqual(v);
    });

    it("accepts tracked_dirty_paths entries that are NOT in file_hashes (deletions)", () => {
      // The whole reason this field exists: tracked deletions are dirty but
      // can't be hashed. They must appear in tracked_dirty_paths to be
      // verifiable by restore, even though file_hashes can't reference them.
      const v = {
        ...validManifest,
        snapshots: {
          ...validManifest.snapshots,
          // Two dirty paths: src/foo.ts is regular (hashed below),
          // src/deleted.ts is a tracked deletion (no hash).
          tracked_dirty_paths: ["src/deleted.ts", "src/foo.ts"],
          // file_hashes still only contains the regular-file subset.
          file_hashes: validManifest.snapshots.file_hashes,
        },
      };
      expect(ManifestSchema.parse(v)).toEqual(v);
    });

    it("rejects unsorted tracked_dirty_paths", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          snapshots: {
            ...validManifest.snapshots,
            tracked_dirty_paths: ["src/zoo.ts", "src/foo.ts"],
            file_hashes: {},
          },
        }),
      ).toThrow();
    });

    it("rejects duplicate tracked_dirty_paths entries", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          snapshots: {
            ...validManifest.snapshots,
            tracked_dirty_paths: ["src/foo.ts", "src/foo.ts"],
          },
        }),
      ).toThrow();
    });

    it("rejects non-canonical path in tracked_dirty_paths (parent traversal)", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          snapshots: {
            ...validManifest.snapshots,
            tracked_dirty_paths: ["../escape.ts"],
            file_hashes: {},
          },
        }),
      ).toThrow();
    });

    it("rejects non-canonical path in tracked_dirty_paths (Windows backslash)", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          snapshots: {
            ...validManifest.snapshots,
            tracked_dirty_paths: ["src\\foo.ts"],
            file_hashes: {},
          },
        }),
      ).toThrow();
    });

    it("rejects absolute path in tracked_dirty_paths", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          snapshots: {
            ...validManifest.snapshots,
            tracked_dirty_paths: ["/abs/foo.ts"],
            file_hashes: {},
          },
        }),
      ).toThrow();
    });
  });

  // M B Step 3e: untracked.exclude_patterns is required and captures the
  // rollback.exclude glob list normalized via normalizeStringArray (sorted
  // + deduped + trimmed). Restore uses both the captured patterns and the
  // current restore-time patterns to detect bidirectional drift via
  // RestoreExcludeDriftError. See the load-bearing doc paragraph in
  // schemas.ts's Manifest section for the full contract + the
  // unordered-deny-list assumption that makes set comparison sound.
  describe("untracked.exclude_patterns field", () => {
    it("rejects manifest missing untracked.exclude_patterns", () => {
      const { exclude_patterns: _omitted, ...untrackedWithout } = validManifest.untracked;
      void _omitted;
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          untracked: untrackedWithout,
        }),
      ).toThrow();
    });

    it("accepts an empty exclude_patterns array (no rollback.exclude config at capture time)", () => {
      // The base validManifest already has exclude_patterns: []; this test
      // makes the empty-array case explicit so future readers don't have to
      // chase the fixture to learn the default.
      const v = {
        ...validManifest,
        untracked: { ...validManifest.untracked, exclude_patterns: [] },
      };
      expect(ManifestSchema.parse(v)).toEqual(v);
    });

    it("accepts arbitrary glob patterns (sorted, deduped)", () => {
      // Glob patterns can be arbitrary strings — picomatch interprets them.
      // The schema doesn't validate glob syntax (that's picomatch's job at
      // capture/restore time); it only validates the array shape.
      const v = {
        ...validManifest,
        untracked: {
          ...validManifest.untracked,
          exclude_patterns: ["*.log", "dist/**", "node_modules/**"],
        },
      };
      expect(ManifestSchema.parse(v)).toEqual(v);
    });

    it("rejects unsorted exclude_patterns", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          untracked: {
            ...validManifest.untracked,
            exclude_patterns: ["node_modules/**", "dist/**"],
          },
        }),
      ).toThrow();
    });

    it("rejects duplicate exclude_patterns entries", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          untracked: {
            ...validManifest.untracked,
            exclude_patterns: ["dist/**", "dist/**"],
          },
        }),
      ).toThrow();
    });

    it("rejects empty-string exclude_patterns entries", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          untracked: {
            ...validManifest.untracked,
            exclude_patterns: [""],
          },
        }),
      ).toThrow();
    });

    it("rejects whitespace-only exclude_patterns entries", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          untracked: {
            ...validManifest.untracked,
            exclude_patterns: ["   "],
          },
        }),
      ).toThrow();
    });
  });
});

describe("SessionReportSchema", () => {
  it("accepts a valid full round-trip", () => {
    const report = {
      schema_version: "1.0" as const,
      session_id: "session-2026-04-30",
      started_at: "2026-04-30T18:00:00Z",
      ended_at: "2026-04-30T18:30:00Z",
      agent_command: "claude",
      detected_frameworks: ["laravel", "node"],
      task: "Add yearly billing",
      checkpoint_id: "checkpoint-1",
      risk_level: "high" as const,
      changed_files: [
        {
          path: "app/Billing.php",
          status: "modified" as const,
          risk_tags: ["payments"],
          risk_level: "high" as const,
        },
      ],
      results: [
        {
          id: "stripe-webhook-test-gap",
          title: "Stripe webhook handler changed without signature verification test",
          level: "high" as const,
          confidence: "medium" as const,
          category: "payments",
          message: "Webhook handler modified, no signature verification test detected",
          evidence: [{ detail: "Modified app/Billing.php", file: "app/Billing.php" }],
          recommendation: "Add a webhook signature verification test",
        },
      ],
      rollback_available: true,
      summary: "Modified billing controller",
    };
    expect(SessionReportSchema.parse(report)).toEqual(report);
  });

  it("rejects detected_frameworks not sorted-unique", () => {
    expect(() =>
      SessionReportSchema.parse({
        schema_version: "1.0",
        session_id: "session-1",
        started_at: "2026-04-30T18:00:00Z",
        detected_frameworks: ["node", "laravel"],
        risk_level: "low",
        changed_files: [],
        results: [],
        rollback_available: false,
      }),
    ).toThrow();
  });

  it("rejects whitespace-only detected_frameworks entries", () => {
    expect(() =>
      SessionReportSchema.parse({
        schema_version: "1.0",
        session_id: "session-1",
        started_at: "2026-04-30T18:00:00Z",
        detected_frameworks: ["   "],
        risk_level: "low",
        changed_files: [],
        results: [],
        rollback_available: false,
      }),
    ).toThrow();
  });
});

// =============================================================================
// SessionStateSchema (D14) — M B `session.json` artifact.
//
// Path fields are repo-relative POSIX paths (e.g.,
// `.viberevert/sessions/sess_<ULID>/before-status.txt`).
// =============================================================================

describe("SessionStateSchema (D14)", () => {
  const validInFlight = {
    schema_version: "1.0" as const,
    session_id: "sess_01JV8Z0N6E9QABCDEFGHIJKLMN",
    checkpoint_id: "cp_01JV8Z0N6FP3ABCDEFGHIJKLMN",
    started_at: "2026-05-04T10:30:11Z",
    before_status_path: ".viberevert/sessions/sess_01JV8Z0N6E9QABCDEFGHIJKLMN/before-status.txt",
    commands_log_path: ".viberevert/sessions/sess_01JV8Z0N6E9QABCDEFGHIJKLMN/commands.log",
  };

  const validEnded = {
    ...validInFlight,
    ended_at: "2026-05-04T11:15:42Z",
    after_status_path: ".viberevert/sessions/sess_01JV8Z0N6E9QABCDEFGHIJKLMN/after-status.txt",
    task: "Add yearly billing",
    agent_command: "claude",
  };

  it("accepts a minimal valid in-flight session (no ended_at, no after_status_path)", () => {
    expect(SessionStateSchema.parse(validInFlight)).toEqual(validInFlight);
  });

  it("accepts a fully populated ended session (ended_at + after_status_path + optional fields)", () => {
    expect(SessionStateSchema.parse(validEnded)).toEqual(validEnded);
  });

  it("accepts in-flight session WITH task and agent_command (still no ended_at/after_status_path)", () => {
    const v = { ...validInFlight, task: "Add yearly billing", agent_command: "claude" };
    expect(SessionStateSchema.parse(v)).toEqual(v);
  });

  it("rejects ended_at WITHOUT after_status_path (refine: must be tied)", () => {
    expect(() =>
      SessionStateSchema.parse({ ...validInFlight, ended_at: "2026-05-04T11:15:42Z" }),
    ).toThrow();
  });

  it("rejects after_status_path WITHOUT ended_at (refine: must be tied)", () => {
    expect(() =>
      SessionStateSchema.parse({
        ...validInFlight,
        after_status_path: ".viberevert/sessions/sess_01JV8Z0N6E9QABCDEFGHIJKLMN/after-status.txt",
      }),
    ).toThrow();
  });

  it("rejects wrong schema_version literal", () => {
    expect(() => SessionStateSchema.parse({ ...validInFlight, schema_version: "2.0" })).toThrow();
  });

  it("rejects unknown top-level field (strict)", () => {
    expect(() => SessionStateSchema.parse({ ...validInFlight, extra_field: "nope" })).toThrow();
  });

  it("rejects whitespace-only session_id", () => {
    expect(() => SessionStateSchema.parse({ ...validInFlight, session_id: "   " })).toThrow();
  });

  it("rejects whitespace-only checkpoint_id", () => {
    expect(() => SessionStateSchema.parse({ ...validInFlight, checkpoint_id: "   " })).toThrow();
  });

  it("rejects whitespace-only optional task when supplied", () => {
    expect(() => SessionStateSchema.parse({ ...validInFlight, task: "   " })).toThrow();
  });

  it("rejects whitespace-only optional agent_command when supplied", () => {
    expect(() => SessionStateSchema.parse({ ...validInFlight, agent_command: "   " })).toThrow();
  });

  it("rejects timestamp without offset on started_at", () => {
    expect(() =>
      SessionStateSchema.parse({ ...validInFlight, started_at: "2026-05-04T10:30:11" }),
    ).toThrow();
  });

  it("rejects timestamp with fractional seconds on started_at", () => {
    expect(() =>
      SessionStateSchema.parse({ ...validInFlight, started_at: "2026-05-04T10:30:11.500Z" }),
    ).toThrow();
  });

  it("rejects non-canonical before_status_path (absolute)", () => {
    expect(() =>
      SessionStateSchema.parse({
        ...validInFlight,
        before_status_path: "/abs/before-status.txt",
      }),
    ).toThrow();
  });

  it("rejects non-canonical commands_log_path (parent traversal)", () => {
    expect(() =>
      SessionStateSchema.parse({ ...validInFlight, commands_log_path: "../commands.log" }),
    ).toThrow();
  });

  it("rejects non-canonical after_status_path (Windows backslash) when ended", () => {
    expect(() =>
      SessionStateSchema.parse({
        ...validInFlight,
        ended_at: "2026-05-04T11:15:42Z",
        after_status_path: ".viberevert\\sessions\\sess_xyz\\after-status.txt",
      }),
    ).toThrow();
  });
});

// =============================================================================
// ActiveSessionLockSchema (D14) — M B `active-session.json` artifact.
//
// Strict subset of SessionStateSchema (no ended_at, no path fields).
// =============================================================================

describe("ActiveSessionLockSchema (D14)", () => {
  const validLock = {
    schema_version: "1.0" as const,
    session_id: "sess_01JV8Z0N6E9QABCDEFGHIJKLMN",
    checkpoint_id: "cp_01JV8Z0N6FP3ABCDEFGHIJKLMN",
    started_at: "2026-05-04T10:30:11Z",
  };

  it("accepts a minimal valid lock (no task)", () => {
    expect(ActiveSessionLockSchema.parse(validLock)).toEqual(validLock);
  });

  it("accepts a lock with optional task", () => {
    const v = { ...validLock, task: "Add yearly billing" };
    expect(ActiveSessionLockSchema.parse(v)).toEqual(v);
  });

  it("rejects wrong schema_version literal", () => {
    expect(() => ActiveSessionLockSchema.parse({ ...validLock, schema_version: "2.0" })).toThrow();
  });

  it("rejects whitespace-only session_id", () => {
    expect(() => ActiveSessionLockSchema.parse({ ...validLock, session_id: "   " })).toThrow();
  });

  it("rejects whitespace-only checkpoint_id", () => {
    expect(() => ActiveSessionLockSchema.parse({ ...validLock, checkpoint_id: "   " })).toThrow();
  });

  it("rejects whitespace-only task when supplied", () => {
    expect(() => ActiveSessionLockSchema.parse({ ...validLock, task: "   " })).toThrow();
  });

  it("rejects timestamp without offset on started_at", () => {
    expect(() =>
      ActiveSessionLockSchema.parse({ ...validLock, started_at: "2026-05-04T10:30:11" }),
    ).toThrow();
  });

  // Strict-subset rules: rejects fields that belong only to SessionStateSchema,
  // not to the active-lock subset. Confirms .pick() preserved strictObject's
  // unknown-field rejection.
  it("rejects ended_at (not part of the lock subset)", () => {
    expect(() =>
      ActiveSessionLockSchema.parse({ ...validLock, ended_at: "2026-05-04T11:15:42Z" }),
    ).toThrow();
  });

  it("rejects before_status_path (not part of the lock subset)", () => {
    expect(() =>
      ActiveSessionLockSchema.parse({
        ...validLock,
        before_status_path: ".viberevert/sessions/sess_xyz/before-status.txt",
      }),
    ).toThrow();
  });

  it("rejects after_status_path (not part of the lock subset)", () => {
    expect(() =>
      ActiveSessionLockSchema.parse({
        ...validLock,
        after_status_path: ".viberevert/sessions/sess_xyz/after-status.txt",
      }),
    ).toThrow();
  });

  it("rejects commands_log_path (not part of the lock subset)", () => {
    expect(() =>
      ActiveSessionLockSchema.parse({
        ...validLock,
        commands_log_path: ".viberevert/sessions/sess_xyz/commands.log",
      }),
    ).toThrow();
  });

  it("rejects agent_command (not part of the lock subset)", () => {
    expect(() =>
      ActiveSessionLockSchema.parse({ ...validLock, agent_command: "claude" }),
    ).toThrow();
  });

  it("rejects unknown top-level field (strict)", () => {
    expect(() => ActiveSessionLockSchema.parse({ ...validLock, extra_field: "nope" })).toThrow();
  });
});

// =============================================================================
// JSON Schema exports (D21).
//
// Covers shape only — refined-coupling rules (e.g., SessionState's ended_at
// <-> after_status_path, CheckResult's recommendation requirement) are NOT
// expressible in JSON Schema and are NOT asserted here. Those are enforced
// only at the zod level.
// =============================================================================

describe("JSON Schema exports", () => {
  it.each([
    ["EvidenceJsonSchema", EvidenceJsonSchema],
    ["ChangedFileJsonSchema", ChangedFileJsonSchema],
    ["CheckResultJsonSchema", CheckResultJsonSchema],
    ["ManifestJsonSchema", ManifestJsonSchema],
    ["SessionReportJsonSchema", SessionReportJsonSchema],
    ["SessionStateJsonSchema", SessionStateJsonSchema],
    ["ActiveSessionLockJsonSchema", ActiveSessionLockJsonSchema],
  ])("%s is an object with type=object and properties", (_name, schema) => {
    expect(schema).toBeTypeOf("object");
    expect(schema).not.toBeNull();
    expect((schema as { type: string }).type).toBe("object");
    expect((schema as { properties: object }).properties).toBeTypeOf("object");
  });

  it("ManifestJsonSchema includes the optional `name` property (D15 refresh)", () => {
    const props = (ManifestJsonSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("name");
  });

  it("ManifestJsonSchema does NOT list `name` in required (D15: optional)", () => {
    const required = (ManifestJsonSchema as { required?: readonly string[] }).required ?? [];
    expect(required).not.toContain("name");
  });

  it("ManifestJsonSchema's snapshots property includes tracked_dirty_paths as required", () => {
    const props = (ManifestJsonSchema as { properties: { snapshots?: unknown } }).properties;
    const snapshots = props.snapshots as {
      properties: Record<string, unknown>;
      required: readonly string[];
    };
    expect(snapshots.properties).toHaveProperty("tracked_dirty_paths");
    expect(snapshots.required).toContain("tracked_dirty_paths");
  });

  it("ManifestJsonSchema's untracked property includes exclude_patterns as required (Step 3e)", () => {
    const props = (ManifestJsonSchema as { properties: { untracked?: unknown } }).properties;
    const untracked = props.untracked as {
      properties: Record<string, unknown>;
      required: readonly string[];
    };
    expect(untracked.properties).toHaveProperty("exclude_patterns");
    expect(untracked.required).toContain("exclude_patterns");
  });

  it("SessionStateJsonSchema describes all expected properties", () => {
    const props = (SessionStateJsonSchema as { properties: Record<string, unknown> }).properties;
    for (const k of [
      "schema_version",
      "session_id",
      "checkpoint_id",
      "started_at",
      "ended_at",
      "task",
      "agent_command",
      "before_status_path",
      "after_status_path",
      "commands_log_path",
    ]) {
      expect(props).toHaveProperty(k);
    }
  });

  it("SessionStateJsonSchema lists exactly the non-optional fields as required", () => {
    const required = (SessionStateJsonSchema as { required: readonly string[] }).required;
    expect([...required].sort()).toEqual(
      [
        "before_status_path",
        "checkpoint_id",
        "commands_log_path",
        "schema_version",
        "session_id",
        "started_at",
      ].sort(),
    );
  });

  it("ActiveSessionLockJsonSchema lists exactly the non-optional subset fields as required", () => {
    const required = (ActiveSessionLockJsonSchema as { required: readonly string[] }).required;
    expect([...required].sort()).toEqual(
      ["checkpoint_id", "schema_version", "session_id", "started_at"].sort(),
    );
  });

  it("ActiveSessionLockJsonSchema does NOT include path fields (subset of SessionState)", () => {
    const props = (ActiveSessionLockJsonSchema as { properties: Record<string, unknown> })
      .properties;
    for (const k of [
      "before_status_path",
      "after_status_path",
      "commands_log_path",
      "ended_at",
      "agent_command",
    ]) {
      expect(props).not.toHaveProperty(k);
    }
  });
});

// =============================================================================
// Barrel surface — locks the public API.
//
// Importing from `../src/index.js` (NOT internal paths) and asserting each new
// M B symbol is defined + has the expected runtime shape. Removing any of
// these from index.ts breaks this test.
// =============================================================================

describe("Barrel surface (M B additions)", () => {
  it("exports SessionStateSchema as a zod schema", () => {
    expect(SessionStateSchema).toBeDefined();
    expect(SessionStateSchema).toHaveProperty("parse");
    expect(typeof (SessionStateSchema as { parse: unknown }).parse).toBe("function");
  });

  it("exports ActiveSessionLockSchema as a zod schema", () => {
    expect(ActiveSessionLockSchema).toBeDefined();
    expect(ActiveSessionLockSchema).toHaveProperty("parse");
    expect(typeof (ActiveSessionLockSchema as { parse: unknown }).parse).toBe("function");
  });

  it("exports SessionStateJsonSchema as a JSON Schema object", () => {
    expect(SessionStateJsonSchema).toBeDefined();
    expect((SessionStateJsonSchema as { type: string }).type).toBe("object");
  });

  it("exports ActiveSessionLockJsonSchema as a JSON Schema object", () => {
    expect(ActiveSessionLockJsonSchema).toBeDefined();
    expect((ActiveSessionLockJsonSchema as { type: string }).type).toBe("object");
  });

  it("exports SESSION_STATE_SCHEMA_VERSION as the literal '1.0'", () => {
    expect(SESSION_STATE_SCHEMA_VERSION).toBe("1.0");
  });
});
