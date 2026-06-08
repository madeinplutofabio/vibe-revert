// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import type { Stats } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Cli } from "clipanion";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HookInstallCommand } from "../src/commands/hook-install.js";
import {
  HookNotFoundError,
  HookNotViberevertManagedError,
  HookUninstallCommand,
  HookUninstallIoError,
  NoBackupsFoundError,
  RestoreTargetExistsError,
  UnsupportedGitHookLayoutError,
  UnsupportedGitHooksDirectoryError,
} from "../src/commands/hook-uninstall.js";
import { HOOK_SCRIPT_TEMPLATE, MANAGED_BY_MARKER } from "../src/hook-script.js";
import { VIBEREVERT_TEST_FIXED_NOW } from "../src/runtime-env.js";

// Mock node:fs/promises with delegating defaults so tests can override specific
// calls (lstat, readFile, readdir) for race / error-injection scenarios while
// keeping real fs behavior for setup helpers.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
  };
});

// =============================================================================
// Locked D98.O copy expectation helpers
// =============================================================================

function expectedRemoved(hookPath: string): string {
  return `Removed viberevert pre-commit hook at ${hookPath}.\n`;
}

function expectedRestored(backupPath: string, hookPath: string): string {
  return `Restored backup at ${backupPath} to ${hookPath} (most recent viberevert backup).\n`;
}

function expectedHookNotFound(hookPath: string): string {
  return (
    `No viberevert hook found at ${hookPath} (nothing to uninstall).\n` +
    `If ${hookPath} exists but is not viberevert-managed, leave it alone -- vibe-revert refuses to remove hooks it did not write.\n`
  );
}

function expectedHookNotViberevertManaged(hookPath: string): string {
  return (
    `Pre-commit hook at ${hookPath} is not viberevert-managed (missing expected managed-by marker on line 2, or path is not a regular file). Refusing to remove it.\n` +
    "If this is a stale viberevert hook from a future version, remove it manually.\n"
  );
}

function expectedNoBackupsFound(hooksDir: string): string {
  return `No backup files found matching \`pre-commit.viberevert-backup-*\` in ${hooksDir}. Nothing to restore.\n`;
}

function expectedRestoreTargetExists(hookPath: string): string {
  return `Cannot restore safely: pre-commit target at ${hookPath} is not the same viberevert-managed hook validated earlier, or already exists and is not viberevert-managed. Remove it manually before \`viberevert hook uninstall --restore\`.\n`;
}

function expectedUnsupportedGitHookLayout(
  repoRoot: string,
  signal: "not-found" | "regular-file" | "other",
): string {
  return (
    `Hook management requires a standard git repository layout (${path.join(
      repoRoot,
      ".git",
    )} must be a directory). Detected: ${signal}.\n` +
    "Git worktrees and submodules use indirected hook directories that vibe-revert does not yet support in v0.7.0-beta. See docs/hook-contract.md for the deferred-feature note.\n"
  );
}

function expectedUnsupportedGitHooksDirectory(
  hooksDir: string,
  signal: "regular-file" | "symbolic-link" | "other",
): string {
  return (
    `Hook management requires .git/hooks to be a real directory at ${hooksDir}. Detected: ${signal}.\n` +
    "Shared-hooks-directory setups (where .git/hooks is a symlink to another location) are not supported in v0.7.0-beta. Manage the hook at the symlink target manually, or wait for M G/M H support.\n"
  );
}

// =============================================================================
// Test harness
// =============================================================================

const originalCwd = process.cwd();
const originalFixedNow = process.env[VIBEREVERT_TEST_FIXED_NOW];
const isWindows = process.platform === "win32";

let tempDirs: string[] = [];

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fsPromises.lstat).mockReset().mockImplementation(actual.lstat);
  vi.mocked(fsPromises.readFile).mockReset().mockImplementation(actual.readFile);
  vi.mocked(fsPromises.readdir).mockReset().mockImplementation(actual.readdir);
  tempDirs = [];
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalFixedNow === undefined) {
    delete process.env[VIBEREVERT_TEST_FIXED_NOW];
  } else {
    process.env[VIBEREVERT_TEST_FIXED_NOW] = originalFixedNow;
  }
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fsPromises.lstat).mockReset().mockImplementation(actual.lstat);
  vi.mocked(fsPromises.readFile).mockReset().mockImplementation(actual.readFile);
  vi.mocked(fsPromises.readdir).mockReset().mockImplementation(actual.readdir);
  for (const dir of tempDirs) {
    await actual.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
});

async function makeTempRepoRoot(): Promise<string> {
  const repoRoot = path.join(
    os.tmpdir(),
    `viberevert-hook-uninstall-test-${crypto.randomBytes(8).toString("hex")}`,
  );
  await fsPromises.mkdir(repoRoot, { recursive: true });
  tempDirs.push(repoRoot);
  return repoRoot;
}

async function makeTempGitRepo(): Promise<string> {
  const repoRoot = await makeTempRepoRoot();
  // Use an empty template dir so the developer's global init.templateDir
  // (which may populate .git/hooks/pre-commit) does NOT contaminate the
  // "clean repo" baseline. NOTE: empty-template git init's behavior re:
  // .git/hooks/ creation varies across git versions / platforms -- tests
  // that need the dir present must call ensureHooksDir(), tests that need
  // it ABSENT must explicitly rm it.
  const templateDir = path.join(repoRoot, ".empty-git-template");
  await fsPromises.mkdir(templateDir, { recursive: true });
  const result = spawnSync("git", ["init", "--quiet", `--template=${templateDir}`], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error(`git init failed in ${repoRoot}`);
  }
  return repoRoot;
}

async function makeTempRepoNoGit(): Promise<string> {
  const repoRoot = await makeTempRepoRoot();
  await fsPromises.writeFile(path.join(repoRoot, ".viberevert.yml"), "# test fixture\n");
  return repoRoot;
}

async function ensureHooksDir(repoRoot: string): Promise<void> {
  await fsPromises.mkdir(path.join(repoRoot, ".git", "hooks"), { recursive: true });
}

async function writeManagedHook(repoRoot: string): Promise<void> {
  await ensureHooksDir(repoRoot);
  await fsPromises.writeFile(
    path.join(repoRoot, ".git", "hooks", "pre-commit"),
    HOOK_SCRIPT_TEMPLATE,
  );
}

async function writeNonVrHook(repoRoot: string, content: string): Promise<void> {
  await ensureHooksDir(repoRoot);
  await fsPromises.writeFile(path.join(repoRoot, ".git", "hooks", "pre-commit"), content);
}

