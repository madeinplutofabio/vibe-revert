// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// exclusion-basis.ts targeted tests.
//
// The fingerprint exists so a transaction can prove the ignore rules held still
// across a verification command, so most tests are written as pairs: capture,
// perturb one input, capture again, assert the comparison moves. Inspecting a
// single capture would not exercise the property the module is for.
//
// `setupRepo` NEUTRALIZES the inherited exclusion basis: it pins an empty
// `core.excludesFile` and an empty `info/exclude` locally, so no developer's
// global ignore rule can change the candidate population under test. Tests that
// care about `core.excludesFile` set it explicitly, overriding that default.
//
// Cases requiring the frozen `GIT_ENV` to hold specific values (unset-versus-
// default resolution, XDG anchoring, HOME precedence, live `process.env`
// isolation) cannot be driven from here, because the runner snapshots the
// environment at module load. They live in exclusion-basis-environment.test.ts,
// which spawns a fresh process per case.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  captureExclusionBasis,
  type ExclusionBasisFingerprint,
  exclusionBasisChanged,
} from "../src/exclusion-basis.js";

const execFileAsync = promisify(execFile);

/** SHA-256 of zero bytes. Pinned so "absent" and "empty" cannot be confused. */
const EMPTY_FILE_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Fixtures shell out to git directly rather than through the package's own
 * runner, so a regression in the module under test cannot also corrupt the
 * fixture meant to detect it.
 */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], { cwd, windowsHide: true });
  return String(stdout);
}

/**
 * `git`, tolerating ONLY the listed exit codes.
 *
 * Blanket failure tolerance would be unsound in these fixtures: a fatal git
 * error would become an empty string and could then "prove" that no path was
 * ignored. Every caller states the exit code that is a meaningful answer for
 * the command it runs (1 for `check-ignore` matching nothing, 5 for
 * `config --unset` on an absent key).
 */
async function gitAllowingExit(
  cwd: string,
  args: readonly string[],
  allowed: readonly number[],
): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (err) {
    const failure = err as { code?: unknown; stdout?: unknown };
    if (typeof failure.code === "number" && allowed.includes(failure.code)) {
      return String(failure.stdout ?? "");
    }
    throw err;
  }
}

interface TestRepo {
  readonly repoRoot: string;
  cleanup: () => Promise<void>;
}

async function write(repoRoot: string, relative: string, body: string): Promise<void> {
  const absolute = join(repoRoot, ...relative.split("/"));
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, body);
}

