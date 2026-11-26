// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// v0.8.0-beta.2: the report-backed selectors, end to end, through the real
// commands.
//
// =============================================================================
// Why this file exists
// =============================================================================
//
// `--risk` and `--finding` never worked in 0.8.0-beta.0 or 0.8.0-beta.1.
// `ReportFileSchema` declares `source_contribution_sha256`,
// `prepareBoundSelectiveRestore` REQUIRES it whenever either selector is used,
// and `buildReportFile` never wrote it. So every normally generated report was
// unbound and both selectors refused with advice that could not be followed:
// re-running `check` reproduced the same unbound report.
//
// Every existing gate missed it, and the reasons are worth stating because they
// determine the shape of this file:
//
//   - all three selective goldens use `--only`, and `--only` / `--except` never
//     consult the binding, so the producer-to-consumer path was never walked;
//   - the one test covering the binding hand-builds a `ReportFile` WITH the
//     field set, so the consumer was proven against a synthetic input while the
//     producer was never asserted at all.
//
// This file therefore consumes the PRODUCER'S OWN OUTPUT throughout. No
// hand-built `ReportFile` appears anywhere in it. That is the whole point: a
// test that constructs the artifact under test cannot detect a missing
// producer.
//
// =============================================================================
// Why not a golden fixture
// =============================================================================
//
// A `finding_id` derives from the session-bound report identity, the rule
// identity and the affected paths. For a session-bound report the `report_id`
// IS the session id, so the finding id is stable across re-runs of `check` for
// one session. But the session id is generated during fixture execution, so a
// static `setup.json` cannot predeclare it. The fixture documentation was right
// about that; the wrong conclusion was that unit tests were therefore enough.
//
// =============================================================================
// Why two independent repositories
// =============================================================================
//
// Each selector gets its own repository and its own session, and both APPLY.
//
// Not two operations against one session: a successful selective apply changes
// the eligibility state for whatever runs next, so a second selector could come
// back `already_at_before` and prove nothing about itself. And not a dry run:
// a preview proves selection and rendering, never that recovery works.
//
// Each repository carries one FLAGGED change group and one UNRELATED unflagged
// one, because the advertised promise is "remove the risky part, keep the rest".
// A fixture with only a flagged group could not tell a selective restore from a
// whole-session one.
//
// The flagged path is `.github/workflows/deploy.yml`, which the
// `generic.gh-actions` path rule matches at level `high` in category
// `deployment` with no framework constraint, so it fires on a plain repository
// without depending on framework detection.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CheckCommand } from "../src/commands/check.js";
import { EndCommand } from "../src/commands/end.js";
import { InitCommand } from "../src/commands/init.js";
import { RollbackCommand } from "../src/commands/rollback.js";
import { StartCommand } from "../src/commands/start.js";

const execFileAsync = promisify(execFile);

/** Generous: each journey drives init, start, end, check and an apply. */
const TIMEOUT_MS = 180_000;

/** The flagged path, and the rule that flags it. */
const FLAGGED_PATH = ".github/workflows/deploy.yml";
const FLAGGING_RULE_ID = "path-classifier.generic.gh-actions";
/** Unrelated to every path rule, so it never carries a finding. */
const UNFLAGGED_PATH = "docs/notes.md";

const UNFLAGGED_BEFORE = "Notes, before.\n";
const UNFLAGGED_AFTER = "Notes, after the agent.\n";

let tmpParent: string;
let originalCwd: string;

