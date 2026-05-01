// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

/**
 * Persisted-artifact schema version. Distinct from the npm package version.
 *
 * This constant is the version stamped into every persisted JSON artifact
 * (session.json, manifest.json, risk-report.json). Bumping it requires a
 * documented migration in MIGRATIONS.md and corresponding zod schema changes
 * in this package.
 *
 * Pre-v1.0: may change with documented migration notes (semver beta stability).
 * Post-v1.0: changes require a major version bump per semver.
 */
export const SCHEMA_VERSION = "1.0" as const;

export type SchemaVersion = typeof SCHEMA_VERSION;
