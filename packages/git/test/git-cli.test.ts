// packages/git/test/git-cli.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// git-cli.ts — A.6 targeted tests for getCommitTimestamp.
//
// Covers:
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

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { getCommitTimestamp } from "../src/git-cli.js";

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
        // (2026-12-31) — proves `^{commit}` peeled tag → commit.
        expect(ts).toBe("2026-01-01T00:00:00Z");
      } finally {
        await repo.cleanup();
      }
    });
  });
});
