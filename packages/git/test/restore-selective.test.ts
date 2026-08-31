// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for selective-restore phase-1 planning (M 0.8.0 step 10A).
//
// Two sections:
//   A. derivePhysicalCandidates -- pure, no repository
//   B. planSelectiveRestore     -- REAL repository + schema-validated,
//                                  hand-built contribution
//
// Section B uses a real repo because the planner OBSERVES reality:
// readIndexSnapshot, observePathState, gitCheckoutSymlinksEnabled, and raw
// readdir. Typed literals cannot exercise it.
//
// The contribution is hand-built rather than produced by captureContribution,
// so a failure here is attributable to the PLANNER. The producer/consumer seam
// is proven separately in restore-selective-capture.test.ts; a failure there
// with this file green means the capture/restore contract drifted.
//
// Every fixture goes through SessionContributionFileSchema.parse and real
// deriveChangeGroupId, so no test can describe a state the persisted contract
// rejects. `expectedAfter` is the real observation (hand-building index OIDs
// would only read them back from the repo, making the guard circular), but each
// fixture asserts the observed SHAPE plus an independently computed content
// digest, so a setup typo cannot masquerade as planner behavior.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  IndexState,
  PathState,
  SessionContributionEntry,
  SessionContributionFile,
} from "@viberevert/session-format";
import {
  CONTRIBUTION_FILE_SCHEMA_VERSION,
  deriveChangeGroupId,
  SessionContributionFileSchema,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { observePathState, readIndexSnapshot } from "../src/path-state.js";
import {
  ABSENT_PATH_STATE,
  derivePhysicalCandidates,
  deriveSelectiveTopology,
  planSelectiveRestore,
  type SelectiveRestoreClassification,
  type SelectiveRestorePlan,
} from "../src/restore-selective.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Fixtures
// =============================================================================

const SESSION_ID = "sess_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const CHECKPOINT_ID = "cp_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const CAPTURED_AT = "2026-05-04T10:30:11Z";
const ENDED_AT = "2026-05-04T11:00:00Z";

const sha256 = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

async function gitOut(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, windowsHide: true });
  return String(stdout);
}

interface TestRepo {
  readonly repoRoot: string;
  readonly cleanup: () => Promise<void>;
}

