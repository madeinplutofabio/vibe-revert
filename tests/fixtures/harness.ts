// tests/fixtures/harness.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Shared golden-fixture harness used by BOTH:
//   - scripts/regen-goldens.ts (write-mode: produces expected/* files)
//   - packages/cli/test/golden-reports.test.ts (verify-mode: compares
//     to expected/* byte-for-byte)
//
// Both consumers MUST agree on the exact same mechanics — env vars,
// subprocess invocation, artifact discovery, comparison/write —
// otherwise CI verification could pass while regenerated goldens
// silently encode different bytes. This shared module is the single
// source of truth for that machinery.
//
// =============================================================================
// Design lock (per the Step 10.1 spec)
// =============================================================================
//
// Boring and narrow:
//   - No framework, no clever abstraction, no extensibility hooks.
//   - One public entrypoint (`runFixture`) that does the whole flow.
//   - Plain procedural helpers (not exported) for the steps.
//   - Schema validation on setup.json is hand-rolled (no zod dep here —
//     this file lives outside any workspace package and shouldn't pull
//     transitive deps).
//
// Determinism env-vars (locked, must match across regen + verify):
//   - VIBEREVERT_TEST_FIXED_NOW       → "2026-01-01T00:00:00Z"
//   - VIBEREVERT_TEST_FIXED_ULID_SEED → "golden"
//   - VIBEREVERT_TEST_FIXED_SHA       → "0000000000000000000000000000000000000000"
//   - VIBEREVERT_TEST_FIXED_VERSION   → "0.7.0-beta"
//
// Git commit env (set ONLY on the harness's own `git commit` calls;
// CLI commands don't commit, so not needed on CLI invocations):
//   - GIT_AUTHOR_DATE / GIT_COMMITTER_DATE → "2026-01-01T00:00:00 +0000"
//   - GIT_AUTHOR_NAME / GIT_COMMITTER_NAME → "Test User"
//   - GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL → "test@example.com"

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Public types
// =============================================================================

/**
 * Per-fixture content file: `path` is repo-relative POSIX, `content`
 * is the literal file body. Used for `files`,
 * `pre_checkpoint_changes`, and `pre_checkpoint_untracked_files`.
 *
 * Path safety is enforced by `validateFixtureFile` at setup.json
 * parse time. The unified segments check (length===0 / "." / "..")
 * rejects absolute paths, empty/dot/dotdot segments (`foo//bar`,
 * `foo/./bar`, `../foo`), trailing slashes (`foo/`), the literal
 * `.`; the colon check rejects Windows drive letters AND alternate-
 * data-stream syntax (`C:/foo`, `foo:bar`); the backslash check
 * rejects Windows path style; and the case-insensitive `.git/`
 * check rejects writes inside the harness's own git state (defending
 * against case-insensitive filesystems like NTFS where `.GIT/config`
 * would otherwise slip through).
 */
export interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Strict shape of `tests/fixtures/<scenario>/setup.json` per D49.
 *
 * `expected_check_exit_code` is REQUIRED — without it, the harness
 * would treat a valid blocker finding (exit 2) as a failed process
 * and the fixture's intent would be ambiguous. Exit 1 is NEVER a
 * valid fixture-expected outcome (it indicates a tool bug).
 */
export interface FixtureSetup {
  readonly files: readonly FixtureFile[];
  readonly git_init: true;
  readonly checkpoint: boolean;
  readonly checkpoint_name?: string;
  readonly task?: string;
  readonly pre_checkpoint_changes?: readonly FixtureFile[];
  readonly pre_checkpoint_untracked_files?: readonly FixtureFile[];
  readonly frameworks?: readonly string[];
  readonly expected_check_exit_code: 0 | 2;
}

export type FixtureMode = "verify" | "regen";

