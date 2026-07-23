// packages/cli/test/license-tarball.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Boundary tests for the in-memory tarball scanner (scripts/refresh-tarball.ts).
// Gzipped ustar archives are built by hand (correct checksums for node-tar's strict
// Parser) so every hostile entry shape is expressible without touching disk. Covered:
// package.json byte extraction and sorted legal-file paths; legal-basename variants
// and ignored files; absent package.json -> null; single-root confinement (a root that
// is not "package/", directory entries, a second top-level root, a top-level file, an
// unsafe root name, and type/path contradictions all fail closed or are tolerated per
// the tar entry type); and the fail-closed hazards — a symlinked file of interest, a
// second package.json, a duplicate legal path, an unsafe (control-bearing) path, path
// traversal under the root, package.json over its byte cap, the entry-count cap,
// invalid limits, a gzip bomb over the decompressed cap, a non-gzip buffer, and a
// buffer over the compressed cap.

import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { DEFAULT_TARBALL_LIMITS, scanTarball } from "../../../scripts/refresh-tarball.js";

type EntryType = "file" | "symlink" | "dir" | "hardlink";

interface TarEntry {
  name: string;
  content?: Buffer;
  type?: EntryType;
  linkname?: string;
}

function octalField(value: number, size: number): string {
  return `${value.toString(8).padStart(size - 1, "0")}\0`;
}

function typeflagFor(t: EntryType): string {
  return t === "symlink" ? "2" : t === "hardlink" ? "1" : t === "dir" ? "5" : "0";
}

function tarHeader(entry: TarEntry): Buffer {
  const h = Buffer.alloc(512, 0);
  const content = entry.content ?? Buffer.alloc(0);
  h.write(entry.name, 0, 100, "utf8");
  h.write(octalField(0o644, 8), 100, 8, "ascii");
  h.write(octalField(0, 8), 108, 8, "ascii");
  h.write(octalField(0, 8), 116, 8, "ascii");
  h.write(octalField(content.length, 12), 124, 12, "ascii");
  h.write(octalField(0, 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii"); // checksum placeholder (8 spaces)
  h.write(typeflagFor(entry.type ?? "file"), 156, 1, "ascii");
  if (entry.linkname !== undefined) {
    h.write(entry.linkname, 157, 100, "utf8");
  }
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += h[i] ?? 0;
  }
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

function buildTgz(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(tarHeader(entry));
    const content = entry.content ?? Buffer.alloc(0);
    if (content.length > 0) {
      blocks.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad > 0) {
        blocks.push(Buffer.alloc(pad, 0));
      }
    }
  }
  blocks.push(Buffer.alloc(1024, 0)); // two zero blocks: end of archive
  return gzipSync(Buffer.concat(blocks));
}

describe("scanTarball — valid archives", () => {
  it("returns package.json bytes and sorted legal-file paths", async () => {
    const pkg = Buffer.from('{"name":"foo","license":"MIT"}', "utf8");
    const tgz = buildTgz([
      { name: "package/package.json", content: pkg },
      { name: "package/LICENSE", content: Buffer.from("MIT text") },
      { name: "package/licenses/LICENSE.md", content: Buffer.from("apache") },
      { name: "package/src/index.js", content: Buffer.from("code") },
    ]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scan.packageJson?.toString("utf8")).toBe('{"name":"foo","license":"MIT"}');
      expect(r.scan.legalFiles).toEqual(["LICENSE", "licenses/LICENSE.md"]);
    }
  });

  it("recognizes legal basename variants and ignores unrelated files", async () => {
    const tgz = buildTgz([
      { name: "package/LICENSE.md", content: Buffer.from("a") },
      { name: "package/LICENCE", content: Buffer.from("b") },
      { name: "package/COPYING.LESSER", content: Buffer.from("c") },
      { name: "package/NOTICE", content: Buffer.from("d") },
      { name: "package/COPYRIGHT", content: Buffer.from("e") },
      { name: "package/README.md", content: Buffer.from("f") },
    ]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scan.legalFiles).toEqual([
        "COPYING.LESSER",
        "COPYRIGHT",
        "LICENCE",
        "LICENSE.md",
        "NOTICE",
      ]);
    }
  });

  it("returns a null package.json when the archive has none", async () => {
    const r = await scanTarball(
      buildTgz([{ name: "package/LICENSE", content: Buffer.from("x") }]),
      DEFAULT_TARBALL_LIMITS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scan.packageJson).toBeNull();
      expect(r.scan.legalFiles).toEqual(["LICENSE"]);
    }
  });
});