beforeEach(async () => {
  tmpParent = await mkdtemp(join(tmpdir(), "viberevert-report-binding-"));
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpParent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// =============================================================================
// Command plumbing (same shape as selective-equivalence.test.ts)
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
// Fixture: one repository, one session, one flagged and one unflagged group
// =============================================================================

interface PreparedSession {
  readonly root: string;
  readonly sessionId: string;
}

async function prepareRepo(root: string, task: string): Promise<PreparedSession> {
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });

  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["config", "core.autocrlf", "false"]);

  // Both paths exist and are committed BEFORE the session, so the session's
  // contribution is a modification of each rather than a creation. That keeps
  // the restore assertion about content rather than about deletion.
  await writeFile(join(root, "README.md"), "# Baseline\n");
  await writeFile(join(root, FLAGGED_PATH), "name: deploy\non: push\njobs: {}\n");
  await writeFile(join(root, UNFLAGGED_PATH), UNFLAGGED_BEFORE);

  process.chdir(root);
  const init = await runCommand(InitCommand, "init", []);
  if (init.exitCode !== 0) throw new Error(`init failed (${init.exitCode}): ${init.stderr}`);

  await git(root, ["add", "-A"]);
  await gitCommit(root, "baseline");

  const start = await runCommand(StartCommand, "start", ["--task", task]);
  if (start.exitCode !== 0) throw new Error(`start failed (${start.exitCode}): ${start.stderr}`);
  const sessionId = start.stdout.match(/sess_[0-9A-HJKMNP-TV-Z]{26}/)?.[0];
  if (sessionId === undefined) {
    throw new Error(`could not parse session id from:\n${start.stdout}`);
  }

  // The agent's work: one risky change, one benign change.
  await writeFile(
    join(root, FLAGGED_PATH),
    "name: deploy\non: push\njobs:\n  ship:\n    runs-on: ubuntu-latest\n",
  );
  await writeFile(join(root, UNFLAGGED_PATH), UNFLAGGED_AFTER);

  const end = await runCommand(EndCommand, "end", []);
  if (end.exitCode !== 0) throw new Error(`end failed (${end.exitCode}): ${end.stderr}`);

  return { root, sessionId };
}

// =============================================================================
// Artifact readers: the producer's own output, never a constructed one
// =============================================================================

interface ReportArtifact {
  readonly kind: string;
  readonly source_contribution_sha256?: string;
  readonly report: {
    readonly results: readonly {
      readonly id: string;
      readonly level: string;
      readonly finding_id?: string;
      readonly affected_paths?: readonly string[];
    }[];
  };
}

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

/**
 * Narrow mutable views for the two artifacts a remediation case edits.
 *
 * Declared shapes rather than `Record<string, unknown>` on purpose: an index
 * signature makes Biome's `useLiteralKeys` demand dot access while tsc's
 * `noPropertyAccessFromIndexSignature` forbids it, so the two tools cannot both
 * be satisfied. Naming the one field each case touches sidesteps the conflict
 * instead of fighting it, and documents what is being tampered with.
 */
interface MutableReport {
  source_contribution_sha256?: string;
}
interface MutableSessionState {
  evaluation_snapshot?: unknown;
}

const readReport = (root: string, sessionId: string): Promise<ReportArtifact> =>
  readJson<ReportArtifact>(join(root, ".viberevert", "sessions", sessionId, "report.json"));

const readSessionState = (
  root: string,
  sessionId: string,
): Promise<{ readonly contribution_sha256?: string }> =>
  readJson(join(root, ".viberevert", "sessions", sessionId, "session.json"));

/** The one apply receipt under `rollbacks/<rb_id>/receipt.json`. */
async function readApplyReceipt(
  root: string,
  sessionId: string,
): Promise<{
  readonly contribution_sha256: string;
  readonly resolved_change_group_ids: readonly string[];
  readonly outcome: string;
}> {
  const { readdir } = await import("node:fs/promises");
  const rollbacksDir = join(root, ".viberevert", "sessions", sessionId, "rollbacks");
  const invocations = (await readdir(rollbacksDir)).filter((name) => name.startsWith("rb_"));
  if (invocations.length !== 1) {
    throw new Error(`expected exactly one apply invocation, found ${invocations.length}`);
  }
  return readJson(join(rollbacksDir, invocations[0] as string, "receipt.json"));
}

// =============================================================================
// The shared journey, parameterized only by the selector under test
// =============================================================================

/**
 * Run `check`, assert the report carries the binding, then apply `selectorArgs`
 * and assert the flagged group was restored while the unflagged one survived.
 *
 * Returns the three digests so the caller can close the evidence chain.
 */
