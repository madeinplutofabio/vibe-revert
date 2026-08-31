// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for the worktree materialization primitives (M 0.8.0 step 10C, §14).
//
// Nine sections:
//   A. removeWorktreePath                 (1-6)
//   B. createWorktreeDirectory            (7-10)
//   C. materializeWorktreeLeaf, regular   (11-19)
//   D. materializeWorktreeLeaf, symlink   (20-22, POSIX)
//   E. executable semantics               (23-27, POSIX)
//   F. known executable on Windows        (28, win32)
//   G. path safety                        (29-33)
//   H. oracle evidence                    (34-35)
//   I. internal-only reachability         (36)
//
// Neither root is a git repository. `observePathState` takes a plain directory,
// so the "oracle" here is an ordinary directory holding the bytes a real oracle
// worktree would hold. What these primitives do is filesystem work; introducing
// git fixtures would slow every case without exercising anything extra.
//
// The tests assert the guarantees the implementation can actually make. No
// attempt is made to manufacture the namespace races Node cannot deterministically
// expose, because a test that cannot reliably create the condition it claims to
// check is worse than an honest gap.

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PathState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";
import {
  createWorktreeDirectory,
  materializeWorktreeLeaf,
  removeWorktreePath,
} from "../src/worktree-materialize.js";

// =============================================================================
// Fixtures
// =============================================================================

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const ABSENT: PathState = { worktree: { kind: "absent" }, index: { kind: "absent" } };

const regularTarget = (content: string, executable: boolean | null = null): PathState => ({
  worktree: {
    kind: "regular",
    content_ref: sha256(Buffer.from(content, "utf8")),
    executable,
  },
  index: { kind: "absent" },
});

const symlinkTarget = (linkTarget: Buffer | string): PathState => ({
  worktree: {
    kind: "symlink",
    target_ref: sha256(Buffer.isBuffer(linkTarget) ? linkTarget : Buffer.from(linkTarget, "utf8")),
  },
  index: { kind: "absent" },
});

interface Roots {
  readonly repo: string;
  readonly oracle: string;
  /** Outside BOTH roots, for proving a refusal did not reach through a symlink. */
  readonly outside: string;
  readonly cleanup: () => Promise<void>;
}

async function setupRoots(): Promise<Roots> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-materializefixture-"));
  const repo = join(tmp, "repo");
  const oracle = join(tmp, "oracle");
  const outside = join(tmp, "outside");
  await mkdir(repo, { recursive: true });
  await mkdir(oracle, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { repo, oracle, outside, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

const at = (root: string, rel: string): string => join(root, ...rel.split("/"));

async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = at(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

const read = (root: string, rel: string): Promise<Buffer> => readFile(at(root, rel));

const permissionsOf = async (root: string, rel: string): Promise<number> =>
  (await lstat(at(root, rel))).mode & 0o7777;

async function exists(root: string, rel: string): Promise<boolean> {
  try {
    await lstat(at(root, rel));
    return true;
  } catch {
    return false;
  }
}

const isPosix = process.platform !== "win32";

// =============================================================================
// Section A: removeWorktreePath
// =============================================================================

describe("removeWorktreePath", () => {
  it("1: removes a regular file", async () => {
    const roots = await setupRoots();
    try {
      await put(roots.repo, "a.txt", "gone soon\n");
      await removeWorktreePath(roots.repo, "a.txt");
      expect(await exists(roots.repo, "a.txt")).toBe(false);
    } finally {
      await roots.cleanup();
    }
  });

  it("2: removes a symlink without following it (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      await put(roots.outside, "target.txt", "must survive\n");
      await symlink(at(roots.outside, "target.txt"), at(roots.repo, "link"));

      await removeWorktreePath(roots.repo, "link");
      expect(await exists(roots.repo, "link")).toBe(false);
      // The link went; what it pointed at did not.
      expect((await read(roots.outside, "target.txt")).toString("utf8")).toBe("must survive\n");
    } finally {
      await roots.cleanup();
    }
  });

  it("3: removes an empty directory", async () => {
    const roots = await setupRoots();
    try {
      await mkdir(at(roots.repo, "empty"));
      await removeWorktreePath(roots.repo, "empty");
      expect(await exists(roots.repo, "empty")).toBe(false);
    } finally {
      await roots.cleanup();
    }
  });

  it("4: refuses a NON-EMPTY directory and leaves its contents", async () => {
    const roots = await setupRoots();
    try {
      await put(roots.repo, "full/child.txt", "not yours to delete\n");

      await expect(removeWorktreePath(roots.repo, "full")).rejects.toThrow(
        /not empty, and removal is never recursive/,
      );
      expect((await read(roots.repo, "full/child.txt")).toString("utf8")).toBe(
        "not yours to delete\n",
      );
    } finally {
      await roots.cleanup();
    }
  });

  it("5: refuses an already-absent path", async () => {
    const roots = await setupRoots();
    try {
      // Deliberately not idempotent: the fence said something was here.
      await expect(removeWorktreePath(roots.repo, "never-existed.txt")).rejects.toThrow(
        /already absent/,
      );
    } finally {
      await roots.cleanup();
    }
  });

  it("6: refuses an unsupported node and leaves it alone (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      const socketPath = at(roots.repo, "daemon.sock");
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        await expect(removeWorktreePath(roots.repo, "daemon.sock")).rejects.toThrow(
          /unsupported filesystem node/,
        );
        expect(await exists(roots.repo, "daemon.sock")).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await roots.cleanup();
    }
  });
});

