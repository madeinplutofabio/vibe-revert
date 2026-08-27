// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M 0.8.0 step 4b: session contribution capture.
//
// These are integration tests against real repositories and real checkpoints.
// Capture is defined by what git actually reports, so a mocked git would test
// the mock; the whole derivation contract exists because git's answers needed
// interpreting.
//
// The `publish` callback returns the capture itself, which is what lets a test
// assert on facts that are never persisted by this layer. `storeObject` doubles
// as the fence's injection seam: it runs during Pass A and never during Pass B.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createCheckpoint } from "../src/checkpoint.js";
import {
  buildContributionFile,
  type ContributionObject,
  captureContribution,
  SessionCheckpointBindingError,
  type StableContributionCapture,
} from "../src/contribution.js";

const execFileAsync = promisify(execFile);

/** A syntactically valid session id; the schema enforces the ULID shape. */
const SESSION_ID = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHECKPOINT_ID = "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

/**
 * Whether git is CONFIGURED to materialize tracked symlinks as symlinks here.
 *
 * A configuration gate, not a capability probe. git-for-Windows sets
 * `core.symlinks=false` at init when the environment cannot use them, and a
 * checkout then writes a regular file containing the target path. That is what
 * makes an oracle worktree observe a tracked symlink as `regular`, and it is
 * the specific reason the symlink case below cannot run everywhere.
 *
 * Host capability is a separate question, answered by the `symlink()` guard in
 * the test itself.
 */
async function gitCheckoutSymlinksEnabled(repoRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "--bool", "core.symlinks"], {
      cwd: repoRoot,
      windowsHide: true,
    });
    return stdout.trim() !== "false";
  } catch (error) {
    // Exit 1 means the key is unset. Git's effective default is symlink
    // checkout enabled, so let the real symlink fixture decide capability.
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) {
      return true;
    }
    throw error;
  }
}

