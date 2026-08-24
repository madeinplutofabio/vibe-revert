// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Content-addressed object store for M 0.8.0 session contributions.
//
// Layout: `.viberevert/objects/<first-2-hex>/<remaining-62-hex>`. The
// two-character shard exists because a flat directory would accumulate one
// entry per distinct blob across every session in the repository, which
// degrades on several filesystems. Shards are created lazily on first write;
// see `viberevertObjectsDir` for why `init` does not pre-create the store.
//
// A digest is 64 lowercase hex characters, the same representation the
// persisted schemas use (`sha256ObjectRef` is `z.hash("sha256")`, not a
// prefixed `sha256:<hex>` form). What `putObject` returns is therefore
// directly usable as a `content_ref`.
//
// =============================================================================
// The contract: an object is its bytes, not its path
// =============================================================================
//
// Every operation verifies content against the digest it was addressed by.
// That is what makes this an evidence store rather than a cache:
//
//   putObject   existing + valid   -> success, nothing written
//               existing + invalid -> ObjectCorruptionError, NEVER overwritten
//               absent             -> published atomically
//   getObject   missing -> ObjectNotFoundError, corrupt -> ObjectCorruptionError
//   hasObject   missing -> false,  corrupt -> ObjectCorruptionError
//
// `hasObject` deliberately does not answer "does this path exist". A caller
// receiving `true` for a path holding the wrong bytes would conclude it holds
// recoverable evidence when it does not. The cost is that `hasObject` is
// O(size), since validity cannot be established without reading: a caller that
// is going to fetch anyway should call `getObject` and catch
// `ObjectNotFoundError` rather than asking twice.
//
// =============================================================================
// Why no atomic-no-replace primitive is needed
// =============================================================================
//
// A general no-replace publish is hard to do portably in Node, and this store
// does not need one. The destination name is DERIVED from the bytes, so the
// only way a rename can clobber is if the existing file already holds
// byte-identical content. Verify-before-write is what provides the real
// guarantee; the absence of a clobber is not.
//
// Two processes storing the same content is the expected case, not an exotic
// one, so the concurrent path is a supported outcome rather than an error.
// `writeFileAtomic` ends in a bare `rename`, whose behavior over an existing
// destination differs by platform: POSIX typically replaces, Windows typically
// fails. So a failed publish is recovered by RE-READING the destination and
// verifying it, rather than by inspecting the error code. Switching on errno
// across platforms is unreliable; re-deriving the truth from the filesystem is
// not. If the destination is still absent, the original error is rethrown, so a
// genuine I/O failure is never laundered into success.
//
// =============================================================================
// Limits, stated rather than implied
// =============================================================================
//
//   - NOT an fsync durability claim. `writeFileAtomic` does not fsync, and
//     0.8.0 does not change the project's durability model.
//   - A failed publish can leave an inert `*.tmp.<hex>` sibling inside a shard,
//     per the existing no-cleanup-on-failure policy. That is safe here because
//     objects are addressed by computed path and nothing iterates a shard, but
//     a future `gc` walking `objects/` MUST skip `.tmp.` siblings.
//   - Digest arguments are validated before any filesystem access. That is a
//     path-traversal guard, not only hygiene: `content_ref` values arrive from
//     a persisted contribution, and a crafted one must not be able to address
//     outside the store.
//   - A non-VibeRevert process writing garbage at an object path between the
//     check and the rename is outside the threat model. A hostile local process
//     can corrupt any file this tool relies on.
//   - No size cap and no garbage collection. Both deferred.

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { viberevertObjectsDir } from "./paths.js";

/** The persisted digest representation: 64 lowercase hex characters. */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Characters of the digest used as the shard directory name. */
const SHARD_LENGTH = 2;

/** Bound on how much of a rejected digest is echoed back in an error. */
const DIGEST_ECHO_LIMIT = 80;

/**
 * Thrown by `getObject` when no object is stored under the requested digest.
 *
 * Distinct from `ObjectCorruptionError` because the two demand different
 * responses: a missing object means the evidence was never stored or has been
 * removed, while a corrupt one means what is stored cannot be trusted.
 */
export class ObjectNotFoundError extends Error {
  readonly digest: string;

  constructor(digest: string) {
    super(`object not found in the VibeRevert object store: ${digest}`);
    this.name = "ObjectNotFoundError";
    this.digest = digest;
  }
}

