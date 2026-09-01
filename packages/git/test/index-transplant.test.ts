// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for the index transplant primitive (M 0.8.0 step 10D, §15).
//
// Seven sections:
//   A. installs and removals        (1-5)
//   B. the worktree stays untouched (6-7)
//   C. refusals                     (8-13)
//   D. argument handling            (14-15)
//   E. mutation path policy         (16-17)
//   F. snapshot authority           (18)
//   G. structural invariants        (19-20)
//
// A real git repository is required here, unlike the worktree materializers:
// `update-index` is a real git invocation and the result is only meaningful when
// read back out of a real index. Verification goes through `readIndexSnapshot`,
// the same observer the rest of the slice uses.
//
// The oracle is a HAND-BUILT `IndexSnapshot`. That is not a shortcut: the
// supplied snapshot is the module's only oracle input by contract, so
// constructing it directly is exactly what a caller does, and it lets case 18
// prove the snapshot outranks the live index.

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { IndexState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";
import { transplantIndexPath } from "../src/index-transplant.js";
import { type IndexSnapshot, readIndexSnapshot } from "../src/path-state.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// Fixtures
// =============================================================================

const ABSENT: IndexState = { kind: "absent" };

const entry = (mode: "100644" | "100755" | "120000" | "160000", oid: string): IndexState => ({
  kind: "entry",
  mode,
  oid,
});

const unmerged = (oid: string): IndexState => ({
  kind: "unmerged",
  entries: [{ stage: 2, mode: "100644", oid }],
});

const snapshotOf = (entries: ReadonlyArray<readonly [string, IndexState]>): IndexSnapshot => ({
  byPath: new Map(entries),
});

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
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-indexfixture-"));
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

const at = (repo: TestRepo, rel: string): string => join(repo.repoRoot, ...rel.split("/"));

async function write(repo: TestRepo, rel: string, content: string): Promise<void> {
  const abs = at(repo, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

/** A real blob in the repository's object database, without touching the index. */
async function blobOid(repo: TestRepo, rel: string, content: string): Promise<string> {
  await write(repo, rel, content);
  return (await gitOut(repo.repoRoot, ["hash-object", "-w", "--", rel])).trim();
}

const indexAt = async (repo: TestRepo, path: string): Promise<IndexState> =>
  (await readIndexSnapshot(repo.repoRoot)).byPath.get(path) ?? ABSENT;

async function exists(repo: TestRepo, rel: string): Promise<boolean> {
  try {
    await lstat(at(repo, rel));
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Section A: installs and removals
// =============================================================================

describe("transplantIndexPath: installs and removals", () => {
  it("1: installs a 100644 entry", async () => {
    const repo = await setupRepo();
    try {
      const oid = await blobOid(repo, "blob-source.txt", "content\n");
      const state = entry("100644", oid);

      await transplantIndexPath(repo.repoRoot, "a.txt", state, snapshotOf([["a.txt", state]]));
      expect(await indexAt(repo, "a.txt")).toEqual(state);
    } finally {
      await repo.cleanup();
    }
  });

  it("2: installs a 100755 entry, carrying the mode", async () => {
    const repo = await setupRepo();
    try {
      const oid = await blobOid(repo, "blob-source.txt", "#!/bin/sh\n");
      const state = entry("100755", oid);

      // Cross-platform: the executable bit lives in the index entry, not in a
      // filesystem mode, so this holds on Windows too.
      await transplantIndexPath(repo.repoRoot, "run.sh", state, snapshotOf([["run.sh", state]]));
      expect(await indexAt(repo, "run.sh")).toEqual(state);
    } finally {
      await repo.cleanup();
    }
  });

  it("3: installs a 120000 entry without creating any worktree node", async () => {
    const repo = await setupRepo();
    try {
      // A symlink's blob content is its target text. Installing it needs no OS
      // symlink at all, which is why `core.symlinks=false` never blocks the
      // index axis.
      const oid = await blobOid(repo, "blob-source.txt", "some/target");
      const state = entry("120000", oid);

      await transplantIndexPath(repo.repoRoot, "linkish", state, snapshotOf([["linkish", state]]));
      expect(await indexAt(repo, "linkish")).toEqual(state);
      expect(await exists(repo, "linkish")).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("4: absent removes an existing entry", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "doomed.txt", "staged\n");
      await git(repo.repoRoot, ["add", "doomed.txt"]);
      expect((await indexAt(repo, "doomed.txt")).kind).toBe("entry");

      await transplantIndexPath(repo.repoRoot, "doomed.txt", ABSENT, snapshotOf([]));
      expect(await indexAt(repo, "doomed.txt")).toEqual(ABSENT);
    } finally {
      await repo.cleanup();
    }
  });

  it("5: absent on an ALREADY-absent path succeeds as a no-op", async () => {
    const repo = await setupRepo();
    try {
      // Deliberately unlike `removeWorktreePath`, which refuses. This primitive
      // establishes an abstract state rather than destroying a concrete node, so
      // an index that already satisfies it needs nothing done.
      expect(await indexAt(repo, "never-staged.txt")).toEqual(ABSENT);

      await transplantIndexPath(repo.repoRoot, "never-staged.txt", ABSENT, snapshotOf([]));
      expect(await indexAt(repo, "never-staged.txt")).toEqual(ABSENT);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section B: the worktree stays untouched
// =============================================================================

describe("transplantIndexPath: worktree isolation", () => {
  it("6: installing an entry leaves the working-tree file untouched", async () => {
    const repo = await setupRepo();
    try {
      const oid = await blobOid(repo, "blob-source.txt", "the INDEX content\n");
      await write(repo, "a.txt", "the WORKTREE content\n");
      const state = entry("100644", oid);

      await transplantIndexPath(repo.repoRoot, "a.txt", state, snapshotOf([["a.txt", state]]));
      expect(await indexAt(repo, "a.txt")).toEqual(state);
      // The index now says one thing and the file says another, which is exactly
      // the staged-then-modified shape the two axes exist to represent.
      expect(await readFile(at(repo, "a.txt"), "utf8")).toBe("the WORKTREE content\n");
    } finally {
      await repo.cleanup();
    }
  });

  it("7: removing an entry leaves the working-tree file in place", async () => {
    const repo = await setupRepo();
    try {
      await write(repo, "kept.txt", "still on disk\n");
      await git(repo.repoRoot, ["add", "kept.txt"]);

      // `--force-remove`, not `--remove`: the file survives becoming untracked.
      await transplantIndexPath(repo.repoRoot, "kept.txt", ABSENT, snapshotOf([]));
      expect(await indexAt(repo, "kept.txt")).toEqual(ABSENT);
      expect(await readFile(at(repo, "kept.txt"), "utf8")).toBe("still on disk\n");
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section C: refusals
// =============================================================================

describe("transplantIndexPath: refusals", () => {
  it("8: an UNMERGED target refuses and leaves the index alone", async () => {
    const repo = await setupRepo();
    try {
      const oid = await blobOid(repo, "blob-source.txt", "content\n");
      const before = await indexAt(repo, "a.txt");

      await expect(
        transplantIndexPath(repo.repoRoot, "a.txt", unmerged(oid), snapshotOf([])),
      ).rejects.toThrow(/the target entry is unmerged/);
      expect(await indexAt(repo, "a.txt")).toEqual(before);
    } finally {
      await repo.cleanup();
    }
  });

  it("9: an UNMERGED oracle refuses and leaves the index alone", async () => {
    const repo = await setupRepo();
    try {
      const oid = await blobOid(repo, "blob-source.txt", "content\n");
      const before = await indexAt(repo, "a.txt");

      await expect(
        transplantIndexPath(
          repo.repoRoot,
          "a.txt",
          entry("100644", oid),
          snapshotOf([["a.txt", unmerged(oid)]]),
        ),
      ).rejects.toThrow(/the oracle entry is unmerged/);
      expect(await indexAt(repo, "a.txt")).toEqual(before);
    } finally {
      await repo.cleanup();
    }
  });

  it("10: a GITLINK target refuses", async () => {
    const repo = await setupRepo();
    try {
      const head = (await gitOut(repo.repoRoot, ["rev-parse", "HEAD"])).trim();
      const state = entry("160000", head);

      await expect(
        transplantIndexPath(repo.repoRoot, "sub", state, snapshotOf([["sub", state]])),
      ).rejects.toThrow(/the target entry is a gitlink/);
      expect(await indexAt(repo, "sub")).toEqual(ABSENT);
    } finally {
      await repo.cleanup();
    }
  });

  it("11: a GITLINK oracle refuses", async () => {
    const repo = await setupRepo();
    try {
      const head = (await gitOut(repo.repoRoot, ["rev-parse", "HEAD"])).trim();
      const oid = await blobOid(repo, "blob-source.txt", "content\n");

      // Shape is checked before agreement, so this reports the gitlink rather
      // than the (also true) disagreement between the two sides.
      await expect(
        transplantIndexPath(
          repo.repoRoot,
          "sub",
          entry("100644", oid),
          snapshotOf([["sub", entry("160000", head)]]),
        ),
      ).rejects.toThrow(/the oracle entry is a gitlink/);
      expect(await indexAt(repo, "sub")).toEqual(ABSENT);
    } finally {
      await repo.cleanup();
    }
  });

  it("12: an OID disagreement refuses", async () => {
    const repo = await setupRepo();
    try {
      const oidA = await blobOid(repo, "blob-a.txt", "A\n");
      const oidB = await blobOid(repo, "blob-b.txt", "B\n");

      await expect(
        transplantIndexPath(
          repo.repoRoot,
          "a.txt",
          entry("100644", oidA),
          snapshotOf([["a.txt", entry("100644", oidB)]]),
        ),
      ).rejects.toThrow(/does not match the state the contribution asserts/);
      expect(await indexAt(repo, "a.txt")).toEqual(ABSENT);
    } finally {
      await repo.cleanup();
    }
  });

  it("13: a MODE disagreement refuses", async () => {
    const repo = await setupRepo();
    try {
      const oid = await blobOid(repo, "blob-source.txt", "content\n");

      await expect(
        transplantIndexPath(
          repo.repoRoot,
          "a.txt",
          entry("100644", oid),
          snapshotOf([["a.txt", entry("100755", oid)]]),
        ),
      ).rejects.toThrow(/does not match the state the contribution asserts/);
      expect(await indexAt(repo, "a.txt")).toEqual(ABSENT);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section D: argument handling
// =============================================================================

describe("transplantIndexPath: git argument forms", () => {
  it("14: a LEADING-DASH path installs and then removes", async () => {
    const repo = await setupRepo();
    try {
      const oid = await blobOid(repo, "blob-source.txt", "content\n");
      const state = entry("100644", oid);
      const path = "-dash.txt";

      // `--cacheinfo` carries the path inside one argument, so the install side
      // needs no separator...
      await transplantIndexPath(repo.repoRoot, path, state, snapshotOf([[path, state]]));
      expect(await indexAt(repo, path)).toEqual(state);

      // ...while `--force-remove` would parse this as options without `--`.
      await transplantIndexPath(repo.repoRoot, path, ABSENT, snapshotOf([]));
      expect(await indexAt(repo, path)).toEqual(ABSENT);
    } finally {
      await repo.cleanup();
    }
  });

  it("15: a path with a leading dash AND embedded commas installs intact", async () => {
    const repo = await setupRepo();
    try {
      const oid = await blobOid(repo, "blob-source.txt", "content\n");
      const state = entry("100644", oid);
      // git splits `--cacheinfo` on the first two commas only, so everything
      // after the oid is the pathname however many commas it holds.
      const path = "-leading-comma,name.txt";

      await transplantIndexPath(repo.repoRoot, path, state, snapshotOf([[path, state]]));
      expect(await indexAt(repo, path)).toEqual(state);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section E: mutation path policy
// =============================================================================

describe("transplantIndexPath: mutation path policy", () => {
  it("16: the store and this repository root's .git are refused", async () => {
    const repo = await setupRepo();
    try {
      const oid = await blobOid(repo, "blob-source.txt", "content\n");
      const state = entry("100644", oid);

      await expect(
        transplantIndexPath(repo.repoRoot, ".viberevert/x", state, snapshotOf([])),
      ).rejects.toThrow(/^transplantIndexPath: path under \.viberevert\//);
      await expect(
        transplantIndexPath(repo.repoRoot, ".git/config", state, snapshotOf([])),
      ).rejects.toThrow(/^transplantIndexPath: path under Git control metadata/);
    } finally {
      await repo.cleanup();
    }
  });

  it("17: .gitignore is ordinary content, and a nested .git is not OUR refusal", async () => {
    const repo = await setupRepo();
    try {
      const oid = await blobOid(repo, "blob-source.txt", "node_modules/\n");
      const state = entry("100644", oid);

      // Root-anchored: `.gitignore` is content selective restore must write.
      await transplantIndexPath(
        repo.repoRoot,
        ".gitignore",
        state,
        snapshotOf([[".gitignore", state]]),
      );
      expect(await indexAt(repo, ".gitignore")).toEqual(state);

      // A nested `.git` component passes OUR mutation policy, which is
      // root-anchored by design. Git's own `verify_path` then refuses any index
      // entry containing a `.git` component, which is a different and stricter
      // rule we neither implement nor duplicate. The assertion is therefore
      // about WHOSE refusal it is, not about whether it is refused.
      const nested = transplantIndexPath(
        repo.repoRoot,
        "src/.git/user.txt",
        state,
        snapshotOf([["src/.git/user.txt", state]]),
      );
      await expect(nested).rejects.toThrow();
      await expect(nested).rejects.not.toThrow(/path under Git control metadata/);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section F: snapshot authority
// =============================================================================

describe("transplantIndexPath: snapshot authority", () => {
  it("18: the SUPPLIED snapshot drives the mutation, not the live index", async () => {
    const repo = await setupRepo();
    try {
      const live = await blobOid(repo, "blob-live.txt", "what the real index holds\n");
      const wanted = await blobOid(repo, "blob-wanted.txt", "what the oracle holds\n");

      // The real index says one thing...
      await write(repo, "a.txt", "on disk\n");
      await git(repo.repoRoot, ["update-index", "--add", "--cacheinfo", `100644,${live},a.txt`]);
      expect(await indexAt(repo, "a.txt")).toEqual(entry("100644", live));

      // ...and the supplied snapshot says another. The snapshot wins, because it
      // is the only oracle input this primitive consults.
      const state = entry("100644", wanted);
      await transplantIndexPath(repo.repoRoot, "a.txt", state, snapshotOf([["a.txt", state]]));
      expect(await indexAt(repo, "a.txt")).toEqual(state);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Section G: structural invariants
// =============================================================================
//
// Case 19 is the only way to prove the oracle-authority rule. Mutation runs only
// once `indexStateEqual(oracle, target)` holds, so by then the two carry
// identical mode and oid: ANY implementation that ended up installing the
// contribution's values would produce a byte-identical index and pass every
// runtime case above.
//
// So the whole provenance chain is pinned, not just its last link. Checking only
// the helper's scope would miss a swapped call-site argument; checking the call
// site too would still miss the two `requireTransplantable` calls being
// transposed, since that renames the provenance without changing the result.
//
//     oracleIndex -> observed -> oracleState -> applyOracleIndexState
//     target      -> targetState -> equality only

describe("structural invariants", () => {
  it("19: mutation provenance runs only from oracleIndex to oracleState", async () => {
    const source = await readFile(new URL("../src/index-transplant.ts", import.meta.url), "utf8");

    const start = source.indexOf("async function applyOracleIndexState(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);

    // Link 4: the mutation helper cannot see the contribution-side state at all,
    // so the git arguments cannot be built from it without widening the
    // signature.
    expect(body).not.toContain("target");

    // Link 1: `observed` comes from the supplied snapshot, and from nothing else.
    const observedAssignments = [
      ...source.matchAll(
        /const observed: IndexState = oracleIndex\.byPath\.get\(path\) \?\? \{ kind: "absent" \};/g,
      ),
    ];
    expect(observedAssignments).toHaveLength(1);

    // Links 2 and 3: the two validations are not transposed. Swapping them would
    // rename the provenance without changing any observable result.
    const targetAssignments = [
      ...source.matchAll(
        /const targetState = requireTransplantable\(target,\s*"target",\s*path\);/g,
      ),
    ];
    expect(targetAssignments).toHaveLength(1);

    const oracleAssignments = [
      ...source.matchAll(
        /const oracleState = requireTransplantable\(observed,\s*"oracle",\s*path\);/g,
      ),
    ];
    expect(oracleAssignments).toHaveLength(1);

    // Link 5: the single production invocation receives the validated ORACLE
    // state.
    const calls = [
      ...source.matchAll(
        /applyOracleIndexState\(\s*repoRoot,\s*path,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g,
      ),
    ];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe("oracleState");
  });

  it("20: no barrel export, and exactly one approved production caller", async () => {
    const srcDir = new URL("../src/", import.meta.url);

    // 10F evolved this invariant from "no production caller" to "exactly one".
    // The scheduler imports this module during PREPARATION for
    // `requireTransplantable`, but reaches the mutation primitive only from its
    // post-marker execution path.
    const APPROVED_CALLER = "transplant-schedule.ts";

    const barrel = await readFile(new URL("index.ts", srcDir), "utf8");
    expect(barrel).not.toContain("index-transplant");

    const approved = await readFile(new URL(APPROVED_CALLER, srcDir), "utf8");

    // Specific to `transplantIndexPath`, NOT to the module. A module-level
    // assertion would stay green if the mutation call were removed while the
    // pre-marker `requireTransplantable` import remained, which is exactly the
    // shape this scheduler has.
    expect(approved).toMatch(
      /import\s*\{[^}]*\btransplantIndexPath\b[^}]*\}\s*from\s*["']\.\/index-transplant\.js["']/s,
    );
    expect(approved).toMatch(/\btransplantIndexPath\s*\(/);

    const names = (await readdir(srcDir)).filter(
      (name) => name.endsWith(".ts") && name !== "index-transplant.ts" && name !== APPROVED_CALLER,
    );
    expect(names.length).toBeGreaterThan(0);

    // Matched as an IMPORT, not as text, so prose naming the module cannot trip
    // it.
    for (const name of names) {
      const source = await readFile(new URL(name, srcDir), "utf8");
      expect(source, `${name} imports the internal-only index transplant`).not.toMatch(
        /from\s*["']\.\/index-transplant\.js["']/,
      );
    }
  });
});
