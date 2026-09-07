// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// The post-race recovery path in `putObject`, driven deterministically.
//
// `object-store.test.ts` proves the concurrency INVARIANT with real IO: sixteen
// concurrent puts agree on a digest and leave one retrievable object. What it
// cannot do is force the platform-specific failure that makes the recovery path
// run, so that path was exercised only by luck. It failed on a Windows CI leg
// for real: the rival won the rename, and the recovery re-read answered EPERM
// instead of ENOENT or bytes, which the strict `readVerified` rethrew.
//
// So this file injects the sequence instead of racing for it. `rename` fails
// once, after the "rival" has published the destination, and the recovery
// `readFile` then fails a controlled number of times before answering. That is
// the real ordering, made repeatable on every platform.
//
// ARMING MATTERS. Recovery failures are armed INSIDE the mocked `rename`, after
// the rival publishes, rather than being live from the start. A counter that is
// live from the start is consumed by the FAST-PATH read, so `putObject` rejects
// before `rename` ever runs and the recovery path is never reached. The
// fast-path test therefore uses its own separate counter.
//
// Both mocks are passthrough by default and intercept only while a test opts in.
// What is load-bearing:
//   - a transient failure while verifying the winner is retried, not surfaced;
//   - a PERSISTENT failure is still surfaced, at an exact bounded attempt count,
//     so this is a retry rather than a swallow;
//   - the initial fast-path read is NOT retried, so permission problems on a
//     quiet filesystem stay immediate;
//   - a corrupt winner is reported at once and never retried.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  /** Remaining `rename` calls that should fail. */
  renameFailures: 0,
  /** Bytes a "rival" publishes at the destination just before rename fails. */
  rivalBytes: null as Buffer | null,
  /** The object path under test. Only reads of THIS path are intercepted. */
  targetPath: null as string | null,
  /**
   * How many recovery reads should fail. Copied into `armedReadFailures` by the
   * mocked `rename`, so it cannot be consumed by the fast-path read.
   */
  recoveryReadFailures: 0,
  /** Live counter, armed at rename time and consumed by `readFile`. */
  armedReadFailures: 0,
  /** Separate counter for the fast-path case, live from the start. */
  fastPathReadFailures: 0,
  /** Every `readFile` path observed, so attempt counts can be asserted. */
  readCalls: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: never, ...rest: never[]) => {
      if (typeof path === "string" && path === hooks.targetPath) {
        hooks.readCalls.push(path);
        if (hooks.fastPathReadFailures > 0) {
          hooks.fastPathReadFailures -= 1;
          throw Object.assign(new Error("EPERM: simulated sharing violation"), { code: "EPERM" });
        }
        if (hooks.armedReadFailures > 0) {
          hooks.armedReadFailures -= 1;
          throw Object.assign(new Error("EPERM: simulated sharing violation"), { code: "EPERM" });
        }
      }
      return await (actual.readFile as (...a: never[]) => Promise<Buffer>)(path, ...rest);
    },
    rename: async (from: never, to: never) => {
      if (hooks.renameFailures > 0) {
        hooks.renameFailures -= 1;
        // The rival publishes FIRST, then our rename fails, then the recovery
        // reads are armed. That ordering is what makes the recovery read
        // meaningful: the bytes are already there when it runs.
        if (hooks.rivalBytes !== null && hooks.targetPath !== null) {
          await actual.mkdir(dirname(hooks.targetPath), { recursive: true });
          await actual.writeFile(hooks.targetPath, hooks.rivalBytes);
        }
        hooks.armedReadFailures = hooks.recoveryReadFailures;
        throw Object.assign(new Error("EPERM: simulated lost rename"), { code: "EPERM" });
      }
      return await (actual.rename as (...a: never[]) => Promise<void>)(from, to);
    },
  };
});

const { ObjectCorruptionError, objectPath, putObject } = await import("../src/object-store.js");

const ABC = Buffer.from("abc", "utf8");
const ABC_DIGEST = createHash("sha256").update(ABC).digest("hex");

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-objstore-race-"));
  hooks.renameFailures = 0;
  hooks.rivalBytes = null;
  hooks.targetPath = objectPath(tmpRoot, ABC_DIGEST);
  hooks.recoveryReadFailures = 0;
  hooks.armedReadFailures = 0;
  hooks.fastPathReadFailures = 0;
  hooks.readCalls = [];
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const targetReads = (): number => hooks.readCalls.length;

describe("putObject: verifying a winner that is still settling", () => {
  it("retries a transient sharing violation and succeeds", async () => {
    hooks.renameFailures = 1;
    hooks.rivalBytes = ABC;
    hooks.recoveryReadFailures = 2;

    await expect(putObject(tmpRoot, ABC)).resolves.toBe(ABC_DIGEST);
    // One fast-path read (ENOENT), two failed recovery reads, then the winner.
    expect(targetReads()).toBe(4);
  });

  it("still fails when the violation is persistent, so this is a retry not a swallow", async () => {
    hooks.renameFailures = 1;
    hooks.rivalBytes = ABC;
    hooks.recoveryReadFailures = Number.MAX_SAFE_INTEGER;

    await expect(putObject(tmpRoot, ABC)).rejects.toMatchObject({ code: "EPERM" });
    // The bound is exact: one fast-path read plus five recovery attempts, which
    // is four backoffs and then the give-up pass. If this number drifts, the
    // retry budget changed and that should be a deliberate decision.
    expect(targetReads()).toBe(6);
  });

  it("reports a corrupt winner immediately and never retries it", async () => {
    hooks.renameFailures = 1;
    hooks.rivalBytes = Buffer.from("not abc", "utf8");

    await expect(putObject(tmpRoot, ABC)).rejects.toBeInstanceOf(ObjectCorruptionError);
    // Fast path plus exactly one recovery read: corruption is an answer, and
    // ObjectCorruptionError carries no `code`, so it is never retried.
    expect(targetReads()).toBe(2);
  });
});

describe("putObject: the fast path stays strict", () => {
  it("does not retry a permission failure on the initial read", async () => {
    // The quiet-filesystem case: no rival, no rename, just a destination that
    // cannot be read. A permission problem here is real and must be immediate.
    const target = hooks.targetPath as string;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, ABC);
    hooks.fastPathReadFailures = 1;

    await expect(putObject(tmpRoot, ABC)).rejects.toMatchObject({ code: "EPERM" });
    expect(targetReads()).toBe(1);
  });
});