async function writeManagedHookWithBody(repoRoot: string, body: string): Promise<void> {
  // Writes a hook with the marker on line 2 but custom body content. Used by
  // tests that need currentManaged=true with non-template body (covers the
  // drifted-but-marker-bearing branch of D98.A11).
  await ensureHooksDir(repoRoot);
  await fsPromises.writeFile(
    path.join(repoRoot, ".git", "hooks", "pre-commit"),
    `#!/bin/sh\n${MANAGED_BY_MARKER}\n${body}`,
  );
}

async function writeBackup(repoRoot: string, name: string, content: string): Promise<void> {
  await ensureHooksDir(repoRoot);
  await fsPromises.writeFile(path.join(repoRoot, ".git", "hooks", name), content);
}

async function hookExists(repoRoot: string): Promise<boolean> {
  try {
    await fsPromises.lstat(path.join(repoRoot, ".git", "hooks", "pre-commit"));
    return true;
  } catch {
    return false;
  }
}

async function readHookFile(repoRoot: string): Promise<Buffer> {
  return fsPromises.readFile(path.join(repoRoot, ".git", "hooks", "pre-commit"));
}

async function listBackups(repoRoot: string): Promise<string[]> {
  const hooksDir = path.join(repoRoot, ".git", "hooks");
  try {
    const entries = await fsPromises.readdir(hooksDir);
    return entries.filter((name) => /^pre-commit\.viberevert-backup-/.test(name)).sort();
  } catch {
    return [];
  }
}

// Fabricated Stats-shape object for mock-injection in race tests where we need
// the second lstat(hookPath) to return "file appeared" without actually
// creating a file (which would interfere with subsequent mutation steps).
function fakeRegularFileStat(overrides: Partial<Stats> = {}): Stats {
  return {
    dev: 1,
    ino: 1,
    size: 100,
    mode: 0o644,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 4096,
    blocks: 1,
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    birthtimeMs: 0,
    atime: new Date(0),
    mtime: new Date(0),
    ctime: new Date(0),
    birthtime: new Date(0),
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    ...overrides,
  } as unknown as Stats;
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runHookUninstall(repoRoot: string, args: string[] = []): Promise<CommandResult> {
  const prevCwd = process.cwd();
  process.chdir(repoRoot);
  try {
    const cli = new Cli({ binaryName: "viberevert" });
    cli.register(HookUninstallCommand);

    let stdoutContent = "";
    let stderrContent = "";

    // biome-ignore lint/suspicious/noExplicitAny: clipanion context shape acceptance
    const writableStdout: any = {
      write: (s: string | Uint8Array) => {
        stdoutContent += typeof s === "string" ? s : Buffer.from(s).toString();
        return true;
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: clipanion context shape acceptance
    const writableStderr: any = {
      write: (s: string | Uint8Array) => {
        stderrContent += typeof s === "string" ? s : Buffer.from(s).toString();
        return true;
      },
    };

    const exitCode = await cli.run(["hook", "uninstall", ...args], {
      stdout: writableStdout,
      stderr: writableStderr,
    });

    return { exitCode, stdout: stdoutContent, stderr: stderrContent };
  } finally {
    process.chdir(prevCwd);
  }
}

async function runHookInstall(repoRoot: string, args: string[] = []): Promise<CommandResult> {
  // Used only by the integration round-trip test below. Cross-command import
  // is fine in test code -- D98.M.12 governs source-to-source only.
  const prevCwd = process.cwd();
  process.chdir(repoRoot);
  try {
    const cli = new Cli({ binaryName: "viberevert" });
    cli.register(HookInstallCommand);

    let stdoutContent = "";
    let stderrContent = "";

    // biome-ignore lint/suspicious/noExplicitAny: clipanion context shape acceptance
    const writableStdout: any = {
      write: (s: string | Uint8Array) => {
        stdoutContent += typeof s === "string" ? s : Buffer.from(s).toString();
        return true;
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: clipanion context shape acceptance
    const writableStderr: any = {
      write: (s: string | Uint8Array) => {
        stderrContent += typeof s === "string" ? s : Buffer.from(s).toString();
        return true;
      },
    };

    const exitCode = await cli.run(["hook", "install", ...args], {
      stdout: writableStdout,
      stderr: writableStderr,
    });

    return { exitCode, stdout: stdoutContent, stderr: stderrContent };
  } finally {
    process.chdir(prevCwd);
  }
}

// =============================================================================
// A12: default uninstall removes managed hook
// =============================================================================

describe("viberevert hook uninstall -- default removal (A12)", () => {
  it("A12: managed hook present -> EXACT one-line 'Removed' stdout + hook absent after", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeManagedHook(repoRoot);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(expectedRemoved(hookPath));
    expect(await hookExists(repoRoot)).toBe(false);
  });

  it("A12: managed hook with drifted body (marker on line 2) -> still removed", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeManagedHookWithBody(repoRoot, "# stale custom body\nexit 0\n");
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(await hookExists(repoRoot)).toBe(false);
  });
});

// =============================================================================
// A13: hook absent / --restore allows absence / hooks-dir missing
// =============================================================================

describe("viberevert hook uninstall -- A13: absence semantics", () => {
  it("A13 default: hook absent (hooks dir exists) -> EXACT 2-line HookNotFoundError copy; exit 1", async () => {
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHookNotFound(hookPath));
  });

  it("A13 --restore: hook absent (hooks dir exists) + no backups -> NoBackupsFoundError (D98.P step 1 absence-allowed)", async () => {
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    const hooksDir = path.join(repoRoot, ".git", "hooks");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedNoBackupsFound(hooksDir));
  });

  it("A13 default: .git/hooks missing (D98.X step 3 ENOENT) -> HookNotFoundError", async () => {
    const repoRoot = await makeTempGitRepo();
    // Force .git/hooks absent regardless of git version/platform behavior --
    // empty-template git init may or may not create it depending on the
    // git build, so we explicitly rm to make this branch deterministic.
    await fsPromises.rm(path.join(repoRoot, ".git", "hooks"), {
      recursive: true,
      force: true,
    });
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHookNotFound(hookPath));
  });

  it("A13 --restore: .git/hooks missing (D98.X step 3 ENOENT) -> NoBackupsFoundError", async () => {
    const repoRoot = await makeTempGitRepo();
    // Force .git/hooks absent (same deterministic-baseline rationale).
    await fsPromises.rm(path.join(repoRoot, ".git", "hooks"), {
      recursive: true,
      force: true,
    });
    const hooksDir = path.join(repoRoot, ".git", "hooks");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedNoBackupsFound(hooksDir));
  });
});

