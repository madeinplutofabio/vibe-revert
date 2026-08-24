// packages/git/test/path-state.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M 0.8.0 step 3 -- two-axis path observation.
//
// Three kinds of test here, deliberately separated:
//
//   1. Index states built with REAL git, including the ones that are awkward to
//      produce: gitlinks, tracked symlinks, unmerged stages, and an index that
//      disagrees with the worktree about executability.
//   2. Worktree observation against a plain directory. `observePathState` never
//      runs git, so these need no repository at all, which is itself worth
//      asserting.
//   3. Parser refusals through the `_*ForTests` seams. Real git cannot emit a
//      malformed stage record, a stage outside 0-3, a path carrying both a
//      resolved entry and conflict stages, or an invalid mode, so the only way
//      to cover those fail-closed branches is to call the parser directly.
//
// Capability-gated tests call `ctx.skip()` rather than returning early. That
// distinction matters here: a test that returns is counted as PASSED, so on a
// host without symlink privileges the ancestor-symlink security case would
// report green while asserting nothing. Skipping makes the missing coverage
// visible in the reporter instead.
//
// Git OIDs are matched against a 40-or-64 hex pattern rather than SHA-1 alone,
// because the schema supports both and these fixtures should not become
// dependent on the host's default object format.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  type IndexSnapshot,
  observePathState,
  PathObservationError,
  _parseStageRecordForTests as parseStageRecord,
  readIndexSnapshot,
  _toIndexStateForTests as toIndexState,
} from "../src/path-state.js";

// =============================================================================
// Helpers
// =============================================================================

const execFileAsync = promisify(execFile);

/** SHA-256 of the empty input. Standard published vector. */
const EMPTY_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A Git object id: SHA-1 or SHA-256, matching the schema's own atom. */
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** VibeRevert content refs are always SHA-256. */
const HEX64 = /^[0-9a-f]{64}$/;

/** An index with no entries, for worktree-only observation. */
const EMPTY_INDEX: IndexSnapshot = { byPath: new Map() };

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, windowsHide: true });
  return stdout;
}

/** For commands that legitimately exit non-zero, such as a conflicting merge. */
async function gitAllowFail(cwd: string, args: readonly string[]): Promise<void> {
  try {
    await execFileAsync("git", args as string[], { cwd, windowsHide: true });
  } catch {
    // The caller expects a non-zero exit; the resulting state is what matters.
  }
}

interface Scratch {
  readonly root: string;
  readonly cleanup: () => Promise<void>;
}

