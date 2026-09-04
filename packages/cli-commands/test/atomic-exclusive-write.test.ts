// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Tests for `writeFileExclusiveAtomic` in packages/cli-commands/src/atomic.ts.
//
// Separate from atomic.test.ts on purpose. Two of the branches here cannot be
// reached with real IO alone:
//
//   - the step-3 contract (a cleanup failure must NOT turn a successful
//     publication into a reported failure) needs `unlink` to fail;
//   - the step-1 branch (a collision at the TEMP path belongs to a peer and
//     must be left alone) needs a predictable temp suffix, which means a
//     deterministic `randomBytes`.
//
// So this file mocks `node:fs/promises` and `node:crypto`. Keeping it separate
// means neither mock ever sits over the `renameDirAtomic` tests, which
// deliberately exercise the real filesystem.
//
// Both mocks are passthrough by default and intercept only while a test opts
// in: `unlink` only for `.tmp.` paths, `randomBytes` only when a fixed suffix
// is set. Every other operation in this file, including the assertions that
// read published bytes, is real IO.
//
// What is load-bearing here:
//   - the destination is never overwritten, and a refused write leaves the
//     existing bytes byte-for-byte intact;
//   - cleanup removes THIS call's temp sibling and never a peer's, on both the
//     step-1 and step-2 failure paths, which differ in who owns the temp file;
//   - a post-link cleanup failure still resolves, because the artifact is
//     already published and reporting a failure would point the error in the
//     dangerous direction;
//   - under a genuine race exactly one writer publishes, and the destination
//     holds that writer's COMPLETE bytes rather than a blend.

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  failTempUnlink: false,
  fixedSuffix: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (hooks.failTempUnlink && typeof path === "string" && path.includes(".tmp.")) {
        throw Object.assign(new Error("EPERM: simulated cleanup failure"), { code: "EPERM" });
      }
      return await actual.unlink(path);
    },
  };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: (size: number) =>
      hooks.fixedSuffix === null ? actual.randomBytes(size) : Buffer.from(hooks.fixedSuffix, "hex"),
  };
});

import { writeFileExclusiveAtomic } from "../src/atomic.js";

/** 8 bytes, so `randomBytes(8).toString("hex")` reproduces it exactly. */
const FIXED_SUFFIX = "deadbeefdeadbeef";

let workDir: string;

beforeEach(async () => {
  hooks.failTempUnlink = false;
  hooks.fixedSuffix = null;
  workDir = await mkdtemp(join(tmpdir(), "viberevert-cli-exclusive-write-"));
});

afterEach(async () => {
  hooks.failTempUnlink = false;
  hooks.fixedSuffix = null;
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Temp siblings OF THIS DESTINATION, by name.
 *
 * Scoped to the `<dest>.tmp.` prefix rather than to every `.tmp.` entry in the
 * directory: a broader check would start asserting about unrelated files and
 * would fail for reasons that have nothing to do with this helper.
 */
async function tempSiblings(dest: string): Promise<string[]> {
  const prefix = `${basename(dest)}.tmp.`;
  const entries = await readdir(dirname(dest));
  return entries.filter((name) => name.startsWith(prefix)).sort();
}

async function captureRejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject, but it resolved");
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

describe("writeFileExclusiveAtomic: publication", () => {
  it("writes an absent destination and leaves no temp sibling", async () => {
    const dest = join(workDir, "receipt.json");

    await writeFileExclusiveAtomic(dest, '{"outcome":"succeeded"}');

    expect(await readFile(dest, "utf8")).toBe('{"outcome":"succeeded"}');
    expect(await tempSiblings(dest)).toEqual([]);
  });

  it("writes Buffer data unchanged", async () => {
    const dest = join(workDir, "receipt.bin");
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff]);

    await writeFileExclusiveAtomic(dest, bytes);

    expect(await readFile(dest)).toEqual(bytes);
  });
});

