// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { describe, expect, it } from "vitest";

import { RECORD_KEYS, type RecordKey } from "../src/engine-types.js";
import {
  type IntegrationFileEditRecord,
  IntegrationFileEditRecordSchema,
  type IntegrationRecord,
  IntegrationRecordSchema,
  type IntegrationsFile,
  IntegrationsFileSchema,
  type PathSpec,
  PathSpecSchema,
  RecordKeySchema,
} from "../src/integrations-schema.js";

// Fixed SHA-shaped constants (64 hex chars). Use these in fixtures
// rather than ad-hoc "a".repeat(64) calls so accidental wrong-length
// inputs are impossible.
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

// --- Factories: each returns a fully-valid value; tests build
// invalid cases by spread-and-override or bare object literals. ---

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

function makeBackupAndWriteOp(
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

function makeSentinelInsertOp(
  overrides: Partial<IntegrationFileEditRecord> = {},
): IntegrationFileEditRecord {
  return {
    kind: "sentinel-block-insert",
    target: makePathSpec(),
    backup: null,
    managedBlockSha256: SHA_A,
    managedValueSha256: null,
    fullFileSha256AfterWrite: null,
    blockId: "test-block-id",
    jsonKeyPath: null,
    mode: null,
    ...overrides,
  };
}

function makeSentinelReplaceOp(
  overrides: Partial<IntegrationFileEditRecord> = {},
): IntegrationFileEditRecord {
  return {
    kind: "sentinel-block-replace",
    target: makePathSpec(),
    backup: null,
    managedBlockSha256: SHA_A,
    managedValueSha256: null,
    fullFileSha256AfterWrite: null,
    blockId: "test-block-id",
    jsonKeyPath: null,
    mode: null,
    ...overrides,
  };
}

function makeJsonKeyMergeOp(
  overrides: Partial<IntegrationFileEditRecord> = {},
): IntegrationFileEditRecord {
  return {
    kind: "json-key-merge",
    target: makePathSpec(),
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

function makeRecord(overrides: Partial<IntegrationRecord> = {}): IntegrationRecord {
  return {
    recordKey: "cursor",
    adapterName: "cursor-test",
    installedAt: "2026-06-27T12:00:00.000Z",
    installedByVersion: "0.7.1-beta.0",
    ops: [makeWriteNewOp()],
    meta: {},
    ...overrides,
  };
}

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

// ===========================================================================
// RECORD_KEYS + RecordKeySchema
// ===========================================================================

describe("RECORD_KEYS + RecordKeySchema", () => {
  it("contains the six expected installer record keys in order", () => {
    expect(RECORD_KEYS).toEqual([
      "cursor",
      "claude",
      "github-action",
      "direct-hook",
      "husky",
      "lefthook",
    ]);
  });
  it.each(RECORD_KEYS)("RecordKeySchema accepts %s", (key) => {
    expect(() => RecordKeySchema.parse(key)).not.toThrow();
  });
  it("RecordKeySchema rejects unknown string", () => {
    expect(() => RecordKeySchema.parse("bogus")).toThrow();
  });
  it("RecordKeySchema rejects non-string", () => {
    expect(() => RecordKeySchema.parse(42)).toThrow();
  });
});

// ===========================================================================
// PathSpecSchema -- boundary corpus
// ===========================================================================

describe("PathSpecSchema -- boundary corpus", () => {
  it("accepts a valid POSIX path", () => {
    expect(() => PathSpecSchema.parse(makePathSpec())).not.toThrow();
  });
  it("accepts a multi-segment POSIX path", () => {
    expect(() =>
      PathSpecSchema.parse(makePathSpec({ pathRelative: ".cursor/mcp.json" })),
    ).not.toThrow();
  });
  it("rejects empty pathRelative", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathRelative: "" }))).toThrow();
  });
  it("rejects pathRelative > 512 chars", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathRelative: "a".repeat(513) }))).toThrow();
  });
  it("rejects control character in pathRelative", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathRelative: "abc\x01def" }))).toThrow();
  });
  it("rejects backslash in pathRelative", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathRelative: "foo\\bar" }))).toThrow();
  });
  it("rejects leading slash in pathRelative", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathRelative: "/foo" }))).toThrow();
  });
  it("rejects Windows drive letter in pathRelative", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathRelative: "C:foo" }))).toThrow();
  });
  it("rejects colon anywhere in pathRelative", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathRelative: "foo:bar" }))).toThrow();
  });
  it("rejects leading tilde in pathRelative", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathRelative: "~foo" }))).toThrow();
  });
  it("rejects empty segment (foo//bar)", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathRelative: "foo//bar" }))).toThrow();
  });
  it("rejects '.' segment", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathRelative: "foo/./bar" }))).toThrow();
  });
  it("rejects '..' segment", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathRelative: "foo/../bar" }))).toThrow();
  });
  it("rejects scope other than 'repo'", () => {
    expect(() =>
      PathSpecSchema.parse({ scope: "home", pathTemplate: "x", pathRelative: "y" }),
    ).toThrow();
  });
  it("rejects missing pathTemplate", () => {
    expect(() => PathSpecSchema.parse({ scope: "repo", pathRelative: "test.json" })).toThrow();
  });
  it("rejects empty pathTemplate", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathTemplate: "" }))).toThrow();
  });
  it("rejects pathTemplate > 512 chars", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathTemplate: "a".repeat(513) }))).toThrow();
  });
  it("rejects control character in pathTemplate", () => {
    expect(() => PathSpecSchema.parse(makePathSpec({ pathTemplate: "abc\x01def" }))).toThrow();
  });
  it("rejects extra field via .strict()", () => {
    expect(() =>
      PathSpecSchema.parse({
        scope: "repo",
        pathTemplate: "{repo}/x.json",
        pathRelative: "x.json",
        extra: "field",
      }),
    ).toThrow();
  });
});

