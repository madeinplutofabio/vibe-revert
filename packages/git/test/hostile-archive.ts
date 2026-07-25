// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Hostile tar-gz fixture harness for @viberevert/git archive-shape tests.
//
// The production capture pipeline (snapshots.ts) only ever writes clean,
// regular-file, canonical-path gzipped tarballs, so the negative branches of
// `assertArchiveEntries` (restore-preflight.ts) — non-regular entry types,
// non-canonical paths, `.viberevert/**` paths, duplicate entries — cannot be
// reached with a captured archive. This helper hand-builds gzipped tar Buffers
// with arbitrary entry types and RAW paths so those branches can be driven
// directly.
//
// Hand-crafted headers (not node-tar's `create`) on purpose:
//   - `tar.create` sanitizes paths and mirrors the real filesystem, so it
//     cannot emit `../`, absolute, or duplicate entries without extra flags,
//     and a symlink entry would need an on-disk symlink (admin/developer mode
//     on Windows). Writing the 512-byte USTAR headers directly avoids the
//     filesystem entirely and behaves identically on every OS.
//   - Verified against the workspace node-tar (7.5.21) `list()`: a regular
//     entry round-trips as {type:"File"} with no warnings, and hostile paths
//     (`../evil`, `/etc/evil`) are reported RAW with no sanitization warning —
//     exactly what `assertArchiveEntries` receives, since its `tar.list()` read
//     path (unlike `tar.extract`) does not rewrite paths.
//
// Entries are emitted verbatim in the given order (duplicates allowed). The
// archive is terminated with the standard two 512-byte zero blocks and gzipped,
// matching the `.tar.gz` shape `assertArchiveEntries` decompresses.

import { gzipSync } from "node:zlib";

/**
 * POSIX ustar typeflag characters, mapped to the node-tar `entry.type` a
 * consumer sees: "0" File, "1" Link (hard link), "2" SymbolicLink,
 * "3" CharacterDevice, "4" BlockDevice, "5" Directory, "6" FIFO. "x" is a PAX
 * extended header (carries metadata for the following entry; never a File).
 */
export type TarTypeflag = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "x";

/** One tar entry to serialize. `content` and `linkname` default to empty. */
export interface TarEntrySpec {
  readonly path: string;
  readonly typeflag: TarTypeflag;
  readonly content?: string;
  readonly linkname?: string;
}

const NUL = "\0";

/**
 * Reject a header field wider than its fixed USTAR byte width. Without this,
 * `Buffer.write(..., maxBytes, "utf8")` would silently truncate long or
 * multibyte input, yielding a fixture different from the one the test author
 * requested — accidental corruption instead of intentional malformation.
 */
function assertFitsField(value: string, field: string, maxBytes: number): void {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > maxBytes) {
    throw new RangeError(`${field} exceeds ${maxBytes} UTF-8 bytes: ${byteLength}`);
  }
}

/** Right-aligned octal in a fixed-width, NUL-terminated tar numeric field. */
function octalField(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + NUL;
}

/** One 512-byte USTAR header block with a correct checksum. */
function headerBlock(path: string, typeflag: TarTypeflag, size: number, linkname: string): Buffer {
  assertFitsField(path, "tar path", 100);
  assertFitsField(linkname, "tar linkname", 100);
  const h = Buffer.alloc(512);
  h.write(path, 0, 100, "utf8"); // name
  h.write(`0000644${NUL}`, 100); // mode
  h.write(`0000000${NUL}`, 108); // uid
  h.write(`0000000${NUL}`, 116); // gid
  h.write(octalField(size, 12), 124); // size
  h.write(octalField(0, 12), 136); // mtime (fixed → deterministic fixtures)
  h.write("        ", 148); // checksum placeholder: 8 spaces
  h.write(typeflag, 156); // typeflag
  h.write(linkname, 157, 100, "utf8"); // linkname
  h.write(`ustar${NUL}`, 257); // magic
  h.write("00", 263); // version
  // Checksum: unsigned sum of all 512 bytes with the checksum field read as
  // spaces, written as 6 octal digits + NUL + space (classic tar convention).
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += h[i] ?? 0;
  }
  h.write(`${octalField(sum, 7).slice(0, 6)}${NUL} `, 148);
  return h;
}

/** Serialize one entry: header block + NUL-padded content to a 512-byte edge. */
function entryBlocks(spec: TarEntrySpec): Buffer {
  const body = Buffer.from(spec.content ?? "", "utf8");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([
    headerBlock(spec.path, spec.typeflag, body.length, spec.linkname ?? ""),
    body,
    padding,
  ]);
}

/**
 * Serialize `entries` (in order, duplicates allowed) into a gzipped tar Buffer
 * terminated by the standard two 512-byte zero blocks. Shape-compatible with
 * the `tar.list()` decompression `assertArchiveEntries` performs.
 */
export function makeTarGz(entries: readonly TarEntrySpec[]): Buffer {
  const eof = Buffer.alloc(1024); // two 512-byte zero blocks
  return gzipSync(Buffer.concat([...entries.map(entryBlocks), eof]));
}

// Convenience builders (typeflag pre-filled) for readable test cases.
export const fileEntry = (path: string, content = ""): TarEntrySpec => ({
  path,
  typeflag: "0",
  content,
});
export const symlinkEntry = (path: string, linkname: string): TarEntrySpec => ({
  path,
  typeflag: "2",
  linkname,
});
export const hardlinkEntry = (path: string, linkname: string): TarEntrySpec => ({
  path,
  typeflag: "1",
  linkname,
});
export const dirEntry = (path: string): TarEntrySpec => ({ path, typeflag: "5" });
export const fifoEntry = (path: string): TarEntrySpec => ({ path, typeflag: "6" });
export const charDeviceEntry = (path: string): TarEntrySpec => ({ path, typeflag: "3" });
export const blockDeviceEntry = (path: string): TarEntrySpec => ({ path, typeflag: "4" });

/**
 * A single PAX extended-header record: `"<len> key=value\n"`, where `<len>` is
 * the record's total BYTE length INCLUDING its own digits (self-referential —
 * resolved by fixpoint). Byte length (not string length) so non-ASCII paths
 * still produce a valid record.
 */
function paxRecord(key: string, value: string): string {
  const kv = `${key}=${value}\n`;
  let len = Buffer.byteLength(kv, "utf8") + 2;
  for (;;) {
    const record = `${len} ${kv}`;
    const total = Buffer.byteLength(record, "utf8");
    if (total === len) {
      return record;
    }
    len = total;
  }
}

/**
 * A PAX extended header (typeflag "x") carrying `path=effectivePath`, followed
 * by a regular-file entry named `placeholderName`. node-tar applies the PAX
 * `path` to the file and reports `effectivePath` as its `entry.path` — the
 * mechanism a hostile archive could use to smuggle a path past a guard that
 * only inspects the 100-byte USTAR name field. `effectivePath` rides in the
 * record body, so it is NOT bounded by the 100-byte field width.
 */
export function paxPathOverride(
  effectivePath: string,
  placeholderName = "harmless",
): readonly [TarEntrySpec, TarEntrySpec] {
  return [
    { path: "PaxHeader.0", typeflag: "x", content: paxRecord("path", effectivePath) },
    fileEntry(placeholderName, "x"),
  ];
}
