// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Public API of @viberevert/adapters.
//
// This package owns:
//   1. Hook-manager detection + hook-script constants moved from
//      @viberevert/cli-commands per the D98.M.8 amendment (M G1b
//      Step 1) -- the cycle-break that lets @viberevert/installers and
//      @viberevert/cli-commands both depend on this layer.
//   2. Sentinel-block helpers for text-file edits performed by
//      @viberevert/installers.
//   3. The Adapter contract types (AdapterContext, AdapterPlan,
//      FileEditOp, RecordKey, etc.) consumed by every per-adapter
//      implementation in src/adapters/ (Steps 3-5).
//   4. The AdapterError base class for genuinely exceptional adapter
//      conditions (most refusals travel as RefusedPlan values).
//   5. Per-adapter implementations (M G1b Step 3 landed cursor +
//      direct-hook; Step 4 landed husky + lefthook; Step 5 adds
//      claude + github-action).
//
// Two consumers:
//   1. @viberevert/cli-commands -- imports the hook surface (Step 1
//      import rewires hook-install.ts and hook-uninstall.ts) and the
//      Adapter contract types + per-adapter implementations (Step 6's
//      InstallCommand / UninstallCommand consume them).
//   2. @viberevert/installers -- imports the contract types + sentinel
//      helpers; provides the InstallOutcome layer on top. M G1b Step 3
//      adds an end-to-end smoke test that imports cursorAdapter via
//      this barrel.
//
// Per D101.A, adapters are READ-ONLY: this barrel exports only data
// shapes, pure helpers, error classes, and read-only adapter
// implementations; no file-mutating surface. D101.M.1 + D101.M.1b
// architectural invariants assert this at the source level.

// =============================================================================
// 1. Hook-manager detection + hook-script constants (moved from
//    @viberevert/cli-commands per D98.M.8 amendment)
// =============================================================================

export {
  detectHookManagers,
  type HookManagerDetection,
  HookManagerIoError,
  type HookManagerState,
  MalformedPackageJsonError,
} from "./hook-managers.js";

export {
  BACKUP_FILE_PREFIX,
  BACKUP_FILE_REGEX,
  formatBackupTimestamp,
  HOOK_SCRIPT_TEMPLATE,
  MANAGED_BY_MARKER,
} from "./hook-script.js";

// =============================================================================
// 2. Sentinel-block helpers (used by per-adapter plan() implementations
//    AND by @viberevert/installers when applying the resulting FileEditOps)
// =============================================================================

export {
  findSentinelBlock,
  removeSentinelBlock,
  renderSentinelBlock,
  replaceOrAppendSentinelBlock,
  SENTINEL_BEGIN_PREFIX,
  SENTINEL_END_PREFIX,
  type SentinelAnchor,
} from "./sentinel.js";

// =============================================================================
// 3. Adapter contract types -- the locked surface every adapter consumes
//    and every installer dispatches on. See ./types.ts for the discipline
//    documentation (D101.A read-only, D101.D PathSpec, D101.J intent,
//    D101.O RecordKey, etc.).
// =============================================================================

export type {
  Adapter,
  AdapterContext,
  AdapterPlan,
  ApplicablePlan,
  DetectedResult,
  DetectResult,
  FileEditOp,
  JsonObject,
  JsonValue,
  NotDetectedResult,
  PathSpec,
  RecordKey,
  RefusedPlan,
} from "./types.js";

// =============================================================================
// 4. Adapter-level errors. Per D101.A, most adapter REFUSALS travel as
//    RefusedPlan values (see ./types.ts), not thrown errors. AdapterError
//    is reserved for genuinely exceptional conditions (I/O failures,
//    malformed config content) that adapters cannot encode as part of a
//    Plan. Step 4+5 add concrete subclasses alongside per-adapter
//    implementations.
// =============================================================================

export { AdapterError } from "./errors.js";

// =============================================================================
// 5. Per-adapter implementations. Re-exported from ./adapters/index.js
//    so that sub-barrel is the SINGLE SOURCE OF TRUTH for the adapter
//    implementation list. Step 3 landed cursor + direct-hook; Step 4
//    landed husky + lefthook; Step 5 adds claude + github-action. The
//    root barrel's re-export line grows to match the sub-barrel; the
//    sub-barrel structure stays stable.
// =============================================================================

export {
  claudeAdapter,
  cursorAdapter,
  directHookAdapter,
  githubActionAdapter,
  huskyAdapter,
  lefthookAdapter,
} from "./adapters/index.js";

// =============================================================================
// Intentionally NOT exported
// =============================================================================
//
// - findWholeLine (internal helper in ./sentinel.js): a low-level
//   whole-line search primitive. Callers should always go through
//   findSentinelBlock / replaceOrAppendSentinelBlock so the sentinel
//   semantics stay co-located in this package.
//
// - Per-adapter private helpers (inspectHookFile in direct-hook,
//   lstatOrNull / isVrManagedHook / refusalReasonForHookManagers, etc.):
//   exercised through the adapter's public detect() + plan() surface
//   only. The per-adapter implementations themselves are exported above
//   in section 5.