// =============================================================================
// A14: marker missing
// =============================================================================

describe("viberevert hook uninstall -- A14: marker missing", () => {
  it("A14: file present without marker -> EXACT 2-line HookNotViberevertManagedError copy; file NOT removed", async () => {
    const repoRoot = await makeTempGitRepo();
    const content = "#!/bin/sh\necho user-managed\n";
    await writeNonVrHook(repoRoot, content);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHookNotViberevertManaged(hookPath));
    const after = (await readHookFile(repoRoot)).toString("utf8");
    expect(after).toBe(content);
  });
});

// =============================================================================
// A15: no git repo
// =============================================================================

describe("viberevert hook uninstall -- A15: no git repo", () => {
  it("A15: refuses with EXACT RepoRootNotFoundError copy reuse", async () => {
    const repoRoot = await makeTempRepoRoot();
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Could not find a VibeRevert repo root: walked up from ${repoRoot} without finding .git or .viberevert.yml\n`,
    );
  });
});

// =============================================================================
// A27: D98.V .git layout (default + --restore)
// =============================================================================

describe("viberevert hook uninstall -- A27: D98.V .git layout", () => {
  it("A27 default: .git missing -> EXACT UnsupportedGitHookLayoutError(not-found) copy", async () => {
    const repoRoot = await makeTempRepoNoGit();
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedUnsupportedGitHookLayout(repoRoot, "not-found"));
  });

  it("A27 default: .git is regular file (worktree pointer) -> EXACT signal=regular-file copy", async () => {
    const repoRoot = await makeTempRepoRoot();
    await fsPromises.writeFile(path.join(repoRoot, ".viberevert.yml"), "# test fixture\n");
    await fsPromises.writeFile(
      path.join(repoRoot, ".git"),
      "gitdir: /elsewhere/.git/worktrees/test\n",
    );
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedUnsupportedGitHookLayout(repoRoot, "regular-file"));
  });

  it("A27 --restore: .git missing -> EXACT UnsupportedGitHookLayoutError(not-found) copy", async () => {
    const repoRoot = await makeTempRepoNoGit();
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedUnsupportedGitHookLayout(repoRoot, "not-found"));
  });

  it("A27 --restore: .git is regular file -> EXACT signal=regular-file copy", async () => {
    const repoRoot = await makeTempRepoRoot();
    await fsPromises.writeFile(path.join(repoRoot, ".viberevert.yml"), "# test fixture\n");
    await fsPromises.writeFile(
      path.join(repoRoot, ".git"),
      "gitdir: /elsewhere/.git/worktrees/test\n",
    );
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedUnsupportedGitHookLayout(repoRoot, "regular-file"));
  });
});

// =============================================================================
// A38: D98.X .git/hooks layout (default + --restore)
// =============================================================================

describe("viberevert hook uninstall -- A38: D98.X .git/hooks layout", () => {
  it("A38 default: .git/hooks is regular file -> EXACT UnsupportedGitHooksDirectoryError(regular-file) copy", async () => {
    const repoRoot = await makeTempGitRepo();
    await fsPromises.rm(path.join(repoRoot, ".git", "hooks"), {
      recursive: true,
      force: true,
    });
    await fsPromises.writeFile(path.join(repoRoot, ".git", "hooks"), "not a directory");
    const hooksDir = path.join(repoRoot, ".git", "hooks");
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedUnsupportedGitHooksDirectory(hooksDir, "regular-file"));
  });

  it.skipIf(isWindows)(
    "A38 default: .git/hooks is symlink -> EXACT signal=symbolic-link copy",
    async () => {
      const repoRoot = await makeTempGitRepo();
      const elsewhere = path.join(repoRoot, "alt-hooks-dir");
      await fsPromises.mkdir(elsewhere, { recursive: true });
      await fsPromises.rm(path.join(repoRoot, ".git", "hooks"), {
        recursive: true,
        force: true,
      });
      await fsPromises.symlink(elsewhere, path.join(repoRoot, ".git", "hooks"));
      const hooksDir = path.join(repoRoot, ".git", "hooks");
      const result = await runHookUninstall(repoRoot);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(expectedUnsupportedGitHooksDirectory(hooksDir, "symbolic-link"));
    },
  );

  it("A38 --restore: .git/hooks is regular file -> EXACT copy", async () => {
    const repoRoot = await makeTempGitRepo();
    await fsPromises.rm(path.join(repoRoot, ".git", "hooks"), {
      recursive: true,
      force: true,
    });
    await fsPromises.writeFile(path.join(repoRoot, ".git", "hooks"), "not a directory");
    const hooksDir = path.join(repoRoot, ".git", "hooks");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedUnsupportedGitHooksDirectory(hooksDir, "regular-file"));
  });

  it.skipIf(isWindows)(
    "A38 --restore: .git/hooks is symlink -> EXACT signal=symbolic-link copy",
    async () => {
      const repoRoot = await makeTempGitRepo();
      const elsewhere = path.join(repoRoot, "alt-hooks-dir");
      await fsPromises.mkdir(elsewhere, { recursive: true });
      await fsPromises.rm(path.join(repoRoot, ".git", "hooks"), {
        recursive: true,
        force: true,
      });
      await fsPromises.symlink(elsewhere, path.join(repoRoot, ".git", "hooks"));
      const hooksDir = path.join(repoRoot, ".git", "hooks");
      const result = await runHookUninstall(repoRoot, ["--restore"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(expectedUnsupportedGitHooksDirectory(hooksDir, "symbolic-link"));
    },
  );
});

// =============================================================================
// A36 default: regular-file-only marker check
// =============================================================================

describe("viberevert hook uninstall -- A36: regular-file-only marker check (default)", () => {
  it("A36 default: pre-commit is directory -> HookNotViberevertManagedError (no readFile)", async () => {
    const repoRoot = await makeTempGitRepo();
    await fsPromises.mkdir(path.join(repoRoot, ".git", "hooks", "pre-commit"), { recursive: true });
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHookNotViberevertManaged(hookPath));
  });

  it.skipIf(isWindows)(
    "A36 default: pre-commit is symlink to marker-bearing target -> HookNotViberevertManagedError (no readFile -- target NOT followed)",
    async () => {
      const repoRoot = await makeTempGitRepo();
      const targetPath = path.join(repoRoot, "managed-elsewhere");
      const targetContent = `#!/bin/sh\n${MANAGED_BY_MARKER}\n# elsewhere\n`;
      await fsPromises.writeFile(targetPath, targetContent);
      await ensureHooksDir(repoRoot);
      const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
      await fsPromises.symlink(targetPath, hookPath);
      const result = await runHookUninstall(repoRoot);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(expectedHookNotViberevertManaged(hookPath));
      // Target untouched: proves no symlink follow happened during marker check
      const targetAfter = await fsPromises.readFile(targetPath, "utf8");
      expect(targetAfter).toBe(targetContent);
    },
  );
});

