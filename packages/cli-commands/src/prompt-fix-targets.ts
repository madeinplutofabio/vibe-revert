// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// prompt-fix-targets — CLI-side resolver wrapper that pairs the source
// report.json path (M C) with its sibling fix-prompt.txt path (M E).
//
// =============================================================================
// Locked design (per M E plan D95 + D82 + D86 + D90.6)
// =============================================================================
//
// 1. **Thin wrapper, not a re-implementation (D95).** This module wraps
//    `resolveReportPaths` from `./report-paths.js` — it does NOT
//    duplicate any of the M C resolution logic (flag mutual-exclusion,
//    --session / --report path construction, default resolution + active-
//    session lock, symlink-strict checks, multi-level sort comparator).
//    The wrapper's job is ONE thing: take the report path that
//    `resolveReportPaths` produced and derive the sibling `fix-prompt.txt`
//    path + the source kind + the source id.
//
// 2. **One resolver, both paths (D82 / D95).** Returning BOTH paths
//    together — instead of the command computing `fixPromptPath` from
//    `reportPath` at the call site — keeps the sibling-derivation rule
//    in one place. If M G eventually moves reports to a different
//    storage root, only this resolver updates. The command consumes the
//    pre-computed paths and never touches the layout.
//
// 3. **Sibling derivation per D82** — same parent directory as the
//    source report.json, filename `fix-prompt.txt`. Both storage
//    layouts (session-bound + ad-hoc) follow this rule:
//      - `.viberevert/sessions/<sess>/report.json`
//        → `.viberevert/sessions/<sess>/fix-prompt.txt`
//      - `.viberevert/reports/<rpt>/report.json`
//        → `.viberevert/reports/<rpt>/fix-prompt.txt`
//
// 4. **No filesystem access here.** This module's job is path math
//    only. It calls into `resolveReportPaths` which DOES touch the
//    filesystem (the report-existence check is intrinsic to its
//    contract), but this wrapper itself adds zero new I/O on top. The
//    `lstat` / `readFile` / `writeFileAtomic` / `rm` operations the
//    command performs are bounded by D90.6's locked CLI-side surface
//    and live in `prompt-fix.ts`, not here.
//
// 5. **Defensive structural checks (filename + layout).** Two checks:
//      (a) the returned path's basename MUST equal `report.json`;
//      (b) the parent layout MUST match the D26 storage root pattern
//          (`.../sessions/<sess>/` or `.../reports/<rpt>/`).
//    Both are cheap (string segment parse + regex) and catch a
//    refactor regression where someone changes `report-paths.ts` to
//    return a different filename OR a path outside the locked storage
//    roots. Without check (a) a hypothetical future bug like
//    `.../sessions/<sess>/wrong-file.json` would silently pair the
//    wrong source with a fix-prompt sibling. Without check (b) a
//    storage-root refactor could route the sibling write to an
//    arbitrary directory. Both throw a descriptive plain `Error`
//    (separate messages — failure mode is clearer when each check is
//    independent).
//
// 6. **Refusal classes are re-used from `./report-paths.js` and
//    re-exported here.** `AmbiguousReportSelectionError`,
//    `InvalidReportSelectionError`, and `ReportNotFoundError` propagate
//    from `resolveReportPaths` unchanged. The resolver re-exports them
//    from this module so the prompt-fix command has ONE seam to import
//    from — it never needs to reach around into `./report-paths.js`
//    directly, which keeps the command's import surface stable across
//    any future refactor of where prompt-fix's report resolution lives.
//    The command's `handleKnownError` catches them and writes the D93-
//    locked stderr copy — the resolver itself does NOT rewrite the
//    error classes. Per D93, the AmbiguousReportSelectionError and
//    ReportNotFoundError messages are reused VERBATIM; the
//    InvalidReportSelectionError message is overridden at the CLI seam
//    (in prompt-fix.ts) because D93's locked copy differs slightly from
//    M C's existing wording.

import { basename, dirname, join } from "node:path";

import { type ResolveReportPathsOptions, resolveReportPaths } from "./report-paths.js";

// Re-export the refusal classes so the prompt-fix command imports
// everything it needs from this one seam (lock #6). Plain re-export —
// no rewrapping, no behavior change. instanceof checks against these
// re-exports work identically to imports from `./report-paths.js`
// because re-exports preserve class identity.
export {
  AmbiguousReportSelectionError,
  InvalidReportSelectionError,
  ReportNotFoundError,
} from "./report-paths.js";

// =============================================================================
// Constants (storage layout per D26 — duplicated from report-paths.ts;
// constants don't change and the duplication keeps the structural check
// here independent of report-paths.ts internals)
// =============================================================================

const SESSIONS_SUBDIR = "sessions";
const REPORTS_SUBDIR = "reports";
const REPORT_FILENAME = "report.json";
const FIX_PROMPT_FILENAME = "fix-prompt.txt";

/** Canonical session id regex per D5. */
const SESSION_ID_RE = /^sess_[0-9A-HJKMNP-TV-Z]{26}$/;
/** Canonical ad-hoc report id regex per D5. */
const REPORT_ID_RE = /^rpt_[0-9A-HJKMNP-TV-Z]{26}$/;

// =============================================================================
// PromptFixReportTarget
// =============================================================================

