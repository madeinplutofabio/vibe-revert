// packages/git/test/git-cli.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// git-cli.ts — A.6 targeted tests for getCommitTimestamp, plus D.1.pre
// direct tests for resolveCommitRef (the single source of truth for
// ref-to-SHA resolution that getCommitTimestamp delegates to) AND for
// the CommitRefNotFoundError class (the typed error both helpers raise).
//
// getCommitTimestamp covers:
//   - second-precision ISO 8601 output (matches `toIsoSecondString`'s
//     contract: no sub-second component, `Z` offset);
//   - determinism under fixed GIT_AUTHOR_DATE / GIT_COMMITTER_DATE env
//     vars (smoke check for the D49 fixture-determinism guarantee);
//   - non-UTC timezone is normalized to UTC in the output;
//   - invalid SHA → throws cleanly;
//   - commit-peel defense: tree/blob SHA → throws; annotated-tag SHA
//     peels to its commit and succeeds;
//   - option-injection defense (`--end-of-options`): ref starting with
//     `-` is treated as a literal ref, not a git option flag.
//
// resolveCommitRef covers (D.1.pre) — direct tests of the helper that
// getCommitTimestamp now delegates to. Adds typed-error class
// assertions, SHA-equality checks (not just timestamp-inferred), and
// lightweight-tag coverage that getCommitTimestamp tests did not have:
//   - happy paths: canonical SHA pass-through (peel is no-op on a real
//     commit SHA); HEAD resolution cross-checked against `git rev-parse
//     HEAD` (HEAD is a symbolic ref, NOT a branch name — distinct git
//     internals from branch-name resolution, both worth covering);
//     branch-name resolution using the `main` branch created by the
//     test repo's `git init -b main`; annotated-tag peel-to-commit
//     (proves the tag's own SHA differs from the commit's);
//     lightweight-tag resolution;
//   - typed-error contract: CommitRefNotFoundError instances thrown
//     (not bare Error), with the original `ref` preserved on the
//     error object via `error.ref`;
//   - commit-peel defense at the resolveCommitRef boundary: tree SHA
//     and blob SHA reject as CommitRefNotFoundError;
//   - non-existent ref rejects as CommitRefNotFoundError;
//   - option-injection defense: ref starting with `-` rejects as
//     CommitRefNotFoundError (proves `--end-of-options` works at the
//     resolveCommitRef boundary, not just downstream).
//
// CommitRefNotFoundError covers (D.1.pre) — unit test of the error
// class itself, independent of resolveCommitRef:
//   - diagnostic-safety: the message uses JSON.stringify(ref) (not
//     bare `${ref}` interpolation) so newlines, terminal escape
//     sequences, and text that mimics another git error fragment in
//     a user-controlled --since ref cannot corrupt the diagnostic
//     line. Test constructs the error directly with a newline-bearing
//     ref and asserts the message is single-line AND JSON-quoted.
//     This locks the hardening that diff.ts's DiffRefNotFoundError
//     also adopts — the symmetric DiffRefNotFoundError test lives
//     in diff.test.ts.
//
// Step 4a additions (parser refactor + raw-bytes helper):
//   - parseStatusPorcelainZ: pure parser direct tests covering empty
//     buffer, single/multiple entries, rename/copy two-path follower
//     correctness (R and C in either X or Y position), and the locked
//     fails-closed errors (malformed entry — too short, missing
//     separator, missing follower).
//   - getStatusPorcelainZRaw: live z-format bytes for after-status.z
//     persistence; empty on clean tree, exact byte equality on dirty
//     tree, round-trip parity through parseStatusPorcelainZ.
//   - getStatusPorcelainZ: live wrapper parity — wrapper(repoRoot)
//     equals parseStatusPorcelainZ(await getStatusPorcelainZRaw())
//     for the same tree state. Locks that the refactor introduced no
//     observable change at the public surface.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  CommitRefNotFoundError,
  getCommitTimestamp,
  getStatusPorcelainZ,
  getStatusPorcelainZRaw,
  parseStatusPorcelainZ,
  resolveCommitRef,
} from "../src/git-cli.js";

