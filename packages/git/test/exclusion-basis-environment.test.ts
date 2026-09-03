// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Environment-authority tests for exclusion-basis.ts.
//
// These cannot run in-process. The runner snapshots the environment git
// subprocesses receive at module initialization, so a test that has already
// imported it cannot change what it froze. Relying on Vitest's per-file module
// isolation would make the result depend on collection order, which is not a
// property worth betting a safety check on.
//
// So each case SPAWNS a fresh process through exclusion-basis-env-fixture.ts
// with the environment set at spawn time, and asserts its PRECONDITIONS from
// the fixture's report before asserting the fingerprint: that the live
// environment really was mutated after import, and that the frozen environment
// really holds the spawn values. A case can then never pass on a premise that
// was never established.
//
// GIT IS THE ORACLE. Every resolution branch runs `git ls-files --others
// --exclude-standard` in the SAME environment object used to spawn the fixture,
// against a marker file that the branch's ignore file names. Asserting only
// that two fingerprints differ would test the resolver against itself; asserting
// which marker git actually excluded pins the branch to git's behavior, so a
// future git that resolves homes differently fails here rather than silently
// diverging.
//
// Global and system git configuration are redirected to nonexistent files in
// every spawn, so `core.excludesFile` is genuinely unset unless a case sets it
// in repo-local config. Unlike the main suite, setup does NOT pin an empty local
// `core.excludesFile`: these cases exist precisely to exercise default
// resolution.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import type { ExclusionBasisFingerprint } from "../src/exclusion-basis.js";

const execFileAsync = promisify(execFile);

const FIXTURE = fileURLToPath(new URL("./exclusion-basis-env-fixture.ts", import.meta.url));

/** Each case spawns at least one process; `tsx` startup dominates. */
const SPAWN_TIMEOUT_MS = 30_000;

/**
 * Named constants rather than literal keys: Biome's `useLiteralKeys` would
 * rewrite `env["X"]` to `env.X`, which tsc rejects under
 * `noPropertyAccessFromIndexSignature`.
 */
const GIT_CONFIG_GLOBAL = "GIT_CONFIG_GLOBAL";
const GIT_CONFIG_SYSTEM = "GIT_CONFIG_SYSTEM";

interface FrozenEnvironment {
  readonly xdgConfigHome: string | null;
  readonly home: string | null;
  readonly homeDrive: string | null;
  readonly homePath: string | null;
  readonly userProfile: string | null;
}

interface FixtureResult {
  readonly liveEnvironmentMutated: boolean;
  readonly frozenEnvironment: FrozenEnvironment;
  readonly basis: ExclusionBasisFingerprint;
}

interface TestRepo {
  readonly repoRoot: string;
  readonly tmp: string;
  cleanup: () => Promise<void>;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-exclenv-"));
  const repoRoot = join(tmp, "repo");
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  return {
    repoRoot,
    tmp,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/** Write `<directory>/ignore` holding one rule, creating parents. */
async function writeIgnoreFile(directory: string, rule: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "ignore"), rule);
}

/** Create an untracked marker file at the repository root. */
async function writeMarker(repo: TestRepo, name: string): Promise<void> {
  await writeFile(join(repo.repoRoot, name), "marker\n");
}

/**
 * The single environment both the fixture spawn and the direct git oracle use.
 * Sharing one object is what makes the two observations comparable.
 */
function environmentFor(
  repo: TestRepo,
  overrides: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env[GIT_CONFIG_GLOBAL] = join(repo.tmp, "no-global-config");
  env[GIT_CONFIG_SYSTEM] = join(repo.tmp, "no-system-config");
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}

async function runFixture(repo: TestRepo, env: NodeJS.ProcessEnv): Promise<FixtureResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", FIXTURE, repo.repoRoot],
    { env, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(String(stdout)) as FixtureResult;
}

/** What git itself considers untracked-and-not-excluded, in `env`. */
async function gitOthers(repo: TestRepo, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: repo.repoRoot,
    env,
    windowsHide: true,
  });
  return String(stdout);
}

/** Assert the fixture's own preconditions before trusting its fingerprint. */
function expectFrozenSpawnEnvironment(result: FixtureResult): void {
  expect(result.liveEnvironmentMutated).toBe(true);
  expect(result.frozenEnvironment.xdgConfigHome).not.toBe("MUTATED_AFTER_IMPORT");
  expect(result.frozenEnvironment.home).not.toBe("MUTATED_AFTER_IMPORT");
  expect(result.frozenEnvironment.userProfile).not.toBe("MUTATED_AFTER_IMPORT");
}

/**
 * "No home variables", expressed the only way Windows permits.
 *
 * MEASURED: libuv reinstates `HOMEDRIVE`, `HOMEPATH` and `USERPROFILE` from the
 * parent process whenever a supplied environment block omits them, so deleting
 * those three is silently undone and the case would test the developer's real
 * home instead. Empty values pass through untouched, and both git and
 * `nonEmptyGitEnvironmentVariable` treat an empty value as no value. `HOME` and
 * `XDG_CONFIG_HOME` are not on libuv's list, so deletion works for them.
 */