// =============================================================================
// A36 --restore: regular-file-only marker check
// =============================================================================

describe("viberevert hook uninstall -- A36: regular-file-only marker check (--restore)", () => {
  const backupName = "pre-commit.viberevert-backup-20260608T120000Z";
  const backupContent = "#!/bin/sh\necho original\n";

  it("A36 --restore: pre-commit is directory -> RestoreTargetExistsError (D98.P step 5.a)", async () => {
    const repoRoot = await makeTempGitRepo();
    await fsPromises.mkdir(path.join(repoRoot, ".git", "hooks", "pre-commit"), { recursive: true });
    await writeBackup(repoRoot, backupName, backupContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedRestoreTargetExists(hookPath));
  });

  it.skipIf(isWindows)(
    "A36 --restore: pre-commit is symlink to marker-bearing target -> RestoreTargetExistsError; target UNTOUCHED",
    async () => {
      const repoRoot = await makeTempGitRepo();
      const targetPath = path.join(repoRoot, "managed-elsewhere");
      const targetContent = `#!/bin/sh\n${MANAGED_BY_MARKER}\n# elsewhere\n`;
      await fsPromises.writeFile(targetPath, targetContent);
      await ensureHooksDir(repoRoot);
      const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
      await fsPromises.symlink(targetPath, hookPath);
      await writeBackup(repoRoot, backupName, backupContent);
      const result = await runHookUninstall(repoRoot, ["--restore"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(expectedRestoreTargetExists(hookPath));
      const targetAfter = await fsPromises.readFile(targetPath, "utf8");
      expect(targetAfter).toBe(targetContent);
    },
  );
});

// =============================================================================
// A40 default uninstall: marker line-2 exact-match (6 cases)
// =============================================================================

describe("viberevert hook uninstall -- A40 marker line-2 exact-match (default)", () => {
  it("A40 case 1: MARKER on line 2 LF, drifted body -> managed; removed", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeManagedHookWithBody(repoRoot, "# stale body\nexit 0\n");
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(await hookExists(repoRoot)).toBe(false);
  });

  it("A40 case 2: MARKER + '\\r' on line 2 (CRLF-drifted) -> managed; removed", async () => {
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    const crlfDrifted = `#!/bin/sh\n${MANAGED_BY_MARKER}\r\n# drifted body\n`;
    await fsPromises.writeFile(path.join(repoRoot, ".git", "hooks", "pre-commit"), crlfDrifted);
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(await hookExists(repoRoot)).toBe(false);
  });

  it("A40 case 3: MARKER on line 3 -> NOT managed; refuse", async () => {
    const repoRoot = await makeTempGitRepo();
    const wrongLine = `#!/bin/sh\n# random comment\n${MANAGED_BY_MARKER}\necho hi\n`;
    await writeNonVrHook(repoRoot, wrongLine);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHookNotViberevertManaged(hookPath));
  });

  it("A40 case 4: MARKER as substring inside comment on line 5 -> NOT managed; refuse", async () => {
    const repoRoot = await makeTempGitRepo();
    const inComment = `#!/bin/sh\n# random\necho ok\n# more\n# wrapper: ${MANAGED_BY_MARKER} embedded\n`;
    await writeNonVrHook(repoRoot, inComment);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHookNotViberevertManaged(hookPath));
  });

  it("A40 case 5: MARKER + ' extra trailing chars' on line 2 -> NOT managed; refuse", async () => {
    const repoRoot = await makeTempGitRepo();
    const withTrailer = `#!/bin/sh\n${MANAGED_BY_MARKER} extra trailing chars\n`;
    await writeNonVrHook(repoRoot, withTrailer);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHookNotViberevertManaged(hookPath));
  });

  it("A40 case 6: no marker anywhere -> NOT managed; refuse", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeNonVrHook(repoRoot, "#!/bin/sh\necho plain\n");
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHookNotViberevertManaged(hookPath));
  });
});

// =============================================================================
// A40 --restore: marker line-2 on current pre-commit (6 cases)
// =============================================================================

describe("viberevert hook uninstall --restore -- A40 current-hook validation (6 cases)", () => {
  const backupName = "pre-commit.viberevert-backup-20260608T120000Z";
  const backupContent = "#!/bin/sh\necho original\n";

  it("A40 case 1: current LF-managed-drifted + backup -> currentManaged=true; restore proceeds", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeManagedHookWithBody(repoRoot, "# stale\n");
    await writeBackup(repoRoot, backupName, backupContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const backupPath = path.join(repoRoot, ".git", "hooks", backupName);
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(expectedRestored(backupPath, hookPath));
    const restored = (await readHookFile(repoRoot)).toString("utf8");
    expect(restored).toBe(backupContent);
  });

  it("A40 case 2: current CRLF-drifted-managed + backup -> currentManaged=true; restore proceeds", async () => {
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    const crlfDrifted = `#!/bin/sh\n${MANAGED_BY_MARKER}\r\n# drifted body\n`;
    await fsPromises.writeFile(path.join(repoRoot, ".git", "hooks", "pre-commit"), crlfDrifted);
    await writeBackup(repoRoot, backupName, backupContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const backupPath = path.join(repoRoot, ".git", "hooks", backupName);
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(expectedRestored(backupPath, hookPath));
    const restored = (await readHookFile(repoRoot)).toString("utf8");
    expect(restored).toBe(backupContent);
  });

  it("A40 case 3: current MARKER on line 3 + backup -> NOT managed -> RestoreTargetExistsError", async () => {
    const repoRoot = await makeTempGitRepo();
    const wrongLine = `#!/bin/sh\n# random comment\n${MANAGED_BY_MARKER}\necho hi\n`;
    await writeNonVrHook(repoRoot, wrongLine);
    await writeBackup(repoRoot, backupName, backupContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedRestoreTargetExists(hookPath));
  });

  it("A40 case 4: current MARKER in line-5 comment + backup -> RestoreTargetExistsError", async () => {
    const repoRoot = await makeTempGitRepo();
    const inComment = `#!/bin/sh\n# random\necho ok\n# more\n# wrapper: ${MANAGED_BY_MARKER} embedded\n`;
    await writeNonVrHook(repoRoot, inComment);
    await writeBackup(repoRoot, backupName, backupContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedRestoreTargetExists(hookPath));
  });

  it("A40 case 5: current MARKER + trailing chars + backup -> RestoreTargetExistsError", async () => {
    const repoRoot = await makeTempGitRepo();
    const withTrailer = `#!/bin/sh\n${MANAGED_BY_MARKER} extra trailing chars\n`;
    await writeNonVrHook(repoRoot, withTrailer);
    await writeBackup(repoRoot, backupName, backupContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedRestoreTargetExists(hookPath));
  });

  it("A40 case 6: current no marker + backup -> RestoreTargetExistsError", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeNonVrHook(repoRoot, "#!/bin/sh\necho plain\n");
    await writeBackup(repoRoot, backupName, backupContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedRestoreTargetExists(hookPath));
  });
});