async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-planfixture-"));
  const repoRoot = join(tmp, "repo");
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await git(repoRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "-m", "initial"]);
  return { repoRoot, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

async function write(repo: TestRepo, rel: string, content: string): Promise<void> {
  const abs = join(repo.repoRoot, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

/** The observer's view of one path, used as `expectedAfter` in most fixtures. */
async function currentState(repoRoot: string, path: string): Promise<PathState> {
  const index = await readIndexSnapshot(repoRoot);
  return (await observePathState(repoRoot, path, index)).state;
}

/** The real index entry at `path`, for fixtures that need a genuine oid. */
async function indexEntryAt(repoRoot: string, path: string): Promise<IndexState> {
  const line = (await gitOut(repoRoot, ["ls-files", "-s", "--", path])).trim();
  if (line === "") return { kind: "absent" };
  const [meta] = line.split("\t");
  const parts = (meta ?? "").split(/\s+/);
  const mode = parts[0];
  const oid = parts[1];
  if (mode === undefined || oid === undefined) throw new Error(`unparsable ls-files: ${line}`);
  if (mode !== "100644" && mode !== "100755" && mode !== "120000" && mode !== "160000") {
    throw new Error(`unexpected index mode ${mode}`);
  }
  return { kind: "entry", mode, oid };
}

function regularWorktree(
  content: string,
  executable: boolean | null = false,
): PathState["worktree"] {
  return { kind: "regular", content_ref: sha256(content), executable };
}

interface EntrySpec {
  readonly path: string;
  readonly previousPath?: string;
  readonly operation: SessionContributionEntry["operation"];
  readonly before: PathState;
  readonly after: PathState;
}

function entryFor(spec: EntrySpec): SessionContributionEntry {
  const aliases = spec.previousPath !== undefined ? [spec.path, spec.previousPath] : [spec.path];
  return {
    path: spec.path,
    ...(spec.previousPath !== undefined ? { previous_path: spec.previousPath } : {}),
    operation: spec.operation,
    facets: [],
    change_group_id: deriveChangeGroupId(SESSION_ID, aliases),
    before: spec.before,
    after: spec.after,
    content_delta: { kind: "none" },
  };
}

/** Schema-VALIDATED, so no fixture can describe a state the contract rejects. */
function buildContribution(entries: readonly SessionContributionEntry[]): SessionContributionFile {
  return SessionContributionFileSchema.parse({
    schema_version: CONTRIBUTION_FILE_SCHEMA_VERSION,
    session_id: SESSION_ID,
    checkpoint_id: CHECKPOINT_ID,
    before_head_sha: "0".repeat(40),
    after_head_sha: "1".repeat(40),
    captured_at: CAPTURED_AT,
    ended_at: ENDED_AT,
    entries: [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
}

const groupsOf = (contribution: SessionContributionFile): readonly string[] => [
  ...new Set(contribution.entries.map((e) => e.change_group_id)),
];

/**
 * Guard against a Git setup typo masquerading as planner behavior: assert with
 * the REAL observer that the fixture tree is what the test claims.
 */
async function assertObserved(
  repoRoot: string,
  path: string,
  expected: { kind: PathState["worktree"]["kind"] } & Record<string, unknown>,
): Promise<void> {
  const state = await currentState(repoRoot, path);
  expect(state.worktree).toMatchObject(expected);
}

function conflictAt(plan: SelectiveRestorePlan, path: string): boolean {
  return plan.conflicts.some((c) => c.path === path);
}

function hasCollisionConflict(plan: SelectiveRestorePlan): boolean {
  return plan.conflicts.some(
    (c) =>
      c.reason.code === "UNSUPPORTED_STATE" && c.reason.detail.includes("file/directory collision"),
  );
}

function operationPaths(plan: SelectiveRestorePlan): readonly string[] {
  return plan.operations.map((o) => o.path);
}

/**
 * Project-visible physical state, for the "planner mutates nothing" test.
 *
 * Deliberately NOT `git status`: that would miss an executable-bit change, a
 * symlink retarget, or an ignored file. Captures regular-file digests plus
 * executable state, symlink targets, directory membership, the full index, and
 * HEAD. `.git` internal churn is out of scope.
 */
async function projectSnapshot(repoRoot: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const dirents = await readdir(join(repoRoot, ...(rel === "" ? [] : rel.split("/"))), {
      withFileTypes: true,
    });
    dirents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const d of dirents) {
      if (rel === "" && d.name === ".git") continue;
      const child = rel === "" ? d.name : `${rel}/${d.name}`;
      const abs = join(repoRoot, ...child.split("/"));
      if (d.isSymbolicLink()) {
        lines.push(`symlink ${child} -> ${await readlink(abs)}`);
      } else if (d.isDirectory()) {
        lines.push(`dir ${child}`);
        await walk(child);
      } else {
        const stats = await lstat(abs);
        const content = await readFile(abs);
        lines.push(
          `file ${child} ${createHash("sha256").update(content).digest("hex")} mode=${
            (stats.mode & 0o111) !== 0 ? "x" : "-"
          }`,
        );
      }
    }
  };
  await walk("");
  lines.push(`index ${(await gitOut(repoRoot, ["ls-files", "-s"])).trim()}`);
  lines.push(`head ${(await gitOut(repoRoot, ["rev-parse", "HEAD"])).trim()}`);
  return lines.join("\n");
}

// =============================================================================
// Section A -- derivePhysicalCandidates (pure)
// =============================================================================

describe("derivePhysicalCandidates", () => {
  it("1: yields ONE candidate for an ordinary entry, carrying the entry's states", () => {
    const before: PathState = { worktree: regularWorktree("old\n"), index: { kind: "absent" } };
    const after: PathState = { worktree: regularWorktree("new\n"), index: { kind: "absent" } };
    const entry = entryFor({ path: "src/a.ts", operation: "modified", before, after });

    expect(derivePhysicalCandidates(entry)).toEqual([
      {
        path: "src/a.ts",
        changeGroupId: entry.change_group_id,
        expectedBefore: before,
        expectedAfter: after,
      },
    ]);
  });

  it("2: yields TWO candidates for a rename, with the implicit absent corners", () => {
    // entry.before is the state of previous_path; entry.after is the state of
    // path. The accepted-rename invariant licenses the other two corners.
    const before: PathState = { worktree: regularWorktree("hook\n"), index: { kind: "absent" } };
    const after: PathState = { worktree: regularWorktree("hook\n"), index: { kind: "absent" } };
    const entry = entryFor({
      path: "utils/webhook.ts",
      previousPath: "payments/webhook.ts",
      operation: "renamed",
      before,
      after,
    });

    expect(derivePhysicalCandidates(entry)).toEqual([
      {
        path: "payments/webhook.ts",
        changeGroupId: entry.change_group_id,
        expectedBefore: before,
        expectedAfter: ABSENT_PATH_STATE,
      },
      {
        path: "utils/webhook.ts",
        changeGroupId: entry.change_group_id,
        expectedBefore: ABSENT_PATH_STATE,
        expectedAfter: after,
      },
    ]);
  });

  it("2b: THROWS on a renamed entry with no previous_path rather than reinterpreting it", () => {
    // Reinterpreting it as ordinary would plan one endpoint of a two-endpoint
    // change and leave the other alias untouched.
    const malformed = {
      ...entryFor({
        path: "utils/webhook.ts",
        operation: "modified",
        before: ABSENT_PATH_STATE,
        after: { worktree: regularWorktree("x\n"), index: { kind: "absent" } },
      }),
      operation: "renamed" as const,
    };
    expect(() => derivePhysicalCandidates(malformed)).toThrow(/has operation "renamed"/);
  });
});

// =============================================================================
// Section B -- planSelectiveRestore (real repository)
// =============================================================================

describe("planSelectiveRestore -- classification and precedence", () => {
  it("3: the rename overwrite regression -- a recreated OLD path refuses", async () => {
    const repo = await setupRepo();
    try {
      // Session renamed old.ts -> new.ts. A human later recreated old.ts.
      await write(repo, "new.ts", "moved\n");
      await write(repo, "old.ts", "HUMAN WORK\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await assertObserved(repo.repoRoot, "old.ts", {
        kind: "regular",
        content_ref: sha256("HUMAN WORK\n"),
      });

      const contribution = buildContribution([
        entryFor({
          path: "new.ts",
          previousPath: "old.ts",
          operation: "renamed",
          before: {
            worktree: regularWorktree("moved\n"),
            index: await indexEntryAt(repo.repoRoot, "new.ts"),
          },
          after: await currentState(repo.repoRoot, "new.ts"),
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });

      // old.ts observes as neither entry.before nor ABSENT, so it drifts.
      expect(plan.outcome).toBe("conflicted");
      expect(conflictAt(plan, "old.ts")).toBe(true);
      expect(await readFile(join(repo.repoRoot, "old.ts"), "utf8")).toBe("HUMAN WORK\n");
    } finally {
      await repo.cleanup();
    }
  });

  it("4: exact-BEFORE beats an UNSUPPORTED shape -- already_at_before wins", async () => {
    const repo = await setupRepo();
    try {
      // A real gitlink index entry, which unsupportedStateDetail() refuses on
      // sight. Using HEAD as the oid keeps this cross-platform.
      const head = (await gitOut(repo.repoRoot, ["rev-parse", "HEAD"])).trim();
      await git(repo.repoRoot, ["update-index", "--add", "--cacheinfo", `160000,${head},gitlink`]);
      const observed = await currentState(repo.repoRoot, "gitlink");
      expect(observed).toMatchObject({
        worktree: { kind: "absent" },
        index: { kind: "entry", mode: "160000" },
      });

      // Current EQUALS the unsupported BEFORE. Nothing needs writing, so the
      // exact-BEFORE branch must fire before unsupportedStateDetail() runs.
      const contribution = buildContribution([
        entryFor({
          path: "gitlink",
          operation: "deleted",
          before: observed,
          after: ABSENT_PATH_STATE,
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("noop");
      expect(plan.classifications[0]?.outcome).toEqual({
        kind: "planned",
        disposition: "already_at_before",
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("5: an unsupported target outranks exact-AFTER", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "current\n");
      await git(repo.repoRoot, ["add", "-A"]);

      // Current == AFTER, so without the unsupported check this would be
      // restore_required -- and would then fail mid-transplant.
      const contribution = buildContribution([
        entryFor({
          path: "a.txt",
          operation: "modified",
          before: {
            worktree: regularWorktree("before\n"),
            index: { kind: "entry", mode: "160000", oid: "a".repeat(40) },
          },
          after: await currentState(repo.repoRoot, "a.txt"),
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("conflicted");
      expect(plan.conflicts[0]?.reason).toEqual({
        code: "UNSUPPORTED_STATE",
        detail: "target index entry is a gitlink (submodule)",
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("6: an unrecognized shape falls through to MODIFIED_SINCE", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "drifted\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const contribution = buildContribution([
        entryFor({
          path: "a.txt",
          operation: "modified",
          before: { worktree: regularWorktree("before\n"), index: { kind: "absent" } },
          after: { worktree: regularWorktree("after\n"), index: { kind: "absent" } },
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("conflicted");
      expect(plan.conflicts[0]?.reason).toEqual({ code: "MODIFIED_SINCE" });
    } finally {
      await repo.cleanup();
    }
  });

  it("7: already_at_before produces NO operation", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "same\n");
      await write(repo, "b.txt", "changed\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const aState = await currentState(repo.repoRoot, "a.txt");

      const contribution = buildContribution([
        entryFor({ path: "a.txt", operation: "modified", before: aState, after: aState }),
        entryFor({
          path: "b.txt",
          operation: "modified",
          before: { worktree: regularWorktree("b-before\n"), index: { kind: "absent" } },
          after: await currentState(repo.repoRoot, "b.txt"),
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("eligible");
      expect(operationPaths(plan)).toEqual(["b.txt"]);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("planSelectiveRestore -- selection-wide eligibility", () => {
  it("8: one drifted endpoint conflicts its WHOLE group", async () => {
    const repo = await setupRepo();
    try {
      // A rename group owns two physical paths. Drifting one must take the
      // other with it -- a group is not partially executable.
      await write(repo, "new.ts", "DRIFTED\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await assertObserved(repo.repoRoot, "old.ts", { kind: "absent" });

      const contribution = buildContribution([
        entryFor({
          path: "new.ts",
          previousPath: "old.ts",
          operation: "renamed",
          before: { worktree: regularWorktree("moved\n"), index: { kind: "absent" } },
          after: { worktree: regularWorktree("expected-after\n"), index: { kind: "absent" } },
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });

      // OLD is exactly at its ABSENT AFTER corner, so by itself it would
      // require restoration. NEW drifted, so the selection yields nothing
      // executable.
      expect(plan.outcome).toBe("conflicted");
      expect(plan.operations).toEqual([]);
      expect(plan.classifications.find((c) => c.path === "old.ts")?.outcome).toEqual({
        kind: "planned",
        disposition: "restore_required",
      });
      expect(conflictAt(plan, "new.ts")).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("9: a conflict in one selected group refuses the whole selection", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "clean.txt", "after\n");
      await write(repo, "drifted.txt", "unexpected\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const contribution = buildContribution([
        entryFor({
          path: "clean.txt",
          operation: "modified",
          before: { worktree: regularWorktree("clean-before\n"), index: { kind: "absent" } },
          after: await currentState(repo.repoRoot, "clean.txt"),
        }),
        entryFor({
          path: "drifted.txt",
          operation: "modified",
          before: { worktree: regularWorktree("d-before\n"), index: { kind: "absent" } },
          after: { worktree: regularWorktree("d-after\n"), index: { kind: "absent" } },
        }),
      ]);
      expect(groupsOf(contribution)).toHaveLength(2);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      // Structural: there is no clean subset to execute by mistake.
      expect(plan.outcome).toBe("conflicted");
      expect(plan.operations).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("10: the conflicted variant still carries COMPLETE classifications", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "clean.txt", "after\n");
      await write(repo, "drifted.txt", "unexpected\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const contribution = buildContribution([
        entryFor({
          path: "clean.txt",
          operation: "modified",
          before: { worktree: regularWorktree("clean-before\n"), index: { kind: "absent" } },
          after: await currentState(repo.repoRoot, "clean.txt"),
        }),
        entryFor({
          path: "drifted.txt",
          operation: "modified",
          before: { worktree: regularWorktree("d-before\n"), index: { kind: "absent" } },
          after: { worktree: regularWorktree("d-after\n"), index: { kind: "absent" } },
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      // The clean member must remain visible in the preview even though the
      // selection refuses; otherwise the user cannot see what would have run.
      expect(plan.classifications.map((c) => c.path).sort()).toEqual(["clean.txt", "drifted.txt"]);
      expect(plan.classifications.find((c) => c.path === "clean.txt")?.outcome).toEqual({
        kind: "planned",
        disposition: "restore_required",
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("11: the planner mutates NOTHING", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "tracked.txt", "v1\n");
      await write(repo, "nested/deep/file.txt", "deep\n");
      await write(repo, "untracked.txt", "loose\n");
      await git(repo.repoRoot, ["add", "tracked.txt", "nested/deep/file.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "seed"]);
      await write(repo, "tracked.txt", "v2\n");

      const contribution = buildContribution([
        entryFor({
          path: "tracked.txt",
          operation: "modified",
          before: { worktree: regularWorktree("v1\n"), index: { kind: "absent" } },
          after: await currentState(repo.repoRoot, "tracked.txt"),
        }),
      ]);

      // Digests, executable bits, symlink targets, directory membership, the
      // whole index, and HEAD -- not `git status`.
      const before = await projectSnapshot(repo.repoRoot);
      await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(await projectSnapshot(repo.repoRoot)).toBe(before);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("planSelectiveRestore -- noop derivation (stage D)", () => {
  it("11a: every path already at BEFORE -> noop, with no operations", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "settled\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const state = await currentState(repo.repoRoot, "a.txt");

      const contribution = buildContribution([
        entryFor({ path: "a.txt", operation: "modified", before: state, after: state }),
      ]);
      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("noop");
      expect(plan.operations).toEqual([]);
      expect(plan.conflicts).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("11b: mixed restore_required + already_at_before -> only the required write", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "settled.txt", "settled\n");
      await write(repo, "moved.txt", "after\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const settled = await currentState(repo.repoRoot, "settled.txt");

      const contribution = buildContribution([
        entryFor({ path: "settled.txt", operation: "modified", before: settled, after: settled }),
        entryFor({
          path: "moved.txt",
          operation: "modified",
          before: { worktree: regularWorktree("before\n"), index: { kind: "absent" } },
          after: await currentState(repo.repoRoot, "moved.txt"),
        }),
      ]);
      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("eligible");
      expect(operationPaths(plan)).toEqual(["moved.txt"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("11c: an unselected group contributes no candidates at all", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "selected.txt", "after\n");
      await write(repo, "unselected.txt", "drifted-badly\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const selectedEntry = entryFor({
        path: "selected.txt",
        operation: "modified",
        before: { worktree: regularWorktree("before\n"), index: { kind: "absent" } },
        after: await currentState(repo.repoRoot, "selected.txt"),
      });
      const otherEntry = entryFor({
        path: "unselected.txt",
        operation: "modified",
        before: { worktree: regularWorktree("x\n"), index: { kind: "absent" } },
        after: { worktree: regularWorktree("y\n"), index: { kind: "absent" } },
      });
      const contribution = buildContribution([selectedEntry, otherEntry]);

      // Only the first group is selected; the drifted one must not conflict.
      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: [selectedEntry.change_group_id],
      });
      expect(plan.outcome).toBe("eligible");
      expect(plan.classifications.map((c) => c.path)).toEqual(["selected.txt"]);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Topology eligibility (stage C) and parent synthesis (stage D)
// =============================================================================
//
// Every test here builds a DESTRUCTIVE transition: `a` is currently a directory
// whose BEFORE worktree is a regular file, so restoring it destroys everything
// beneath. That is the only shape in which C1a's descendant rules apply.

describe("planSelectiveRestore -- destructive-directory descendants (C1a)", () => {
  async function destructiveAncestor(repo: TestRepo): Promise<SessionContributionEntry> {
    return entryFor({
      path: "a",
      operation: "type_changed",
      before: { worktree: regularWorktree("a-was-a-file\n"), index: { kind: "absent" } },
      after: await currentState(repo.repoRoot, "a"),
    });
  }

  it("24: an UNCOVERED leaf beneath the transition refuses, and survives", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a/uncovered.txt", "human work\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await assertObserved(repo.repoRoot, "a", { kind: "directory" });

      const contribution = buildContribution([await destructiveAncestor(repo)]);
      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });

      expect(plan.outcome).toBe("conflicted");
      expect(
        plan.conflicts.some(
          (c) =>
            c.reason.code === "UNSUPPORTED_STATE" && c.reason.detail.includes("a/uncovered.txt"),
        ),
      ).toBe(true);
      // Nothing mutates, so the file is still there.
      expect(await readFile(join(repo.repoRoot, "a", "uncovered.txt"), "utf8")).toBe(
        "human work\n",
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("24a: a descendant covered by a DIFFERENT selected group is eligible", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a/other.txt", "goes away\n");
      await git(repo.repoRoot, ["add", "-A"]);

      // Distinct alias sets give distinct change_group_ids. Group id must not
      // make this unsafe: the whole selection is atomic.
      const contribution = buildContribution([
        await destructiveAncestor(repo),
        entryFor({
          path: "a/other.txt",
          operation: "added",
          before: ABSENT_PATH_STATE,
          after: await currentState(repo.repoRoot, "a/other.txt"),
        }),
      ]);
      expect(groupsOf(contribution)).toHaveLength(2);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("eligible");
    } finally {
      await repo.cleanup();
    }
  });

  it("24b: a descendant with a PRESENT before-worktree cannot exist beneath a file", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a/present.txt", "current\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const contribution = buildContribution([
        await destructiveAncestor(repo),
        entryFor({
          path: "a/present.txt",
          operation: "modified",
          // BEFORE claims a real file beneath `a` -- impossible once `a` is a
          // regular file, so there is no reconstruction path.
          before: { worktree: regularWorktree("was here\n"), index: { kind: "absent" } },
          after: await currentState(repo.repoRoot, "a/present.txt"),
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("conflicted");
      expect(conflictAt(plan, "a/present.txt")).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("24b2: MIXED AXIS -- absent before-worktree with an index entry is not refused by C1", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a/b", "content\n");
      await git(repo.repoRoot, ["add", "-A"]);
      const bIndex = await indexEntryAt(repo.repoRoot, "a/b");

      // Presence spans BOTH axes, and git permits divergence. Testing with full
      // ABSENT_PATH_STATE equality would wrongly refuse this coherent state.
      const contribution = buildContribution([
        await destructiveAncestor(repo),
        entryFor({
          path: "a/b",
          operation: "modified",
          before: { worktree: { kind: "absent" }, index: bIndex },
          after: await currentState(repo.repoRoot, "a/b"),
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("eligible");
      expect(conflictAt(plan, "a/b")).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("24b3: an UNCOVERED EMPTY DIRECTORY refuses, and survives", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a/covered.txt", "goes away\n");
      await git(repo.repoRoot, ["add", "-A"]);
      // Created independently by a human. Git cannot track it, but it is real
      // physical state the selection has no authority to destroy.
      await mkdir(join(repo.repoRoot, "a", "unrelated-empty-dir"), { recursive: true });

      const contribution = buildContribution([
        await destructiveAncestor(repo),
        entryFor({
          path: "a/covered.txt",
          operation: "added",
          before: ABSENT_PATH_STATE,
          after: await currentState(repo.repoRoot, "a/covered.txt"),
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("conflicted");
      expect(
        plan.conflicts.some(
          (c) =>
            c.reason.code === "UNSUPPORTED_STATE" &&
            c.reason.detail.includes("a/unrelated-empty-dir"),
        ),
      ).toBe(true);
      await expect(lstat(join(repo.repoRoot, "a", "unrelated-empty-dir"))).resolves.toBeDefined();
    } finally {
      await repo.cleanup();
    }
  });

  it("24b4: a STRUCTURAL intermediary holding covered state does NOT refuse", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a/sub/covered.txt", "goes away\n");
      await git(repo.repoRoot, ["add", "-A"]);

      // `a/sub` has no contribution entry -- git never represents intermediate
      // directories -- but it contains covered state, so it is structural.
      const contribution = buildContribution([
        await destructiveAncestor(repo),
        entryFor({
          path: "a/sub/covered.txt",
          operation: "added",
          before: ABSENT_PATH_STATE,
          after: await currentState(repo.repoRoot, "a/sub/covered.txt"),
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("eligible");
      expect(plan.conflicts).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("planSelectiveRestore -- symlink capability is worktree-only", () => {
  it("24b5a: core.symlinks=false refuses a BEFORE worktree symlink", async () => {
    const repo = await setupRepo();
    try {
      // Set explicitly rather than depending on the platform default, so this
      // runs identically everywhere.
      await git(repo.repoRoot, ["config", "core.symlinks", "false"]);
      await write(repo, "link", "current regular content\n");
      await git(repo.repoRoot, ["add", "-A"]);

      const contribution = buildContribution([
        entryFor({
          path: "link",
          operation: "type_changed",
          before: {
            worktree: { kind: "symlink", target_ref: sha256("target.txt") },
            index: { kind: "absent" },
          },
          after: await currentState(repo.repoRoot, "link"),
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.capabilities).toEqual({ symlinkCheckout: false });
      expect(plan.outcome).toBe("conflicted");
      expect(plan.conflicts[0]?.reason).toEqual({
        code: "UNSUPPORTED_STATE",
        detail: "restoring this path would create a symlink, but core.symlinks is false",
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("24b5b: core.symlinks=false does NOT refuse an index-only 120000 target", async () => {
    const repo = await setupRepo();
    try {
      await git(repo.repoRoot, ["config", "core.symlinks", "false"]);
      await assertObserved(repo.repoRoot, "linkish", { kind: "absent" });

      // Restoring this needs only `update-index --cacheinfo 120000,...`; no OS
      // symlink is created, so the capability must not refuse it.
      const contribution = buildContribution([
        entryFor({
          path: "linkish",
          operation: "deleted",
          before: {
            worktree: { kind: "absent" },
            index: { kind: "entry", mode: "120000", oid: "a".repeat(40) },
          },
          after: ABSENT_PATH_STATE,
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.capabilities).toEqual({ symlinkCheckout: false });
      expect(plan.outcome).toBe("eligible");
      expect(operationPaths(plan)).toEqual(["linkish"]);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("planSelectiveRestore -- parent synthesis and dependency (C1b, stage D)", () => {
  it("24d: an absent parent yields create_parent_directory that PRESERVES its index axis", async () => {
    const repo = await setupRepo();
    try {
      // `foo` has an index entry but no worktree node -- the grounded
      // mixed-axis shape. Creating `foo/` must not touch that entry.
      await write(repo, "scratch", "blob source\n");
      await git(repo.repoRoot, ["add", "scratch"]);
      const oid = (await gitOut(repo.repoRoot, ["rev-parse", ":scratch"])).trim();
      await git(repo.repoRoot, ["update-index", "--add", "--cacheinfo", `100644,${oid},foo`]);
      await assertObserved(repo.repoRoot, "foo", { kind: "absent" });
      const fooIndex = await indexEntryAt(repo.repoRoot, "foo");
      expect(fooIndex.kind).toBe("entry");

      const contribution = buildContribution([
        entryFor({
          path: "foo/bar.txt",
          operation: "deleted",
          before: { worktree: regularWorktree("restored\n"), index: { kind: "absent" } },
          after: ABSENT_PATH_STATE,
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("eligible");
      const parent = plan.operations.find((o) => o.kind === "create_parent_directory");
      expect(parent?.path).toBe("foo");
      // The synthetic parent has NO authority over the index axis.
      expect(parent?.target).toEqual({ worktree: { kind: "directory" }, index: fooIndex });
      expect(parent?.kind === "create_parent_directory" && parent.requiredBy).toEqual([
        "foo/bar.txt",
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it("24e: an EXISTING parent directory is a dependency, not an operation", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "foo/keep.txt", "already here\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await assertObserved(repo.repoRoot, "foo", { kind: "directory" });

      const contribution = buildContribution([
        entryFor({
          path: "foo/bar.txt",
          operation: "deleted",
          before: { worktree: regularWorktree("restored\n"), index: { kind: "absent" } },
          after: ABSENT_PATH_STATE,
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("eligible");
      // No write, but LOAD-BEARING: it must remain a directory until mutation,
      // so it joins the protected domain via topologyDependencyPaths.
      expect(plan.topologyDependencyPaths).toEqual(["foo"]);
      expect(plan.operations.some((o) => o.kind === "create_parent_directory")).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("planSelectiveRestore -- projected index D/F topology (C2)", () => {
  it("24f: a target entry at `a` collides with a SURVIVING entry at `a/b`", async () => {
    const repo = await setupRepo();
    try {
      // Current index is collision-FREE; the collision exists only in the
      // restored index, which is exactly what C2 must catch before any write.
      await write(repo, "a/b", "survivor\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await assertObserved(repo.repoRoot, "a", { kind: "directory" });

      const contribution = buildContribution([
        entryFor({
          path: "a",
          operation: "type_changed",
          before: {
            worktree: { kind: "absent" },
            index: { kind: "entry", mode: "100644", oid: "b".repeat(40) },
          },
          after: await currentState(repo.repoRoot, "a"),
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("conflicted");
      expect(hasCollisionConflict(plan)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("24g: a target entry at `a/b` collides with a SURVIVING entry at `a`", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "a", "a is a file\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await assertObserved(repo.repoRoot, "a", { kind: "regular" });

      const contribution = buildContribution([
        entryFor({
          path: "a/b",
          operation: "deleted",
          before: {
            worktree: { kind: "absent" },
            index: { kind: "entry", mode: "100644", oid: "c".repeat(40) },
          },
          after: ABSENT_PATH_STATE,
        }),
      ]);

      const plan = await planSelectiveRestore({
        repoRoot: repo.repoRoot,
        contribution,
        selectedChangeGroupIds: groupsOf(contribution),
      });
      expect(plan.outcome).toBe("conflicted");
      expect(hasCollisionConflict(plan)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section C: the shared derivation seam (10B)
// =============================================================================
//
// `deriveSelectiveTopology` is the algebra plan stabilization reuses, so its
// LOOKUP CONTRACT is load-bearing, not an implementation detail. The callbacks
// are lookup-only and complete: a path the caller never gathered is an internal
// construction error.
//
// The helper cannot detect a callback that silently returns `[]` or invents an
// absent state -- from inside, that is indistinguishable from a genuinely empty
// directory. So what these cases prove is narrower and exactly right: a
// callback that DOES raise is propagated rather than swallowed or converted
// into absence. The planner's own callbacks raise, and stabilization's must too.

describe("deriveSelectiveTopology lookup contract", () => {
  const DIRECTORY_STATE: PathState = {
    worktree: { kind: "directory" },
    index: { kind: "absent" },
  };
  const regularState = (content: string): PathState => ({
    worktree: { kind: "regular", content_ref: sha256(content), executable: false },
    index: { kind: "absent" },
  });

  const planned = (
    path: string,
    observed: PathState,
    expectedBefore: PathState,
  ): SelectiveRestoreClassification => ({
    path,
    changeGroupId: "cg_seam",
    expectedBefore,
    expectedAfter: observed,
    observed,
    outcome: { kind: "planned", disposition: "restore_required" },
  });

  /** Map-backed and throwing on miss, exactly as the planner builds them. */
  const lookups = (
    descendants: ReadonlyMap<string, readonly { path: string; kind: "directory" | "leaf" }[]>,
    ancestors: ReadonlyMap<string, PathState>,
  ) => ({
    descendantsOf: (path: string) => {
      const found = descendants.get(path);
      if (found === undefined) throw new Error(`descendants of "${path}" were never gathered`);
      return found;
    },
    ancestorStateOf: (path: string) => {
      const found = ancestors.get(path);
      if (found === undefined) throw new Error(`ancestor state for "${path}" was never gathered`);
      return found;
    },
  });

  // A destructive root: currently a directory, restoring to a regular file, so
  // C1a must ask for its descendants.
  const destructiveInputs = [planned("d", DIRECTORY_STATE, regularState("was a file\n"))];

  // A write whose BEFORE worktree is present under a non-classification
  // ancestor, so C1b must ask for `a`'s state.
  const ancestorInputs = [planned("a/b.txt", ABSENT_PATH_STATE, regularState("restored\n"))];

  it("28: an ungathered descendant root propagates out of the derivation", () => {
    expect(() =>
      deriveSelectiveTopology({
        classifications: destructiveInputs,
        ...lookups(new Map(), new Map()),
        indexPopulation: new Set(),
      }),
    ).toThrow(/descendants of "d" were never gathered/);
  });

  it("29: an ungathered ancestor state propagates out of the derivation", () => {
    expect(() =>
      deriveSelectiveTopology({
        classifications: ancestorInputs,
        ...lookups(new Map(), new Map()),
        indexPopulation: new Set(),
      }),
    ).toThrow(/ancestor state for "a" was never gathered/);
  });

  it("30: the SAME inputs derive cleanly once the lookups are complete", () => {
    // The positive control. Without it, cases 28 and 29 could pass because the
    // fixtures are malformed rather than because a lookup was missing.
    const destructive = deriveSelectiveTopology({
      classifications: destructiveInputs,
      ...lookups(new Map([["d", []]]), new Map()),
      indexPopulation: new Set(),
    });
    expect(destructive.conflicts).toEqual([]);
    expect(destructive.operations.map((o) => o.path)).toEqual(["d"]);

    const withAncestor = deriveSelectiveTopology({
      classifications: ancestorInputs,
      ...lookups(new Map(), new Map([["a", ABSENT_PATH_STATE]])),
      indexPopulation: new Set(),
    });
    expect(withAncestor.conflicts).toEqual([]);
    expect(withAncestor.operations.map((o) => o.path)).toEqual(["a", "a/b.txt"]);
    expect(withAncestor.operations.find((o) => o.path === "a")?.kind).toBe(
      "create_parent_directory",
    );
  });
});
