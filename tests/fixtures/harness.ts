// tests/fixtures/harness.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Shared golden-fixture harness used by:
//   - scripts/regen-goldens.ts (write-mode: produces expected/* files)
//   - packages/cli/test/golden-reports.test.ts (verify-mode for report goldens)
//   - packages/cli/test/golden-receipts.test.ts (verify-mode for rollback receipt goldens)
//
// All consumers MUST agree on the exact same mechanics — env vars,
// subprocess invocation, artifact discovery, comparison/write —
// otherwise CI verification could pass while regenerated goldens
// silently encode different bytes. This shared module is the single
// source of truth for that machinery.
//
// =============================================================================
// Design lock (per the Step 10.1 spec; extended by M D Step 8 for receipts)
// =============================================================================
//
// Boring and narrow:
//   - No framework, no clever abstraction.
//   - Two public entrypoints:
//       * `runFixture` for M C report fixtures under tests/fixtures/
//       * `runReceiptFixture` for M D rollback receipt fixtures under tests/fixtures-rollback/
//   - Shared private helpers for env vars, subprocess invocation, git setup,
//     file writing, and verify/write comparison.
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
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

    // 4) viberevert prompt-fix — M E D91 / Step 4 extension. Data-
    // driven: branch on the ACTUAL persisted report's findings count
    // (NOT on a setup.json field — the harness verifies behavior
    // against the persisted artifact, never a reconstruction).
    // Two paths:
    //
    //   - Non-empty findings: prompt-fix MUST exit 0 with empty
    //     stderr, persist the sibling fix-prompt.txt, AND emit a
    //     stdout that is byte-identical to the persisted file (D81
    //     dual-sink contract — compared as raw bytes via
    //     Buffer.equals, not string equality). The persisted bytes
    //     are LF-only checked, then verifyOrWrite'd against
    //     expected/fix-prompt.txt.
    //
    //   - Empty findings: prompt-fix MUST exit 1 with the EXACT D86
    //     refusal copy on stderr (locks against any other exit-1
    //     path — repo-not-found, parse-failure, drift, etc. — that
    //     would otherwise silently pass a count-only check) and
    //     empty stdout. The sibling fix-prompt.txt MUST NOT exist
    //     after the refusal. expected/fix-prompt.txt MUST NOT exist
    //     for the fixture (regen-mode deletes any stale one AFTER
    //     the command-refusal checks pass; verify-mode fails if
    //     present) — empty-findings fixtures intentionally have no
    //     prompt golden, so a leftover from a prior non-empty
    //     iteration cannot silently survive a fixture revision.
    //
    // VIBEREVERT_TEST_FIXED_VERSION is in FIXED_CLI_ENV so the
    // footer "Generated by VibeRevert v<version>" is byte-stable
    // across Windows/Linux runs AND across the workspace's actual
    // package version.
    //
    // The persisted report is re-read from disk (NOT reusing
    // actualReportJson) so the branch is tied to the persisted
    // artifact at persistedReportPath — survives a future refactor
    // where actualReportJson might come from a different source.
    const persistedReportJson = await readFile(persistedReportPath, "utf8");
    const reportData = JSON.parse(persistedReportJson) as {
      report_id?: unknown;
      report?: { results?: unknown };
    };
    const persistedResults = reportData.report?.results;
    if (!Array.isArray(persistedResults)) {
      throw new Error(
        `Persisted report at ${persistedReportPath} has no \`report.results\` array — fixture is corrupt OR the M C schema has drifted.`,
      );
    }
    const reportId = reportData.report_id;
    if (typeof reportId !== "string") {
      throw new Error(
        `Persisted report at ${persistedReportPath} has no string \`report_id\` — fixture is corrupt OR the M C schema has drifted.`,
      );
    }
    const findingsCount = persistedResults.length;

    // D82 at the harness layer: the persisted sibling fix-prompt.txt
    // MUST live in the same directory as the source report.json.
    // Catches a regression where the resolver routes the sibling
    // write to a different location.
    const siblingFixPromptPath = join(dirname(persistedReportPath), "fix-prompt.txt");
    const expectedFixPromptPath = join(expectedDir, "fix-prompt.txt");

    if (findingsCount > 0) {
      const promptFixResult = await runCliInRepo(opts.cliBinAbsPath, repoRoot, ["prompt-fix"]);
      if (promptFixResult.exitCode !== 0) {
        throw new Error(
          `\`viberevert prompt-fix\` exited ${promptFixResult.exitCode}, expected 0 (fixture has ${findingsCount} findings).\nstdout:\n${promptFixResult.stdout}\nstderr:\n${promptFixResult.stderr}`,
        );
      }
      // Locks no silent warnings on success — any stderr output
      // would otherwise become golden-approved on the next regen.
      if (promptFixResult.stderr !== "") {
        throw new Error(
          `\`viberevert prompt-fix\` wrote unexpected stderr on success:\n${promptFixResult.stderr}`,
        );
      }
      // D81 dual-sink byte-identity — compare raw bytes via
      // Buffer.equals (NOT string equality, which could
      // theoretically pass under degenerate Unicode normalization
      // edge cases).
      const persistedFixPromptBytes = await readFile(siblingFixPromptPath);
      const stdoutBytes = Buffer.from(promptFixResult.stdout, "utf8");
      if (!stdoutBytes.equals(persistedFixPromptBytes)) {
        throw new Error(
          `\`viberevert prompt-fix\` stdout differs from persisted fix-prompt.txt at ${siblingFixPromptPath} — D81 dual-sink contract violation.\nstdout (${stdoutBytes.length} bytes):\n${promptFixResult.stdout}\npersisted (${persistedFixPromptBytes.length} bytes):\n${persistedFixPromptBytes.toString("utf8")}`,
        );
      }
      // LF-only invariant — catches accidental CRLF persistence on
      // Windows BEFORE goldens normalize the wrong line endings.
      // Byte 13 (0x0D) is CR; the renderer's normalizers should
      // strip CRLF / lone CR from all dynamic content per D85.7,
      // and the template-owned text is ASCII-only.
      if (persistedFixPromptBytes.includes(13)) {
        throw new Error(
          `Persisted fix-prompt.txt at ${siblingFixPromptPath} contains CR bytes (0x0D); golden prompts must be LF-only.`,
        );
      }
      await verifyOrWrite(
        expectedFixPromptPath,
        persistedFixPromptBytes.toString("utf8"),
        opts.mode,
      );
    } else {
      const promptFixResult = await runCliInRepo(opts.cliBinAbsPath, repoRoot, ["prompt-fix"]);
      if (promptFixResult.exitCode !== 1) {
        throw new Error(
          `\`viberevert prompt-fix\` against empty-findings fixture exited ${promptFixResult.exitCode}, expected 1 (D86 empty-findings refusal).\nstdout:\n${promptFixResult.stdout}\nstderr:\n${promptFixResult.stderr}`,
        );
      }
      // Lock the EXACT D86 refusal copy on stderr — without this,
      // ANY exit-1 path (repo-not-found, parse-failure, drift,
      // I/O failure, etc.) would silently pass the count check
      // above. The expected stderr embeds reportId from the parsed
      // persisted report so a future schema/wording drift surfaces
      // here too.
      const expectedEmptyFindingsStderr =
        `Report ${reportId} contains no findings; nothing to prompt-fix. ` +
        "Run `viberevert check ...` against fresh changes to generate a report with findings.\n";
      if (promptFixResult.stderr !== expectedEmptyFindingsStderr) {
        throw new Error(
          `\`viberevert prompt-fix\` empty-findings stderr drifted from D86 verbatim.\nexpected:\n${expectedEmptyFindingsStderr}\nactual:\n${promptFixResult.stderr}`,
        );
      }
      // Empty-findings refusal MUST NOT emit stdout — no prompt
      // text to a user who just got a refusal.
      if (promptFixResult.stdout !== "") {
        throw new Error(
          `\`viberevert prompt-fix\` emitted stdout on empty-findings refusal:\n${promptFixResult.stdout}`,
        );
      }
      // Sibling fix-prompt.txt MUST NOT exist after the refusal.
      let siblingExists = false;
      try {
        await lstat(siblingFixPromptPath);
        siblingExists = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (siblingExists) {
        throw new Error(
          `\`viberevert prompt-fix\` empty-findings refusal left a sibling fix-prompt.txt at ${siblingFixPromptPath} — D86 contract violation.`,
        );
      }
      // expected/fix-prompt.txt MUST NOT exist for empty-findings
      // fixtures. Order matters: only delete the stale golden AFTER
      // proving the command refused correctly above — otherwise a
      // broken command could still leave the fixture looking clean.
      let expectedExists = false;
      try {
        await lstat(expectedFixPromptPath);
        expectedExists = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (opts.mode === "regen") {
        if (expectedExists) {
          await rm(expectedFixPromptPath, { force: true });
        }
      } else if (expectedExists) {
        throw new Error(
          `expected/fix-prompt.txt exists for empty-findings fixture at ${expectedFixPromptPath} — empty-findings fixtures must NOT have a golden prompt artifact (per the locked Step 4 design). Run \`pnpm regen-goldens\` to remove it.`,
        );
      }
    }
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

// =============================================================================
// Receipt-fixture extension (M D Step 8)
//
// Parallel public entrypoint `runReceiptFixture` for the M D rollback-receipt
// golden fixtures. Lives in the same file as the report-fixture machinery
// (NOT extracted to a sibling module) because the locked env-var constants
// + private helpers (runCliInRepo, initGitRepo, writeFixtureFiles,
// verifyOrWrite, validateFixtureFile) are SHARED with the report path, and
// the file-header lock makes that sharing canonical.
//
// =============================================================================
// Receipt-fixture design (locked per Step 8 Substep B)
// =============================================================================
//
// 1. **Refusal vs receipt-producing split is by `expected_receipt`, NOT
//    by exit code.** Lock #16 (M D Step 7) decouples the two: an apply
//    attempt that reaches the receipt-build stage writes a receipt
//    regardless of whether restoreCheckpoint succeeded. So a fixture can
//    have `expected_rollback_exit_code: 1` AND `expected_receipt: true`
//    (e.g., extraction-conflict failures). The harness branches on the
//    explicit `expected_receipt` flag — never on exit code as a proxy.
//
// 2. **Validator cross-checks on exit-code × expected_receipt × mode.**
//      - `expected_receipt: false` ⇒ exit code MUST be 1 (refusals
//        never exit 0).
//      - `expected_receipt: true` + `mode: dry_run` + `force: true` is
//        impossible (--force without --apply triggers the CLI's
//        flag-validation refusal in rollback.ts BEFORE any receipt is
//        built).
//      - `expected_receipt: true` + `mode: dry_run` requires exit 0
//        (D66: successful dry-run always exits 0).
//
// 3. **Receipt-producing scenarios run THREE times per fixture.** Each
//    format flag (terminal / markdown / json) gets a fresh setup-and-end
//    sequence because `viberevert rollback --apply` mutates state and
//    D70 blocks re-apply. Dry-run scenarios technically could share one
//    setup but use the same fresh-per-format discipline for shape
//    uniformity.
//
// 4. **JSON byte-identity assertion between stdout and persisted file.**
//    Per `rollback.ts`'s `writeReceiptAtomically` + `--json` rendering
//    path, the stdout `JSON.stringify(receipt, null, 2) + "\n"` is
//    byte-identical to the persisted file content. The json-format run
//    asserts this identity explicitly — locks the contract at the
//    harness seam.
//
// 5. **Stream-discipline assertions per scenario class.**
//      - Receipt-producing: stderr MUST be empty. Receipt rendering
//        goes to stdout exclusively; any stderr write indicates an
//        unexpected diagnostic / warning / CLI error.
//      - Refusal: stdout MUST be empty. Refusals write the user-
//        facing message to stderr only; any stdout output indicates
//        a leaked render or partial success.
//      - Both classes assert exit code matches setup.
//
// 6. **D68 path-split discipline assertion (receipt-producing only).**
//    After confirming the expected receipt path exists, the harness
//    additionally asserts the WRONG path is ABSENT — a dry-run scenario
//    must NOT create the apply receipt path, and an apply scenario must
//    NOT create the dry-run receipt path. Locks the named-path discipline
//    (lock #4 in rollback.ts) at the fixture seam too.
//
// 7. **Session id parsed from start's stdout via forgiving regex.** First
//    `/sess_[0-9A-HJKMNP-TV-Z]{26}/` match anywhere; cp_/rb_ prefixes
//    won't false-match.
//
// 8. **Pre-session untracked files semantics.**
//    `pre_session_untracked_files` writes files AFTER the initial
//    commit but BEFORE `viberevert start`, so they exist as untracked
//    at session-start time and get captured into the checkpoint's
//    untracked archive. The `partial-failure-extraction-conflict`
//    fixture uses this to write `subdir/file.txt` pre-session so the
//    checkpoint's untracked tarball contains it — the extraction-
//    conflict mechanism then re-creates a directory at the same path
//    (see lock #9 below) to force `tar.extract` to fail.
//
//    By contrast, `session.untracked_files` writes happen AFTER start,
//    so they're "during-session changes" rather than checkpoint-captured
//    state. Both fields coexist for different semantics; the fixture
//    picks the right one for what it's testing.
//
// 9. **`post_end_transformations` ordering is LOCKED.** Three fields,
//    applied in EXACTLY this order:
//      1. `delete_paths` — rm -rf each path.
//      2. `create_dirs`  — recursive mkdir each path.
//      3. `create_files` — write each regular file.
//
//    The order matters because the extraction-conflict fixture depends
//    on an EMPTY SUBDIRECTORY surviving the delete pass. Mechanism for
//    `partial-failure-extraction-conflict`:
//      - `pre_session_untracked_files` captures `subdir/file.txt`.
//      - `delete_paths: ["subdir/file.txt", "subdir"]` clears the
//        original captured tree.
//      - `create_dirs: ["subdir/file.txt/blocker"]` creates a directory
//        at `subdir/file.txt/` containing an empty `blocker/` subdir.
//    At rollback-apply time:
//      - `git ls-files --others` does NOT enumerate empty directories,
//        so `deleteUncapturedUntracked` cannot delete `blocker/`.
//      - `clearExtractionPathConflicts` lstat's `subdir/file.txt`,
//        sees a non-empty directory, tries `rmdir`, gets ENOTEMPTY,
//        pushes a structured conflict, and `restoreCheckpoint` throws
//        `RestoreExtractionConflictError` per restore.ts file header
//        invariant #1. Per Lock #16, the apply receipt is still
//        persisted with populated `failures[]` and empty `results[]`.
//
//    DO NOT replace the empty-subdir mechanism with a regular-file
//    blocker (e.g., `create_files: [{path: "subdir", ...}]`). A regular
//    file at `subdir` would be enumerated by `git ls-files --others`,
//    classified as uncaptured-untracked, and DELETED by the delete
//    pass BEFORE the cleanup pass runs. The captured path's parent
//    would then be clearable, restore would succeed, and the fixture
//    would no longer test `extraction_conflict`. The empty-subdir
//    mechanism is the locked recipe — mirrored 1:1 from the existing
//    git-test at `packages/git/test/restore.test.ts:533`.
//
//    No `post_end_commits` / `post_end_git` / shell-hook fields exist
//    here intentionally. Committing a blocker would advance HEAD and
//    trip D64 HEAD-mismatch BEFORE restore runs — a second wrong
//    mechanism. `create_dirs` is the locked harness extension.

/**
 * Receipt-fixture setup schema. Parallel to FixtureSetup but driven by the
 * session lifecycle (start → modify → end → rollback) rather than the
 * report lifecycle (checkpoint → diff → check → report).
 *
 * `expected_rollback_exit_code` is REQUIRED — 0 (successful dry-run or
 * apply-clean) or 1 (refusal, missing artifacts, apply-with-failures).
 * Exit 2 is NEVER a valid rollback fixture outcome per D66.
 *
 * `expected_receipt` is REQUIRED and decouples receipt-existence from
 * exit code per Lock #16. `false` means refusal-before-receipt (and
 * exit code must be 1); `true` means a receipt is persisted regardless
 * of exit code (apply attempts that fail mid-restore still write
 * receipts per Lock #16).
 *
 * `pre_session_untracked_files` (optional) writes files BEFORE
 * `viberevert start` so they're captured in the checkpoint's untracked
 * archive. Use this for fixtures that need the captured tarball to
 * contain specific files (e.g., extraction-conflict scenarios). For
 * during-session content changes, use `session.untracked_files` /
 * `session.modifications` instead — those write AFTER start so they
 * become session-created/modified files rather than captured state.
 */
export interface ReceiptFixtureSetup {
  readonly files: readonly FixtureFile[];
  readonly git_init: true;
  readonly pre_session_untracked_files?: readonly FixtureFile[];
  readonly session: {
    readonly task?: string;
    readonly modifications?: readonly FixtureFile[];
    readonly untracked_files?: readonly FixtureFile[];
  };
  readonly unrelated_dirt_after_end?: readonly FixtureFile[];
  readonly post_end_transformations?: {
    readonly delete_paths?: readonly string[];
    readonly create_dirs?: readonly string[];
    readonly create_files?: readonly FixtureFile[];
  };
  readonly rollback_invocation: {
    readonly mode: "dry_run" | "apply";
    readonly force: boolean;
  };
  readonly expected_rollback_exit_code: 0 | 1;
  readonly expected_receipt: boolean;
}

export interface RunReceiptFixtureOptions {
  readonly fixtureDir: string;
  readonly cliBinAbsPath: string;
  readonly mode: FixtureMode;
}

type ReceiptFormat = "terminal" | "markdown" | "json";

const RECEIPT_FORMATS: readonly ReceiptFormat[] = ["terminal", "markdown", "json"];

/**
 * Run one receipt fixture end-to-end. Branches on `setup.expected_receipt`:
 *   - false → refusal-scenario runner (single setup, assert exit code +
 *     no receipt files written + empty stdout).
 *   - true → receipt-producing runner (3 fresh setups, one per format,
 *     capture stdout + assert persisted receipt exists + assert wrong
 *     D68 path absent + byte-compare stdout to persisted for json
 *     format + empty stderr; verify/write golden artifacts).
 *
 * Always cleans up each per-format temp dir, even on throw.
 */
export async function runReceiptFixture(opts: RunReceiptFixtureOptions): Promise<void> {
  const setup = await loadReceiptFixtureSetup(opts.fixtureDir);

  if (!setup.expected_receipt) {
    await runRefusalReceiptScenario({ opts, setup });
    return;
  }

  const captured: Record<ReceiptFormat, string> = {
    terminal: "",
    markdown: "",
    json: "",
  };
  for (const format of RECEIPT_FORMATS) {
    captured[format] = await runOneReceiptProducingScenario({ opts, setup, format });
  }

  const expectedDir = join(opts.fixtureDir, "expected");
  await mkdir(expectedDir, { recursive: true });
  await verifyOrWrite(join(expectedDir, "receipt.json"), captured.json, opts.mode);
  await verifyOrWrite(join(expectedDir, "receipt.terminal.txt"), captured.terminal, opts.mode);
  await verifyOrWrite(join(expectedDir, "receipt.markdown.md"), captured.markdown, opts.mode);
}

/**
 * Read and validate `tests/fixtures-rollback/<scenario>/setup.json`.
 * Throws on missing file, invalid JSON, OR violation of the
 * ReceiptFixtureSetup shape (including the
 * expected_receipt × exit-code × mode cross-checks).
 *
 * Private to this module — no external consumer needs it; the public
 * `runReceiptFixture` entrypoint calls it internally.
 */
async function loadReceiptFixtureSetup(fixtureDir: string): Promise<ReceiptFixtureSetup> {
  const setupPath = join(fixtureDir, "setup.json");
  const raw = await readFile(setupPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Receipt fixture setup.json is not valid JSON at ${setupPath}: ${(err as Error).message}`,
    );
  }
  return validateReceiptFixtureSetup(parsed, setupPath);
}

// =============================================================================
// Refusal scenario runner
// =============================================================================

async function runRefusalReceiptScenario(args: {
  readonly opts: RunReceiptFixtureOptions;
  readonly setup: ReceiptFixtureSetup;
}): Promise<void> {
  const tmpParent = await mkdtemp(join(tmpdir(), "viberevert-receipt-fixture-"));
  const repoRoot = join(tmpParent, "repo");
  try {
    await mkdir(repoRoot, { recursive: true });

    // Pre-check: assert the fixture's own expected/ directory does
    // not exist on disk before the scenario runs. Catches a stale
    // dir committed by a prior contributor (e.g., regen ran against
    // a misclassified setup.json before the misclassification was
    // corrected). Paired with an after-check below for defense in
    // depth.
    await assertRefusalFixtureHasNoExpectedDir(args.opts.fixtureDir);

    const sessionId = await setupSessionAndEnd({
      opts: args.opts,
      setup: args.setup,
      repoRoot,
    });

    if (args.setup.unrelated_dirt_after_end !== undefined) {
      await writeFixtureFiles(repoRoot, args.setup.unrelated_dirt_after_end);
    }
    if (args.setup.post_end_transformations !== undefined) {
      await applyPostEndTransformations(repoRoot, args.setup.post_end_transformations);
    }

    const rollbackArgs = buildRollbackArgs({
      sessionId,
      invocation: args.setup.rollback_invocation,
      format: "terminal",
    });
    const result = await runCliInRepo(args.opts.cliBinAbsPath, repoRoot, rollbackArgs);
    if (result.exitCode !== args.setup.expected_rollback_exit_code) {
      throw new Error(
        `Receipt fixture refusal-scenario expected exit ${args.setup.expected_rollback_exit_code} but got ${result.exitCode}.\n` +
          `args: ${rollbackArgs.join(" ")}\n` +
          `stdout:\n${result.stdout}\n` +
          `stderr:\n${result.stderr}`,
      );
    }

    // Lock #5 stream discipline: refusal writes stderr only; stdout
    // MUST be empty (no leaked render, no partial success).
    if (result.stdout.length > 0) {
      throw new Error(
        `Refusal scenario wrote unexpected stdout.\n` +
          `args: ${rollbackArgs.join(" ")}\n` +
          `stdout:\n${result.stdout}`,
      );
    }

    const dryRunPath = join(
      repoRoot,
      ".viberevert",
      "sessions",
      sessionId,
      "rollback-dry-run-receipt.json",
    );
    const applyPath = join(repoRoot, ".viberevert", "sessions", sessionId, "rollback-receipt.json");
    if (await pathExists(dryRunPath)) {
      throw new Error(
        `Refusal scenario should produce NO dry-run receipt, but found one at ${dryRunPath}`,
      );
    }
    if (await pathExists(applyPath)) {
      throw new Error(
        `Refusal scenario should produce NO apply receipt, but found one at ${applyPath}`,
      );
    }

    // Post-check: re-assert the fixture's own expected/ directory
    // does not exist. Defensive against a future harness regression
    // that might accidentally write into the fixture directory
    // during the scenario.
    await assertRefusalFixtureHasNoExpectedDir(args.opts.fixtureDir);
  } finally {
    await rm(tmpParent, { recursive: true, force: true });
  }
}

// =============================================================================
// Receipt-producing scenario runner (one format per call; called 3 times
// per fixture). Accepts exit code 0 OR 1 per setup.expected_rollback_exit_code
// — Lock #16's apply-attempt semantics mean exit 1 can still produce a
// receipt.
// =============================================================================

async function runOneReceiptProducingScenario(args: {
  readonly opts: RunReceiptFixtureOptions;
  readonly setup: ReceiptFixtureSetup;
  readonly format: ReceiptFormat;
}): Promise<string> {
  const tmpParent = await mkdtemp(join(tmpdir(), "viberevert-receipt-fixture-"));
  const repoRoot = join(tmpParent, "repo");
  try {
    await mkdir(repoRoot, { recursive: true });
    const sessionId = await setupSessionAndEnd({
      opts: args.opts,
      setup: args.setup,
      repoRoot,
    });

    if (args.setup.unrelated_dirt_after_end !== undefined) {
      await writeFixtureFiles(repoRoot, args.setup.unrelated_dirt_after_end);
    }
    if (args.setup.post_end_transformations !== undefined) {
      await applyPostEndTransformations(repoRoot, args.setup.post_end_transformations);
    }

    const rollbackArgs = buildRollbackArgs({
      sessionId,
      invocation: args.setup.rollback_invocation,
      format: args.format,
    });
    const result = await runCliInRepo(args.opts.cliBinAbsPath, repoRoot, rollbackArgs);
    if (result.exitCode !== args.setup.expected_rollback_exit_code) {
      throw new Error(
        `Receipt fixture receipt-producing-scenario expected exit ${args.setup.expected_rollback_exit_code} but got ${result.exitCode}.\n` +
          `format: ${args.format}\n` +
          `args: ${rollbackArgs.join(" ")}\n` +
          `stdout:\n${result.stdout}\n` +
          `stderr:\n${result.stderr}`,
      );
    }

    // Lock #5 stream discipline: receipt-producing scenarios route the
    // receipt rendering to stdout. stderr MUST be empty — any output
    // there indicates an unexpected diagnostic, warning, or partial
    // failure that should fail the fixture loudly.
    if (result.stderr.length > 0) {
      throw new Error(
        `Receipt-producing scenario wrote unexpected stderr.\n` +
          `format: ${args.format}\n` +
          `args: ${rollbackArgs.join(" ")}\n` +
          `stderr:\n${result.stderr}`,
      );
    }

    const receiptFilename =
      args.setup.rollback_invocation.mode === "apply"
        ? "rollback-receipt.json"
        : "rollback-dry-run-receipt.json";
    const receiptPath = join(repoRoot, ".viberevert", "sessions", sessionId, receiptFilename);
    const persistedBytes = await readFile(receiptPath, "utf8").catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Receipt-producing scenario should have written ${receiptFilename}, but it is missing at ${receiptPath}`,
        );
      }
      throw err;
    });

    // Lock #6 D68 path-split discipline: the WRONG path must be ABSENT.
    // Dry-run must NOT create the apply path; apply must NOT touch
    // the dry-run path (apply may PRESERVE an existing dry-run receipt
    // byte-identically per rollback.test.ts F-2, but a fresh-setup
    // receipt-producing scenario starts from no dry-run receipt at
    // all, so the absence assertion holds in this harness).
    const wrongReceiptFilename =
      args.setup.rollback_invocation.mode === "apply"
        ? "rollback-dry-run-receipt.json"
        : "rollback-receipt.json";
    const wrongReceiptPath = join(
      repoRoot,
      ".viberevert",
      "sessions",
      sessionId,
      wrongReceiptFilename,
    );
    if (await pathExists(wrongReceiptPath)) {
      throw new Error(
        `Receipt-producing scenario wrote the wrong D68 receipt path: ${wrongReceiptPath}`,
      );
    }

    if (args.format === "json" && result.stdout !== persistedBytes) {
      throw new Error(
        `Receipt fixture json-format stdout does not byte-match the persisted receipt at ${receiptPath}\n` +
          `--- stdout (${result.stdout.length} bytes)\n${result.stdout}\n` +
          `--- persisted (${persistedBytes.length} bytes)\n${persistedBytes}`,
      );
    }

    return result.stdout;
  } finally {
    await rm(tmpParent, { recursive: true, force: true });
  }
}

