// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

/** Options passed to every profile's generate() function. */
export interface GenerateOptions {
  projectName: string;
}

/** Signature of every profile generator. */
export type Generator = (opts: GenerateOptions) => string;

/** Options for generateGenericProfile, including a user-supplied profile name. */
export interface GenericProfileOptions extends GenerateOptions {
  profileName: string;
}

/**
 * Wraps a string as a double-quoted YAML scalar with escaping for backslashes,
 * newlines, carriage returns, tabs, and double quotes. Produces a value that
 * round-trips through any compliant YAML 1.2 parser. Sufficient for project
 * names and short descriptive scalars; not intended for arbitrary multiline
 * or binary data.
 */
export function yamlScalar(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;
}

/**
 * Generic-shaped config generator parameterized by an arbitrary profile name.
 *
 * Used by:
 *   - profiles/generic.ts (built-in "generic" profile)
 *   - commands/init.ts when --profile is given a name not in the built-in set
 *     (e.g., a third-party or user-defined profile)
 *
 * The output is intentionally sparse: only secrets and dependencies checks
 * are enabled by default. Users extend it for their stack.
 */
export function generateGenericProfile(opts: GenericProfileOptions): string {
  return `version: 1
profile: ${yamlScalar(opts.profileName)}
project:
  name: ${yamlScalar(opts.projectName)}

risk:
  block_on: critical
  warn_on: medium

checks:
  secrets: true
  dependencies: true
`;
}
