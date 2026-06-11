// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert checkpoints` — list all checkpoints in the repo, newest
// first.
//
// =============================================================================
// Architectural locks
// =============================================================================
//
// 1. **D19: config-blind.** This command MUST NOT import or call
//    `loadConfig`. Listing operates purely on persisted state under
//    `.viberevert/checkpoints/`. The architectural-invariants test
//    added at the end of 5d-2 polices this by grep.
//
// 2. **D16/D17c: git invocation through @viberevert/git only.** This
//    command MUST NOT import `child_process`. All checkpoint reading
//    happens via `listCheckpoints`, which internally uses git's
//    private helpers — git is the single owner of git invocation.
//
// 3. **D12 human format + D5 ID truncation + D12 SHA truncation.**
//    Columns: NAME ID CREATED_AT HEAD_SHA. Newest first (guaranteed by
//    git.listCheckpoints's ULID-descending sort). Unnamed shows "-".
//    ID truncated to prefix + 14 chars; SHA truncated to 7 chars
//    (matches `git log --oneline`). Both truncations via the
//    package-private helpers in `../format.js`.
//
// 4. **D20 --json contract.** Full IDs (no truncation), full SHAs,
//    `null` (not omitted) for missing fields, repo-relative POSIX
//    paths, `[]` for empty state. CheckpointSummary's shape (from
//    @viberevert/git's public surface) is already D20-compliant —
//    JSON.stringify emits it as-is. The format.ts truncation helpers
//    MUST NOT be used in the --json branch.
//
// 5. **D23 missing-state contract.** `git.listCheckpoints` returns
//    `[]` when `.viberevert/checkpoints/` is absent (fresh repo —
//    NOT an error). Empty state surfaces here as either the human
//    "No checkpoints found." line OR JSON `[]`, per D12 + D20.
//
// 6. **D12 empty-state copy is locked verbatim.** Human mode:
//    exactly the one line `No checkpoints found.` to stdout, exit 0.
//    No header, no boxes, no extra blank lines. JSON mode emits `[]`
//    (NOT the empty-state text).

import { RepoRootNotFoundError, resolveRepoRoot } from "@viberevert/core";
import {
  CheckpointCorruptError,
  CheckpointNotFoundError,
  type CheckpointSummary,
  listCheckpoints,
} from "@viberevert/git";
import { Command, Option } from "clipanion";
import { truncateIdForDisplay, truncateShaForDisplay } from "../format.js";

export class CheckpointsCommand extends Command {
  static override paths = [["checkpoints"]];

  static override usage = Command.Usage({
    description: "List checkpoints, newest first",
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
        this.context.stderr.write("Run `viberevert init` to create a project here.\n");
        return 1;
      }
      throw err;
    }

    let checkpoints: readonly CheckpointSummary[];
    try {
      checkpoints = await listCheckpoints(repoRoot);
    } catch (err) {
      // listCheckpoints fails loudly on a corrupt entry (D6 invariant
      // violation, manifest schema failure, missing referenced
      // artifact, etc.). Surface the error message cleanly rather
      // than leaking the JS stack to the user.
      if (err instanceof CheckpointCorruptError || err instanceof CheckpointNotFoundError) {
        this.context.stderr.write(`Error reading checkpoints: ${err.message}\n`);
        return 1;
      }
      throw err;
    }

    if (this.json) {
      // D20: CheckpointSummary's shape (id/name/created_at/head_sha/
      // path) is the locked JSON contract verbatim. Pretty-printed for
      // human inspection; downstream tools parse either form
      // identically.
      this.context.stdout.write(`${JSON.stringify(checkpoints, null, 2)}\n`);
      return 0;
    }

    // Human format per D12.
    if (checkpoints.length === 0) {
      // D12 locked empty-state copy: exactly one line.
      this.context.stdout.write("No checkpoints found.\n");
      return 0;
    }

    const headers = ["NAME", "ID", "CREATED_AT", "HEAD_SHA"];
    const rows: string[][] = checkpoints.map((c) => [
      c.name ?? "-",
      truncateIdForDisplay(c.id),
      c.created_at,
      truncateShaForDisplay(c.head_sha),
    ]);
    this.context.stdout.write(`${renderTable(headers, rows)}\n`);
    return 0;
  }
}

/**
 * Render a simple fixed-width table: headers on top, rows beneath,
 * each column padded with 2 spaces of separation, trailing whitespace
 * trimmed from each line.
 *
 * Intentionally duplicated identically in `sessions.ts` (same shape,
 * same body). The small duplication (~15 lines) keeps each command
 * file self-contained and avoids a cross-command import. Matches the
 * package-internal helper pattern used by `atomic.ts` and `locks.ts`
 * (where intentional duplication across packages is justified per
 * D17c). If a third listing command appears, this would justify
 * extraction to `../format.ts`.
 */
function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
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