// =============================================================================
// A16: --restore happy path
// =============================================================================

describe("viberevert hook uninstall --restore -- A16: happy path", () => {
  const backupName = "pre-commit.viberevert-backup-20260608T120000Z";
  const backupContent = "#!/bin/sh\necho original\n";

  it("A16: current managed hook + single backup -> restored + EXACT stdout + backup gone", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeManagedHook(repoRoot);
    await writeBackup(repoRoot, backupName, backupContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const backupPath = path.join(repoRoot, ".git", "hooks", backupName);
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(expectedRestored(backupPath, hookPath));
    const restored = (await readHookFile(repoRoot)).toString("utf8");
    expect(restored).toBe(backupContent);
    expect(await listBackups(repoRoot)).toEqual([]);
  });

  it("A16: no current hook + single backup -> restored (D98.P step 1 absence-allowed path)", async () => {
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    await writeBackup(repoRoot, backupName, backupContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const backupPath = path.join(repoRoot, ".git", "hooks", backupName);
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(expectedRestored(backupPath, hookPath));
    const restored = (await readHookFile(repoRoot)).toString("utf8");
    expect(restored).toBe(backupContent);
  });

  it("A16: chmod 0o755 applied after restore when backup is regular file (Unix only)", async () => {
    if (isWindows) return;
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    await writeBackup(repoRoot, backupName, backupContent);
    // Distinctive non-executable mode before restore
    await fsPromises.chmod(path.join(repoRoot, ".git", "hooks", backupName), 0o644);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(0);
    const stat = await fsPromises.lstat(hookPath);
    expect(stat.mode & 0o111).not.toBe(0);
  });
});

// =============================================================================
// A17 + A39: --restore no backups / validate-before-mutate
// =============================================================================

describe("viberevert hook uninstall --restore -- A17, A39: no-backups + validate-before-mutate", () => {
  it("A17: empty hooks dir -> EXACT NoBackupsFoundError copy", async () => {
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    const hooksDir = path.join(repoRoot, ".git", "hooks");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedNoBackupsFound(hooksDir));
  });

  it("A39 CRITICAL: managed hook + zero backups -> NoBackupsFoundError; MANAGED HOOK UNTOUCHED", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeManagedHook(repoRoot);
    const hooksDir = path.join(repoRoot, ".git", "hooks");
    const beforeContent = await readHookFile(repoRoot);
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedNoBackupsFound(hooksDir));
    // Managed hook still present + byte-identical after refusal
    expect(await hookExists(repoRoot)).toBe(true);
    const afterContent = await readHookFile(repoRoot);
    expect(afterContent.equals(beforeContent)).toBe(true);
  });

  it("A39 follow-up: after the A39 refusal, plain uninstall still succeeds (proves managed hook valid)", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeManagedHook(repoRoot);
    const firstResult = await runHookUninstall(repoRoot, ["--restore"]);
    expect(firstResult.exitCode).toBe(1);
    const secondResult = await runHookUninstall(repoRoot);
    expect(secondResult.exitCode).toBe(0);
    expect(await hookExists(repoRoot)).toBe(false);
  });
});

// =============================================================================
// A18: --restore target validation (regular non-vr file case)
// =============================================================================

describe("viberevert hook uninstall --restore -- A18: target validation", () => {
  const backupName = "pre-commit.viberevert-backup-20260608T120000Z";

  it("A18: current pre-commit is regular non-vr file -> EXACT RestoreTargetExistsError; both files UNTOUCHED", async () => {
    const repoRoot = await makeTempGitRepo();
    const userContent = "#!/bin/sh\necho user-managed\n";
    await writeNonVrHook(repoRoot, userContent);
    await writeBackup(repoRoot, backupName, "#!/bin/sh\necho original\n");
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedRestoreTargetExists(hookPath));
    const after = (await readHookFile(repoRoot)).toString("utf8");
    expect(after).toBe(userContent);
    expect(await listBackups(repoRoot)).toEqual([backupName]);
  });
});

// =============================================================================
// A30: --restore backup filter + sort
// =============================================================================

describe("viberevert hook uninstall --restore -- A30: backup filter + sort", () => {
  it("A30: malformed entries alongside valid backup -> picks valid backup; malformed entries SILENTLY excluded", async () => {
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    const validName = "pre-commit.viberevert-backup-20260608T120000Z";
    const validContent = "#!/bin/sh\necho valid\n";
    await writeBackup(repoRoot, validName, validContent);
    await writeBackup(repoRoot, "pre-commit.viberevert-backup-z-danger", "x");
    await writeBackup(repoRoot, "pre-commit.viberevert-backup-20260608", "y");
    await writeBackup(repoRoot, "pre-commit.viberevert-backup-2026O608T120000Z", "z");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(0);
    const restored = (await readHookFile(repoRoot)).toString("utf8");
    expect(restored).toBe(validContent);
  });

  it("A30: multiple valid backups -> picks most recent (lexicographic descending = chronological descending)", async () => {
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    const olderName = "pre-commit.viberevert-backup-20260101T120000Z";
    const newerName = "pre-commit.viberevert-backup-20260608T120000Z";
    await writeBackup(repoRoot, olderName, "#!/bin/sh\necho older\n");
    await writeBackup(repoRoot, newerName, "#!/bin/sh\necho newer\n");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(0);
    const restored = (await readHookFile(repoRoot)).toString("utf8");
    expect(restored).toBe("#!/bin/sh\necho newer\n");
    expect(await listBackups(repoRoot)).toEqual([olderName]);
  });

  it("A30: only malformed entries -> EXACT NoBackupsFoundError (malformed NOT considered candidates)", async () => {
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    await writeBackup(repoRoot, "pre-commit.viberevert-backup-z-danger", "x");
    await writeBackup(repoRoot, "pre-commit.viberevert-backup-bogus", "y");
    const hooksDir = path.join(repoRoot, ".git", "hooks");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedNoBackupsFound(hooksDir));
  });
});

