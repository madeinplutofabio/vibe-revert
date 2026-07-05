// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure command-guard matcher for `viberevert run` (M G2, D102.C).
 *
 * Evaluates a proxied argv against the `.viberevert.yml` `commands`
 * section BEFORE any session is started or any child is spawned:
 *
 *   commands:
 *     guard:            # matched -> refuse outright (exit 2)
 *       - "rm -rf /"
 *     require_confirm:  # matched -> interactive confirmation required
 *       - "terraform destroy"
 *
 * === Matching semantics v1 (D102.C, LOCKED) ===
 *
 * Normalization: `argv.join(" ")`. No shell parsing, no case folding,
 * no path resolution. This intentionally loses shell quoting:
 * ["echo", "a b"] normalizes to `echo a b` -- that is the documented
 * v1 contract, not a bug. Entries are LITERAL strings, not regexes or
 * globs.
 *
 * An entry E matches normalized command C iff:
 *
 *   C === E                     (exact)
 *   C.startsWith(E + " ")       (prefix ending at a join boundary)
 *
 * Case-sensitive. `rm -rf /x` does NOT match entry `rm -rf /` (the
 * boundary rule), while `rm -rf / --no-preserve-root` does.
 *
 * Precedence: `guard` is checked BEFORE `require_confirm`; a command
 * matching entries in both lists is refused outright (guard wins --
 * confirmation can never override a guard). Within a list, the first
 * matching entry (source order) is reported.
 *
 * Absent `commands` key or absent sub-arrays mean "no guards, no
 * confirms" -- everything is allowed.
 *
 * === Scope honesty (D102.A) ===
 *
 * Matching applies to the TOP-LEVEL invocation only: the argv that
 * `viberevert run` was asked to spawn. Commands the child runs
 * internally (subshells, agent tool calls, scripts) are never seen
 * here and never intercepted.
 *
 * This module is a pure leaf: no fs, no child_process, no imports
 * from other packages. NOT exported from the package barrel
 * (internal to RunCommand; see the D99.M.19 not-exported list).
 */

/**
 * Structural shape of the config's `commands` section (schema-validated
 * upstream). Properties admit explicit `undefined` so the schema-derived
 * config type stays assignable under exactOptionalPropertyTypes; the
 * evaluator reads them through `?? []` either way.
 */
export interface CommandsPolicyConfig {
  readonly guard?: readonly string[] | undefined;
  readonly require_confirm?: readonly string[] | undefined;
}

export type CommandPolicyDecision =
  | { readonly kind: "allow"; readonly normalized: string }
  | { readonly kind: "guard"; readonly entry: string; readonly normalized: string }
  | { readonly kind: "confirm"; readonly entry: string; readonly normalized: string };

/**
 * Normalize a proxied argv to the matching form: tokens joined with
 * single spaces. Shell quoting is intentionally NOT reconstructed
 * (documented v1 contract).
 */
export function normalizeCommand(argv: readonly string[]): string {
  return argv.join(" ");
}

/**
 * True iff `entry` matches `normalized` per D102.C: exact equality or
 * a prefix ending at a join boundary.
 */
export function matchGuardEntry(normalized: string, entry: string): boolean {
  return normalized === entry || normalized.startsWith(`${entry} `);
}

/**
 * Evaluate the top-level command against the config policy. Guard
 * wins over confirm; first matching entry in source order is
 * reported. Absent lists allow everything.
 */
export function evaluateCommandPolicy(
  argv: readonly string[],
  commands: CommandsPolicyConfig | undefined,
): CommandPolicyDecision {
  const normalized = normalizeCommand(argv);

  for (const entry of commands?.guard ?? []) {
    if (matchGuardEntry(normalized, entry)) {
      return { kind: "guard", entry, normalized };
    }
  }

  for (const entry of commands?.require_confirm ?? []) {
    if (matchGuardEntry(normalized, entry)) {
      return { kind: "confirm", entry, normalized };
    }
  }

  return { kind: "allow", normalized };
}
