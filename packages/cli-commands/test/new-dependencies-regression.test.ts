// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Regression fixture for the `dependencies.new-dependencies` false positive
// fixed in M 0.9.0 step 2.
//
// =============================================================================
// Why this exists when step 2 already added unit controls
// =============================================================================
//
// Step 2's controls construct `addedLines` and `removedLines` by hand. That
// proves the RULE is right about the inputs it is handed, and it cannot prove
// those are the inputs git and the parser actually produce. A defect anywhere in
// `git diff` invocation, unified-diff parsing, or `parseRawDiffToInputs` would
// leave every one of them green while the product still misreported.
//
// This test takes the opposite end. A real repository, the real
// `getDiffSinceRef`, the real `parseRawDiffToInputs`, and the real detector. The
// only hand-written thing is the file content, and that content is the ACTUAL
// before and after of this repository's own commit `a216cab`, which is where the
// false positive was observed.
//
// The lesson being applied is the beta.2 one. There, a consumer was proven
// against a synthetic artifact the test built itself, so the missing producer
// went unnoticed. A hand-built diff is the same mistake one layer down.
//
// =============================================================================
// The real diff, from a216cab
// =============================================================================
//
//     @@ -45,11 +45,7 @@
//        },
//        "pnpm": {
//          "overrides": {
//     -      "hono": "4.12.34",
//     -      "@hono/node-server": "1.19.15",
//     -      "ip-address": "10.3.1",
//     -      "fast-uri": "3.1.7",
//     -      "qs": "6.16.0"
//     +      "ip-address": "10.7.6"
//          }
//        }
//      }
//
// `ip-address` is the whole point. It appears on a REMOVED line and on an ADDED
// line, because its version changed and shrinking the block also moved it to
// last position where it loses its trailing comma. Before step 2 the rule looked
// only at added lines and reported it as a NEW dependency. It is not new; it was
// already there.
//
// The other four keys are removed-only, so they were never candidates. Keeping
// them in the fixture matters anyway: a naive fix that compared whole LINES
// rather than KEYS would still mishandle `ip-address`, and a fix that compared
// across the whole diff rather than per file would be invisible without them.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILTIN_CHECKS, type Check, runChecks } from "@viberevert/checks";
import { getDiffSinceRef } from "@viberevert/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseRawDiffToInputs } from "../src/check-orchestration.js";

/** The committed state: five overrides, `ip-address` pinned to 10.3.1. */
const PACKAGE_JSON_BEFORE = `{
  "name": "fixture",
  "version": "0.0.0",
  "private": true,
  "pnpm": {
    "overrides": {
      "hono": "4.12.34",
      "@hono/node-server": "1.19.15",
      "ip-address": "10.3.1",
      "fast-uri": "3.1.7",
      "qs": "6.16.0"
    }
  }
}
`;

/** After: four removed, `ip-address` re-pinned AND now last, so no comma. */
const PACKAGE_JSON_AFTER = `{
  "name": "fixture",
  "version": "0.0.0",
  "private": true,
  "pnpm": {
    "overrides": {
      "ip-address": "10.7.6"
    }
  }
}
`;

/** A genuinely new key, for the control. */
const PACKAGE_JSON_WITH_NEW_DEP = `{
  "name": "fixture",
  "version": "0.0.0",
  "private": true,
  "dependencies": {
    "left-pad": "^1.3.0"
  },
  "pnpm": {
    "overrides": {
      "ip-address": "10.7.6"
    }
  }
}
`;

/**
 * The dependencies detector, taken from the REGISTRY rather than imported
 * directly. It is not individually exported from the package barrel, and going
 * through the registry is better anyway: this test then exercises the detector
 * exactly as the product reaches it.
 */
const dependenciesCheck: Check = (() => {
  const found = BUILTIN_CHECKS.find((c) => c.id === "dependencies");
  if (found === undefined) throw new Error('no registered check with id "dependencies"');
  return found;
})();