// =============================================================================
// Section B: createWorktreeDirectory
// =============================================================================

describe("createWorktreeDirectory", () => {
  it("7: creates a directory whose parent exists", async () => {
    const roots = await setupRoots();
    try {
      await mkdir(at(roots.repo, "parent"));
      await createWorktreeDirectory(roots.repo, "parent/child");
      expect((await lstat(at(roots.repo, "parent/child"))).isDirectory()).toBe(true);
    } finally {
      await roots.cleanup();
    }
  });

  it("8: refuses an EXISTING directory and leaves it untouched", async () => {
    const roots = await setupRoots();
    try {
      // Not harmless idempotence: a creation op is planned only for an absent
      // path, so finding a directory means the world moved after the fence.
      await put(roots.repo, "here/child.txt", "still here\n");

      await expect(createWorktreeDirectory(roots.repo, "here")).rejects.toThrow(
        /a directory already exists there/,
      );
      expect((await read(roots.repo, "here/child.txt")).toString("utf8")).toBe("still here\n");
    } finally {
      await roots.cleanup();
    }
  });

  it("9: refuses an existing file and leaves its content", async () => {
    const roots = await setupRoots();
    try {
      await put(roots.repo, "occupied", "a file, not a directory\n");

      await expect(createWorktreeDirectory(roots.repo, "occupied")).rejects.toThrow(
        /a regular already exists there/,
      );
      expect((await read(roots.repo, "occupied")).toString("utf8")).toBe(
        "a file, not a directory\n",
      );
    } finally {
      await roots.cleanup();
    }
  });

  it("10: refuses a missing parent and creates nothing", async () => {
    const roots = await setupRoots();
    try {
      await expect(createWorktreeDirectory(roots.repo, "absent/child")).rejects.toThrow(
        /not safely reachable/,
      );
      expect(await exists(roots.repo, "absent")).toBe(false);
      expect(await exists(roots.repo, "absent/child")).toBe(false);
    } finally {
      await roots.cleanup();
    }
  });
});

// =============================================================================
// Section C: materializeWorktreeLeaf, regular
// =============================================================================

