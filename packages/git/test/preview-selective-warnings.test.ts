// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Cleanup-warning propagation for the read-only selective preview.
//
// Separate file, and narrowly mocked, because this is the one part of the
// contract real IO cannot reach. A non-empty `cleanupWarnings` requires a
// worktree or temp directory that resists removal, and no portable filesystem
// state produces that on demand: an open handle blocks removal on Windows and
// not on Linux, a read-only parent behaves the reverse way.
//
// So `withCheckpointOracle` is wrapped rather than replaced. The real one runs
// on every path, against a real repository and a real checkpoint; the wrapper
// only appends a warning to its result, or throws an error carrying one. That
// keeps the thing under test honest: what is faked is the cleanup outcome, not
// the oracle.
//
// Two routes exist for warnings to reach a caller, and they are NOT symmetric.
// On success they arrive on the result. On failure `withCheckpointOracle`
// attaches them to the thrown error, which is the only way they survive, so a
// preview that ignored them would silently lose the record of a stranded
// worktree exactly when something had already gone wrong.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  mode: "passthrough" as "passthrough" | "warn_on_success" | "throw_with_warnings",
}));

const SUCCESS_WARNING = "simulated: git worktree remove --force failed";
const FAILURE_WARNING = "simulated: rm -rf tempRoot failed";

vi.mock("../src/checkpoint-oracle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/checkpoint-oracle.js")>();
  return {
    ...actual,
    withCheckpointOracle: async (
      ...args: Parameters<typeof actual.withCheckpointOracle>
    ): ReturnType<typeof actual.withCheckpointOracle> => {
      if (hooks.mode === "throw_with_warnings") {
        // Exactly the shape the real one produces: the error carries the
        // warnings, because a thrown value is the only carrier left.
        throw Object.assign(new Error("simulated oracle failure"), {
          cleanupWarnings: [FAILURE_WARNING],
        });
      }
      const result = await actual.withCheckpointOracle(...args);
      return hooks.mode === "warn_on_success"
        ? { ...result, cleanupWarnings: [SUCCESS_WARNING] }
        : result;
    },
  };
});

import { createCheckpoint } from "../src/checkpoint.js";
import { previewSelectiveRestore } from "../src/preview-selective.js";
import type { SelectiveRestorePlan } from "../src/restore-selective.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

/** An empty selection: this suite is about the lifecycle, not classification. */
const EMPTY_PLAN: SelectiveRestorePlan = {
  outcome: "noop",
  capabilities: { symlinkCheckout: true },
  selectedChangeGroupIds: [],
  classifications: [],
  topologyDependencyPaths: [],
  operations: [],
  conflicts: [],
};

let tmpRoot: string;
let repoRoot: string;
let checkpointDir: string;

beforeEach(async () => {
  hooks.mode = "passthrough";
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-previewwarn-"));
  repoRoot = join(tmpRoot, "repo");
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
  await writeFile(join(repoRoot, "a.txt"), "a\n");
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "-m", "initial"]);

  checkpointDir = join(tmpRoot, "cp");
  await mkdir(checkpointDir, { recursive: true });
  await createCheckpoint({ repoRoot, checkpointDir, rollbackExcludePatterns: [] });
});

afterEach(async () => {
  hooks.mode = "passthrough";
  await rm(tmpRoot, { recursive: true, force: true });
});

const preview = () =>
  previewSelectiveRestore({ repoRoot, sessionCheckpointDir: checkpointDir, plan: EMPTY_PLAN });

describe("previewSelectiveRestore: cleanup warnings", () => {
  it("passes them through on SUCCESS rather than reporting a clean run", async () => {
    hooks.mode = "warn_on_success";

    const result = await preview();

    if (result.outcome !== "previewed") throw new Error("expected previewed");
    // The preview succeeded AND something was stranded. Both facts survive.
    expect(result.cleanupWarnings).toEqual([SUCCESS_WARNING]);
  });

  it("recovers them from the thrown error on FAILURE", async () => {
    hooks.mode = "throw_with_warnings";

    const result = await preview();

    if (result.outcome !== "failed") throw new Error("expected failed");
    // Attached to the error is the only route they survive a throw. Dropping
    // them would lose the stranded-worktree record precisely when something
    // already went wrong.
    expect(result.cleanupWarnings).toEqual([FAILURE_WARNING]);
    expect(result.cause).toBeInstanceOf(Error);
  });

  it("reports none when the real oracle strands nothing", async () => {
    // The passthrough control: without it, the two cases above would pass even
    // if the preview always echoed whatever it was handed.
    const result = await preview();

    if (result.outcome !== "previewed") throw new Error("expected previewed");
    expect(result.cleanupWarnings).toEqual([]);
  });
});