async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-exclbasis-"));
  const repoRoot = join(tmp, "repo");
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await git(repoRoot, ["config", "core.autocrlf", "false"]);
  // Neutralize inherited exclusion sources. An empty core.excludesFile disables
  // git's default global ignore file entirely, and an empty info/exclude
  // replaces whatever the init template supplied.
  await git(repoRoot, ["config", "core.excludesFile", ""]);
  await write(repoRoot, ".git/info/exclude", "");
  return {
    repoRoot,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/** Commit a tracked root `.gitignore` holding `rules`. */
async function commitRootIgnore(repoRoot: string, rules: string): Promise<void> {
  await write(repoRoot, ".gitignore", rules);
  await git(repoRoot, ["add", ".gitignore"]);
  await git(repoRoot, ["commit", "-m", "ignore rules"]);
}

async function untrackedIgnorePaths(repoRoot: string): Promise<readonly string[]> {
  const basis = await captureExclusionBasis(repoRoot);
  return basis.untrackedIgnoreFiles.map((entry) => entry.path);
}

// =============================================================================
// Population: which untracked .gitignore files are part of the basis
// =============================================================================

describe("captureExclusionBasis untracked .gitignore population", () => {
  it("includes visible, self-ignored and deeply nested candidates, excludes tracked ones", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "secret/\nnested/.gitignore\n");
      await write(repo.repoRoot, "visible/.gitignore", "a\n");
      await write(repo.repoRoot, "deep/a/b/.gitignore", "c\n");
      // Give the self-ignored file a REAL rule and a path it governs, so the
      // test proves git applies it rather than merely listing it.
      await write(repo.repoRoot, "nested/.gitignore", "owned.tmp\n");
      await write(repo.repoRoot, "nested/owned.tmp", "x\n");

      const paths = await untrackedIgnorePaths(repo.repoRoot);
      const applied = await gitAllowingExit(
        repo.repoRoot,
        ["check-ignore", "-v", "--", "nested/owned.tmp"],
        [1],
      );

      // The semantic reason it belongs in the basis: git READS it, even though
      // the file is itself ignored and therefore absent from `S`.
      expect(applied).toContain("nested/.gitignore");
      expect(paths).toContain("nested/.gitignore");
      // Enumerated although not ignored at all: `rollback.exclude` can drop a
      // visible untracked path from `S`, which is why the population is
      // "untracked", not "ignored".
      expect(paths).toContain("visible/.gitignore");
      expect(paths).toContain("deep/a/b/.gitignore");
      // TRACKED, so `S` covers it unconditionally; enumerating it here would
      // duplicate coverage `S` already supplies.
      expect(paths).not.toContain(".gitignore");
    } finally {
      await repo.cleanup();
    }
  });

  it("excludes a .gitignore whose parent directory is ignored, at any depth", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "secret/\n");
      await write(repo.repoRoot, "secret/.gitignore", "x\n");
      await write(repo.repoRoot, "secret/inner/.gitignore", "y\n");
      await write(repo.repoRoot, "visible/.gitignore", "z\n");

      const paths = await untrackedIgnorePaths(repo.repoRoot);

      // An excluded parent is terminal for untracked discovery, so rules inside
      // it have no effect. `secret/inner` is ignored through the ancestor rule
      // alone, which the immediate-parent query already accounts for.
      expect(paths).toEqual(["visible/.gitignore"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("still excludes it when the ignored parent also contains a tracked file", async () => {
    const repo = await setupRepo();
    try {
      // Causal order: the rule exists first, so `-f` is genuinely required to
      // track a file beneath it.
      await commitRootIgnore(repo.repoRoot, "secret/\n");
      await write(repo.repoRoot, "secret/tracked.txt", "kept\n");
      await git(repo.repoRoot, ["add", "-f", "secret/tracked.txt"]);
      await git(repo.repoRoot, ["commit", "-m", "tracked file inside ignored directory"]);
      await write(repo.repoRoot, "secret/.gitignore", "x\n");

      const paths = await untrackedIgnorePaths(repo.repoRoot);

      // Git knows the tracked file from the index, not by traversing, so the
      // directory's untracked contents stay unenumerated and its `.gitignore`
      // stays inapplicable.
      expect(paths).not.toContain("secret/.gitignore");
    } finally {
      await repo.cleanup();
    }
  });

  it("orders candidates deterministically and reports no change across two captures", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "# none\n");
      await write(repo.repoRoot, "c/.gitignore", "1\n");
      await write(repo.repoRoot, "a/.gitignore", "2\n");
      await write(repo.repoRoot, "b/deep/.gitignore", "3\n");

      const first = await captureExclusionBasis(repo.repoRoot);
      const second = await captureExclusionBasis(repo.repoRoot);

      expect(first.untrackedIgnoreFiles.map((entry) => entry.path)).toEqual([
        "a/.gitignore",
        "b/deep/.gitignore",
        "c/.gitignore",
      ]);
      expect(exclusionBasisChanged(first, second)).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("detects a content change in an applicable untracked .gitignore", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "nested/.gitignore\n");
      await write(repo.repoRoot, "nested/.gitignore", "before\n");
      const before = await captureExclusionBasis(repo.repoRoot);

      await write(repo.repoRoot, "nested/.gitignore", "after\n");
      const after = await captureExclusionBasis(repo.repoRoot);

      expect(exclusionBasisChanged(before, after)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")(
    "excludes a symlinked .gitignore, and membership changes when it becomes a regular file",
    async () => {
      const repo = await setupRepo();
      try {
        await commitRootIgnore(repo.repoRoot, "# none\n");
        await write(repo.repoRoot, "realrules", "owned.tmp\n");
        await write(repo.repoRoot, "sym/owned.tmp", "x\n");
        await symlink("../realrules", join(repo.repoRoot, "sym", ".gitignore"));

        const linked = await captureExclusionBasis(repo.repoRoot);
        const applied = await gitAllowingExit(
          repo.repoRoot,
          ["check-ignore", "-v", "--", "sym/owned.tmp"],
          [1],
        );

        // Git does not read an in-tree `.gitignore` through a symlink, so the
        // rule must not apply AND the file must not enter the basis. Hashing it
        // would record rules git never uses.
        expect(applied).toBe("");
        expect(linked.untrackedIgnoreFiles.map((entry) => entry.path)).not.toContain(
          "sym/.gitignore",
        );

        // Replacing the link with a regular file makes it a live rule source.
        // Membership itself is the signal.
        await rm(join(repo.repoRoot, "sym", ".gitignore"));
        await write(repo.repoRoot, "sym/.gitignore", "owned.tmp\n");
        const regular = await captureExclusionBasis(repo.repoRoot);

        expect(regular.untrackedIgnoreFiles.map((entry) => entry.path)).toContain("sym/.gitignore");
        expect(exclusionBasisChanged(linked, regular)).toBe(true);
      } finally {
        await repo.cleanup();
      }
    },
  );
});