// =============================================================================
// A31: --restore missing hooks dir mid-flow (readdir ENOENT)
// =============================================================================

describe("viberevert hook uninstall --restore -- A31: readdir ENOENT mid-flow", () => {
  it("A31: readdir ENOENT on hooks dir -> NoBackupsFoundError (NOT HookUninstallIoError)", async () => {
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    const hooksDir = path.join(repoRoot, ".git", "hooks");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.readdir).mockImplementation(async (p, opts) => {
      if (p === hooksDir) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${hooksDir}'`), {
          code: "ENOENT",
        });
      }
      return actual.readdir(p, opts);
    });
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedNoBackupsFound(hooksDir));
  });

  it("A31 STRENGTHENED: readdir ENOENT mid-flow + managed hook present -> NoBackupsFoundError; MANAGED HOOK UNTOUCHED (locks D98.P validate-before-mutate under mid-flow listing failure)", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeManagedHook(repoRoot);
    const managedContent = await readHookFile(repoRoot);
    const hooksDir = path.join(repoRoot, ".git", "hooks");

    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.readdir).mockImplementation(async (p, opts) => {
      if (p === hooksDir) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${hooksDir}'`), {
          code: "ENOENT",
        });
      }
      return actual.readdir(p, opts);
    });

    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedNoBackupsFound(hooksDir));
    // CRITICAL: managed hook UNTOUCHED -- validate-before-mutate holds under
    // mid-flow listing failure (the rm in step 6 must not have fired).
    expect(await hookExists(repoRoot)).toBe(true);
    const afterContent = await readHookFile(repoRoot);
    expect(afterContent.equals(managedContent)).toBe(true);
  });
});

// =============================================================================
// A37: --restore symlink-safe / non-regular backup chmod skip
// =============================================================================

describe("viberevert hook uninstall --restore -- A37: symlink-safe non-regular backup chmod skip", () => {
  it.skipIf(isWindows)(
    "A37 Unix-only: backup is symlink -> restored pre-commit is STILL a symlink; chmod skipped; symlink target mode UNCHANGED",
    async () => {
      const repoRoot = await makeTempGitRepo();
      await ensureHooksDir(repoRoot);
      const targetPath = path.join(repoRoot, "external-target");
      await fsPromises.writeFile(targetPath, "#!/bin/sh\necho external\n");
      await fsPromises.chmod(targetPath, 0o600);
      const targetModeBefore = (await fsPromises.lstat(targetPath)).mode & 0o777;
      const backupName = "pre-commit.viberevert-backup-20260608T120000Z";
      await fsPromises.symlink(targetPath, path.join(repoRoot, ".git", "hooks", backupName));
      const result = await runHookUninstall(repoRoot, ["--restore"]);
      expect(result.exitCode).toBe(0);
      // Restored pre-commit is STILL a symlink -- rename preserved inode type
      // (proves we did NOT accidentally resolve / copy the symlink target).
      const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
      const hookStat = await fsPromises.lstat(hookPath);
      expect(hookStat.isSymbolicLink()).toBe(true);
      // Symlink target mode UNCHANGED -- proves chmod was skipped per D98.P step 9
      const targetModeAfter = (await fsPromises.lstat(targetPath)).mode & 0o777;
      expect(targetModeAfter).toBe(targetModeBefore);
    },
  );

  it("A37 cross-platform: backup is directory -> chmod skipped; restored directory present at pre-commit path", async () => {
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    const backupName = "pre-commit.viberevert-backup-20260608T120000Z";
    await fsPromises.mkdir(path.join(repoRoot, ".git", "hooks", backupName), { recursive: true });
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(0);
    const stat = await fsPromises.lstat(hookPath);
    expect(stat.isDirectory()).toBe(true);
  });
});

// =============================================================================
// Race tests: metadata-fingerprint guard (mock-injection)
// =============================================================================

describe("viberevert hook uninstall --restore -- race: metadata-fingerprint mismatch", () => {
  const backupName = "pre-commit.viberevert-backup-20260608T120000Z";
  const backupContent = "#!/bin/sh\necho original\n";

  it("race 1: managed first stat, mtimeMs changed on second stat -> RestoreTargetExistsError; hook + backup UNTOUCHED", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeManagedHook(repoRoot);
    await writeBackup(repoRoot, backupName, backupContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const managedContent = await readHookFile(repoRoot);

    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let hookPathStatCount = 0;
    vi.mocked(fsPromises.lstat).mockImplementation(async (p) => {
      if (p === hookPath) {
        hookPathStatCount++;
        const realStat = await actual.lstat(p);
        if (hookPathStatCount === 2) {
          // Race: simulate file mutated between first and second stat by
          // bumping mtimeMs. dev/ino/size/ctimeMs stay the same so we
          // specifically isolate the mtime-bump branch of the fingerprint
          // check. Object.create preserves the prototype chain so methods
          // like isFile() still work.
          const mutated: Stats = Object.create(realStat);
          (mutated as { mtimeMs: number }).mtimeMs = realStat.mtimeMs + 1000;
          return mutated;
        }
        return realStat;
      }
      return actual.lstat(p);
    });

    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedRestoreTargetExists(hookPath));
    // Both UNTOUCHED
    const hookAfter = await readHookFile(repoRoot);
    expect(hookAfter.equals(managedContent)).toBe(true);
    const backupAfter = await fsPromises.readFile(
      path.join(repoRoot, ".git", "hooks", backupName),
      "utf8",
    );
    expect(backupAfter).toBe(backupContent);
  });

  it("race 2: absent first stat, suddenly present on second stat -> RestoreTargetExistsError; backup UNTOUCHED", async () => {
    const repoRoot = await makeTempGitRepo();
    await ensureHooksDir(repoRoot);
    // No current pre-commit at first stat
    await writeBackup(repoRoot, backupName, backupContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");

    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let hookPathStatCount = 0;
    vi.mocked(fsPromises.lstat).mockImplementation(async (p) => {
      if (p === hookPath) {
        hookPathStatCount++;
        if (hookPathStatCount === 1) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        // Second call: race -- fabricated "file appeared" stat
        return fakeRegularFileStat();
      }
      return actual.lstat(p);
    });

    const result = await runHookUninstall(repoRoot, ["--restore"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedRestoreTargetExists(hookPath));
    // Backup UNTOUCHED
    const backupAfter = await fsPromises.readFile(
      path.join(repoRoot, ".git", "hooks", backupName),
      "utf8",
    );
    expect(backupAfter).toBe(backupContent);
  });
});

// =============================================================================
// HookUninstallIoError surfacing (handleKnownError wire copy)
// =============================================================================

describe("viberevert hook uninstall -- HookUninstallIoError surfacing", () => {
  it("readFile EACCES while marker-checking regular hook -> EXACT generic I/O refusal copy; hook UNTOUCHED", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeManagedHook(repoRoot);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");

    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.readFile).mockImplementation(async (p) => {
      if (p === hookPath) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      // biome-ignore lint/suspicious/noExplicitAny: forwarding overloaded readFile signature
      return actual.readFile(p as any);
    });

    const result = await runHookUninstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`Failed to read at ${hookPath}: EACCES: permission denied.\n`);
    expect(await hookExists(repoRoot)).toBe(true);
  });
});

