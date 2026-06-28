// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Engine-level shared types for @viberevert/installers.
//
// Defines:
//   - RECORD_KEYS / RecordKey: single source of truth for installer-
//     managed record keys (integrations-schema derives its Zod enum
//     from this constant; tests reference this const rather than
//     duplicating the list).
//   - CommandKind: transactional command discriminator carried by
//     lock + journal.
//   - UninstallContext: runtime context for engine.uninstall().
//     Parallel to AdapterContext (which lives in @viberevert/adapters
//     and is install-driven + adapter-aware); UninstallContext is
//     record-driven + adapter-free (adapterName is sourced from the
//     existing IntegrationRecord at uninstall time).
//   - PreviewOutcome / InstallOutcome / UninstallOutcome (+ their
//     receipt/diff structs): the engine's public return contracts.
//     Locked here so callers can rely on the shape independently of
//     engine implementation.
//
// Dependency-free: no imports from @viberevert/adapters or anywhere
// else. PreviewDiff's opKind discriminator uses an inline string
// literal union matching adapter FileEditOp's kind discriminator;
// alignment is by convention, not type-system enforcement.

// Single source of truth for installer-managed record keys. Every
// recordKey that integrations.json can persist must appear here.
export const RECORD_KEYS = [
  "cursor",
  "claude",
  "github-action",
  "direct-hook",
  "husky",
  "lefthook",
] as const;

export type RecordKey = (typeof RECORD_KEYS)[number];

/**
 * Top-level transactional command kind. Carried in the lock's
 * pid.json + the recovery journal entry so a stale lock or pending
 * journal can be diagnosed without re-deriving the originating call.
 */
export type CommandKind = "install" | "uninstall";

/**
 * Runtime context passed to engine.uninstall(). Parallel to
 * AdapterContext (which is install-driven and adapter-aware), but
 * uninstall is record-driven and adapter-free: adapterName is
 * sourced from the existing IntegrationRecord at uninstall time.
 *
 * Locked option: forceUninstall overrides ordinary content-drift
 * refusals (current managed-region SHA != recorded SHA) only. It
 * does NOT override structural refusals
 * (backup-file-missing-on-disk, integrations-record-duplicate-target,
 * integrations-record-corrupted-op).
 *
 * Force semantics for already-done reverses (currentSha === null +
 * forceUninstall): write-new / sentinel-* / json-key-merge SKIP
 * (reverse is already done; no file touch). backup-and-write does
 * NOT skip -- backup-restore is the whole point of that op kind,
 * regardless of whether the target exists. See engine-uninstall.ts
 * top comment for the full force-and-already-done matrix.
 */
export interface UninstallContext {
  readonly repoRoot: string;
  readonly now: Date;
  readonly cliVersion: string;
  readonly options: {
    readonly forceUninstall: boolean;
  };
}

// ---------------------------------------------------------------------------
// Outcome contracts: the values that engine.preview / .apply /
// .uninstall return to their caller. Locked here so cli-commands +
// MCP layers + tests can rely on the shape independently of engine
// implementation.
//
// Refusal-shape asymmetry across the three outcomes is intentional
// and reflects the locked design assumption: install is adapter-
// driven, uninstall is recordKey-driven.
//   - PreviewOutcome.refused has NO recordKey because an adapter-
//     level refused plan (Step 1's RefusedPlan shape) never carries
//     one; preview surfaces that refusal verbatim.
//   - InstallOutcome.refused has OPTIONAL recordKey: adapter-plan
//     refusals omit it; engine-preflight refusals on an applicable
//     plan (drift, lock, pending journal, symlink, etc.) include it.
//   - UninstallOutcome.refused has REQUIRED recordKey because
//     uninstall is recordKey-driven by definition — the caller knows
//     which recordKey it tried to uninstall even if the store is
//     corrupt or no adapter metadata is available; adapterName is
//     optional here for the same reason (may be unavailable on early
//     failure paths).
// ---------------------------------------------------------------------------

/**
 * Per-file unified-diff entry produced by engine.preview for the
 * "applicable" status. For an applicable outcome, empty perFile
 * means an adoption-style transaction: no target-file changes, but
 * apply may still update integrations.json. (Noop outcomes have no
 * diff field at all.)
 */
export interface PreviewDiff {
  readonly perFile: ReadonlyArray<{
    readonly pathRelative: string;
    readonly opKind:
      | "write-new"
      | "sentinel-block-insert"
      | "sentinel-block-replace"
      | "backup-and-write"
      | "json-key-merge";
    readonly unifiedDiff: string;
  }>;
}

export type PreviewOutcome =
  | {
      readonly status: "applicable";
      readonly recordKey: RecordKey;
      readonly adapterName: string;
      readonly diff: PreviewDiff;
      /**
       * Human-readable summary of the preview outcome. For non-
       * adoption applicable previews, sourced from
       * ApplicablePlan.humanSummary. For adoption previews
       * (diff.perFile is empty because the current state already
       * matches the desired managed state and apply would write
       * only the integrations record), overridden to the locked
       * adoption string so CLI can distinguish adoption from
       * non-adoption applicable previews without inspecting
       * diff.perFile.length.
       */
      readonly humanSummary: string;
    }
  | {
      readonly status: "noop";
      readonly recordKey: RecordKey;
      readonly adapterName: string;
      readonly reason: string;
    }
  | {
      readonly status: "refused";
      readonly adapterName: string;
      readonly reasonCode: string;
      readonly message: string;
      readonly manualSnippet?: string;
    };

/**
 * Engine.apply result for the "applied" status. opsApplied is 0 for
 * the adoption case (engine found existing managed state matching the
 * adapter plan; wrote only the integrations record, no target files).
 */
export interface InstallReceipt {
  readonly recordKey: RecordKey;
  readonly adapterName: string;
  readonly opsApplied: number;
  readonly filesWritten: ReadonlyArray<string>;
  readonly backupsCreated: ReadonlyArray<string>;
  readonly integrationsJsonPath: string;
  readonly humanSummary: string;
}

export type InstallOutcome =
  | { readonly status: "applied"; readonly receipt: InstallReceipt }
  | {
      readonly status: "noop";
      readonly recordKey: RecordKey;
      readonly adapterName: string;
      readonly reason: string;
    }
  | {
      readonly status: "refused";
      readonly recordKey?: RecordKey;
      readonly adapterName: string;
      readonly reasonCode: string;
      readonly message: string;
      readonly manualSnippet?: string;
    };

/**
 * Engine.uninstall result for the "uninstalled" status. filesRestored
 * comes from backup-and-write op rollback + sentinel/json-key-merge op
 * inverse application; filesRemoved comes from write-new op rollback.
 */
export interface UninstallReceipt {
  readonly recordKey: RecordKey;
  readonly adapterName: string;
  readonly filesRemoved: ReadonlyArray<string>;
  readonly filesRestored: ReadonlyArray<string>;
  readonly humanSummary: string;
}

export type UninstallOutcome =
  | { readonly status: "uninstalled"; readonly receipt: UninstallReceipt }
  | {
      readonly status: "not-installed";
      readonly recordKey: RecordKey;
      readonly reason: string;
    }
  | {
      readonly status: "refused";
      readonly recordKey: RecordKey;
      readonly adapterName?: string;
      readonly reasonCode: string;
      readonly message: string;
    };
