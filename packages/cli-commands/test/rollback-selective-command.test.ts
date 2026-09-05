// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Command-level tests for the selective selectors and the single locked phase
// (M 0.8.0 step 12).
//
// Scope, deliberately narrow. `rollback.test.ts` already owns the legacy
// full-session behavior end to end, and it passing unchanged is what proves the
// extraction moved that behavior rather than reinterpreting it. This file
// covers only what the extraction ADDED:
//
//   A. option parsing and the pure pre-lock selector validation
//   B. the mode/selector binding, as a unit
//   C. the single-lock boundary
//   D. post-lock rendering and exit status for the selective arms
//   E. the empty resolution, on both sides of the dry-run/apply split
//
// Nothing below MUTATES the repository. Every case either refuses before the
// transplant or takes the read-only preview path, which is what makes a
// command-level suite affordable here. The transplant's own end-to-end
// coverage, and per-path presentation, are rung 8's.
//
// TWO fixtures, because the two questions are different:
//
//   - a legacy ENDED session, `session.json` with no `contribution_path`. That
//     is the shape every pre-0.8.0 ended session has on disk today, so it is
//     the honest input for "selective rollback against a session that has no
//     contribution", and it is the state most real repositories are in.
//   - the same session WITH a real contribution written to disk and its digest
//     computed from the exact bytes. Needed because an empty resolution is a
//     RESULT that gets recorded, and recording it requires a verified
//     contribution to name. Group E's positive control uses it too: without a
//     selection that genuinely resolves, every "it was empty" assertion would
//     pass against a command that could only ever produce emptiness.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import {
  CONTRIBUTION_FILE_SCHEMA_VERSION,
  deriveChangeGroupId,
  type Manifest,
  type PathState,
  SCHEMA_VERSION,
  SESSION_STATE_SCHEMA_VERSION,
  type SelectiveRollbackReceipt,
  type SessionContributionEntry,
  type SessionContributionFile,
  type SessionState,
} from "@viberevert/session-format";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RollbackCommand } from "../src/commands/rollback.js";
import { resolveRollbackSelectionMode } from "../src/rollback-locked-phase.js";
import type { SelectionSelectors } from "../src/selection-resolver.js";

const execFileAsync = promisify(execFile);

const SESSION_ID = "sess_01JV8Z0N6E7ABCDEFGHJKMNPQR";
const CHECKPOINT_ID = "cp_01JV8Y7W2M7ABCDEFGHJKMNPQR";
const STARTED_AT = "2026-05-04T10:30:11Z";
const ENDED_AT = "2026-05-04T10:35:11Z";

/** A well-formed finding id: the shape `--finding` requires. */
const FULL_FINDING_ID = `fnd_${"a".repeat(64)}`;

const ROLLBACK_LOCK_REL = join(".viberevert", ".locks", "rollback.lock");

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-rollback-selective-"));
  originalCwd = process.cwd();
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: tmpRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.test",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "init",
    ],
    { cwd: tmpRoot },
  );
  await writeFile(join(tmpRoot, ".gitignore"), ".viberevert/\n");
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// =============================================================================
// Helpers
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

const runRollback = (args: string[]) => runCommand(RollbackCommand, "rollback", args);

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

async function writeMinimalConfig(): Promise<void> {
  await writeFile(join(tmpRoot, ".viberevert.yml"), "version: 1\n");
}

const ABSENT: PathState = { worktree: { kind: "absent" }, index: { kind: "absent" } };
const CONTRIBUTION_REL = `.viberevert/sessions/${SESSION_ID}/contribution.json`;
const SELECTIVE_DRY_RUN_RECEIPT = "selective-rollback-dry-run-receipt.json";

const contributionEntry = (path: string): SessionContributionEntry => ({
  path,
  operation: "modified",
  facets: [],
  change_group_id: deriveChangeGroupId(SESSION_ID, [path]),
  before: ABSENT,
  after: ABSENT,
  content_delta: { kind: "none" },
});

/**
 * Write a real contribution and return the binding a session must record.
 *
 * The digest is computed from the EXACT bytes written, never declared, so the
 * fixture cannot drift from the artifact the loader will verify.
 */