// ===========================================================================
// JsonKeyPath -- via json-key-merge op
// ===========================================================================

describe("JsonKeyPath -- proto-pollution + segment boundary", () => {
  // JsonKeySegmentSchema is not exported; tested via json-key-merge.
  it("accepts a valid multi-segment jsonKeyPath", () => {
    expect(() =>
      IntegrationFileEditRecordSchema.parse(
        makeJsonKeyMergeOp({ jsonKeyPath: ["mcpServers", "viberevert"] }),
      ),
    ).not.toThrow();
  });
  it("rejects __proto__ segment", () => {
    expect(() =>
      IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp({ jsonKeyPath: ["__proto__"] })),
    ).toThrow();
  });
  it("rejects constructor segment", () => {
    expect(() =>
      IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp({ jsonKeyPath: ["constructor"] })),
    ).toThrow();
  });
  it("rejects prototype segment", () => {
    expect(() =>
      IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp({ jsonKeyPath: ["prototype"] })),
    ).toThrow();
  });
  it("rejects proto-pollution segment embedded in multi-segment path", () => {
    expect(() =>
      IntegrationFileEditRecordSchema.parse(
        makeJsonKeyMergeOp({ jsonKeyPath: ["mcpServers", "__proto__"] }),
      ),
    ).toThrow();
  });
  it("rejects empty segment", () => {
    expect(() =>
      IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp({ jsonKeyPath: [""] })),
    ).toThrow();
  });
  it("rejects control char in segment", () => {
    expect(() =>
      IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp({ jsonKeyPath: ["abc\x01"] })),
    ).toThrow();
  });
  it("rejects segment > 256 chars", () => {
    expect(() =>
      IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp({ jsonKeyPath: ["a".repeat(257)] })),
    ).toThrow();
  });
  it("rejects empty jsonKeyPath array (min length 1)", () => {
    expect(() =>
      IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp({ jsonKeyPath: [] })),
    ).toThrow();
  });
});

// ===========================================================================
// IntegrationFileEditRecordSchema -- per-kind superRefine
// ===========================================================================

