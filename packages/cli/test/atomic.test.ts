// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Tests for the package-private atomic-rename helper in
// packages/cli/src/atomic.ts. NOT exported from any public CLI surface,
// so we import it directly via the source path.
//
// What's load-bearing here:
//   - renameDirAtomic must perform the rename and preserve contents
//     when the destination does not already exist.
//   - renameDirAtomic must REFUSE if the destination already exists at
//     the moment of `lstat`, with a recognizable error message and NO
//     mutation of either source or destination — half-rename or
//     silent-overwrite of a checkpoint dir would destroy a prior
//     checkpoint's state.
//
// What these tests deliberately do NOT prove (per the source-file
// honesty note in src/atomic.ts):
//   - Race-free behavior under arbitrary concurrent callers. The
//     `lstat`→`rename` window is a real TOCTOU; the no-collision
//     guarantee under concurrency comes from the caller's D22
//     exclusive lock (tested in test/locks.test.ts when locks.ts
//     lands in 5c), plus ULID uniqueness for id-based destinations.
//     A test that races two `renameDirAtomic` calls on the same
//     destination would either pass by luck or expose the TOCTOU —
//     neither outcome would prove anything about the code's actual
//     contract.
//
// The CLI helper has only `renameDirAtomic` (no `writeFileAtomic`)
// per D17c — see the header comment in src/atomic.ts. The two tests
// here are a strict subset of packages/core/test/atomic.test.ts's
// renameDirAtomic block.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renameDirAtomic } from "../src/atomic.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "viberevert-cli-atomic-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("renameDirAtomic", () => {
  it("renames a tmp dir into the final position, preserving contents", async () => {
    // Fixture mirrors a realistic standalone-checkpoint outer dir
    // mid-construction: manifest.json + rollback/ subdir with the
    // tarballs and patches git would have written before the CLI's
    // outer rename. The names (.tmp-checkpoint-FAKE, cp_FAKE) match
    // the D13/D17b naming convention even though the random/ULID
    // portions are placeholders here.
    const tmpDir = join(workDir, ".tmp-checkpoint-FAKE");
    const finalDir = join(workDir, "cp_FAKE");
    await mkdir(tmpDir);
    await writeFile(join(tmpDir, "manifest.json"), '{"id":"cp_FAKE"}');
    await mkdir(join(tmpDir, "rollback"));
    await writeFile(
      join(tmpDir, "rollback", "tracked-dirty.tar.gz"),
      "fake-tarball-bytes",
    );

    await renameDirAtomic(tmpDir, finalDir);

    // The tmp name is gone; only the final id-based name is visible.
    const topLevel = await readdir(workDir);
    expect(topLevel).toEqual(["cp_FAKE"]);

    // Contents (including nested subdirs) preserved byte-for-byte.
    expect(await readFile(join(finalDir, "manifest.json"), "utf8")).toBe(
      '{"id":"cp_FAKE"}',
    );
    expect(
      await readFile(
        join(finalDir, "rollback", "tracked-dirty.tar.gz"),
        "utf8",
      ),
    ).toBe("fake-tarball-bytes");
  });

  it("refuses to overwrite an existing destination (loud failure per D13)", async () => {
    const tmpDir = join(workDir, ".tmp-checkpoint-FAKE");
    const finalDir = join(workDir, "cp_FAKE");
    await mkdir(tmpDir);
    await writeFile(join(tmpDir, "incoming.txt"), "incoming");
    await mkdir(finalDir);
    await writeFile(join(finalDir, "preexisting.txt"), "preexisting");

    await expect(renameDirAtomic(tmpDir, finalDir)).rejects.toThrow(
      /destination already exists/,
    );

    // BOTH source and destination byte-untouched — no half-rename,
    // no partial state, no silent overwrite of the prior checkpoint.
    expect(await readFile(join(tmpDir, "incoming.txt"), "utf8")).toBe(
      "incoming",
    );
    expect(await readFile(join(finalDir, "preexisting.txt"), "utf8")).toBe(
      "preexisting",
    );
  });
});