async function writeContribution(): Promise<{ path: string; sha256: string }> {
  const contribution: SessionContributionFile = {
    schema_version: CONTRIBUTION_FILE_SCHEMA_VERSION,
    session_id: SESSION_ID,
    checkpoint_id: CHECKPOINT_ID,
    before_head_sha: "0".repeat(40),
    after_head_sha: "1".repeat(40),
    captured_at: STARTED_AT,
    ended_at: ENDED_AT,
    entries: [contributionEntry("docs/readme.md"), contributionEntry("src/a.ts")],
  };
  const bytes = Buffer.from(JSON.stringify(contribution, null, 2), "utf8");
  await writeFile(join(tmpRoot, ...CONTRIBUTION_REL.split("/")), bytes);
  return {
    path: CONTRIBUTION_REL,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * An ENDED session with real checkpoint artifacts, optionally with a
 * contribution.
 *
 * Ended rather than active so the D63 active-session refusal does not fire
 * first and hide the selection outcome these tests are about.
 */
async function writeLegacyEndedSession(
  opts: { withContribution?: boolean } = {},
): Promise<{ contributionSha256?: string }> {
  const sessionDir = join(tmpRoot, ".viberevert", "sessions", SESSION_ID);
  const checkpointDir = join(sessionDir, "checkpoint");
  await mkdir(join(checkpointDir, "rollback"), { recursive: true });

  for (const filename of [
    "unstaged.patch",
    "staged.patch",
    "tracked-dirty.tar.gz",
    "untracked.tar.gz",
  ]) {
    await writeFile(join(checkpointDir, "rollback", filename), "");
  }

  // Commit the working files, then record the REAL HEAD, so the fixture
  // describes the repository it lives in and the tree is clean.
  //
  // Both matter for the apply-side tests: a placeholder HEAD refuses on D64
  // head_mismatch and an untracked `.gitignore` / `.viberevert.yml` refuses on
  // D61 dirty_tree, either of which would silently turn a test about selection
  // into a test of a precondition it never meant to exercise.
  await execFileAsync("git", ["add", "-A"], { cwd: tmpRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.test",
      "commit",
      "-q",
      "-m",
      "fixture",
      "--allow-empty",
    ],
    { cwd: tmpRoot },
  );
  const headSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tmpRoot })
  ).stdout.trim();

  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    session_id: SESSION_ID,
    captured_at: STARTED_AT,
    git: { head_sha: headSha, branch: "main", porcelain_v1: "" },
    diffs: {
      unstaged_patch_path: "rollback/unstaged.patch",
      staged_patch_path: "rollback/staged.patch",
    },
    snapshots: {
      tracked_dirty_archive_path: "rollback/tracked-dirty.tar.gz",
      tracked_dirty_paths: [],
      file_hashes: {},
    },
    untracked: { archive_path: "rollback/untracked.tar.gz", exclude_patterns: [], file_hashes: {} },
    rollback_target_description: "Selective-command test fixture",
  };
  await writeFile(join(checkpointDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const contribution = opts.withContribution === true ? await writeContribution() : undefined;

  const session: SessionState = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: SESSION_ID,
    checkpoint_id: CHECKPOINT_ID,
    started_at: STARTED_AT,
    ended_at: ENDED_AT,
    before_status_path: `.viberevert/sessions/${SESSION_ID}/before-status.txt`,
    after_status_path: `.viberevert/sessions/${SESSION_ID}/after-status.txt`,
    // Present so the session is genuinely ended: without the machine-readable
    // snapshot, D61b refuses every apply before the selection is resolved.
    after_status_z_path: `.viberevert/sessions/${SESSION_ID}/after-status.z`,
    commands_log_path: `.viberevert/sessions/${SESSION_ID}/commands.log`,
    ...(contribution !== undefined
      ? { contribution_path: contribution.path, contribution_sha256: contribution.sha256 }
      : {}),
  } as SessionState;
  await writeFile(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));
  await writeFile(join(sessionDir, "before-status.txt"), "");
  await writeFile(join(sessionDir, "after-status.txt"), "");
  // Empty: the session ended with no changed paths, which is a coherent state
  // and keeps the dirty-tree comparison from having anything to disagree with.
  await writeFile(join(sessionDir, "after-status.z"), "");
  await writeFile(join(sessionDir, "commands.log"), "");

  return contribution === undefined ? {} : { contributionSha256: contribution.sha256 };
}

