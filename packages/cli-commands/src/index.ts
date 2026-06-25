// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public API of @viberevert/cli-commands.
//
// Two consumers:
//   1. `viberevert` CLI binary (packages/cli/src/index.ts) — imports
//      the 14 Command classes for register(). The binary is a thin
//      wrapper that does `new Cli + register + runExit`.
//   2. @viberevert/mcp (M G1a Step 3+) — imports:
//        - 3 operation functions for the typed-operation backend
//        - 9 operation-public typed-error classes for MCP_ERROR_CODE_MAP
//        - 5 package-local passthrough error classes (3 resolver +
//          runtime-env + concurrent-operation) for the same map
//        - runCommandInProcess for the command-harness backend
//
// D99.M.19 barrel guard: a number of CLI-internal symbols are
// intentionally NOT re-exported. The substep 11 architectural-invariants
// test asserts both directions — the listed exports are present AND the
// known-internal symbols are absent. See the "Intentionally NOT exported"
// note at the bottom of this file.

// =============================================================================
// 1. Command classes — consumed by the `viberevert` CLI binary's
//    `new Cli + register` boot path in packages/cli/src/index.ts
// =============================================================================

export { CheckCommand } from "./commands/check.js";
export { CheckpointCommand } from "./commands/checkpoint.js";
export { CheckpointsCommand } from "./commands/checkpoints.js";
export { DoctorCommand } from "./commands/doctor.js";
export { EndCommand } from "./commands/end.js";
export { HookInstallCommand } from "./commands/hook-install.js";
export { HookUninstallCommand } from "./commands/hook-uninstall.js";
export { InitCommand } from "./commands/init.js";
export { PromptFixCommand } from "./commands/prompt-fix.js";
export { ReportCommand } from "./commands/report.js";
export { RollbackCommand } from "./commands/rollback.js";
export { SessionsCommand } from "./commands/sessions.js";
export { StartCommand } from "./commands/start.js";
export { VersionCommand } from "./commands/version.js";

// =============================================================================
// 2. Typed operations — consumed by @viberevert/mcp typed-operation backend
//    (D99.E). Each export group: the operation function + its Opts/Result
//    types + any operation-public typed-error classes defined alongside it.
// =============================================================================

export {
  CheckpointNameCollisionError,
  CreateCheckpointListLoadError,
  type CreateCheckpointOperationOpts,
  type CreateCheckpointOperationResult,
  createCheckpointOperation,
} from "./operations/create-checkpoint.js";
export {
  type GenerateFixPromptOperationOpts,
  type GenerateFixPromptOperationResult,
  generateFixPromptOperation,
  PromptFixDriftDetectedError,
  PromptFixEmptyFindingsError,
  PromptFixIoFailureError,
  PromptFixReadFailureError,
  PromptFixReportParseError,
  PromptFixStaleRemovalFailureError,
  PromptFixTargetResolutionError,
} from "./operations/generate-fix-prompt.js";
// startSessionOperation has no operation-defined error classes — all errors
// it throws are passthrough (see section 4 below). Only the function +
// types are exported here.
export {
  type StartSessionOperationOpts,
  type StartSessionOperationResult,
  startSessionOperation,
} from "./operations/start-session.js";

// =============================================================================
// 3. In-process Clipanion harness — consumed by @viberevert/mcp
//    command-harness backend (D99.E + D99.W + D99.X)
// =============================================================================

export {
  type RunCommandInProcessOpts,
  type RunCommandInProcessResult,
  runCommandInProcess,
} from "./run-command-in-process.js";

