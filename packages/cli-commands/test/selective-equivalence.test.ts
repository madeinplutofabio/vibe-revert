// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The constrained equivalence property (M 0.8.0 step 14).
//
// THE CLAIM UNDER TEST, from the milestone plan: for an ended session with no
// post-end drift, matching HEAD, no unsupported path states, and the same
// exclusion domain, selecting every contribution unit produces the same managed
// working-tree and index state as a whole-session rollback.
//
// This is load-bearing rather than decorative. `docs/rollback-contract.md` tells
// a user who has begun surgical recovery to run `--only '**' --apply` to finish
// restoring the rest, because control never returns to the whole-checkpoint
// engine once a selective apply has succeeded. That instruction is only sound if
// the two engines actually agree, and nothing else in the suite compares them.
//
// =============================================================================
// Two repositories, independently prepared
// =============================================================================
//
// The same preparation runs twice into two temp directories. It is NOT prepared
// once and copied, for two reasons: a copy would share any accident of the
// first run, and running it twice additionally proves the preparation is
// deterministic. That determinism is asserted BEFORE either rollback, because a
// comparison of two end states means nothing if the start states differed.
//
// Then one repository takes the whole-session engine and the other takes the
// selective engine over every unit, and the same normalized state is compared
// again.
//
// =============================================================================
// What "managed state" means here, and what is deliberately excluded
// =============================================================================
//
// Compared: the git index (mode, object id, stage, path for every entry), the
// content digest of every tracked and untracked file, the executable bit where
// the platform can report one, the untracked path set, and HEAD.
//
// NOT compared: receipts, generated identifiers, timestamps, or anything under
// `.viberevert/`. Those differ between the two engines BY DESIGN, since they
// write different artifacts to different paths, and comparing them would fail
// for reasons that have nothing to do with the property. The whole point of the
// claim is about the user's project, not about VibeRevert's own bookkeeping.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EndCommand } from "../src/commands/end.js";
import { InitCommand } from "../src/commands/init.js";
import { RollbackCommand } from "../src/commands/rollback.js";
import { StartCommand } from "../src/commands/start.js";
import { VIBEREVERT_TEST_FIXED_NOW } from "../src/runtime-env.js";

const execFileAsync = promisify(execFile);

const FIXED_NOW = "2026-01-01T00:00:00Z";
/** Generous: each leg drives init, start, end and an apply over a real repo. */
const TIMEOUT_MS = 180_000;

/** The exec bit is not observable on Windows, so it is compared only where it is real. */
const EXEC_BIT_OBSERVABLE = process.platform !== "win32";

let tmpParent: string;
let originalCwd: string;

beforeEach(async () => {
  tmpParent = await mkdtemp(join(tmpdir(), "viberevert-equivalence-"));
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpParent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// =============================================================================
// Command plumbing
// =============================================================================

type RegisteredCommand = Parameters<Cli["register"]>[0];

async function runCommand(
  CommandClass: RegisteredCommand,
  commandName: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const cli = new Cli({ binaryName: "viberevert" });
  cli.register(CommandClass);

  const stdinStub = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdinStub.isTTY = false;

  const collect = (sink: string[]): Writable =>
    new Writable({
      write(chunk, _encoding, callback) {
        sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        callback();
      },
    });

  const exitCode = await cli.run([commandName, ...args], {
    stdin: stdinStub,
    stdout: collect(stdoutChunks),
    stderr: collect(stderrChunks),
  });
  return { exitCode, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

const git = async (cwd: string, args: readonly string[]): Promise<string> =>
  (await execFileAsync("git", [...args], { cwd, windowsHide: true, maxBuffer: 1 << 24 })).stdout;

/**
 * Fixed identity AND timestamps for the baseline commit.
 *
 * Without pinned dates the two repositories produce different commit SHAs from
 * identical trees, purely because they were created moments apart. HEAD is part
 * of the compared state, since both engines must leave it unmoved, so it has to
 * be reproducible for the comparison to mean anything.
 */
const FIXED_COMMIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

const gitCommit = async (cwd: string, message: string): Promise<void> => {
  await execFileAsync("git", ["commit", "-q", "-m", message], {
    cwd,
    windowsHide: true,
    env: FIXED_COMMIT_ENV,
  });
};

// =============================================================================
// Preparation: run twice, independently
// =============================================================================

/**
 * Build one repository and drive a session through it.
 *
 * The session deliberately covers several change shapes at once, because the
 * property is about the WHOLE managed domain agreeing, not about one file:
 * a modified tracked file, a staged-then-further-modified file, a deleted
 * tracked file, and a session-created untracked file the restore must remove.
 */
async function prepareRepo(root: string): Promise<string> {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });

  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["config", "core.autocrlf", "false"]);

  await writeFile(join(root, "README.md"), "# Baseline\n");
  await writeFile(join(root, "src/app.ts"), 'export const app = "before";\n');
  await writeFile(join(root, "src/staged.ts"), 'export const staged = "before";\n');
  await writeFile(join(root, "docs/guide.md"), "Guide, before.\n");
  await writeFile(join(root, "src/doomed.ts"), "export const doomed = true;\n");

  process.chdir(root);
  const init = await runCommand(InitCommand, "init", []);
  if (init.exitCode !== 0) {
    throw new Error(`init failed (${init.exitCode}): ${init.stderr}`);
  }
  await git(root, ["add", "-A"]);
  await gitCommit(root, "baseline");

  const start = await runCommand(StartCommand, "start", ["--task", "equivalence property"]);
  if (start.exitCode !== 0) {
    throw new Error(`start failed (${start.exitCode}): ${start.stderr}`);
  }
  const sessionId = start.stdout.match(/sess_[0-9A-HJKMNP-TV-Z]{26}/)?.[0];
  if (sessionId === undefined) {
    throw new Error(`could not parse session id from:\n${start.stdout}`);
  }

  // The session's work, spanning four change shapes.
  await writeFile(join(root, "src/app.ts"), 'export const app = "after";\n');
  await writeFile(join(root, "src/staged.ts"), 'export const staged = "staged";\n');
  await git(root, ["add", "src/staged.ts"]);
  await writeFile(join(root, "src/staged.ts"), 'export const staged = "staged then edited";\n');
  await unlink(join(root, "src/doomed.ts"));
  await writeFile(join(root, "src/created.ts"), "export const created = true;\n");
  await writeFile(join(root, "docs/guide.md"), "Guide, after.\n");

  const end = await runCommand(EndCommand, "end", []);
  if (end.exitCode !== 0) {
    throw new Error(`end failed (${end.exitCode}): ${end.stderr}`);
  }
  return sessionId;
}

// =============================================================================
// Normalized managed state
// =============================================================================

interface ManagedState {
  readonly head: string;
  /** `<mode> <oid> <stage>\t<path>` per index entry, sorted. */
  readonly index: readonly string[];
  /** `<path> <sha256>[ x]`, sorted. `x` marks the exec bit where observable. */
  readonly files: readonly string[];
  readonly untracked: readonly string[];
}

const MANAGED_EXCLUDE = /^\.viberevert\//;

async function fileFacts(root: string, relPath: string): Promise<string> {
  const abs = join(root, relPath);
  const bytes = await readFile(abs);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!EXEC_BIT_OBSERVABLE) {
    return `${relPath} ${digest}`;
  }
  const mode = (await stat(abs)).mode;
  return `${relPath} ${digest}${(mode & 0o111) === 0 ? "" : " x"}`;
}

