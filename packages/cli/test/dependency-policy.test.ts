// packages/cli/test/dependency-policy.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Tests for the M H5 dependency-boundary checker: the pure core
// (scripts/dependency-policy-core.ts) and the filesystem collector
// (scripts/workspace-collector.ts). The collector security tests exercise real
// symlinks and are skipped as a group (not silently) where the OS forbids
// creating them.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  evaluateAll,
  extractDirectDeps,
  isValidCalendarDate,
  isValidPattern,
  matchesPattern,
  type Policy,
  type RawManifest,
  sortViolations,
  type Violation,
} from "../../../scripts/dependency-policy-core.js";
import { collectWorkspaceManifests } from "../../../scripts/workspace-collector.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// --- temp-directory bookkeeping -------------------------------------------

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Does this OS/account permit creating symlinks at all? Computed once so the
 *  symlink-security group is skipped visibly rather than silently no-op-passing. */
const SYMLINKS_OK: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), "vr-symcap-"));
  try {
    symlinkSync(dir, join(dir, "self-link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

/** Attempt a typed symlink; return whether it succeeded (never throws). */
function trySymlink(target: string, linkPath: string, type: "dir" | "file"): boolean {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

// --- workspace scaffolding -------------------------------------------------

function makeWorkspace(patternsYaml = 'packages:\n  - "packages/*"\n'): string {
  const root = mkTmp("vr-ws-");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ws-root", private: true }));
  writeFileSync(join(root, "pnpm-workspace.yaml"), patternsYaml);
  mkdirSync(join(root, "packages"));
  return root;
}

function addPkg(root: string, dir: string, manifest: unknown): string {
  const d = join(root, "packages", dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "package.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  return d;
}

// --- core construction helpers ---------------------------------------------

function rootManifest(content: unknown): RawManifest {
  return { path: "<root>/package.json", isRoot: true, content };
}

function pkgManifest(path: string, content: unknown): RawManifest {
  return { path, isRoot: false, content };
}

function codes(violations: readonly Violation[]): string[] {
  return violations.map((v) => v.code);
}

const BASE_POLICY: Policy = {
  schemaVersion: 1,
  forbiddenByDefault: ["express"],
  requiresReview: ["@octokit/*"],
  allowlistOverrides: [],
};

const AS_OF = "2026-07-19";

// ===========================================================================
// pattern + date helpers
// ===========================================================================

describe("isValidPattern", () => {
  it("accepts exact names and single scoped-family wildcards", () => {
    expect(isValidPattern("express")).toBe(true);
    expect(isValidPattern("@aws-sdk/*")).toBe(true);
    expect(isValidPattern("@scope/pkg")).toBe(true);
  });
  it("rejects unscoped globs, nested globs, whitespace, and malformed slashes", () => {
    expect(isValidPattern("foo/*")).toBe(false);
    expect(isValidPattern("@scope/sub/*")).toBe(false);
    expect(isValidPattern("*")).toBe(false);
    expect(isValidPattern("")).toBe(false);
    expect(isValidPattern("a b")).toBe(false);
    expect(isValidPattern("/x")).toBe(false);
    expect(isValidPattern("x/")).toBe(false);
    expect(isValidPattern("a//b")).toBe(false);
  });
});

describe("matchesPattern", () => {
  it("matches exact names and scoped families without over-reaching", () => {
    expect(matchesPattern("express", "express")).toBe(true);
    expect(matchesPattern("expressx", "express")).toBe(false);
    expect(matchesPattern("@aws-sdk/client-s3", "@aws-sdk/*")).toBe(true);
    expect(matchesPattern("@aws-sdkx/y", "@aws-sdk/*")).toBe(false);
  });
});

describe("isValidCalendarDate", () => {
  it("accepts real dates and rejects impossible or unpadded ones", () => {
    expect(isValidCalendarDate("2024-02-29")).toBe(true);
    expect(isValidCalendarDate("2026-02-29")).toBe(false);
    expect(isValidCalendarDate("2026-13-01")).toBe(false);
    expect(isValidCalendarDate("2026-00-10")).toBe(false);
    expect(isValidCalendarDate("2026-04-31")).toBe(false);
    expect(isValidCalendarDate("2026-1-1")).toBe(false);
  });
});

describe("sortViolations", () => {
  it("is order-independent for the same multiset of violations", () => {
    const a: Violation[] = [
      { code: "B", message: "m", declaredBy: "p", dependency: "z", scope: "production" },
      { code: "A", message: "m", declaredBy: "p", dependency: "a", scope: "production" },
    ];
    const b: Violation[] = [a[1] as Violation, a[0] as Violation];
    expect(sortViolations(a)).toEqual(sortViolations(b));
    expect(codes(sortViolations(a))).toEqual(["A", "B"]);
  });
});

// ===========================================================================
// manifest extraction
// ===========================================================================

describe("extractDirectDeps", () => {
  it("extracts direct deps with the root identity and precise shape", () => {
    const { deps, violations } = extractDirectDeps([
      rootManifest({ name: "ignored", peerDependencies: { typescript: "^5" } }),
      pkgManifest("packages/a/package.json", { name: "pkg-a", dependencies: { lodash: "^4" } }),
    ]);
    expect(violations).toEqual([]);
    expect(deps).toContainEqual({
      name: "typescript",
      scope: "peer",
      declaredBy: "//",
      declaredSpec: "^5",
    });
    expect(deps).toContainEqual({
      name: "lodash",
      scope: "production",
      declaredBy: "pkg-a",
      declaredSpec: "^4",
    });
  });

  it("flags a dependency declared in more than one section (non-cascading)", () => {
    const { violations } = extractDirectDeps([
      pkgManifest("packages/a/package.json", {
        name: "pkg-a",
        dependencies: { lodash: "^4" },
        devDependencies: { lodash: "^4" },
      }),
    ]);
    expect(codes(violations)).toContain("MANIFEST_DEP_IN_MULTIPLE_SECTIONS");
  });

  it("flags duplicate workspace identities", () => {
    const { violations } = extractDirectDeps([
      pkgManifest("packages/a/package.json", { name: "dup" }),
      pkgManifest("packages/b/package.json", { name: "dup" }),
    ]);
    expect(codes(violations)).toContain("MANIFEST_DUPLICATE_IDENTITY");
  });

  it("flags a non-root manifest missing a name", () => {
    const { violations } = extractDirectDeps([
      pkgManifest("packages/a/package.json", { dependencies: {} }),
    ]);
    expect(codes(violations)).toContain("MANIFEST_MISSING_NAME");
  });

  it("flags a non-string dependency specification", () => {
    const { violations } = extractDirectDeps([
      pkgManifest("packages/a/package.json", { name: "pkg-a", dependencies: { lodash: 4 } }),
    ]);
    expect(codes(violations)).toContain("MANIFEST_INVALID_SPEC");
  });

  it("flags non-object manifest content", () => {
    const { violations } = extractDirectDeps([
      pkgManifest("packages/a/package.json", "not-an-object"),
    ]);
    expect(codes(violations)).toContain("MANIFEST_MALFORMED");
  });
});

// ===========================================================================
// full evaluation
// ===========================================================================

describe("evaluateAll", () => {
  const manifestWith = (deps: Record<string, string>, section = "dependencies"): RawManifest =>
    pkgManifest("packages/a/package.json", { name: "pkg-a", [section]: deps });

  it("passes a clean workspace", () => {
    expect(evaluateAll(BASE_POLICY, [manifestWith({ lodash: "^4" })], AS_OF)).toEqual([]);
  });

  it("rejects a forbidden dependency", () => {
    expect(codes(evaluateAll(BASE_POLICY, [manifestWith({ express: "^4" })], AS_OF))).toContain(
      "FORBIDDEN_DEPENDENCY",
    );
  });

  it("rejects a review-required dependency without an override", () => {
    const v = evaluateAll(BASE_POLICY, [manifestWith({ "@octokit/rest": "^20" })], AS_OF);
    expect(codes(v)).toContain("REVIEW_REQUIRED_WITHOUT_OVERRIDE");
  });

  it("accepts a review-required dependency covered by a valid, unexpired override", () => {
    const policy: Policy = {
      ...BASE_POLICY,
      allowlistOverrides: [
        {
          dependency: "@octokit/rest",
          declaredBy: "pkg-a",
          scope: "production",
          justification: "needed for the GitHub integration",
          approvedBy: "maintainer",
          approvedAt: "2026-01-01",
          reviewAfter: "2027-01-01",
        },
      ],
    };
    expect(evaluateAll(policy, [manifestWith({ "@octokit/rest": "^20" })], AS_OF)).toEqual([]);
  });

  it("rejects an expired override", () => {
    const policy: Policy = {
      ...BASE_POLICY,
      allowlistOverrides: [
        {
          dependency: "@octokit/rest",
          declaredBy: "pkg-a",
          scope: "production",
          justification: "j",
          approvedBy: "m",
          approvedAt: "2026-01-01",
          reviewAfter: "2026-06-01",
        },
      ],
    };
    expect(codes(evaluateAll(policy, [manifestWith({ "@octokit/rest": "^20" })], AS_OF))).toContain(
      "OVERRIDE_EXPIRED",
    );
  });

  it("rejects an override approved in the future", () => {
    const policy: Policy = {
      ...BASE_POLICY,
      allowlistOverrides: [
        {
          dependency: "@octokit/rest",
          declaredBy: "pkg-a",
          scope: "production",
          justification: "j",
          approvedBy: "m",
          approvedAt: "2027-01-01",
          reviewAfter: "2027-06-01",
        },
      ],
    };
    expect(codes(evaluateAll(policy, [manifestWith({ "@octokit/rest": "^20" })], AS_OF))).toContain(
      "OVERRIDE_APPROVED_AT_IN_FUTURE",
    );
  });

  it("rejects an override that targets a forbiddenByDefault dependency", () => {
    const policy: Policy = {
      ...BASE_POLICY,
      allowlistOverrides: [
        {
          dependency: "express",
          declaredBy: "pkg-a",
          scope: "production",
          justification: "j",
          approvedBy: "m",
          approvedAt: "2026-01-01",
          reviewAfter: "2027-01-01",
        },
      ],
    };
    expect(codes(evaluateAll(policy, [manifestWith({ lodash: "^4" })], AS_OF))).toContain(
      "OVERRIDE_TARGETS_FORBIDDEN",
    );
  });

  it("rejects an override that matches no review-required declaration", () => {
    const policy: Policy = {
      ...BASE_POLICY,
      allowlistOverrides: [
        {
          dependency: "@octokit/rest",
          declaredBy: "pkg-a",
          scope: "production",
          justification: "j",
          approvedBy: "m",
          approvedAt: "2026-01-01",
          reviewAfter: "2027-01-01",
        },
      ],
    };
    expect(codes(evaluateAll(policy, [manifestWith({ lodash: "^4" })], AS_OF))).toContain(
      "OVERRIDE_NO_MATCH",
    );
  });

  it("flags a dependency that matches more than one policy rule as ambiguous", () => {
    const policy: Policy = {
      schemaVersion: 1,
      forbiddenByDefault: ["@scope/*"],
      requiresReview: ["@scope/thing"],
      allowlistOverrides: [],
    };
    expect(codes(evaluateAll(policy, [manifestWith({ "@scope/thing": "^1" })], AS_OF))).toContain(
      "POLICY_AMBIGUOUS_MATCH",
    );
  });

  it("rejects an invalid evaluation date", () => {
    expect(codes(evaluateAll(BASE_POLICY, [manifestWith({ lodash: "^4" })], "2026-02-29"))).toEqual(
      ["INVALID_AS_OF"],
    );
  });

  it("short-circuits on a malformed policy without evaluating dependencies", () => {
    const v = evaluateAll("not-a-policy", [manifestWith({ express: "^4" })], AS_OF);
    expect(codes(v)).toEqual(["POLICY_MALFORMED"]);
    expect(codes(v)).not.toContain("FORBIDDEN_DEPENDENCY");
  });

  it("reports an unknown top-level policy field", () => {
    const v = evaluateAll({ ...BASE_POLICY, extra: true }, [manifestWith({ lodash: "^4" })], AS_OF);
    expect(codes(v)).toContain("POLICY_UNKNOWN_FIELD");
  });

  it("reports an unsupported schema version", () => {
    const v = evaluateAll(
      { ...BASE_POLICY, schemaVersion: 2 },
      [manifestWith({ lodash: "^4" })],
      AS_OF,
    );
    expect(codes(v)).toContain("POLICY_UNSUPPORTED_SCHEMA_VERSION");
  });

  it("reports a pattern appearing in both lists", () => {
    const policy = { ...BASE_POLICY, forbiddenByDefault: ["express"], requiresReview: ["express"] };
    expect(codes(evaluateAll(policy, [manifestWith({ lodash: "^4" })], AS_OF))).toContain(
      "POLICY_PATTERN_IN_BOTH_LISTS",
    );
  });

  it("reports a duplicate override", () => {
    const override = {
      dependency: "@octokit/rest",
      declaredBy: "pkg-a",
      scope: "production" as const,
      justification: "j",
      approvedBy: "m",
      approvedAt: "2026-01-01",
      reviewAfter: "2027-01-01",
    };
    const policy: Policy = { ...BASE_POLICY, allowlistOverrides: [override, { ...override }] };
    expect(codes(evaluateAll(policy, [manifestWith({ "@octokit/rest": "^20" })], AS_OF))).toContain(
      "OVERRIDE_DUPLICATE",
    );
  });

  it("short-circuits on a manifest-extraction violation without evaluating the policy", () => {
    const good = manifestWith({ express: "^4" });
    const bad = pkgManifest("packages/b/package.json", {
      name: "pkg-b",
      dependencies: { lodash: "^4" },
      devDependencies: { lodash: "^4" },
    });
    const v = evaluateAll(BASE_POLICY, [good, bad], AS_OF);
    expect(codes(v)).toContain("MANIFEST_DEP_IN_MULTIPLE_SECTIONS");
    expect(codes(v)).not.toContain("FORBIDDEN_DEPENDENCY");
  });
});

// ===========================================================================
// workspace collector (temp filesystem)
// ===========================================================================

describe("collectWorkspaceManifests", () => {
  it("collects the root plus every package manifest from a valid workspace", () => {
    const root = makeWorkspace();
    addPkg(root, "a", { name: "pkg-a" });
    addPkg(root, "b", { name: "pkg-b" });
    const result = collectWorkspaceManifests(root);
    expect(result.violations).toEqual([]);
    expect(result.manifests.filter((m) => m.isRoot)).toHaveLength(1);
    expect(result.manifests).toHaveLength(3);
  });

  it("reports a missing workspace config", () => {
    const root = mkTmp("vr-ws-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "r" }));
    expect(codes(collectWorkspaceManifests(root).violations)).toEqual(["WORKSPACE_CONFIG_MISSING"]);
  });

  it("reports a missing root manifest", () => {
    const root = mkTmp("vr-ws-");
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    expect(codes(collectWorkspaceManifests(root).violations)).toEqual([
      "WORKSPACE_ROOT_MANIFEST_MISSING",
    ]);
  });

  it("reports malformed workspace YAML", () => {
    const root = mkTmp("vr-ws-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "r" }));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: [unterminated\n");
    expect(codes(collectWorkspaceManifests(root).violations)).toEqual([
      "WORKSPACE_CONFIG_MALFORMED",
    ]);
  });

  it("reports a workspace config without a packages array", () => {
    const root = mkTmp("vr-ws-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "r" }));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "name: nope\n");
    expect(codes(collectWorkspaceManifests(root).violations)).toEqual([
      "WORKSPACE_CONFIG_MALFORMED",
    ]);
  });

  it("rejects an absolute workspace pattern before touching the filesystem", () => {
    const root = makeWorkspace('packages:\n  - "/etc"\n');
    expect(codes(collectWorkspaceManifests(root).violations)).toContain(
      "WORKSPACE_PATTERN_UNSUPPORTED",
    );
  });

  it("rejects a workspace pattern with a parent-directory component", () => {
    const root = makeWorkspace('packages:\n  - "../*"\n');
    expect(codes(collectWorkspaceManifests(root).violations)).toContain(
      "WORKSPACE_PATTERN_UNSUPPORTED",
    );
  });

  it("rejects a workspace pattern containing a backslash", () => {
    const root = makeWorkspace('packages:\n  - "packages\\\\evil"\n');
    expect(codes(collectWorkspaceManifests(root).violations)).toContain(
      "WORKSPACE_PATTERN_UNSUPPORTED",
    );
  });

  it("reports a pattern that matches no directory", () => {
    const root = makeWorkspace();
    expect(codes(collectWorkspaceManifests(root).violations)).toContain(
      "WORKSPACE_PATTERN_UNMATCHED",
    );
  });

  it("reports invalid JSON in a package manifest", () => {
    const root = makeWorkspace();
    addPkg(root, "a", "{ not json");
    expect(codes(collectWorkspaceManifests(root).violations)).toContain(
      "WORKSPACE_MANIFEST_INVALID_JSON",
    );
  });
});

// ===========================================================================
// workspace collector — symlink security (skipped as a group where unsupported)
// ===========================================================================

describe.skipIf(!SYMLINKS_OK)("collectWorkspaceManifests — symlink security", () => {
  it("rejects a manifest whose realpath escapes the repository", () => {
    const root = makeWorkspace();
    const dir = addPkg(root, "a", { name: "pkg-a" });
    const external = mkTmp("vr-ext-");
    writeFileSync(join(external, "package.json"), JSON.stringify({ name: "evil" }));
    rmSync(join(dir, "package.json"));
    const linked = trySymlink(join(external, "package.json"), join(dir, "package.json"), "file");
    if (!linked) {
      return;
    }
    expect(codes(collectWorkspaceManifests(root).violations)).toContain(
      "WORKSPACE_MANIFEST_OUTSIDE_REPO",
    );
  });

  it("rejects two patterns that resolve to the same physical manifest", () => {
    const root = makeWorkspace();
    addPkg(root, "a", { name: "pkg-a" });
    const dirB = join(root, "packages", "b");
    mkdirSync(dirB);
    const linked = trySymlink(
      join(root, "packages", "a", "package.json"),
      join(dirB, "package.json"),
      "file",
    );
    if (!linked) {
      return;
    }
    expect(codes(collectWorkspaceManifests(root).violations)).toContain(
      "WORKSPACE_MANIFEST_DUPLICATE",
    );
  });

  it("does not enumerate through a workspace parent symlink pointing outside the repository", () => {
    const root = mkTmp("vr-ws-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ws-root", private: true }));
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    const external = mkTmp("vr-ext-");
    mkdirSync(join(external, "sneaky"));
    writeFileSync(join(external, "sneaky", "package.json"), JSON.stringify({ name: "evil" }));
    const linked = trySymlink(external, join(root, "packages"), "dir");
    if (!linked) {
      return;
    }
    const result = collectWorkspaceManifests(root);
    expect(result.manifests).toEqual([]);
    expect(codes(result.violations)).toContain("WORKSPACE_PATTERN_OUTSIDE_REPO");
  });
});

// ===========================================================================
// real workspace + committed policy (physical-root safe, exact inventory)
// ===========================================================================

describe("real workspace", () => {
  it("collects exactly the root plus every packages/* manifest", () => {
    const physicalRoot = realpathSync(REPO_ROOT);
    const result = collectWorkspaceManifests(REPO_ROOT);
    expect(result.violations).toEqual([]);

    const expected = new Set<string>([join(physicalRoot, "package.json")]);
    const packagesDir = join(physicalRoot, "packages");
    for (const name of readdirSync(packagesDir)) {
      if (!statSync(join(packagesDir, name)).isDirectory()) {
        continue;
      }
      const manifestPath = join(packagesDir, name, "package.json");
      expect(
        existsSync(manifestPath),
        `every packages/* directory must contain package.json: ${manifestPath}`,
      ).toBe(true);
      expected.add(manifestPath);
    }

    expect(new Set(result.manifests.map((m) => m.path))).toEqual(expected);
  });

  it("passes the committed dependency-boundary policy", () => {
    const collected = collectWorkspaceManifests(REPO_ROOT);
    expect(collected.violations).toEqual([]);
    const rawPolicy: unknown = JSON.parse(
      readFileSync(join(realpathSync(REPO_ROOT), "dependency-boundary.json"), "utf8"),
    );
    expect(evaluateAll(rawPolicy, collected.manifests, AS_OF)).toEqual([]);
  });
});