describe("materializeWorktreeLeaf: regular", () => {
  it("11: writes the oracle's bytes over an absent destination", async () => {
    const roots = await setupRoots();
    try {
      await put(roots.oracle, "a.txt", "restored content\n");

      await materializeWorktreeLeaf(
        roots.repo,
        roots.oracle,
        "a.txt",
        regularTarget("restored content\n"),
      );
      expect((await read(roots.repo, "a.txt")).toString("utf8")).toBe("restored content\n");
    } finally {
      await roots.cleanup();
    }
  });

  it("12: overwrites a COMPATIBLE existing regular file exactly", async () => {
    const roots = await setupRoots();
    try {
      await put(roots.oracle, "a.txt", "the BEFORE bytes\n");
      await put(roots.repo, "a.txt", "much longer current content that must be fully replaced\n");

      await materializeWorktreeLeaf(
        roots.repo,
        roots.oracle,
        "a.txt",
        regularTarget("the BEFORE bytes\n"),
      );
      // Truncation happened: no tail of the old content survives.
      expect((await read(roots.repo, "a.txt")).toString("utf8")).toBe("the BEFORE bytes\n");
    } finally {
      await roots.cleanup();
    }
  });

  it("13: reproduces binary content byte for byte", async () => {
    const roots = await setupRoots();
    try {
      const bytes = Buffer.from([0x00, 0xff, 0x1b, 0x00, 0x80, 0x0a, 0xc3, 0x28]);
      await writeFile(at(roots.oracle, "blob.bin"), bytes);
      const target: PathState = {
        worktree: { kind: "regular", content_ref: sha256(bytes), executable: null },
        index: { kind: "absent" },
      };

      await materializeWorktreeLeaf(roots.repo, roots.oracle, "blob.bin", target);
      expect(await read(roots.repo, "blob.bin")).toEqual(bytes);
    } finally {
      await roots.cleanup();
    }
  });

  it("14: refuses a symlink destination, which phase 1 should have removed (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      await put(roots.oracle, "a.txt", "oracle bytes\n");
      await put(roots.outside, "victim.txt", "must not be written\n");
      await symlink(at(roots.outside, "victim.txt"), at(roots.repo, "a.txt"));

      await expect(
        materializeWorktreeLeaf(roots.repo, roots.oracle, "a.txt", regularTarget("oracle bytes\n")),
      ).rejects.toThrow(/a symlink is in the way/);
      expect((await read(roots.outside, "victim.txt")).toString("utf8")).toBe(
        "must not be written\n",
      );
    } finally {
      await roots.cleanup();
    }
  });

  it("15: refuses a directory destination and leaves it untouched", async () => {
    const roots = await setupRoots();
    try {
      await put(roots.oracle, "a.txt", "oracle bytes\n");
      await put(roots.repo, "a.txt/child.txt", "inside the directory\n");

      await expect(
        materializeWorktreeLeaf(roots.repo, roots.oracle, "a.txt", regularTarget("oracle bytes\n")),
      ).rejects.toThrow(/a directory is in the way/);
      expect((await read(roots.repo, "a.txt/child.txt")).toString("utf8")).toBe(
        "inside the directory\n",
      );
    } finally {
      await roots.cleanup();
    }
  });

  it("16: refuses a missing parent and creates no node", async () => {
    const roots = await setupRoots();
    try {
      await put(roots.oracle, "dir/a.txt", "oracle bytes\n");

      await expect(
        materializeWorktreeLeaf(
          roots.repo,
          roots.oracle,
          "dir/a.txt",
          regularTarget("oracle bytes\n"),
        ),
      ).rejects.toThrow(/not safely reachable/);
      expect(await exists(roots.repo, "dir")).toBe(false);
    } finally {
      await roots.cleanup();
    }
  });

  it("17: refuses an ABSENT leaf target", async () => {
    const roots = await setupRoots();
    try {
      await expect(
        materializeWorktreeLeaf(roots.repo, roots.oracle, "a.txt", ABSENT),
      ).rejects.toThrow(/absent is not a leaf target/);
    } finally {
      await roots.cleanup();
    }
  });

  it("18: refuses a DIRECTORY leaf target", async () => {
    const roots = await setupRoots();
    try {
      const target: PathState = {
        worktree: { kind: "directory" },
        index: { kind: "absent" },
      };
      await expect(
        materializeWorktreeLeaf(roots.repo, roots.oracle, "a.txt", target),
      ).rejects.toThrow(/directory is not a leaf target/);
    } finally {
      await roots.cleanup();
    }
  });

  it("19: refuses an UNSUPPORTED leaf target", async () => {
    const roots = await setupRoots();
    try {
      const target: PathState = {
        worktree: { kind: "unsupported", fs_kind: "unknown" },
        index: { kind: "absent" },
      };
      await expect(
        materializeWorktreeLeaf(roots.repo, roots.oracle, "a.txt", target),
      ).rejects.toThrow(/unsupported is not a leaf target/);
    } finally {
      await roots.cleanup();
    }
  });
});

