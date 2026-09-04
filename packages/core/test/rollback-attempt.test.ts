// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for RollbackAttempt publication (M 0.8.0 step 10E).
//
// Four sections:
//   A. publication                     (1-6)
//   B. caller-field validation         (7-10)
//   C. control-plane ancestry          (11-16)
//   D. source invariants               (17)
//
// No git repository is involved: this writer publishes a control-plane artifact
// and performs no git-state validation. The fixture is a temp directory holding
// a `.viberevert/sessions/<sess>/` tree, plus a sibling `outside/` that exists
// specifically so an escaping path resolves somewhere REAL rather than failing
// for the wrong reason.

import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ROLLBACK_ATTEMPT_SCHEMA_VERSION,
  RollbackAttemptSchema,
  type RollbackSelection,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";
import {
  type PublishRollbackAttemptOpts,
  publishRollbackAttempt,
  rollbackInvocationPaths,
  sessionRollbacksDir,
} from "../src/rollback-attempt.js";

// =============================================================================
// Fixtures
// =============================================================================

const SESSION_ID = "sess_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const CHECKPOINT_ID = "cp_01JV8Y7W2M7AABCDEFGHJKMNPQ";
const CONTRIBUTION_SHA = "a".repeat(64);
const CHANGE_GROUP = `cg_${"0".repeat(63)}1`;

const SELECTION: RollbackSelection = {
  selectors: { only: ["src/**"] },
  resolved_change_group_ids: [CHANGE_GROUP],
};

const isPosix = process.platform !== "win32";

interface Fixture {
  /** The temp root ENCLOSING both `repoRoot` and `outside`. */
  readonly root: string;
  readonly repoRoot: string;
  readonly outside: string;
  readonly cleanup: () => Promise<void>;
}

/** `withSession` false leaves `.viberevert/sessions/` without the session dir. */
async function setup(withSession = true): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "viberevert-attemptfixture-"));
  const repoRoot = join(root, "repo");
  const outside = join(root, "outside");
  await mkdir(join(repoRoot, ".viberevert", "sessions"), { recursive: true });
  await mkdir(outside, { recursive: true });
  if (withSession) {
    await mkdir(join(repoRoot, ".viberevert", "sessions", SESSION_ID), { recursive: true });
  }
  return { root, repoRoot, outside, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const validOpts = (fx: Fixture): PublishRollbackAttemptOpts => ({
  repoRoot: fx.repoRoot,
  sessionId: SESSION_ID,
  contributionSha256: CONTRIBUTION_SHA,
  preRollbackCheckpointId: CHECKPOINT_ID,
  selection: SELECTION,
});

const viberevertDirOf = (fx: Fixture): string => join(fx.repoRoot, ".viberevert");

const sessionsDirOf = (fx: Fixture): string => join(viberevertDirOf(fx), "sessions");

const sessionDirOf = (fx: Fixture): string => join(sessionsDirOf(fx), SESSION_ID);

const rollbacksDirOf = (fx: Fixture): string => join(sessionDirOf(fx), "rollbacks");

/**
 * Every entry beneath `root`, relative and kind-tagged, sorted.
 *
 * `withFileTypes` carries lstat semantics, and only real directories are
 * descended, so a symlink is recorded as a symlink and never followed. This is
 * what makes "zero filesystem effect" checkable across a whole namespace rather
 * than only where a correct implementation would have written.
 */
async function treeEntries(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const dirents = await readdir(rel === "" ? root : join(root, rel), { withFileTypes: true });
    for (const dirent of dirents) {
      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      const kind = dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "dir" : "file";
      out.push(`${childRel}:${kind}`);
      if (kind === "dir") await walk(childRel);
    }
  };
  await walk("");
  return out.sort();
}

/** The single rollback directory, for cases that do not get one returned. */
async function soleRollbackDir(fx: Fixture): Promise<string> {
  const names = await readdir(rollbacksDirOf(fx));
  expect(names).toHaveLength(1);
  return join(rollbacksDirOf(fx), names[0] as string);
}

// =============================================================================
// Section A: publication
// =============================================================================

