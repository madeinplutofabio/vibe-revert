// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `materializeCheckpointIntoFreshWorktree`, and the concurrency contracts it
// and `contribution.ts` depend on.
//
// =============================================================================
// What this file has to prove
// =============================================================================
//
// The fresh-worktree path exists ONLY as a performance change. It skips work
// its caller's preconditions make redundant, and it restores archived bytes for
// a subset of paths instead of all of them. So the load-bearing claim is an
// EQUIVALENCE claim: for every shape a checkpoint can capture, restoring
// through the fresh path lands in the same state as `restoreCheckpoint`.
//
// That claim is tested DIFFERENTIALLY rather than by asserting expected states
// per category. Hand-written expectations would encode my belief about what
// each shape restores to, and the whole risk here is that the optimized path
// and the shipped path disagree somewhere I did not think to look. Comparing
// the two against each other cannot miss a divergence just because I failed to
// predict it.
//
// The normalized state deliberately covers more than bytes: HEAD, the index
// (`ls-files -s`, so mode and blob id and stage), porcelain status, and a full
// filesystem walk including untracked files, the POSIX executable bit, and
// symlinks compared by KIND and TARGET rather than followed. A byte-only
// comparison would pass while index, mode, HEAD or link state diverged, and a
// comparison that followed symlinks would report a link and its target as the
// same thing.
//
// =============================================================================
// The repair set, and how it is observed without new exports
// =============================================================================
//
// "Only drifted paths are rewritten" has no return value to assert on, and
// exporting the internal drift computation to see it would widen a module
// surface for a test's convenience. Instead the tests stamp a known old mtime
// on every tracked file after `worktree add` and check which mtimes moved.
//
// WHAT THAT PROVES, EXACTLY: which paths were rewritten. A path that was
// rewritten has a new mtime; a path that was skipped keeps the stamp.
//
// WHAT IT DOES NOT PROVE: that git's stat cache survived. Stamping the mtimes
// itself invalidates that cache, so these tests cannot observe the property
// that produced the measured speedup. The stat-cache effect is a PERFORMANCE
// claim, evidenced by the benchmark and the phase profile in
// `docs/performance.md`, and it is deliberately not asserted here. What is
// asserted is the behavioral precondition for it: the rewrite does not happen.
//
// =============================================================================
// Why the concurrency contracts are tested here
// =============================================================================
//
// Both were preserved deliberately when the loops were parallelized, and both
// are invisible in normal runs: they only show up when something fails, or when
// a caller's sink is not reentrant. Untested, either could be dropped by a
// later refactor with every other test still green. The end-to-end proof that
// the real injected sink stays serialized lives in `contribution.test.ts`,
// where the sink is actually injected.

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
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createCheckpoint } from "../src/checkpoint.js";
import { mapWithConcurrency, serializeCalls } from "../src/concurrency.js";
import { CheckpointCorruptError, RestoreTrackedDirtyParityError } from "../src/errors.js";
import { getHeadSha } from "../src/git-cli.js";
import { materializeCheckpointIntoFreshWorktree, restoreCheckpoint } from "../src/restore.js";

const execFileAsync = promisify(execFile);

const POSIX_ONLY = process.platform !== "win32";

// Far enough in the past that no filesystem timestamp granularity can confuse
// it with "written during this test".
const STAMP = new Date("2020-01-01T00:00:00Z");

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, windowsHide: true });
  return String(stdout);
}

interface Fixture {
  readonly repoRoot: string;
  readonly parentDir: string;
  readonly cleanup: () => Promise<void>;
}