// =============================================================================
// Section D: materializeWorktreeLeaf, symlink (POSIX)
// =============================================================================

describe("materializeWorktreeLeaf: symlink", () => {
  it("20: creates a symlink carrying the oracle's RAW target bytes (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      // Deliberately NOT valid UTF-8. A `readlink` that decoded to a string and
      // re-encoded would silently replace 0x80 and 0xff, so this case fails on
      // any regression away from raw-buffer handling while still proving
      // ordinary symlink creation.
      const rawTarget = Buffer.from([0x2e, 0x2f, 0x66, 0x80, 0xff]);
      await symlink(rawTarget, at(roots.oracle, "link"));

      await materializeWorktreeLeaf(roots.repo, roots.oracle, "link", symlinkTarget(rawTarget));

      expect((await lstat(at(roots.repo, "link"))).isSymbolicLink()).toBe(true);
      expect(await readlink(at(roots.repo, "link"), { encoding: "buffer" })).toEqual(rawTarget);
    } finally {
      await roots.cleanup();
    }
  });

  it("21: replaces an existing symlink WITHOUT following it (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      await put(roots.outside, "old-target.txt", "the old link's target\n");
      await symlink(at(roots.outside, "old-target.txt"), at(roots.repo, "link"));
      await symlink("new/target", at(roots.oracle, "link"));

      await materializeWorktreeLeaf(roots.repo, roots.oracle, "link", symlinkTarget("new/target"));
      expect(await readlink(at(roots.repo, "link"))).toBe("new/target");
      // Writing THROUGH the old link would have clobbered this.
      expect((await read(roots.outside, "old-target.txt")).toString("utf8")).toBe(
        "the old link's target\n",
      );
    } finally {
      await roots.cleanup();
    }
  });

  it("22: refuses a regular destination for a symlink target (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      await symlink("wherever", at(roots.oracle, "link"));
      await put(roots.repo, "link", "currently a regular file\n");

      await expect(
        materializeWorktreeLeaf(roots.repo, roots.oracle, "link", symlinkTarget("wherever")),
      ).rejects.toThrow(/a regular is in the way/);
      expect((await read(roots.repo, "link")).toString("utf8")).toBe("currently a regular file\n");
    } finally {
      await roots.cleanup();
    }
  });
});

// =============================================================================
// Section E: executable semantics (POSIX)
// =============================================================================
//
// The modeled fact is only `(mode & 0o111) !== 0`, so every case here asserts
// that the MINIMUM transition was applied and no other permission bit moved.

