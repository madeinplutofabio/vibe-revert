// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * hook-install-integrations-guard.ts -- compatibility guard between
 * M F's `viberevert hook install` (direct .git/hooks/pre-commit
 * install) and M G1b's `viberevert install --direct` (integrations-
 * record-managed direct hook).
 *
 * The two install paths overlap at .git/hooks/pre-commit. If the
 * user has already run `viberevert install --direct`, the direct
 * hook is TRACKED in .viberevert/integrations.json. Running M F's
 * `viberevert hook install` on top would silently create a double-
 * managed hook: the M G1b integrations record would still point at
 * bytes the M F install just overwrote, leaving uninstall
 * bookkeeping in an inconsistent state.
 *
 * This guard is called from hook-install.ts (4E wire-up) BEFORE the
 * locked M F fs surface begins. It throws
 * IntegrationsRecordsHookConflictError if a direct-hook integration
 * record is present; hook-install.ts's handleKnownError() maps that
 * to a stderr line + exit 1, matching the D98.Q style.
 *
 * Recovery paths surfaced in the error message:
 *   - `viberevert uninstall --direct` -- removes the integration
 *     record + rolls back the tracked hook.
 *   - `viberevert install --husky --migrate-from-hook-install` --
 *     migrates the tracked direct hook into a husky-managed
 *     sentinel block.
 *
 * === Architectural lock (D101.M.5) ===
 *
 * Locked import surface: EXACTLY one import from
 * @viberevert/installers -- `hasRepoIntegrationRecord`. NO deep
 * imports (`@viberevert/installers/dist/...`), NO
 * readIntegrationsFile, NO engine internals, NO schema/types
 * imports. This module is pure orchestration; all store-read +
 * validation logic lives in integrations-query.ts (which documents
 * this consumer relationship in its own JSDoc). The 4E architectural-
 * invariants test grep-enforces this at CI time.
 *
 * === Error propagation ===
 *
 *   - "direct-hook" record present -> throw
 *     IntegrationsRecordsHookConflictError.
 *   - Store intentionally absent (no `.viberevert/` OR no
 *     integrations.json) -> return silently (per hasRepoIntegration-
 *     Record's contract).
 *   - Store CORRUPTION (invalid JSON, wrong schemaVersion, symlink
 *     safety refusal, I/O error) -> propagate the typed installer
 *     error verbatim; DO NOT swallow. The caller decides how to
 *     surface a broken store.
 *
 * === Non-goals ===
 *
 *   - No options object, no "target adapter" parameter. This guard
 *     answers exactly one question: "is direct-hook recorded?".
 *     Generalizing to other adapters would weaken the D101.M.5 lock.
 *   - No side effects. The guard is idempotent and read-only; a
 *     snapshot of the repo tree before and after is byte-identical
 *     whether the guard threw or returned.
 */

import { hasRepoIntegrationRecord } from "@viberevert/installers";

/**
 * Thrown when hook-install-integrations-guard detects an existing
 * direct-hook integration record. Carries the repoRoot as a typed
 * field so downstream callers (hook-install.ts's handleKnownError)
 * can construct alternate recovery messaging without string-parsing
 * the message.
 *
 * The message intentionally does NOT print the full absolute
 * repoRoot path -- CLI output stays path-light. Tests assert both
 * the message content (recovery command names) and the
 * error.repoRoot field.
 */
export class IntegrationsRecordsHookConflictError extends Error {
  readonly repoRoot: string;

  constructor(repoRoot: string) {
    super(
      "Refusing to run `viberevert hook install` because " +
        ".viberevert/integrations.json already records a VibeRevert direct-hook integration.\n\n" +
        "Choose one recovery path:\n" +
        "  - Remove the recorded integration: viberevert uninstall --direct\n" +
        "  - Migrate to Husky: viberevert install --husky --migrate-from-hook-install\n\n" +
        "See docs/hook-contract.md for the coexistence model.",
    );
    this.name = "IntegrationsRecordsHookConflictError";
    this.repoRoot = repoRoot;
  }
}

/**
 * Guard entry point. Called by hook-install.ts (4E wire-up) BEFORE
 * the locked M F fs surface begins. Behavior:
 *
 *   - hasRepoIntegrationRecord(repoRoot, "direct-hook") === true
 *     -> throw IntegrationsRecordsHookConflictError.
 *   - hasRepoIntegrationRecord(repoRoot, "direct-hook") === false
 *     (intentional absence of the store) -> return silently.
 *   - hasRepoIntegrationRecord throws (corruption / schema / safety
 *     / I/O) -> propagate the typed installer error.
 *
 * The recordKey is hard-coded as the literal "direct-hook" (not
 * imported from a RecordKey enum). This keeps the D101.M.5
 * invariant trivial: one installer import, one durable key.
 */
export async function assertNoIntegrationsHookConflict(repoRoot: string): Promise<void> {
  const present = await hasRepoIntegrationRecord(repoRoot, "direct-hook");
  if (present) {
    throw new IntegrationsRecordsHookConflictError(repoRoot);
  }
}