async function runJourney(
  prepared: PreparedSession,
  selectorArgs: (report: ReportArtifact) => string[],
): Promise<{
  sessionDigest: string;
  reportDigest: string;
  receiptDigest: string;
  selectedGroups: readonly string[];
}> {
  const { root, sessionId } = prepared;

  // --- check produces the report ------------------------------------------
  const check = await runCommand(CheckCommand, "check", ["--since", sessionId, "--json"]);
  // `high` findings do not block under the default `risk.block_on: critical`.
  expect(check.exitCode, `check stderr:\n${check.stderr}`).toBe(0);

  const report = await readReport(root, sessionId);
  const session = await readSessionState(root, sessionId);

  expect(report.kind).toBe("session_bound");
  expect(session.contribution_sha256).toBeDefined();

  // THE defect assertion. In beta.0 and beta.1 this field is absent.
  expect(
    report.source_contribution_sha256,
    "check --since must bind the report to the contribution that produced its findings",
  ).toBe(session.contribution_sha256);

  // The fixture must actually produce the flagged finding, or the selector
  // journey below would pass vacuously by selecting nothing.
  const flagged = report.report.results.find((r) => r.id === FLAGGING_RULE_ID);
  expect(
    flagged,
    `expected a ${FLAGGING_RULE_ID} finding; got ${JSON.stringify(
      report.report.results.map((r) => r.id),
    )}`,
  ).toBeDefined();
  expect(flagged?.affected_paths).toEqual([FLAGGED_PATH]);
  expect(flagged?.finding_id).toMatch(/^fnd_[0-9a-f]{64}$/);

  // --- apply the selector --------------------------------------------------
  const rollback = await runCommand(RollbackCommand, "rollback", [
    sessionId,
    ...selectorArgs(report),
    "--apply",
  ]);
  expect(rollback.exitCode, `rollback stderr:\n${rollback.stderr}`).toBe(0);

  // --- the flagged group is back, the unflagged one is not touched ---------
  const flaggedAfter = await readFile(join(root, FLAGGED_PATH), "utf8");
  expect(flaggedAfter).toBe("name: deploy\non: push\njobs: {}\n");

  const unflaggedAfter = await readFile(join(root, UNFLAGGED_PATH), "utf8");
  expect(unflaggedAfter, "an unrelated, unflagged change must survive a selective apply").toBe(
    UNFLAGGED_AFTER,
  );

  const receipt = await readApplyReceipt(root, sessionId);
  expect(receipt.outcome).toBe("succeeded");
  expect(receipt.resolved_change_group_ids).toHaveLength(1);

  return {
    sessionDigest: session.contribution_sha256 as string,
    reportDigest: report.source_contribution_sha256 as string,
    receiptDigest: receipt.contribution_sha256,
    selectedGroups: receipt.resolved_change_group_ids,
  };
}

// =============================================================================
// The two journeys, independently prepared
// =============================================================================

describe("report-backed selectors, end to end", () => {
  it(
    "--finding --apply removes only the flagged change group",
    async () => {
      const prepared = await prepareRepo(join(tmpParent, "finding-journey"), "finding journey");

      const digests = await runJourney(prepared, (report) => {
        const flagged = report.report.results.find((r) => r.id === FLAGGING_RULE_ID);
        return ["--finding", flagged?.finding_id as string];
      });

      // The complete evidence chain: producer, selection, mutation receipt.
      expect(digests.reportDigest).toBe(digests.sessionDigest);
      expect(digests.receiptDigest).toBe(digests.sessionDigest);
    },
    TIMEOUT_MS,
  );

  it(
    "--risk --apply removes only the change groups at or above the threshold",
    async () => {
      const prepared = await prepareRepo(join(tmpParent, "risk-journey"), "risk journey");

      const digests = await runJourney(prepared, () => ["--risk", "high"]);

      expect(digests.reportDigest).toBe(digests.sessionDigest);
      expect(digests.receiptDigest).toBe(digests.sessionDigest);
    },
    TIMEOUT_MS,
  );
});

// =============================================================================
// Remediation, both outcomes
// =============================================================================
//
// After beta.2 an absent binding means one of two things, and they have
// different remedies. The old message offered only "re-run check", which was
// impossible advice for the second case: a session with no evaluation snapshot
// never gains report-backed selectors, because its authoritative session-start
// configuration was never recorded.

