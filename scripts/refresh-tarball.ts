// scripts/refresh-tarball.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Bounded, in-memory npm-tarball scanner for the M H5 license-metadata refresh (see
// docs/adr/0001-deterministic-license-audit.md). It reads a .tgz ENTIRELY IN MEMORY
// through the mature `tar` parser in strict list mode — never extracting to disk — and
// returns only the packaged package.json bytes plus the package-relative paths of legal
// files. Every dimension is bounded: the compressed input, the decompressed output
// (gzip-bomb guard via zlib maxOutputLength), the entry count, the retained
// package.json size, the legal-file count, and each path length.
//
// npm packs a package under a SINGLE top-level directory — conventionally "package/"
// but not always (DefinitelyTyped packs each @types/<x> under "<x>/"). The scanner
// infers that one root directory from the first entry with a safe leading segment and
// requires every entry to live under it, then strips exactly that root. It fails closed
// on a second top-level directory, a top-level file, an absolute or "./"-stripped-empty
// path, an unsafe root name, a traversal/unsafe path under the root, or an entry whose
// tar TYPE contradicts its path — a non-directory entry wearing a trailing-slash
// (directory) name, or a root-only entry not declared a Directory. The tar entry type,
// never the path spelling, decides directory-ness; directory entries under the root are
// tolerated (not files of interest).
//
// Fail-closed: a file OF INTEREST (package.json or a legal file) that is a non-regular
// entry (symlink/hardlink/device/…), an unsafe or oversized path, a declared size that
// is not a safe non-negative integer, a duplicate legal-file path, a second
// package.json, a malformed/truncated archive (strict mode), or any exceeded bound
// fails the scan — and parsing is aborted at the first failure. Diagnostics never echo
// the raw entry path. It parses nothing and applies no license semantics: the caller
// parses the returned package.json bytes with the strict JSON parser.

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
  /** Raw bytes of the packaged package.json, or null when the archive has none. */
  readonly packageJson: Buffer | null;
  /** Package-relative POSIX paths of legal files, deduped and sorted. */
  readonly legalFiles: readonly string[];
}

export type TarballScanResult =
  | { readonly ok: true; readonly scan: TarballScan }
  | { readonly ok: false; readonly reason: string };

// Basenames treated as legal files: LICENSE/LICENCE, COPYING, NOTICE,
// UNLICENSE/UNLICENCE, COPYRIGHT — bare or with a `.`/`-`/`_` suffix (e.g. LICENSE.md,
// LICENSE-MIT, COPYING.LESSER). A basename heuristic; unusually named legal files are
// not detected and simply surface as fewer listed paths.
const LEGAL_BASENAME = /^(licen[cs]e|copying|notice|unlicen[cs]e|copyright)([._-].*)?$/i;

type Interest = "package-json" | "legal" | "none";

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function truncateError(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length <= 200 ? s : `${s.slice(0, 200)}… (${s.length} chars)`;
}

/** A safe single top-level directory name: non-empty, not `.`/`..`, no backslash or
 *  control character (incl. DEL). Bounds the root length to maxLen. */
function isSafeRootSegment(seg: string, maxLen: number): boolean {
  if (
    seg.length === 0 ||
    seg.length > maxLen ||
    seg === "." ||
    seg === ".." ||
    seg.includes("\\")
  ) {
    return false;
  }
  for (let i = 0; i < seg.length; i++) {
    const c = seg.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      return false;
    }
  }
  return true;
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

/** A package-relative POSIX file path: non-empty, within maxLen, not absolute, no
 *  backslash, control (incl. DEL), or empty/`.`/`..` segment. */
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
    // The archive's single top-level directory, established from the first entry with a
    // safe leading segment; every entry must live under it.
    let rootPrefix: string | null = null;

    // A raw entry path is a root segment + "/" + a package-relative path, each bounded
    // by maxPathLength, plus a possible "./" and trailing "/".
    const maxRawPathLength = limits.maxPathLength * 2 + 3;

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

      let raw = entry.path;
      if (raw.startsWith("./")) {
        raw = raw.slice(2);
      }
      const slash = raw.indexOf("/");
      if (slash <= 0) {
        // No top-level directory component: an absolute path, or a stray top-level file
        // that violates the single-package-root model.
        fail("tarball entry is not under a single package root directory");
        entry.resume();
        return;
      }
      const root = raw.slice(0, slash);
      const rest = raw.slice(slash + 1);
      if (rootPrefix === null) {
        if (!isSafeRootSegment(root, limits.maxPathLength)) {
          fail("tarball root directory name is unsafe");
          entry.resume();
          return;
        }
        rootPrefix = root;
      } else if (root !== rootPrefix) {
        fail("tarball has more than one top-level directory");
        entry.resume();
        return;
      }
      if (rest.length === 0) {
        // A root-only entry ("<root>/") is valid only when the archive declares it a
        // Directory. node-tar coerces a typeflag-0 file with a trailing-slash name to
        // Directory (and zeroes its body), so only a non-File type — symlink, hardlink,
        // device — reaches here as a non-directory; that fails closed.
        if (entry.type !== "Directory") {
          fail("tarball package-root entry is not a directory");
          entry.resume();
          return;
        }
        entry.resume();
        return;
      }
      // The tar entry type, not the path spelling, decides directory-ness: a
      // non-directory entry wearing a trailing-slash name fails closed.
      const hasTrailingSlash = rest.endsWith("/");
      if (hasTrailingSlash && entry.type !== "Directory") {
        fail("tarball contains a non-directory entry with a directory path");
        entry.resume();
        return;
      }
      const rel = hasTrailingSlash ? rest.slice(0, -1) : rest;
      if (!isSafeRelPath(rel, limits.maxPathLength)) {
        fail("tarball contains an unsafe or oversized path under the package root");
        entry.resume();
        return;
      }
      if (entry.type === "Directory") {
        // A subdirectory under the root: safe, but not a file of interest.
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
      // interest === "package-json" — record discovery immediately, before the async
      // content stream, so a second package.json can never slip in.
      if (packageJsonSeen) {
        fail("tarball contains more than one packaged package.json");
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
        fail("packaged package.json did not complete");
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
