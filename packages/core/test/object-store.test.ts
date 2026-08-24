// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M 0.8.0 step 1 -- the content-addressed object store.
//
// The store's whole claim is that an object is its BYTES, not its path. So the
// tests that matter most are the ones proving a path with the wrong content is
// never treated as a usable object, and never silently repaired.
//
// Expected digests are frozen NIST SHA-256 vectors rather than values
// recomputed with the same library the implementation uses. Recomputing would
// make the assertion circular: it would pass even if both sides hashed
// something other than what was asked for.

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureViberevertDirs,
  getObject,
  hasObject,
  ObjectCorruptionError,
  ObjectNotFoundError,
  objectPath,
  objectRelPath,
  putObject,
  viberevertObjectsDir,
} from "../src/index.js";

// =============================================================================
// Fixtures
// =============================================================================

/** SHA-256 of the empty input. Standard published vector. */
const EMPTY_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** SHA-256 of "abc". Standard published vector. */
const ABC = Buffer.from("abc", "utf8");
const ABC_DIGEST = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/**
 * Bytes that are not valid UTF-8 and include a NUL, built numerically rather
 * than written as a literal.
 */
const BINARY = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80, 0x00, 0xfe]);

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-objects-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Every entry in a digest's shard directory, sorted. */
async function shardEntries(repoRoot: string, digest: string): Promise<readonly string[]> {
  const shard = join(viberevertObjectsDir(repoRoot), digest.slice(0, 2));
  return (await readdir(shard)).sort();
}

/** Shard entries excluding the inert `*.tmp.<hex>` siblings a failed publish can leave. */
async function publishedEntries(repoRoot: string, digest: string): Promise<readonly string[]> {
  return (await shardEntries(repoRoot, digest)).filter((name) => !name.includes(".tmp."));
}

/** Write raw bytes directly at a digest's path, bypassing the store. */
async function plantRaw(repoRoot: string, digest: string, data: Buffer): Promise<string> {
  const path = objectPath(repoRoot, digest);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return path;
}

// =============================================================================
// Digest validation happens before any filesystem access
// =============================================================================

describe("digest validation", () => {
  const INVALID = [
    ["empty", ""],
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["uppercase hex", "A".repeat(64)],
    ["non-hex character", `${"a".repeat(63)}g`],
    ["traversal shape", "../../../etc/passwd"],
    ["separator smuggled in", `${"a".repeat(61)}/..`],
  ] as const;

  it.each(INVALID)("objectPath rejects a %s digest", (_label, digest) => {
    expect(() => objectPath(tmpRoot, digest)).toThrow(/invalid object digest/);
  });

  it.each(INVALID)("objectRelPath rejects a %s digest", (_label, digest) => {
    expect(() => objectRelPath(digest)).toThrow(/invalid object digest/);
  });

  it.each(INVALID)("getObject rejects a %s digest", async (_label, digest) => {
    await expect(getObject(tmpRoot, digest)).rejects.toThrow(/invalid object digest/);
  });

  it.each(INVALID)("hasObject rejects a %s digest", async (_label, digest) => {
    await expect(hasObject(tmpRoot, digest)).rejects.toThrow(/invalid object digest/);
  });

  it("validates before touching the filesystem", async () => {
    // Exercised through the filesystem-facing functions, because objectPath is
    // pure and would report an invalid digest no matter where validation sat.
    // Against a root that does not exist, an implementation that reached the
    // filesystem first would surface a missing-path failure instead, so this
    // pins the ORDERING and not merely the rejection.
    const missingRoot = join(tmpRoot, "does", "not", "exist");

    await expect(getObject(missingRoot, "../../etc/passwd")).rejects.toThrow(
      /invalid object digest/,
    );
    await expect(hasObject(missingRoot, "../../etc/passwd")).rejects.toThrow(
      /invalid object digest/,
    );
  });

  it("does not echo an unbounded rejected digest", () => {
    const huge = "z".repeat(5000);
    try {
      objectRelPath(huge);
      expect.unreachable("expected objectRelPath to throw");
    } catch (err) {
      expect((err as Error).message.length).toBeLessThan(200);
    }
  });
});

// =============================================================================
// Layout
// =============================================================================