export interface RunFixtureOptions {
  /** Absolute path to `tests/fixtures/<scenario>/`. */
  readonly fixtureDir: string;
  /** Absolute path to `packages/cli/dist/index.js` (the built CLI binary). */
  readonly cliBinAbsPath: string;
  /** "verify" → compare actual to expected/*; "regen" → write expected/*. */
  readonly mode: FixtureMode;
}

// =============================================================================
// Locked constants
// =============================================================================

const FIXED_CLI_ENV: Readonly<Record<string, string>> = {
  VIBEREVERT_TEST_FIXED_NOW: "2026-01-01T00:00:00Z",
  VIBEREVERT_TEST_FIXED_ULID_SEED: "golden",
  VIBEREVERT_TEST_FIXED_SHA: "0000000000000000000000000000000000000000",
  VIBEREVERT_TEST_FIXED_VERSION: "0.7.0-beta",
};

const FIXED_GIT_COMMIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00 +0000",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00 +0000",
  GIT_AUTHOR_NAME: "Test User",
  GIT_COMMITTER_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/**
 * Subprocess buffer cap (stdout AND stderr each). `execFile`'s default
 * is 1MB, which would silently truncate large fixture outputs — e.g.,
 * markdown rendering of 50 findings + 100 changed files could approach
 * or exceed that. 10MB gives substantial headroom for current and
 * near-future fixture sizes without inviting truly pathological
 * cases.
 */
const EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// Canonical ULID-bearing dir-name regexes (kept inline — duplicating
// 2 regex lines is cheaper than importing from session-format and
// configuring the cross-workspace import path resolution).
const RPT_DIR_RE = /^rpt_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESS_DIR_RE = /^sess_[0-9A-HJKMNP-TV-Z]{26}$/;

// =============================================================================
// Public entrypoint
// =============================================================================

/**
 * Run one fixture end-to-end. Either verifies against `expected/*`
 * (mode: "verify") or writes `expected/*` (mode: "regen"). Throws on
 * any mismatch (verify) or unexpected failure (both modes); silent
 * success on regen-mode write.
 *
 * Always cleans up the temp dir, even on throw.
 */