const NO_HOME_VARS = {
  XDG_CONFIG_HOME: undefined,
  HOME: undefined,
  HOMEDRIVE: "",
  HOMEPATH: "",
  USERPROFILE: "",
} as const;

/** Absent, whichever way this platform allowed the case to express it. */
function expectAbsent(value: string | null): void {
  expect(value ?? "").toBe("");
}

// =============================================================================
// XDG_CONFIG_HOME
// =============================================================================

describe("exclusion basis default resolution via XDG_CONFIG_HOME", () => {
  it(
    "uses the environment frozen at spawn, not live process.env mutated after import",
    async () => {
      const repo = await setupRepo();
      try {
        const xdg = join(repo.tmp, "xdg");
        await writeIgnoreFile(join(xdg, "git"), "xdg-abs.txt\n");
        await writeMarker(repo, "xdg-abs.txt");
        const env = environmentFor(repo, { ...NO_HOME_VARS, XDG_CONFIG_HOME: xdg });

        const result = await runFixture(repo, env);
        const others = await gitOthers(repo, env);

        // Both halves: the live environment moved, and the frozen one did not.
        expectFrozenSpawnEnvironment(result);
        expect(result.frozenEnvironment.xdgConfigHome).toBe(xdg);
        // Git applied the rule from that file, and the fingerprint names it.
        expect(others).not.toContain("xdg-abs.txt");
        expect(result.basis.globalExcludes?.source).toBe("default");
        expect(result.basis.globalExcludes?.path).toBe(resolve(xdg, "git", "ignore"));
      } finally {
        await repo.cleanup();
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "anchors a relative XDG_CONFIG_HOME at the repository root",
    async () => {
      const repo = await setupRepo();
      try {
        await writeIgnoreFile(join(repo.repoRoot, "xdgrel", "git"), "xdg-rel.txt\n");
        await writeMarker(repo, "xdg-rel.txt");
        const env = environmentFor(repo, { ...NO_HOME_VARS, XDG_CONFIG_HOME: "xdgrel" });

        const result = await runFixture(repo, env);
        const others = await gitOthers(repo, env);

        // Git honors a relative value against its own cwd, which the runner
        // pins to the repository root. Discarding relative values, as the XDG
        // specification suggests, would skip a source git is actively using.
        expectFrozenSpawnEnvironment(result);
        expect(result.frozenEnvironment.xdgConfigHome).toBe("xdgrel");
        expect(others).not.toContain("xdg-rel.txt");
        expect(result.basis.globalExcludes?.path).toBe(
          resolve(repo.repoRoot, "xdgrel", "git", "ignore"),
        );
      } finally {
        await repo.cleanup();
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

// =============================================================================
// Home precedence
// =============================================================================

describe("exclusion basis default resolution via home variables", () => {
  it(
    "prefers a relative HOME over USERPROFILE, anchored at the repository root",
    async () => {
      const repo = await setupRepo();
      try {
        await writeIgnoreFile(join(repo.repoRoot, "homeA", ".config", "git"), "home-a.txt\n");
        const profile = join(repo.tmp, "homeB");
        await writeIgnoreFile(join(profile, ".config", "git"), "profile-b.txt\n");
        await writeMarker(repo, "home-a.txt");
        await writeMarker(repo, "profile-b.txt");
        const env = environmentFor(repo, {
          ...NO_HOME_VARS,
          HOME: "homeA",
          USERPROFILE: profile,
        });

        const result = await runFixture(repo, env);
        const others = await gitOthers(repo, env);

        expectFrozenSpawnEnvironment(result);
        expect(result.frozenEnvironment.home).toBe("homeA");
        expect(result.frozenEnvironment.userProfile).toBe(profile);
        // Git's own verdict decides precedence: the HOME rule applied, the
        // USERPROFILE rule did not. A relative home resolves from the repo root.
        expect(others).not.toContain("home-a.txt");
        expect(others).toContain("profile-b.txt");
        expect(result.basis.globalExcludes?.path).toBe(
          resolve(repo.repoRoot, "homeA", ".config", "git", "ignore"),
        );
      } finally {
        await repo.cleanup();
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports no global excludes when no home variable applies",
    async () => {
      const repo = await setupRepo();
      try {
        await writeMarker(repo, "no-home.txt");
        const env = environmentFor(repo, NO_HOME_VARS);

        const result = await runFixture(repo, env);
        const others = await gitOthers(repo, env);

        // With every variable absent git derived no home and applied no default
        // excludes file, so `null` is accurate rather than a shortfall.
        //
        // If this fails on a POSIX host, it is a real finding rather than a
        // flaky fixture: it would mean git derived a home by another route
        // (a passwd-database lookup, say) and the resolver must account for it.
        expectFrozenSpawnEnvironment(result);
        expectAbsent(result.frozenEnvironment.home);
        expectAbsent(result.frozenEnvironment.userProfile);
        expect(others).toContain("no-home.txt");
        expect(result.basis.globalExcludes).toBeNull();
      } finally {
        await repo.cleanup();
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

// =============================================================================
// Windows-only fallbacks
// =============================================================================

describe.skipIf(process.platform !== "win32")("Windows home fallbacks", () => {
  it(
    "prefers HOMEDRIVE plus HOMEPATH over USERPROFILE when HOME is unset",
    async () => {
      const repo = await setupRepo();
      try {
        const driveHome = join(repo.tmp, "homeC");
        const profile = join(repo.tmp, "homeB");
        await writeIgnoreFile(join(driveHome, ".config", "git"), "drive-c.txt\n");
        await writeIgnoreFile(join(profile, ".config", "git"), "profile-b.txt\n");
        await writeMarker(repo, "drive-c.txt");
        await writeMarker(repo, "profile-b.txt");
        const env = environmentFor(repo, {
          ...NO_HOME_VARS,
          HOMEDRIVE: driveHome.slice(0, 2),
          HOMEPATH: driveHome.slice(2),
          USERPROFILE: profile,
        });

        const result = await runFixture(repo, env);
        const others = await gitOthers(repo, env);

        expectFrozenSpawnEnvironment(result);
        expectAbsent(result.frozenEnvironment.home);
        expect(result.frozenEnvironment.homeDrive).toBe(driveHome.slice(0, 2));
        expect(others).not.toContain("drive-c.txt");
        expect(others).toContain("profile-b.txt");
        expect(result.basis.globalExcludes?.path).toBe(
          resolve(driveHome, ".config", "git", "ignore"),
        );
      } finally {
        await repo.cleanup();
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "falls back to a relative USERPROFILE last, anchored at the repository root",
    async () => {
      const repo = await setupRepo();
      try {
        await writeIgnoreFile(join(repo.repoRoot, "homeB", ".config", "git"), "profile-b.txt\n");
        await writeMarker(repo, "profile-b.txt");
        const env = environmentFor(repo, { ...NO_HOME_VARS, USERPROFILE: "homeB" });

        const result = await runFixture(repo, env);
        const others = await gitOthers(repo, env);

        expectFrozenSpawnEnvironment(result);
        expectAbsent(result.frozenEnvironment.home);
        expectAbsent(result.frozenEnvironment.homeDrive);
        expect(result.frozenEnvironment.userProfile).toBe("homeB");
        expect(others).not.toContain("profile-b.txt");
        expect(result.basis.globalExcludes?.path).toBe(
          resolve(repo.repoRoot, "homeB", ".config", "git", "ignore"),
        );
      } finally {
        await repo.cleanup();
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe.skipIf(process.platform === "win32")("non-Windows ignores Windows home variables", () => {
  it(
    "does not derive a home from HOMEDRIVE, HOMEPATH or USERPROFILE",
    async () => {
      const repo = await setupRepo();
      try {
        const profile = join(repo.tmp, "homeB");
        await writeIgnoreFile(join(profile, ".config", "git"), "profile-b.txt\n");
        await writeMarker(repo, "profile-b.txt");
        const env = environmentFor(repo, {
          ...NO_HOME_VARS,
          HOMEDRIVE: "/nowhere",
          HOMEPATH: "/either",
          USERPROFILE: profile,
        });

        const result = await runFixture(repo, env);
        const others = await gitOthers(repo, env);

        // These are Git-for-Windows fallbacks. Git ignores them here, so the
        // marker stays listed, and consulting them in the resolver would name a
        // home git would never derive on this platform.
        expectFrozenSpawnEnvironment(result);
        expect(result.frozenEnvironment.userProfile).toBe(profile);
        expect(others).toContain("profile-b.txt");
        expect(result.basis.globalExcludes).toBeNull();
      } finally {
        await repo.cleanup();
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

// =============================================================================
// Unset versus explicitly empty core.excludesFile, against git's real default
// =============================================================================

describe("core.excludesFile unset versus explicitly empty", () => {
  it(
    "falls back to the default when unset, and to no source when explicitly empty",
    async () => {
      const repo = await setupRepo();
      try {
        const home = join(repo.tmp, "homeA");
        await writeIgnoreFile(join(home, ".config", "git"), "excludes-unset.txt\n");
        await writeMarker(repo, "excludes-unset.txt");
        const env = environmentFor(repo, { ...NO_HOME_VARS, HOME: home });

        const unset = await runFixture(repo, env);
        const othersWhenUnset = await gitOthers(repo, env);

        await git(repo.repoRoot, ["config", "core.excludesFile", ""]);
        const emptied = await runFixture(repo, env);
        const othersWhenEmptied = await gitOthers(repo, env);

        // Git's behavior, not just our two fingerprints: unset APPLIES the
        // default excludes file, an explicitly empty value DISABLES it. The
        // marker's visibility flips, and the fingerprint follows.
        expectFrozenSpawnEnvironment(unset);
        expect(othersWhenUnset).not.toContain("excludes-unset.txt");
        expect(unset.basis.globalExcludes?.source).toBe("default");
        expect(unset.basis.globalExcludes?.path).toBe(resolve(home, ".config", "git", "ignore"));

        expect(othersWhenEmptied).toContain("excludes-unset.txt");
        expect(emptied.basis.globalExcludes).toBeNull();
      } finally {
        await repo.cleanup();
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