// =============================================================================
// Test helpers
// =============================================================================

const execFileAsync = promisify(execFile);

async function runGit(
  cwd: string,
  args: readonly string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  const { stdout } = await execFileAsync("git", args as string[], {
    cwd,
    windowsHide: true,
    env,
  });
  // Defense against future toolchain widening of stdout to string | Buffer.
  // String(buf) calls Buffer.prototype.toString() (utf8 by default), same as
  // an explicit `.toString("utf8")` would. Type-safe under both narrow
  // (current) and wide (hypothetical future) stdout typings — avoids the
  // unreachable `never` branch that a typeof guard would produce now.
  return String(stdout);
}

interface TestRepo {
  readonly repoRoot: string;
  cleanup: () => Promise<void>;
}

async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-gitclitest-"));
  const repoRoot = join(tmp, "repo");
  await mkdir(repoRoot, { recursive: true });
  await runGit(repoRoot, ["init", "-b", "main"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test User"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
  await runGit(repoRoot, ["config", "core.autocrlf", "false"]);
  // Force `git status --porcelain=v1 -z` to enumerate untracked files. Some
  // user/system configs set `status.showUntrackedFiles=no` (e.g., to speed
  // up status on huge repos); without this repo-local override, the live
  // raw + wrapper tests below would get an empty buffer and assert
  // wrong-tree shape for environmental reasons.
  await runGit(repoRoot, ["config", "status.showUntrackedFiles", "all"]);
  return {
    repoRoot,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Commit `README.md` with content `body` using `committerDate` as BOTH the
 * author and committer date (ISO 8601 offset form, e.g.
 * "2026-01-01T00:00:00+00:00"). Returns the new commit's SHA.
 */
async function commitWithFixedDate(
  repoRoot: string,
  body: string,
  committerDate: string,
): Promise<string> {
  await writeFile(join(repoRoot, "README.md"), body);
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "fixed-date commit"], {
    env: {
      GIT_AUTHOR_DATE: committerDate,
      GIT_COMMITTER_DATE: committerDate,
    },
  });
  return (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
}

// =============================================================================
// Tests
// =============================================================================

describe("getCommitTimestamp", () => {
  describe("ISO second-precision output", () => {
    it("returns the committer date in ISO seconds form (Z offset)", async () => {
      const repo = await setupRepo();
      try {
        const sha = await commitWithFixedDate(
          repo.repoRoot,
          "# test\n",
          "2026-01-01T00:00:00+00:00",
        );
        const ts = await getCommitTimestamp(repo.repoRoot, sha);
        expect(ts).toBe("2026-01-01T00:00:00Z");
      } finally {
        await repo.cleanup();
      }
    });

    it("output matches the strict seconds-precision Z-offset regex (no sub-second component)", async () => {
      const repo = await setupRepo();
      try {
        const sha = await commitWithFixedDate(
          repo.repoRoot,
          "# test\n",
          "2026-05-21T14:30:45+00:00",
        );
        const ts = await getCommitTimestamp(repo.repoRoot, sha);
        expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      } finally {
        await repo.cleanup();
      }
    });

    it("is deterministic — two calls against the same SHA return identical strings", async () => {
      const repo = await setupRepo();
      try {
        const sha = await commitWithFixedDate(
          repo.repoRoot,
          "# test\n",
          "2026-01-01T00:00:00+00:00",
        );
        const a = await getCommitTimestamp(repo.repoRoot, sha);
        const b = await getCommitTimestamp(repo.repoRoot, sha);
        expect(a).toBe(b);
      } finally {
        await repo.cleanup();
      }
    });

    it("normalizes a non-UTC commit timezone to UTC in the output", async () => {
      const repo = await setupRepo();
      try {
        // 14:30:45 in +05:30 = 09:00:45 UTC.
        const sha = await commitWithFixedDate(
          repo.repoRoot,
          "# test\n",
          "2026-06-15T14:30:45+05:30",
        );
        const ts = await getCommitTimestamp(repo.repoRoot, sha);
        expect(ts).toBe("2026-06-15T09:00:45Z");
      } finally {
        await repo.cleanup();
      }
    });
  });

  describe("error paths", () => {
    it("rejects an invalid SHA cleanly", async () => {
      const repo = await setupRepo();
      try {
        await commitWithFixedDate(repo.repoRoot, "# test\n", "2026-01-01T00:00:00+00:00");
        await expect(
          getCommitTimestamp(repo.repoRoot, "0000000000000000000000000000000000000000"),
        ).rejects.toThrow();
      } finally {
        await repo.cleanup();
      }
    });

    it("commit-peel defense: tree SHA rejects (^{commit} fails on a tree)", async () => {
      const repo = await setupRepo();
      try {
        await commitWithFixedDate(repo.repoRoot, "# test\n", "2026-01-01T00:00:00+00:00");
        const treeSha = (await runGit(repo.repoRoot, ["rev-parse", "HEAD^{tree}"])).trim();
        await expect(getCommitTimestamp(repo.repoRoot, treeSha)).rejects.toThrow();
      } finally {
        await repo.cleanup();
      }
    });

    it("commit-peel defense: blob SHA rejects (^{commit} fails on a blob)", async () => {
      const repo = await setupRepo();
      try {
        await commitWithFixedDate(repo.repoRoot, "# test\n", "2026-01-01T00:00:00+00:00");
        const blobSha = (await runGit(repo.repoRoot, ["rev-parse", "HEAD:README.md"])).trim();
        await expect(getCommitTimestamp(repo.repoRoot, blobSha)).rejects.toThrow();
      } finally {
        await repo.cleanup();
      }
    });

    it("option-injection defense: ref starting with `-` is treated as a literal ref, not a flag", async () => {
      const repo = await setupRepo();
      try {
        await commitWithFixedDate(repo.repoRoot, "# test\n", "2026-01-01T00:00:00+00:00");
        // With --end-of-options, `-Hello` is treated as a literal ref name.
        // Git fails to resolve it as a commit-ish → throws. The important
        // property: it does NOT silently succeed treating `-Hello` as a git
        // option flag (which would corrupt behavior).
        await expect(getCommitTimestamp(repo.repoRoot, "-Hello")).rejects.toThrow();
      } finally {
        await repo.cleanup();
      }
    });
  });

  describe("commit-peel succeeds for tag-ish input", () => {
    it("annotated-tag SHA peels to its commit and returns the commit's timestamp", async () => {
      const repo = await setupRepo();
      try {
        const commitSha = await commitWithFixedDate(
          repo.repoRoot,
          "# test\n",
          "2026-01-01T00:00:00+00:00",
        );
        // Annotated tag — the tag object itself has its own SHA, distinct
        // from the commit's. The tagger date intentionally differs from
        // the commit date to prove the peel resolves to the COMMIT's date.
        await runGit(repo.repoRoot, ["tag", "-a", "v1", "-m", "release"], {
          env: {
            GIT_AUTHOR_DATE: "2026-12-31T23:59:59+00:00",
            GIT_COMMITTER_DATE: "2026-12-31T23:59:59+00:00",
          },
        });
        const tagSha = (await runGit(repo.repoRoot, ["rev-parse", "v1"])).trim();
        // Sanity: tag's own SHA is distinct from the commit's SHA (proves
        // we're testing the peel, not just passing the commit SHA through).
        expect(tagSha).not.toBe(commitSha);

        const ts = await getCommitTimestamp(repo.repoRoot, tagSha);
        // Returns the COMMIT's timestamp (2026-01-01), NOT the tag's
        // (2026-12-31) — proves the commit-peel suffix peeled tag → commit.
        expect(ts).toBe("2026-01-01T00:00:00Z");
      } finally {
        await repo.cleanup();
      }
    });
  });
});

// =============================================================================
// D.1.pre — direct tests for resolveCommitRef
// =============================================================================

describe("resolveCommitRef", () => {
  describe("happy paths", () => {
    it("returns the input SHA unchanged when given a canonical commit SHA (peel is no-op)", async () => {
      const repo = await setupRepo();
      try {
        const sha = await commitWithFixedDate(
          repo.repoRoot,
          "# test\n",
          "2026-01-01T00:00:00+00:00",
        );
        const resolved = await resolveCommitRef(repo.repoRoot, sha);
        expect(resolved).toBe(sha);
        // Sanity: confirms the COMMIT_SHA_RE shape — 40 lowercase hex.
        // Mirrors the regex resolveCommitRef itself validates against.
        expect(resolved).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        await repo.cleanup();
      }
    });

    it("resolves HEAD to the current commit SHA (matches `git rev-parse HEAD`)", async () => {
      const repo = await setupRepo();
      try {
        const sha = await commitWithFixedDate(
          repo.repoRoot,
          "# test\n",
          "2026-01-01T00:00:00+00:00",
        );
        // HEAD is a SYMBOLIC ref — git looks up `.git/HEAD` to find the
        // target ref (or a detached SHA), then resolves through that. This
        // is distinct from branch-name resolution (see the next test
        // below); HEAD-specific because the M C `viberevert check --staged`
        // path (D58) defaults to `--since HEAD` and we want that path
        // covered explicitly.
        const resolved = await resolveCommitRef(repo.repoRoot, "HEAD");
        expect(resolved).toBe(sha);
        // Cross-check against an independent rev-parse of the same ref so
        // the test does not rely solely on commitWithFixedDate's return value.
        const independent = (await runGit(repo.repoRoot, ["rev-parse", "HEAD"])).trim();
        expect(resolved).toBe(independent);
      } finally {
        await repo.cleanup();
      }
    });

    it("resolves a branch name to that branch's commit SHA", async () => {
      const repo = await setupRepo();
      try {
        const sha = await commitWithFixedDate(
          repo.repoRoot,
          "# test\n",
          "2026-01-01T00:00:00+00:00",
        );
        // Branch-name resolution: `main` is the branch created by
        // setupRepo's `git init -b main`. This goes through a different
        // git-internal code path than HEAD (direct ref lookup, no
        // symbolic-ref indirection). Both paths must work.
        const resolved = await resolveCommitRef(repo.repoRoot, "main");
        expect(resolved).toBe(sha);
      } finally {
        await repo.cleanup();
      }
    });

    it("annotated-tag SHA peels to the commit SHA (proves tag SHA ≠ commit SHA, and resolve returns the commit's)", async () => {
      const repo = await setupRepo();
      try {
        const commitSha = await commitWithFixedDate(
          repo.repoRoot,
          "# test\n",
          "2026-01-01T00:00:00+00:00",
        );
        // Annotated tag — the tag object has its own SHA distinct from the
        // commit's SHA. We pass the TAG SHA (not the tag name) to prove the
        // peel transformation explicitly: input is a tag-object SHA, output
        // is the commit SHA the tag points at.
        await runGit(repo.repoRoot, ["tag", "-a", "v1", "-m", "release"], {
          env: {
            GIT_AUTHOR_DATE: "2026-12-31T23:59:59+00:00",
            GIT_COMMITTER_DATE: "2026-12-31T23:59:59+00:00",
          },
        });
        const tagSha = (await runGit(repo.repoRoot, ["rev-parse", "v1"])).trim();
        // Inequality sanity: tag's SHA MUST differ from the commit's SHA,
        // else the peel is a no-op and this test proves nothing.
        expect(tagSha).not.toBe(commitSha);

        const resolved = await resolveCommitRef(repo.repoRoot, tagSha);
        // The peel returns the COMMIT SHA, NOT the tag-object's SHA.
        expect(resolved).toBe(commitSha);
      } finally {
        await repo.cleanup();
      }
    });

    it("lightweight-tag name resolves to the commit SHA (no tag object involved)", async () => {
      const repo = await setupRepo();
      try {
        const commitSha = await commitWithFixedDate(
          repo.repoRoot,
          "# test\n",
          "2026-01-01T00:00:00+00:00",
        );
        // Lightweight tag: no -a flag → just a ref pointing directly at
        // the commit, no tag object created. `git rev-parse v1-light`
        // returns the commit SHA directly. Coverage complement to the
        // annotated-tag case above — git treats the two tag kinds
        // differently internally, both must resolve.
        await runGit(repo.repoRoot, ["tag", "v1-light"]);
        const resolved = await resolveCommitRef(repo.repoRoot, "v1-light");
        expect(resolved).toBe(commitSha);
      } finally {
        await repo.cleanup();
      }
    });
  });

  describe("error paths (CommitRefNotFoundError typed-error contract)", () => {
    it("commit-peel defense: tree SHA rejects with CommitRefNotFoundError carrying the original ref", async () => {
      const repo = await setupRepo();
      try {
        await commitWithFixedDate(repo.repoRoot, "# test\n", "2026-01-01T00:00:00+00:00");
        const treeSha = (await runGit(repo.repoRoot, ["rev-parse", "HEAD^{tree}"])).trim();
        const p = resolveCommitRef(repo.repoRoot, treeSha);
        // Typed-error contract: not just any throw — must be the typed
        // CommitRefNotFoundError. Stronger than getCommitTimestamp's
        // equivalent test, which only asserts `rejects.toThrow()`.
        await expect(p).rejects.toBeInstanceOf(CommitRefNotFoundError);
        await expect(p).rejects.toHaveProperty("ref", treeSha);
      } finally {
        await repo.cleanup();
      }
    });

    it("commit-peel defense: blob SHA rejects with CommitRefNotFoundError carrying the original ref", async () => {
      const repo = await setupRepo();
      try {
        await commitWithFixedDate(repo.repoRoot, "# test\n", "2026-01-01T00:00:00+00:00");
        const blobSha = (await runGit(repo.repoRoot, ["rev-parse", "HEAD:README.md"])).trim();
        const p = resolveCommitRef(repo.repoRoot, blobSha);
        await expect(p).rejects.toBeInstanceOf(CommitRefNotFoundError);
        await expect(p).rejects.toHaveProperty("ref", blobSha);
      } finally {
        await repo.cleanup();
      }
    });

    it("non-existent ref rejects with CommitRefNotFoundError carrying the original ref", async () => {
      const repo = await setupRepo();
      try {
        await commitWithFixedDate(repo.repoRoot, "# test\n", "2026-01-01T00:00:00+00:00");
        const bogus = "nonexistent-branch-name";
        const p = resolveCommitRef(repo.repoRoot, bogus);
        await expect(p).rejects.toBeInstanceOf(CommitRefNotFoundError);
        await expect(p).rejects.toHaveProperty("ref", bogus);
      } finally {
        await repo.cleanup();
      }
    });

    it("option-injection defense: ref starting with `-` rejects with CommitRefNotFoundError (not treated as a flag)", async () => {
      const repo = await setupRepo();
      try {
        await commitWithFixedDate(repo.repoRoot, "# test\n", "2026-01-01T00:00:00+00:00");
        // With --end-of-options, `-Hello` is treated as a literal
        // (non-existent) ref name. Git rejects it as not-a-commit-ish.
        // The important property: it is NOT silently re-interpreted as
        // a git option flag — which would corrupt behavior and could
        // leak arbitrary git options through a user-controlled --since
        // ref in the CLI.
        const malicious = "-Hello";
        const p = resolveCommitRef(repo.repoRoot, malicious);
        await expect(p).rejects.toBeInstanceOf(CommitRefNotFoundError);
        await expect(p).rejects.toHaveProperty("ref", malicious);
      } finally {
        await repo.cleanup();
      }
    });
  });
});

// =============================================================================
// D.1.pre — direct unit tests for the CommitRefNotFoundError class
// =============================================================================

describe("CommitRefNotFoundError", () => {
  it("diagnostic-safety: CommitRefNotFoundError JSON-quotes refs with control characters", () => {
    // Locks the JSON.stringify(ref) hardening in CommitRefNotFoundError's
    // constructor. Without it, a user-controlled ref containing a newline
    // (or terminal escape, or text that mimics another git error
    // fragment) would corrupt the diagnostic line — the message would
    // span multiple lines OR be confusable with an unrelated error. The
    // JSON-quoting wraps the ref in double quotes and escapes the
    // hazardous characters. Symmetric hardening lives on
    // DiffRefNotFoundError in diff.ts; that test lives in diff.test.ts.
    const err = new CommitRefNotFoundError("bad\nref");
    expect(err.message).toBe('Could not resolve commit ref "bad\\nref"');
    expect(err.message).not.toContain("\n");
  });
});

// =============================================================================
// Step 4a — parseStatusPorcelainZ (pure parser)
//
// Tests target the pure parser directly via Buffer literals — no git
// subprocess, no temp repo. Locks every parsing branch independent of
// git's runtime behavior. The same parser feeds both live status
// (getStatusPorcelainZ) and persisted after-status.z snapshots
// (M D's loadEndOfSessionChangedPaths in Step 4b); a regression here
// would corrupt both surfaces.
//
// Format reminder: each entry is `<XY> <path>\0`. Rename (R in X or Y)
// or copy (C in X or Y) entries are followed by an extra
// `<oldpath>\0` chunk.
// =============================================================================

describe("parseStatusPorcelainZ — pure parser", () => {
  describe("happy paths", () => {
    it("returns [] for empty buffer", () => {
      expect(parseStatusPorcelainZ(Buffer.alloc(0))).toEqual([]);
    });

    it("parses single untracked entry", () => {
      const buf = Buffer.from("?? newfile.txt\0", "utf8");
      expect(parseStatusPorcelainZ(buf)).toEqual([{ statusXY: "??", path: "newfile.txt" }]);
    });

    it("parses single unstaged-modified entry", () => {
      // Format: X=space (no index change), Y=M (worktree modified)
      const buf = Buffer.from(" M file.txt\0", "utf8");
      expect(parseStatusPorcelainZ(buf)).toEqual([{ statusXY: " M", path: "file.txt" }]);
    });

    it("parses multiple non-rename entries in source order", () => {
      const buf = Buffer.from("?? a.txt\0 M b.txt\0M  c.txt\0", "utf8");
      expect(parseStatusPorcelainZ(buf)).toEqual([
        { statusXY: "??", path: "a.txt" },
        { statusXY: " M", path: "b.txt" },
        { statusXY: "M ", path: "c.txt" },
      ]);
    });
  });

  describe("rename/copy two-path entries (D61 path-set comparison depends on this)", () => {
    it("parses rename entry with R in X (index) position + old-path follower", () => {
      // R in X = rename detected in the index. Format: `R <newpath>\0<oldpath>\0`
      const buf = Buffer.from("R  newname.txt\0oldname.txt\0", "utf8");
      expect(parseStatusPorcelainZ(buf)).toEqual([
        { statusXY: "R ", path: "newname.txt", previousPath: "oldname.txt" },
      ]);
    });

    it("parses rename entry with R in Y (worktree) position + old-path follower", () => {
      // Y=R also consumes a follower per porcelain v1 -z docs.
      const buf = Buffer.from(" R newname.txt\0oldname.txt\0", "utf8");
      expect(parseStatusPorcelainZ(buf)).toEqual([
        { statusXY: " R", path: "newname.txt", previousPath: "oldname.txt" },
      ]);
    });

    it("parses copy entry with C in X position + old-path follower", () => {
      const buf = Buffer.from("C  copy.txt\0source.txt\0", "utf8");
      expect(parseStatusPorcelainZ(buf)).toEqual([
        { statusXY: "C ", path: "copy.txt", previousPath: "source.txt" },
      ]);
    });

    it("parses copy entry with C in Y position + old-path follower", () => {
      // Y=C also consumes a follower per porcelain v1 -z docs (matches
      // the R-in-Y branch in the parser's isRenameOrCopy check).
      const buf = Buffer.from(" C copy.txt\0source.txt\0", "utf8");
      expect(parseStatusPorcelainZ(buf)).toEqual([
        { statusXY: " C", path: "copy.txt", previousPath: "source.txt" },
      ]);
    });

    it("parses mixed entries with renames interspersed (index advances by 2 across rename, 1 elsewhere)", () => {
      const buf = Buffer.from("?? a.txt\0R  new.txt\0old.txt\0 M c.txt\0", "utf8");
      expect(parseStatusPorcelainZ(buf)).toEqual([
        { statusXY: "??", path: "a.txt" },
        { statusXY: "R ", path: "new.txt", previousPath: "old.txt" },
        { statusXY: " M", path: "c.txt" },
      ]);
    });
  });

  describe("error paths (fails closed — never silently skips)", () => {
    it("throws on malformed entry shorter than 4 chars", () => {
      // Minimum valid entry: 2-char status + space + at-least-one-char path = 4.
      // "ab" is only 2 chars → malformed.
      const buf = Buffer.from("ab\0", "utf8");
      expect(() => parseStatusPorcelainZ(buf)).toThrow(/malformed entry/);
    });

    it("throws when the status/path separator is not a space (tampered after-status.z byte protection)", () => {
      // Step 4a fail-closed hardening: the original live-only parser
      // trusted the separator position implicitly. The extracted parser
      // also consumes persisted after-status.z bytes (tamperable), so it
      // now validates `raw[2] === " "` explicitly. Without the
      // hardening, `??foo.txt\0` would silently parse as
      // { statusXY: "??", path: "oo.txt" } — wrong path, no error.
      const buf = Buffer.from("??foo.txt\0", "utf8");
      expect(() => parseStatusPorcelainZ(buf)).toThrow(/malformed entry/);
    });

    it("throws on rename entry missing its required old-path follower", () => {
      // R entry but no follower chunk → fails closed with structured error.
      const buf = Buffer.from("R  orphan.txt\0", "utf8");
      expect(() => parseStatusPorcelainZ(buf)).toThrow(/missing its required old-path follower/);
    });
  });
});

// =============================================================================
// Step 4a — getStatusPorcelainZRaw (live z-format bytes)
//
// The raw helper is the bridge between git subprocess output and M B's
// `end` persistence of after-status.z. These live tests prove:
//   - clean tree → empty Buffer
//   - dirty tree → exact byte equality with the parser's input form
//   - round-trip: getStatusPorcelainZRaw → parseStatusPorcelainZ matches
//     getStatusPorcelainZ for the same tree state (no semantic drift
//     from the refactor)
// =============================================================================

describe("getStatusPorcelainZRaw — live z-format bytes for after-status.z persistence", () => {
  it("returns an empty Buffer on a clean tree", async () => {
    const repo = await setupRepo();
    try {
      await writeFile(join(repo.repoRoot, "README.md"), "# test\n");
      await runGit(repo.repoRoot, ["add", "README.md"]);
      await runGit(repo.repoRoot, ["commit", "-m", "init"]);

      const buf = await getStatusPorcelainZRaw(repo.repoRoot);
      expect(buf.length).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  it("returns the exact raw z-format bytes git produced for a dirty tree, parseable via parseStatusPorcelainZ", async () => {
    const repo = await setupRepo();
    try {
      await writeFile(join(repo.repoRoot, "README.md"), "# test\n");
      await runGit(repo.repoRoot, ["add", "README.md"]);
      await runGit(repo.repoRoot, ["commit", "-m", "init"]);

      // Add an untracked file — git enumerates it as ?? in z-format.
      await writeFile(join(repo.repoRoot, "newfile.txt"), "new\n");

      const buf = await getStatusPorcelainZRaw(repo.repoRoot);
      // Format: `?? newfile.txt\0`
      expect(buf.toString("utf8")).toBe("?? newfile.txt\0");

      // The bytes flow through the pure parser to the expected entry —
      // proves the raw helper and the parser are wired correctly together.
      const entries = parseStatusPorcelainZ(buf);
      expect(entries).toEqual([{ statusXY: "??", path: "newfile.txt" }]);
    } finally {
      await repo.cleanup();
    }
  });
});

// =============================================================================
// Step 4a — getStatusPorcelainZ (live wrapper parity)
//
// Locks that the refactor preserved observable behavior at the public
// surface: wrapper(repoRoot) === parseStatusPorcelainZ(await
// getStatusPorcelainZRaw(repoRoot)) for any tree state. Existing
// callers of getStatusPorcelainZ are unaffected by the extraction.
// =============================================================================

describe("getStatusPorcelainZ — live wrapper parity", () => {
  it("returns [] on a clean tree", async () => {
    const repo = await setupRepo();
    try {
      await writeFile(join(repo.repoRoot, "README.md"), "# test\n");
      await runGit(repo.repoRoot, ["add", "README.md"]);
      await runGit(repo.repoRoot, ["commit", "-m", "init"]);

      const entries = await getStatusPorcelainZ(repo.repoRoot);
      expect(entries).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("parity: wrapper output equals parseStatusPorcelainZ(getStatusPorcelainZRaw()) for the same tree state", async () => {
    const repo = await setupRepo();
    try {
      await writeFile(join(repo.repoRoot, "README.md"), "# test\n");
      await runGit(repo.repoRoot, ["add", "README.md"]);
      await runGit(repo.repoRoot, ["commit", "-m", "init"]);

      // Mixed dirty state: modified tracked file + new untracked file.
      await writeFile(join(repo.repoRoot, "README.md"), "# modified\n");
      await writeFile(join(repo.repoRoot, "newfile.txt"), "new\n");

      const fromWrapper = await getStatusPorcelainZ(repo.repoRoot);
      const fromRaw = parseStatusPorcelainZ(await getStatusPorcelainZRaw(repo.repoRoot));
      expect(fromWrapper).toEqual(fromRaw);
    } finally {
      await repo.cleanup();
    }
  });

  it("correctly captures rename entries via the wrapper (live git output)", async () => {
    const repo = await setupRepo();
    try {
      await writeFile(join(repo.repoRoot, "README.md"), "# test\n");
      await writeFile(join(repo.repoRoot, "oldname.txt"), "content\n");
      await runGit(repo.repoRoot, ["add", "README.md", "oldname.txt"]);
      await runGit(repo.repoRoot, ["commit", "-m", "init"]);

      // Force rename detection on. `status.renames` may be `false` in
      // user / system git config (e.g., to avoid CPU cost on large
      // repos); without this repo-local override, `git status
      // --porcelain=v1 -z` would surface the rename as a separate D + ??
      // pair, NOT an R entry, and the rename-capture assertion below
      // would fail environment-dependently.
      await runGit(repo.repoRoot, ["config", "status.renames", "true"]);

      // Use `git mv` to stage a rename — porcelain z output produces an
      // R-status entry with the old-path follower.
      await runGit(repo.repoRoot, ["mv", "oldname.txt", "newname.txt"]);

      const entries = await getStatusPorcelainZ(repo.repoRoot);
      const renameEntry = entries.find((e) => e.statusXY.includes("R"));
      expect(renameEntry).toBeDefined();
      expect(renameEntry?.path).toBe("newname.txt");
      expect(renameEntry?.previousPath).toBe("oldname.txt");
    } finally {
      await repo.cleanup();
    }
  });
});
