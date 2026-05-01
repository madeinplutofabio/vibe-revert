// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { describe, expect, it } from "vitest";
import {
  ChangedFile,
  ChangedFileJsonSchema,
  CheckResult,
  CheckResultJsonSchema,
  Evidence,
  EvidenceJsonSchema,
  Manifest,
  ManifestJsonSchema,
  SCHEMA_VERSION,
  SessionReport,
  SessionReportJsonSchema,
  isSafeStoredRelativePath,
  isSortedUniqueStringArray,
  normalizeRelativePath,
  normalizeStringArray,
} from "../src/index.js";

describe("SCHEMA_VERSION", () => {
  it("is the string '1.0'", () => {
    expect(SCHEMA_VERSION).toBe("1.0");
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

  it.each(["", "/abs", "C:/abs", "foo/../bar", "../foo", "./", ".", ".."])(
    "throws on %s",
    (input) => {
      expect(() => normalizeRelativePath(input)).toThrow();
    },
  );
});

describe("isSortedUniqueStringArray", () => {
  it.each([[[]], [["a"]], [["a", "b"]], [["auth", "payments"]]])(
    "accepts %j",
    (input) => {
      expect(isSortedUniqueStringArray(input)).toBe(true);
    },
  );

  it.each([[["b", "a"]], [["a", "a"]], [["b", "a", "c"]]])(
    "rejects %j",
    (input) => {
      expect(isSortedUniqueStringArray(input)).toBe(false);
    },
  );
});

describe("normalizeStringArray", () => {
  it("returns empty for empty input", () => {
    expect(normalizeStringArray([])).toEqual([]);
  });

  it("trims, dedupes, drops empties and whitespace-only entries, sorts", () => {
    expect(
      normalizeStringArray(["payments", "  auth  ", "auth", "", "  "]),
    ).toEqual(["auth", "payments"]);
  });
});

describe("Evidence", () => {
  it("accepts minimal valid", () => {
    expect(Evidence.parse({ detail: "missing test" })).toEqual({
      detail: "missing test",
    });
  });

  it("accepts with file and line", () => {
    const v = { detail: "x", file: "app/foo.ts", line: 12 };
    expect(Evidence.parse(v)).toEqual(v);
  });

  it("rejects line without file", () => {
    expect(() => Evidence.parse({ detail: "x", line: 12 })).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() => Evidence.parse({ detail: "x", extra: 1 })).toThrow();
  });
});

describe("ChangedFile", () => {
  const baseAdded = {
    path: "src/foo.ts",
    status: "added" as const,
    risk_tags: ["payments"],
    risk_level: "low" as const,
  };

  it("accepts valid added", () => {
    expect(ChangedFile.parse(baseAdded)).toEqual(baseAdded);
  });

  it("accepts renamed with previous_path", () => {
    const v = {
      ...baseAdded,
      status: "renamed" as const,
      previous_path: "src/old.ts",
      path: "src/new.ts",
    };
    expect(ChangedFile.parse(v)).toEqual(v);
  });

  it("rejects renamed without previous_path", () => {
    expect(() =>
      ChangedFile.parse({ ...baseAdded, status: "renamed" }),
    ).toThrow();
  });

  it("rejects added with previous_path", () => {
    expect(() =>
      ChangedFile.parse({ ...baseAdded, previous_path: "src/old.ts" }),
    ).toThrow();
  });

  it("rejects renamed with previous_path === path", () => {
    expect(() =>
      ChangedFile.parse({
        ...baseAdded,
        status: "renamed",
        previous_path: baseAdded.path,
      }),
    ).toThrow();
  });

  it("rejects unsorted risk_tags", () => {
    expect(() =>
      ChangedFile.parse({ ...baseAdded, risk_tags: ["payments", "auth"] }),
    ).toThrow();
  });

  it("rejects duplicate risk_tags", () => {
    expect(() =>
      ChangedFile.parse({ ...baseAdded, risk_tags: ["auth", "auth"] }),
    ).toThrow();
  });

  it("rejects empty-string risk_tags", () => {
    expect(() =>
      ChangedFile.parse({ ...baseAdded, risk_tags: [""] }),
    ).toThrow();
  });

  it("rejects whitespace-only risk_tags", () => {
    expect(() =>
      ChangedFile.parse({ ...baseAdded, risk_tags: ["   "] }),
    ).toThrow();
  });
});

describe("CheckResult", () => {
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
    expect(CheckResult.parse(baseLow)).toEqual(baseLow);
  });

  it("accepts medium without recommendation", () => {
    const v = { ...baseLow, level: "medium" as const };
    expect(CheckResult.parse(v)).toEqual(v);
  });

  // Locks the contract-wide rule that nonBlankString rejects whitespace-only
  // scalar strings. Protects against a future "simplification" back to .min(1).
  it("rejects whitespace-only scalar strings via nonBlankString", () => {
    expect(() =>
      CheckResult.parse({
        ...baseLow,
        id: "   ",
      }),
    ).toThrow();
  });

  it("rejects empty evidence array", () => {
    expect(() => CheckResult.parse({ ...baseLow, evidence: [] })).toThrow();
  });

  it.each(["high", "critical"] as const)(
    "rejects %s without recommendation",
    (level) => {
      expect(() => CheckResult.parse({ ...baseLow, level })).toThrow();
    },
  );

  it.each(["high", "critical"] as const)(
    "accepts %s with recommendation",
    (level) => {
      const v = { ...baseLow, level, recommendation: "fix it" };
      expect(CheckResult.parse(v)).toEqual(v);
    },
  );
});