const selectors = (overrides: Partial<SelectionSelectors> = {}): SelectionSelectors => ({
  only: [],
  except: [],
  finding: [],
  ...overrides,
});

// =============================================================================
// A. Pure pre-lock selector validation
// =============================================================================

describe("rollback selectors: validated before the lock", () => {
  it("refuses an unknown --risk level and names the four that exist", async () => {
    await writeMinimalConfig();
    const result = await runRollback([SESSION_ID, "--risk", "urgent"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid --risk "urgent"');
    expect(result.stderr).toContain("low, medium, high, critical");
  });

  it("refuses a --finding PREFIX rather than persisting one a marker cannot express", async () => {
    await writeMinimalConfig();
    const result = await runRollback([SESSION_ID, "--finding", "fnd_abc"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Expected a full finding id");
    expect(result.stderr).toContain("Short prefixes are not accepted yet");
  });

  it("refuses before touching rollback state at all", async () => {
    // No config and no session exist. A validation that ran AFTER the lock
    // would have to report a missing config or session instead, and would have
    // created the lock directory on the way.
    const result = await runRollback([SESSION_ID, "--risk", "urgent"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --risk");
    expect(await exists(join(tmpRoot, ROLLBACK_LOCK_REL))).toBe(false);
  });

  it("accepts a full finding id, which then reaches the locked phase", async () => {
    await writeMinimalConfig();
    const result = await runRollback([SESSION_ID, "--finding", FULL_FINDING_ID]);

    // The session does not exist, so this refuses INSIDE the lock. That is the
    // point: the pure check passed and the command got that far.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("Expected a full finding id");
    expect(result.stderr).toContain(SESSION_ID);
  });

  it("still validates the session id first, whatever selectors are supplied", async () => {
    await writeMinimalConfig();
    const result = await runRollback(["not-a-session", "--only", "src/**"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid session id");
  });
});

// =============================================================================
// B. Mode and selectors are bound to each other
// =============================================================================

describe("resolveRollbackSelectionMode", () => {
  it("no selector at all is full mode, and carries no selectors to disagree with", () => {
    expect(resolveRollbackSelectionMode(selectors())).toEqual({ mode: "full" });
  });

  it.each([
    ["only", selectors({ only: ["src/**"] })],
    ["except", selectors({ except: ["tests/**"] })],
    ["finding", selectors({ finding: [FULL_FINDING_ID] })],
    ["risk", selectors({ risk: "high" })],
  ] as const)("a lone --%s enters selective mode", (_family, supplied) => {
    expect(resolveRollbackSelectionMode(supplied)).toEqual({
      mode: "selective",
      selectors: supplied,
    });
  });

  it("carries the selectors VERBATIM, so mode and intent cannot drift apart", () => {
    const supplied = selectors({ only: ["a/**", "b/**"], except: ["c/**"], risk: "critical" });
    const resolved = resolveRollbackSelectionMode(supplied);

    if (resolved.mode !== "selective") throw new Error("expected selective mode");
    expect(resolved.selectors).toBe(supplied);
  });
});

// =============================================================================
// C. The single-lock boundary
// =============================================================================

describe("rollback holds the rollback lock exactly once", () => {
  it("releases it after a selective refusal", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    const result = await runRollback([SESSION_ID, "--only", "src/**"]);

    expect(result.exitCode).toBe(1);
    expect(await exists(join(tmpRoot, ROLLBACK_LOCK_REL))).toBe(false);
  });

  it("refuses when the lock is already held, selectors and all", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();
    // A bare directory with no lock.json: the "metadata unavailable" variant,
    // which needs no fabricated holder to be a real contention.
    await mkdir(join(tmpRoot, ROLLBACK_LOCK_REL), { recursive: true });

    const result = await runRollback([SESSION_ID, "--only", "src/**"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Another viberevert operation is already running");
    expect(result.stderr).toContain(ROLLBACK_LOCK_REL);
  });

  it("a nested acquisition would deadlock, so a second run inside the same repo is refused", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();
    await mkdir(join(tmpRoot, ROLLBACK_LOCK_REL), { recursive: true });

    // Full mode contends on the SAME lock as selective mode. One boundary, not
    // one per branch.
    const result = await runRollback([SESSION_ID]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Another viberevert operation is already running");
  });
});

// =============================================================================
// D. Post-lock rendering and exit status
// =============================================================================

describe("selective rollback against a session with no contribution", () => {
  it("refuses a preview and says which evidence is missing", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    const result = await runRollback([SESSION_ID, "--only", "src/**"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CONTRIBUTION_REQUIRED");
    expect(result.stdout).toBe("");
  });

  it("writes no receipt of either kind", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    await runRollback([SESSION_ID, "--except", "tests/**"]);

    const sessionDir = join(tmpRoot, ".viberevert", "sessions", SESSION_ID);
    expect(await exists(join(sessionDir, "rollback-dry-run-receipt.json"))).toBe(false);
    expect(await exists(join(sessionDir, "rollback-receipt.json"))).toBe(false);
    expect(await exists(join(sessionDir, "selective-rollback-dry-run-receipt.json"))).toBe(false);
  });

  it("reserves no rollback invocation, so it cannot block a later apply", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    await runRollback([SESSION_ID, "--only", "src/**", "--apply"]);

    // An invocation directory with a marker and no receipt is what the history
    // scan treats as a blocker. A refused operation must leave none.
    const rollbacksDir = join(tmpRoot, ".viberevert", "sessions", SESSION_ID, "rollbacks");
    expect(await exists(rollbacksDir)).toBe(false);
  });

  it("creates no emergency checkpoint, because nothing was ever authorized to mutate", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    await runRollback([SESSION_ID, "--risk", "critical", "--apply"]);

    const checkpointsDir = join(tmpRoot, ".viberevert", "checkpoints");
    const entries = await readdir(checkpointsDir).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("refuses a report-backed selector for its OWN reason, not a contribution one", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    // `--risk` consults a report, and no report exists. The contribution is
    // missing too, and the contribution refusal is the one that must win:
    // without it there is nothing for a report to be stale against.
    const result = await runRollback([SESSION_ID, "--risk", "high"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CONTRIBUTION_REQUIRED");
  });
});

describe("a selection that resolves to nothing", () => {
  const receiptPath = () =>
    join(tmpRoot, ".viberevert", "sessions", SESSION_ID, SELECTIVE_DRY_RUN_RECEIPT);

  const readReceipt = async (): Promise<SelectiveRollbackReceipt> =>
    JSON.parse(await readFile(receiptPath(), "utf8"));

  it("a dry run RECORDS it as empty_selection and exits 0", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession({ withContribution: true });

    const result = await runRollback([SESSION_ID, "--only", "nothing/matches/**"]);

    expect(result.exitCode).toBe(0);
    const receipt = await readReceipt();
    if (receipt.mode !== "dry_run") throw new Error("expected a dry-run receipt");
    expect(receipt.eligibility).toBe("empty_selection");
    expect(receipt.results).toEqual([]);
    expect(receipt.resolved_change_group_ids).toEqual([]);
  });

  it("the recorded receipt names what the selectors were matched against", async () => {
    await writeMinimalConfig();
    const { contributionSha256 } = await writeLegacyEndedSession({ withContribution: true });

    await runRollback([SESSION_ID, "--only", "nothing/matches/**", "--except", "b/**"]);

    const receipt = await readReceipt();
    expect(receipt.session_id).toBe(SESSION_ID);
    expect(receipt.checkpoint_id).toBe(CHECKPOINT_ID);
    // Bound to the digest of the exact bytes the loader verified, so the
    // receipt says which contribution produced this answer.
    expect(receipt.contribution_sha256).toBe(contributionSha256);
    expect(receipt.selectors).toEqual({ only: ["nothing/matches/**"], except: ["b/**"] });
    expect(receipt.rollback_id).toMatch(/^rb_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is written OUTSIDE rollbacks/, so it can never look like an unfinalized attempt", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession({ withContribution: true });

    await runRollback([SESSION_ID, "--only", "nothing/matches/**"]);

    // A receipt inside an invocation directory with no sibling marker is what
    // the history scan reports as inconsistent, which would fail every later
    // apply closed on the strength of a command that mutated nothing.
    expect(await exists(receiptPath())).toBe(true);
    expect(await exists(join(tmpRoot, ".viberevert", "sessions", SESSION_ID, "rollbacks"))).toBe(
      false,
    );
  });

  it("an APPLY refuses it instead, with no receipt and no invocation", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession({ withContribution: true });

    const result = await runRollback([SESSION_ID, "--only", "nothing/matches/**", "--apply"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("nothing to apply");
    expect(await exists(receiptPath())).toBe(false);
    expect(await exists(join(tmpRoot, ".viberevert", "sessions", SESSION_ID, "rollbacks"))).toBe(
      false,
    );
  });

  it("a selection that DOES resolve takes the preview path instead", async () => {
    // The positive control for every assertion above. Without it, an
    // `empty_selection` receipt could be what this command produces for
    // everything, and each test in this group would still pass.
    await writeMinimalConfig();
    await writeLegacyEndedSession({ withContribution: true });

    const result = await runRollback([SESSION_ID, "--only", "src/**"]);

    expect(result.exitCode).toBe(0);
    const receipt = await readReceipt();
    if (receipt.mode !== "dry_run") throw new Error("expected a dry-run receipt");
    expect(receipt.eligibility).not.toBe("empty_selection");
    expect(receipt.results.map((r) => r.path)).toEqual(["src/a.ts"]);
    expect(receipt.resolved_change_group_ids).toHaveLength(1);
    // Both halves of the coupling the schema enforces: a non-empty selection
    // has results AND resolved groups, and it went through the same file.
    expect(result.stdout).toContain('"mode": "dry_run"');
  });

  it("writes both kinds to the SAME session-scoped path, so a preview replaces a preview", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession({ withContribution: true });

    await runRollback([SESSION_ID, "--only", "src/**"]);
    const resolved = await readReceipt();
    await runRollback([SESSION_ID, "--only", "nothing/matches/**"]);
    const empty = await readReceipt();

    if (resolved.mode !== "dry_run" || empty.mode !== "dry_run") {
      throw new Error("expected dry-run receipts");
    }
    // A regenerable artifact with one home. If the empty case had its own
    // path, a stale non-empty preview would sit beside it claiming otherwise.
    expect(resolved.eligibility).toBe("eligible");
    expect(empty.eligibility).toBe("empty_selection");
  });
});

describe("no selectors still means the legacy full-session engine", () => {
  it("writes the legacy dry-run receipt and exits 0", async () => {
    await writeMinimalConfig();
    await writeLegacyEndedSession();

    const result = await runRollback([SESSION_ID]);

    expect(result.exitCode).toBe(0);
    expect(
      await exists(
        join(tmpRoot, ".viberevert", "sessions", SESSION_ID, "rollback-dry-run-receipt.json"),
      ),
    ).toBe(true);
    // The selective preview receipt is a different artifact at a different
    // path, and the full path must never produce one.
    expect(
      await exists(
        join(
          tmpRoot,
          ".viberevert",
          "sessions",
          SESSION_ID,
          "selective-rollback-dry-run-receipt.json",
        ),
      ),
    ).toBe(false);
  });

  it("keeps --force without --apply a pure pre-lock refusal", async () => {
    await writeMinimalConfig();
    const result = await runRollback([SESSION_ID, "--only", "src/**", "--force"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--force has no effect without --apply");
    expect(await exists(join(tmpRoot, ROLLBACK_LOCK_REL))).toBe(false);
  });
});