describe("publishRollbackAttempt: publication", () => {
  it("1: publishes attempt.json under sessions/<sess>/rollbacks/<rb>/", async () => {
    const fx = await setup();
    try {
      const published = await publishRollbackAttempt(validOpts(fx));

      expect(published.rollbackId).toMatch(/^rb_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(published.rollbackDir).toBe(join(rollbacksDirOf(fx), published.rollbackId));
      expect((await lstat(join(published.rollbackDir, "attempt.json"))).isFile()).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it("2: persists two-space JSON with NO trailing newline", async () => {
    const fx = await setup();
    try {
      const published = await publishRollbackAttempt(validOpts(fx));
      const bytes = await readFile(join(published.rollbackDir, "attempt.json"), "utf8");

      // Byte-exact against the package's established convention.
      expect(bytes).toBe(JSON.stringify(published.attempt, null, 2));
      expect(bytes.endsWith("\n")).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  it("3: what was written re-parses and equals what was returned", async () => {
    const fx = await setup();
    try {
      const published = await publishRollbackAttempt(validOpts(fx));
      const raw = await readFile(join(published.rollbackDir, "attempt.json"), "utf8");

      expect(RollbackAttemptSchema.parse(JSON.parse(raw))).toEqual(published.attempt);
    } finally {
      await fx.cleanup();
    }
  });

  it("4: records the marker state and schema version", async () => {
    const fx = await setup();
    try {
      const { attempt } = await publishRollbackAttempt(validOpts(fx));

      expect(attempt.state).toBe("mutation_may_have_started");
      expect(attempt.schema_version).toBe(ROLLBACK_ATTEMPT_SCHEMA_VERSION);
      expect(attempt.session_id).toBe(SESSION_ID);
      expect(attempt.pre_rollback_checkpoint_id).toBe(CHECKPOINT_ID);
      expect(attempt.contribution_sha256).toBe(CONTRIBUTION_SHA);
      expect(attempt.selection).toEqual(SELECTION);
    } finally {
      await fx.cleanup();
    }
  });

  it("5: two publications yield different ids and sibling directories", async () => {
    const fx = await setup();
    try {
      const first = await publishRollbackAttempt(validOpts(fx));
      const second = await publishRollbackAttempt(validOpts(fx));

      expect(first.rollbackId).not.toBe(second.rollbackId);
      expect((await readdir(rollbacksDirOf(fx))).sort()).toEqual(
        [first.rollbackId, second.rollbackId].sort(),
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("6: written_at is sampled INSIDE the call", async () => {
    const fx = await setup();
    try {
      const before = Date.now();
      const { attempt } = await publishRollbackAttempt(validOpts(fx));
      const after = Date.now();

      // Bounds are second-normalized because the schema stores second precision:
      // a sample at 12:00:00.950 persists as 12:00:00.000, which would compare
      // earlier than an unnormalized `before` of 12:00:00.900.
      const writtenAt = Date.parse(attempt.written_at);
      expect(writtenAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      expect(writtenAt).toBeLessThanOrEqual(Math.floor(after / 1000) * 1000);
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section B: caller-field validation
// =============================================================================

describe("publishRollbackAttempt: caller-field validation", () => {
  it("7: a malformed sessionId throws with ZERO filesystem effect", async () => {
    const fx = await setup();
    try {
      // Snapshotting the ENCLOSING temp root, not just the repository. A
      // malformed id can escape `repoRoot` entirely:
      //
      //   join(repoRoot, ".viberevert", "sessions", "../../../outside")
      //     -> <tmp>/outside
      //
      // which the fixture creates as a REAL directory, so a regression to the
      // weak field schema would pass the ancestry check and create
      // `<tmp>/outside/rollbacks/<rb>/` while the repository looked untouched.
      for (const bad of ["..", "../..", "../../../outside", "foo/bar", "sess_short", ""]) {
        const before = await treeEntries(fx.root);
        await expect(publishRollbackAttempt({ ...validOpts(fx), sessionId: bad })).rejects.toThrow(
          /sessionId must match sess_<ULID>/,
        );
        expect(await treeEntries(fx.root)).toEqual(before);
      }
    } finally {
      await fx.cleanup();
    }
  });

  it("8: a malformed contributionSha256 throws before anything is reserved", async () => {
    const fx = await setup();
    try {
      const before = await treeEntries(fx.root);
      await expect(
        publishRollbackAttempt({ ...validOpts(fx), contributionSha256: "not-a-digest" }),
      ).rejects.toThrow();
      expect(await treeEntries(fx.root)).toEqual(before);
    } finally {
      await fx.cleanup();
    }
  });

  it("9: a malformed selection throws before anything is reserved", async () => {
    const fx = await setup();
    try {
      const before = await treeEntries(fx.root);

      // No selector family present: this is the legacy full-session path, which
      // never writes a marker.
      await expect(
        publishRollbackAttempt({
          ...validOpts(fx),
          selection: { selectors: {}, resolved_change_group_ids: [CHANGE_GROUP] },
        }),
      ).rejects.toThrow();

      // An empty resolution refuses BEFORE mutation, so no marker exists for one.
      await expect(
        publishRollbackAttempt({
          ...validOpts(fx),
          selection: { selectors: { only: ["src/**"] }, resolved_change_group_ids: [] },
        }),
      ).rejects.toThrow();

      expect(await treeEntries(fx.root)).toEqual(before);
    } finally {
      await fx.cleanup();
    }
  });

  it("10: a malformed checkpoint id throws, leaving an INERT empty directory", async () => {
    const fx = await setup();
    try {
      // Deliberately different from cases 8 and 9. `pre_rollback_checkpoint_id`
      // is only `nonBlankString` at field level -- its `cp_<ULID>` shape is a
      // top-level refinement -- so a non-blank malformed value survives early
      // validation and is caught by the full parse, AFTER the directory is
      // reserved. It is not a path component, so nothing unsafe follows.
      await expect(
        publishRollbackAttempt({ ...validOpts(fx), preRollbackCheckpointId: "not-a-checkpoint" }),
      ).rejects.toThrow();

      const stranded = await soleRollbackDir(fx);
      // No marker, so nothing claims mutation may have started.
      expect(await readdir(stranded)).toEqual([]);
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section C: control-plane ancestry
// =============================================================================

describe("publishRollbackAttempt: control-plane ancestry", () => {
  it("11: a missing component is named and refused", async () => {
    const fx = await setup(false);
    try {
      // sessions/ exists but the session directory does not.
      await expect(publishRollbackAttempt(validOpts(fx))).rejects.toThrow(
        /the session directory does not exist/,
      );

      await rm(sessionsDirOf(fx), { recursive: true });
      await expect(publishRollbackAttempt(validOpts(fx))).rejects.toThrow(
        /the sessions directory does not exist/,
      );

      await rm(viberevertDirOf(fx), { recursive: true });
      await expect(publishRollbackAttempt(validOpts(fx))).rejects.toThrow(
        /the \.viberevert directory does not exist/,
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("12: a session path that is a FILE is refused", async () => {
    const fx = await setup(false);
    try {
      await writeFile(sessionDirOf(fx), "not a directory\n", "utf8");

      await expect(publishRollbackAttempt(validOpts(fx))).rejects.toThrow(
        /the session directory is not a real directory/,
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("13: EVERY symlinked control-plane component is refused (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();

    // All three components, because checking only the innermost would let a
    // regression at either outer `requireRealDirectory` publish outside the
    // store while the suite stayed green. Each target is a REAL directory
    // containing exactly what the writer would need, so the refusal is about
    // the stable symlink itself rather than an invalid target.

    // .viberevert -> outside, with outside/sessions/<sess>/ present
    {
      const fx = await setup();
      try {
        await rm(viberevertDirOf(fx), { recursive: true });
        await mkdir(join(fx.outside, "sessions", SESSION_ID), { recursive: true });
        await symlink(fx.outside, viberevertDirOf(fx));

        const before = await treeEntries(fx.outside);
        await expect(publishRollbackAttempt(validOpts(fx))).rejects.toThrow(
          /the \.viberevert directory is not a real directory/,
        );
        expect(await treeEntries(fx.outside)).toEqual(before);
      } finally {
        await fx.cleanup();
      }
    }

    // .viberevert/sessions -> outside, with outside/<sess>/ present
    {
      const fx = await setup();
      try {
        await rm(sessionsDirOf(fx), { recursive: true });
        await mkdir(join(fx.outside, SESSION_ID), { recursive: true });
        await symlink(fx.outside, sessionsDirOf(fx));

        const before = await treeEntries(fx.outside);
        await expect(publishRollbackAttempt(validOpts(fx))).rejects.toThrow(
          /the sessions directory is not a real directory/,
        );
        expect(await treeEntries(fx.outside)).toEqual(before);
      } finally {
        await fx.cleanup();
      }
    }

    // .viberevert/sessions/<sess> -> outside
    {
      const fx = await setup(false);
      try {
        await symlink(fx.outside, sessionDirOf(fx));

        const before = await treeEntries(fx.outside);
        await expect(publishRollbackAttempt(validOpts(fx))).rejects.toThrow(
          /the session directory is not a real directory/,
        );
        expect(await treeEntries(fx.outside)).toEqual(before);
      } finally {
        await fx.cleanup();
      }
    }
  });

  it("14: a SYMLINKED rollbacks directory is refused, creating nothing outside (POSIX)", async (ctx) => {
    if (!isPosix) ctx.skip();
    const fx = await setup();
    try {
      // The concrete hole: `mkdir` follows symlinked ancestors, so without the
      // non-recursive create-then-inspect this would place the supposedly
      // protected rb_<ULID> outside the store entirely.
      await symlink(fx.outside, rollbacksDirOf(fx));

      const before = await treeEntries(fx.outside);
      await expect(publishRollbackAttempt(validOpts(fx))).rejects.toThrow(
        /the session's rollbacks directory is not a real directory/,
      );
      expect(await treeEntries(fx.outside)).toEqual(before);
    } finally {
      await fx.cleanup();
    }
  });

  it("15: a rollbacks path that is a FILE is refused", async () => {
    const fx = await setup();
    try {
      await writeFile(rollbacksDirOf(fx), "not a directory\n", "utf8");

      await expect(publishRollbackAttempt(validOpts(fx))).rejects.toThrow(
        /the session's rollbacks directory is not a real directory/,
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("16: an existing real rollbacks directory is reused", async () => {
    const fx = await setup();
    try {
      await mkdir(rollbacksDirOf(fx));

      const published = await publishRollbackAttempt(validOpts(fx));
      expect((await lstat(join(published.rollbackDir, "attempt.json"))).isFile()).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });
});

// =============================================================================
// Section D: source invariants
// =============================================================================
//
// The final `mkdir` collision cannot be forced through the public API from one
// test process: `generateRollbackId` is a monotonic factory cached per
// (namespace, seed, fixedNow), so successive calls increment rather than repeat
// even with `VIBEREVERT_TEST_FIXED_ULID_SEED` set.
//
// What can actually regress is not `mkdir`'s kernel semantics but whether we
// pass `{ recursive: true }`, which would silently succeed on an existing
// directory and destroy the immutability guarantee outright. That is a source
// property, so the test is one.

describe("source invariants", () => {
  it("17: the final mkdir is non-recursive and written_at is sampled internally", async () => {
    const source = await readFile(new URL("../src/rollback-attempt.ts", import.meta.url), "utf8");

    // Exclusive creation of the rollback directory, with no options argument.
    expect(source).toContain("await mkdir(rollbackDir);");
    expect(source).not.toContain("mkdir(rollbackDir,");

    // No caller-supplied timestamp in the input surface. Scoped to the options
    // interface because the module legitimately uses a local `writtenAt` for
    // the value it samples itself.
    const start = source.indexOf("export interface PublishRollbackAttemptOpts {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const optsInterface = source.slice(start, end);

    expect(optsInterface).not.toContain("writtenAt");
    expect(optsInterface).not.toContain("written_at");

    // And the sampling expression itself. Without this, a later `now?: Date`
    // feeding `toIsoSecondString(opts.now ?? new Date())` would leave both case
    // 6 and the interface check green while reintroducing the override.
    expect(source).toContain("const writtenAt = toIsoSecondString(new Date());");
  });
});

// =============================================================================
// E. the invocation layout helpers (M 0.8.0)
//
// A publication returns its own `rollbackDir`, so a publisher never
// reconstructs the layout. A SCAN has no prior publication to return one, which
// is why the convention has to be nameable at all. These helpers are the only
// public way to name it: the storage filenames stay private, so core can rename
// either artifact without touching a consumer.
// =============================================================================

describe("selective rollback invocation layout", () => {
  it("18: sessionRollbacksDir names the session's rollbacks directory", () => {
    const repoRoot = join("/repo");
    const sessionId = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";

    expect(sessionRollbacksDir(repoRoot, sessionId)).toBe(
      join(repoRoot, ".viberevert", "sessions", sessionId, "rollbacks"),
    );
  });

  it("19: rollbackInvocationPaths returns BOTH artifacts of one invocation", () => {
    const rollbackDir = join("/repo", ".viberevert", "x", "rb_01ARZ3NDEKTSV4RRFFQ69G5FAV");

    const paths = rollbackInvocationPaths(rollbackDir);

    // Returned together because the pair is what the state machine reads: the
    // marker alone means "may have started and did not finalize", and only the
    // sibling finalizes it. A one-at-a-time helper would invite a consumer to
    // check the marker and forget the sibling.
    expect(paths.attemptPath).toBe(join(rollbackDir, "attempt.json"));
    expect(paths.receiptPath).toBe(join(rollbackDir, "receipt.json"));
  });

  it("20: the two helpers compose into the path a publication would produce", async () => {
    // Composition is the actual contract: a scanner enumerates the directory
    // from the first helper and reads artifacts with the second, and must land
    // exactly where `publishRollbackAttempt` wrote them.
    const tmp = await mkdtemp(join(tmpdir(), "viberevert-layout-"));
    try {
      const sessionId = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
      await mkdir(join(tmp, ".viberevert", "sessions", sessionId), { recursive: true });
      const published = await publishRollbackAttempt({
        repoRoot: tmp,
        sessionId,
        contributionSha256: "a".repeat(64),
        preRollbackCheckpointId: "cp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        selection: {
          selectors: { only: ["**"] },
          resolved_change_group_ids: [`cg_${"0".repeat(63)}1`],
        } satisfies RollbackSelection,
      });

      expect(published.rollbackDir).toBe(
        join(sessionRollbacksDir(tmp, sessionId), published.rollbackId),
      );
      const { attemptPath } = rollbackInvocationPaths(published.rollbackDir);
      await expect(readFile(attemptPath, "utf8")).resolves.toContain(published.rollbackId);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