describe("materializeWorktreeLeaf: executable bit", () => {
  it("23: true on a non-executable file adds ONLY owner-execute (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      await put(roots.oracle, "run.sh", "#!/bin/sh\n");
      await put(roots.repo, "run.sh", "old\n");
      await chmod(at(roots.repo, "run.sh"), 0o640);

      await materializeWorktreeLeaf(
        roots.repo,
        roots.oracle,
        "run.sh",
        regularTarget("#!/bin/sh\n", true),
      );
      // NOT 0755: group-read is preserved and no new read access is granted.
      expect(await permissionsOf(roots.repo, "run.sh")).toBe(0o740);
    } finally {
      await roots.cleanup();
    }
  });

  it("24: true on an ALREADY-executable file changes nothing (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      await put(roots.oracle, "run.sh", "#!/bin/sh\n");
      await put(roots.repo, "run.sh", "old\n");
      await chmod(at(roots.repo, "run.sh"), 0o750);

      await materializeWorktreeLeaf(
        roots.repo,
        roots.oracle,
        "run.sh",
        regularTarget("#!/bin/sh\n", true),
      );
      // `true` asserts only that SOME execute bit exists; 0750 already satisfies
      // it, so normalizing to 0755 would invent permissions.
      expect(await permissionsOf(roots.repo, "run.sh")).toBe(0o750);
    } finally {
      await roots.cleanup();
    }
  });

  it("25: false clears every execute bit and preserves the rest (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      await put(roots.oracle, "plain.txt", "data\n");
      await put(roots.repo, "plain.txt", "old\n");
      await chmod(at(roots.repo, "plain.txt"), 0o710);

      await materializeWorktreeLeaf(
        roots.repo,
        roots.oracle,
        "plain.txt",
        regularTarget("data\n", false),
      );
      expect(await permissionsOf(roots.repo, "plain.txt")).toBe(0o600);
    } finally {
      await roots.cleanup();
    }
  });

  it("26: null leaves the mode entirely untouched (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      await put(roots.oracle, "a.txt", "data\n");
      await put(roots.repo, "a.txt", "old\n");
      await chmod(at(roots.repo, "a.txt"), 0o755);

      // UNKNOWN is neither `false` nor a wildcard: coercing it would clear these
      // execute bits.
      await materializeWorktreeLeaf(
        roots.repo,
        roots.oracle,
        "a.txt",
        regularTarget("data\n", null),
      );
      expect(await permissionsOf(roots.repo, "a.txt")).toBe(0o755);
    } finally {
      await roots.cleanup();
    }
  });

  it("27: a NEW file preserves the ambient creation mode and changes only the modeled bit (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      await put(roots.oracle, "run.sh", "#!/bin/sh\n");
      await put(roots.oracle, "plain.txt", "data\n");

      // A control file created by an ordinary write captures this process's real
      // creation mode. Deriving the expectations from it is what makes the umask
      // claim executable: an implementation that reverted to a synthetic
      // chmod 0755 / 0644 would satisfy "some execute bit" but fail here.
      await put(roots.repo, "control.txt", "control\n");
      const baseMode = await permissionsOf(roots.repo, "control.txt");
      const expectedExecutable = (baseMode & 0o111) !== 0 ? baseMode : baseMode | 0o100;
      const expectedNonExecutable = baseMode & ~0o111;

      await materializeWorktreeLeaf(
        roots.repo,
        roots.oracle,
        "run.sh",
        regularTarget("#!/bin/sh\n", true),
      );
      expect(await permissionsOf(roots.repo, "run.sh")).toBe(expectedExecutable);

      await materializeWorktreeLeaf(
        roots.repo,
        roots.oracle,
        "plain.txt",
        regularTarget("data\n", false),
      );
      expect(await permissionsOf(roots.repo, "plain.txt")).toBe(expectedNonExecutable);
    } finally {
      await roots.cleanup();
    }
  });
});

// =============================================================================
// Section F: known executable on a host that cannot establish it (win32)
// =============================================================================

describe("materializeWorktreeLeaf: unsupported executable host", () => {
  it("28: refuses BOTH true and false before touching the destination (win32)", async (ctx) => {
    if (isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      await put(roots.oracle, "a.txt", "oracle bytes\n");

      // Table-driven so an implementation guarding only `=== true` cannot pass:
      // `false` is a known assertion too, not "don't care".
      for (const executable of [true, false] as const) {
        await put(roots.repo, "a.txt", "original\n");
        await expect(
          materializeWorktreeLeaf(
            roots.repo,
            roots.oracle,
            "a.txt",
            regularTarget("oracle bytes\n", executable),
          ),
        ).rejects.toThrow(/this platform cannot establish or observe/);
        expect((await read(roots.repo, "a.txt")).toString("utf8")).toBe("original\n");
      }
    } finally {
      await roots.cleanup();
    }
  });
});

// =============================================================================
// Section G: path safety
// =============================================================================