/**
 * Thrown when the bytes stored at a digest's path do not hash to that digest.
 *
 * This is never recovered from automatically and never repaired by overwriting.
 * The stored bytes are preserved so the damage can be inspected.
 */
export class ObjectCorruptionError extends Error {
  readonly expectedDigest: string;
  readonly actualDigest: string;
  readonly objectPath: string;

  constructor(expectedDigest: string, actualDigest: string, objectPath: string) {
    super(
      `object store corruption: ${objectPath} holds content with digest ${actualDigest}, expected ${expectedDigest}`,
    );
    this.name = "ObjectCorruptionError";
    this.expectedDigest = expectedDigest;
    this.actualDigest = actualDigest;
    this.objectPath = objectPath;
  }
}

/** Rejects anything that is not the persisted digest representation. */
function assertDigest(digest: string): void {
  if (!DIGEST_PATTERN.test(digest)) {
    const echo =
      digest.length > DIGEST_ECHO_LIMIT ? `${digest.slice(0, DIGEST_ECHO_LIMIT)}...` : digest;
    throw new Error(
      `invalid object digest: expected 64 lowercase hex characters, got ${JSON.stringify(echo)}`,
    );
  }
}

/** SHA-256 of `data` as 64 lowercase hex characters. */
function digestOf(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Store-relative path for `digest`, POSIX-separated: `"ab/cdef..."`.
 *
 * For display, documentation, and tests. Use `objectPath` to address the
 * filesystem; this form deliberately does not vary by platform.
 */
export function objectRelPath(digest: string): string {
  assertDigest(digest);
  return `${digest.slice(0, SHARD_LENGTH)}/${digest.slice(SHARD_LENGTH)}`;
}

/** Absolute filesystem path for `digest` within `repoRoot`. Pure path-join. */
export function objectPath(repoRoot: string, digest: string): string {
  assertDigest(digest);
  return join(
    viberevertObjectsDir(repoRoot),
    digest.slice(0, SHARD_LENGTH),
    digest.slice(SHARD_LENGTH),
  );
}

/**
 * Read `path` and verify it hashes to `digest`.
 *
 * Returns `undefined` when the path does not exist, throws
 * `ObjectCorruptionError` when it exists with different content, and
 * propagates every other filesystem error unchanged. A directory sitting at an
 * object path is a filesystem anomaly outside this store's model and surfaces
 * as its underlying error rather than being reinterpreted.
 */
async function readVerified(path: string, digest: string): Promise<Buffer | undefined> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const actual = digestOf(data);
  if (actual !== digest) throw new ObjectCorruptionError(digest, actual, path);
  return data;
}

/**
 * Store `data` and return its digest.
 *
 * Idempotent: storing content that is already present succeeds without writing.
 * Never overwrites a digest path whose bytes disagree with it.
 */
export async function putObject(repoRoot: string, data: Buffer): Promise<string> {
  const digest = digestOf(data);
  const path = objectPath(repoRoot, digest);

  if ((await readVerified(path, digest)) !== undefined) return digest;

  await mkdir(dirname(path), { recursive: true });

  try {
    await writeFileAtomic(path, data);
  } catch (err) {
    // A concurrent writer may have published this digest between the check
    // above and the rename. Re-derive the outcome from the filesystem instead
    // of interpreting the error, and rethrow if the destination is still
    // absent.
    if ((await readVerified(path, digest)) !== undefined) return digest;
    throw err;
  }

  return digest;
}

/**
 * Read the object stored under `digest`, verifying it before returning.
 *
 * Throws `ObjectNotFoundError` if absent, `ObjectCorruptionError` if the stored
 * bytes disagree with the digest.
 */
export async function getObject(repoRoot: string, digest: string): Promise<Buffer> {
  const path = objectPath(repoRoot, digest);
  const data = await readVerified(path, digest);
  if (data === undefined) throw new ObjectNotFoundError(digest);
  return data;
}

/**
 * Whether a VALID object is stored under `digest`.
 *
 * `false` means absent. Corruption throws rather than returning `false`,
 * because "no usable object here" and "damaged evidence here" call for
 * different responses.
 */
export async function hasObject(repoRoot: string, digest: string): Promise<boolean> {
  const path = objectPath(repoRoot, digest);
  return (await readVerified(path, digest)) !== undefined;
}