describe("IntegrationFileEditRecordSchema -- per-kind superRefine", () => {
  describe("write-new", () => {
    it("accepts valid baseline", () => {
      expect(() => IntegrationFileEditRecordSchema.parse(makeWriteNewOp())).not.toThrow();
    });
    it("accepts mode set to a POSIX number (0o755)", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeWriteNewOp({ mode: 0o755 })),
      ).not.toThrow();
    });
    it("rejects null fullFileSha256AfterWrite", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeWriteNewOp({ fullFileSha256AfterWrite: null })),
      ).toThrow();
    });
    it("rejects non-null backup", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeWriteNewOp({ backup: makeBackupPathSpec() })),
      ).toThrow();
    });
    it("rejects non-null blockId", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeWriteNewOp({ blockId: "abc" })),
      ).toThrow();
    });
    it("rejects non-null jsonKeyPath", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeWriteNewOp({ jsonKeyPath: ["foo"] })),
      ).toThrow();
    });
    it("rejects mode out of 0-0o777 range", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeWriteNewOp({ mode: 0o1000 })),
      ).toThrow();
    });
  });

  describe("backup-and-write", () => {
    it("accepts valid baseline (non-null backup PathSpec)", () => {
      expect(() => IntegrationFileEditRecordSchema.parse(makeBackupAndWriteOp())).not.toThrow();
    });
    it("rejects null backup (required for this kind)", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeBackupAndWriteOp({ backup: null })),
      ).toThrow();
    });
    it("rejects null fullFileSha256AfterWrite", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(
          makeBackupAndWriteOp({ fullFileSha256AfterWrite: null }),
        ),
      ).toThrow();
    });
    it("rejects non-null blockId", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeBackupAndWriteOp({ blockId: "abc" })),
      ).toThrow();
    });
    it("rejects non-null jsonKeyPath", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeBackupAndWriteOp({ jsonKeyPath: ["foo"] })),
      ).toThrow();
    });
    it("accepts mode set to a POSIX number (hook scripts)", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeBackupAndWriteOp({ mode: 0o755 })),
      ).not.toThrow();
    });
  });

  describe("sentinel-block-insert", () => {
    it("accepts valid baseline", () => {
      expect(() => IntegrationFileEditRecordSchema.parse(makeSentinelInsertOp())).not.toThrow();
    });
    it("rejects null managedBlockSha256", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeSentinelInsertOp({ managedBlockSha256: null })),
      ).toThrow();
    });
    it("rejects null blockId", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeSentinelInsertOp({ blockId: null })),
      ).toThrow();
    });
    it("rejects non-null jsonKeyPath", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeSentinelInsertOp({ jsonKeyPath: ["foo"] })),
      ).toThrow();
    });
    it("rejects non-null mode", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeSentinelInsertOp({ mode: 0o644 })),
      ).toThrow();
    });
    it("rejects non-null backup", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(
          makeSentinelInsertOp({ backup: makeBackupPathSpec() }),
        ),
      ).toThrow();
    });
    it("rejects non-null fullFileSha256AfterWrite (two SHAs non-null)", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(
          makeSentinelInsertOp({ fullFileSha256AfterWrite: SHA_B }),
        ),
      ).toThrow();
    });
  });

  describe("sentinel-block-replace", () => {
    it("accepts valid baseline", () => {
      expect(() => IntegrationFileEditRecordSchema.parse(makeSentinelReplaceOp())).not.toThrow();
    });
    it("rejects null managedBlockSha256", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeSentinelReplaceOp({ managedBlockSha256: null })),
      ).toThrow();
    });
    it("rejects null blockId", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeSentinelReplaceOp({ blockId: null })),
      ).toThrow();
    });
    it("rejects non-null mode", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeSentinelReplaceOp({ mode: 0o644 })),
      ).toThrow();
    });
  });

  describe("json-key-merge", () => {
    it("accepts valid baseline", () => {
      expect(() => IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp())).not.toThrow();
    });
    it("rejects null managedValueSha256", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp({ managedValueSha256: null })),
      ).toThrow();
    });
    it("rejects null jsonKeyPath", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp({ jsonKeyPath: null })),
      ).toThrow();
    });
    it("rejects non-null blockId", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp({ blockId: "abc" })),
      ).toThrow();
    });
    it("rejects non-null mode", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp({ mode: 0o644 })),
      ).toThrow();
    });
    it("rejects non-null backup", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeJsonKeyMergeOp({ backup: makeBackupPathSpec() })),
      ).toThrow();
    });
  });

  describe("exactly-one-SHA + cross-cutting", () => {
    it("rejects zero SHAs non-null", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeWriteNewOp({ fullFileSha256AfterWrite: null })),
      ).toThrow();
    });
    it("rejects two SHAs non-null", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeWriteNewOp({ managedBlockSha256: SHA_B })),
      ).toThrow();
    });
    it("rejects three SHAs non-null", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(
          makeWriteNewOp({ managedBlockSha256: SHA_B, managedValueSha256: SHA_A }),
        ),
      ).toThrow();
    });
    it("rejects malformed SHA (wrong length)", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(makeWriteNewOp({ fullFileSha256AfterWrite: "abc" })),
      ).toThrow();
    });
    it("rejects malformed SHA (non-hex char)", () => {
      expect(() =>
        IntegrationFileEditRecordSchema.parse(
          makeWriteNewOp({ fullFileSha256AfterWrite: `${"a".repeat(63)}Z` }),
        ),
      ).toThrow();
    });
    it("rejects unknown kind", () => {
      const bad = { ...makeWriteNewOp(), kind: "unknown-kind" } as unknown;
      expect(() => IntegrationFileEditRecordSchema.parse(bad)).toThrow();
    });
    it("rejects extra field via .strict()", () => {
      const bad = { ...makeWriteNewOp(), extra: "field" } as unknown;
      expect(() => IntegrationFileEditRecordSchema.parse(bad)).toThrow();
    });
  });
});

