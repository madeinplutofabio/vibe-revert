// scripts/regen-license-audit-core.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Orchestration + security-sensitive filesystem mechanics for the M H5 license-audit
// driver (see docs/adr/0001-deterministic-license-audit.md and
// scripts/regen-license-audit.ts), extracted from the executable so the write/check
// mechanics are unit-testable in isolation. This module reads no process.argv, writes
// to no stdout/stderr, and runs nothing on import; the thin executable owns path and
// real-path calculation, CLI parsing, console output, and process.exitCode.
//
// Parameterized by an output path, a SIBLING temp path (same directory, so the rename
// stays on one filesystem), and an injected generation function. Write mode is
// symlink-safe and atomic: refuse a non-regular target, exclusive-create the temp
// private (0o600, never following a symlink or clobbering a stray temp), write it
// fully, set its final mode (an existing report's permissions, else 0o644, so a
// regenerate never drops it to owner-only), close, and rename it over the target.
// Check mode reads the existing report through a single no-follow descriptor bound to
// its pre-open lstat identity.

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import type { GenerationError } from "./license-audit-core.js";

export type GenerateResult =
  | { readonly ok: true; readonly markdown: string; readonly summary: string }
  | { readonly ok: false; readonly errors: readonly GenerationError[] };

/** The generation pipeline (collect -> build -> render), injected so the file
 *  mechanics can be exercised without rebuilding it. */
export type GenerateFn = () => GenerateResult;

export type ReadResult =
  | { readonly ok: true; readonly bytes: Buffer }
  | {
      readonly ok: false;
      readonly reason: "missing" | "not-regular" | "changed" | "error";
      readonly message?: string;
    };

export type WritableCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not-regular" | "error"; readonly message?: string };

export type WriteResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export type RegenOutcome =
  | { readonly kind: "generation-failed"; readonly errors: readonly GenerationError[] }
  | { readonly kind: "wrote"; readonly summary: string }
  | { readonly kind: "up-to-date"; readonly summary: string }
  | { readonly kind: "drift"; readonly committedBytes: number; readonly regeneratedBytes: number }
  | {
      readonly kind: "check-read-failed";
      readonly reason: "missing" | "not-regular" | "changed" | "error";
      readonly message?: string;
    }
  | {
      readonly kind: "write-refused";
      readonly reason: "not-regular" | "error";
      readonly message?: string;
    }
  | { readonly kind: "write-failed"; readonly message: string };

export interface RunRegenOptions {
  readonly outputPath: string;
  readonly tempPath: string;
  readonly check: boolean;
  readonly generate: GenerateFn;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

/**
 * Read the existing output through one descriptor. Refuses a symlink observed before
 * opening, opens with no-follow where supported, and verifies the opened descriptor
 * matches the pre-open file identity, so a symlink/file swap between the shape check
 * and the open cannot redirect the read.
 */
export function readExistingOutput(outputPath: string): ReadResult {
  let pre: Stats;
  try {
    pre = lstatSync(outputPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    return { ok: false, reason: "error", message: (err as Error).message };
  }
  if (pre.isSymbolicLink() || !pre.isFile()) {
    return { ok: false, reason: "not-regular" };
  }
  let fd: number | null = null;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    fd = openSync(outputPath, constants.O_RDONLY | noFollow);
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== pre.dev || before.ino !== pre.ino) {
      return { ok: false, reason: "changed" };
    }
    const size = before.size;
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n === 0) {
        break;
      }
      read += n;
    }
    if (read !== size) {
      return { ok: false, reason: "changed" };
    }
    const after = fstatSync(fd);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      return { ok: false, reason: "changed" };
    }
    return { ok: true, bytes: buf };
  } catch (err) {
    return { ok: false, reason: "error", message: (err as Error).message };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

/** Refuse a non-regular existing output (symlink included via lstat); ENOENT is fine. */
export function existingOutputIsWritable(outputPath: string): WritableCheck {
  try {
    const st = lstatSync(outputPath);
    if (!st.isFile()) {
      return { ok: false, reason: "not-regular" };
    }
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true };
    }
    return { ok: false, reason: "error", message: (err as Error).message };
  }
}

/** The mode to apply to the regenerated report: preserve an existing regular file's
 *  permission bits, else 0o644 (a normal repository-readable file). A non-ENOENT stat
 *  error propagates so the caller fails rather than guessing a mode. */
function finalOutputMode(outputPath: string): number {
  try {
    const stat = lstatSync(outputPath);
    if (stat.isFile()) {
      return stat.mode & 0o777;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  return 0o644;
}

/**
 * Exclusive-create the sibling temp (0o600 during construction, never following a
 * symlink or clobbering a stray temp), write it fully, set its final mode (preserve an
 * existing regular file's permissions, else 0o644), then rename it over the target.
 * The temp must be in the output's directory so the rename stays on one filesystem.
 * Cleans up its own temp on any failure after creation.
 */
export function writeAtomically(
  outputPath: string,
  tempPath: string,
  rendered: Buffer,
): WriteResult {
  const resolvedOutput = resolve(outputPath);
  const resolvedTemp = resolve(tempPath);
  if (resolvedOutput === resolvedTemp) {
    return { ok: false, message: "atomic temp path must differ from output path" };
  }
  if (dirname(resolvedOutput) !== dirname(resolvedTemp)) {
    return { ok: false, message: "atomic temp path must be in the output directory" };
  }

  let finalMode: number;
  try {
    finalMode = finalOutputMode(outputPath);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  let fd: number | null = null;
  let created = false;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    let written = 0;
    while (written < rendered.length) {
      const count = writeSync(fd, rendered, written, rendered.length - written, written);
      if (count === 0) {
        throw new Error("atomic write made no progress");
      }
      written += count;
    }
    fchmodSync(fd, finalMode);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, outputPath);
    created = false;
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
    if (created) {
      try {
        unlinkSync(tempPath);
      } catch {
        // best-effort cleanup of the exclusively-created temp
      }
    }
  }
}

/** Orchestrate generation + write/check, returning a structured outcome the caller
 *  maps to console output and an exit code. Performs no console I/O. */
export function runRegen(options: RunRegenOptions): RegenOutcome {
  const gen = options.generate();
  if (!gen.ok) {
    return { kind: "generation-failed", errors: gen.errors };
  }
  const rendered = Buffer.from(ensureTrailingNewline(gen.markdown), "utf8");

  if (options.check) {
    const read = readExistingOutput(options.outputPath);
    if (!read.ok) {
      return {
        kind: "check-read-failed",
        reason: read.reason,
        ...(read.message === undefined ? {} : { message: read.message }),
      };
    }
    if (read.bytes.equals(rendered)) {
      return { kind: "up-to-date", summary: gen.summary };
    }
    return { kind: "drift", committedBytes: read.bytes.length, regeneratedBytes: rendered.length };
  }

  const writable = existingOutputIsWritable(options.outputPath);
  if (!writable.ok) {
    return {
      kind: "write-refused",
      reason: writable.reason,
      ...(writable.message === undefined ? {} : { message: writable.message }),
    };
  }
  const write = writeAtomically(options.outputPath, options.tempPath, rendered);
  if (!write.ok) {
    return { kind: "write-failed", message: write.message };
  }
  return { kind: "wrote", summary: gen.summary };
}