interface TestRepo {
  readonly repoRoot: string;
  readonly checkpointDir: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Temp repo with one commit. The checkpoint is NOT taken here: most cases need
 * to arrange pre-session state first, so `checkpoint()` is a separate step.
 *
 * checkpointDir lives outside the repo, matching diff.test.ts and
 * checkpoint-oracle.test.ts.
 */
async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-contribfixture-"));
  const repoRoot = join(tmp, "repo");
  const checkpointDir = join(tmp, "checkpoint");
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await git(repoRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await git(repoRoot, ["add", ".gitignore", "README.md"]);
  await git(repoRoot, ["commit", "-m", "initial"]);
  return {
    repoRoot,
    checkpointDir,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Capture a checkpoint for this repo.
 *
 * `rollbackExcludePatterns` is an options field rather than a capture-time
 * argument because the exclusion policy now lives in the manifest: capture
 * reads the patterns the checkpoint recorded, so a fixture exercising them has
 * to set them HERE.
 */
async function checkpoint(
  repo: TestRepo,
  opts: {
    readonly sessionId?: string;
    readonly rollbackExcludePatterns?: readonly string[];
  } = {},
): Promise<void> {
  await mkdir(repo.checkpointDir, { recursive: true });
  await createCheckpoint({
    repoRoot: repo.repoRoot,
    checkpointDir: repo.checkpointDir,
    rollbackExcludePatterns: opts.rollbackExcludePatterns ?? [],
    sessionId: opts.sessionId ?? SESSION_ID,
  });
}

async function write(repo: TestRepo, rel: string, content: string | Buffer): Promise<void> {
  const abs = join(repo.repoRoot, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

interface CaptureRun {
  readonly capture: StableContributionCapture;
  readonly storedDigests: ReadonlySet<string>;
  readonly cleanupWarnings: readonly string[];
}

/**
 * Run a capture, recording every digest handed to the sink and returning the
 * capture itself from `publish`.
 *
 * `onStore` is the fence-injection hook: it runs inside Pass A, never Pass B.
 */
async function runCapture(
  repo: TestRepo,
  opts: {
    readonly additionalObservationPaths?: readonly string[];
    readonly sessionId?: string;
    readonly onStore?: () => Promise<void>;
  } = {},
): Promise<CaptureRun> {
  const storedDigests = new Set<string>();
  const result = await captureContribution<StableContributionCapture>(
    repo.repoRoot,
    repo.checkpointDir,
    {
      sessionId: opts.sessionId ?? SESSION_ID,
      checkpointId: CHECKPOINT_ID,
      additionalObservationPaths: opts.additionalObservationPaths ?? [],
      storeObject: async (object: ContributionObject) => {
        storedDigests.add(object.digest);
        if (opts.onStore !== undefined) await opts.onStore();
      },
      publish: async (capture) => capture,
    },
  );
  return {
    capture: result.value,
    storedDigests,
    cleanupWarnings: result.cleanupWarnings,
  };
}

function entryFor(capture: StableContributionCapture, path: string) {
  return capture.entries.find((e) => e.path === path);
}

// =============================================================================
// Baseline
// =============================================================================

describe("captureContribution: baseline", () => {
  it("produces no entries for an untouched tree", async () => {
    const repo = await setupRepo();
    try {
      await checkpoint(repo);
      const { capture } = await runCapture(repo);
      expect(capture.entries).toEqual([]);
      expect(capture.beforeHeadSha).toBe(capture.afterHeadSha);
    } finally {
      await repo.cleanup();
    }
  });

  it("carries checkpoint identity and both status forms through to the capture", async () => {
    const repo = await setupRepo();
    try {
      await checkpoint(repo);
      await write(repo, "README.md", "# changed\n");
      const { capture } = await runCapture(repo);
      expect(capture.sessionId).toBe(SESSION_ID);
      expect(capture.checkpointId).toBe(CHECKPOINT_ID);
      expect(capture.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // The audit form is text; the machine form is raw bytes. They are read by
      // two separate git invocations and both are fence members.
      expect(capture.afterStatusText).toContain("README.md");
      expect(capture.afterStatusZRaw.toString("utf8")).toContain("README.md");
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Ordinary operations
// =============================================================================

describe("captureContribution: ordinary operations", () => {
  it("classifies a modified tracked file with a text delta", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "src/a.txt", "alpha\nbeta\n");
      await git(repo.repoRoot, ["add", "src/a.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "add a"]);
      await checkpoint(repo);

      await write(repo, "src/a.txt", "alpha\nBETA\n");
      const { capture } = await runCapture(repo);

      const entry = entryFor(capture, "src/a.txt");
      expect(entry?.operation).toBe("modified");
      expect(entry?.facets).toContain("content_changed");
      expect(entry?.content_delta.kind).toBe("text");
      expect(entry?.previous_path).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it("classifies a new untracked file as added", async () => {
    const repo = await setupRepo();
    try {
      await checkpoint(repo);
      await write(repo, "new.txt", "hello\n");
      const { capture } = await runCapture(repo);

      const entry = entryFor(capture, "new.txt");
      expect(entry?.operation).toBe("added");
      expect(entry?.before.worktree.kind).toBe("absent");
      expect(entry?.after.worktree.kind).toBe("regular");
      expect(entry?.content_delta.kind).toBe("text");
    } finally {
      await repo.cleanup();
    }
  });

  it("classifies a deleted tracked file as deleted", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "gone.txt", "bye\n");
      await git(repo.repoRoot, ["add", "gone.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "add gone"]);
      await checkpoint(repo);

      await git(repo.repoRoot, ["rm", "gone.txt"]);
      const { capture } = await runCapture(repo);

      const entry = entryFor(capture, "gone.txt");
      expect(entry?.operation).toBe("deleted");
      expect(entry?.after.worktree.kind).toBe("absent");
      expect(entry?.after.index.kind).toBe("absent");
    } finally {
      await repo.cleanup();
    }
  });

  it("treats staging a pre-existing untracked file as modified, never type_changed", async () => {
    // Pins the rule that `index absent -> entry` is NOT type evidence. The
    // worktree never moved; only the index did.
    const repo = await setupRepo();
    try {
      await write(repo, "staged.txt", "same bytes\n");
      await checkpoint(repo);

      await git(repo.repoRoot, ["add", "staged.txt"]);
      const { capture } = await runCapture(repo);

      const entry = entryFor(capture, "staged.txt");
      expect(entry?.operation).toBe("modified");
      expect(entry?.operation).not.toBe("type_changed");
      expect(entry?.facets).toContain("index_changed");
      expect(entry?.facets).not.toContain("content_changed");
      expect(entry?.before.index.kind).toBe("absent");
      expect(entry?.after.index.kind).toBe("entry");
    } finally {
      await repo.cleanup();
    }
  });

  it("records an added empty file with no content delta", async () => {
    // Eligible transition, but git emits no hunk, so `text` would be illegal.
    const repo = await setupRepo();
    try {
      await checkpoint(repo);
      await write(repo, "empty.txt", "");
      const { capture } = await runCapture(repo);
      expect(entryFor(capture, "empty.txt")?.content_delta.kind).toBe("none");
    } finally {
      await repo.cleanup();
    }
  });

  it("marks a NUL-containing file as a binary delta", async () => {
    const repo = await setupRepo();
    try {
      await checkpoint(repo);
      await write(repo, "blob.bin", Buffer.from([0x00, 0x01, 0x02]));
      const { capture } = await runCapture(repo);
      expect(entryFor(capture, "blob.bin")?.content_delta.kind).toBe("binary");
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Renames
// =============================================================================

describe("captureContribution: renames", () => {
  it("accepts a staged rename and records both aliases in one entry", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "old.txt", "alpha\nbeta\n");
      await git(repo.repoRoot, ["add", "old.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "add old"]);
      await checkpoint(repo);

      await git(repo.repoRoot, ["mv", "old.txt", "new.txt"]);
      const { capture } = await runCapture(repo);

      const entry = entryFor(capture, "new.txt");
      expect(entry?.operation).toBe("renamed");
      expect(entry?.previous_path).toBe("old.txt");
      // The old alias is CONSUMED: it must not also appear as a deletion.
      expect(entryFor(capture, "old.txt")).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it("derives a content delta for a rename that also changed content", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "old.txt", "alpha\nbeta\ngamma\n");
      await git(repo.repoRoot, ["add", "old.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "add old"]);
      await checkpoint(repo);

      await git(repo.repoRoot, ["mv", "old.txt", "new.txt"]);
      await write(repo, "new.txt", "alpha\nBETA\ngamma\n");
      await git(repo.repoRoot, ["add", "new.txt"]);
      const { capture } = await runCapture(repo);

      const entry = entryFor(capture, "new.txt");
      expect(entry?.operation).toBe("renamed");
      expect(entry?.previous_path).toBe("old.txt");
      // Mirror normalization is what makes this a same-path delta rather than
      // an unrelated add plus remove.
      expect(entry?.content_delta.kind).toBe("text");
      expect(entry?.facets).toContain("content_changed");
    } finally {
      await repo.cleanup();
    }
  });

  it("does NOT treat committing a pre-existing staged rename as a session rename", async () => {
    // The case the four-state acceptance rule exists for. The rename happened
    // BEFORE the checkpoint; the session only committed it. `before(old)` is
    // already absent, so the proposal fails acceptance, and both paths are
    // then elided because neither state moved during the session.
    const repo = await setupRepo();
    try {
      await write(repo, "old.txt", "alpha\n");
      await git(repo.repoRoot, ["add", "old.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "add old"]);
      await git(repo.repoRoot, ["mv", "old.txt", "new.txt"]);
      await checkpoint(repo);

      await git(repo.repoRoot, ["commit", "-m", "commit the pre-existing rename"]);
      const { capture } = await runCapture(repo);

      expect(entryFor(capture, "new.txt")).toBeUndefined();
      expect(entryFor(capture, "old.txt")).toBeUndefined();
      // The session's only effect is visible on the header, not in entries.
      expect(capture.beforeHeadSha).not.toBe(capture.afterHeadSha);
    } finally {
      await repo.cleanup();
    }
  });

  it("keeps the non-store alias when a COMMITTED rename moves a file into the store", async () => {
    // The regression that forced the injected path policy in parseNameStatus.
    // Committing is what routes this through the committed-delta parser: with
    // the default validator, that parse would raise DiffParseError on the
    // store-side alias and capture would fail outright. With the injected
    // validator both aliases survive the parse, the store side is dropped at
    // candidate assembly, the rename is rejected as unprovable, and `src/a.txt`
    // still derives ordinarily.
    const repo = await setupRepo();
    try {
      await write(repo, "src/a.txt", "alpha\n");
      await git(repo.repoRoot, ["add", "src/a.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "add a"]);
      await checkpoint(repo);

      await write(repo, ".viberevert/a.txt", "alpha\n");
      await rm(join(repo.repoRoot, "src", "a.txt"));
      await git(repo.repoRoot, ["add", "-A"]);
      await git(repo.repoRoot, ["add", "-f", ".viberevert/a.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "move into the store"]);

      const { capture } = await runCapture(repo);

      const entry = entryFor(capture, "src/a.txt");
      expect(entry?.operation).toBe("deleted");
      expect(entry?.previous_path).toBeUndefined();
      expect(capture.entries.some((e) => e.path.startsWith(".viberevert"))).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Symlinks
// =============================================================================

describe("captureContribution: symlinks", () => {
  it("stores symlink target payloads even though symlinks never enter a mirror", async (ctx) => {
    // Regression: storage eligibility is not mirror eligibility. A symlink's
    // `target_ref` is useless if its bytes were never handed to the sink.
    const repo = await setupRepo();
    try {
      // Two independent guards. Git must be configured to check symlinks out
      // AS symlinks, or the oracle worktree observes a regular file containing
      // the target path and BEFORE is not a symlink at all. Separately, this
      // host must be able to create one.
      if (!(await gitCheckoutSymlinksEnabled(repo.repoRoot))) {
        ctx.skip();
        return;
      }
      await write(repo, "target-a.txt", "A\n");
      await write(repo, "target-b.txt", "B\n");
      try {
        await symlink("target-a.txt", join(repo.repoRoot, "link"), "file");
      } catch {
        // Symlink creation needs privileges this host may not grant.
        ctx.skip();
        return;
      }
      await git(repo.repoRoot, ["add", "-A"]);
      await git(repo.repoRoot, ["commit", "-m", "add link"]);
      await checkpoint(repo);

      await rm(join(repo.repoRoot, "link"));
      await symlink("target-b.txt", join(repo.repoRoot, "link"), "file");
      await git(repo.repoRoot, ["add", "-A"]);

      const { capture, storedDigests } = await runCapture(repo);
      const entry = entryFor(capture, "link");
      expect(entry?.before.worktree.kind).toBe("symlink");
      expect(entry?.after.worktree.kind).toBe("symlink");
      expect(entry?.facets).toContain("content_changed");
      // A symlink is not an eligible content-delta transition.
      expect(entry?.content_delta.kind).toBe("none");

      if (entry?.before.worktree.kind === "symlink") {
        expect(storedDigests.has(entry.before.worktree.target_ref)).toBe(true);
      }
      if (entry?.after.worktree.kind === "symlink") {
        expect(storedDigests.has(entry.after.worktree.target_ref)).toBe(true);
      }
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Committed changes
// =============================================================================

describe("captureContribution: mid-session commits", () => {
  it("captures a change that was committed during the session", async () => {
    // Clean in `git status`, so only the before_head..after_head tree diff can
    // surface it.
    const repo = await setupRepo();
    try {
      await write(repo, "src/a.txt", "alpha\n");
      await git(repo.repoRoot, ["add", "src/a.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "add a"]);
      await checkpoint(repo);

      await write(repo, "src/a.txt", "alpha\nbeta\n");
      await git(repo.repoRoot, ["add", "src/a.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "mid-session"]);

      const { capture } = await runCapture(repo);
      const entry = entryFor(capture, "src/a.txt");
      expect(entry?.operation).toBe("modified");
      expect(entry?.content_delta.kind).toBe("text");
      expect(capture.beforeHeadSha).not.toBe(capture.afterHeadSha);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// The observation set
// =============================================================================

describe("captureContribution: additional observation paths", () => {
  it("observes an unchanged extra path without making it an entry", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "composer.json", "{}\n");
      await git(repo.repoRoot, ["add", "composer.json"]);
      await git(repo.repoRoot, ["commit", "-m", "add composer"]);
      await checkpoint(repo);

      await write(repo, "unrelated.txt", "x\n");
      const { capture } = await runCapture(repo, {
        additionalObservationPaths: ["composer.json", "artisan"],
      });

      // Present in the observation set, both the existing and the absent one.
      expect(capture.endWorktreeStates.get("composer.json")?.kind).toBe("regular");
      expect(capture.endWorktreeStates.get("artisan")?.kind).toBe("absent");
      // But neither is a contribution entry, because neither changed.
      expect(entryFor(capture, "composer.json")).toBeUndefined();
      expect(entryFor(capture, "artisan")).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it("still emits an entry for an extra path that independently changed", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "composer.json", "{}\n");
      await git(repo.repoRoot, ["add", "composer.json"]);
      await git(repo.repoRoot, ["commit", "-m", "add composer"]);
      await checkpoint(repo);

      await write(repo, "composer.json", '{"name":"x"}\n');
      const { capture } = await runCapture(repo, {
        additionalObservationPaths: ["composer.json"],
      });

      expect(entryFor(capture, "composer.json")?.operation).toBe("modified");
      expect(capture.endWorktreeStates.get("composer.json")?.kind).toBe("regular");
    } finally {
      await repo.cleanup();
    }
  });

  it("refuses an observation path naming the store", async () => {
    const repo = await setupRepo();
    try {
      await checkpoint(repo);
      await expect(
        runCapture(repo, { additionalObservationPaths: [".viberevert/objects"] }),
      ).rejects.toThrow("must not name the VibeRevert store");
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Exclusions
// =============================================================================

describe("captureContribution: exclusions", () => {
  it("excludes store paths without failing, even when they are not gitignored", async () => {
    // Removing the ignore line is the scenario the independent store filter
    // exists for: end must keep working, and the store must stay out.
    const repo = await setupRepo();
    try {
      await checkpoint(repo);
      await write(repo, ".gitignore", "\n");
      await write(repo, ".viberevert/junk.txt", "internal\n");

      const { capture } = await runCapture(repo);
      expect(capture.entries.some((e) => e.path.startsWith(".viberevert"))).toBe(false);
      // The .gitignore edit itself is an ordinary change and IS captured.
      expect(entryFor(capture, ".gitignore")?.operation).toBe("modified");
    } finally {
      await repo.cleanup();
    }
  });

  it("applies the checkpoint's exclude patterns to the untracked surface only", async () => {
    // The patterns come from the manifest the oracle loaded, so the fixture
    // sets them at checkpoint time rather than at capture time.
    const repo = await setupRepo();
    try {
      await write(repo, "tracked.log", "kept\n");
      await git(repo.repoRoot, ["add", "tracked.log"]);
      await git(repo.repoRoot, ["commit", "-m", "add tracked log"]);
      await checkpoint(repo, { rollbackExcludePatterns: ["*.log"] });

      await write(repo, "tracked.log", "changed\n");
      await write(repo, "untracked.log", "dropped\n");

      const { capture } = await runCapture(repo);

      // The tracked path matches the pattern and is captured anyway; that
      // asymmetry is the shipped restore contract.
      expect(entryFor(capture, "tracked.log")?.operation).toBe("modified");
      expect(entryFor(capture, "untracked.log")).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Evidence chain
// =============================================================================

describe("captureContribution: object storage", () => {
  it("stores every payload the entries reference, on both sides", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "keep.txt", "before\n");
      await write(repo, "drop.txt", "gone\n");
      await git(repo.repoRoot, ["add", "keep.txt", "drop.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "seed"]);
      await checkpoint(repo);

      await write(repo, "keep.txt", "after\n");
      await git(repo.repoRoot, ["rm", "drop.txt"]);
      await write(repo, "added.txt", "new\n");

      const { capture, storedDigests } = await runCapture(repo);
      expect(capture.entries.length).toBeGreaterThan(0);

      // Every ref on either side must resolve, or the contribution would
      // describe content the store cannot produce.
      for (const entry of capture.entries) {
        for (const state of [entry.before.worktree, entry.after.worktree]) {
          if (state.kind === "regular") expect(storedDigests.has(state.content_ref)).toBe(true);
          if (state.kind === "symlink") expect(storedDigests.has(state.target_ref)).toBe(true);
        }
      }
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// The fence
// =============================================================================

describe("captureContribution: the end-state fence", () => {
  it("retries when the tree moves during Pass A and captures the stabilized state", async () => {
    // `storeObject` runs inside Pass A and never inside Pass B, so mutating
    // the tree from it is a deterministic way to make attempt 1's fence
    // disagree. The mutation fires once, so attempt 2 is stable.
    const repo = await setupRepo();
    try {
      await write(repo, "a.txt", "original\n");
      await git(repo.repoRoot, ["add", "a.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "seed"]);
      await checkpoint(repo);

      await write(repo, "a.txt", "first-edit\n");

      let mutated = false;
      const { capture, storedDigests } = await runCapture(repo, {
        onStore: async () => {
          if (mutated) return;
          mutated = true;
          await writeFile(join(repo.repoRoot, "a.txt"), "mutated\n");
        },
      });

      expect(mutated).toBe(true);

      // Attempt 1 stored the pre-mutation payload; attempt 2 stored the
      // post-mutation one. Both being present is what proves a second Pass A
      // ran rather than the fence being skipped.
      expect(storedDigests.has(sha256("first-edit\n"))).toBe(true);
      expect(storedDigests.has(sha256("mutated\n"))).toBe(true);
      expect(storedDigests.has(sha256("original\n"))).toBe(true);

      // The published capture reflects the stabilized tree, not what attempt 1
      // observed before the mutation.
      const entry = entryFor(capture, "a.txt");
      expect(entry?.operation).toBe("modified");
      if (entry?.after.worktree.kind === "regular") {
        expect(entry.after.worktree.content_ref).toBe(sha256("mutated\n"));
      }
    } finally {
      await repo.cleanup();
    }
  });

  it("a mutated observation-only path trips the fence and re-runs the capture", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "composer.json", "{}\n");
      await write(repo, "artisan", "#!/usr/bin/env php\n");
      await write(repo, "a.txt", "original\n");
      await git(repo.repoRoot, ["add", "-A"]);
      await git(repo.repoRoot, ["commit", "-m", "seed"]);
      await checkpoint(repo);

      // a.txt is the ONLY candidate on attempt 1. composer.json and artisan
      // are unchanged, so they are observation members and nothing else.
      await write(repo, "a.txt", "first-edit\n");

      const mutatedComposer = '{"name":"x"}\n';
      let mutated = false;
      const { capture, storedDigests } = await runCapture(repo, {
        additionalObservationPaths: ["composer.json", "artisan"],
        onStore: async () => {
          // Guarded, or every retry would mutate again and the capture would
          // never stabilize -- exhausting the attempts instead of proving one
          // discarded attempt.
          if (mutated) return;
          mutated = true;
          await writeFile(join(repo.repoRoot, "composer.json"), mutatedComposer);
        },
      });

      expect(mutated).toBe(true);

      // THE RETRY WITNESS. composer.json was unchanged on attempt 1, so it was
      // not a candidate and none of its content could have been stored. Its
      // mutated bytes can only be in the store if a SECOND Pass A ran -- which
      // happens only if the observation-only path participated in the fence.
      // Counting onStore calls would not prove this: the hook fires per stored
      // OBJECT, not per attempt.
      expect(storedDigests.has(sha256(mutatedComposer))).toBe(true);

      // The published capture reflects the STABILIZED tree, not what the
      // discarded attempt observed. Asserted as one object so the `kind` is
      // mandatory: a narrowing `if` would silently skip the payload check if
      // the kind ever became something other than "regular".
      const composer = entryFor(capture, "composer.json");
      expect(composer?.operation).toBe("modified");
      expect(composer?.after.worktree).toMatchObject({
        kind: "regular",
        content_ref: sha256(mutatedComposer),
      });

      // artisan participated in the fence and never changed, so observation
      // membership ALONE did not confer candidate status. This is the
      // widen-the-observation-set-not-the-candidate-set invariant.
      expect(entryFor(capture, "artisan")).toBeUndefined();
      expect(capture.endWorktreeStates.get("artisan")?.kind).toBe("regular");
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Binding and lifecycle
// =============================================================================

describe("captureContribution: binding and lifecycle", () => {
  it("refuses a checkpoint belonging to a different session", async () => {
    const repo = await setupRepo();
    try {
      await checkpoint(repo, { sessionId: "sess_01BX5ZZKBKACTAV9WEVGEMMVRZ" });
      await expect(runCapture(repo, { sessionId: SESSION_ID })).rejects.toBeInstanceOf(
        SessionCheckpointBindingError,
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("returns the publish result and an empty cleanup-warning list", async () => {
    const repo = await setupRepo();
    try {
      await checkpoint(repo);
      const marker = { ok: true };
      const result = await captureContribution<typeof marker>(repo.repoRoot, repo.checkpointDir, {
        sessionId: SESSION_ID,
        checkpointId: CHECKPOINT_ID,
        additionalObservationPaths: [],
        storeObject: async () => {},
        publish: async () => marker,
      });
      expect(result.value).toBe(marker);
      expect(result.cleanupWarnings).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("propagates a sink failure rather than publishing a partial contribution", async () => {
    const repo = await setupRepo();
    try {
      await checkpoint(repo);
      await write(repo, "a.txt", "x\n");
      let published = false;
      await expect(
        captureContribution<void>(repo.repoRoot, repo.checkpointDir, {
          sessionId: SESSION_ID,
          checkpointId: CHECKPOINT_ID,
          additionalObservationPaths: [],
          storeObject: async () => {
            throw new Error("store is full");
          },
          publish: async () => {
            published = true;
          },
        }),
      ).rejects.toThrow("store is full");
      expect(published).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// The deterministic builder
// =============================================================================

describe("buildContributionFile", () => {
  async function captureFor(): Promise<{
    capture: StableContributionCapture;
    done: () => Promise<void>;
  }> {
    const repo = await setupRepo();
    await checkpoint(repo);
    await write(repo, "a.txt", "alpha\n");
    const { capture } = await runCapture(repo);
    return { capture, done: repo.cleanup };
  }

  it("assembles a valid artifact from capture facts plus endedAt", async () => {
    const { capture, done } = await captureFor();
    try {
      const file = buildContributionFile(capture, { endedAt: "2026-08-25T12:00:00+00:00" });
      expect(file.session_id).toBe(SESSION_ID);
      expect(file.checkpoint_id).toBe(CHECKPOINT_ID);
      expect(file.captured_at).toBe(capture.capturedAt);
      expect(file.ended_at).toBe("2026-08-25T12:00:00+00:00");
      expect(file.detected_frameworks_at_end).toBeUndefined();
    } finally {
      await done();
    }
  });

  it("sorts detected frameworks and omits the field when not supplied", async () => {
    const { capture, done } = await captureFor();
    try {
      const withFrameworks = buildContributionFile(capture, {
        endedAt: "2026-08-25T12:00:00+00:00",
        detectedFrameworksAtEnd: ["nextjs", "laravel"],
      });
      expect(withFrameworks.detected_frameworks_at_end).toEqual(["laravel", "nextjs"]);

      const without = buildContributionFile(capture, { endedAt: "2026-08-25T12:00:00+00:00" });
      expect("detected_frameworks_at_end" in without).toBe(false);
    } finally {
      await done();
    }
  });

  it("is deterministic: the same capture and options build an equal artifact", async () => {
    // Capture reads no clock and evaluates no framework, so this must hold.
    const { capture, done } = await captureFor();
    try {
      const opts = { endedAt: "2026-08-25T12:00:00+00:00" } as const;
      expect(buildContributionFile(capture, opts)).toEqual(buildContributionFile(capture, opts));
    } finally {
      await done();
    }
  });

  it("refuses a capture whose session id is not a session ULID", async () => {
    const { capture, done } = await captureFor();
    try {
      const broken: StableContributionCapture = { ...capture, sessionId: "not-a-session" };
      expect(() => buildContributionFile(broken, { endedAt: "2026-08-25T12:00:00+00:00" })).toThrow(
        "assembled contribution is invalid",
      );
    } finally {
      await done();
    }
  });
});
