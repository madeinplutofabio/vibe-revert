// scripts/check-support-manifest.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M H7 Step 2.2: thin entry for the support.yml validator. Reads the file,
// delegates parsing (parseSupportManifest, with the uniqueKeys duplicate-key
// guard) and validation (validateSupportManifest) to pure seams, prints
// violations, and ALWAYS runs main() -- no direct-entry guard, so this
// gatekeeper can never silently no-op.
//
// Usage: check-support-manifest   (no arguments)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateSupportManifest } from "./support-manifest-core.js";
import { parseSupportManifest } from "./support-manifest-parser.js";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(): void {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = join(repoRoot, "support.yml");

  let manifest: unknown;
  try {
    manifest = parseSupportManifest(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    process.stderr.write(`support manifest: cannot parse ${manifestPath}: ${messageOf(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const violations = validateSupportManifest(manifest);
  if (violations.length > 0) {
    process.stderr.write(`support manifest: ${violations.length} problem(s) in support.yml:\n`);
    for (const { code, message } of violations) {
      process.stdout.write(`${code}: ${message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write("support manifest: OK (structure + self-consistency).\n");
}

main();
