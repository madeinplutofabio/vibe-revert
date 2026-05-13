// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert sessions` — list all sessions in the repo, newest first.
// Active session marked with `status: "active"`; ended sessions show
// their end timestamp.
//
// =============================================================================
// Architectural locks
// =============================================================================
//
// 1. **D19: config-blind.** This command MUST NOT import or call
//    `loadConfig`. Listing operates purely on persisted state under
//    `.viberevert/sessions/` + `.viberevert/active-session.json`. The
//    architectural-invariants test added at the end of 5d-2 polices
//    this by grep.
//
// 2. **D16/D17c: no child_process; no direct git invocation.** All
//    session reading happens via `core.listSessions`, which is pure
//    fs I/O on `.viberevert/` state.
//
// 3. **D13 boundary: core owns session-state classification; CLI owns
//    presentation.** `core.listSessions` returns SessionSummary
//    objects with a pre-computed `status: "active" | "ended"` field
//    that already incorporates active-session.json awareness internally
//    (a session with `status: "active"` is one that has no `ended_at`
//    AND is referenced by the active lock; orphans without an
//    active-lock match are filtered into the `warnings` array per D13,
//    NOT returned in `sessions`). This command therefore does NOT
//    call `loadActiveSessionLock` separately — `session.status` is the
//    canonical truth. Re-reading the lock would add a redundant fs op
//    and reintroduce the drift risk D13 was designed to prevent.
//
// 4. **D13 warnings forwarding.** `core.listSessions` returns
//    `{sessions, warnings}`. This command prints each warning to
//    stderr in BOTH human and --json mode — stderr is the warnings
//    channel and doesn't break stdout JSON parsability per D20. Two
//    warning kinds (locked):
//      - `crash_interrupted`: orphan session dir (no `ended_at`, no
//        active-lock reference). Likely a crash between the outer
//        session-dir rename and the active-lock write.
//      - `schema_invalid`: session.json failed parse / schema /
//        session_id-vs-dirname check.
//
// 5. **D12 human format + D5 ID truncation + D18 TASK truncation.**
//    Columns: STATUS ID STARTED_AT ENDED_AT TASK. Newest first
//    (guaranteed by core.listSessions's ULID-descending sort).
//    ENDED_AT shows "-" for active sessions; TASK shows "-" for
//    sessions without a task description, otherwise truncated to 48
//    chars with `…` ellipsis per D18.
//
// 6. **D20 --json contract.** Full IDs (no truncation), `null` (NOT
//    omitted, NOT "-") for `ended_at` and `task`, repo-relative POSIX
//    paths, `[]` for empty state. SessionSummary's shape (from
//    @viberevert/core's public surface) is already D20-compliant —
//    JSON.stringify emits it as-is. The format.ts truncation helpers
//    MUST NOT be used in the --json branch.
//
// 7. **D12 empty-state copy is locked verbatim.** Human mode: exactly
//    the one line `No sessions found.` to stdout, exit 0. JSON mode
//    emits `[]` (NOT the empty-state text). Warnings (if any) still
//    go to stderr in both modes.

import {
  type ListSessionsWarning,
  listSessions,
  RepoRootNotFoundError,
  resolveRepoRoot,
} from "@viberevert/core";
import { Command, Option } from "clipanion";
import {
  truncateIdForDisplay,
  truncateTaskForDisplay,
} from "../format.js";

export class SessionsCommand extends Command {
  static override paths = [["sessions"]];

  static override usage = Command.Usage({
    description: "List sessions, newest first; active session marked",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit machine-readable JSON to stdout (D20 contract)",
  });

  override async execute(): Promise<number> {
    let repoRoot: string;
    try {
      repoRoot = resolveRepoRoot();
    } catch (err) {
      if (err instanceof RepoRootNotFoundError) {
        this.context.stderr.write(
          "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\n",
        );
        this.context.stderr.write(
          "Run `viberevert init` to create a project here.\n",
        );
        return 1;
      }
      throw err;
    }

    const { sessions, warnings } = await listSessions(repoRoot);

    // D13 warnings forwarding: print to stderr in BOTH human and
    // --json mode. Done BEFORE the stdout output so the stderr lines
    // appear above the stdout output in interleaved terminal display
    // (real-world ordering depends on the OS; this is best-effort).
    for (const warning of warnings) {
      this.context.stderr.write(`${formatWarning(warning)}\n`);
    }

    if (this.json) {
      // D20: SessionSummary's shape (id/checkpoint_id/status/started_at/
      // ended_at/task/path) is the locked JSON contract verbatim. null
      // values for ended_at (active session) and task (no description)
      // are preserved as JSON null per D20's "null for missing fields"
      // rule. Pretty-printed for human inspection.
      this.context.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
      return 0;
    }

    // Human format per D12.
    if (sessions.length === 0) {
      // D12 locked empty-state copy: exactly one line.
      this.context.stdout.write("No sessions found.\n");
      return 0;
    }

    const headers = ["STATUS", "ID", "STARTED_AT", "ENDED_AT", "TASK"];
    const rows: string[][] = sessions.map((s) => [
      s.status,
      truncateIdForDisplay(s.id),
      s.started_at,
      s.ended_at ?? "-",
      truncateTaskForDisplay(s.task),
    ]);
    this.context.stdout.write(`${renderTable(headers, rows)}\n`);
    return 0;
  }
}

/**
 * Render a structured ListSessionsWarning as a single stderr line.
 * Format is stable (consumers can grep) but not part of any locked
 * machine contract — D20's --json contract covers stdout only.
 *
 * Examples:
 *   warning: crash_interrupted: sess_01JV8Z0N6E7ABCDEFGHJKMNPQR at .viberevert/sessions/sess_01JV8Z0N6E7ABCDEFGHJKMNPQR
 *   warning: schema_invalid: sess_01JV8Z0N6E7ABCDEFGHJKMNPQR at .viberevert/sessions/sess_01JV8Z0N6E7ABCDEFGHJKMNPQR/session.json: invalid JSON: Unexpected token
 */
function formatWarning(w: ListSessionsWarning): string {
  if (w.kind === "schema_invalid") {
    return `warning: ${w.kind}: ${w.sessionId} at ${w.path}: ${w.reason}`;
  }
  return `warning: ${w.kind}: ${w.sessionId} at ${w.path}`;
}

/**
 * Render a simple fixed-width table: headers on top, rows beneath,
 * each column padded with 2 spaces of separation, trailing whitespace
 * trimmed from each line.
 *
 * Intentionally duplicated identically from `checkpoints.ts` (same
 * shape, same body). The small duplication (~15 lines) keeps each
 * command file self-contained and avoids a cross-command import.
 * Matches the package-internal helper pattern used by `atomic.ts` and
 * `locks.ts` (where intentional duplication across packages is
 * justified per D17c). If a third listing command appears, this would
 * justify extraction to `../format.ts`.
 */
function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, colIdx) => {
    let w = header.length;
    for (const row of rows) {
      const cell = row[colIdx] ?? "";
      if (cell.length > w) w = cell.length;
    }
    return w;
  });
  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, colIdx) => cell.padEnd(widths[colIdx] ?? 0))
      .join("  ")
      .trimEnd();
  return [headers, ...rows].map(renderRow).join("\n");
}
