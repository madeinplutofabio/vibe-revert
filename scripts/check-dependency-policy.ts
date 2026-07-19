// scripts/check-dependency-policy.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Thin entry for the M H5 dependency-boundary check. Collects the workspace
// manifests from the committed workspace definition, then evaluates them against
// dependency-boundary.json with the pure core. Collector failures short-circuit
// policy evaluation -- a partial or untrusted inventory must never report clean.
//
// Usage: check-dependency-policy [--as-of YYYY-MM-DD]
//   --as-of  Evaluation date for override approve/expiry windows. Defaults to the
//            current UTC date. Only exact, strict calendar dates are accepted.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateAll, isValidCalendarDate, type Violation } from "./dependency-policy-core.js";
import { collectWorkspaceManifests } from "./workspace-collector.js";

const USAGE = "usage: check-dependency-policy [--as-of YYYY-MM-DD]";

function fail(message: string): never {
  process.stderr.write(`check-dependency-policy: ${message}\n${USAGE}\n`);
  process.exit(2);
}

/** Strict argument parser: the only accepted option is a single `--as-of` with a
 *  strict `YYYY-MM-DD` value. Unknown flags, repeats, a missing/invalid value, and
 *  positional arguments are all fatal usage errors. */
function parseAsOf(argv: readonly string[]): string {
  let asOf: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--as-of") {
      if (asOf !== null) {
        fail("--as-of may be given only once");
      }
      const value = argv[i + 1];
      if (value === undefined) {
        fail("--as-of requires a YYYY-MM-DD value");
      }
      if (!isValidCalendarDate(value)) {
        fail(`--as-of value ${JSON.stringify(value)} is not a strict YYYY-MM-DD calendar date`);
      }
      asOf = value;
      i++;
      continue;
    }
    fail(`unexpected argument ${JSON.stringify(arg)}`);
  }
  if (asOf !== null) {
    return asOf;
  }
  return new Date().toISOString().slice(0, 10);
}

function printViolations(violations: readonly Violation[]): void {
  for (const v of violations) {
    process.stdout.write(`${v.code}: ${v.message}\n`);
  }
}

function main(): void {
  const asOf = parseAsOf(process.argv.slice(2));
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

  const collected = collectWorkspaceManifests(repoRoot);
  if (collected.violations.length > 0) {
    process.stderr.write(
      `dependency boundary: workspace inventory could not be trusted (${collected.violations.length} issue(s)); policy not evaluated.\n`,
    );
    printViolations(collected.violations);
    process.exitCode = 1;
    return;
  }

  const boundaryPath = join(repoRoot, "dependency-boundary.json");
  let rawPolicy: unknown;
  try {
    rawPolicy = JSON.parse(readFileSync(boundaryPath, "utf8"));
  } catch (err) {
    process.stderr.write(
      `dependency boundary: cannot read ${boundaryPath}: ${(err as Error).message}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const violations = evaluateAll(rawPolicy, collected.manifests, asOf);
  if (violations.length > 0) {
    process.stderr.write(
      `dependency boundary: ${violations.length} violation(s) (as of ${asOf}):\n`,
    );
    printViolations(violations);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `dependency boundary: OK (${collected.manifests.length} manifest(s), as of ${asOf}).\n`,
  );
}

main();
