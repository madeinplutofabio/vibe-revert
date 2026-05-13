// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Tests for the package-private atomic-write + atomic-rename helpers in
// packages/core/src/atomic.ts. These are NOT exported from the public
// barrel (per D17c), so we import them directly via the source path.
//
// What's load-bearing here:
//   - writeFileAtomic must leave no `*.tmp.*` siblings behind on success.
//     The atomic.ts comment + D13 explicitly tolerate leftover temp files
//     on FAILURE (a future `viberevert gc` sweeps them), but on SUCCESS
//     the rename must consume the temp path. A regression that left
//     `<file>.tmp.<hex>` behind on every write would silently inflate
//     `.viberevert/` over time.
//   - writeFileAtomic must overwrite an existing target without complaint.
//     Reason: `endSession` rewrites `session.json` after the initial
//     `startSession` write — that second write IS an overwrite, so
//     overwriting is part of the contract, not an edge case.
//   - renameDirAtomic must REFUSE if the destination already exists.
//     This is the load-bearing safety property from D13 — silent
//     overwrite of a session/checkpoint dir would destroy state. Test
//     locks the contract.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renameDirAtomic, writeFileAtomic } from "../src/atomic.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "viberevert-core-atomic-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("writes data to a fresh path and leaves no temp siblings behind", async () => {
    const targetPath = join(workDir, "session.json");
    await writeFileAtomic(targetPath, '{"hello":"world"}');

    expect(await readFile(targetPath, "utf8")).toBe('{"hello":"world"}');

    const entries = await readdir(workDir);
    expect(entries).toEqual(["session.json"]);
  });

  it("overwrites an existing target file (endSession rewrites session.json)", async () => {
    const targetPath = join(workDir, "session.json");
    await writeFile(targetPath, '{"first":true}');

    await writeFileAtomic(targetPath, '{"second":true}');

    expect(await readFile(targetPath, "utf8")).toBe('{"second":true}');

    const entries = await readdir(workDir);
    expect(entries).toEqual(["session.json"]);
  });

  it("supports concurrent writes to different target paths", async () => {
    const a = join(workDir, "a.txt");
    const b = join(workDir, "b.txt");
    const c = join(workDir, "c.txt");

    await Promise.all([
      writeFileAtomic(a, "alpha"),
      writeFileAtomic(b, "beta"),
      writeFileAtomic(c, "gamma"),
    ]);

    expect(await readFile(a, "utf8")).toBe("alpha");
    expect(await readFile(b, "utf8")).toBe("beta");
    expect(await readFile(c, "utf8")).toBe("gamma");

    const entries = await readdir(workDir);
    expect(entries.sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("accepts Buffer data without conversion artifacts", async () => {
    const targetPath = join(workDir, "binary.bin");
    const data = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);

    await writeFileAtomic(targetPath, data);

    const readBack = await readFile(targetPath);
    expect(readBack.equals(data)).toBe(true);
  });
});

describe("renameDirAtomic", () => {
  it("renames a tmp dir into the final position, preserving contents", async () => {
    const tmpDir = join(workDir, ".tmp-sess_FAKE");
    const finalDir = join(workDir, "sess_FAKE");
    await mkdir(tmpDir);
    await writeFile(join(tmpDir, "session.json"), '{"id":"sess_FAKE"}');
    await mkdir(join(tmpDir, "checkpoint"));
    await writeFile(join(tmpDir, "checkpoint", "manifest.json"), '{"v":"1.0"}');

    await renameDirAtomic(tmpDir, finalDir);

    const topLevel = await readdir(workDir);
    expect(topLevel).toEqual(["sess_FAKE"]);

    expect(await readFile(join(finalDir, "session.json"), "utf8")).toBe('{"id":"sess_FAKE"}');
    expect(await readFile(join(finalDir, "checkpoint", "manifest.json"), "utf8")).toBe(
      '{"v":"1.0"}',
    );
  });

  it("refuses to overwrite an existing destination (loud failure per D13)", async () => {
    const tmpDir = join(workDir, ".tmp-sess_FAKE");
    const finalDir = join(workDir, "sess_FAKE");
    await mkdir(tmpDir);
    await writeFile(join(tmpDir, "incoming.txt"), "incoming");
    await mkdir(finalDir);
    await writeFile(join(finalDir, "preexisting.txt"), "preexisting");

    await expect(renameDirAtomic(tmpDir, finalDir)).rejects.toThrow(/destination already exists/);

    // Source dir is untouched; destination is untouched.
    expect(await readFile(join(tmpDir, "incoming.txt"), "utf8")).toBe("incoming");
    expect(await readFile(join(finalDir, "preexisting.txt"), "utf8")).toBe("preexisting");
  });
});
