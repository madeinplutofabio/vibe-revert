// packages/git/test/diff.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// diff.ts — A.2 targeted tests.
//
// Two layers:
//
// 1. PURE PARSER TESTS (via _*ForTests exports)
//    - parseUnifiedDiff: fail-closed contracts; binary marker; GIT binary
//      patch; derived status from new/deleted-file-mode / rename / mode-only;
//      quoted-path rejection; malformed-header rejection; rename-pair-half
//      rejection; additionalStripPrefixes strip.
//    - parseNameStatus: empty-status throw; R<score> regex validation;
//      copy-token rejection; unknown-token rejection; truncated entries;
//      unsafe-path rejection inside entries.
//    - assertSafeRepoRelativePath: positive + each negative class.
//
// 2. INTEGRATION TESTS (real git, temp repos)
//    - getDiffSinceRef: modified / added / deleted / renamed / binary;
//      --cached (staged) scope; untracked enumeration with bounded read;
//      gitignore-respecting enumeration; unparseable-ref throws
//      DiffRefNotFoundError; option-injection defense via --end-of-options.
//    - getDiffSinceCheckpoint: clean-tree base; post-checkpoint additions;
//      THE D56 TRUST-CRITICAL ASSERTION — pre-existing dirty work at
//      capture time is EXCLUDED from findings; liveExcludePatterns
//      filtering; .viberevert/ misconfiguration THROW (defeat gitignore
//      AFTER valid checkpoint); scratch worktree cleaned up after success;
//      loadCheckpoint failure does not allocate internal temp resources.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createCheckpoint } from "../src/checkpoint.js";
import {
  _assertSafeRepoRelativePathForTests as assertSafeRepoRelativePath,
  DiffParseError,
  DiffRefNotFoundError,
  getDiffSinceCheckpoint,
  getDiffSinceRef,
  _parseNameStatusForTests as parseNameStatus,
  _parseUnifiedDiffForTests as parseUnifiedDiff,
} from "../src/diff.js";

// =============================================================================
// Test helpers
// =============================================================================

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

interface TestRepo {
  readonly repoRoot: string;
  cleanup: () => Promise<void>;
}

/**
 * Minimal temp git repo with .gitignore + a single committed file (so HEAD
 * exists). core.autocrlf=false is set so writeFile content survives intact
 * across Windows/POSIX. Caller adds further commits / edits as needed.
 */
