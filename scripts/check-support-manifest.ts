// scripts/check-support-manifest.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M H7 Step 2.3: thin entry for the full support-manifest authority check. Reads
// support.yml, .github/workflows/ci.yml, and package.json through the shared
// parser seams, then runs BOTH validators -- self-consistency
// (validateSupportManifest) and cross-file mapping (validateWorkflowMapping) --
// and fails once if the combined result is non-empty. Always runs main() (no
// direct-entry guard), so this gatekeeper can never silently no-op. A read/parse
// failure is reported without running the validators (which would only add noise
// on an undefined input). The entire failure report is written to stderr so CI
// captures it as one coherent error stream.
//
// Usage: check-support-manifest   (no arguments)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Violation, validateSupportManifest } from "./support-manifest-core.js";
import { parseSupportManifest, parseWorkflow } from "./support-manifest-parser.js";
import { validateWorkflowMapping } from "./support-manifest-workflow.js";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Read + parse a file, recording a read/parse failure as a violation.
function loadParsed(
  path: string,
  parse: (source: string) => unknown,
  code: string,
  parseErrors: Violation[],
): unknown {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    parseErrors.push({ code, message: `cannot read ${path}: ${messageOf(error)}` });
    return undefined;
  }
  try {
    return parse(source);
  } catch (error) {
    parseErrors.push({ code, message: `cannot parse ${path}: ${messageOf(error)}` });
    return undefined;
  }
}

function main(): void {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const parseErrors: Violation[] = [];

  const manifest = loadParsed(
    join(repoRoot, "support.yml"),
    parseSupportManifest,
    "support.yml",
    parseErrors,
  );
  const workflow = loadParsed(
    join(repoRoot, ".github", "workflows", "ci.yml"),
    parseWorkflow,
    "ci.yml",
    parseErrors,
  );
  const packageJson = loadParsed(
    join(repoRoot, "package.json"),
    (source: string) => JSON.parse(source),
    "package.json",
    parseErrors,
  );

  const violations =
    parseErrors.length > 0
      ? parseErrors
      : [
          ...validateSupportManifest(manifest),
          ...validateWorkflowMapping(manifest, workflow, packageJson),
        ];

  if (violations.length > 0) {
    process.stderr.write(`support manifest: ${violations.length} problem(s):\n`);
    for (const { code, message } of violations) {
      process.stderr.write(`${code}: ${message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write("support manifest: OK (self-consistency + workflow authority).\n");
}

main();
