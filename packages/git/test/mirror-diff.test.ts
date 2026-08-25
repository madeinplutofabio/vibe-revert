// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M 0.8.0 step 4b: the prepared-mirror seam extracted from
// getDiffSinceCheckpoint and shared with contribution capture.
//
// Scope. This file covers ONLY the newly callable surface:
// `diffPreparedMirrors`, its mirror-name contract, and the observable
// difference between the two rename-detection modes. Checkpoint mode's own
// behavior is unchanged and is witnessed by the untouched diff.test.ts plus
// the report goldens driven from the CLI packages, not restated here.
//
// These tests run REAL git via `--no-index`, which works outside a
// repository, so each case is a bare temp directory holding two sibling
// mirrors. No repo, no worktree, no oracle: that is the point of the seam.

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { diffPreparedMirrors } from "../src/diff.js";

const BASE = "base";
const LIVE = "live";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "viberevert-mirrordiff-test-"));
  await mkdir(join(tempRoot, BASE), { recursive: true });
  await mkdir(join(tempRoot, LIVE), { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** Write one file into a mirror side, creating parent directories. */
async function put(side: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = join(tempRoot, side, ...rel.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

/** The common call, so individual cases stay about their fixture. */
function run(detectRenames: boolean) {
  return diffPreparedMirrors(tempRoot, BASE, LIVE, { detectRenames });
}

// =============================================================================
// Mirror-name contract
// =============================================================================
//
// Every case here must fail during validation, BEFORE git runs. None of these
// directories exist, so a missing validator would surface as a git failure
// with a different message; asserting the specific message is what proves the
// guard fired first.

describe("diffPreparedMirrors: mirror-name charset", () => {
  it.each([
    ["empty", ""],
    ["a space", "base dir"],
    ["a forward slash", "a/b"],
    ["a backslash", "a\\b"],
    ["a double quote", 'a"b'],
    ["non-ASCII", "bäse"],
    ["a tab", "ba\tse"],
  ])("rejects a name containing %s", async (_why, name) => {
    await expect(
      diffPreparedMirrors(tempRoot, name, LIVE, { detectRenames: false }),
    ).rejects.toThrow("baseDirName must contain only ASCII letters");
  });

  it("labels the offending parameter, so the message names liveDirName", async () => {
    await expect(
      diffPreparedMirrors(tempRoot, BASE, "live dir", { detectRenames: false }),
    ).rejects.toThrow("liveDirName must contain only ASCII letters");
  });

  it.each([".", ".."])("rejects %j with the dedicated rule, not the charset rule", async (name) => {
    // Both match [A-Za-z0-9._-]+, so the charset check passes and the
    // explicit check is what catches them. Asserting the message here is
    // what pins that ordering.
    await expect(
      diffPreparedMirrors(tempRoot, name, LIVE, { detectRenames: false }),
    ).rejects.toThrow(`baseDirName must not be ${JSON.stringify(name)}`);
  });
});

describe("diffPreparedMirrors: mirror-name distinctness", () => {
  it("rejects identical names", async () => {
    await expect(
      diffPreparedMirrors(tempRoot, BASE, BASE, { detectRenames: false }),
    ).rejects.toThrow("mirror directory names must differ");
  });

  it.each([
    ["base", "BASE"],
    ["Base", "bASE"],
  ])("rejects %j and %j, which alias on case-insensitive filesystems", async (a, b) => {
    await expect(diffPreparedMirrors(tempRoot, a, b, { detectRenames: false })).rejects.toThrow(
      "mirror directory names must differ",
    );
  });
});

// =============================================================================
// Content
// =============================================================================

describe("diffPreparedMirrors: content", () => {
  it("returns nothing for identical mirrors", async () => {
    await put(BASE, "a.txt", "same\n");
    await put(LIVE, "a.txt", "same\n");
    expect(await run(false)).toEqual([]);
  });

  it("reports a file present only on the live side as all-add", async () => {
    await put(LIVE, "a.txt", "alpha\nbeta\ngamma\n");
    const entries = await run(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("a.txt");
    expect(entries[0]?.isBinary).toBe(false);
    expect(entries[0]?.hunks).toEqual([
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        lines: [
          { kind: "add", text: "alpha" },
          { kind: "add", text: "beta" },
          { kind: "add", text: "gamma" },
        ],
      },
    ]);
  });

  it("reports a file present only on the base side as all-remove", async () => {
    await put(BASE, "a.txt", "alpha\nbeta\ngamma\n");
    const entries = await run(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("a.txt");
    expect(entries[0]?.hunks).toEqual([
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 0,
        newLines: 0,
        lines: [
          { kind: "remove", text: "alpha" },
          { kind: "remove", text: "beta" },
          { kind: "remove", text: "gamma" },
        ],
      },
    ]);
  });

  it("reports a single-line modification, exercising the implicit count of 1", async () => {
    // -U0 emits `@@ -2 +2 @@` with no comma for a one-line range, which the
    // hunk-header parser defaults to a count of 1.
    await put(BASE, "a.txt", "alpha\nbeta\ngamma\n");
    await put(LIVE, "a.txt", "alpha\nBETA\ngamma\n");
    const entries = await run(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hunks).toEqual([
      {
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 1,
        lines: [
          { kind: "remove", text: "beta" },
          { kind: "add", text: "BETA" },
        ],
      },
    ]);
  });

  it("yields an entry with NO hunks for an added empty file", async () => {
    // Contract E's "eligible for analysis, resolves to none". The transition
    // absent -> regular is eligible, but git emits no @@ hunk, so a caller
    // deriving content_delta must land on `none` rather than an empty `text`.
    await put(LIVE, "empty.txt", "");
    const entries = await run(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("empty.txt");
    expect(entries[0]?.isBinary).toBe(false);
    expect(entries[0]?.hunks).toEqual([]);
  });

  it("marks a file containing NUL bytes as binary with no hunks", async () => {
    await put(BASE, "blob.bin", Buffer.from([0x01, 0x02, 0x03]));
    await put(LIVE, "blob.bin", Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const entries = await run(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("blob.bin");
    expect(entries[0]?.isBinary).toBe(true);
    expect(entries[0]?.hunks).toEqual([]);
  });

  it("returns entries sorted by path", async () => {
    await put(LIVE, "zeta.txt", "z\n");
    await put(LIVE, "alpha.txt", "a\n");
    await put(LIVE, "src/mid.txt", "m\n");
    const entries = await run(false);
    expect(entries.map((e) => e.path)).toEqual(["alpha.txt", "src/mid.txt", "zeta.txt"]);
  });

  it("strips the mirror prefix exactly once, so a nested dir named like the other mirror survives", async () => {
    // The file sits at `base/live/x.txt` on disk. After stripping the outer
    // `base/`, the remaining path is `live/x.txt`. Without the `break`,
    // stripAllPrefixes would continue to the next prefix and incorrectly strip
    // `live/` too, collapsing the path to `x.txt`.
    await put(BASE, "live/x.txt", "hello\n");
    const entries = await run(false);
    expect(entries.map((e) => e.path)).toEqual(["live/x.txt"]);
  });
});

// =============================================================================
// Rename detection: the reason the parameter exists
// =============================================================================

describe("diffPreparedMirrors: detectRenames", () => {
  /** Same content, different name on each side. */
  async function renameFixture(): Promise<void> {
    await put(BASE, "old.txt", "alpha\nbeta\ngamma\n");
    await put(LIVE, "new.txt", "alpha\nbeta\ngamma\n");
  }

  it("false yields the add and the remove, each carrying real hunks", async () => {
    await renameFixture();
    const entries = await run(false);
    expect(entries.map((e) => e.path)).toEqual(["new.txt", "old.txt"]);
    expect(entries[0]?.hunks[0]?.lines.map((l) => l.kind)).toEqual(["add", "add", "add"]);
    expect(entries[1]?.hunks[0]?.lines.map((l) => l.kind)).toEqual(["remove", "remove", "remove"]);
  });

  it("true collapses the pair into one entry with NO content delta", async () => {
    // git emits `similarity index 100%` with rename headers and no hunks. The
    // content-only seam therefore reports a single path whose delta is empty,
    // and a caller reading content alone cannot tell anything happened.
    //
    // This is precisely why contribution capture passes false: with rename
    // detection on, a renamed file's content delta disappears.
    await renameFixture();
    const entries = await run(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("new.txt");
    expect(entries[0]?.isBinary).toBe(false);
    expect(entries[0]?.hunks).toEqual([]);
  });

  it("the two modes disagree on the same fixture", async () => {
    // Stated as its own assertion so the parameter can never quietly become a
    // no-op, which is exactly what merely omitting `-M` would have produced
    // under a repository with diff.renames enabled.
    await renameFixture();
    const withRenames = await run(true);
    const withoutRenames = await run(false);
    expect(withRenames).not.toEqual(withoutRenames);
  });
});

// =============================================================================
// Lifecycle
// =============================================================================

describe("diffPreparedMirrors: lifecycle", () => {
  it("leaves both mirrors in place, owning no scratch cleanup", async () => {
    await put(BASE, "a.txt", "one\n");
    await put(LIVE, "a.txt", "two\n");
    await run(false);
    expect((await stat(join(tempRoot, BASE))).isDirectory()).toBe(true);
    expect((await stat(join(tempRoot, LIVE))).isDirectory()).toBe(true);
    expect((await stat(join(tempRoot, BASE, "a.txt"))).isFile()).toBe(true);
  });
});