async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-difftest-"));
  const repoRoot = join(tmp, "repo");
  await mkdir(repoRoot, { recursive: true });
  await runGit(repoRoot, ["init", "-b", "main"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test User"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
  await runGit(repoRoot, ["config", "core.autocrlf", "false"]);
  // .viberevert/ MUST be gitignored — D56 + test invariant. Without this,
  // checkpoint creation INSIDE the repo would surface as candidates.
  await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await runGit(repoRoot, ["add", ".gitignore", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return {
    repoRoot,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

interface TestRepoWithCheckpoint extends TestRepo {
  readonly checkpointDir: string;
}

/**
 * Temp git repo + a checkpoint captured at the current state. checkpointDir
 * lives OUTSIDE the repo so it doesn't pollute candidate enumeration
 * (per the existing restore.test.ts convention).
 */
async function setupRepoWithCheckpoint(): Promise<TestRepoWithCheckpoint> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-difftest-"));
  const repoRoot = join(tmp, "repo");
  const checkpointDir = join(tmp, "checkpoint");
  await mkdir(repoRoot, { recursive: true });
  await runGit(repoRoot, ["init", "-b", "main"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test User"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
  await runGit(repoRoot, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await runGit(repoRoot, ["add", ".gitignore", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  await mkdir(checkpointDir, { recursive: true });
  await createCheckpoint({ repoRoot, checkpointDir, rollbackExcludePatterns: [] });
  return {
    repoRoot,
    checkpointDir,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Snapshot the OS temp dir for `viberevert-diff-` prefixed entries — the
 * prefix used by getDiffSinceCheckpoint's internal mkdtemp. Used by
 * cleanup-proof tests; test-fixture temp dirs use the `viberevert-difftest-`
 * prefix (no overlap).
 */
async function listInternalTempDirs(): Promise<readonly string[]> {
  try {
    const all = await readdir(tmpdir());
    return all.filter(
      (n) => n.startsWith("viberevert-diff-") && !n.startsWith("viberevert-difftest-"),
    );
  } catch {
    return [];
  }
}

// =============================================================================
// SECTION 1 — parseUnifiedDiff (pure parser)
// =============================================================================

describe("parseUnifiedDiff — pure parser", () => {
  it("empty input returns empty array", () => {
    expect(parseUnifiedDiff("", { stripPrefixes: true })).toEqual([]);
  });

  it("non-empty input with zero `diff --git` chunks throws DiffParseError", () => {
    expect(() => parseUnifiedDiff("not a diff at all\n", { stripPrefixes: true })).toThrow(
      DiffParseError,
    );
  });

  it("single add entry parses path + hunk + derives status='added'", () => {
    const input =
      "diff --git a/src/foo.ts b/src/foo.ts\n" +
      "new file mode 100644\n" +
      "index 0000000..abcd\n" +
      "--- /dev/null\n" +
      "+++ b/src/foo.ts\n" +
      "@@ -0,0 +1,2 @@\n" +
      "+line one\n" +
      "+line two\n";
    const result = parseUnifiedDiff(input, { stripPrefixes: true });
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry).toBeDefined();
    expect(entry?.path).toBe("src/foo.ts");
    expect(entry?.derivedStatus).toBe("added");
    expect(entry?.isBinary).toBe(false);
    expect(entry?.hunks).toHaveLength(1);
    expect(entry?.hunks[0]?.lines).toEqual([
      { kind: "add", text: "line one" },
      { kind: "add", text: "line two" },
    ]);
  });

  it("'Binary files ... differ' sets isBinary=true and skips hunks", () => {
    const input =
      "diff --git a/img.png b/img.png\n" +
      "index abcd..efgh\n" +
      "Binary files a/img.png and b/img.png differ\n";
    const [entry] = parseUnifiedDiff(input, { stripPrefixes: true });
    expect(entry).toBeDefined();
    expect(entry?.path).toBe("img.png");
    expect(entry?.isBinary).toBe(true);
    expect(entry?.hunks).toEqual([]);
  });

  it("'GIT binary patch' header sets isBinary=true (inline base85 block case)", () => {
    const input =
      "diff --git a/img.png b/img.png\n" +
      "index abcd..efgh 100644\n" +
      "GIT binary patch\n" +
      "literal 42\n" +
      "JcmZQzWMT-9000010000000000\n";
    const [entry] = parseUnifiedDiff(input, { stripPrefixes: true });
    expect(entry).toBeDefined();
    expect(entry?.isBinary).toBe(true);
    expect(entry?.hunks).toEqual([]);
  });

  it("'deleted file mode' header sets derivedStatus='deleted'", () => {
    const input =
      "diff --git a/old.txt b/old.txt\n" +
      "deleted file mode 100644\n" +
      "index abcd..0000000\n" +
      "--- a/old.txt\n" +
      "+++ /dev/null\n" +
      "@@ -1,1 +0,0 @@\n" +
      "-gone\n";
    const [entry] = parseUnifiedDiff(input, { stripPrefixes: true });
    expect(entry).toBeDefined();
    expect(entry?.derivedStatus).toBe("deleted");
  });

  it("'rename from' + 'rename to' sets derivedStatus='renamed' + previous_path", () => {
    const input =
      "diff --git a/old.txt b/new.txt\n" +
      "similarity index 95%\n" +
      "rename from old.txt\n" +
      "rename to new.txt\n";
    const [entry] = parseUnifiedDiff(input, { stripPrefixes: true });
    expect(entry).toBeDefined();
    expect(entry?.derivedStatus).toBe("renamed");
    expect(entry?.path).toBe("new.txt");
    expect(entry?.previous_path).toBe("old.txt");
  });

  it("'rename to' WITHOUT 'rename from' throws DiffParseError (pair-half fail-closed)", () => {
    const input =
      "diff --git a/old.txt b/new.txt\n" + "similarity index 95%\n" + "rename to new.txt\n";
    expect(() => parseUnifiedDiff(input, { stripPrefixes: true })).toThrow(DiffParseError);
  });

  it("'rename from' WITHOUT 'rename to' throws DiffParseError (pair-half fail-closed)", () => {
    const input =
      "diff --git a/old.txt b/new.txt\n" + "similarity index 95%\n" + "rename from old.txt\n";
    expect(() => parseUnifiedDiff(input, { stripPrefixes: true })).toThrow(DiffParseError);
  });

  it("old mode + new mode (different) sets derivedStatus='type_changed'", () => {
    const input =
      "diff --git a/script.sh b/script.sh\n" + "old mode 100644\n" + "new mode 100755\n";
    const [entry] = parseUnifiedDiff(input, { stripPrefixes: true });
    expect(entry).toBeDefined();
    expect(entry?.derivedStatus).toBe("type_changed");
  });

  it("quoted path in header throws DiffParseError (quoted-path limitation)", () => {
    const input = 'diff --git "a/has space.txt" "b/has space.txt"\n';
    expect(() => parseUnifiedDiff(input, { stripPrefixes: true })).toThrow(DiffParseError);
  });

  it("header with !=2 space-separated tokens (path containing literal space) throws", () => {
    // After splitting on `diff --git `, the chunk header is
    // `a/has space.txt b/has space.txt` → 4 space-separated tokens.
    const input = "diff --git a/has space.txt b/has space.txt\n";
    expect(() => parseUnifiedDiff(input, { stripPrefixes: true })).toThrow(DiffParseError);
  });

  it("additionalStripPrefixes peels mirror-dir basenames (checkpoint mode)", () => {
    const input =
      "diff --git a/base/src/foo.ts b/live/src/foo.ts\n" +
      "index abcd..efgh\n" +
      "--- a/base/src/foo.ts\n" +
      "+++ b/live/src/foo.ts\n" +
      "@@ -1,0 +1,1 @@\n" +
      "+added\n";
    const [entry] = parseUnifiedDiff(input, {
      stripPrefixes: true,
      additionalStripPrefixes: ["base/", "live/"],
    });
    expect(entry).toBeDefined();
    expect(entry?.path).toBe("src/foo.ts");
  });

  it("rejects unsafe path inside an entry header (e.g. .viberevert/foo)", () => {
    const input =
      "diff --git a/.viberevert/leak b/.viberevert/leak\n" +
      "new file mode 100644\n" +
      "--- /dev/null\n" +
      "+++ b/.viberevert/leak\n";
    expect(() => parseUnifiedDiff(input, { stripPrefixes: true })).toThrow(DiffParseError);
  });
});

// =============================================================================
// SECTION 2 — parseNameStatus (pure parser)
// =============================================================================

describe("parseNameStatus — pure parser", () => {
  function makeBuf(...parts: readonly string[]): Buffer {
    return Buffer.from(`${parts.join("\0")}\0`);
  }

  it("empty buffer returns empty array", () => {
    expect(parseNameStatus(Buffer.alloc(0))).toEqual([]);
  });

  it("single A token → added", () => {
    expect(parseNameStatus(makeBuf("A", "src/foo.ts"))).toEqual([
      { status: "added", path: "src/foo.ts" },
    ]);
  });

  it("single M token → modified", () => {
    expect(parseNameStatus(makeBuf("M", "src/foo.ts"))).toEqual([
      { status: "modified", path: "src/foo.ts" },
    ]);
  });

  it("single D token → deleted", () => {
    expect(parseNameStatus(makeBuf("D", "src/foo.ts"))).toEqual([
      { status: "deleted", path: "src/foo.ts" },
    ]);
  });

  it("single T token → type_changed", () => {
    expect(parseNameStatus(makeBuf("T", "src/script.sh"))).toEqual([
      { status: "type_changed", path: "src/script.sh" },
    ]);
  });

  it("R100 → renamed with previous_path + new path", () => {
    expect(parseNameStatus(makeBuf("R100", "src/old.ts", "src/new.ts"))).toEqual([
      { status: "renamed", path: "src/new.ts", previous_path: "src/old.ts" },
    ]);
  });

  it("R0 → renamed (score=0 is a valid R<digits> token)", () => {
    expect(parseNameStatus(makeBuf("R0", "src/old.ts", "src/new.ts"))).toEqual([
      { status: "renamed", path: "src/new.ts", previous_path: "src/old.ts" },
    ]);
  });

  it("'ReallyBad' (R-prefixed but not R<digits>) throws DiffParseError", () => {
    expect(() => parseNameStatus(makeBuf("ReallyBad", "foo", "bar"))).toThrow(DiffParseError);
  });

  it("C100 (copy token) throws DiffParseError (not supported in M C)", () => {
    expect(() => parseNameStatus(makeBuf("C100", "src/orig.ts", "src/copy.ts"))).toThrow(
      DiffParseError,
    );
  });

  it("unknown token 'X' throws DiffParseError", () => {
    expect(() => parseNameStatus(makeBuf("X", "src/foo.ts"))).toThrow(DiffParseError);
  });

  it("truncated rename (R100 + only previous, no current) throws", () => {
    expect(() => parseNameStatus(makeBuf("R100", "src/old.ts"))).toThrow(DiffParseError);
  });

  it("truncated entry (status without path) throws", () => {
    expect(() => parseNameStatus(makeBuf("A"))).toThrow(DiffParseError);
  });

  it("empty interior status token throws DiffParseError (malformed -z output)", () => {
    // Leading \0 → splitNulList yields ["", "A", "foo"]; the empty leading
    // token is the malformed-input signal we fail closed on.
    expect(() => parseNameStatus(Buffer.from("\0A\0foo\0"))).toThrow(DiffParseError);
  });

  it("rejects unsafe path inside a status entry (absolute path)", () => {
    expect(() => parseNameStatus(makeBuf("A", "/etc/passwd"))).toThrow(DiffParseError);
  });

  it("rejects unsafe rename previous_path (../escape)", () => {
    expect(() => parseNameStatus(makeBuf("R100", "../escape", "src/new.ts"))).toThrow(
      DiffParseError,
    );
  });

  it("rejects unsafe rename current path (.viberevert/leak)", () => {
    expect(() => parseNameStatus(makeBuf("R100", "src/old.ts", ".viberevert/leak"))).toThrow(
      DiffParseError,
    );
  });
});

// =============================================================================
// SECTION 3 — assertSafeRepoRelativePath (pure)
// =============================================================================

describe("assertSafeRepoRelativePath — pure", () => {
  it("accepts plain repo-relative paths", () => {
    expect(() => assertSafeRepoRelativePath("src/foo.ts", "test")).not.toThrow();
    expect(() => assertSafeRepoRelativePath("a/b/c.txt", "test")).not.toThrow();
    expect(() => assertSafeRepoRelativePath("README.md", "test")).not.toThrow();
  });

  it("rejects empty", () => {
    expect(() => assertSafeRepoRelativePath("", "test")).toThrow(DiffParseError);
  });

  it("rejects backslash", () => {
    expect(() => assertSafeRepoRelativePath("src\\foo.ts", "test")).toThrow(DiffParseError);
  });

  it("rejects POSIX absolute (leading /)", () => {
    expect(() => assertSafeRepoRelativePath("/etc/passwd", "test")).toThrow(DiffParseError);
  });

  it("rejects Windows drive prefix", () => {
    expect(() => assertSafeRepoRelativePath("C:/Windows/System32", "test")).toThrow(DiffParseError);
    expect(() => assertSafeRepoRelativePath("D:foo", "test")).toThrow(DiffParseError);
  });

  it("rejects .. segment", () => {
    expect(() => assertSafeRepoRelativePath("../escape", "test")).toThrow(DiffParseError);
    expect(() => assertSafeRepoRelativePath("src/../escape", "test")).toThrow(DiffParseError);
  });

  it("rejects . segment", () => {
    expect(() => assertSafeRepoRelativePath("./foo", "test")).toThrow(DiffParseError);
    expect(() => assertSafeRepoRelativePath("src/./foo", "test")).toThrow(DiffParseError);
  });

  it("rejects empty segment (double slash)", () => {
    expect(() => assertSafeRepoRelativePath("src//foo", "test")).toThrow(DiffParseError);
  });

  it("rejects .viberevert exactly", () => {
    expect(() => assertSafeRepoRelativePath(".viberevert", "test")).toThrow(DiffParseError);
  });

  it("rejects .viberevert/ subpath", () => {
    expect(() => assertSafeRepoRelativePath(".viberevert/sessions/foo", "test")).toThrow(
      DiffParseError,
    );
  });
});

// =============================================================================
// SECTION 4 — getDiffSinceRef integration (real git, temp repo)
// =============================================================================

describe("getDiffSinceRef — integration", () => {
  it("detects modified file (status='modified', has hunk)", async () => {
    const repo = await setupRepo();
    try {
      await writeFile(join(repo.repoRoot, "README.md"), "# test\n\nadded line\n");
      const { diff, cleanupWarnings } = await getDiffSinceRef(repo.repoRoot, "HEAD", {});
      expect(cleanupWarnings).toEqual([]);
      const e = diff.entries.find((x) => x.path === "README.md");
      expect(e).toBeDefined();
      expect(e?.status).toBe("modified");
      expect(e?.hunks.length).toBeGreaterThan(0);
    } finally {
      await repo.cleanup();
    }
  });

  it("detects added (tracked) file via name-status authority", async () => {
    const repo = await setupRepo();
    try {
      await mkdir(join(repo.repoRoot, "src"), { recursive: true });
      await writeFile(join(repo.repoRoot, "src/new.ts"), "export {};\n");
      await runGit(repo.repoRoot, ["add", "src/new.ts"]);
      await runGit(repo.repoRoot, ["commit", "-m", "add new"]);
      const { diff } = await getDiffSinceRef(repo.repoRoot, "HEAD~1", {});
      const e = diff.entries.find((x) => x.path === "src/new.ts");
      expect(e).toBeDefined();
      expect(e?.status).toBe("added");
    } finally {
      await repo.cleanup();
    }
  });

  it("detects deleted file (status='deleted')", async () => {
    const repo = await setupRepo();
    try {
      await runGit(repo.repoRoot, ["rm", "README.md"]);
      await runGit(repo.repoRoot, ["commit", "-m", "remove readme"]);
      const { diff } = await getDiffSinceRef(repo.repoRoot, "HEAD~1", {});
      const e = diff.entries.find((x) => x.path === "README.md");
      expect(e).toBeDefined();
      expect(e?.status).toBe("deleted");
    } finally {
      await repo.cleanup();
    }
  });

  it("detects renamed file (status='renamed', previous_path populated)", async () => {
    const repo = await setupRepo();
    try {
      // Fatten the file so rename detection (-M) catches similarity.
      const bigContent = `# test\n\n${"x ".repeat(500)}\n`;
      await writeFile(join(repo.repoRoot, "README.md"), bigContent);
      await runGit(repo.repoRoot, ["add", "README.md"]);
      await runGit(repo.repoRoot, ["commit", "-m", "fatten readme"]);
      await runGit(repo.repoRoot, ["mv", "README.md", "DOCS.md"]);
      await runGit(repo.repoRoot, ["commit", "-m", "rename"]);
      const { diff } = await getDiffSinceRef(repo.repoRoot, "HEAD~1", {});
      const e = diff.entries.find((x) => x.path === "DOCS.md");
      expect(e).toBeDefined();
      expect(e?.status).toBe("renamed");
      expect(e?.previous_path).toBe("README.md");
    } finally {
      await repo.cleanup();
    }
  });

  it("detects modified binary file (isBinary=true, no hunks)", async () => {
    const repo = await setupRepo();
    try {
      const binBefore = Buffer.from([0, 1, 2, 0, 3, 4, 5]);
      await writeFile(join(repo.repoRoot, "data.bin"), binBefore);
      await runGit(repo.repoRoot, ["add", "data.bin"]);
      await runGit(repo.repoRoot, ["commit", "-m", "add binary"]);
      const binAfter = Buffer.from([0, 1, 2, 0, 99, 4, 5]);
      await writeFile(join(repo.repoRoot, "data.bin"), binAfter);
      const { diff } = await getDiffSinceRef(repo.repoRoot, "HEAD", {});
      const e = diff.entries.find((x) => x.path === "data.bin");
      expect(e).toBeDefined();
      expect(e?.isBinary).toBe(true);
      expect(e?.hunks).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("--cached (staged: true) scopes diff to the index (excludes worktree-only changes)", async () => {
    const repo = await setupRepo();
    try {
      await writeFile(join(repo.repoRoot, "staged.txt"), "staged\n");
      await runGit(repo.repoRoot, ["add", "staged.txt"]);
      await writeFile(join(repo.repoRoot, "worktree-only.txt"), "wt only\n");
      const { diff } = await getDiffSinceRef(repo.repoRoot, "HEAD", { staged: true });
      expect(diff.entries.find((x) => x.path === "staged.txt")).toBeDefined();
      expect(diff.entries.find((x) => x.path === "worktree-only.txt")).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it("enumerates untracked-not-ignored files as 'added' (non-staged mode)", async () => {
    const repo = await setupRepo();
    try {
      await writeFile(join(repo.repoRoot, "untracked.txt"), "hi\nbye\n");
      const { diff } = await getDiffSinceRef(repo.repoRoot, "HEAD", {});
      const e = diff.entries.find((x) => x.path === "untracked.txt");
      expect(e).toBeDefined();
      expect(e?.status).toBe("added");
      expect(e?.isBinary).toBe(false);
      expect(e?.hunks[0]?.lines.map((l) => l.text)).toEqual(["hi", "bye"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("untracked file > MAX_UNTRACKED_TEXT_BYTES is marked isBinary=true with no hunks (bounded read)", async () => {
    const repo = await setupRepo();
    try {
      // 2 MiB of ASCII 'A's — well over the 1 MiB cap. ASCII content so the
      // binary scan would NOT trigger; this isolates the size-bound path.
      const big = "A".repeat(2 * 1024 * 1024);
      await writeFile(join(repo.repoRoot, "big.log"), big);
      const { diff } = await getDiffSinceRef(repo.repoRoot, "HEAD", {});
      const e = diff.entries.find((x) => x.path === "big.log");
      expect(e).toBeDefined();
      expect(e?.isBinary).toBe(true);
      expect(e?.hunks).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("gitignore is respected via ls-files --exclude-standard", async () => {
    const repo = await setupRepo();
    try {
      await writeFile(join(repo.repoRoot, ".gitignore"), ".viberevert/\nnode_modules/\n");
      await runGit(repo.repoRoot, ["add", ".gitignore"]);
      await runGit(repo.repoRoot, ["commit", "-m", "ignore node_modules"]);
      await mkdir(join(repo.repoRoot, "node_modules"), { recursive: true });
      await writeFile(join(repo.repoRoot, "node_modules/pkg.txt"), "ignored\n");
      const { diff } = await getDiffSinceRef(repo.repoRoot, "HEAD", {});
      expect(diff.entries.find((x) => x.path.startsWith("node_modules/"))).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it("unparseable ref throws DiffRefNotFoundError", async () => {
    const repo = await setupRepo();
    try {
      await expect(getDiffSinceRef(repo.repoRoot, "totally-not-a-ref", {})).rejects.toThrow(
        DiffRefNotFoundError,
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("option-injection defense: ref starting with `-` is treated as a literal ref (not an option)", async () => {
    const repo = await setupRepo();
    try {
      // Without --end-of-options, `git rev-parse --verify -Hello^{commit}`
      // would interpret -Hello as an option flag. With --end-of-options the
      // ref is treated as a literal, fails to resolve, and we surface the
      // standard DiffRefNotFoundError — NOT an option-misuse error from git.
      await expect(getDiffSinceRef(repo.repoRoot, "-Hello", {})).rejects.toThrow(
        DiffRefNotFoundError,
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("empty repo state (no changes since HEAD) returns empty entries + no warnings", async () => {
    const repo = await setupRepo();
    try {
      const { diff, cleanupWarnings } = await getDiffSinceRef(repo.repoRoot, "HEAD", {});
      expect(diff.entries).toEqual([]);
      expect(cleanupWarnings).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("entries are sorted deterministically by path ASC", async () => {
    const repo = await setupRepo();
    try {
      await writeFile(join(repo.repoRoot, "zebra.txt"), "z\n");
      await writeFile(join(repo.repoRoot, "alpha.txt"), "a\n");
      await writeFile(join(repo.repoRoot, "mango.txt"), "m\n");
      const { diff } = await getDiffSinceRef(repo.repoRoot, "HEAD", {});
      const paths = diff.entries.map((e) => e.path);
      const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(paths).toEqual(sorted);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// SECTION 5 — getDiffSinceCheckpoint integration (D56 trust-critical)
// =============================================================================

describe("getDiffSinceCheckpoint — integration", () => {
  it("clean-tree checkpoint + no changes → empty entries", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      const { diff, cleanupWarnings } = await getDiffSinceCheckpoint(
        repo.repoRoot,
        repo.checkpointDir,
        {},
      );
      expect(diff.entries).toEqual([]);
      expect(cleanupWarnings).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("post-checkpoint addition appears (status='added', derived from new file mode)", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      await writeFile(join(repo.repoRoot, "added.txt"), "new\n");
      const { diff } = await getDiffSinceCheckpoint(repo.repoRoot, repo.checkpointDir, {});
      const e = diff.entries.find((x) => x.path === "added.txt");
      expect(e).toBeDefined();
      expect(e?.status).toBe("added");
    } finally {
      await repo.cleanup();
    }
  });

  it("D56 TRUST-CRITICAL: pre-existing dirty file at capture time is EXCLUDED", async () => {
    // Build a repo with a tracked file that's DIRTY (modified) BEFORE the
    // checkpoint is created. The checkpoint captures that dirty state.
    // Then make a SEPARATE post-checkpoint edit to a DIFFERENT file. The
    // diff MUST contain only the post-checkpoint edit; the pre-existing
    // dirt MUST NOT appear (it was part of the base, not the session).
    const tmp = await mkdtemp(join(tmpdir(), "viberevert-difftest-"));
    const repoRoot = join(tmp, "repo");
    const checkpointDir = join(tmp, "checkpoint");
    try {
      await mkdir(repoRoot, { recursive: true });
      await runGit(repoRoot, ["init", "-b", "main"]);
      await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
      await runGit(repoRoot, ["config", "user.name", "Test User"]);
      await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
      await runGit(repoRoot, ["config", "core.autocrlf", "false"]);
      await writeFile(join(repoRoot, ".gitignore"), ".viberevert/\n");
      await writeFile(join(repoRoot, "tracked.txt"), "original\n");
      await runGit(repoRoot, ["add", ".gitignore", "tracked.txt"]);
      await runGit(repoRoot, ["commit", "-m", "initial"]);

      // Dirty the tracked file BEFORE the checkpoint.
      await writeFile(join(repoRoot, "tracked.txt"), "pre-checkpoint DIRTY\n");

      // Capture.
      await mkdir(checkpointDir, { recursive: true });
      await createCheckpoint({ repoRoot, checkpointDir, rollbackExcludePatterns: [] });

      // Make a SEPARATE post-checkpoint edit to a DIFFERENT file.
      await writeFile(join(repoRoot, "post.txt"), "post-checkpoint addition\n");

      const { diff } = await getDiffSinceCheckpoint(repoRoot, checkpointDir, {});

      // Post-checkpoint file MUST appear.
      const post = diff.entries.find((x) => x.path === "post.txt");
      expect(post).toBeDefined();
      expect(post?.status).toBe("added");

      // Pre-existing dirt MUST NOT appear — it was already present at
      // capture time and is part of the base.
      const tracked = diff.entries.find((x) => x.path === "tracked.txt");
      expect(tracked).toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("liveExcludePatterns filters matching candidate paths before mirror construction", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      await writeFile(join(repo.repoRoot, "keep.txt"), "keep\n");
      await mkdir(join(repo.repoRoot, "vendor"), { recursive: true });
      await writeFile(join(repo.repoRoot, "vendor/skip.txt"), "skip\n");
      const { diff } = await getDiffSinceCheckpoint(repo.repoRoot, repo.checkpointDir, {
        liveExcludePatterns: ["vendor/**"],
      });
      expect(diff.entries.find((x) => x.path === "keep.txt")).toBeDefined();
      expect(diff.entries.find((x) => x.path.startsWith("vendor/"))).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it("entries are sorted deterministically by path ASC", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      await writeFile(join(repo.repoRoot, "zebra.txt"), "z\n");
      await writeFile(join(repo.repoRoot, "alpha.txt"), "a\n");
      await writeFile(join(repo.repoRoot, "mango.txt"), "m\n");
      const { diff } = await getDiffSinceCheckpoint(repo.repoRoot, repo.checkpointDir, {});
      const paths = diff.entries.map((e) => e.path);
      const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(paths).toEqual(sorted);
    } finally {
      await repo.cleanup();
    }
  });

  it("scratch worktree + tempRoot cleaned up after successful run", async () => {
    const repo = await setupRepoWithCheckpoint();
    try {
      await writeFile(join(repo.repoRoot, "edit.txt"), "edit\n");
      const before = await listInternalTempDirs();
      await getDiffSinceCheckpoint(repo.repoRoot, repo.checkpointDir, {});
      const after = await listInternalTempDirs();
      const newOnes = after.filter((d) => !before.includes(d));
      expect(newOnes).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("loadCheckpoint failure does not allocate internal temp resources", async () => {
    // Point at a non-existent checkpoint dir → loadCheckpoint throws BEFORE
    // mkdtemp runs. Cleanup is a no-op (tempRoot=null, worktreeAdded=false).
    // Validates that early-exit failure paths don't leak temp resources.
    const repo = await setupRepo();
    try {
      const before = await listInternalTempDirs();
      await expect(
        getDiffSinceCheckpoint(repo.repoRoot, "/nonexistent/checkpoint", {}),
      ).rejects.toThrow();
      const after = await listInternalTempDirs();
      const newOnes = after.filter((d) => !before.includes(d));
      expect(newOnes).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it(".viberevert/ candidate path THROWS DiffParseError (misconfiguration signal)", async () => {
    // Use the standard helper so the checkpoint is created VALIDLY (with
    // .viberevert/ properly gitignored and the checkpoint dir outside the
    // repo). AFTER the checkpoint exists, defeat the .gitignore in the LIVE
    // repo only and seed a .viberevert/leak.txt file. Live candidate
    // enumeration via ls-files --others --exclude-standard now surfaces
    // .viberevert/leak.txt → assertSafeRepoRelativePath fail-closed throws.
    const repo = await setupRepoWithCheckpoint();
    try {
      await writeFile(join(repo.repoRoot, ".gitignore"), "");
      await mkdir(join(repo.repoRoot, ".viberevert"), { recursive: true });
      await writeFile(join(repo.repoRoot, ".viberevert", "leak.txt"), "leak\n");
      await expect(getDiffSinceCheckpoint(repo.repoRoot, repo.checkpointDir, {})).rejects.toThrow(
        DiffParseError,
      );
    } finally {
      await repo.cleanup();
    }
  });
});
