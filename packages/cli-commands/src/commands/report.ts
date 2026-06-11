// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert report [--session <id>] [--report <id>] [--threshold <level>]
//                    [--json | --markdown]`
//
// Render a persisted ReportFile artifact to stdout. Read-only and
// config-BLIND — never mutates state, never loads `.viberevert.yml`,
// never re-runs checks. The viewer counterpart to `viberevert check`:
// the producer writes the artifact, this command renders it.
//
// =============================================================================
// Architectural locks (must be preserved by all changes here)
// =============================================================================
//
// 1. **D19 — config-BLIND.** `viberevert report` reads zero config
//    files. The persisted `ReportFile` already carries everything the
//    renderer needs (full findings set, severity, since_kind, etc.); a
//    second config load would risk drift between "what the check
//    captured" and "what the render thinks the policy is" if the user
//    edited `.viberevert.yml` between check and report. Root discovery
//    still follows `resolveRepoRoot()` semantics — `.git` OR
//    `.viberevert.yml` as the upward marker — because that is the
//    standard CLI repo-root contract, not because we read either file.
//    (Verified against packages/core/src/paths.ts: hasRepoMarker checks
//    `.git` file/dir OR `.viberevert.yml` regular file; NOT `.viberevert/`.)
//
// 2. **D23 — singular load throws ReportNotFoundError.** When the user
//    asks for a specific report (--session or --report) and no
//    `report.json` exists at the resolved path, `resolveReportPaths`
//    throws `ReportNotFoundError` with the D47-locked message. The CLI
//    surfaces it verbatim as exit 1.
//
// 3. **D26 + D47 — resolution order owned by resolveReportPaths.**
//    --session + --report mutex, explicit-id lookup, active-session
//    default, latest-by-(written_at DESC, report_id DESC, path ASC)
//    fallback — all of it lives in `report-paths.ts`. report.ts just
//    passes the user's --session / --report flags through and renders
//    whatever path it gets back. No fallback policy lives here.
//
// 4. **D29 — report.ts owns stderr/stdout writes.** No helper module
//    (report-paths.ts, runtime-env.ts, the reporters package) writes to
//    the terminal. Reporters return values; report.ts writes them.
//
// 5. **D38 — --threshold is OUTPUT-ONLY.** Default for the report
//    viewer is `undefined` (no filter) for ALL formats, including
//    terminal. `viberevert check` differs (its terminal default is
//    `resolved.riskWarnOn`) because check is a producer reporting on
//    a fresh run; report is a viewer of a persisted artifact and
//    should show the artifact's content unless the user explicitly
//    asks for filtering. The persisted `report.json` is NEVER mutated
//    by render — `applyThreshold` produces a filtered VIEW only.
//
// 6. **D47 — exit codes are locked.** 0 = successful render. 1 = any
//    error (resolution, parse, IO, flag). **NEVER exit 2** — report is
//    read-only; it never gates. Exit 2 is reserved for `viberevert
//    check` per D24.
//
// 7. **D45 / D55 — render contract.** Reporters return ANSI-free
//    strings (terminal, markdown) or schema-verbatim values (json).
//    No color in M C. The CLI is responsible for the trailing newline
//    on JSON output and for writing whatever the renderer returned to
//    stdout unchanged.
//
// 8. **3-tier load with isolated catches.** readFile → JSON.parse →
//    ReportFileSchema.parse each have their own try/catch with a
//    distinct user-facing message. A missing/unreadable file ≠
//    malformed JSON ≠ schema-invalid content; conflating them would
//    rob the user of the right next-step hint. ZodError is detected by
//    duck typing (`err.name === "ZodError"`) so report.ts does NOT
//    take a direct dep on `zod`.
//
// 9. **exactOptionalPropertyTypes-safe spreads.** ResolveReportPaths
//    sessionId/reportId AND RenderInput's optional `threshold` field
//    use conditional spreads — no `: undefined` literals.

import { readFile } from "node:fs/promises";

import { RepoRootNotFoundError, resolveRepoRoot } from "@viberevert/core";
import {
  type RenderInput,
  renderJson,
  renderMarkdown,
  renderTerminal,
} from "@viberevert/reporters";
import { type ReportFile, ReportFileSchema, type RiskLevel } from "@viberevert/session-format";
import { Command, Option } from "clipanion";

import {
  AmbiguousReportSelectionError,
  InvalidReportSelectionError,
  ReportNotFoundError,
  resolveReportPaths,
} from "../report-paths.js";
import { RuntimeEnvInvalidError, resolveProductVersionForReport } from "../runtime-env.js";

// =============================================================================
// Constants
// =============================================================================

const VALID_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

// =============================================================================
// Pure helpers
// =============================================================================

function isValidRiskLevel(value: string): value is RiskLevel {
  return (VALID_RISK_LEVELS as readonly string[]).includes(value);
}