describe("writeFileExclusiveAtomic: no-overwrite", () => {
  it("refuses an existing destination with EEXIST and leaves its bytes untouched", async () => {
    const dest = join(workDir, "receipt.json");
    await writeFile(dest, "ORIGINAL");

    const err = await captureRejection(() => writeFileExclusiveAtomic(dest, "REPLACEMENT"));

    expect(codeOf(err)).toBe("EEXIST");
    expect(await readFile(dest, "utf8")).toBe("ORIGINAL");
  });

  it("a step-2 failure removes THIS call's temp sibling and not a peer's", async () => {
    const dest = join(workDir, "receipt.json");
    await writeFile(dest, "ORIGINAL");

    // A foreign temp sibling standing in for another writer's in-flight file.
    // The suffix is fixed rather than random so the assertion can name it. The
    // call under test still picks a RANDOM suffix here, so it reaches step 2.
    const peerName = `${basename(dest)}.tmp.0123456789abcdef`;
    await writeFile(join(workDir, peerName), "PEER IN FLIGHT");

    const err = await captureRejection(() => writeFileExclusiveAtomic(dest, "REPLACEMENT"));
    expect(codeOf(err)).toBe("EEXIST");

    // Exactly the peer's file remains: this call cleaned up after itself and
    // touched nothing it did not create.
    expect(await tempSiblings(dest)).toEqual([peerName]);
    expect(await readFile(join(workDir, peerName), "utf8")).toBe("PEER IN FLIGHT");
    expect(await readFile(dest, "utf8")).toBe("ORIGINAL");
  });
});

describe("writeFileExclusiveAtomic: a step-1 collision belongs to a peer", () => {
  it("rejects with EEXIST, leaves the peer's bytes intact, and publishes nothing", async () => {
    const dest = join(workDir, "receipt.json");
    hooks.fixedSuffix = FIXED_SUFFIX;

    // The call under test will choose exactly this temp path, so its `wx`
    // write collides at STEP 1 rather than at the destination.
    const peerName = `${basename(dest)}.tmp.${FIXED_SUFFIX}`;
    await writeFile(join(workDir, peerName), "PEER IN FLIGHT");

    const err = await captureRejection(() => writeFileExclusiveAtomic(dest, "REPLACEMENT"));
    expect(codeOf(err)).toBe("EEXIST");

    // The peer's in-flight bytes survive. This call did NOT create that file,
    // so deleting it would have destroyed another writer's work mid-flight.
    expect(await readFile(join(workDir, peerName), "utf8")).toBe("PEER IN FLIGHT");
    expect(await tempSiblings(dest)).toEqual([peerName]);

    // And nothing reached the destination.
    expect(await readdir(workDir)).not.toContain(basename(dest));
  });
});

describe("writeFileExclusiveAtomic: cleanup failure after publication", () => {
  it("resolves successfully and leaves the published bytes valid", async () => {
    const dest = join(workDir, "receipt.json");
    hooks.failTempUnlink = true;

    // Must NOT reject: the link already succeeded, so the receipt IS published.
    await expect(writeFileExclusiveAtomic(dest, "PUBLISHED")).resolves.toBeUndefined();

    expect(await readFile(dest, "utf8")).toBe("PUBLISHED");

    // The debris the contract explicitly tolerates: one temp sibling, holding
    // the complete written content. This asserts the leftover is whole and
    // consistent with what was published; it says nothing about inode identity,
    // which is not portably observable here.
    const leftovers = await tempSiblings(dest);
    expect(leftovers).toHaveLength(1);
    expect(await readFile(join(workDir, leftovers[0] as string), "utf8")).toBe("PUBLISHED");
  });
});

describe("writeFileExclusiveAtomic: concurrent writers", () => {
  it("exactly one publishes, the other gets EEXIST, and the bytes are one writer's whole content", async () => {
    const dest = join(workDir, "receipt.json");
    // Deliberately NOT using the fixed-suffix hook: both writers must get
    // distinct temp paths so they genuinely race at `link`, which is the
    // contended step, rather than colliding at the temp write.
    //
    // Large and distinguishable, so a blended or truncated result cannot pass
    // as either writer's content.
    const contentA = `A${"a".repeat(64 * 1024)}`;
    const contentB = `B${"b".repeat(64 * 1024)}`;

    const [resultA, resultB] = await Promise.allSettled([
      writeFileExclusiveAtomic(dest, contentA),
      writeFileExclusiveAtomic(dest, contentB),
    ]);

    const statuses = [resultA.status, resultB.status];
    expect(statuses.filter((s) => s === "fulfilled")).toHaveLength(1);
    expect(statuses.filter((s) => s === "rejected")).toHaveLength(1);

    const rejected = resultA.status === "rejected" ? resultA : resultB;
    if (rejected.status !== "rejected") {
      throw new Error("expected exactly one rejection");
    }
    expect(codeOf(rejected.reason)).toBe("EEXIST");

    // The winner is derived from which promise fulfilled, never assumed from
    // scheduling order.
    const winner = resultA.status === "fulfilled" ? contentA : contentB;
    expect(await readFile(dest, "utf8")).toBe(winner);

    // Both writers cleaned up: the winner after linking, the loser after
    // failing to link.
    expect(await tempSiblings(dest)).toEqual([]);
  });
});