describe("path safety", () => {
  const unsafe = ["../escape.txt", "/absolute.txt", ".viberevert/objects/ab", "a\\b.txt", ""];

  it("29: every primitive refuses an unsafe path through ITS OWN lexical guard", async () => {
    const roots = await setupRoots();
    try {
      // Anchored on each primitive's own context prefix. A bare `rejects.toThrow()`
      // would also pass if the refusal came later from `observePathState`
      // rejecting the oracle path, which would not prove this module owns the
      // check.
      for (const path of unsafe) {
        await expect(removeWorktreePath(roots.repo, path)).rejects.toThrow(/^removeWorktreePath:/);
        await expect(createWorktreeDirectory(roots.repo, path)).rejects.toThrow(
          /^createWorktreeDirectory:/,
        );
        await expect(
          materializeWorktreeLeaf(roots.repo, roots.oracle, path, regularTarget("x\n")),
        ).rejects.toThrow(/^materializeWorktreeLeaf:/);
      }
    } finally {
      await roots.cleanup();
    }
  });

  it("30: the .viberevert store is refused and never mutated", async () => {
    const roots = await setupRoots();
    try {
      await put(roots.repo, ".viberevert/sessions/x.json", "{}\n");
      await put(roots.oracle, ".viberevert/sessions/x.json", "{}\n");

      await expect(removeWorktreePath(roots.repo, ".viberevert/sessions/x.json")).rejects.toThrow(
        /path under \.viberevert\//,
      );
      await expect(createWorktreeDirectory(roots.repo, ".viberevert/new")).rejects.toThrow(
        /path under \.viberevert\//,
      );
      await expect(
        materializeWorktreeLeaf(
          roots.repo,
          roots.oracle,
          ".viberevert/sessions/x.json",
          regularTarget("{}\n"),
        ),
      ).rejects.toThrow(/path under \.viberevert\//);

      expect((await read(roots.repo, ".viberevert/sessions/x.json")).toString("utf8")).toBe("{}\n");
      expect(await exists(roots.repo, ".viberevert/new")).toBe(false);
    } finally {
      await roots.cleanup();
    }
  });

  it("31: Git control metadata is refused and never mutated", async () => {
    const roots = await setupRoots();
    try {
      await put(roots.repo, ".git/config", "[core]\n\tsentinel = true\n");
      await put(roots.oracle, ".git/config", "[core]\n\tattacker = true\n");

      await expect(removeWorktreePath(roots.repo, ".git/config")).rejects.toThrow(
        /path under Git control metadata/,
      );
      await expect(createWorktreeDirectory(roots.repo, ".git/new")).rejects.toThrow(
        /path under Git control metadata/,
      );
      await expect(
        materializeWorktreeLeaf(
          roots.repo,
          roots.oracle,
          ".git/config",
          regularTarget("[core]\n\tattacker = true\n"),
        ),
      ).rejects.toThrow(/path under Git control metadata/);

      expect((await read(roots.repo, ".git/config")).toString("utf8")).toBe(
        "[core]\n\tsentinel = true\n",
      );
      expect(await exists(roots.repo, ".git/new")).toBe(false);

      // ROOT-ANCHORED, proven in both dimensions. `.gitignore` and `src/.gitkeep`
      // rule out matching on a `.git` PREFIX; `src/.git/user.txt` rules out
      // matching an exact `.git` SEGMENT anywhere, which a nested repository or
      // vendored directory legitimately contains. `.gitignore` in particular is
      // content selective restore must be able to write.
      await put(roots.oracle, ".gitignore", "node_modules/\n");
      await put(roots.oracle, "src/.gitkeep", "keep\n");
      await put(roots.oracle, "src/.git/user.txt", "nested data\n");
      await mkdir(at(roots.repo, "src/.git"), { recursive: true });

      await materializeWorktreeLeaf(
        roots.repo,
        roots.oracle,
        ".gitignore",
        regularTarget("node_modules/\n"),
      );
      await materializeWorktreeLeaf(
        roots.repo,
        roots.oracle,
        "src/.gitkeep",
        regularTarget("keep\n"),
      );
      await materializeWorktreeLeaf(
        roots.repo,
        roots.oracle,
        "src/.git/user.txt",
        regularTarget("nested data\n"),
      );

      expect((await read(roots.repo, ".gitignore")).toString("utf8")).toBe("node_modules/\n");
      expect((await read(roots.repo, "src/.gitkeep")).toString("utf8")).toBe("keep\n");
      expect((await read(roots.repo, "src/.git/user.txt")).toString("utf8")).toBe("nested data\n");
    } finally {
      await roots.cleanup();
    }
  });

  it("32: a SYMLINKED destination ancestor refuses and never reaches through it (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      await put(roots.outside, "victim.txt", "outside the repository\n");
      await put(roots.oracle, "a/victim.txt", "oracle bytes\n");
      // `repo/a` resolves outside the repository. Path resolution would follow
      // it before any rule about the final component applied.
      await symlink(roots.outside, at(roots.repo, "a"));

      await expect(
        materializeWorktreeLeaf(
          roots.repo,
          roots.oracle,
          "a/victim.txt",
          regularTarget("oracle bytes\n"),
        ),
      ).rejects.toThrow(/not safely reachable/);
      expect((await read(roots.outside, "victim.txt")).toString("utf8")).toBe(
        "outside the repository\n",
      );
    } finally {
      await roots.cleanup();
    }
  });

  it("33: removal and directory creation refuse a symlinked ancestor too (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const roots = await setupRoots();
    try {
      await put(roots.outside, "victim.txt", "outside the repository\n");
      await symlink(roots.outside, at(roots.repo, "a"));

      await expect(removeWorktreePath(roots.repo, "a/victim.txt")).rejects.toThrow(
        /not safely reachable/,
      );
      await expect(createWorktreeDirectory(roots.repo, "a/newdir")).rejects.toThrow(
        /not safely reachable/,
      );
      expect(await exists(roots.outside, "victim.txt")).toBe(true);
      expect(await exists(roots.outside, "newdir")).toBe(false);
    } finally {
      await roots.cleanup();
    }
  });
});