export async function runFixture(opts: RunFixtureOptions): Promise<void> {
  const setup = await loadFixtureSetup(opts.fixtureDir);

  const tmpParent = await mkdtemp(join(tmpdir(), "viberevert-fixture-"));
  const repoRoot = join(tmpParent, "repo");
  try {
    await mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot);
    await writeFixtureFiles(repoRoot, setup.files);

    // Step: viberevert init. Must succeed before downstream steps —
    // a silent init failure would cascade into confusing later
    // errors (commit succeeds on partial state, checkpoint then
    // fails with a config-load error pointing at the symptom not
    // the cause).
    const initResult = await runCliInRepo(opts.cliBinAbsPath, repoRoot, ["init"]);
    if (initResult.exitCode !== 0) {
      throw new Error(
        `Fixture setup: \`viberevert init\` failed (exit ${initResult.exitCode}).\nstdout:\n${initResult.stdout}\nstderr:\n${initResult.stderr}`,
      );
    }

    if (setup.frameworks !== undefined) {
      await patchFrameworksInConfig(repoRoot, setup.frameworks);
    }
    await runGitInRepo(repoRoot, ["add", "."], FIXED_GIT_COMMIT_ENV);
    await runGitInRepo(repoRoot, ["commit", "-q", "-m", "initial"], FIXED_GIT_COMMIT_ENV);

    if (setup.pre_checkpoint_changes !== undefined) {
      await writeFixtureFiles(repoRoot, setup.pre_checkpoint_changes);
    }
    if (setup.pre_checkpoint_untracked_files !== undefined) {
      await writeFixtureFiles(repoRoot, setup.pre_checkpoint_untracked_files);
    }

    if (setup.checkpoint) {
      const name = setup.checkpoint_name ?? "baseline";
      const checkpointResult = await runCliInRepo(opts.cliBinAbsPath, repoRoot, [
        "checkpoint",
        "--name",
        name,
      ]);
      if (checkpointResult.exitCode !== 0) {
        throw new Error(
          `Fixture setup: \`viberevert checkpoint --name ${name}\` failed (exit ${checkpointResult.exitCode}).\nstdout:\n${checkpointResult.stdout}\nstderr:\n${checkpointResult.stderr}`,
        );
      }
    }

    // Apply diff.patch ONLY when non-empty. Whitespace-only or
    // zero-byte patches would fail `git apply` with an opaque
    // empty-input error — the locked harness rule per D49 is to
    // skip in that case.
    const diffPath = join(opts.fixtureDir, "diff.patch");
    const diffContent = await readFile(diffPath, "utf8");
    if (diffContent.trim().length > 0) {
      await runGitInRepo(repoRoot, ["apply", diffPath]);
    }

    // 1) viberevert check — produces persisted report.json AND has
    // the assertable exit code. Stdout from this invocation is NOT
    // compared to any expected/* artifact (the locked design has
    // `viberevert report` produce the terminal/markdown views).
    const checkArgs = buildCheckArgs(setup);
    const checkResult = await runCliInRepo(opts.cliBinAbsPath, repoRoot, checkArgs);
    if (checkResult.exitCode !== setup.expected_check_exit_code) {
      throw new Error(
        `\`viberevert ${checkArgs.join(" ")}\` exited ${checkResult.exitCode}, expected ${setup.expected_check_exit_code}.\nstdout:\n${checkResult.stdout}\nstderr:\n${checkResult.stderr}`,
      );
    }

    const persistedReportPath = await findPersistedReport(repoRoot);
    const actualReportJson = await readFile(persistedReportPath, "utf8");

    // 2) viberevert report (no flag) — terminal rendering of the
    // just-persisted report. Exit 0 always expected (report is a
    // read-only viewer per D47 — never exits 2).
    const reportTerminalResult = await runCliInRepo(opts.cliBinAbsPath, repoRoot, ["report"]);
    if (reportTerminalResult.exitCode !== 0) {
      throw new Error(
        `\`viberevert report\` exited ${reportTerminalResult.exitCode}, expected 0.\nstderr:\n${reportTerminalResult.stderr}`,
      );
    }
    const actualTerminal = reportTerminalResult.stdout;

    // 3) viberevert report --markdown — CommonMark rendering.
    const reportMarkdownResult = await runCliInRepo(opts.cliBinAbsPath, repoRoot, [
      "report",
      "--markdown",
    ]);
    if (reportMarkdownResult.exitCode !== 0) {
      throw new Error(
        `\`viberevert report --markdown\` exited ${reportMarkdownResult.exitCode}, expected 0.\nstderr:\n${reportMarkdownResult.stderr}`,
      );
    }
    const actualMarkdown = reportMarkdownResult.stdout;

    const expectedDir = join(opts.fixtureDir, "expected");
    await mkdir(expectedDir, { recursive: true });
    await verifyOrWrite(join(expectedDir, "report.json"), actualReportJson, opts.mode);
    await verifyOrWrite(join(expectedDir, "report.terminal.txt"), actualTerminal, opts.mode);
    await verifyOrWrite(join(expectedDir, "report.markdown.md"), actualMarkdown, opts.mode);
  } finally {
    // Cleanup temp dir. Restore-of-cwd not needed because the
    // harness uses cwd-as-arg (passed to execFile) — never chdirs.
    await rm(tmpParent, { recursive: true, force: true });
  }
}

/**
 * Read and validate `tests/fixtures/<scenario>/setup.json`. Throws
 * on missing file, invalid JSON, OR violation of the FixtureSetup
 * shape. Validation is hand-rolled (no zod dep in this module).
 */