// =============================================================================
// Shared session setup (init → pre-session untracked → start → modify → end)
// =============================================================================

/**
 * Initialize the repo, run `viberevert init`, write initial files,
 * commit them, OPTIONALLY write pre-session untracked files (captured
 * by the checkpoint's untracked archive), then drive the M B session
 * lifecycle: `viberevert start` → write session modifications + session
 * untracked files → `viberevert end`. Returns the session id parsed
 * from start's stdout.
 *
 * Step ordering is significant:
 *   1. initGitRepo + writeFixtureFiles(files) — tracked baseline
 *   2. viberevert init — creates .viberevert.yml
 *   3. git add + commit — bakes the initial baseline
 *   4. writeFixtureFiles(pre_session_untracked_files) — untracked at
 *      start time, will be CAPTURED by the checkpoint's tarball
 *   5. viberevert start — creates session + inner checkpoint
 *   6. writeFixtureFiles(session.modifications) — modifies committed
 *      tracked files DURING the session
 *   7. writeFixtureFiles(session.untracked_files) — creates new
 *      untracked files DURING the session (NOT captured by the
 *      pre-session checkpoint; they're in the after-status snapshot)
 *   8. viberevert end — captures after-status.z snapshot
 */
async function setupSessionAndEnd(args: {
  readonly opts: RunReceiptFixtureOptions;
  readonly setup: ReceiptFixtureSetup;
  readonly repoRoot: string;
}): Promise<string> {
  await initGitRepo(args.repoRoot);
  await writeFixtureFiles(args.repoRoot, args.setup.files);

  const initResult = await runCliInRepo(args.opts.cliBinAbsPath, args.repoRoot, ["init"]);
  if (initResult.exitCode !== 0) {
    throw new Error(
      `Receipt fixture setup: \`viberevert init\` failed (exit ${initResult.exitCode}).\n` +
        `stdout:\n${initResult.stdout}\nstderr:\n${initResult.stderr}`,
    );
  }

  await runGitInRepo(args.repoRoot, ["add", "."], FIXED_GIT_COMMIT_ENV);
  await runGitInRepo(args.repoRoot, ["commit", "-q", "-m", "initial"], FIXED_GIT_COMMIT_ENV);

  if (args.setup.pre_session_untracked_files !== undefined) {
    await writeFixtureFiles(args.repoRoot, args.setup.pre_session_untracked_files);
  }

  const startArgs =
    args.setup.session.task !== undefined
      ? ["start", "--task", args.setup.session.task]
      : ["start"];
  const startResult = await runCliInRepo(args.opts.cliBinAbsPath, args.repoRoot, startArgs);
  if (startResult.exitCode !== 0) {
    throw new Error(
      `Receipt fixture setup: \`viberevert start\` failed (exit ${startResult.exitCode}).\n` +
        `stdout:\n${startResult.stdout}\nstderr:\n${startResult.stderr}`,
    );
  }
  const sessionId = extractSessionIdFromStdout(startResult.stdout);

  if (args.setup.session.modifications !== undefined) {
    await writeFixtureFiles(args.repoRoot, args.setup.session.modifications);
  }
  if (args.setup.session.untracked_files !== undefined) {
    await writeFixtureFiles(args.repoRoot, args.setup.session.untracked_files);
  }

  const endResult = await runCliInRepo(args.opts.cliBinAbsPath, args.repoRoot, ["end"]);
  if (endResult.exitCode !== 0) {
    throw new Error(
      `Receipt fixture setup: \`viberevert end\` failed (exit ${endResult.exitCode}).\n` +
        `stdout:\n${endResult.stdout}\nstderr:\n${endResult.stderr}`,
    );
  }

  return sessionId;
}

