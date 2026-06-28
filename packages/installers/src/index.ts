// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public API of @viberevert/installers.
//
// This package owns:
//   1. The integrations store -- read-only via readIntegrationsFile;
//      mutated EXCLUSIVELY via apply / uninstall. writeIntegrationsFile
//      is intentionally NOT re-exported (D101.M.10): callers bypassing
//      apply/uninstall would skip the lock, journal, preview/apply
//      outcome semantics, and pending-journal refusal. The safe path
//      must be the only obvious path.
//   2. The engine entry points (preview / apply / uninstall) that
//      drive integrations-record I/O with the locked discipline
//      (lock acquisition, pending-journal refusal, atomic target
//      writes, byte-faithful backups, recovery journal, best-effort
//      cleanup, ADOPTION-AND-BACKUP rule, force-scope discipline).
//   3. The hasRepoIntegrationRecord helper consumed by
//      @viberevert/cli-commands' hook-install integrations guard
//      (D101.M.5).
//   4. The durable engine type surface (PreviewOutcome /
//      InstallOutcome / UninstallOutcome + their receipts;
//      RecordKey + RECORD_KEYS + CommandKind + UninstallContext).
//   5. The durable store type surface (IntegrationsFile /
//      IntegrationRecord / IntegrationFileEditRecord / PathSpec) so
//      consumers can traverse persisted records without re-importing
//      Zod-inferred shapes.
//   6. The typed InstallerError hierarchy consumed by the CLI for
//      instanceof-based actionable message rendering.
//
// Internal modules NOT re-exported (D101.M.10 enforced by an
// architectural invariant test in
// packages/cli/test/architectural-invariants.test.ts):
//   - engine-classify.ts -- classifier core consumed internally by
//     engine-preview / engine-apply / engine-uninstall.
//   - journal.ts -- recovery journal primitives owned exclusively by
//     this package per D101.M.8.
//   - lock.ts -- per-repo install lock primitives owned exclusively
//     by this package per D101.M.7.
//   - atomic.ts -- D17c writeFileAtomic primitive (4th private copy).
//   - preflight-target.ts -- assertSafeTarget path-walk safety check.
//   - canonical-json.ts -- canonicalJson / prettyJson /
//     sha256OfCanonical (callers should not re-canonicalize records).
//   - line-endings.ts -- detectLineEnding / normalizeToWriteFormat.
//   - path-resolve.ts, path-encode.ts -- internal path computation.
//   - All Zod schemas (IntegrationsFileSchema etc.) -- the store API
//     validates at the boundary; consumers do not re-validate.
//
// Cross-package import discipline (D101.M.11 enforced by the same
// invariants test): other workspace packages import this package
// ONLY via the bare specifier `@viberevert/installers`. Deep
// imports into ./dist/ or ./src/ subpaths are forbidden -- the
// barrel is the public surface.

// Engine entry points (5 functions).
export { apply } from "./engine-apply.js";
export { preview } from "./engine-preview.js";
// Engine outcome + context types (10 from engine-types.ts).
export {
  type CommandKind,
  type InstallOutcome,
  type InstallReceipt,
  type PreviewDiff,
  type PreviewOutcome,
  RECORD_KEYS,
  type RecordKey,
  type UninstallContext,
  type UninstallOutcome,
  type UninstallReceipt,
} from "./engine-types.js";
export { uninstall } from "./engine-uninstall.js";
// Typed error classes (11 from errors.ts). CLI uses instanceof +
// reads typed fields to render actionable messages. The abstract
// InstallerError base is exported so consumers can do a single
// `instanceof InstallerError` check for "is this an installer-
// originated error" before drilling into specific subclasses.
export {
  BackupCollisionError,
  InstallerError,
  IntegrationsCorruptedError,
  IntegrationsLockError,
  IntegrationsSchemaVersionError,
  IntegrationTargetNotFileError,
  IntegrationTargetParentNotDirectoryError,
  IntegrationTargetTooLargeError,
  PendingIntegrationRecoveryError,
  SymlinkTargetRefusal,
  TargetOutsideRepoRootError,
} from "./errors.js";
export { hasRepoIntegrationRecord } from "./integrations-query.js";

// Durable store types (4 from integrations-schema.ts; Zod schemas
// themselves are intentionally NOT re-exported).
export type {
  IntegrationFileEditRecord,
  IntegrationRecord,
  IntegrationsFile,
  PathSpec,
} from "./integrations-schema.js";
export { readIntegrationsFile } from "./integrations-store.js";