describe("Manifest", () => {
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
      file_hashes: {
        "src/foo.ts":
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    },
    untracked: {
      archive_path: "rollback/untracked.tar.gz",
      file_hashes: {},
    },
    rollback_target_description: "Restore to pre-session state",
  };

  it("accepts a valid manifest", () => {
    expect(Manifest.parse(validManifest)).toEqual(validManifest);
  });

  it("rejects wrong schema_version", () => {
    expect(() =>
      Manifest.parse({ ...validManifest, schema_version: "2.0" }),
    ).toThrow();
  });

  it("rejects timestamp without offset", () => {
    expect(() =>
      Manifest.parse({ ...validManifest, captured_at: "2026-04-30T18:00:00" }),
    ).toThrow();
  });

  it("rejects timestamp with fractional seconds", () => {
    expect(() =>
      Manifest.parse({
        ...validManifest,
        captured_at: "2026-04-30T18:00:00.123Z",
      }),
    ).toThrow();
  });

  it("rejects non-canonical path in diffs", () => {
    expect(() =>
      Manifest.parse({
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
      Manifest.parse({
        ...validManifest,
        snapshots: {
          ...validManifest.snapshots,
          file_hashes: { "src/foo.ts": "not-a-sha256" },
        },
      }),
    ).toThrow();
  });

  it("rejects unknown top-level field (strict)", () => {
    expect(() =>
      Manifest.parse({ ...validManifest, extra_field: "nope" }),
    ).toThrow();
  });
});

describe("SessionReport", () => {
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
          title:
            "Stripe webhook handler changed without signature verification test",
          level: "high" as const,
          confidence: "medium" as const,
          category: "payments",
          message:
            "Webhook handler modified, no signature verification test detected",
          evidence: [
            { detail: "Modified app/Billing.php", file: "app/Billing.php" },
          ],
          recommendation: "Add a webhook signature verification test",
        },
      ],
      rollback_available: true,
      summary: "Modified billing controller",
    };
    expect(SessionReport.parse(report)).toEqual(report);
  });

  it("rejects detected_frameworks not sorted-unique", () => {
    expect(() =>
      SessionReport.parse({
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
      SessionReport.parse({
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

describe("JSON Schema exports", () => {
  it.each([
    ["EvidenceJsonSchema", EvidenceJsonSchema],
    ["ChangedFileJsonSchema", ChangedFileJsonSchema],
    ["CheckResultJsonSchema", CheckResultJsonSchema],
    ["ManifestJsonSchema", ManifestJsonSchema],
    ["SessionReportJsonSchema", SessionReportJsonSchema],
  ])("%s is an object with type=object and properties", (_, schema) => {
    expect(schema).toBeTypeOf("object");
    expect(schema).not.toBeNull();
    expect((schema as { type: string }).type).toBe("object");
    expect((schema as { properties: object }).properties).toBeTypeOf("object");
  });
});