/**
 * The two locked paths + discriminator that `viberevert prompt-fix`
 * needs to operate per D95. Returned by `resolvePromptFixReportTarget`.
 *
 *   - `reportPath`: absolute path to the source `report.json`. The
 *     command reads from this path TWICE per D88's drift guard (call
 *     A before render, call B after render); the two reads must use
 *     the same exact bytes to consider the output safe to write.
 *   - `fixPromptPath`: absolute path to the SIBLING `fix-prompt.txt`
 *     per D82. The command writes to this path ONCE on the success
 *     path via writeFileAtomic, OR removes it via `rm` on the D86
 *     empty-findings refusal. No other writes are permitted (D90.6).
 *   - `sourceKind`: `"session_bound"` for session-bound reports,
 *     `"ad_hoc"` for ad-hoc reports. Matches `ReportFile.kind` from
 *     `@viberevert/session-format` exactly so this field carries the
 *     same vocabulary as the underlying schema and the renderer's
 *     `file.kind` branch — no third term introduced for the same
 *     concept. The fix-prompt template's next-steps section branches
 *     on this (session-bound suggests `viberevert rollback <session_id>`;
 *     ad-hoc suggests git/checkpoint recovery per D85.6) — though the
 *     renderer reads `file.kind` directly from the parsed ReportFile,
 *     this field is carried in the target primarily for log /
 *     diagnostic / test-assertion convenience.
 *   - `sourceId`: the resolved id — `sess_<ULID>` for session-bound,
 *     `rpt_<ULID>` for ad-hoc. Mirrors the parent directory name in
 *     the source report path. Useful for stderr / log messages.
 */
export interface PromptFixReportTarget {
  readonly reportPath: string;
  readonly fixPromptPath: string;
  readonly sourceKind: "session_bound" | "ad_hoc";
  readonly sourceId: string;
}

// =============================================================================
// resolvePromptFixReportTarget
// =============================================================================

/**
 * Resolve the source report path + sibling fix-prompt.txt path for
 * `viberevert prompt-fix`.
 *
 * The flag-resolution behavior — `--session` + `--report` mutual
 * exclusion, individual flag-shape validation, default resolution via
 * active-session lock + latest-report scan, ReportNotFoundError on
 * absent reports — is delegated unchanged to `resolveReportPaths`.
 * This wrapper post-processes the resolved path to derive the
 * sibling `fix-prompt.txt` path + the source-kind discriminator +
 * the source id.
 *
 * Throws (propagates from `resolveReportPaths`):
 *   - `AmbiguousReportSelectionError` — both flags passed.
 *   - `InvalidReportSelectionError` — flag id shape invalid OR active
 *     session lock id shape invalid.
 *   - `ReportNotFoundError` — no report at the requested path / no
 *     active session report / no default-resolution candidate.
 *
 * Throws (internal, defensive — lock #5):
 *   - Plain `Error` if the path returned by `resolveReportPaths` does
 *     not end in `report.json` (filename check). Should never happen;
 *     models a refactor regression where report-paths.ts starts
 *     returning a different filename.
 *   - Plain `Error` if the parent layout does not match the D26
 *     storage-root pattern (`.../sessions/<sess>/` or
 *     `.../reports/<rpt>/`). Should never happen; models a refactor
 *     regression where report-paths.ts starts returning paths outside
 *     the locked storage roots.
 */
export async function resolvePromptFixReportTarget(
  repoRoot: string,
  flags: { readonly session?: string; readonly report?: string },
): Promise<PromptFixReportTarget> {
  const options: ResolveReportPathsOptions = {
    repoRoot,
    ...(flags.session !== undefined ? { sessionId: flags.session } : {}),
    ...(flags.report !== undefined ? { reportId: flags.report } : {}),
  };

  const reportPath = await resolveReportPaths(options);

  // Sibling path: same parent directory, filename "fix-prompt.txt".
  const containerDir = dirname(reportPath);
  const fixPromptPath = join(containerDir, FIX_PROMPT_FILENAME);

  // Defensive structural check (a) — filename. Catches a refactor
  // regression where `resolveReportPaths` starts returning a path
  // whose basename is NOT `report.json` (e.g., a hypothetical
  // `.../sessions/<sess>/something-else.json` that would otherwise
  // silently pair the wrong source file with a fix-prompt sibling).
  const reportFileName = basename(reportPath);
  if (reportFileName !== REPORT_FILENAME) {
    throw new Error(
      `prompt-fix-targets: resolveReportPaths returned an unexpected report filename ` +
        `(expected ${REPORT_FILENAME}, got ${reportPath}).`,
    );
  }

  // Defensive structural check (b) — parent layout. Confirm the
  // returned path matches the locked D26 storage root pattern and
  // derive sourceKind + sourceId from the path segments. Mismatch
  // throws a plain Error (this branch should never fire under correct
  // resolveReportPaths behavior; if it does, it indicates a refactor
  // regression in report-paths.ts).
  const idDirName = basename(containerDir);
  const storageRootName = basename(dirname(containerDir));

  let sourceKind: "session_bound" | "ad_hoc";
  if (storageRootName === SESSIONS_SUBDIR && SESSION_ID_RE.test(idDirName)) {
    sourceKind = "session_bound";
  } else if (storageRootName === REPORTS_SUBDIR && REPORT_ID_RE.test(idDirName)) {
    sourceKind = "ad_hoc";
  } else {
    throw new Error(
      `prompt-fix-targets: resolveReportPaths returned an unexpected path layout ` +
        `(expected .../{sessions/<sess>|reports/<rpt>}/report.json, got ${reportPath}).`,
    );
  }

  return {
    reportPath,
    fixPromptPath,
    sourceKind,
    sourceId: idDirName,
  };
}
