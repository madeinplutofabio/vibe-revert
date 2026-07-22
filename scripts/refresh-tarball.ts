// scripts/refresh-tarball.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Bounded, in-memory npm-tarball scanner for the M H5 license-metadata refresh
// (see docs/adr/0001-deterministic-license-audit.md). It reads a .tgz ENTIRELY IN
// MEMORY through the mature `tar` parser in strict list mode — never extracting to
// disk — and returns only the packaged package.json bytes plus the package-relative
// paths of legal files. Every dimension is bounded: the compressed input, the
// decompressed output (gzip-bomb guard via zlib maxOutputLength), the entry count,
// the retained package.json size, the legal-file count, and each path length.
//
// Fail-closed: a file OF INTEREST (package/package.json or a legal file) that is a
// non-regular entry (symlink/hardlink/device/…), an unsafe or oversized path under
// package/, a declared size that is not a safe non-negative integer, a duplicate
// legal-file path, a second package/package.json, a malformed/truncated archive
// (strict mode), or any exceeded bound fails the scan — and parsing is aborted at
// the first failure so no further work is done. Diagnostics never echo the raw
// entry path. It parses nothing and applies no license semantics: the caller parses
// the returned package.json bytes with the strict JSON parser.

import { gunzipSync } from "node:zlib";
import { Parser, type ReadEntry } from "tar";

export interface TarballLimits {
  readonly maxCompressedBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxEntries: number;
  readonly maxPackageJsonBytes: number;
  readonly maxLegalFiles: number;
  readonly maxPathLength: number;
}

export const DEFAULT_TARBALL_LIMITS: TarballLimits = {
  maxCompressedBytes: 64 * 1024 * 1024,
  maxDecompressedBytes: 256 * 1024 * 1024,
  maxEntries: 65_536,
  maxPackageJsonBytes: 4 * 1024 * 1024,
  maxLegalFiles: 64,
  maxPathLength: 4096,
};

export interface TarballScan {
  /** Raw bytes of package/package.json, or null when the archive has none. */
  readonly packageJson: Buffer | null;
  /** Package-relative POSIX paths of legal files, deduped and sorted. */
  readonly legalFiles: readonly string[];
}

export type TarballScanResult =
  | { readonly ok: true; readonly scan: TarballScan }
  | { readonly ok: false; readonly reason: string };

const PACKAGE_PREFIX = "package/";
// Basenames treated as legal files: LICENSE/LICENCE, COPYING, NOTICE,
// UNLICENSE/UNLICENCE, COPYRIGHT — bare or with a `.`/`-`/`_` suffix (e.g.
// LICENSE.md, LICENSE-MIT, COPYING.LESSER). A basename heuristic; unusually named
// legal files are not detected and simply surface as fewer listed paths.
const LEGAL_BASENAME = /^(licen[cs]e|copying|notice|unlicen[cs]e|copyright)([._-].*)?$/i;

type Interest = "package-json" | "legal" | "none";

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function truncateError(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length <= 200 ? s : `${s.slice(0, 200)}… (${s.length} chars)`;
}

function toPackageRelative(path: string): string | null {
  let p = path;
  if (p.startsWith("./")) {
    p = p.slice(2);
  }
  if (!p.startsWith(PACKAGE_PREFIX)) {
    return null;
  }
  return p.slice(PACKAGE_PREFIX.length);
}

function basename(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? rel : rel.slice(idx + 1);
}

function classify(rel: string): Interest {
  if (rel === "package.json") {
    return "package-json";
  }
  if (LEGAL_BASENAME.test(basename(rel))) {
    return "legal";
  }
  return "none";
}

function isSafeRelPath(rel: string, maxLen: number): boolean {
  if (rel.length === 0 || rel.length > maxLen) {
    return false;
  }
  if (rel.startsWith("/") || rel.includes("\\")) {
    return false;
  }
  for (let i = 0; i < rel.length; i++) {
    const c = rel.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      return false;
    }
  }
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      return false;
    }
  }
  return true;
}

function isRegularFile(type: string): boolean {
  return type === "File" || type === "OldFile" || type === "ContiguousFile";
}