// ===========================================================================
// IntegrationRecordSchema
// ===========================================================================

describe("IntegrationRecordSchema", () => {
  it("accepts a valid baseline", () => {
    expect(() => IntegrationRecordSchema.parse(makeRecord())).not.toThrow();
  });
  it("rejects non-enum recordKey", () => {
    const bad = { ...makeRecord(), recordKey: "bogus" } as unknown;
    expect(() => IntegrationRecordSchema.parse(bad)).toThrow();
  });
  it("rejects empty ops array", () => {
    expect(() => IntegrationRecordSchema.parse(makeRecord({ ops: [] }))).toThrow();
  });
  it("accepts multi-op record", () => {
    expect(() =>
      IntegrationRecordSchema.parse(
        makeRecord({ ops: [makeWriteNewOp(), makeSentinelInsertOp()] }),
      ),
    ).not.toThrow();
  });
  it("rejects empty adapterName", () => {
    expect(() => IntegrationRecordSchema.parse(makeRecord({ adapterName: "" }))).toThrow();
  });
  it("rejects adapterName > 128 chars", () => {
    expect(() =>
      IntegrationRecordSchema.parse(makeRecord({ adapterName: "a".repeat(129) })),
    ).toThrow();
  });
  it("rejects control char in adapterName", () => {
    expect(() =>
      IntegrationRecordSchema.parse(makeRecord({ adapterName: "abc\x01def" })),
    ).toThrow();
  });
  it("rejects empty installedByVersion", () => {
    expect(() => IntegrationRecordSchema.parse(makeRecord({ installedByVersion: "" }))).toThrow();
  });
  it("rejects extra field via .strict()", () => {
    const bad = { ...makeRecord(), extra: "field" } as unknown;
    expect(() => IntegrationRecordSchema.parse(bad)).toThrow();
  });

  describe("installedAt datetime", () => {
    it("accepts UTC Z form", () => {
      expect(() =>
        IntegrationRecordSchema.parse(makeRecord({ installedAt: "2026-01-01T00:00:00.000Z" })),
      ).not.toThrow();
    });
    it("rejects timezone offset (e.g., +01:00) instead of Z", () => {
      expect(() =>
        IntegrationRecordSchema.parse(makeRecord({ installedAt: "2026-01-01T00:00:00.000+01:00" })),
      ).toThrow();
    });
    it("rejects non-datetime string", () => {
      expect(() =>
        IntegrationRecordSchema.parse(makeRecord({ installedAt: "not-a-datetime" })),
      ).toThrow();
    });
  });

  describe("meta", () => {
    it("accepts empty meta", () => {
      expect(() => IntegrationRecordSchema.parse(makeRecord({ meta: {} }))).not.toThrow();
    });
    it("accepts string-to-string map", () => {
      expect(() =>
        IntegrationRecordSchema.parse(makeRecord({ meta: { key1: "val1", key2: "val2" } })),
      ).not.toThrow();
    });
    it("accepts empty-string value (value min length 0)", () => {
      expect(() => IntegrationRecordSchema.parse(makeRecord({ meta: { key1: "" } }))).not.toThrow();
    });
    it("rejects non-string value (number)", () => {
      const bad = { ...makeRecord(), meta: { key1: 42 } } as unknown;
      expect(() => IntegrationRecordSchema.parse(bad)).toThrow();
    });
    it("rejects non-string value (null)", () => {
      const bad = { ...makeRecord(), meta: { key1: null } } as unknown;
      expect(() => IntegrationRecordSchema.parse(bad)).toThrow();
    });
    it("rejects non-string value (boolean)", () => {
      const bad = { ...makeRecord(), meta: { key1: true } } as unknown;
      expect(() => IntegrationRecordSchema.parse(bad)).toThrow();
    });
    it("rejects control char in meta key", () => {
      expect(() =>
        IntegrationRecordSchema.parse(makeRecord({ meta: { "key\x01": "val" } })),
      ).toThrow();
    });
    it("rejects control char in meta value", () => {
      expect(() =>
        IntegrationRecordSchema.parse(makeRecord({ meta: { key1: "val\x01" } })),
      ).toThrow();
    });
    it("accepts 64-entry meta (boundary)", () => {
      const meta: Record<string, string> = {};
      for (let i = 0; i < 64; i++) meta[`k${i}`] = `v${i}`;
      expect(() => IntegrationRecordSchema.parse(makeRecord({ meta }))).not.toThrow();
    });
    it("rejects 65-entry meta (over limit)", () => {
      const meta: Record<string, string> = {};
      for (let i = 0; i < 65; i++) meta[`k${i}`] = `v${i}`;
      expect(() => IntegrationRecordSchema.parse(makeRecord({ meta }))).toThrow();
    });
  });
});