describe("scanTarball — fail-closed hazards", () => {
  it("rejects a symlinked file of interest", async () => {
    const tgz = buildTgz([{ name: "package/LICENSE", type: "symlink", linkname: "/etc/passwd" }]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("not a regular file");
    }
  });

  it("rejects a second package/package.json", async () => {
    const tgz = buildTgz([
      { name: "package/package.json", content: Buffer.from("{}") },
      { name: "package/package.json", content: Buffer.from("{}") },
    ]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("more than one");
    }
  });

  it("rejects a duplicate legal-file path", async () => {
    const tgz = buildTgz([
      { name: "package/LICENSE", content: Buffer.from("a") },
      { name: "package/LICENSE", content: Buffer.from("b") },
    ]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("duplicate");
    }
  });

  it("rejects an unsafe (control-bearing) path under package/", async () => {
    const tgz = buildTgz([
      { name: `package/a${String.fromCharCode(1)}b`, content: Buffer.from("x") },
    ]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("unsafe");
    }
  });

  it("rejects path traversal inside the package/ tree as unsafe", async () => {
    for (const name of ["package/../LICENSE", "package/a/../../LICENSE"]) {
      const r = await scanTarball(
        buildTgz([{ name, content: Buffer.from("x") }]),
        DEFAULT_TARBALL_LIMITS,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain("unsafe");
      }
    }
  });

  it("rejects a package.json exceeding its byte cap", async () => {
    const tgz = buildTgz([{ name: "package/package.json", content: Buffer.alloc(2048, 0x20) }]);
    const r = await scanTarball(tgz, { ...DEFAULT_TARBALL_LIMITS, maxPackageJsonBytes: 1024 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("package.json exceeds");
    }
  });

  it("rejects more entries than the cap", async () => {
    const tgz = buildTgz([
      { name: "package/a.txt", content: Buffer.from("1") },
      { name: "package/b.txt", content: Buffer.from("2") },
      { name: "package/c.txt", content: Buffer.from("3") },
    ]);
    const r = await scanTarball(tgz, { ...DEFAULT_TARBALL_LIMITS, maxEntries: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("entries");
    }
  });

  it("rejects invalid limits", async () => {
    const tgz = buildTgz([{ name: "package/LICENSE", content: Buffer.from("x") }]);
    const r = await scanTarball(tgz, { ...DEFAULT_TARBALL_LIMITS, maxEntries: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("invalid tarball limit");
    }
  });

  it("rejects a gzip bomb exceeding the decompressed cap", async () => {
    const tgz = buildTgz([{ name: "package/LICENSE", content: Buffer.alloc(4096, 0x41) }]);
    const r = await scanTarball(tgz, { ...DEFAULT_TARBALL_LIMITS, maxDecompressedBytes: 512 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("decompressed size exceeds");
    }
  });

  it("rejects a non-gzip buffer", async () => {
    const r = await scanTarball(Buffer.from("not a gzip archive"), DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("gunzip failed");
    }
  });

  it("rejects a buffer over the compressed cap", async () => {
    const tgz = buildTgz([{ name: "package/LICENSE", content: Buffer.from("x") }]);
    const r = await scanTarball(tgz, { ...DEFAULT_TARBALL_LIMITS, maxCompressedBytes: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("compressed bytes");
    }
  });
});

describe("scanTarball — single-root confinement", () => {
  it("collects a package whose root directory is not 'package/' (with dir entries)", async () => {
    const tgz = buildTgz([
      { name: "node/", type: "dir" },
      { name: "node/package.json", content: Buffer.from('{"name":"@types/node"}') },
      { name: "node/LICENSE", content: Buffer.from("MIT") },
      { name: "node/assert/", type: "dir" },
      { name: "node/assert.d.ts", content: Buffer.from("decl") },
    ]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scan.packageJson?.toString("utf8")).toBe('{"name":"@types/node"}');
      expect(r.scan.legalFiles).toEqual(["LICENSE"]);
    }
  });

  it("still collects a standard package/ root with a directory entry", async () => {
    const tgz = buildTgz([
      { name: "package/", type: "dir" },
      { name: "package/package.json", content: Buffer.from("{}") },
      { name: "package/LICENSE", content: Buffer.from("x") },
    ]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scan.legalFiles).toEqual(["LICENSE"]);
    }
  });

  it("tolerates a root-only directory entry", async () => {
    const tgz = buildTgz([
      { name: "node/", type: "dir" },
      { name: "node/package.json", content: Buffer.from("{}") },
    ]);
    expect((await scanTarball(tgz, DEFAULT_TARBALL_LIMITS)).ok).toBe(true);
  });

  it("rejects a root-only entry that is not declared as a directory", async () => {
    // node-tar coerces a typeflag-0 file with a trailing-slash name to Directory, so a
    // non-directory root-only entry is only reachable via a non-File type (symlink).
    const tgz = buildTgz([{ name: "node/", type: "symlink", linkname: "x" }]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("root entry is not a directory");
    }
  });

  it("rejects a non-directory entry whose path ends with a slash", async () => {
    const tgz = buildTgz([
      { name: "node/package.json", content: Buffer.from("{}") },
      { name: "node/fake/", type: "symlink", linkname: "x" },
    ]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("non-directory entry");
    }
  });

  it("rejects path traversal under a named root", async () => {
    const tgz = buildTgz([
      { name: "node/package.json", content: Buffer.from("{}") },
      { name: "node/../evil/LICENSE", content: Buffer.from("x") },
    ]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("unsafe");
    }
  });

  it("rejects a second top-level root directory", async () => {
    const tgz = buildTgz([
      { name: "node/package.json", content: Buffer.from("{}") },
      { name: "other/file.txt", content: Buffer.from("x") },
    ]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("more than one top-level");
    }
  });

  it("rejects a top-level file alongside the root", async () => {
    const tgz = buildTgz([
      { name: "node/package.json", content: Buffer.from("{}") },
      { name: "README", content: Buffer.from("x") },
    ]);
    const r = await scanTarball(tgz, DEFAULT_TARBALL_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("single package root");
    }
  });

  it("rejects unsafe root directory names (traversal and control characters)", async () => {
    for (const name of ["../package.json", `a${String.fromCharCode(1)}b/package.json`]) {
      const r = await scanTarball(
        buildTgz([{ name, content: Buffer.from("{}") }]),
        DEFAULT_TARBALL_LIMITS,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain("root directory name is unsafe");
      }
    }
  });
});