/** A plain directory. No git. */
async function setupDir(): Promise<Scratch> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-pathstate-"));
  return {
    root: tmp,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/** A git repository with one commit. */
async function setupRepo(): Promise<Scratch> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-pathstate-repo-"));
  const root = join(tmp, "repo");
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await writeFile(join(root, "README.md"), "# test\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return {
    root,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/** Whether this host permits symlink creation. Probed once. */
let symlinkCapability: boolean | undefined;
async function symlinksWork(): Promise<boolean> {
  if (symlinkCapability !== undefined) return symlinkCapability;
  const dir = await mkdtemp(join(tmpdir(), "viberevert-symprobe-"));
  try {
    await writeFile(join(dir, "t"), "x");
    await symlink(join(dir, "t"), join(dir, "l"));
    symlinkCapability = true;
  } catch {
    symlinkCapability = false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return symlinkCapability;
}

// =============================================================================
// Index snapshot, against real git
// =============================================================================

describe("readIndexSnapshot", () => {
  it("reports a tracked file as a stage-0 entry", async () => {
    const s = await setupRepo();
    try {
      const index = await readIndexSnapshot(s.root);
      const entry = index.byPath.get("README.md");
      expect(entry).toBeDefined();
      expect(entry?.kind).toBe("entry");
      if (entry?.kind === "entry") {
        expect(entry.mode).toBe("100644");
        expect(entry.oid).toMatch(GIT_OID);
      }
    } finally {
      await s.cleanup();
    }
  });

  it("omits untracked paths entirely", async () => {
    const s = await setupRepo();
    try {
      await writeFile(join(s.root, "untracked.txt"), "x\n");
      const index = await readIndexSnapshot(s.root);
      expect(index.byPath.has("untracked.txt")).toBe(false);
    } finally {
      await s.cleanup();
    }
  });

  it("covers CLEAN tracked files, not only changed ones", async () => {
    // The reason `git status` cannot be the index source: a file Git considers
    // clean still has index state, and step 4's raw-byte candidate source needs
    // exactly those paths.
    const s = await setupRepo();
    try {
      const index = await readIndexSnapshot(s.root);
      expect(index.byPath.has("README.md")).toBe(true);
    } finally {
      await s.cleanup();
    }
  });

  it("reports a gitlink as mode 160000", async () => {
    const s = await setupRepo();
    try {
      const head = (await git(s.root, ["rev-parse", "HEAD"])).trim();
      await git(s.root, ["update-index", "--add", "--cacheinfo", `160000,${head},sub`]);

      const index = await readIndexSnapshot(s.root);
      const entry = index.byPath.get("sub");
      expect(entry?.kind).toBe("entry");
      if (entry?.kind === "entry") {
        expect(entry.mode).toBe("160000");
        expect(entry.oid).toBe(head);
      }
    } finally {
      await s.cleanup();
    }
  });

  it("reports a conflicted path as unmerged stages in ascending order", async () => {
    const s = await setupRepo();
    try {
      await writeFile(join(s.root, "c.txt"), "base\n");
      await git(s.root, ["add", "c.txt"]);
      await git(s.root, ["commit", "-m", "base"]);

      await git(s.root, ["checkout", "-b", "other"]);
      await writeFile(join(s.root, "c.txt"), "other\n");
      await git(s.root, ["add", "c.txt"]);
      await git(s.root, ["commit", "-m", "other"]);

      await git(s.root, ["checkout", "main"]);
      await writeFile(join(s.root, "c.txt"), "mainline\n");
      await git(s.root, ["add", "c.txt"]);
      await git(s.root, ["commit", "-m", "mainline"]);

      await gitAllowFail(s.root, ["merge", "other"]);

      const index = await readIndexSnapshot(s.root);
      const entry = index.byPath.get("c.txt");
      expect(entry?.kind).toBe("unmerged");
      if (entry?.kind === "unmerged") {
        expect(entry.entries.map((e) => e.stage)).toEqual([1, 2, 3]);
        for (const stage of entry.entries) {
          expect(stage.mode).toBe("100644");
          expect(stage.oid).toMatch(GIT_OID);
        }
      }
    } finally {
      await s.cleanup();
    }
  });
});

// =============================================================================
// The two axes really are independent
// =============================================================================

describe("two-axis independence", () => {
  it("records an index-only executable bit without touching the worktree axis", async () => {
    // `update-index --chmod=+x` changes the INDEX mode alone. If the worktree
    // axis were ever derived from the index, this is where it would show.
    const s = await setupRepo();
    try {
      await git(s.root, ["update-index", "--chmod=+x", "README.md"]);
      const index = await readIndexSnapshot(s.root);
      const observed = await observePathState(s.root, "README.md", index);

      expect(observed.state.index.kind).toBe("entry");
      if (observed.state.index.kind === "entry") {
        expect(observed.state.index.mode).toBe("100755");
      }
      expect(observed.state.worktree.kind).toBe("regular");
      if (observed.state.worktree.kind === "regular") {
        // Never `true` merely because the index says 100755.
        expect(observed.state.worktree.executable).toBe(
          process.platform === "win32" ? null : false,
        );
      }
    } finally {
      await s.cleanup();
    }
  });

  it("reports a tracked symlink as index mode 120000 and worktree symlink", async (ctx) => {
    if (!(await symlinksWork())) ctx.skip();

    const s = await setupRepo();
    try {
      await writeFile(join(s.root, "target.txt"), "target\n");
      // Relative target: keeps the Git fixture canonical and keeps Windows
      // absolute-path normalization out of this assertion.
      await symlink("target.txt", join(s.root, "link"));
      await git(s.root, ["add", "link"]);

      const index = await readIndexSnapshot(s.root);
      const observed = await observePathState(s.root, "link", index);

      expect(observed.state.index.kind).toBe("entry");
      if (observed.state.index.kind === "entry") {
        expect(observed.state.index.mode).toBe("120000");
        expect(observed.state.index.oid).toMatch(GIT_OID);
      }

      expect(observed.state.worktree.kind).toBe("symlink");
      expect(observed.worktreeObject).toBeDefined();
    } finally {
      await s.cleanup();
    }
  });

  it("represents an unstaged deletion as index entry plus absent worktree", async () => {
    const s = await setupRepo();
    try {
      const index = await readIndexSnapshot(s.root);
      await unlink(join(s.root, "README.md"));
      const observed = await observePathState(s.root, "README.md", index);

      expect(observed.state.index.kind).toBe("entry");
      expect(observed.state.worktree.kind).toBe("absent");
      expect(observed.worktreeObject).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  });

  it("represents a staged deletion with a worktree file present", async () => {
    // The state a single discriminant cannot express: gone from the index,
    // still on disk.
    const s = await setupRepo();
    try {
      await git(s.root, ["rm", "--cached", "README.md"]);
      const index = await readIndexSnapshot(s.root);
      const observed = await observePathState(s.root, "README.md", index);

      expect(observed.state.index.kind).toBe("absent");
      expect(observed.state.worktree.kind).toBe("regular");
    } finally {
      await s.cleanup();
    }
  });

  it("reports the worktree bytes, not the staged bytes, after staged-then-modified", async () => {
    const s = await setupRepo();
    try {
      const v2 = Buffer.from("second\n", "utf8");
      await writeFile(join(s.root, "f.txt"), "first\n");
      await git(s.root, ["add", "f.txt"]);
      const index = await readIndexSnapshot(s.root);
      await writeFile(join(s.root, "f.txt"), v2);

      const observed = await observePathState(s.root, "f.txt", index);
      expect(observed.state.index.kind).toBe("entry");
      if (observed.state.worktree.kind === "regular") {
        expect(observed.state.worktree.content_ref).toBe(sha256(v2));
      }
      expect(observed.worktreeObject?.data).toEqual(v2);
    } finally {
      await s.cleanup();
    }
  });

  it("pairs a gitlink index entry with whatever the worktree actually holds", async () => {
    const s = await setupRepo();
    try {
      const head = (await git(s.root, ["rev-parse", "HEAD"])).trim();
      await git(s.root, ["update-index", "--add", "--cacheinfo", `160000,${head},sub`]);
      const index = await readIndexSnapshot(s.root);

      const observed = await observePathState(s.root, "sub", index);
      expect(observed.state.index.kind).toBe("entry");
      // No submodule was checked out, so the worktree side is simply absent.
      expect(observed.state.worktree.kind).toBe("absent");
    } finally {
      await s.cleanup();
    }
  });
});

// =============================================================================
// Worktree observation (no git involved)
// =============================================================================

describe("worktree observation", () => {
  it("needs no git repository at all", async () => {
    // observePathState never shells out. If that ever changes, this fails in a
    // bare temp directory.
    const s = await setupDir();
    try {
      await writeFile(join(s.root, "f.txt"), "x\n");
      const observed = await observePathState(s.root, "f.txt", EMPTY_INDEX);
      expect(observed.state.worktree.kind).toBe("regular");
      expect(observed.state.index.kind).toBe("absent");
    } finally {
      await s.cleanup();
    }
  });

  it("returns a content ref that describes the returned payload", async () => {
    const s = await setupDir();
    try {
      const bytes = Buffer.from("hello observation\n", "utf8");
      await writeFile(join(s.root, "f.txt"), bytes);
      const observed = await observePathState(s.root, "f.txt", EMPTY_INDEX);

      expect(observed.worktreeObject).toBeDefined();
      expect(observed.worktreeObject?.data).toEqual(bytes);
      if (observed.state.worktree.kind === "regular") {
        expect(observed.state.worktree.content_ref).toMatch(HEX64);
        // The ref and the payload are the SAME observation, which is the whole
        // reason the bytes are returned rather than reread in step 4.
        expect(observed.state.worktree.content_ref).toBe(
          sha256(observed.worktreeObject?.data as Buffer),
        );
      }
    } finally {
      await s.cleanup();
    }
  });

  it("handles empty content, matching the published SHA-256 vector", async () => {
    const s = await setupDir();
    try {
      await writeFile(join(s.root, "empty.txt"), Buffer.alloc(0));
      const observed = await observePathState(s.root, "empty.txt", EMPTY_INDEX);
      if (observed.state.worktree.kind === "regular") {
        expect(observed.state.worktree.content_ref).toBe(EMPTY_DIGEST);
      }
      expect(observed.worktreeObject?.data.length).toBe(0);
    } finally {
      await s.cleanup();
    }
  });

  it("preserves CRLF bytes exactly", async () => {
    // The raw-byte case the capture format was broadened for: what is on disk,
    // not what a checkout would regenerate.
    const s = await setupDir();
    try {
      const crlf = Buffer.from("a\r\nb\r\n", "utf8");
      await writeFile(join(s.root, "crlf.txt"), crlf);
      const observed = await observePathState(s.root, "crlf.txt", EMPTY_INDEX);
      expect(observed.worktreeObject?.data).toEqual(crlf);
      if (observed.state.worktree.kind === "regular") {
        expect(observed.state.worktree.content_ref).toBe(sha256(crlf));
      }
    } finally {
      await s.cleanup();
    }
  });

  it("round-trips binary content containing NUL", async () => {
    const s = await setupDir();
    try {
      const binary = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80, 0x00, 0xfe]);
      await writeFile(join(s.root, "bin"), binary);
      const observed = await observePathState(s.root, "bin", EMPTY_INDEX);
      expect(observed.worktreeObject?.data).toEqual(binary);
    } finally {
      await s.cleanup();
    }
  });

  it("reports an absent path with no payload", async () => {
    const s = await setupDir();
    try {
      const observed = await observePathState(s.root, "nope.txt", EMPTY_INDEX);
      expect(observed.state.worktree.kind).toBe("absent");
      expect(observed.worktreeObject).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  });

  it("reports a directory, with no payload", async () => {
    const s = await setupDir();
    try {
      await mkdir(join(s.root, "d"));
      const observed = await observePathState(s.root, "d", EMPTY_INDEX);
      expect(observed.state.worktree.kind).toBe("directory");
      expect(observed.worktreeObject).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  });

  it("reports the executable bit per platform", async () => {
    const s = await setupDir();
    try {
      await writeFile(join(s.root, "plain.txt"), "x\n");
      if (process.platform !== "win32") await chmod(join(s.root, "plain.txt"), 0o644);
      const observed = await observePathState(s.root, "plain.txt", EMPTY_INDEX);
      if (observed.state.worktree.kind === "regular") {
        expect(observed.state.worktree.executable).toBe(
          process.platform === "win32" ? null : false,
        );
      }
    } finally {
      await s.cleanup();
    }
  });

  it("observes an executable file as executable on POSIX", async (ctx) => {
    if (process.platform === "win32") ctx.skip();

    const s = await setupDir();
    try {
      await writeFile(join(s.root, "run.sh"), "#!/bin/sh\n");
      await chmod(join(s.root, "run.sh"), 0o755);
      const observed = await observePathState(s.root, "run.sh", EMPTY_INDEX);
      if (observed.state.worktree.kind === "regular") {
        expect(observed.state.worktree.executable).toBe(true);
      }
    } finally {
      await s.cleanup();
    }
  });

  it("hashes a symlink's raw target bytes", async (ctx) => {
    if (!(await symlinksWork())) ctx.skip();

    const s = await setupDir();
    try {
      const target = join(s.root, "target.txt");
      await writeFile(target, "pointed-at\n");
      await symlink(target, join(s.root, "link"));

      const observed = await observePathState(s.root, "link", EMPTY_INDEX);
      expect(observed.state.worktree.kind).toBe("symlink");
      expect(observed.worktreeObject).toBeDefined();
      const data = observed.worktreeObject?.data as Buffer;
      expect(data.length).toBeGreaterThan(0);
      if (observed.state.worktree.kind === "symlink") {
        // Ref and payload are the same observation. The exact target text is
        // not asserted: Windows may rewrite separators, and this module's
        // contract is "the bytes readlink returned", not a normalized string.
        expect(observed.state.worktree.target_ref).toBe(sha256(data));
      }
      // The TARGET's content must not leak in: this is the link, not the file.
      expect(data.toString("utf8")).not.toContain("pointed-at");
    } finally {
      await s.cleanup();
    }
  });
});

// =============================================================================
// Ancestor protection
// =============================================================================

describe("ancestor traversal", () => {
  it("reports absent when an ancestor is a regular file", async () => {
    // Same code path as the symlink case, reachable without any privilege.
    const s = await setupDir();
    try {
      await writeFile(join(s.root, "a"), "not a directory\n");
      const observed = await observePathState(s.root, "a/b.txt", EMPTY_INDEX);
      expect(observed.state.worktree.kind).toBe("absent");
    } finally {
      await s.cleanup();
    }
  });

  it("reports absent when an ancestor does not exist", async () => {
    const s = await setupDir();
    try {
      const observed = await observePathState(s.root, "missing/b.txt", EMPTY_INDEX);
      expect(observed.state.worktree.kind).toBe("absent");
    } finally {
      await s.cleanup();
    }
  });

  it("observes normally through real nested directories", async () => {
    // The positive half. Without it, the two tests above would pass even if
    // every nested path were reported absent.
    const s = await setupDir();
    try {
      await mkdir(join(s.root, "a", "b"), { recursive: true });
      await writeFile(join(s.root, "a", "b", "c.txt"), "deep\n");
      const observed = await observePathState(s.root, "a/b/c.txt", EMPTY_INDEX);
      expect(observed.state.worktree.kind).toBe("regular");
    } finally {
      await s.cleanup();
    }
  });

  it("refuses to traverse a symlinked ancestor, even though the file exists", async (ctx) => {
    // The security case. An ancestor symlink is never traversed, regardless of
    // where it points -- which is why this fixture stays valid even though
    // `real` is inside the declared root. The rule is about not following, not
    // about where following would land.
    if (!(await symlinksWork())) ctx.skip();

    const s = await setupDir();
    try {
      await mkdir(join(s.root, "real"));
      await writeFile(join(s.root, "real", "f.txt"), "reachable\n");
      await symlink(join(s.root, "real"), join(s.root, "link"));

      // The file genuinely resolves through the link.
      const direct = await observePathState(s.root, "real/f.txt", EMPTY_INDEX);
      expect(direct.state.worktree.kind).toBe("regular");

      const throughLink = await observePathState(s.root, "link/f.txt", EMPTY_INDEX);
      expect(throughLink.state.worktree.kind).toBe("absent");
      expect(throughLink.worktreeObject).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  });
});

// =============================================================================
// Lexical path guard
// =============================================================================

describe("path guard", () => {
  it.each([
    ["empty", ""],
    ["parent escape", "../escape.txt"],
    ["absolute", "/etc/passwd"],
    ["Windows drive", "C:/escape.txt"],
    ["dot segment", "a/./b.txt"],
    ["empty segment", "a//b.txt"],
    ["viberevert root", ".viberevert"],
    ["viberevert child", ".viberevert/objects/x"],
    ["backslash", "a\\b.txt"],
  ])("rejects a %s path", async (_label, path) => {
    const s = await setupDir();
    try {
      await expect(observePathState(s.root, path, EMPTY_INDEX)).rejects.toBeInstanceOf(
        PathObservationError,
      );
    } finally {
      await s.cleanup();
    }
  });
});

// =============================================================================
// Parser refusals, through the test-only seams
// =============================================================================

describe("parseStageRecord", () => {
  const OID = "a".repeat(40);

  it("splits at the FIRST tab, preserving whitespace in the path", () => {
    const parsed = parseStageRecord(`100644 ${OID} 0\tdir/file with space.txt`, 0);
    expect(parsed.mode).toBe("100644");
    expect(parsed.oid).toBe(OID);
    expect(parsed.stage).toBe(0);
    expect(parsed.path).toBe("dir/file with space.txt");
  });

  it("keeps a tab inside the path", () => {
    expect(parseStageRecord(`100644 ${OID} 0\tdir/od\td.txt`, 0).path).toBe("dir/od\td.txt");
  });

  it("rejects a record with no tab", () => {
    expect(() => parseStageRecord(`100644 ${OID} 0 nope.txt`, 3)).toThrow(/no tab separator/);
  });

  it("rejects metadata that is not three tokens", () => {
    expect(() => parseStageRecord(`100644 ${OID}\tf.txt`, 0)).toThrow(/not 3 tokens/);
    expect(() => parseStageRecord(`100644 ${OID} 0 extra\tf.txt`, 0)).toThrow(/not 3 tokens/);
  });

  it.each(["4", "9", "x", "-1", ""])("rejects stage %s", (stage) => {
    expect(() => parseStageRecord(`100644 ${OID} ${stage}\tf.txt`, 0)).toThrow(/expected 0-3/);
  });
});

describe("toIndexState", () => {
  const OID1 = "1".repeat(40);
  const OID2 = "2".repeat(40);
  const OID3 = "3".repeat(40);

  const rec = (stage: number, oid: string, mode = "100644") => ({
    mode,
    oid,
    stage,
    path: "f.txt",
  });

  it("builds a stage-0 entry", () => {
    expect(toIndexState("f.txt", [rec(0, OID1)])).toEqual({
      kind: "entry",
      mode: "100644",
      oid: OID1,
    });
  });

  it("accepts a 64-hex Git OID, for SHA-256 repositories", () => {
    const sha256Oid = "b".repeat(64);
    expect(toIndexState("f.txt", [rec(0, sha256Oid)])).toEqual({
      kind: "entry",
      mode: "100644",
      oid: sha256Oid,
    });
  });

  it("sorts conflict stages ascending regardless of input order", () => {
    // The schema REQUIRES canonical ordering, because contribution_sha256 is
    // computed over deterministic bytes. Emitting git's order would not merely
    // look untidy, it would fail validation.
    const state = toIndexState("f.txt", [rec(3, OID3), rec(1, OID1), rec(2, OID2)]);
    expect(state.kind).toBe("unmerged");
    if (state.kind === "unmerged") {
      expect(state.entries.map((e) => e.stage)).toEqual([1, 2, 3]);
      expect(state.entries.map((e) => e.oid)).toEqual([OID1, OID2, OID3]);
    }
  });

  it("accepts a two-stage conflict with no stage 1", () => {
    // An add/add conflict has no common ancestor, so stage 1 is absent.
    const state = toIndexState("f.txt", [rec(2, OID2), rec(3, OID3)]);
    expect(state.kind).toBe("unmerged");
    if (state.kind === "unmerged") {
      expect(state.entries.map((e) => e.stage)).toEqual([2, 3]);
    }
  });

  it("refuses a stage-0 entry mixed with conflict stages", () => {
    expect(() => toIndexState("f.txt", [rec(0, OID1), rec(2, OID2)])).toThrow(
      /both a stage-0 entry and conflict stages/,
    );
  });

  it("refuses two stage-0 entries", () => {
    expect(() => toIndexState("f.txt", [rec(0, OID1), rec(0, OID2)])).toThrow(/2 stage-0 entries/);
  });

  it("refuses duplicate conflict stages", () => {
    expect(() => toIndexState("f.txt", [rec(2, OID1), rec(2, OID2)])).toThrow(/duplicate stage 2/);
  });

  it("refuses a mode outside the schema's vocabulary", () => {
    expect(() => toIndexState("f.txt", [rec(0, OID1, "100664")])).toThrow(/not a valid IndexState/);
    expect(() => toIndexState("f.txt", [rec(0, OID1, "040000")])).toThrow(/not a valid IndexState/);
  });

  it("refuses an OID of the wrong width or alphabet", () => {
    expect(() => toIndexState("f.txt", [rec(0, "a".repeat(39))])).toThrow(/not a valid IndexState/);
    expect(() => toIndexState("f.txt", [rec(0, "A".repeat(40))])).toThrow(/not a valid IndexState/);
  });
});