// =============================================================================
// D98.S: no --force flag (behavior)
// =============================================================================

describe("viberevert hook uninstall -- D98.S: no --force flag (behavior)", () => {
  it("D98.S: --force is rejected by Clipanion and does NOT remove a managed hook", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeManagedHook(repoRoot);
    const before = await readHookFile(repoRoot);
    const result = await runHookUninstall(repoRoot, ["--force"]);
    // The safety invariant is "no mutation" -- exact Clipanion exit code /
    // error copy is intentionally NOT asserted (Clipanion's unknown-option
    // handling is its concern). What matters: managed hook still byte-
    // identical, exit code is non-zero.
    expect(result.exitCode).not.toBe(0);
    expect(await hookExists(repoRoot)).toBe(true);
    const after = await readHookFile(repoRoot);
    expect(after.equals(before)).toBe(true);
  });
});

// =============================================================================
// Integration round-trip: install --force then uninstall --restore
// =============================================================================

describe("install --force + uninstall --restore -- integration round-trip", () => {
  it("install --force then uninstall --restore -> original non-vr content restored EXACTLY (locks BACKUP_FILE_REGEX + timestamp format + restore semantics + interop copy)", async () => {
    process.env[VIBEREVERT_TEST_FIXED_NOW] = "2026-06-08T15:49:25.000Z";
    const repoRoot = await makeTempGitRepo();
    const originalContent = "#!/bin/sh\necho user-original\n";
    await writeNonVrHook(repoRoot, originalContent);

    // 1. install --force: backs up user file, writes viberevert hook
    const installResult = await runHookInstall(repoRoot, ["--force"]);
    expect(installResult.exitCode).toBe(0);

    // 2. backup + viberevert hook both present
    const expectedBackupName = "pre-commit.viberevert-backup-20260608T154925Z";
    expect(await listBackups(repoRoot)).toEqual([expectedBackupName]);
    const hookAfterInstall = (await readHookFile(repoRoot)).toString("utf8");
    expect(hookAfterInstall).toBe(HOOK_SCRIPT_TEMPLATE);

    // 3. uninstall --restore: renames backup back over the managed hook
    const restoreResult = await runHookUninstall(repoRoot, ["--restore"]);
    expect(restoreResult.exitCode).toBe(0);

    // 3a. EXACT restore stdout + empty stderr (locks interop copy + path
    // calculation between install and uninstall)
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const backupPath = path.join(repoRoot, ".git", "hooks", expectedBackupName);
    expect(restoreResult.stdout).toBe(expectedRestored(backupPath, hookPath));
    expect(restoreResult.stderr).toBe("");

    // 4. original content restored EXACTLY
    const restoredContent = (await readHookFile(repoRoot)).toString("utf8");
    expect(restoredContent).toBe(originalContent);

    // 5. backup is gone (it WAS the rename source)
    expect(await listBackups(repoRoot)).toEqual([]);
  });
});

// =============================================================================
// D98.M source invariants for hook-uninstall.ts (preview of Step 5)
// =============================================================================