// =============================================================================
// 4. Package-local passthrough error classes — re-exported for MCP
//    envelope mapping. These originate inside @viberevert/cli-commands
//    (the resolver, runtime-env, locks) and operations propagate them
//    unchanged. MCP's MCP_ERROR_CODE_MAP keys on these so the envelope
//    can carry a stable code. The barrel re-exports them so
//    @viberevert/mcp gets them via a single seam (`@viberevert/cli-commands`)
//    rather than reaching into deep paths (forbidden by D99.M.19).
//
//    `ConcurrentOperationError` is the SOLE allowed export from
//    `./locks.js` — its sibling symbols (`LockInfo`, `withExclusiveLock`)
//    are package-internal. `startSessionOperation` and
//    `createCheckpointOperation` can throw it from D22 lock acquisition.
//    `generateFixPromptOperation` deliberately has no lock — its
//    concurrency mitigation is D88's byte-level drift guard instead.
//
//    Core-originating passthrough errors such as RepoRootNotFoundError,
//    ConfigNotFoundError, ConfigParseError, ConfigValidationError, and
//    SessionAlreadyActiveError are NOT re-exported here — MCP imports
//    them directly from @viberevert/core per D99.M.6's narrow carve-out.
// =============================================================================

export { ConcurrentOperationError } from "./locks.js";

export {
  AmbiguousReportSelectionError,
  InvalidReportSelectionError,
  ReportNotFoundError,
} from "./prompt-fix-targets.js";

export { RuntimeEnvInvalidError } from "./runtime-env.js";

// =============================================================================
// Intentionally NOT exported (D99.M.19 barrel guard)
// =============================================================================
//
// The substep 11 architectural-invariants test asserts NONE of these
// symbols are reachable through `@viberevert/cli-commands`:
//
//   - START_LOCK_REL                       (from ./operations/start-session.js)
//   - CHECKPOINT_NAME_LOCK_REL             (from ./operations/create-checkpoint.js)
//     → internal display/lock-path plumbing for the Commands' stderr
//       templates; not part of MCP's public surface.
//
//   - CollisionExitSentinel                (from ./checkpoint-helpers.js)
//   - CheckpointListLoadError              (from ./checkpoint-helpers.js)
//   - safeListCheckpoints                  (from ./checkpoint-helpers.js)
//     → package-internal helpers; the operation wraps CheckpointListLoadError
//       into CreateCheckpointListLoadError (operation-public) so MCP keys
//       on the wrap, not the helper.
//
//   - PromptFixReportTarget (type)         (from ./prompt-fix-targets.js)
//   - resolvePromptFixReportTarget         (from ./prompt-fix-targets.js)
//   - resolveReportPaths                   (from ./report-paths.js)
//     → resolver implementation details; operations consume them
//       internally, MCP does not.
//
//   - resolveProductVersionForReport       (from ./runtime-env.js)
//   - resolveNowForCliTimestamp            (from ./runtime-env.js)
//     → CLI-side utilities; operations consume them internally.
//
//   - All file-internal helpers in operations/*.ts (readReportBytes,
//     parseReportFile, assertSourceReportUnchanged, removeStaleFixPrompt,
//     persistFixPrompt, formatCause, etc.)
//
//   - LockInfo and lock-path/helper internals from ./locks.js
//     → internal to operations. Exception: ConcurrentOperationError is
//       exported (see section 4 above) because it is an operation
//       passthrough error needed by MCP_ERROR_CODE_MAP.
//
//   - writeFileAtomic, renameDirAtomic     (from ./atomic.js)
//     → package-private per D17c; each package owns its own atomic helpers.
//
//   - All other CLI-internal modules: format.ts, gitignore.ts,
//     check-orchestration.ts, check-since-resolution.ts,
//     checkpoint-helpers.ts (the whole module, modulo the 3 exports
//     covered by the "not exported" notes above), report-paths.ts,
//     rollback-orchestration.ts, profiles/, etc.
//
//   - hook-script.ts, hook-managers.ts     (moved to @viberevert/adapters)
//     → moved per the D98.M.8 amendment (M G1b Step 1) to break the
//       cli-commands → installers → adapters → cli-commands cycle.
//       hook-install.ts and hook-uninstall.ts import the surface via
//       @viberevert/adapters; this barrel does NOT re-export it.