/**
 * Everything the property claims must agree, and nothing else.
 *
 * `.viberevert/` is excluded wholesale: the two engines write different
 * artifacts there by design, and the claim is about the user's project.
 */
async function managedState(root: string): Promise<ManagedState> {
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();

  const index = (await git(root, ["ls-files", "-s"]))
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((line) => !MANAGED_EXCLUDE.test(line.split("\t")[1] ?? ""))
    .sort();

  const tracked = (await git(root, ["ls-files"]))
    .split("\n")
    .filter((p) => p.length > 0 && !MANAGED_EXCLUDE.test(p));
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard"]))
    .split("\n")
    .filter((p) => p.length > 0 && !MANAGED_EXCLUDE.test(p))
    .sort();

  // A tracked path can be absent from the worktree (a staged deletion), which
  // is a real managed state rather than an error, so a missing file is recorded
  // as such instead of throwing.
  const files: string[] = [];
  for (const relPath of [...tracked, ...untracked].sort()) {
    files.push(await fileFacts(root, relPath).catch(() => `${relPath} <absent-from-worktree>`));
  }

  return { head, index, files, untracked };
}

// =============================================================================
// The property
// =============================================================================

describe("constrained equivalence: --only '**' matches whole-session rollback", () => {
  it(
    "produces identical managed state from two independently prepared repositories",
    async () => {
      // Both repositories share the BASENAME `repo`, differing only in their
      // parent. `viberevert init` writes `basename(repoRoot)` into
      // `.viberevert.yml` as the project name, and that file is tracked, so
      // distinct directory names would give the two repos different configs,
      // different blobs, and therefore different commit SHAs. The control
      // assertion below caught exactly that.
      const fullRoot = join(tmpParent, "a", "repo");
      const selectiveRoot = join(tmpParent, "b", "repo");
      await mkdir(fullRoot, { recursive: true });
      await mkdir(selectiveRoot, { recursive: true });

      const previousNow = process.env[VIBEREVERT_TEST_FIXED_NOW];
      process.env[VIBEREVERT_TEST_FIXED_NOW] = FIXED_NOW;
      try {
        const fullSession = await prepareRepo(fullRoot);
        const selectiveSession = await prepareRepo(selectiveRoot);

        // CONTROL. Without this the comparison below proves nothing: two end
        // states can only be meaningfully equal if the start states were.
        const beforeFull = await managedState(fullRoot);
        const beforeSelective = await managedState(selectiveRoot);
        expect(beforeSelective).toEqual(beforeFull);

        process.chdir(fullRoot);
        const full = await runCommand(RollbackCommand, "rollback", [fullSession, "--apply"]);
        expect(full.exitCode, `whole-session apply failed:\n${full.stderr}`).toBe(0);

        process.chdir(selectiveRoot);
        const selective = await runCommand(RollbackCommand, "rollback", [
          selectiveSession,
          "--only",
          "**",
          "--apply",
        ]);
        expect(selective.exitCode, `selective all-unit apply failed:\n${selective.stderr}`).toBe(0);

        const afterFull = await managedState(fullRoot);
        const afterSelective = await managedState(selectiveRoot);
        expect(afterSelective).toEqual(afterFull);

        // The property would hold vacuously if neither engine had done
        // anything, so assert the state actually moved.
        expect(afterFull).not.toEqual(beforeFull);
      } finally {
        if (previousNow === undefined) {
          delete process.env[VIBEREVERT_TEST_FIXED_NOW];
        } else {
          process.env[VIBEREVERT_TEST_FIXED_NOW] = previousNow;
        }
      }
    },
    TIMEOUT_MS,
  );
});
