// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Verification-command mutation, end to end (M 0.8.0 step 14).
//
// The second integrity pass exists for one reason: a project's own verification
// command can modify the project it was asked to check. `npm test` writing a
// snapshot file, a formatter rewriting sources, a script that commits. If that
// goes unnoticed, a selective rollback reports a clean restore over a tree the
// command has since changed, which is the receipt lying about the repository.
//
// The classification of that condition is already unit-tested in
// `post-command-integrity.test.ts` and at the transaction level. What was NOT
// tested, and is what this file adds, is the COMPLETE path: a command really
// configured at `viberevert start`, really executed by a selective apply, really
// mutating the repository, and the persisted receipt really recording it.
//
// Unit coverage cannot substitute here. It proves the comparator classifies a
// constructed pair of observations; it cannot prove the observations are taken
// at the right moments, that the configured argv reaches the runner, or that the
// outcome reaches the artifact. Each of those is a seam between packages.
//
// =============================================================================
// Three separate cases, on purpose
// =============================================================================
//
// Each mutation shape is its own `it`, because they fail for different reasons
// and a combined case would report only the first. They also probe genuinely
// different comparison axes:
//
//   content   a tracked file's bytes change            -> changed_paths
//   mode      only the executable bit changes          -> POSIX only
//   history   HEAD moves while bytes stay acceptable   -> head_moved
//
// The mode case is skipped on Windows rather than weakened, because the
// executable bit is not observable there at all. A test that passed by
// asserting nothing would be worse than an honest skip.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import type { SelectiveRollbackReceipt } from "@viberevert/session-format";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EndCommand } from "../src/commands/end.js";
import { InitCommand } from "../src/commands/init.js";
import { RollbackCommand } from "../src/commands/rollback.js";
import { StartCommand } from "../src/commands/start.js";
import { VIBEREVERT_TEST_FIXED_NOW } from "../src/runtime-env.js";

const execFileAsync = promisify(execFile);

const FIXED_NOW = "2026-01-01T00:00:00Z";
const TIMEOUT_MS = 180_000;

/** The executable bit is unobservable on Windows, so the mode case cannot run there. */
const POSIX_ONLY = process.platform === "win32" ? it.skip : it;

/** Selected by the rollback; the commands below deliberately touch other paths. */
const SELECTOR = "src/**";
/** Unselected, so a mutation to it also proves the UNSELECTED domain is watched. */
const UNSELECTED = "docs/guide.md";

let repoRoot: string;
let originalCwd: string;

beforeEach(async () => {
  const parent = await mkdtemp(join(tmpdir(), "viberevert-verifymut-"));
  repoRoot = join(parent, "repo");
  await mkdir(repoRoot, { recursive: true });
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(join(repoRoot, ".."), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// =============================================================================
// Plumbing
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

const git = async (args: readonly string[]): Promise<string> =>
  (await execFileAsync("git", [...args], { cwd: repoRoot, windowsHide: true })).stdout;

/**
 * Drive a session whose evaluation snapshot carries `commands`.
 *
 * The verify block is written into `.viberevert.yml` BEFORE `viberevert start`,
 * which is the only way it reaches the run: selective rollback reads the
 * session-start snapshot, never live config, so a block added later would be
 * ignored. That is the safety property, and setting it up this way exercises it.
 */
async function setupSessionWithVerify(commands: string): Promise<string> {
  await mkdir(join(repoRoot, "src"), { recursive: true });
  await mkdir(join(repoRoot, "docs"), { recursive: true });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);
  await git(["config", "commit.gpgsign", "false"]);
  await git(["config", "core.autocrlf", "false"]);

  await writeFile(join(repoRoot, "src/app.ts"), 'export const app = "before";\n');
  await writeFile(join(repoRoot, UNSELECTED), "Guide, before.\n");

  process.chdir(repoRoot);
  const init = await runCommand(InitCommand, "init", []);
  if (init.exitCode !== 0) throw new Error(`init failed: ${init.stderr}`);

  const configPath = join(repoRoot, ".viberevert.yml");
  const base = await readFile(configPath, "utf8");
  await writeFile(configPath, `${base}\nverify:\n  commands:\n${commands}`);

  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "baseline"]);

  const start = await runCommand(StartCommand, "start", ["--task", "verify mutation"]);
  if (start.exitCode !== 0) throw new Error(`start failed: ${start.stderr}`);
  const sessionId = start.stdout.match(/sess_[0-9A-HJKMNP-TV-Z]{26}/)?.[0];
  if (sessionId === undefined) throw new Error(`no session id in:\n${start.stdout}`);

  await writeFile(join(repoRoot, "src/app.ts"), 'export const app = "after";\n');

  const end = await runCommand(EndCommand, "end", []);
  if (end.exitCode !== 0) throw new Error(`end failed: ${end.stderr}`);
  return sessionId;
}