/** Scan a .tgz in memory for the packaged package.json bytes and legal-file paths. */
export function scanTarball(tgz: Buffer, limits: TarballLimits): Promise<TarballScanResult> {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return Promise.resolve({ ok: false, reason: `invalid tarball limit ${name}` });
    }
  }
  if (tgz.length > limits.maxCompressedBytes) {
    return Promise.resolve({
      ok: false,
      reason: `tarball exceeds ${limits.maxCompressedBytes} compressed bytes`,
    });
  }
  let tarBytes: Buffer;
  try {
    tarBytes = gunzipSync(tgz, { maxOutputLength: limits.maxDecompressedBytes });
  } catch (err) {
    const reason =
      (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
        ? `decompressed size exceeds ${limits.maxDecompressedBytes} bytes`
        : `gunzip failed: ${(err as Error).message}`;
    return Promise.resolve({ ok: false, reason });
  }

  return new Promise<TarballScanResult>((resolve) => {
    const parser = new Parser({ strict: true });
    let settled = false;
    let entryCount = 0;
    let packageJsonSeen = false;
    let packageJsonComplete = false;
    let packageJson: Buffer | null = null;
    const legalFiles = new Set<string>();

    const maxRawPathLength = limits.maxPathLength + PACKAGE_PREFIX.length + 2;

    // Resolve, then abort parsing so no further entries or bytes are processed.
    // `settled` is set before abort so the resulting error is ignored.
    const fail = (reason: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ok: false, reason });
      try {
        parser.abort(new Error(reason));
      } catch {
        // parser already stopped
      }
    };
    const succeed = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ok: true, scan: { packageJson, legalFiles: [...legalFiles].sort(cmp) } });
    };

    parser.on("entry", (entry: ReadEntry) => {
      entry.on("error", (e: unknown) => fail(`tar entry error: ${truncateError(e)}`));
      if (settled) {
        entry.resume();
        return;
      }
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        fail(`tarball exceeds ${limits.maxEntries} entries`);
        entry.resume();
        return;
      }
      if (entry.path.length > maxRawPathLength) {
        fail("tarball contains an oversized entry path");
        entry.resume();
        return;
      }
      const rel = toPackageRelative(entry.path);
      if (rel === null) {
        // Not under package/ — not a file we consider; skip.
        entry.resume();
        return;
      }
      if (!isSafeRelPath(rel, limits.maxPathLength)) {
        fail("tarball contains an unsafe or oversized path under package/");
        entry.resume();
        return;
      }
      const interest = classify(rel);
      if (interest === "none") {
        entry.resume();
        return;
      }
      if (!isRegularFile(entry.type)) {
        fail(`${entry.type} entry ${JSON.stringify(rel)} is not a regular file`);
        entry.resume();
        return;
      }
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
        fail("tarball contains an invalid declared entry size");
        entry.resume();
        return;
      }
      if (interest === "legal") {
        if (legalFiles.has(rel)) {
          fail(`tarball contains duplicate legal-file path ${JSON.stringify(rel)}`);
          entry.resume();
          return;
        }
        if (legalFiles.size >= limits.maxLegalFiles) {
          fail(`tarball has more than ${limits.maxLegalFiles} legal files`);
          entry.resume();
          return;
        }
        legalFiles.add(rel);
        entry.resume();
        return;
      }
      // interest === "package-json" — record discovery immediately, before the
      // async content stream, so a second package.json can never slip in.
      if (packageJsonSeen) {
        fail("tarball contains more than one package/package.json");
        entry.resume();
        return;
      }
      packageJsonSeen = true;
      if (entry.size > limits.maxPackageJsonBytes) {
        fail(`package.json exceeds ${limits.maxPackageJsonBytes} bytes`);
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      entry.on("data", (c: Buffer) => {
        if (settled) {
          return;
        }
        size += c.length;
        if (size > limits.maxPackageJsonBytes) {
          fail(`package.json exceeds ${limits.maxPackageJsonBytes} bytes`);
          return;
        }
        chunks.push(c);
      });
      entry.on("end", () => {
        if (!settled) {
          packageJson = Buffer.concat(chunks);
          packageJsonComplete = true;
        }
      });
    });

    parser.on("error", (err: Error) => {
      if (!settled) {
        fail(`tar parse error: ${err.message}`);
      }
    });
    parser.on("finish", () => {
      if (settled) {
        return;
      }
      if (packageJsonSeen && !packageJsonComplete) {
        fail("package/package.json did not complete");
        return;
      }
      succeed();
    });

    try {
      parser.end(tarBytes);
    } catch (err) {
      fail(`tar write failed: ${(err as Error).message}`);
    }
  });
}