describe("hook-uninstall.ts source invariants (preview of D98.M Step 5)", () => {
  const sourcePath = fileURLToPath(new URL("../src/commands/hook-uninstall.ts", import.meta.url));
  let source: string;

  beforeAll(async () => {
    source = await fsPromises.readFile(sourcePath, "utf8");
  });

  it("D98.M.12: does NOT import from commands/hook-install.ts (cross-command import lock)", () => {
    expect(source).not.toMatch(/from\s+["']\.\/hook-install/);
    expect(source).not.toMatch(/from\s+["']\.\.\/commands\/hook-install/);
  });

  it("D98.M.7: naive grep counts match locked surface (9 fs source call sites across 8 op patterns)", () => {
    const countMatches = (re: RegExp): number => (source.match(re) || []).length;
    const counts = {
      gitStat: countMatches(/lstat\(join\(repoRoot, "\.git"\)/g),
      hooksDirStat: countMatches(/lstat\(hooksDir/g),
      hookPathStat: countMatches(/lstat\(hookPath/g),
      hookPathRead: countMatches(/readFile\(hookPath/g),
      hooksDirReaddir: countMatches(/readdir\(hooksDir/g),
      hookPathRm: countMatches(/rm\(hookPath/g),
      backupRename: countMatches(/rename\(backupPath, hookPath/g),
      hookPathChmod: countMatches(/chmod\(hookPath/g),
    };
    expect(counts).toEqual({
      gitStat: 1,
      hooksDirStat: 1,
      hookPathStat: 2,
      hookPathRead: 1,
      hooksDirReaddir: 1,
      hookPathRm: 1,
      backupRename: 1,
      hookPathChmod: 1,
    });
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(9);
  });

  it("D98.M.7: `withFileTypes: true` token present EXACTLY once", () => {
    // Exactly-once (stronger than at-least-once): catches a future second
    // readdir call that would also violate D98.M.7's readdir x1 lock.
    const matches = source.match(/withFileTypes:\s*true/g) || [];
    expect(matches.length).toBe(1);
  });

  it("D98.M.7 negatives: NO mkdir / writeFile / writeFileAtomic / unlink / copyFile / stat( calls", () => {
    expect(source).not.toMatch(/\bmkdir\(/);
    expect(source).not.toMatch(/\bwriteFile\(/);
    expect(source).not.toMatch(/\bwriteFileAtomic\(/);
    expect(source).not.toMatch(/\bunlink\(/);
    expect(source).not.toMatch(/\bcopyFile\(/);
    // `stat(` standalone -- word boundary excludes `lstat(` since `l` and `s`
    // are both word chars (no boundary between them).
    expect(source).not.toMatch(/\bstat\(/);
  });

  it("D98.M.13: ASCII-only at byte level", () => {
    for (let i = 0; i < source.length; i++) {
      expect(source.charCodeAt(i)).toBeLessThan(128);
    }
  });

  it("D98.M.1/M.2/M.3: NO child_process, @viberevert/checks, or known LLM SDK imports", () => {
    expect(source).not.toMatch(/from\s+["']child_process["']/);
    expect(source).not.toMatch(/from\s+["']node:child_process["']/);
    expect(source).not.toMatch(/from\s+["']@viberevert\/checks["']/);
    expect(source).not.toMatch(/from\s+["']@anthropic-ai\/sdk["']/);
    expect(source).not.toMatch(/from\s+["']openai["']/);
  });

  it("D98.M.8: EXACTLY ONE import statement containing MANAGED_BY_MARKER; HOOK_SCRIPT_TEMPLATE NOT imported", () => {
    const markerImportLines = (source.match(/import\s*\{[^}]*\bMANAGED_BY_MARKER\b[^}]*\}/g) || [])
      .length;
    expect(markerImportLines).toBe(1);
    expect(source).not.toMatch(/import\s*\{[^}]*\bHOOK_SCRIPT_TEMPLATE\b/);
  });

  it("D98.R: exactly 7 exported error classes + HookUninstallCommand separately", () => {
    // Count only "export class <Name>Error extends Error" -- excludes the
    // HookUninstallCommand export (which extends Command, not Error). This
    // avoids the false-positive of counting HookUninstallCommand as an
    // 8th "error class".
    const exportedErrorClasses = (source.match(/^export class \w+Error extends Error/gm) || [])
      .length;
    expect(exportedErrorClasses).toBe(7);
    expect(source).toMatch(/^export class HookUninstallCommand extends Command/gm);
  });

  it("D98.S: NO --force Option is defined for uninstall (any Option.* helper)", () => {
    // Single regex covers Boolean, String, Array, Counter, and any future
    // Option.* helper. Comments intentionally mention "no --force" for
    // documentation -- this regex specifically targets the Clipanion
    // Option-binding shape, not raw `--force` text.
    expect(source).not.toMatch(/Option\.[A-Za-z]+\(\s*["']--force["']/);
  });

  it("D98.M.9/M.10: index.ts registers HookUninstallCommand exactly once after HookInstallCommand", async () => {
    const indexSourcePath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const indexSource = await fsPromises.readFile(indexSourcePath, "utf8");
    // Exactly ONE import statement containing the HookUninstallCommand identifier
    const importCount = (
      indexSource.match(/import\s*\{[^}]*\bHookUninstallCommand\b[^}]*\}/g) || []
    ).length;
    // Exactly ONE cli.register call
    const registerCount = (indexSource.match(/cli\.register\(HookUninstallCommand\)/g) || [])
      .length;
    expect(importCount).toBe(1);
    expect(registerCount).toBe(1);
    // Registration ORDER: HookUninstallCommand AFTER HookInstallCommand (D98.M.10)
    const installIdx = indexSource.indexOf("cli.register(HookInstallCommand);");
    const uninstallIdx = indexSource.indexOf("cli.register(HookUninstallCommand);");
    expect(installIdx).toBeGreaterThan(-1);
    expect(uninstallIdx).toBeGreaterThan(installIdx);
  });
});

// =============================================================================
// Error-class shapes (exported per D98.R)
// =============================================================================

describe("hook-uninstall error classes (exported per D98.R)", () => {
  it("UnsupportedGitHookLayoutError exposes repoRoot + signal", () => {
    const err = new UnsupportedGitHookLayoutError("/repo", "not-found");
    expect(err.name).toBe("UnsupportedGitHookLayoutError");
    expect(err.repoRoot).toBe("/repo");
    expect(err.signal).toBe("not-found");
  });

  it("UnsupportedGitHooksDirectoryError exposes hooksDir + signal", () => {
    const err = new UnsupportedGitHooksDirectoryError("/repo/.git/hooks", "symbolic-link");
    expect(err.name).toBe("UnsupportedGitHooksDirectoryError");
    expect(err.hooksDir).toBe("/repo/.git/hooks");
    expect(err.signal).toBe("symbolic-link");
  });

  it("HookNotFoundError exposes hookPath", () => {
    const err = new HookNotFoundError("/h/pre-commit");
    expect(err.name).toBe("HookNotFoundError");
    expect(err.hookPath).toBe("/h/pre-commit");
  });

  it("HookNotViberevertManagedError exposes hookPath + message wording covers both branches", () => {
    const err = new HookNotViberevertManagedError("/h/pre-commit");
    expect(err.name).toBe("HookNotViberevertManagedError");
    expect(err.hookPath).toBe("/h/pre-commit");
    expect(err.message).toContain("missing expected managed-by marker on line 2");
    expect(err.message).toContain("or path is not a regular file");
  });

  it("NoBackupsFoundError exposes hooksDir", () => {
    const err = new NoBackupsFoundError("/repo/.git/hooks");
    expect(err.name).toBe("NoBackupsFoundError");
    expect(err.hooksDir).toBe("/repo/.git/hooks");
  });

  it("RestoreTargetExistsError exposes hookPath + message wording covers race + pre-condition", () => {
    const err = new RestoreTargetExistsError("/h/pre-commit");
    expect(err.name).toBe("RestoreTargetExistsError");
    expect(err.hookPath).toBe("/h/pre-commit");
    expect(err.message).toContain("not the same viberevert-managed hook validated earlier");
    expect(err.message).toContain("or already exists and is not viberevert-managed");
  });

  it("HookUninstallIoError exposes op + path + underlyingMessage", () => {
    const err = new HookUninstallIoError("rm", "/h/pre-commit", "EBUSY");
    expect(err.name).toBe("HookUninstallIoError");
    expect(err.op).toBe("rm");
    expect(err.path).toBe("/h/pre-commit");
    expect(err.underlyingMessage).toBe("EBUSY");
    expect(err.message).toBe("Failed to rm at /h/pre-commit: EBUSY.");
  });
});

// =============================================================================
// Re-imports sanity
// =============================================================================

describe("hook-uninstall exports", () => {
  it("all 7 uninstall error classes + HookUninstallCommand are exported", () => {
    expect(HookUninstallCommand).toBeDefined();
    expect(UnsupportedGitHookLayoutError).toBeDefined();
    expect(UnsupportedGitHooksDirectoryError).toBeDefined();
    expect(HookNotFoundError).toBeDefined();
    expect(HookNotViberevertManagedError).toBeDefined();
    expect(NoBackupsFoundError).toBeDefined();
    expect(RestoreTargetExistsError).toBeDefined();
    expect(HookUninstallIoError).toBeDefined();
  });
});