async function setupRepo(): Promise<Fixture> {
  const parentDir = await mkdtemp(join(tmpdir(), "viberevert-fresh-oracle-"));
  const repoRoot = join(parentDir, "repo");
  await mkdir(repoRoot, { recursive: true });

  await git(repoRoot, ["init", "-q", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  // Pinned for the reason restore-matrix.test.ts pins it: these cases assert
  // bytes, and a smudge filter would move them out from under the captured
  // hashes. The CRLF case carries CRLF bytes explicitly rather than asking git
  // to produce them.
  await git(repoRoot, ["config", "core.autocrlf", "false"]);

  await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
  await git(repoRoot, ["add", ".gitignore"]);
  await git(repoRoot, ["commit", "-q", "-m", "initial"]);

  return { repoRoot, parentDir, cleanup: () => rm(parentDir, { recursive: true, force: true }) };
}

async function write(root: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

async function takeCheckpoint(fx: Fixture): Promise<string> {
  const checkpointDir = await mkdtemp(join(fx.parentDir, "checkpoint-"));
  await createCheckpoint({ repoRoot: fx.repoRoot, checkpointDir, rollbackExcludePatterns: [] });
  return checkpointDir;
}

/**
 * Add a detached linked worktree at `headSha`, OUTSIDE the repository, so it
 * cannot appear in the repository's own status output.
 */
async function addFreshWorktree(fx: Fixture, headSha: string, name: string): Promise<string> {
  const worktreePath = join(fx.parentDir, name);
  await git(fx.repoRoot, ["worktree", "add", "--detach", worktreePath, headSha]);
  return worktreePath;
}

/**
 * Every file under `root`, excluding git's own metadata.
 *
 * `readdir` reports a symlink as neither a file nor a directory it should
 * descend into, so a link to a directory is recorded as one entry and never
 * traversed.
 */
async function walkFiles(root: string, dir = root, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // `.git` is a directory in a normal repo and a FILE in a linked worktree.
    // Skipping it by name covers both.
    if (entry.name === ".git") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(root, abs, out);
    else out.push(relative(root, abs).split(sep).join("/"));
  }
  return out;
}

/**
 * A canonical description of one working tree: HEAD, files with content digests
 * and executable bits, symlinks by target, the index, and porcelain status.
 *
 * Everything here is comparable BETWEEN a repository and a linked worktree of
 * that repository, which is what makes the differential assertion possible.
 *
 * `lstat` rather than `stat`: a symlink must be compared as a symlink. Following
 * it would digest the target's bytes and report a link and a regular file with
 * the same content as identical, which is exactly the divergence a symlink case
 * exists to catch.
 */
async function normalizedState(root: string): Promise<string> {
  const files = (await walkFiles(root)).sort();
  const lines: string[] = [];
  for (const rel of files) {
    const abs = join(root, ...rel.split("/"));
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      const target = (await readlink(abs)).split(sep).join("/");
      lines.push(`symlink ${rel} -> ${target}`);
      continue;
    }
    const digest = createHash("sha256")
      .update(await readFile(abs))
      .digest("hex");
    // The executable bit is a real boolean on POSIX and unreportable on
    // Windows, so it is recorded only where it means something.
    const mode = POSIX_ONLY ? ((st.mode & 0o111) !== 0 ? "x" : "-") : "?";
    lines.push(`file ${rel} ${digest} ${mode}`);
  }
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  const index = (await git(root, ["ls-files", "-s"])).trim().split("\n").sort().join("\n");
  const status = (await git(root, ["status", "--porcelain=v1"]))
    .trim()
    .split("\n")
    .sort()
    .join("\n");
  return [
    `head ${head}`,
    lines.join("\n"),
    "--- index ---",
    index,
    "--- status ---",
    status,
    "",
  ].join("\n");
}

/** Stamp every tracked file in `root` with a known past mtime. */
async function stampTrackedFiles(root: string): Promise<string[]> {
  const tracked = (await git(root, ["ls-files"])).trim().split("\n").filter(Boolean);
  for (const rel of tracked) await utimes(join(root, ...rel.split("/")), STAMP, STAMP);
  return tracked;
}

/** Which of `paths` no longer carry the stamped mtime. */
async function movedSince(root: string, paths: readonly string[]): Promise<string[]> {
  const moved: string[] = [];
  for (const rel of paths) {
    const st = await stat(join(root, ...rel.split("/")));
    if (Math.abs(st.mtime.getTime() - STAMP.getTime()) > 1000) moved.push(rel);
  }
  return moved.sort();
}

/**
 * Whether this host can create a symlink AND git will check one out as a
 * symlink here. Both are required, and they are separate questions: a host can
 * support links while git-for-Windows still has `core.symlinks=false`.
 */
async function symlinksUsable(repoRoot: string, parentDir: string): Promise<boolean> {
  if (!POSIX_ONLY) return false;
  try {
    const probe = join(parentDir, "symlink-probe");
    await symlink("target", probe);
    await rm(probe, { force: true });
  } catch {
    return false;
  }
  const configured = await git(repoRoot, ["config", "--get", "--bool", "core.symlinks"]).catch(
    () => "true",
  );
  return configured.trim() !== "false";
}

// =============================================================================
// 1. Differential equivalence, fresh path against the shipped path
// =============================================================================
//
// One case per shape rather than a loop over a table, so a failure names the
// shape that diverged instead of an index.

interface Shape {
  readonly name: string;
  /** Pre-session state, captured by the checkpoint. */
  readonly seed: (repoRoot: string) => Promise<void>;
  /** Session work, which both restore paths must undo. */
  readonly mutate: (repoRoot: string) => Promise<void>;
  readonly posixOnly?: boolean;
  readonly needsSymlinks?: boolean;
}

const SHAPES: readonly Shape[] = [
  {
    name: "clean tracked content",
    seed: async (r) => {
      await write(r, "src/a.ts", "export const a = 1;\n");
      await git(r, ["add", "-A"]);
      await git(r, ["commit", "-q", "-m", "seed"]);
    },
    mutate: async (r) => write(r, "src/a.ts", "export const a = 999;\n"),
  },
  {
    name: "staged change",
    seed: async (r) => {
      await write(r, "src/b.ts", "export const b = 1;\n");
      await git(r, ["add", "-A"]);
      await git(r, ["commit", "-q", "-m", "seed"]);
      await write(r, "src/b.ts", "export const b = 2;\n");
      await git(r, ["add", "src/b.ts"]);
    },
    mutate: async (r) => {
      await write(r, "src/b.ts", "export const b = 3;\n");
      await git(r, ["add", "src/b.ts"]);
    },
  },
  {
    name: "unstaged change layered over a staged one",
    seed: async (r) => {
      await write(r, "src/c.ts", "one\n");
      await git(r, ["add", "-A"]);
      await git(r, ["commit", "-q", "-m", "seed"]);
      await write(r, "src/c.ts", "two\n");
      await git(r, ["add", "src/c.ts"]);
      await write(r, "src/c.ts", "three\n");
    },
    mutate: async (r) => write(r, "src/c.ts", "four\n"),
  },
  {
    name: "unstaged deletion",
    seed: async (r) => {
      await write(r, "src/d.ts", "gone soon\n");
      await git(r, ["add", "-A"]);
      await git(r, ["commit", "-q", "-m", "seed"]);
      await rm(join(r, "src", "d.ts"));
    },
    mutate: async (r) => write(r, "src/d.ts", "resurrected during the session\n"),
  },
  {
    name: "untracked files including a nested one",
    seed: async (r) => {
      await write(r, "src/e.ts", "tracked\n");
      await git(r, ["add", "-A"]);
      await git(r, ["commit", "-q", "-m", "seed"]);
      await write(r, "scratch/notes.txt", "untracked note\n");
      await write(r, "scratch/deep/nested.txt", "nested untracked\n");
    },
    mutate: async (r) => {
      await write(r, "scratch/notes.txt", "session edited this\n");
      await write(r, "scratch/extra.txt", "created during the session\n");
    },
  },
  {
    name: "executable bit",
    posixOnly: true,
    seed: async (r) => {
      await write(r, "bin/run.sh", "#!/bin/sh\necho hi\n");
      await git(r, ["add", "-A"]);
      await git(r, ["update-index", "--chmod=+x", "bin/run.sh"]);
      await git(r, ["commit", "-q", "-m", "seed"]);
    },
    mutate: async (r) => write(r, "bin/run.sh", "#!/bin/sh\necho changed\n"),
  },
  {
    name: "CRLF bytes in a tracked file",
    seed: async (r) => {
      await write(r, "src/crlf.txt", "line one\r\nline two\r\n");
      await git(r, ["add", "-A"]);
      await git(r, ["commit", "-q", "-m", "seed"]);
      await write(r, "src/crlf.txt", "line one\r\nline two\r\nline three\r\n");
    },
    mutate: async (r) => write(r, "src/crlf.txt", "totally different\n"),
  },
  {
    name: "topology: nested directories and a deep staged add",
    seed: async (r) => {
      await write(r, "a/b/c/deep.ts", "deep\n");
      await write(r, "a/b/sibling.ts", "sibling\n");
      await git(r, ["add", "-A"]);
      await git(r, ["commit", "-q", "-m", "seed"]);
      await write(r, "a/b/c/added.ts", "added pre-session\n");
      await git(r, ["add", "a/b/c/added.ts"]);
    },
    mutate: async (r) => {
      await rm(join(r, "a", "b", "c", "deep.ts"));
      await write(r, "a/b/c/added.ts", "session rewrote this\n");
    },
  },
  {
    name: "tracked symlink retargeted before the session",
    posixOnly: true,
    needsSymlinks: true,
    seed: async (r) => {
      await write(r, "src/one.ts", "one\n");
      await write(r, "src/two.ts", "two\n");
      await symlink("src/one.ts", join(r, "link.ts"));
      await git(r, ["add", "-A"]);
      await git(r, ["commit", "-q", "-m", "seed"]);
      // Retarget pre-session, so the captured state is a DIRTY symlink and the
      // unstaged patch carries the link change. Tracked symlinks are restored
      // through patch replay, never through the tracked archive, which only
      // holds regular files.
      await rm(join(r, "link.ts"));
      await symlink("src/two.ts", join(r, "link.ts"));
    },
    mutate: async (r) => {
      await rm(join(r, "link.ts"));
      await symlink("src/one.ts", join(r, "link.ts"));
    },
  },
];

describe("fresh-worktree materialization equals restoreCheckpoint", () => {
  for (const shape of SHAPES) {
    it(shape.name, async (ctx) => {
      if (shape.posixOnly === true && !POSIX_ONLY) {
        ctx.skip();
        return;
      }
      const fx = await setupRepo();
      try {
        if (shape.needsSymlinks === true && !(await symlinksUsable(fx.repoRoot, fx.parentDir))) {
          ctx.skip();
          return;
        }

        await shape.seed(fx.repoRoot);
        const headSha = await getHeadSha(fx.repoRoot);
        const checkpointDir = await takeCheckpoint(fx);

        await shape.mutate(fx.repoRoot);

        // Path A: the shipped whole-tree restore, into the repository itself.
        await restoreCheckpoint(checkpointDir, {
          repoRoot: fx.repoRoot,
          rollbackExcludePatterns: [],
        });
        const shipped = await normalizedState(fx.repoRoot);

        // Path B: the oracle's restore, into a worktree created exactly the way
        // `withCheckpointOracle` creates one.
        const worktree = await addFreshWorktree(fx, headSha, "wt");
        await materializeCheckpointIntoFreshWorktree(checkpointDir, {
          repoRoot: worktree,
          rollbackExcludePatterns: [],
        });

        expect(await normalizedState(worktree)).toBe(shipped);
      } finally {
        await fx.cleanup();
      }
    });
  }
});

// =============================================================================
// 2. The repair set
// =============================================================================

describe("fresh-worktree materialization: the repair set", () => {
  it("rewrites nothing when checkout already reproduces the captured bytes", async () => {
    const fx = await setupRepo();
    try {
      await write(fx.repoRoot, "src/a.ts", "alpha\n");
      await write(fx.repoRoot, "src/b.ts", "beta\n");
      await write(fx.repoRoot, "src/c.ts", "gamma\n");
      await git(fx.repoRoot, ["add", "-A"]);
      await git(fx.repoRoot, ["commit", "-q", "-m", "seed"]);
      // One dirty path, so the checkpoint carries a tracked archive at all.
      await write(fx.repoRoot, "src/a.ts", "alpha dirty\n");

      const headSha = await getHeadSha(fx.repoRoot);
      const checkpointDir = await takeCheckpoint(fx);

      const worktree = await addFreshWorktree(fx, headSha, "wt");
      const tracked = await stampTrackedFiles(worktree);
      expect(tracked.length).toBeGreaterThan(0);

      await materializeCheckpointIntoFreshWorktree(checkpointDir, {
        repoRoot: worktree,
        rollbackExcludePatterns: [],
      });

      // `src/a.ts` moves because PATCH REPLAY writes it, not because the byte
      // restore did. Every other tracked path was already correct after
      // checkout, so an unconditional rewrite would show up here as extra
      // entries. This is the assertion the optimization rests on.
      expect(await movedSince(worktree, tracked)).toEqual(["src/a.ts"]);
    } finally {
      await fx.cleanup();
    }
  });

  it("repairs a raw-byte mismatch and leaves matching paths alone", async () => {
    const fx = await setupRepo();
    try {
      await write(fx.repoRoot, "src/a.ts", "alpha\n");
      await write(fx.repoRoot, "src/b.ts", "beta\n");
      await git(fx.repoRoot, ["add", "-A"]);
      await git(fx.repoRoot, ["commit", "-q", "-m", "seed"]);
      await write(fx.repoRoot, "src/a.ts", "alpha dirty\n");

      const headSha = await getHeadSha(fx.repoRoot);
      const checkpointDir = await takeCheckpoint(fx);
      const capturedB = await readFile(join(fx.repoRoot, "src", "b.ts"));

      const worktree = await addFreshWorktree(fx, headSha, "wt");
      // Corrupt a path git considers clean. This is the shape the
      // unconditional rewrite existed for: bytes a checkout produced that do
      // not match what was captured.
      await write(worktree, "src/b.ts", "CORRUPTED BY A FILTER\n");
      const tracked = await stampTrackedFiles(worktree);

      await materializeCheckpointIntoFreshWorktree(checkpointDir, {
        repoRoot: worktree,
        rollbackExcludePatterns: [],
      });

      expect(await readFile(join(worktree, "src", "b.ts"))).toEqual(capturedB);
      // The repair was targeted: only the patched path and the drifted path.
      expect(await movedSince(worktree, tracked)).toEqual(["src/a.ts", "src/b.ts"]);
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// 3. Evidence failures still refuse, and still refuse BEFORE mutating
// =============================================================================
//
// These tamper with a checkpoint on disk. That is the point: the fail-closed
// behavior at an evidence boundary cannot be reached with a well-formed
// checkpoint, and refusing to test it would leave the boundary unproven.

describe("fresh-worktree materialization: evidence failures", () => {
  it("refuses a corrupt tracked archive during preflight, before mutating", async () => {
    const fx = await setupRepo();
    try {
      await write(fx.repoRoot, "src/a.ts", "alpha\n");
      await git(fx.repoRoot, ["add", "-A"]);
      await git(fx.repoRoot, ["commit", "-q", "-m", "seed"]);
      await write(fx.repoRoot, "src/a.ts", "alpha dirty\n");

      const headSha = await getHeadSha(fx.repoRoot);
      const checkpointDir = await takeCheckpoint(fx);
      await writeFile(
        join(checkpointDir, "rollback", "tracked-dirty.tar.gz"),
        Buffer.from("not a gzip stream"),
      );

      const worktree = await addFreshWorktree(fx, headSha, "wt");
      const before = await normalizedState(worktree);

      await expect(
        materializeCheckpointIntoFreshWorktree(checkpointDir, {
          repoRoot: worktree,
          rollbackExcludePatterns: [],
        }),
      ).rejects.toBeInstanceOf(CheckpointCorruptError);

      // The refusal is not merely reported: nothing changed on the way to it.
      expect(await normalizedState(worktree)).toBe(before);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses when a manifest-declared path is missing from the archive", async () => {
    const fx = await setupRepo();
    try {
      await write(fx.repoRoot, "src/a.ts", "alpha\n");
      await git(fx.repoRoot, ["add", "-A"]);
      await git(fx.repoRoot, ["commit", "-q", "-m", "seed"]);
      await write(fx.repoRoot, "src/a.ts", "alpha dirty\n");

      const headSha = await getHeadSha(fx.repoRoot);
      const checkpointDir = await takeCheckpoint(fx);

      // Declare a path the archive does not contain. Entry-set parity is
      // checked against `file_hashes` keys in preflight, so this is rejected
      // before mutation whether or not the later extraction is filtered. This
      // is the test standing behind the comment correction in restore.ts.
      const manifestPath = join(checkpointDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        snapshots: { file_hashes: Record<string, string> };
      };
      manifest.snapshots.file_hashes["src/never-archived.ts"] = "0".repeat(64);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const worktree = await addFreshWorktree(fx, headSha, "wt");
      const before = await normalizedState(worktree);

      await expect(
        materializeCheckpointIntoFreshWorktree(checkpointDir, {
          repoRoot: worktree,
          rollbackExcludePatterns: [],
        }),
      ).rejects.toBeInstanceOf(CheckpointCorruptError);
      expect(await normalizedState(worktree)).toBe(before);
    } finally {
      await fx.cleanup();
    }
  });

  it("parity still catches a reconstructed dirty set that does not match the manifest", async () => {
    const fx = await setupRepo();
    try {
      await write(fx.repoRoot, "src/a.ts", "alpha\n");
      await write(fx.repoRoot, "src/clean.ts", "never dirty\n");
      await git(fx.repoRoot, ["add", "-A"]);
      await git(fx.repoRoot, ["commit", "-q", "-m", "seed"]);
      await write(fx.repoRoot, "src/a.ts", "alpha dirty\n");

      const headSha = await getHeadSha(fx.repoRoot);
      const checkpointDir = await takeCheckpoint(fx);

      // Claim a path was dirty at capture when it was not. Nothing in the
      // restore can make it dirty, so the reconstructed set must diverge and
      // parity must say so. `tracked_dirty_paths` is NOT part of archive
      // entry-set parity, so this reaches parity rather than preflight.
      const manifestPath = join(checkpointDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        snapshots: { tracked_dirty_paths: string[] };
      };
      manifest.snapshots.tracked_dirty_paths = [
        ...manifest.snapshots.tracked_dirty_paths,
        "src/clean.ts",
      ].sort();
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const worktree = await addFreshWorktree(fx, headSha, "wt");

      await expect(
        materializeCheckpointIntoFreshWorktree(checkpointDir, {
          repoRoot: worktree,
          rollbackExcludePatterns: [],
        }),
      ).rejects.toBeInstanceOf(RestoreTrackedDirtyParityError);
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// 4. Concurrency contracts
// =============================================================================

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency: failure is deterministic by input index", () => {
  it("throws the LOWEST input index even when a later failure settles first", async () => {
    // Index 3 rejects immediately; index 1 rejects later. `Promise.all` would
    // surface index 3, which is the non-determinism this helper removes.
    await expect(
      mapWithConcurrency(
        [0, 1, 2, 3, 4, 5, 6, 7],
        async (_item, index) => {
          if (index === 3) throw new Error("failure at 3");
          if (index === 1) {
            await delay(30);
            throw new Error("failure at 1");
          }
          await delay(60);
          return index;
        },
        8,
      ),
    ).rejects.toThrow("failure at 1");
  });

  it("starts no new work once a failure has been recorded", async () => {
    const started: number[] = [];

    await expect(
      mapWithConcurrency(
        Array.from({ length: 40 }, (_v, i) => i),
        async (_item, index) => {
          started.push(index);
          if (index === 0) throw new Error("immediate");
          await delay(5);
          return index;
        },
        2,
      ),
    ).rejects.toThrow("immediate");

    // Two workers, so 0 and 1 are dispatched before anything settles. Index 0
    // fails, and neither worker may pull another item after that, so the tail
    // of the list is never touched.
    expect(started.sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("still returns results in input order on the success path", async () => {
    // Reverse-ordered delays, so completion order is the opposite of input
    // order and an implementation collecting results as they settle would fail.
    const out = await mapWithConcurrency(
      [0, 1, 2, 3, 4, 5],
      async (item, index) => {
        await delay((6 - index) * 5);
        return item * 10;
      },
      6,
    );
    expect(out).toEqual([0, 10, 20, 30, 40, 50]);
  });
});

describe("serializeCalls: an injected sink is never entered concurrently", () => {
  it("holds concurrency at one under heavy parallel pressure", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: number[] = [];

    const sink = serializeCalls(async (n: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(2);
      seen.push(n);
      inFlight -= 1;
    });

    // Driven THROUGH the concurrent mapper, which is how the real sink is
    // reached: `contribution.ts` parallelizes observation and hashing, and the
    // sink must still see one call at a time.
    await mapWithConcurrency(
      Array.from({ length: 40 }, (_v, i) => i),
      async (n) => sink(n),
      16,
    );

    expect(maxInFlight).toBe(1);
    expect(seen).toHaveLength(40);
  });

  it("does not poison the queue when one call rejects", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const sink = serializeCalls(async (n: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(1);
      inFlight -= 1;
      if (n === 2) throw new Error("sink refused 2");
      return n;
    });

    const settled = await Promise.allSettled([0, 1, 2, 3, 4].map((n) => sink(n)));

    expect(settled.map((s) => s.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(maxInFlight).toBe(1);
  });
});