// =============================================================================
// Section H: oracle evidence
// =============================================================================

describe("oracle evidence", () => {
  it("34: a KIND mismatch refuses before the destination changes", async () => {
    const roots = await setupRoots();
    try {
      // The oracle holds a directory where the target asserts a regular file.
      await put(roots.oracle, "a.txt/child", "not a regular file\n");
      await put(roots.repo, "a.txt", "untouched\n");

      await expect(
        materializeWorktreeLeaf(roots.repo, roots.oracle, "a.txt", regularTarget("whatever\n")),
      ).rejects.toThrow(/the oracle holds a directory/);
      expect((await read(roots.repo, "a.txt")).toString("utf8")).toBe("untouched\n");
    } finally {
      await roots.cleanup();
    }
  });

  it("35: a REF mismatch refuses before the destination changes", async () => {
    const roots = await setupRoots();
    try {
      await put(roots.oracle, "a.txt", "what the oracle actually holds\n");
      await put(roots.repo, "a.txt", "untouched\n");

      await expect(
        materializeWorktreeLeaf(
          roots.repo,
          roots.oracle,
          "a.txt",
          regularTarget("a DIFFERENT asserted BEFORE\n"),
        ),
      ).rejects.toThrow(/does not match the target/);
      expect((await read(roots.repo, "a.txt")).toString("utf8")).toBe("untouched\n");
    } finally {
      await roots.cleanup();
    }
  });
});

// =============================================================================
// Section I: internal-only reachability
// =============================================================================
//
// The executable form of 10C's safety property: mutation-capable code may land
// before the attempt marker and fence exist ONLY because nothing in a shipped
// build can reach it.
//
// TEMPORARY IN THIS FORM. When 10F lands, change this to a caller ALLOWLIST
// naming the scheduler, rather than deleting it. Until then any production
// import is a reachability violation.

describe("internal-only reachability", () => {
  it("36: no barrel export and no production caller", async () => {
    const srcDir = new URL("../src/", import.meta.url);

    const barrel = await readFile(new URL("index.ts", srcDir), "utf8");
    expect(barrel).not.toContain("worktree-materialize");

    const names = (await readdir(srcDir)).filter(
      (name) => name.endsWith(".ts") && name !== "worktree-materialize.ts",
    );
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const source = await readFile(new URL(name, srcDir), "utf8");
      expect(source, `${name} imports the internal-only materializer`).not.toContain(
        './worktree-materialize.js"',
      );
    }
  });
});