/**
 * Duck-type guard for zod's ZodError. report.ts deliberately does NOT
 * import `zod` directly (the persisted-report contract is "schema
 * validates, render proceeds" — the schema itself is enough; we don't
 * need zod's error helpers). Using `err.name === "ZodError"` matches
 * the stable public identity zod sets on every error instance it
 * constructs and survives bundler renaming or transitive-version
 * drift that could break a class-based `instanceof` check.
 *
 * Returns true ONLY if `err` is a real `Error` instance whose `name`
 * is exactly `"ZodError"`. A plain object `{ name: "ZodError" }`
 * returns false — we want a real Error so `.message` is safe to read.
 */
function isZodErrorLike(err: unknown): err is Error {
  return err instanceof Error && err.name === "ZodError";
}

// =============================================================================
// Centralized typed-error → stderr message mapping
// =============================================================================

/**
 * Maps every typed error class report.ts expects (from resolveRepoRoot,
 * resolveReportPaths, resolveProductVersionForReport) to a clean stderr
 * message + exit 1. Unknown errors re-throw and let Clipanion surface
 * them as a stack trace + non-zero exit.
 *
 * Per D47, this command NEVER returns exit 2. It is a viewer.
 *
 * Note: the 3-tier load failures (readFile / JSON.parse / schema)
 * are handled INLINE in execute() with their own custom messages,
 * not via this helper. handleKnownError is exclusively for errors
 * thrown by the resolution + version-resolution + repo-root steps.
 */
function handleKnownError(stderr: { write(s: string): unknown }, err: unknown): number {
  if (err instanceof RepoRootNotFoundError) {
    stderr.write(
      "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\n",
    );
    stderr.write("Run `viberevert init` to create a project here.\n");
    return 1;
  }
  if (
    err instanceof AmbiguousReportSelectionError ||
    err instanceof InvalidReportSelectionError ||
    err instanceof ReportNotFoundError ||
    err instanceof RuntimeEnvInvalidError
  ) {
    // These error classes carry their own user-friendly, already-
    // formatted messages (D47-locked "Run `viberevert check --since
    // ...` first" copy, JSON.stringify hardening on user-controlled
    // ids, env-var diagnostics with envVar+value+reason). Surface
    // them verbatim.
    stderr.write(`${err.message}\n`);
    return 1;
  }
  // Unknown error — re-throw so Clipanion surfaces it as a crash.
  throw err;
}

// =============================================================================
// Command class
// =============================================================================

export class ReportCommand extends Command {
  static override paths = [["report"]];

  static override usage = Command.Usage({
    description: "Render a previously-captured check report",
    details: `\
Reads a persisted ReportFile artifact and renders it to stdout in the
chosen format. Read-only — does not mutate state, does not load
.viberevert.yml, does not re-run checks.

Report selection:
  --report <rpt_ULID>   → render the named ad-hoc report
  --session <sess_ULID> → render the report for the named session
  (omitted)             → default resolution:
                          1. active session's report, if any
                          2. else latest report across both
                             .viberevert/sessions/*/report.json AND
                             .viberevert/reports/*/report.json
                             (sorted by written_at DESC,
                             report_id DESC, path ASC)

Output format (mutually exclusive):
  --json     → emit the ReportFile as schema-verbatim JSON
  --markdown → emit a CommonMark summary
  (default)  → emit a plain-text human-readable summary

--threshold filters the rendered view to findings at-or-above the
named level. The persisted report.json on disk is NEVER mutated —
threshold is an output filter only. Default is no filter (the viewer
shows the full persisted content unless the user opts in).

Exit codes:
  0  — render succeeded
  1  — any error (resolution, parse, IO, flag)
       (this command NEVER returns 2; it is a viewer, not a gate)`,
  });

  session = Option.String("--session", {
    description: "Render the report for this session id (mutually exclusive with --report)",
  });

  report = Option.String("--report", {
    description: "Render this ad-hoc report id (mutually exclusive with --session)",
  });

  threshold = Option.String("--threshold", {
    description:
      "Output filter: only show findings at-or-above this level (low|medium|high|critical). " +
      "Does NOT mutate the persisted report.",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the ReportFile as JSON to stdout (mutually exclusive with --markdown)",
  });

  markdown = Option.Boolean("--markdown", false, {
    description: "Emit a CommonMark summary to stdout (mutually exclusive with --json)",
  });