describe("an absent binding, and what the user is told to do about it", () => {
  const sessionFile = (root: string, sessionId: string): string =>
    join(root, ".viberevert", "sessions", sessionId, "session.json");
  const reportFileOf = (root: string, sessionId: string): string =>
    join(root, ".viberevert", "sessions", sessionId, "report.json");

  it(
    "a beta.0 or beta.1 unbound report becomes usable after re-running check",
    async () => {
      const { root, sessionId } = await prepareRepo(
        join(tmpParent, "remediable"),
        "remediable report",
      );

      // Produce a real report, then strip the binding to reproduce exactly what
      // beta.0 and beta.1 wrote. Stripping the shipped producer's own output is
      // the honest way to simulate the old version: the rest of the artifact
      // stays byte-for-byte what this build produces.
      const firstCheck = await runCommand(CheckCommand, "check", ["--since", sessionId]);
      expect(firstCheck.exitCode).toBe(0);

      const reportPath = reportFileOf(root, sessionId);
      const asShipped = await readJson<MutableReport>(reportPath);
      expect(asShipped.source_contribution_sha256).toBeDefined();
      delete asShipped.source_contribution_sha256;
      await writeFile(reportPath, `${JSON.stringify(asShipped, null, 2)}\n`);

      // The refusal fires, and it names both remedies.
      const refused = await runCommand(RollbackCommand, "rollback", [sessionId, "--risk", "high"]);
      expect(refused.exitCode).toBe(1);
      const refusalText = `${refused.stdout}${refused.stderr}`.replace(/\s+/g, " ");
      expect(refusalText).toContain("not bound to the session contribution");
      expect(refusalText).toContain("re-run");

      // Following the first remedy works, which is the whole point: in beta.0
      // and beta.1 this step reproduced the same unbound report.
      const secondCheck = await runCommand(CheckCommand, "check", ["--since", sessionId]);
      expect(secondCheck.exitCode).toBe(0);

      const rebound = await readJson<MutableReport>(reportPath);
      expect(rebound.source_contribution_sha256).toBeDefined();

      const after = await runCommand(RollbackCommand, "rollback", [sessionId, "--risk", "high"]);
      expect(after.exitCode, `rollback stderr:\n${after.stderr}`).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    "a session with no evaluation snapshot is told to use path selectors instead",
    async () => {
      const { root, sessionId } = await prepareRepo(
        join(tmpParent, "legacy"),
        "legacy-shaped session",
      );

      // Remove the snapshot to reproduce a session started before 0.8.0. The
      // contribution stays on disk and stays valid, which is exactly the real
      // shape: the evidence exists, but nothing records what configuration was
      // authoritative when the session began, so it can never drive evaluation.
      const statePath = sessionFile(root, sessionId);
      const state = await readJson<MutableSessionState>(statePath);
      expect(state.evaluation_snapshot).toBeDefined();
      delete state.evaluation_snapshot;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      // Re-running check cannot bind this report, so the advice must not be
      // "re-run check" alone.
      const check = await runCommand(CheckCommand, "check", ["--since", sessionId]);
      expect(check.exitCode).toBe(0);
      const report = await readJson<MutableReport>(reportFileOf(root, sessionId));
      expect(report.source_contribution_sha256).toBeUndefined();

      const refused = await runCommand(RollbackCommand, "rollback", [sessionId, "--risk", "high"]);
      expect(refused.exitCode).toBe(1);
      // Whitespace-normalized: the renderer wraps, so asserting raw substrings
      // would pin the wrap column rather than the message.
      const refusalText = `${refused.stdout}${refused.stderr}`.replace(/\s+/g, " ");
      expect(refusalText).toContain("not bound to the session contribution");
      expect(refusalText).toContain("no evaluation snapshot");
      expect(refusalText).toContain("--only");

      // And the alternative the message offers actually works.
      const viaPaths = await runCommand(RollbackCommand, "rollback", [
        sessionId,
        "--only",
        `${FLAGGED_PATH}`,
      ]);
      expect(viaPaths.exitCode, `rollback stderr:\n${viaPaths.stderr}`).toBe(0);
    },
    TIMEOUT_MS,
  );
});