export async function loadFixtureSetup(fixtureDir: string): Promise<FixtureSetup> {
  const setupPath = join(fixtureDir, "setup.json");
  const raw = await readFile(setupPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Fixture setup.json is not valid JSON at ${setupPath}: ${(err as Error).message}`,
    );
  }
  return validateFixtureSetup(parsed, setupPath);
}

// =============================================================================
// Internal helpers
// =============================================================================

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Invoke the built CLI binary via `node <bin> <args>`. Captures
 * stdout/stderr/exitCode. Does NOT throw on non-zero exit — the
 * caller decides whether the exit code is acceptable (e.g.,
 * `viberevert check` exits 2 on blocker findings, which is a valid
 * outcome for risky fixtures).
 *
 * Always merges FIXED_CLI_ENV on top of process.env so determinism
 * env vars propagate. The CLI's internal git invocations inherit
 * the same env.
 *
 * Buffer cap is EXEC_MAX_BUFFER_BYTES (10MB) instead of the default
 * 1MB — fixture-driven output can grow substantial. On spawn failure
 * (ENOENT, EACCES) where execFile produces no stderr at all, falls
 * back to the error's `.message` so the caller never sees an empty
 * diagnostic.
 */
async function runCliInRepo(
  cliBinAbsPath: string,
  repoRoot: string,
  args: readonly string[],
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...FIXED_CLI_ENV };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliBinAbsPath, ...args], {
      cwd: repoRoot,
      env,
      windowsHide: true,
      maxBuffer: EXEC_MAX_BUFFER_BYTES,
    });
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };
    const exitCode = typeof e.code === "number" ? e.code : 1;
    return {
      exitCode,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
    };
  }
}

/**
 * Invoke `git <args>` in `repoRoot`. Optional `extraEnv` merges on
 * top of process.env — used to inject GIT_AUTHOR_DATE etc. for
 * deterministic commits. Same buffer cap as runCliInRepo.
 */
async function runGitInRepo(
  repoRoot: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  await execFileAsync("git", args as string[], {
    cwd: repoRoot,
    env,
    windowsHide: true,
    maxBuffer: EXEC_MAX_BUFFER_BYTES,
  });
}

/**
 * Initialize a git repo with deterministic config (no gpg signing,
 * no autocrlf line-ending conversion that would diverge between
 * Windows and Linux fixture runs).
 */
async function initGitRepo(repoRoot: string): Promise<void> {
  await runGitInRepo(repoRoot, ["init", "-q", "-b", "main"]);
  await runGitInRepo(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGitInRepo(repoRoot, ["config", "user.name", "Test User"]);
  await runGitInRepo(repoRoot, ["config", "commit.gpgsign", "false"]);
  await runGitInRepo(repoRoot, ["config", "core.autocrlf", "false"]);
}

/**
 * Write each FixtureFile to `repoRoot`. Parent dirs created as
 * needed. Pre-existing files are overwritten (used both for initial
 * files AND for `pre_checkpoint_changes` which modify already-
 * committed files).
 *
 * Path safety is enforced UPSTREAM by `validateFixtureFile` at
 * setup.json parse time — by the time we reach this function, every
 * `file.path` is guaranteed to be a safe repo-relative POSIX file
 * path.
 */
async function writeFixtureFiles(repoRoot: string, files: readonly FixtureFile[]): Promise<void> {
  for (const file of files) {
    const absPath = join(repoRoot, file.path);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, file.content);
  }
}

/**
 * Overwrite the `frameworks: [...]` line in `.viberevert.yml` (or
 * insert if absent). Used when setup.frameworks is provided — lets
 * fixtures override auto-detection without depending on whatever
 * `viberevert init` decided.
 *
 * Intentionally simple string-replace (no YAML parser): the config
 * file is small and structurally predictable since `viberevert init`
 * just wrote it.
 *
 * Strip regex handles ALL realistic init outputs:
 *   - block form with trailing newline:  `frameworks:\n  - foo\n`
 *   - block form WITHOUT trailing newline at EOF: `frameworks:\n  - foo`
 *   - inline form with trailing newline:  `frameworks: []\n`
 *   - inline form WITHOUT trailing newline at EOF: `frameworks: []`
 *   - inline form with content: `frameworks: [foo, bar]`
 * The terminator `(?:\n|$)` accepts EOF — without it, a no-trailing-
 * newline file would leave the old block in place AND the harness
 * would append a new one, producing duplicate top-level
 * `frameworks:` keys → YAML parse error.
 *
 * Empty-array handling: `frameworks: []` is the canonical YAML
 * inline form for "no frameworks". Emitting the block form
 * (`frameworks:\n` with no items) would parse as `null` rather
 * than as an empty list — a fixture explicitly passing `[]` to
 * force "no frameworks" would silently get null. The conditional
 * below emits the inline form for the empty case.
 *
 * Newline safety: ensures the prefix ends in `\n` before appending
 * the frameworks block — otherwise an init-written config missing
 * a trailing newline (or one whose trailing newline got stripped by
 * the regex above) would produce `version: 1frameworks:\n...`
 * (invalid YAML).
 *
 * YAML-safe value quoting: each framework name flows through
 * `JSON.stringify` so any name containing YAML-sensitive characters
 * (`:`, `#`, quotes, etc.) is emitted as a double-quoted scalar.
 * YAML 1.2 accepts JSON-style quoted strings, so this works without
 * pulling a YAML dep — defense-in-depth against future framework
 * names like `"foo:bar"` or `"with #pound"`.
 */
async function patchFrameworksInConfig(
  repoRoot: string,
  frameworks: readonly string[],
): Promise<void> {
  const configPath = join(repoRoot, ".viberevert.yml");
  const existing = await readFile(configPath, "utf8");
  const yamlList = frameworks.map((f) => `  - ${JSON.stringify(f)}`).join("\n");
  const frameworksBlock =
    frameworks.length === 0 ? "frameworks: []\n" : `frameworks:\n${yamlList}\n`;
  const stripped = existing.replace(/^frameworks:.*(?:\n {2}-.*)*(?:\n|$)/m, "");
  const prefix = stripped.length === 0 || stripped.endsWith("\n") ? stripped : `${stripped}\n`;
  await writeFile(configPath, `${prefix}${frameworksBlock}`);
}

/**
 * Build `viberevert check` args from a FixtureSetup. Locked rules:
 *   - checkpoint:true  → `--since <checkpoint_name ?? "baseline">`
 *   - checkpoint:false → `--since HEAD~1`
 *   - task:"..."       → append `--task "..."`
 *
 * The harness doesn't currently support `--staged` fixtures; if a
 * future fixture needs that mode, add a `staged: true` field to
 * FixtureSetup and a branch here.
 */
function buildCheckArgs(setup: FixtureSetup): string[] {
  const args = ["check"];
  if (setup.checkpoint) {
    args.push("--since", setup.checkpoint_name ?? "baseline");
  } else {
    args.push("--since", "HEAD~1");
  }
  if (setup.task !== undefined) {
    args.push("--task", setup.task);
  }
  return args;
}

/**
 * Locate the persisted `report.json` the CLI just wrote. Checks
 * ad-hoc storage first (`.viberevert/reports/rpt_<ULID>/report.json`),
 * then session-bound (`.viberevert/sessions/sess_<ULID>/report.json`).
 *
 * Asserts exactly one report exists across both locations. Throws
 * with a precise message on zero or multiple — both are fixture-
 * setup bugs (the harness should have driven the CLI to produce
 * exactly one report).
 */
async function findPersistedReport(repoRoot: string): Promise<string> {
  const candidates: string[] = [];

  const reportsDir = join(repoRoot, ".viberevert", "reports");
  const rptEntries = await readdirSafe(reportsDir);
  for (const name of rptEntries) {
    if (!RPT_DIR_RE.test(name)) continue;
    candidates.push(join(reportsDir, name, "report.json"));
  }

  const sessionsDir = join(repoRoot, ".viberevert", "sessions");
  const sessEntries = await readdirSafe(sessionsDir);
  for (const name of sessEntries) {
    if (!SESS_DIR_RE.test(name)) continue;
    const candidate = join(sessionsDir, name, "report.json");
    // Session dirs always exist after `viberevert start`, but they
    // only contain `report.json` after `viberevert check` runs
    // against that session. Probe with readFile + ignore-ENOENT.
    try {
      await readFile(candidate, "utf8");
      candidates.push(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  if (candidates.length === 0) {
    throw new Error(`No persisted report.json found under ${repoRoot}/.viberevert/`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Expected exactly 1 persisted report.json under ${repoRoot}/.viberevert/, found ${candidates.length}:\n  ${candidates.join("\n  ")}`,
    );
  }
  // Length === 1; non-null assertion would be cleaner but the
  // codebase prefers explicit narrowing.
  const [only] = candidates;
  if (only === undefined) {
    throw new Error("unreachable: candidates.length === 1 but candidates[0] is undefined");
  }
  return only;
}

/**
 * `readdir` that returns `[]` on ENOENT instead of throwing. Used
 * to probe `.viberevert/reports/` and `.viberevert/sessions/` which
 * may or may not exist depending on which CLI commands ran.
 */
async function readdirSafe(absDir: string): Promise<readonly string[]> {
  try {
    return await readdir(absDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * In verify mode: byte-compare `actualContent` to the file at
 * `expectedPath` and throw with a diff-friendly message on mismatch.
 *
 * In regen mode: write `actualContent` to `expectedPath`. Parent dir
 * was created by the caller (`mkdir(expectedDir, { recursive: true })`
 * in runFixture).
 *
 * UTF-8 throughout. Files committed to git are LF-pinned via
 * .gitattributes, so byte equality is consistent across platforms.
 */
async function verifyOrWrite(
  expectedPath: string,
  actualContent: string,
  mode: FixtureMode,
): Promise<void> {
  if (mode === "regen") {
    await writeFile(expectedPath, actualContent);
    return;
  }
  let expectedContent: string;
  try {
    expectedContent = await readFile(expectedPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Expected fixture artifact missing: ${expectedPath}\nRun \`pnpm regen-goldens\` to create it (review the diff before committing).`,
      );
    }
    throw err;
  }
  if (actualContent !== expectedContent) {
    throw new Error(
      `Fixture artifact byte mismatch at ${expectedPath}\n` +
        `--- expected (${expectedContent.length} bytes)\n` +
        `${expectedContent}\n` +
        `--- actual (${actualContent.length} bytes)\n` +
        `${actualContent}\n` +
        `Re-run \`pnpm regen-goldens\` if this change is intentional (and review the diff carefully).`,
    );
  }
}

// =============================================================================
// FixtureSetup runtime validator (hand-rolled, no zod)
//
// All property accesses on the parsed object use DOT notation via
// per-validator typed-optional-fields shapes (`RawFixtureSetup` /
// `RawFixtureFile`, declared just above each validator). This
// satisfies BOTH conflicting rules:
//   - TypeScript's `noPropertyAccessFromIndexSignature` (enforced
//     by the CLI package's tsconfig, which includes this file via
//     the `tests/fixtures/**/*.ts` glob): the rule forbids dot
//     access on `Record<string, unknown>` index signatures; dot
//     access on a declared property (even optional, even typed
//     `unknown`) is allowed.
//   - Biome's `useLiteralKeys`: prefers `obj.foo` over `obj["foo"]`
//     when the key is a string literal.
// The conflict only arises on `Record<string, unknown>`; typed
// shapes sidestep it entirely. Bonus: typos in the validator
// (`obj.fles` instead of `obj.files`) become compile-time errors
// instead of silent `unknown`.
// =============================================================================

/**
 * Raw-shape cast target for `validateFixtureSetup`. Every field is
 * declared as optional `unknown` so dot access compiles cleanly
 * under both TS strict rules and biome's `useLiteralKeys`; runtime
 * checks below narrow each value before use.
 */
interface RawFixtureSetup {
  files?: unknown;
  git_init?: unknown;
  checkpoint?: unknown;
  checkpoint_name?: unknown;
  task?: unknown;
  pre_checkpoint_changes?: unknown;
  pre_checkpoint_untracked_files?: unknown;
  frameworks?: unknown;
  expected_check_exit_code?: unknown;
}

function validateFixtureSetup(parsed: unknown, sourcePath: string): FixtureSetup {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Fixture setup.json must be an object at ${sourcePath}`);
  }
  const obj = parsed as RawFixtureSetup;

  const filesValue = obj.files;
  if (!Array.isArray(filesValue)) {
    throw new Error(`Fixture setup.json: \`files\` must be an array at ${sourcePath}`);
  }
  const files = filesValue.map((f, i) => validateFixtureFile(f, `${sourcePath}: files[${i}]`));

  if (obj.git_init !== true) {
    throw new Error(`Fixture setup.json: \`git_init\` must be literal \`true\` at ${sourcePath}`);
  }

  const checkpointValue = obj.checkpoint;
  if (typeof checkpointValue !== "boolean") {
    throw new Error(`Fixture setup.json: \`checkpoint\` must be boolean at ${sourcePath}`);
  }

  // checkpoint_name (when set) MUST be a non-empty, non-whitespace
  // string — it flows directly into a `--name` CLI argument and the
  // checkpoint command would reject blank/whitespace values later
  // anyway. Failing here at fixture-validation time gives a clearer
  // error pointing at setup.json rather than at a "viberevert
  // checkpoint failed" wrapping.
  const checkpointNameValue = obj.checkpoint_name;
  if (
    checkpointNameValue !== undefined &&
    (typeof checkpointNameValue !== "string" || checkpointNameValue.trim().length === 0)
  ) {
    throw new Error(
      `Fixture setup.json: \`checkpoint_name\` must be a non-empty string when set at ${sourcePath}`,
    );
  }

  const taskValue = obj.task;
  if (taskValue !== undefined && typeof taskValue !== "string") {
    throw new Error(`Fixture setup.json: \`task\` must be string when set at ${sourcePath}`);
  }

  let pre_checkpoint_changes: readonly FixtureFile[] | undefined;
  const preChangesValue = obj.pre_checkpoint_changes;
  if (preChangesValue !== undefined) {
    if (!Array.isArray(preChangesValue)) {
      throw new Error(
        `Fixture setup.json: \`pre_checkpoint_changes\` must be an array when set at ${sourcePath}`,
      );
    }
    pre_checkpoint_changes = preChangesValue.map((f, i) =>
      validateFixtureFile(f, `${sourcePath}: pre_checkpoint_changes[${i}]`),
    );
  }

  let pre_checkpoint_untracked_files: readonly FixtureFile[] | undefined;
  const preUntrackedValue = obj.pre_checkpoint_untracked_files;
  if (preUntrackedValue !== undefined) {
    if (!Array.isArray(preUntrackedValue)) {
      throw new Error(
        `Fixture setup.json: \`pre_checkpoint_untracked_files\` must be an array when set at ${sourcePath}`,
      );
    }
    pre_checkpoint_untracked_files = preUntrackedValue.map((f, i) =>
      validateFixtureFile(f, `${sourcePath}: pre_checkpoint_untracked_files[${i}]`),
    );
  }

  // frameworks (when set) MUST be an array of non-empty strings.
  // An EMPTY array is explicitly allowed and signals "force no
  // frameworks" — `[].every(...) === true` naturally accepts this.
  // patchFrameworksInConfig emits the canonical inline form
  // `frameworks: []\n` for the empty case.
  let frameworks: readonly string[] | undefined;
  const frameworksValue = obj.frameworks;
  if (frameworksValue !== undefined) {
    if (
      !Array.isArray(frameworksValue) ||
      !frameworksValue.every((s) => typeof s === "string" && s.trim().length > 0)
    ) {
      throw new Error(
        `Fixture setup.json: \`frameworks\` must be an array of non-empty strings; an empty array is allowed to force no frameworks (${sourcePath})`,
      );
    }
    frameworks = frameworksValue as readonly string[];
  }

  const exitCodeValue = obj.expected_check_exit_code;
  if (exitCodeValue !== 0 && exitCodeValue !== 2) {
    throw new Error(
      `Fixture setup.json: \`expected_check_exit_code\` must be literal 0 or 2 at ${sourcePath} (exit 1 is never a valid fixture outcome)`,
    );
  }

  return {
    files,
    git_init: true,
    checkpoint: checkpointValue,
    ...(typeof checkpointNameValue === "string" ? { checkpoint_name: checkpointNameValue } : {}),
    ...(typeof taskValue === "string" ? { task: taskValue } : {}),
    ...(pre_checkpoint_changes !== undefined ? { pre_checkpoint_changes } : {}),
    ...(pre_checkpoint_untracked_files !== undefined ? { pre_checkpoint_untracked_files } : {}),
    ...(frameworks !== undefined ? { frameworks } : {}),
    // exitCodeValue is typed `unknown` and TS can't narrow `unknown`
    // through negative-equality checks; the runtime check above
    // proves it is 0 or 2, so the cast is sound.
    expected_check_exit_code: exitCodeValue as 0 | 2,
  };
}

/**
 * Raw-shape cast target for `validateFixtureFile`. See the
 * RawFixtureSetup docstring for the design rationale.
 */
interface RawFixtureFile {
  path?: unknown;
  content?: unknown;
}

function validateFixtureFile(parsed: unknown, source: string): FixtureFile {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} must be an object`);
  }
  const obj = parsed as RawFixtureFile;
  const pathValue = obj.path;
  const contentValue = obj.content;

  if (typeof pathValue !== "string" || pathValue.length === 0) {
    throw new Error(`${source}.path must be a non-empty string`);
  }

  const segments = pathValue.split("/");
  const lowerPath = pathValue.toLowerCase();

  // Path safety: reject paths that aren't safe repo-relative POSIX
  // file paths. Without these checks, a malformed setup.json could:
  //   - escape the temp repo (`/etc/passwd`, `../../../foo`, `C:/foo`,
  //     `foo:bar` alternate-data-stream on Windows NTFS)
  //   - corrupt the harness's git state (`.git/config`, `.GIT/config`
  //     on case-insensitive filesystems)
  //   - confuse the writer with directory-like paths (`.`, `foo/`,
  //     `foo//bar`, `foo/./bar`)
  //
  // The unified segments check (length===0 / "." / "..") subsumes
  // standalone checks for trailing-slash, dot, and dotdot variants —
  // any path whose split-on-"/" produces an empty / "." / ".."
  // segment is rejected. Includes-":" covers BOTH Windows drive
  // letters AND ADS-style names. Case-insensitive `.git`/`.git/`
  // covers NTFS where `.GIT/config` would otherwise slip through.
  //
  // `.gitignore` is explicitly allowed — sibling of `.git/`, not
  // inside (the prefix check is `.git/` with the trailing slash).
  if (
    pathValue.startsWith("/") ||
    pathValue.includes(":") ||
    pathValue.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    lowerPath === ".git" ||
    lowerPath.startsWith(".git/")
  ) {
    throw new Error(`${source}.path must be a safe repo-relative POSIX file path`);
  }

  if (typeof contentValue !== "string") {
    throw new Error(`${source}.content must be a string`);
  }

  return { path: pathValue, content: contentValue };
}