  override async execute(): Promise<number> {
    try {
      // Step 1: resolve repo root. Same `.git`-or-`.viberevert.yml`
      // discovery as every other CLI command, NOT a `.viberevert/`
      // detection — we don't need .viberevert.yml's content here (D19
      // config-blind), but we DO need the same upward-walk semantics
      // so a sub-project-rooted `.viberevert.yml` resolves to the
      // nested project root, not the outer Git root.
      const repoRoot = resolveRepoRoot();

      // Step 2: validate input flags (fail fast before any I/O beyond
      // step 1's repo-root scan).
      //
      // --json + --markdown: mutually exclusive per D47. Reject up
      // front rather than letting one silently shadow the other.
      if (this.json && this.markdown) {
        this.context.stderr.write("--json and --markdown are mutually exclusive.\n");
        return 1;
      }
      // --threshold: per D38, --threshold is OUTPUT-ONLY. Reject
      // unknown values here so we never hand a malformed level to the
      // renderer.
      if (this.threshold !== undefined && !isValidRiskLevel(this.threshold)) {
        this.context.stderr.write(
          `Invalid --threshold ${JSON.stringify(this.threshold)}. ` +
            `Expected one of: low, medium, high, critical.\n`,
        );
        return 1;
      }

      // Step 3: resolve the report path (D26 + D47 dispatch). All the
      // hard policy lives in resolveReportPaths — flag mutex on
      // --session+--report, ULID validation on every id-derived path
      // (defense vs. corrupted active-lock state), the locked
      // multi-level sort for default resolution. report.ts just
      // passes flags through.
      const reportPath = await resolveReportPaths({
        repoRoot,
        ...(this.session !== undefined ? { sessionId: this.session } : {}),
        ...(this.report !== undefined ? { reportId: this.report } : {}),
      });

      // Step 4: 3-tier load — readFile → JSON.parse →
      // ReportFileSchema.parse. Each tier has its own try/catch with a
      // distinct user-facing message so the next-step hint matches the
      // failure mode.
      //
      // Tier 1: file-system read. Catches missing-after-resolve TOCTOU
      // (resolveReportPaths lstat'd the file, but it could disappear,
      // become a symlink, or hit a permission revocation between
      // resolution and read), EACCES, EISDIR, etc. Surfaces the
      // underlying message verbatim — these are mundane I/O failures
      // the user can usually fix from the message alone.
      let raw: string;
      try {
        raw = await readFile(reportPath, "utf8");
      } catch (err) {
        this.context.stderr.write(
          `Failed to read report: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
      // Tier 2: JSON parse. JSON.parse on a string can only throw
      // SyntaxError (the input is guaranteed `string` because
      // readFile with "utf8" returns string), so an unconditional
      // catch with a fixed "invalid JSON" message is correct AND
      // stable — no err.message leakage of V8-version-specific
      // parser internals into the user-facing output.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.context.stderr.write("Persisted report file is malformed: invalid JSON.\n");
        return 1;
      }
      // Tier 3: schema validation. ZodError is detected by name (duck
      // typing) so report.ts does not need a direct zod dep — the
      // schema itself comes through session-format; report.ts only
      // needs to distinguish schema-validation failures from
      // unexpected crashes. A non-ZodError throw here would be
      // unexpected (zod parse only throws ZodError or rethrows
      // synchronous side-effect errors from refines — we have no
      // async refines on ReportFileSchema), so we rethrow and let
      // the outer try/catch or Clipanion surface it as a crash
      // rather than silently swallowing.
      let file: ReportFile;
      try {
        file = ReportFileSchema.parse(parsed);
      } catch (err) {
        if (isZodErrorLike(err)) {
          this.context.stderr.write(`Persisted report file is malformed: ${err.message}\n`);
          this.context.stderr.write("Re-run `viberevert check` to regenerate it.\n");
          return 1;
        }
        throw err;
      }

      // Step 5: resolve the product version stamp. Env-overridable
      // for golden-fixture determinism (VIBEREVERT_TEST_FIXED_VERSION).
      // Throws RuntimeEnvInvalidError on a malformed override; the
      // outer try/catch hands it to handleKnownError for a clean
      // exit 1.
      const productVersion = resolveProductVersionForReport();

      // Step 6: render. RenderInput's `threshold` is conditionally
      // spread to keep exactOptionalPropertyTypes happy — no explicit
      // `: undefined` literal. The default (no --threshold) is no
      // filter for ALL formats, per D38 — report is a viewer, not a
      // gate, so we show whatever the persisted artifact contains
      // unless the user opts in.
      const renderInput: RenderInput = {
        file,
        productVersion,
        ...(this.threshold !== undefined ? { threshold: this.threshold as RiskLevel } : {}),
      };
      if (this.json) {
        // renderJson returns a JSON.stringify-able value; D54 byte-
        // stability depends on schema-declaration key order, which
        // the renderer preserves from the validated `file`. Newline
        // after for POSIX-tool friendliness — matches `check --json`.
        const value = renderJson(renderInput);
        this.context.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      } else if (this.markdown) {
        // CommonMark output. The reporter is responsible for its own
        // trailing-newline structure (final newline included, blank
        // lines between sections).
        this.context.stdout.write(renderMarkdown(renderInput));
      } else {
        // Plain-text terminal output. ANSI-free per D55 — no color
        // in M C. Reporter is responsible for its own newline
        // structure.
        this.context.stdout.write(renderTerminal(renderInput));
      }

      // Step 7: exit 0 on successful render. D47 lock: this command
      // NEVER returns 2.
      return 0;
    } catch (err) {
      return handleKnownError(this.context.stderr, err);
    }
  }
}
