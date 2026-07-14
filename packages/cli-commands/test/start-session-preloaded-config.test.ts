// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4e-iv-a0: startSessionOperation's optional preloaded-config
// input. These exercise the REAL startSessionOperation with its heavy
// collaborators mocked (config load, active-lock pre-check, checkpoint, git
// status, core.startSession), so the config-SELECTION boundary is observed
// deterministically:
//   - omitted  loadedConfig -> loadConfig called exactly once (disk load),
//     and an internal load failure still propagates BEFORE any session-state
//     work (current behavior);
//   - explicit loadedConfig: undefined -> still the internal load path;
//   - supplied loadedConfig -> loadConfig called ZERO times;
//   - opts.loadedConfig is read exactly once; every config-derived value (the
//     rollback excludes) is the supplied array itself (forwarded, not cloned),
//     and its nested rollback/exclude getters are each read exactly once,
//     never re-read across the async locked flow.
// The D22 lock runs for real (it self-creates its lock dir); the two real
// mkdir calls run under a per-test mkdtemp root.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  ConfigNotFoundError,
  generateSessionId,
  loadActiveSessionLock,
  loadConfig,
  resolveRepoRoot,
  startSession,
} from "@viberevert/core";
import { createCheckpoint, getStatusPorcelainText } from "@viberevert/git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StartSessionOperationOpts } from "../src/operations/start-session.js";
import { startSessionOperation } from "../src/operations/start-session.js";
import { VIBEREVERT_TEST_FIXED_NOW } from "../src/runtime-env.js";

vi.mock("@viberevert/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@viberevert/core")>();
  return {
    ...actual,
    resolveRepoRoot: vi.fn(),
    loadConfig: vi.fn(),
    loadActiveSessionLock: vi.fn(),
    generateSessionId: vi.fn(),
    startSession: vi.fn(),
  };
});

vi.mock("@viberevert/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@viberevert/git")>();
  return {
    ...actual,
    createCheckpoint: vi.fn(),
    getStatusPorcelainText: vi.fn(),
  };
});

/** The rollback excludes passed to createCheckpoint on the most recent call. */
function capturedExcludes(): readonly string[] | undefined {
  const call = vi.mocked(createCheckpoint).mock.calls.at(-1)?.[0];
  return call?.rollbackExcludePatterns;
}

let tmpRoot = "";

beforeEach(async () => {
  vi.clearAllMocks();
  tmpRoot = await mkdtemp(join(tmpdir(), "vr-preloaded-config-"));
  vi.mocked(resolveRepoRoot).mockReturnValue(tmpRoot);
  vi.mocked(loadActiveSessionLock).mockResolvedValue(null);
  vi.mocked(generateSessionId).mockReturnValue("sess_test");
  vi.mocked(startSession).mockResolvedValue(undefined);
  vi.mocked(getStatusPorcelainText).mockResolvedValue("");
  vi.mocked(createCheckpoint).mockResolvedValue({ checkpointId: "cp_test" });
  // Deterministic timestamp (the operation resolves it once; value is not asserted).
  process.env[VIBEREVERT_TEST_FIXED_NOW] = "2026-07-14T00:00:00Z";
});

afterEach(async () => {
  delete process.env[VIBEREVERT_TEST_FIXED_NOW];
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

describe("startSessionOperation -- preloaded config (M G4 4e-iv-a0)", () => {
  it("omitted loadedConfig loads config from disk exactly once", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ rollback: { exclude: ["disk-only/**"] } } as Config);

    const result = await startSessionOperation({ cwd: tmpRoot });

    expect(vi.mocked(loadConfig)).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("sess_test");
    // The config-derived value came from the disk load.
    expect(capturedExcludes()).toEqual(["disk-only/**"]);
  });

  it("omitted loadedConfig: an internal load failure propagates before any session-state work", async () => {
    vi.mocked(loadConfig).mockRejectedValue(
      new ConfigNotFoundError(join(tmpRoot, ".viberevert.yml")),
    );

    await expect(startSessionOperation({ cwd: tmpRoot })).rejects.toBeInstanceOf(
      ConfigNotFoundError,
    );
    expect(vi.mocked(loadConfig)).toHaveBeenCalledTimes(1);
    // Config selection + validation occur BEFORE the D22 / session-state flow.
    expect(loadActiveSessionLock).not.toHaveBeenCalled();
    expect(createCheckpoint).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("explicit loadedConfig undefined uses the internal load path once", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ rollback: { exclude: ["disk/**"] } } as Config);

    // exactOptionalPropertyTypes forbids passing an explicit `loadedConfig: undefined`
    // at a typed call site, so this models a JS / dynamically-built caller that sets
    // the key to undefined; the runtime contract must treat it as "not supplied".
    const opts = {
      cwd: tmpRoot,
      loadedConfig: undefined,
    } as unknown as StartSessionOperationOpts;
    const result = await startSessionOperation(opts);

    expect(vi.mocked(loadConfig)).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("sess_test");
    expect(capturedExcludes()).toEqual(["disk/**"]);
  });

  it("supplied loadedConfig performs NO internal config load", async () => {
    // If loadConfig were called it would reject -> the operation would fail.
    vi.mocked(loadConfig).mockRejectedValue(new Error("loadConfig must not be called"));
    const supplied = { rollback: { exclude: ["supplied/**"] } } as Config;

    const result = await startSessionOperation({ cwd: tmpRoot, loadedConfig: supplied });

    expect(vi.mocked(loadConfig)).toHaveBeenCalledTimes(0);
    expect(result.sessionId).toBe("sess_test");
  });

  it("forwards the supplied object's rollback excludes by identity", async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error("loadConfig must not be called"));
    const excludes = ["supplied/**", "node_modules/**"];
    const supplied = { rollback: { exclude: excludes } } as Config;

    await startSessionOperation({ cwd: tmpRoot, loadedConfig: supplied });

    // The exact array is forwarded to createCheckpoint (not cloned/reconstructed).
    expect(capturedExcludes()).toBe(excludes);
  });

  it("reads opts.loadedConfig exactly once", async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error("loadConfig must not be called"));
    let loadedConfigReads = 0;
    const supplied = { rollback: { exclude: ["supplied/**"] } } as Config;
    const opts = {
      cwd: tmpRoot,
      get loadedConfig() {
        loadedConfigReads += 1;
        return supplied;
      },
    };

    const result = await startSessionOperation(opts);

    expect(loadedConfigReads).toBe(1);
    expect(vi.mocked(loadConfig)).not.toHaveBeenCalled();
    expect(result.sessionId).toBe("sess_test");
    // The captured excludes are the supplied array itself (forwarded, not cloned).
    expect(capturedExcludes()).toBe(supplied.rollback?.exclude);
  });

  it("nested rollback/exclude getters on the supplied object are each read exactly once", async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error("loadConfig must not be called"));
    let rollbackReads = 0;
    let excludeReads = 0;
    const supplied = {
      get rollback() {
        rollbackReads += 1;
        return {
          get exclude() {
            excludeReads += 1;
            return ["dist/**"];
          },
        };
      },
    } as unknown as Config;

    const result = await startSessionOperation({ cwd: tmpRoot, loadedConfig: supplied });

    expect(rollbackReads).toBe(1);
    expect(excludeReads).toBe(1);
    expect(result.sessionId).toBe("sess_test");
    // Value-equality only — reading supplied.rollback?.exclude here would re-trigger
    // the counting getters and defeat the read-once assertions above.
    expect(capturedExcludes()).toEqual(["dist/**"]);
  });
});
