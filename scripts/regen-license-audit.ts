#!/usr/bin/env tsx
// scripts/regen-license-audit.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Thin executable for the M H5 license audit (see
// docs/adr/0001-deterministic-license-audit.md and regen-license-audit-core.ts). It
// computes the repository paths, parses CLI arguments, runs the collect -> build ->
// render generation, delegates the symlink-safe atomic write / freshness check to the
// core, maps the structured outcome to stderr diagnostics, and sets process.exitCode.
// It performs NO network access and stamps NO timestamp — identical inputs always
// produce identical bytes.
//
// Invoked via `pnpm run regen:license-audit` (freshness gate:
// `pnpm run regen:license-audit -- --check`). Peer of scripts/regen-goldens.ts
// (generate-then-assert idiom): progress goes to stderr, stdout is left clean, and the
// exit code is set via process.exitCode so buffered stderr drains before exit.
//
// Byte-exact --check depends on LICENSE-AUDIT.md being stored with LF endings on every
// platform; a `.gitattributes` rule pins it, so core.autocrlf cannot turn a clean
// checkout into false drift on Windows.
//
// Exit codes: 0 = wrote (or verified up to date); 1 = generation error, drift, a
// missing/ill-shaped/changed LICENSE-AUDIT.md under --check, or a refused/failed write;
// 2 = usage error.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAuditModel, type GenerationError } from "./license-audit-core.js";
import { renderAuditModel } from "./license-audit-render.js";
import { collectLicenseInputs } from "./license-collector.js";
import { type GenerateResult, type RegenOutcome, runRegen } from "./regen-license-audit-core.js";

// Version of the generator's OUTPUT format (stamped into the model and the rendered
// table). Distinct from the license-policy.json / license-metadata.json input
// schemaVersion, which the schema validators pin to 1.
const GENERATOR_SCHEMA_VERSION = 1;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const OUTPUT_REL = "LICENSE-AUDIT.md";
const OUTPUT_PATH = join(REPO_ROOT, OUTPUT_REL);
const TEMP_PATH = join(REPO_ROOT, `.LICENSE-AUDIT.md.tmp-${process.pid}`);

const CMD = "pnpm run regen:license-audit";
const USAGE = `Usage: ${CMD} -- [--check]\n`;

function printErrors(errors: readonly GenerationError[]): void {
  process.stderr.write(`License audit generation failed with ${errors.length} error(s):\n`);
  for (const e of errors) {
    process.stderr.write(
      `  [${e.code}]${e.package !== undefined ? ` ${e.package}:` : ""} ${e.message}\n`,
    );
  }
}

function generate(): GenerateResult {
  const collected = collectLicenseInputs(REPO_ROOT);
  if (!collected.ok) {
    return { ok: false, errors: collected.errors };
  }
  const { graph, policy, cache, hashes } = collected.inputs;
  const built = buildAuditModel({
    graph,
    cache,
    policy,
    hashes,
    generatorSchemaVersion: GENERATOR_SCHEMA_VERSION,
  });
  if (!built.ok) {
    return { ok: false, errors: built.errors };
  }
  const markdown = renderAuditModel(built.model);
  const summary = `${built.model.rows.length} third-party package row(s), ${built.model.firstParty.length} first-party, ${built.model.unresolvedPeers.length} unresolved peer(s)`;
  return { ok: true, markdown, summary };
}

function report(outcome: RegenOutcome): number {
  switch (outcome.kind) {
    case "generation-failed":
      printErrors(outcome.errors);
      return 1;
    case "wrote":
      process.stderr.write(`Wrote ${OUTPUT_REL} (${outcome.summary}).\n`);
      return 0;
    case "up-to-date":
      process.stderr.write(`${OUTPUT_REL} is up to date (${outcome.summary}).\n`);
      return 0;
    case "drift":
      process.stderr.write(
        `${OUTPUT_REL} is out of date (${outcome.committedBytes} committed bytes vs ${outcome.regeneratedBytes} regenerated).\n` +
          `Run \`${CMD}\` and commit the result.\n`,
      );
      return 1;
    case "check-read-failed":
      switch (outcome.reason) {
        case "missing":
          process.stderr.write(`${OUTPUT_REL} is missing.\nRun \`${CMD}\` to generate it.\n`);
          break;
        case "not-regular":
          process.stderr.write(`${OUTPUT_REL} is not a regular file; refusing to read it.\n`);
          break;
        case "changed":
          process.stderr.write(`${OUTPUT_REL} changed during the check.\n`);
          break;
        default:
          process.stderr.write(
            `cannot read ${OUTPUT_REL}: ${outcome.message ?? "unknown error"}\n`,
          );
          break;
      }
      return 1;
    case "write-refused":
      if (outcome.reason === "not-regular") {
        process.stderr.write(
          `${OUTPUT_REL} exists and is not a regular file; refusing to replace it.\n`,
        );
      } else {
        process.stderr.write(`cannot stat ${OUTPUT_REL}: ${outcome.message ?? "unknown error"}\n`);
      }
      return 1;
    case "write-failed":
      process.stderr.write(`failed to write ${OUTPUT_REL}: ${outcome.message}\n`);
      return 1;
  }
}

function main(argv: readonly string[]): number {
  let check = false;
  for (const arg of argv) {
    if (arg === "--check") {
      check = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stderr.write(USAGE);
      return 0;
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }
  return report(runRegen({ outputPath: OUTPUT_PATH, tempPath: TEMP_PATH, check, generate }));
}

process.exitCode = main(process.argv.slice(2));