/** The one invocation's receipt. Exactly one must exist. */
async function readApplyReceipt(sessionId: string): Promise<SelectiveRollbackReceipt> {
  const rollbacksDir = join(repoRoot, ".viberevert", "sessions", sessionId, "rollbacks");
  const entries = (await readdir(rollbacksDir)).sort();
  if (entries.length !== 1) {
    throw new Error(`expected exactly one invocation directory, got ${JSON.stringify(entries)}`);
  }
  const raw = await readFile(join(rollbacksDir, entries[0] as string, "receipt.json"), "utf8");
  return JSON.parse(raw) as SelectiveRollbackReceipt;
}

/** A node one-liner, so the command is real and portable without a shell. */
const nodeCommand = (script: string): string =>
  `    - command: node\n      args:\n        - "-e"\n        - ${JSON.stringify(script)}\n`;

async function applySelective(sessionId: string): Promise<number> {
  process.chdir(repoRoot);
  const result = await runCommand(RollbackCommand, "rollback", [
    sessionId,
    "--only",
    SELECTOR,
    "--apply",
  ]);
  return result.exitCode;
}

async function withFixedNow<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env[VIBEREVERT_TEST_FIXED_NOW];
  process.env[VIBEREVERT_TEST_FIXED_NOW] = FIXED_NOW;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[VIBEREVERT_TEST_FIXED_NOW];
    else process.env[VIBEREVERT_TEST_FIXED_NOW] = previous;
  }
}

/**
 * An apply that ran its commands and then failed on what they did.
 *
 * Asserted once, here, because all three cases share it: the outcome is
 * `failed`, a recovery handle exists, and the second pass reports the project
 * was mutated. What differs between the cases is WHICH evidence names the
 * mutation, and that stays in each case.
 */
function expectMutationDetected(receipt: SelectiveRollbackReceipt): Extract<
  SelectiveRollbackReceipt,
  { mode: "apply" }
>["post_command_integrity"] & {
  state: "project_mutated";
} {
  if (receipt.mode !== "apply") throw new Error("expected an apply receipt");
  // A mutated project cannot be a succeeded receipt; the schema couples them.
  expect(receipt.outcome).toBe("failed");
  // E, the recovery handle, must exist because mutation was authorized.
  expect(receipt.pre_rollback_checkpoint_id).toMatch(/^cp_[0-9A-HJKMNP-TV-Z]{26}$/);
  // The commands ran, which is what makes this a test of the command path.
  expect(receipt.project_verification.state).toBe("completed");
  expect(receipt.post_command_integrity.state).toBe("project_mutated");
  if (receipt.post_command_integrity.state !== "project_mutated") {
    throw new Error("unreachable: state asserted above");
  }
  return receipt.post_command_integrity;
}

// =============================================================================
// The three cases
// =============================================================================

describe("a verification command that mutates the project is caught and recorded", () => {
  it(
    "writing a tracked file is recorded as a changed path",
    async () => {
      await withFixedNow(async () => {
        const sessionId = await setupSessionWithVerify(
          nodeCommand(
            `require("fs").writeFileSync(${JSON.stringify(UNSELECTED)}, "mutated by verify\\n")`,
          ),
        );
        const exitCode = await applySelective(sessionId);
        expect(exitCode).toBe(1);

        const integrity = expectMutationDetected(await readApplyReceipt(sessionId));
        expect(integrity.changed_paths).toContain(UNSELECTED);
        expect(integrity.head_moved).toBe(false);
      });
    },
    TIMEOUT_MS,
  );

  POSIX_ONLY(
    "changing only the executable bit is recorded, with bytes and index untouched",
    async () => {
      await withFixedNow(async () => {
        const sessionId = await setupSessionWithVerify(
          nodeCommand(`require("fs").chmodSync(${JSON.stringify(UNSELECTED)}, 0o755)`),
        );
        const before = await readFile(join(repoRoot, UNSELECTED), "utf8");

        const exitCode = await applySelective(sessionId);
        expect(exitCode).toBe(1);

        const integrity = expectMutationDetected(await readApplyReceipt(sessionId));
        // Named somewhere: the mode is part of the path's state even though its
        // bytes are not.
        expect([
          ...integrity.changed_paths,
          ...integrity.added_paths,
          ...integrity.removed_paths,
        ]).toContain(UNSELECTED);

        // The premise of the case: bytes really were untouched, so the
        // detection came from the mode axis rather than from content.
        expect(await readFile(join(repoRoot, UNSELECTED), "utf8")).toBe(before);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "running git commit is recorded as a moved HEAD",
    async () => {
      await withFixedNow(async () => {
        const sessionId = await setupSessionWithVerify(
          '    - command: git\n      args:\n        - commit\n        - "--allow-empty"\n        - "-q"\n        - "-m"\n        - "mutated by verify"\n',
        );
        const headBefore = (await git(["rev-parse", "HEAD"])).trim();

        const exitCode = await applySelective(sessionId);
        expect(exitCode).toBe(1);

        const integrity = expectMutationDetected(await readApplyReceipt(sessionId));
        // The whole reason the second pass compares HEAD: file bytes can be
        // entirely acceptable while history has moved underneath them.
        expect(integrity.head_moved).toBe(true);
        expect((await git(["rev-parse", "HEAD"])).trim()).not.toBe(headBefore);
      });
    },
    TIMEOUT_MS,
  );
});