describe("layout", () => {
  it("shards on the first two hex characters", () => {
    expect(objectPath(tmpRoot, ABC_DIGEST)).toBe(
      join(tmpRoot, ".viberevert", "objects", "ba", ABC_DIGEST.slice(2)),
    );
  });

  it("keeps objectRelPath POSIX-separated on every platform", () => {
    expect(objectRelPath(ABC_DIGEST)).toBe(`ba/${ABC_DIGEST.slice(2)}`);
    expect(objectRelPath(ABC_DIGEST)).not.toContain("\\");
  });

  it("is NOT created by ensureViberevertDirs", async () => {
    // The store holds contribution content, so it appears on the first object
    // write rather than at init. See viberevertObjectsDir.
    await ensureViberevertDirs(tmpRoot);
    await expect(stat(viberevertObjectsDir(tmpRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the store and shard on first write, with no init required", async () => {
    // No ensureViberevertDirs call, and tmpRoot has no .viberevert at all.
    await putObject(tmpRoot, ABC);
    expect(await publishedEntries(tmpRoot, ABC_DIGEST)).toEqual([ABC_DIGEST.slice(2)]);
  });
});

// =============================================================================
// Round trip
// =============================================================================

describe("round trip", () => {
  it("returns the published SHA-256 vector for 'abc'", async () => {
    expect(await putObject(tmpRoot, ABC)).toBe(ABC_DIGEST);
  });

  it("returns the published SHA-256 vector for empty content", async () => {
    expect(await putObject(tmpRoot, Buffer.alloc(0))).toBe(EMPTY_DIGEST);
  });

  it("stores and returns empty content", async () => {
    // An empty tracked file is legitimate content, not an absent object.
    const digest = await putObject(tmpRoot, Buffer.alloc(0));
    const round = await getObject(tmpRoot, digest);
    expect(round.length).toBe(0);
    expect(await hasObject(tmpRoot, digest)).toBe(true);
  });

  it("round-trips binary content byte for byte", async () => {
    const digest = await putObject(tmpRoot, BINARY);
    expect(await getObject(tmpRoot, digest)).toEqual(BINARY);
  });

  it("gives different content different digests", async () => {
    const a = await putObject(tmpRoot, Buffer.from("one", "utf8"));
    const b = await putObject(tmpRoot, Buffer.from("two", "utf8"));
    expect(a).not.toBe(b);
  });
});

// =============================================================================
// Idempotence and concurrency
// =============================================================================

describe("idempotence", () => {
  it("storing the same content twice is a no-op", async () => {
    const first = await putObject(tmpRoot, ABC);
    const second = await putObject(tmpRoot, ABC);
    expect(second).toBe(first);
    expect(await publishedEntries(tmpRoot, ABC_DIGEST)).toEqual([ABC_DIGEST.slice(2)]);
    expect(await getObject(tmpRoot, ABC_DIGEST)).toEqual(ABC);
  });

  it("concurrent puts of identical content all succeed", async () => {
    // The invariant, not the race: forcing the platform-specific
    // destination-exists rename failure is not portable, but every concurrent
    // put must agree on the digest and leave exactly one retrievable object
    // regardless of which writer won.
    const results = await Promise.all(Array.from({ length: 16 }, () => putObject(tmpRoot, ABC)));

    expect([...new Set(results)]).toEqual([ABC_DIGEST]);
    expect(await publishedEntries(tmpRoot, ABC_DIGEST)).toEqual([ABC_DIGEST.slice(2)]);
    expect(await getObject(tmpRoot, ABC_DIGEST)).toEqual(ABC);
  });

  it("concurrent puts of different content all succeed", async () => {
    const inputs = Array.from({ length: 8 }, (_v, i) => Buffer.from(`payload-${i}`, "utf8"));
    const digests = await Promise.all(inputs.map((buf) => putObject(tmpRoot, buf)));

    expect(new Set(digests).size).toBe(inputs.length);
    for (const [i, digest] of digests.entries()) {
      expect(await getObject(tmpRoot, digest)).toEqual(inputs[i]);
    }
  });
});

// =============================================================================
// Absence
// =============================================================================

describe("absence", () => {
  it("getObject throws ObjectNotFoundError naming the digest", async () => {
    await expect(getObject(tmpRoot, ABC_DIGEST)).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(getObject(tmpRoot, ABC_DIGEST)).rejects.toMatchObject({
      name: "ObjectNotFoundError",
      digest: ABC_DIGEST,
    });
  });

  it("hasObject returns false rather than throwing", async () => {
    expect(await hasObject(tmpRoot, ABC_DIGEST)).toBe(false);
  });

  it("reports absence even when the shard exists but the object does not", async () => {
    await putObject(tmpRoot, ABC);
    // Same shard "ba", different remainder.
    const sameShard = `ba${"c".repeat(62)}`;
    expect(await hasObject(tmpRoot, sameShard)).toBe(false);
  });
});

// =============================================================================
// Corruption
// =============================================================================

describe("corruption", () => {
  const WRONG = Buffer.from("these are not the bytes you are looking for", "utf8");

  it("getObject throws ObjectCorruptionError with both digests and the path", async () => {
    const path = await plantRaw(tmpRoot, ABC_DIGEST, WRONG);

    await expect(getObject(tmpRoot, ABC_DIGEST)).rejects.toBeInstanceOf(ObjectCorruptionError);
    await expect(getObject(tmpRoot, ABC_DIGEST)).rejects.toMatchObject({
      name: "ObjectCorruptionError",
      expectedDigest: ABC_DIGEST,
      objectPath: path,
    });

    const err = await getObject(tmpRoot, ABC_DIGEST).catch((e: unknown) => e);
    expect((err as ObjectCorruptionError).actualDigest).toMatch(/^[0-9a-f]{64}$/);
    expect((err as ObjectCorruptionError).actualDigest).not.toBe(ABC_DIGEST);
  });

  it("hasObject throws rather than answering false", async () => {
    // Damaged evidence and absent evidence call for different responses, so
    // this must never collapse into `false`.
    await plantRaw(tmpRoot, ABC_DIGEST, WRONG);
    await expect(hasObject(tmpRoot, ABC_DIGEST)).rejects.toBeInstanceOf(ObjectCorruptionError);
  });

  it("putObject refuses and NEVER repairs by overwriting", async () => {
    // The load-bearing case. Silently replacing the damaged bytes would destroy
    // the only evidence that the store was corrupted.
    const path = await plantRaw(tmpRoot, ABC_DIGEST, WRONG);

    await expect(putObject(tmpRoot, ABC)).rejects.toBeInstanceOf(ObjectCorruptionError);
    expect(await readFile(path)).toEqual(WRONG);
  });

  it("leaves an unrelated valid object untouched", async () => {
    const goodDigest = await putObject(tmpRoot, BINARY);
    await plantRaw(tmpRoot, ABC_DIGEST, WRONG);

    await expect(getObject(tmpRoot, ABC_DIGEST)).rejects.toBeInstanceOf(ObjectCorruptionError);
    expect(await getObject(tmpRoot, goodDigest)).toEqual(BINARY);
  });
});