const ALL_ENABLED = {
  secrets: true,
  dependencies: true,
  migrations: true,
  auth: true,
  payments: true,
  infra: true,
  tests: true,
  scope_expansion: true,
} as const;

let repoRoot: string;

const git = (...args: string[]): void => {
  execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" });
};

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-newdeps-regression-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  await writeFile(join(repoRoot, "package.json"), PACKAGE_JSON_BEFORE, "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "baseline with five overrides");
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

/** The real pipeline: git diff, parse, detect. No hand-built inputs. */
async function newDependencyFindings(): Promise<readonly string[]> {
  const diff = await getDiffSinceRef(repoRoot, "HEAD");
  const inputs = parseRawDiffToInputs(diff.diff);
  const result = runChecks([dependenciesCheck], {
    changedFiles: inputs,
    detectedFrameworks: [],
    configChecks: ALL_ENABLED,
  });
  return result.results.filter((r) => r.id === "dependencies.new-dependencies").map((r) => r.id);
}

describe("dependencies.new-dependencies: the a216cab regression", () => {
  it("the real overrides-shrink diff reports NO new dependency", async () => {
    await writeFile(join(repoRoot, "package.json"), PACKAGE_JSON_AFTER, "utf8");
    expect(await newDependencyFindings()).toEqual([]);
  });

  it("the parsed diff really does contain ip-address on BOTH sides", async () => {
    // Without this, the test above could pass because the diff was empty, the
    // file was not seen, or the parser produced no removed lines at all. It
    // pins the precondition the rule depends on, measured from the real parse
    // rather than assumed.
    await writeFile(join(repoRoot, "package.json"), PACKAGE_JSON_AFTER, "utf8");
    const diff = await getDiffSinceRef(repoRoot, "HEAD");
    const [file] = parseRawDiffToInputs(diff.diff);
    expect(file).toBeDefined();
    if (file === undefined) return;
    expect(file.path).toBe("package.json");
    expect(file.addedLines.some((l) => l.text.includes('"ip-address"'))).toBe(true);
    expect(file.removedLines.some((l) => l.text.includes('"ip-address"'))).toBe(true);
    // And the removed-only keys really are removed-only, which is what makes
    // them non-candidates rather than suppressed candidates.
    expect(file.addedLines.some((l) => l.text.includes('"hono"'))).toBe(false);
    expect(file.removedLines.some((l) => l.text.includes('"hono"'))).toBe(true);
  });

  it("CONTROL: a genuinely new key in the same real pipeline IS reported", async () => {
    // The positive control, and it is doing real work here: both assertions
    // above are absence claims, and absence is also what a broken pipeline
    // produces. This proves the pipeline can report at all.
    await writeFile(join(repoRoot, "package.json"), PACKAGE_JSON_WITH_NEW_DEP, "utf8");
    expect(await newDependencyFindings()).toEqual(["dependencies.new-dependencies"]);
  });

  it("CONTROL: the new key and the re-pinned key in one diff reports only the new one", async () => {
    // The discriminating case. A fix that simply stopped reporting whenever any
    // key appeared on both sides would pass the first test and fail this one.
    await writeFile(join(repoRoot, "package.json"), PACKAGE_JSON_WITH_NEW_DEP, "utf8");
    const diff = await getDiffSinceRef(repoRoot, "HEAD");
    const inputs = parseRawDiffToInputs(diff.diff);
    const result = runChecks([dependenciesCheck], {
      changedFiles: inputs,
      detectedFrameworks: [],
      configChecks: ALL_ENABLED,
    });
    const finding = result.results.find((r) => r.id === "dependencies.new-dependencies");
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    const details = finding.evidence.map((e) => e.detail);
    expect(details).toContain("new-dependency: left-pad");
    expect(details.some((d) => d?.includes("ip-address"))).toBe(false);
  });
});