// =============================================================================
// info/exclude, including the linked-worktree common directory
// =============================================================================

describe("captureExclusionBasis info/exclude", () => {
  it("detects a content change", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "# none\n");
      const before = await captureExclusionBasis(repo.repoRoot);

      await write(repo.repoRoot, ".git/info/exclude", "*.tmp\n");
      const after = await captureExclusionBasis(repo.repoRoot);

      expect(before.infoExclude?.path).toBe(resolve(repo.repoRoot, ".git", "info", "exclude"));
      expect(exclusionBasisChanged(before, after)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("represents a missing file distinctly from an empty one", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "# none\n");
      await rm(join(repo.repoRoot, ".git", "info", "exclude"), { force: true });
      const missing = await captureExclusionBasis(repo.repoRoot);

      await write(repo.repoRoot, ".git/info/exclude", "");
      const empty = await captureExclusionBasis(repo.repoRoot);

      // The two states impose the SAME rules. Keeping them apart detects
      // creation or deletion of the control-plane file itself; it is not what
      // catches losing populated content, which differs from both values.
      expect(missing.infoExclude?.sha256).toBeNull();
      expect(empty.infoExclude?.sha256).toBe(EMPTY_FILE_SHA256);
      expect(exclusionBasisChanged(missing, empty)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("resolves the COMMON info/exclude from inside a linked worktree", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "# none\n");
      await git(repo.repoRoot, ["worktree", "add", "../wt", "-b", "wt"]);
      const worktree = resolve(repo.repoRoot, "..", "wt");
      const expected = resolve(repo.repoRoot, ".git", "info", "exclude");

      const before = await captureExclusionBasis(worktree);
      // Modify the MAIN repository's info/exclude. In a linked worktree `.git`
      // is a file and this path is only reachable through the common directory.
      await write(repo.repoRoot, ".git/info/exclude", "*.tmp\n");
      const after = await captureExclusionBasis(worktree);

      // Pins the production docblock's `$GIT_COMMON_DIR` claim directly: the
      // path resolves to the main repository's file, and editing that file is
      // what the linked worktree observes.
      expect(before.infoExclude?.path).toBe(expected);
      expect(after.infoExclude?.path).toBe(expected);
      expect(before.infoExclude?.sha256).not.toBe(after.infoExclude?.sha256);
      expect(exclusionBasisChanged(before, after)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// core.excludesFile
// =============================================================================

describe("captureExclusionBasis core.excludesFile", () => {
  it("resolves a relative value against the repository root, naming the file git uses", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "# none\n");
      await write(repo.repoRoot, "rel-ex.txt", "hidden.txt\n");
      await write(repo.repoRoot, "hidden.txt", "x\n");
      await git(repo.repoRoot, ["config", "core.excludesFile", "rel-ex.txt"]);

      const basis = await captureExclusionBasis(repo.repoRoot);
      const others = await git(repo.repoRoot, ["ls-files", "--others", "--exclude-standard"]);

      // Both halves matter: the fingerprint names repoRoot/rel-ex.txt, and that
      // is demonstrably the file whose rules git applied. `--path` returns the
      // value verbatim without absolutizing, so this pins the resolution base.
      expect(basis.globalExcludes?.source).toBe("configured");
      expect(basis.globalExcludes?.path).toBe(resolve(repo.repoRoot, "rel-ex.txt"));
      expect(others).not.toContain("hidden.txt");
    } finally {
      await repo.cleanup();
    }
  });

  it("detects a path change even when the two files have identical contents", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "# none\n");
      await write(repo.repoRoot, "ex-a.txt", "*.log\n");
      await write(repo.repoRoot, "ex-b.txt", "*.log\n");

      await git(repo.repoRoot, ["config", "core.excludesFile", "ex-a.txt"]);
      const before = await captureExclusionBasis(repo.repoRoot);
      await git(repo.repoRoot, ["config", "core.excludesFile", "ex-b.txt"]);
      const after = await captureExclusionBasis(repo.repoRoot);

      expect(before.globalExcludes?.sha256).toBe(after.globalExcludes?.sha256);
      expect(exclusionBasisChanged(before, after)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("detects a content change at a stable path", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "# none\n");
      await write(repo.repoRoot, "ex.txt", "*.log\n");
      await git(repo.repoRoot, ["config", "core.excludesFile", "ex.txt"]);
      const before = await captureExclusionBasis(repo.repoRoot);

      await write(repo.repoRoot, "ex.txt", "*.log\n*.tmp\n");
      const after = await captureExclusionBasis(repo.repoRoot);

      expect(before.globalExcludes?.path).toBe(after.globalExcludes?.path);
      expect(exclusionBasisChanged(before, after)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("treats an explicitly empty value as no global source", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "# none\n");
      await write(repo.repoRoot, "ex.txt", "*.log\n");
      await git(repo.repoRoot, ["config", "core.excludesFile", "ex.txt"]);
      const configured = await captureExclusionBasis(repo.repoRoot);

      await git(repo.repoRoot, ["config", "core.excludesFile", ""]);
      const emptied = await captureExclusionBasis(repo.repoRoot);

      // An empty value disables git's default excludes file entirely, which is
      // NOT the same as the key being unset. That distinction is proven against
      // git's own behavior in the environment suite, which can control it.
      expect(configured.globalExcludes).not.toBeNull();
      expect(emptied.globalExcludes).toBeNull();
      expect(exclusionBasisChanged(configured, emptied)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Evaluation configuration
// =============================================================================

describe("captureExclusionBasis evaluation configuration", () => {
  it("records core.ignoreCase, which changes git's verdict for identical rule bytes", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "BUILD.LOG\n");
      await write(repo.repoRoot, "build.log", "x\n");

      await git(repo.repoRoot, ["config", "core.ignoreCase", "false"]);
      const sensitive = await captureExclusionBasis(repo.repoRoot);
      const listedWhenSensitive = await git(repo.repoRoot, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        "build.log",
      ]);

      await git(repo.repoRoot, ["config", "core.ignoreCase", "true"]);
      const folded = await captureExclusionBasis(repo.repoRoot);
      const listedWhenFolded = await git(repo.repoRoot, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        "build.log",
      ]);

      // The justification for the field: same rule file, opposite verdict. The
      // setting lives in `.git/config`, outside `S`, so nothing else would see
      // a command toggling it.
      expect(listedWhenSensitive).toContain("build.log");
      expect(listedWhenFolded).toBe("");
      expect(sensitive.ignoreCase).toBe(false);
      expect(folded.ignoreCase).toBe(true);
      expect(exclusionBasisChanged(sensitive, folded)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("records core.precomposeUnicode conservatively", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "# none\n");
      await git(repo.repoRoot, ["config", "core.precomposeUnicode", "false"]);
      const before = await captureExclusionBasis(repo.repoRoot);

      await git(repo.repoRoot, ["config", "core.precomposeUnicode", "true"]);
      const after = await captureExclusionBasis(repo.repoRoot);

      // No claim that this alters ignore evaluation. It alters how git
      // interprets paths on macOS, which is reason enough to refuse to compare
      // across a change in it. macOS CI still owes the characterization.
      expect(before.precomposeUnicode).toBe(false);
      expect(after.precomposeUnicode).toBe(true);
      expect(exclusionBasisChanged(before, after)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it("normalizes both unset booleans to false", async () => {
    const repo = await setupRepo();
    try {
      await commitRootIgnore(repo.repoRoot, "# none\n");
      // `git init` writes core.ignorecase explicitly on case-insensitive
      // filesystems, so unsetting is a real operation here, not a no-op. Exit 5
      // is git's "key was already absent", the only tolerated failure.
      await gitAllowingExit(repo.repoRoot, ["config", "--unset", "core.ignoreCase"], [5]);
      await gitAllowingExit(repo.repoRoot, ["config", "--unset", "core.precomposeUnicode"], [5]);

      const basis = await captureExclusionBasis(repo.repoRoot);

      expect(basis.ignoreCase).toBe(false);
      expect(basis.precomposeUnicode).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Comparator table: pure, constructed fingerprints
//
// Integration fixtures prove the fields that happen to be exercised. This table
// proves EVERY field participates, so a comparison that silently stopped
// consulting one of them fails here rather than passing everywhere else.
// =============================================================================

const BASE: ExclusionBasisFingerprint = {
  infoExclude: { path: "/repo/.git/info/exclude", sha256: "a".repeat(64) },
  globalExcludes: { source: "configured", path: "/repo/ex", sha256: "b".repeat(64) },
  untrackedIgnoreFiles: [
    { path: "a/.gitignore", sha256: "c".repeat(64) },
    { path: "b/.gitignore", sha256: "d".repeat(64) },
  ],
  ignoreCase: false,
  precomposeUnicode: false,
};

function withBase(patch: Partial<ExclusionBasisFingerprint>): ExclusionBasisFingerprint {
  return { ...BASE, ...patch };
}

describe("exclusionBasisChanged field coverage", () => {
  it("reports no change for an identical fingerprint", () => {
    expect(exclusionBasisChanged(BASE, withBase({}))).toBe(false);
  });

  const changes: readonly (readonly [string, ExclusionBasisFingerprint])[] = [
    ["infoExclude becomes null", withBase({ infoExclude: null })],
    [
      "infoExclude.path",
      withBase({ infoExclude: { path: "/other/.git/info/exclude", sha256: "a".repeat(64) } }),
    ],
    [
      "infoExclude.sha256",
      withBase({ infoExclude: { path: "/repo/.git/info/exclude", sha256: "e".repeat(64) } }),
    ],
    ["globalExcludes becomes null", withBase({ globalExcludes: null })],
    [
      "globalExcludes.source",
      withBase({ globalExcludes: { source: "default", path: "/repo/ex", sha256: "b".repeat(64) } }),
    ],
    [
      "globalExcludes.path",
      withBase({
        globalExcludes: { source: "configured", path: "/repo/other", sha256: "b".repeat(64) },
      }),
    ],
    [
      "globalExcludes.sha256",
      withBase({
        globalExcludes: { source: "configured", path: "/repo/ex", sha256: "f".repeat(64) },
      }),
    ],
    ["ignoreCase", withBase({ ignoreCase: true })],
    ["precomposeUnicode", withBase({ precomposeUnicode: true })],
    [
      "an untracked .gitignore added",
      withBase({
        untrackedIgnoreFiles: [
          ...BASE.untrackedIgnoreFiles,
          { path: "c/.gitignore", sha256: "0".repeat(64) },
        ],
      }),
    ],
    [
      "an untracked .gitignore removed",
      withBase({ untrackedIgnoreFiles: [{ path: "a/.gitignore", sha256: "c".repeat(64) }] }),
    ],
    [
      "an untracked .gitignore renamed with identical content",
      withBase({
        untrackedIgnoreFiles: [
          { path: "a/.gitignore", sha256: "c".repeat(64) },
          { path: "z/.gitignore", sha256: "d".repeat(64) },
        ],
      }),
    ],
    [
      "an untracked .gitignore content change",
      withBase({
        untrackedIgnoreFiles: [
          { path: "a/.gitignore", sha256: "c".repeat(64) },
          { path: "b/.gitignore", sha256: "9".repeat(64) },
        ],
      }),
    ],
    [
      "the same set in a different order",
      withBase({
        untrackedIgnoreFiles: [
          { path: "b/.gitignore", sha256: "d".repeat(64) },
          { path: "a/.gitignore", sha256: "c".repeat(64) },
        ],
      }),
    ],
  ];

  for (const [label, changed] of changes) {
    it(`reports a change for ${label}`, () => {
      expect(exclusionBasisChanged(BASE, changed)).toBe(true);
      // Symmetric: argument order must not decide the verdict.
      expect(exclusionBasisChanged(changed, BASE)).toBe(true);
    });
  }
});