// ===========================================================================
// IntegrationsFileSchema -- top-level + map-key + history
// ===========================================================================

describe("IntegrationsFileSchema -- top-level", () => {
  it("accepts empty file (records: {}, history: [])", () => {
    expect(() => IntegrationsFileSchema.parse(makeIntegrationsFile())).not.toThrow();
  });
  it("rejects schemaVersion 2", () => {
    const bad = { ...makeIntegrationsFile(), schemaVersion: 2 } as unknown;
    expect(() => IntegrationsFileSchema.parse(bad)).toThrow();
  });
  it("rejects missing schemaVersion", () => {
    const { schemaVersion: _omit, ...bad } = makeIntegrationsFile();
    expect(() => IntegrationsFileSchema.parse(bad)).toThrow();
  });
  it("rejects missing createdByVersion", () => {
    const { createdByVersion: _omit, ...bad } = makeIntegrationsFile();
    expect(() => IntegrationsFileSchema.parse(bad)).toThrow();
  });
  it("rejects missing updatedByVersion", () => {
    const { updatedByVersion: _omit, ...bad } = makeIntegrationsFile();
    expect(() => IntegrationsFileSchema.parse(bad)).toThrow();
  });
  it("rejects extra field via .strict()", () => {
    const bad = { ...makeIntegrationsFile(), extra: "field" } as unknown;
    expect(() => IntegrationsFileSchema.parse(bad)).toThrow();
  });

  describe("records map-key consistency", () => {
    it("accepts records map where key matches record.recordKey (positive)", () => {
      expect(() =>
        IntegrationsFileSchema.parse(
          makeIntegrationsFile({
            records: { cursor: makeRecord({ recordKey: "cursor" }) },
          }),
        ),
      ).not.toThrow();
    });
    it("accepts records map with multiple matching entries", () => {
      expect(() =>
        IntegrationsFileSchema.parse(
          makeIntegrationsFile({
            records: {
              cursor: makeRecord({ recordKey: "cursor" }),
              claude: makeRecord({ recordKey: "claude" }),
            },
          }),
        ),
      ).not.toThrow();
    });
    it("rejects map key mismatching record.recordKey field", () => {
      expect(() =>
        IntegrationsFileSchema.parse(
          makeIntegrationsFile({
            records: { cursor: makeRecord({ recordKey: "claude" }) },
          }),
        ),
      ).toThrow();
    });
  });

  describe("history boundary", () => {
    function makeHistoryEntry(): {
      timestamp: string;
      action: "install" | "uninstall" | "migrate" | "adopt";
      recordKey: RecordKey;
      cliVersion: string;
    } {
      return {
        timestamp: "2026-06-27T12:00:00.000Z",
        action: "install",
        recordKey: "cursor",
        cliVersion: "0.7.1-beta.0",
      };
    }
    it("accepts 1000 history entries (boundary)", () => {
      const history = Array.from({ length: 1000 }, makeHistoryEntry);
      expect(() => IntegrationsFileSchema.parse(makeIntegrationsFile({ history }))).not.toThrow();
    });
    it("rejects 1001 history entries (over limit)", () => {
      const history = Array.from({ length: 1001 }, makeHistoryEntry);
      expect(() => IntegrationsFileSchema.parse(makeIntegrationsFile({ history }))).toThrow();
    });
    it("accepts each of the 4 history actions", () => {
      const actions = ["install", "uninstall", "migrate", "adopt"] as const;
      for (const action of actions) {
        expect(() =>
          IntegrationsFileSchema.parse(
            makeIntegrationsFile({
              history: [{ ...makeHistoryEntry(), action }],
            }),
          ),
        ).not.toThrow();
      }
    });
    it("rejects unknown history action", () => {
      const bad = { ...makeHistoryEntry(), action: "bogus" };
      expect(() =>
        IntegrationsFileSchema.parse(
          makeIntegrationsFile({
            history: [bad] as unknown as IntegrationsFile["history"],
          }),
        ),
      ).toThrow();
    });
    it("rejects history entry with timezone-offset timestamp", () => {
      const bad = [{ ...makeHistoryEntry(), timestamp: "2026-06-27T12:00:00.000+01:00" }];
      expect(() => IntegrationsFileSchema.parse(makeIntegrationsFile({ history: bad }))).toThrow();
    });
  });
});