function extractSessionIdFromStdout(stdout: string): string {
  const match = stdout.match(/sess_[0-9A-HJKMNP-TV-Z]{26}/);
  if (match === null) {
    throw new Error(
      `Receipt fixture setup: could not parse session id from start stdout:\n${stdout}`,
    );
  }
  const sessionId = match[0];
  if (sessionId === undefined) {
    throw new Error("extractSessionIdFromStdout: match[0] undefined despite regex match");
  }
  return sessionId;
}

function buildRollbackArgs(args: {
  readonly sessionId: string;
  readonly invocation: { readonly mode: "dry_run" | "apply"; readonly force: boolean };
  readonly format: ReceiptFormat;
}): string[] {
  const result = ["rollback", args.sessionId];
  if (args.invocation.mode === "apply") result.push("--apply");
  if (args.invocation.force) result.push("--force");
  if (args.format === "json") result.push("--json");
  else if (args.format === "markdown") result.push("--markdown");
  return result;
}

async function applyPostEndTransformations(
  repoRoot: string,
  transforms: NonNullable<ReceiptFixtureSetup["post_end_transformations"]>,
): Promise<void> {
  // Order is LOCKED per design lock #9: delete_paths → create_dirs →
  // create_files. The extraction-conflict fixture depends on this
  // order: deletion clears the original captured tree, then
  // create_dirs places an empty subdirectory that survives the
  // restore-time `git ls-files --others` delete pass and triggers
  // ENOTEMPTY at extraction-path cleanup. Reordering would break
  // the locked mechanism.
  if (transforms.delete_paths !== undefined) {
    for (const relPath of transforms.delete_paths) {
      await rm(join(repoRoot, relPath), { recursive: true, force: true });
    }
  }
  if (transforms.create_dirs !== undefined) {
    for (const relPath of transforms.create_dirs) {
      // Recursive mkdir: a single `subdir/file.txt/blocker` entry
      // creates BOTH the directory at the captured path AND the
      // empty subdirectory inside that makes it non-empty.
      await mkdir(join(repoRoot, relPath), { recursive: true });
    }
  }
  if (transforms.create_files !== undefined) {
    await writeFixtureFiles(repoRoot, transforms.create_files);
  }
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await readFile(absPath, "utf8");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Assert that a refusal-class receipt fixture does NOT have an
 * `expected/` directory on disk. Refusal scenarios (per design lock
 * #8 in this file's header and the rollback-fixtures README) produce
 * NO golden artifacts; an `expected/` directory under a refusal
 * fixture indicates either (a) the fixture was misclassified and
 * `pnpm regen-goldens` ran against it before the misclassification
 * was corrected, or (b) the fixture was repurposed from
 * receipt-producing to refusal without removing the now-stale
 * expected/ tree. Either way, the stale dir would sit in git as
 * never-verified noise.
 *
 * Called BOTH before and after the refusal scenario runs — the
 * before-call catches a stale dir committed by a prior contributor;
 * the after-call catches a stale dir somehow created during the
 * scenario (defensive belt-and-suspenders against a future harness
 * regression that might accidentally write into the fixture
 * directory).
 *
 * Uses `lstat` (not `pathExists`) because the target is a directory
 * and `pathExists` is file-oriented (implemented via `readFile`).
 * Throws on any non-ENOENT error so I/O failures don't silently
 * pass the check.
 */
async function assertRefusalFixtureHasNoExpectedDir(fixtureDir: string): Promise<void> {
  const fixtureExpectedDir = join(fixtureDir, "expected");
  try {
    await lstat(fixtureExpectedDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  throw new Error(
    `Refusal-scenario fixture should not have an expected/ directory, but ${fixtureExpectedDir} exists. ` +
      `Remove it if the fixture was misclassified or repurposed.`,
  );
}

// =============================================================================
// ReceiptFixtureSetup runtime validator
// =============================================================================

interface RawReceiptFixtureSetup {
  files?: unknown;
  git_init?: unknown;
  pre_session_untracked_files?: unknown;
  session?: unknown;
  unrelated_dirt_after_end?: unknown;
  post_end_transformations?: unknown;
  rollback_invocation?: unknown;
  expected_rollback_exit_code?: unknown;
  expected_receipt?: unknown;
}

interface RawReceiptSession {
  task?: unknown;
  modifications?: unknown;
  untracked_files?: unknown;
}

interface RawPostEndTransformations {
  delete_paths?: unknown;
  create_dirs?: unknown;
  create_files?: unknown;
}

interface RawRollbackInvocation {
  mode?: unknown;
  force?: unknown;
}

function validateReceiptFixtureSetup(parsed: unknown, sourcePath: string): ReceiptFixtureSetup {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Receipt fixture setup.json must be an object at ${sourcePath}`);
  }
  const obj = parsed as RawReceiptFixtureSetup;

  const filesValue = obj.files;
  if (!Array.isArray(filesValue)) {
    throw new Error(`Receipt fixture setup.json: \`files\` must be an array at ${sourcePath}`);
  }
  const files = filesValue.map((f, i) => validateFixtureFile(f, `${sourcePath}: files[${i}]`));

  if (obj.git_init !== true) {
    throw new Error(
      `Receipt fixture setup.json: \`git_init\` must be literal \`true\` at ${sourcePath}`,
    );
  }

  let pre_session_untracked_files: readonly FixtureFile[] | undefined;
  const preSessionValue = obj.pre_session_untracked_files;
  if (preSessionValue !== undefined) {
    if (!Array.isArray(preSessionValue)) {
      throw new Error(
        `Receipt fixture setup.json: \`pre_session_untracked_files\` must be an array when set at ${sourcePath}`,
      );
    }
    pre_session_untracked_files = preSessionValue.map((f, i) =>
      validateFixtureFile(f, `${sourcePath}: pre_session_untracked_files[${i}]`),
    );
  }

  const sessionValue = obj.session;
  if (typeof sessionValue !== "object" || sessionValue === null || Array.isArray(sessionValue)) {
    throw new Error(`Receipt fixture setup.json: \`session\` must be an object at ${sourcePath}`);
  }
  const session = validateReceiptSession(sessionValue, `${sourcePath}: session`);

  let unrelated_dirt_after_end: readonly FixtureFile[] | undefined;
  const dirtValue = obj.unrelated_dirt_after_end;
  if (dirtValue !== undefined) {
    if (!Array.isArray(dirtValue)) {
      throw new Error(
        `Receipt fixture setup.json: \`unrelated_dirt_after_end\` must be an array when set at ${sourcePath}`,
      );
    }
    unrelated_dirt_after_end = dirtValue.map((f, i) =>
      validateFixtureFile(f, `${sourcePath}: unrelated_dirt_after_end[${i}]`),
    );
  }

  let post_end_transformations: ReceiptFixtureSetup["post_end_transformations"];
  const transformsValue = obj.post_end_transformations;
  if (transformsValue !== undefined) {
    if (
      typeof transformsValue !== "object" ||
      transformsValue === null ||
      Array.isArray(transformsValue)
    ) {
      throw new Error(
        `Receipt fixture setup.json: \`post_end_transformations\` must be an object when set at ${sourcePath}`,
      );
    }
    post_end_transformations = validatePostEndTransformations(
      transformsValue,
      `${sourcePath}: post_end_transformations`,
    );
  }

  const invocationValue = obj.rollback_invocation;
  if (
    typeof invocationValue !== "object" ||
    invocationValue === null ||
    Array.isArray(invocationValue)
  ) {
    throw new Error(
      `Receipt fixture setup.json: \`rollback_invocation\` must be an object at ${sourcePath}`,
    );
  }
  const rollback_invocation = validateRollbackInvocation(
    invocationValue,
    `${sourcePath}: rollback_invocation`,
  );

  const exitCodeValue = obj.expected_rollback_exit_code;
  if (exitCodeValue !== 0 && exitCodeValue !== 1) {
    throw new Error(
      `Receipt fixture setup.json: \`expected_rollback_exit_code\` must be literal 0 or 1 at ${sourcePath} (exit 2 is never a valid rollback fixture outcome per D66)`,
    );
  }

  const receiptValue = obj.expected_receipt;
  if (typeof receiptValue !== "boolean") {
    throw new Error(
      `Receipt fixture setup.json: \`expected_receipt\` must be boolean at ${sourcePath}`,
    );
  }

  // Cross-check #1: expected_receipt === false ⇒ exit code must be 1.
  // Refusal scenarios (no receipt) never exit 0.
  if (receiptValue === false && exitCodeValue !== 1) {
    throw new Error(
      `Receipt fixture setup.json: \`expected_receipt: false\` requires \`expected_rollback_exit_code: 1\` (refusal scenarios never exit 0) at ${sourcePath}`,
    );
  }

  // Cross-check #2: dry_run + force is impossible for receipt-producing
  // scenarios because --force without --apply triggers the CLI's
  // flag-validation refusal BEFORE any receipt is built.
  if (
    receiptValue === true &&
    rollback_invocation.mode === "dry_run" &&
    rollback_invocation.force
  ) {
    throw new Error(
      `Receipt fixture setup.json: \`expected_receipt: true\` is impossible for \`mode: dry_run\` + \`force: true\` because --force without --apply is a CLI flag-validation refusal at ${sourcePath}`,
    );
  }

  // Cross-check #3: dry_run receipt-producing scenarios must exit 0.
  // Per D66, a successful dry-run that produces a receipt always exits
  // 0; exit 1 indicates a refusal or error that never reaches the
  // receipt-build stage.
  if (receiptValue === true && rollback_invocation.mode === "dry_run" && exitCodeValue !== 0) {
    throw new Error(
      `Receipt fixture setup.json: dry_run receipt-producing scenarios must exit 0 at ${sourcePath} (D66: successful dry-run always exits 0; exit 1 means no receipt was produced)`,
    );
  }

  return {
    files,
    git_init: true,
    ...(pre_session_untracked_files !== undefined ? { pre_session_untracked_files } : {}),
    session,
    ...(unrelated_dirt_after_end !== undefined ? { unrelated_dirt_after_end } : {}),
    ...(post_end_transformations !== undefined ? { post_end_transformations } : {}),
    rollback_invocation,
    expected_rollback_exit_code: exitCodeValue as 0 | 1,
    expected_receipt: receiptValue,
  };
}

function validateReceiptSession(parsed: unknown, source: string): ReceiptFixtureSetup["session"] {
  const obj = parsed as RawReceiptSession;

  const taskValue = obj.task;
  if (taskValue !== undefined && typeof taskValue !== "string") {
    throw new Error(`${source}.task must be a string when set`);
  }

  let modifications: readonly FixtureFile[] | undefined;
  const modsValue = obj.modifications;
  if (modsValue !== undefined) {
    if (!Array.isArray(modsValue)) {
      throw new Error(`${source}.modifications must be an array when set`);
    }
    modifications = modsValue.map((f, i) =>
      validateFixtureFile(f, `${source}.modifications[${i}]`),
    );
  }

  let untracked_files: readonly FixtureFile[] | undefined;
  const untrackedValue = obj.untracked_files;
  if (untrackedValue !== undefined) {
    if (!Array.isArray(untrackedValue)) {
      throw new Error(`${source}.untracked_files must be an array when set`);
    }
    untracked_files = untrackedValue.map((f, i) =>
      validateFixtureFile(f, `${source}.untracked_files[${i}]`),
    );
  }

  return {
    ...(typeof taskValue === "string" ? { task: taskValue } : {}),
    ...(modifications !== undefined ? { modifications } : {}),
    ...(untracked_files !== undefined ? { untracked_files } : {}),
  };
}

function validatePostEndTransformations(
  parsed: unknown,
  source: string,
): NonNullable<ReceiptFixtureSetup["post_end_transformations"]> {
  const obj = parsed as RawPostEndTransformations;

  let delete_paths: readonly string[] | undefined;
  const deleteValue = obj.delete_paths;
  if (deleteValue !== undefined) {
    if (
      !Array.isArray(deleteValue) ||
      !deleteValue.every((s) => typeof s === "string" && s.length > 0)
    ) {
      throw new Error(`${source}.delete_paths must be an array of non-empty strings when set`);
    }
    for (let i = 0; i < deleteValue.length; i += 1) {
      validateFixtureFile({ path: deleteValue[i], content: "" }, `${source}.delete_paths[${i}]`);
    }
    delete_paths = deleteValue as readonly string[];
  }

  // create_dirs uses the SAME path-safety rules as delete_paths
  // (validateFixtureFile with empty content). Rejects absolute paths,
  // `..`, empty/dot segments, Windows path style (backslash / colon),
  // and `.git/` writes — same defense as every other path field in
  // this validator. Locked per correction #2 (no separate weaker
  // validation).
  let create_dirs: readonly string[] | undefined;
  const createDirsValue = obj.create_dirs;
  if (createDirsValue !== undefined) {
    if (
      !Array.isArray(createDirsValue) ||
      !createDirsValue.every((s) => typeof s === "string" && s.length > 0)
    ) {
      throw new Error(`${source}.create_dirs must be an array of non-empty strings when set`);
    }
    for (let i = 0; i < createDirsValue.length; i += 1) {
      validateFixtureFile({ path: createDirsValue[i], content: "" }, `${source}.create_dirs[${i}]`);
    }
    create_dirs = createDirsValue as readonly string[];
  }

  let create_files: readonly FixtureFile[] | undefined;
  const createValue = obj.create_files;
  if (createValue !== undefined) {
    if (!Array.isArray(createValue)) {
      throw new Error(`${source}.create_files must be an array when set`);
    }
    create_files = createValue.map((f, i) =>
      validateFixtureFile(f, `${source}.create_files[${i}]`),
    );
  }

  return {
    ...(delete_paths !== undefined ? { delete_paths } : {}),
    ...(create_dirs !== undefined ? { create_dirs } : {}),
    ...(create_files !== undefined ? { create_files } : {}),
  };
}

function validateRollbackInvocation(
  parsed: unknown,
  source: string,
): ReceiptFixtureSetup["rollback_invocation"] {
  const obj = parsed as RawRollbackInvocation;

  const modeValue = obj.mode;
  if (modeValue !== "dry_run" && modeValue !== "apply") {
    throw new Error(`${source}.mode must be literal "dry_run" or "apply"`);
  }

  const forceValue = obj.force;
  if (typeof forceValue !== "boolean") {
    throw new Error(`${source}.force must be boolean`);
  }

  return { mode: modeValue, force: forceValue };
}
