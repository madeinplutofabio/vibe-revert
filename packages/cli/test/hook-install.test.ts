// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Cli } from "clipanion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BackupCollisionError,
  ExistingNonViberevertHookError,
  HookInstallCommand,
  HookInstallIoError,
  HookManagersDetectedError,
  HuskyDetectedError,
  LefthookDetectedError,
  UnsupportedGitHookLayoutError,
  UnsupportedGitHooksDirectoryError,
} from "../src/commands/hook-install.js";
import { HookManagerIoError, MalformedPackageJsonError } from "../src/hook-managers.js";
import { HOOK_SCRIPT_TEMPLATE, MANAGED_BY_MARKER } from "../src/hook-script.js";
import { VIBEREVERT_TEST_FIXED_NOW } from "../src/runtime-env.js";

// Mock node:fs/promises with delegating defaults so tests can override
// specific calls (lstat, readFile) for error-injection scenarios while
// keeping real fs behavior for setup helpers.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    readFile: vi.fn(actual.readFile),
  };
});

// =============================================================================
// Locked D98.O copy expectation helpers
// =============================================================================

function expectedHuskyDetected(signal: string): string {
  return (
    `Detected husky configuration (${signal}). vibe-revert does not install into husky-managed hooks in v0.7.0.\n` +
    "Manage your pre-commit through husky directly, or remove husky to let `viberevert hook install` manage `.git/hooks/pre-commit` standalone.\n" +
    "If you want vibe-revert to gate commits while keeping husky, add this line to your husky pre-commit:\n" +
    "  viberevert check --staged\n"
  );
}

function expectedLefthookDetected(signal: string): string {
  return (
    `Detected lefthook configuration (${signal}). vibe-revert does not install into lefthook-managed hooks in v0.7.0.\n` +
    "Manage your pre-commit through lefthook directly, or remove lefthook to let `viberevert hook install` manage `.git/hooks/pre-commit` standalone.\n" +
    "If you want vibe-revert to gate commits while keeping lefthook, add `viberevert check --staged` to your lefthook.yml pre-commit commands.\n"
  );
}

function expectedBothDetected(huskySignal: string, lefthookSignal: string): string {
  // HookManagersDetectedError composes: huskyMsg + "\n\n" + lefthookMsg.
  // handleKnownError appends one trailing \n. The two helpers already include
  // their trailing \n (one final \n each). Concatenating helper + "\n" + helper
  // exactly reproduces the locked wire shape (blank line between, single
  // trailing \n at end).
  return `${expectedHuskyDetected(huskySignal)}\n${expectedLefthookDetected(lefthookSignal)}`;
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
    `viberevert-hook-install-test-${crypto.randomBytes(8).toString("hex")}`,
  );
  await fsPromises.mkdir(repoRoot, { recursive: true });
  tempDirs.push(repoRoot);
  return repoRoot;
}

async function makeTempGitRepo(): Promise<string> {
  const repoRoot = await makeTempRepoRoot();
  // Use an empty template dir so the developer's global init.templateDir
  // (which may populate .git/hooks/pre-commit) does NOT contaminate the
  // "clean repo" baseline.
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

async function writeFile(repoRoot: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(repoRoot, relPath);
  await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
  await fsPromises.writeFile(fullPath, content);
}

async function readHookFile(repoRoot: string): Promise<Buffer> {
  return fsPromises.readFile(path.join(repoRoot, ".git", "hooks", "pre-commit"));
}

async function hookExists(repoRoot: string): Promise<boolean> {
  try {
    await fsPromises.lstat(path.join(repoRoot, ".git", "hooks", "pre-commit"));
    return true;
  } catch {
    return false;
  }
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runHookInstall(repoRoot: string, args: string[] = []): Promise<CommandResult> {
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
// A1-A3, A21: Clean install
// =============================================================================

describe("viberevert hook install -- clean install (A1, A2, A3, A21)", () => {
  it("A1: writes byte-identical hook + emits EXACT 3-line install success copy", async () => {
    const repoRoot = await makeTempGitRepo();
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `Wrote viberevert pre-commit hook at ${hookPath}.\n` +
        "The hook runs `viberevert check --staged` on every commit; vibe-revert's `risk.block_on` threshold (default: critical) determines what aborts the commit.\n" +
        "To bypass this hook for a single commit, use `git commit --no-verify`.\n",
    );
    const written = await readHookFile(repoRoot);
    expect(written.equals(Buffer.from(HOOK_SCRIPT_TEMPLATE, "utf8"))).toBe(true);
  });

  it("A1: chmods 0o755 (Unix only)", async () => {
    if (isWindows) return;
    const repoRoot = await makeTempGitRepo();
    await runHookInstall(repoRoot);
    const stat = await fsPromises.lstat(path.join(repoRoot, ".git", "hooks", "pre-commit"));
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it("A2: line 1 = shebang, line 2 = MANAGED_BY_MARKER", async () => {
    const repoRoot = await makeTempGitRepo();
    await runHookInstall(repoRoot);
    const lines = (await readHookFile(repoRoot)).toString("utf8").split("\n");
    expect(lines[0]).toBe("#!/bin/sh");
    expect(lines[1]).toBe(MANAGED_BY_MARKER);
  });

  it("A3: body contains locked substrings AND does NOT contain `set -e`", async () => {
    const repoRoot = await makeTempGitRepo();
    await runHookInstall(repoRoot);
    const content = (await readHookFile(repoRoot)).toString("utf8");
    expect(content).toContain("viberevert check --staged");
    expect(content).toContain("--no-verify");
    expect(content).toContain("viberevert prompt-fix");
    expect(content).not.toContain("set -e");
  });

  it("creates .git/hooks/ when absent (D98.X deferred mkdir)", async () => {
    const repoRoot = await makeTempGitRepo();
    await fsPromises.rm(path.join(repoRoot, ".git", "hooks"), {
      recursive: true,
      force: true,
    });
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(await hookExists(repoRoot)).toBe(true);
  });

  it("A21: deterministic content -- two installs in two repos produce byte-identical hooks", async () => {
    const repoA = await makeTempGitRepo();
    const repoB = await makeTempGitRepo();
    await runHookInstall(repoA);
    await runHookInstall(repoB);
    const contentA = await readHookFile(repoA);
    const contentB = await readHookFile(repoB);
    expect(contentA.equals(contentB)).toBe(true);
  });
});

// =============================================================================
// A4, A5, A6: --force / existing non-vr hook / backup collision
// =============================================================================

describe("viberevert hook install -- --force / existing non-vr hook (A4, A5, A6)", () => {
  it("A4: refuses without --force; EXACT 2-line refusal copy; existing hook NOT modified", async () => {
    process.env[VIBEREVERT_TEST_FIXED_NOW] = "2026-06-08T15:49:25.000Z";
    const repoRoot = await makeTempGitRepo();
    const existingContent = "#!/bin/sh\necho user-managed hook\n";
    await writeFile(repoRoot, ".git/hooks/pre-commit", existingContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const backupPath = path.join(
      repoRoot,
      ".git",
      "hooks",
      "pre-commit.viberevert-backup-20260608T154925Z",
    );
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refusing to overwrite existing non-viberevert pre-commit hook at ${hookPath}.\n` +
        `Re-run with --force to back it up to ${backupPath} and install the viberevert hook.\n`,
    );
    const after = (await readHookFile(repoRoot)).toString("utf8");
    expect(after).toBe(existingContent);
  });

  it("A5: --force backs up existing hook with locked timestamp; writes viberevert hook; EXACT install success copy", async () => {
    process.env[VIBEREVERT_TEST_FIXED_NOW] = "2026-06-08T15:49:25.000Z";
    const repoRoot = await makeTempGitRepo();
    const existingContent = "#!/bin/sh\necho user-managed hook\n";
    await writeFile(repoRoot, ".git/hooks/pre-commit", existingContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookInstall(repoRoot, ["--force"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `Wrote viberevert pre-commit hook at ${hookPath}.\n` +
        "The hook runs `viberevert check --staged` on every commit; vibe-revert's `risk.block_on` threshold (default: critical) determines what aborts the commit.\n" +
        "To bypass this hook for a single commit, use `git commit --no-verify`.\n",
    );
    expect(await listBackups(repoRoot)).toEqual(["pre-commit.viberevert-backup-20260608T154925Z"]);
    const backupContent = await fsPromises.readFile(
      path.join(repoRoot, ".git", "hooks", "pre-commit.viberevert-backup-20260608T154925Z"),
      "utf8",
    );
    expect(backupContent).toBe(existingContent);
    const newHook = await readHookFile(repoRoot);
    expect(newHook.equals(Buffer.from(HOOK_SCRIPT_TEMPLATE, "utf8"))).toBe(true);
  });

  it("A6: backup collision -> EXACT BackupCollisionError copy; neither file modified", async () => {
    process.env[VIBEREVERT_TEST_FIXED_NOW] = "2026-06-08T15:49:25.000Z";
    const repoRoot = await makeTempGitRepo();
    const existingContent = "#!/bin/sh\necho user-managed hook\n";
    await writeFile(repoRoot, ".git/hooks/pre-commit", existingContent);
    const backupName = "pre-commit.viberevert-backup-20260608T154925Z";
    const existingBackupContent = "backup-placeholder\n";
    await writeFile(repoRoot, `.git/hooks/${backupName}`, existingBackupContent);
    const backupPath = path.join(repoRoot, ".git", "hooks", backupName);
    const result = await runHookInstall(repoRoot, ["--force"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Existing backup file at ${backupPath} would be overwritten by this install. Remove or rename it first, then re-run \`viberevert hook install --force\`.\n`,
    );
    const after = (await readHookFile(repoRoot)).toString("utf8");
    expect(after).toBe(existingContent);
    const backupAfter = await fsPromises.readFile(backupPath, "utf8");
    expect(backupAfter).toBe(existingBackupContent);
  });

  it("parses --force through Clipanion and enters the backup path (covers parsing surface)", async () => {
    process.env[VIBEREVERT_TEST_FIXED_NOW] = "2026-06-08T15:49:25.000Z";
    const repoRoot = await makeTempGitRepo();
    await writeFile(repoRoot, ".git/hooks/pre-commit", "#!/bin/sh\necho user\n");
    const result = await runHookInstall(repoRoot, ["--force"]);
    expect(result.exitCode).toBe(0);
    expect(await listBackups(repoRoot)).toEqual(["pre-commit.viberevert-backup-20260608T154925Z"]);
  });
});

// =============================================================================
// A7, A8, A9: husky / lefthook / both detected (EXACT D98.O copy)
// =============================================================================

describe("viberevert hook install -- husky / lefthook detection (A7, A8, A9)", () => {
  it("A7: husky via .husky/ -> EXACT HuskyDetectedError copy; no file written", async () => {
    const repoRoot = await makeTempGitRepo();
    await fsPromises.mkdir(path.join(repoRoot, ".husky"), { recursive: true });
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHuskyDetected(".husky/ directory"));
    expect(await hookExists(repoRoot)).toBe(false);
  });

  it("A7: husky via top-level package.json key -> EXACT copy with `package.json `husky` key` signal", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeFile(
      repoRoot,
      "package.json",
      JSON.stringify({ name: "test", husky: { hooks: {} } }),
    );
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHuskyDetected("package.json `husky` key"));
  });

  it("A7: husky via devDependencies -> EXACT copy with devDependencies signal", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeFile(
      repoRoot,
      "package.json",
      JSON.stringify({ name: "test", devDependencies: { husky: "^8.0.0" } }),
    );
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHuskyDetected("package.json `husky` in devDependencies"));
  });

  it("A7: husky via dependencies -> EXACT copy with dependencies signal", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeFile(
      repoRoot,
      "package.json",
      JSON.stringify({ name: "test", dependencies: { husky: "^8.0.0" } }),
    );
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHuskyDetected("package.json `husky` in dependencies"));
  });

  it("A8: lefthook via lefthook.yml -> EXACT LefthookDetectedError copy; no file written", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeFile(repoRoot, "lefthook.yml", "pre-commit:\n");
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedLefthookDetected("lefthook.yml"));
    expect(await hookExists(repoRoot)).toBe(false);
  });

  it("A8: lefthook via devDependencies -> EXACT copy with devDependencies signal", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeFile(
      repoRoot,
      "package.json",
      JSON.stringify({ name: "test", devDependencies: { lefthook: "^1.0.0" } }),
    );
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      expectedLefthookDetected("package.json `lefthook` in devDependencies"),
    );
  });

  it("A9: both husky AND lefthook -> EXACT concatenated HookManagersDetectedError copy with husky-first blank-line-separator ordering", async () => {
    const repoRoot = await makeTempGitRepo();
    await fsPromises.mkdir(path.join(repoRoot, ".husky"), { recursive: true });
    await writeFile(repoRoot, "lefthook.yml", "pre-commit:\n");
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedBothDetected(".husky/ directory", "lefthook.yml"));
    expect(await hookExists(repoRoot)).toBe(false);
  });
});

// =============================================================================
// A10: no git repo (EXACT D98.O copy)
// =============================================================================

describe("viberevert hook install -- no git repo (A10)", () => {
  it("A10: refuses with EXACT 2-line RepoRootNotFoundError copy", async () => {
    const repoRoot = await makeTempRepoRoot();
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    // RepoRootNotFoundError.message format is owned by @viberevert/core
    // and reused verbatim per D98.O ("RepoRootNotFoundError reuse"). The
    // wire shape is one line + the trailing \n from handleKnownError.
    expect(result.stderr).toBe(
      `Could not find a VibeRevert repo root: walked up from ${repoRoot} without finding .git or .viberevert.yml\n`,
    );
  });
});

// =============================================================================
// A11a/b/c, A35: D98.A11 idempotent re-install
// =============================================================================

describe("viberevert hook install -- D98.A11 idempotent re-install (A11, A35)", () => {
  it("A11a: byte-identical AND executable -> EXACT 'no changes needed' copy + content unchanged", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeFile(repoRoot, ".git/hooks/pre-commit", HOOK_SCRIPT_TEMPLATE);
    if (!isWindows) {
      await fsPromises.chmod(path.join(repoRoot, ".git", "hooks", "pre-commit"), 0o755);
    }
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `VibeRevert pre-commit hook already installed at ${hookPath} (byte-identical to current template; no changes needed).\n`,
    );
    const afterContent = await readHookFile(repoRoot);
    expect(afterContent.equals(Buffer.from(HOOK_SCRIPT_TEMPLATE, "utf8"))).toBe(true);
  });

  it("A11b/A35: byte-identical AND non-executable (Unix) -> EXACT 'permissions refreshed' copy + execute bit restored", async () => {
    if (isWindows) return;
    const repoRoot = await makeTempGitRepo();
    await writeFile(repoRoot, ".git/hooks/pre-commit", HOOK_SCRIPT_TEMPLATE);
    await fsPromises.chmod(path.join(repoRoot, ".git", "hooks", "pre-commit"), 0o644);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `VibeRevert pre-commit hook already installed at ${hookPath} (byte-identical to current template; executable permissions refreshed).\n`,
    );
    const after = await fsPromises.lstat(hookPath);
    expect(after.mode & 0o111).not.toBe(0);
    const content = await readHookFile(repoRoot);
    expect(content.equals(Buffer.from(HOOK_SCRIPT_TEMPLATE, "utf8"))).toBe(true);
  });

  it("A11c: bytes differ (managed marker present) -> EXACT 'updated' copy + atomic refresh to template", async () => {
    const repoRoot = await makeTempGitRepo();
    const driftedContent = `#!/bin/sh\n${MANAGED_BY_MARKER}\n# stale body\nexit 0\n`;
    await writeFile(repoRoot, ".git/hooks/pre-commit", driftedContent);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `VibeRevert pre-commit hook updated at ${hookPath} (existing managed hook refreshed to current template).\n`,
    );
    const after = await readHookFile(repoRoot);
    expect(after.equals(Buffer.from(HOOK_SCRIPT_TEMPLATE, "utf8"))).toBe(true);
  });
});

// =============================================================================
// A25, A26: .git missing / .git is a file (D98.V)
// =============================================================================

describe("viberevert hook install -- D98.V .git layout (A25, A26)", () => {
  it("A25: .git missing -> EXACT UnsupportedGitHookLayoutError(not-found) copy", async () => {
    const repoRoot = await makeTempRepoNoGit();
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Hook management requires a standard git repository layout (${path.join(
        repoRoot,
        ".git",
      )} must be a directory). Detected: not-found.\n` +
        "Git worktrees and submodules use indirected hook directories that vibe-revert does not yet support in v0.7.0-beta. See docs/hook-contract.md for the deferred-feature note.\n",
    );
    expect(await hookExists(repoRoot)).toBe(false);
  });

  it("A26: .git is a regular file (worktree pointer) -> EXACT signal=regular-file copy; .viberevert.yml ensures repo-root resolution is independent of `.git`-file behavior", async () => {
    const repoRoot = await makeTempRepoRoot();
    // Locked per the A26 robustness fix: write .viberevert.yml so resolveRepoRoot
    // succeeds via that marker, then D98.V's lstat(.git) sees the regular file
    // and refuses. Without .viberevert.yml, this test would silently depend on
    // resolveRepoRoot()'s behavior toward a .git regular file.
    await fsPromises.writeFile(path.join(repoRoot, ".viberevert.yml"), "# test fixture\n");
    await fsPromises.writeFile(
      path.join(repoRoot, ".git"),
      "gitdir: /elsewhere/.git/worktrees/test\n",
    );
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Hook management requires a standard git repository layout (${path.join(
        repoRoot,
        ".git",
      )} must be a directory). Detected: regular-file.\n` +
        "Git worktrees and submodules use indirected hook directories that vibe-revert does not yet support in v0.7.0-beta. See docs/hook-contract.md for the deferred-feature note.\n",
    );
    expect(await hookExists(repoRoot)).toBe(false);
  });

  it("A25: --force does NOT override .git layout refusal", async () => {
    const repoRoot = await makeTempRepoNoGit();
    const result = await runHookInstall(repoRoot, ["--force"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Hook management requires a standard git repository layout");
  });
});

// =============================================================================
// A28: malformed package.json (D98.O 2-line copy)
// =============================================================================

describe("viberevert hook install -- malformed package.json (A28)", () => {
  it("A28: malformed JSON -> EXACT 2-line refusal copy (line 1 parse-message-bearing via regex; line 2 install-context lock verbatim)", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeFile(repoRoot, "package.json", "{ this is not valid JSON");
    const pkgPath = path.join(repoRoot, "package.json");
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    const lines = result.stderr.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      new RegExp(
        `^Failed to parse package\\.json while checking for hook managers at ${escapeRegex(
          pkgPath,
        )}: .+\\.$`,
      ),
    );
    expect(lines[1]).toBe(
      "Refusing to install the hook because we cannot verify whether husky or lefthook is configured. Fix the JSON and re-run.",
    );
    expect(lines[2]).toBe("");
    expect(await hookExists(repoRoot)).toBe(false);
  });

  it("A28: --force does NOT override MalformedPackageJsonError", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeFile(repoRoot, "package.json", "{ broken");
    const result = await runHookInstall(repoRoot, ["--force"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to parse package.json");
    expect(await hookExists(repoRoot)).toBe(false);
  });
});

// =============================================================================
// A29: HookManagerIoError surfacing
// =============================================================================

describe("viberevert hook install -- HookManagerIoError (A29)", () => {
  it("A29: non-ENOENT lstat failure on .husky -> generic I/O refusal copy with op + path", async () => {
    const repoRoot = await makeTempGitRepo();
    const huskyPath = path.join(repoRoot, ".husky");
    const eaccesErr = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.lstat).mockImplementation(async (p) => {
      if (p === huskyPath) {
        throw eaccesErr;
      }
      return actual.lstat(p);
    });
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to stat at");
    expect(result.stderr).toContain(huskyPath);
    expect(result.stderr).toContain("EACCES");
    expect(await hookExists(repoRoot)).toBe(false);
  });

  it("A29: --force does NOT override HookManagerIoError", async () => {
    const repoRoot = await makeTempGitRepo();
    const huskyPath = path.join(repoRoot, ".husky");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.lstat).mockImplementation(async (p) => {
      if (p === huskyPath) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      return actual.lstat(p);
    });
    const result = await runHookInstall(repoRoot, ["--force"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to stat at");
  });
});

// =============================================================================
// A38: .git/hooks not a directory (D98.X)
// =============================================================================

describe("viberevert hook install -- D98.X .git/hooks layout (A38)", () => {
  it("A38: .git/hooks is a regular file -> EXACT UnsupportedGitHooksDirectoryError(regular-file) copy", async () => {
    const repoRoot = await makeTempGitRepo();
    await fsPromises.rm(path.join(repoRoot, ".git", "hooks"), {
      recursive: true,
      force: true,
    });
    await fsPromises.writeFile(path.join(repoRoot, ".git", "hooks"), "not a directory");
    const hooksDir = path.join(repoRoot, ".git", "hooks");
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Hook management requires .git/hooks to be a real directory at ${hooksDir}. Detected: regular-file.\n` +
        "Shared-hooks-directory setups (where .git/hooks is a symlink to another location) are not supported in v0.7.0-beta. Manage the hook at the symlink target manually, or wait for M G/M H support.\n",
    );
  });

  it.skipIf(isWindows)(
    "A38: .git/hooks is a symlink -> EXACT signal=symbolic-link copy",
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
      const result = await runHookInstall(repoRoot);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `Hook management requires .git/hooks to be a real directory at ${hooksDir}. Detected: symbolic-link.\n` +
          "Shared-hooks-directory setups (where .git/hooks is a symlink to another location) are not supported in v0.7.0-beta. Manage the hook at the symlink target manually, or wait for M G/M H support.\n",
      );
    },
  );

  it("A38: --force does NOT override .git/hooks layout refusal", async () => {
    const repoRoot = await makeTempGitRepo();
    await fsPromises.rm(path.join(repoRoot, ".git", "hooks"), {
      recursive: true,
      force: true,
    });
    await fsPromises.writeFile(path.join(repoRoot, ".git", "hooks"), "blocker");
    const result = await runHookInstall(repoRoot, ["--force"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Hook management requires .git/hooks to be a real directory");
  });
});

// =============================================================================
// A36, A41: regular-file-only marker check
// =============================================================================

describe("viberevert hook install -- regular-file-only marker check (A36, A41)", () => {
  it("A36: existing pre-commit is a directory -> non-vr; refuses without --force", async () => {
    const repoRoot = await makeTempGitRepo();
    await fsPromises.mkdir(path.join(repoRoot, ".git", "hooks", "pre-commit"), { recursive: true });
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Refusing to overwrite existing non-viberevert pre-commit hook",
    );
  });

  it("A36: existing pre-commit is a directory + --force -> directory renamed to backup; fresh viberevert hook written (cross-platform)", async () => {
    process.env[VIBEREVERT_TEST_FIXED_NOW] = "2026-06-08T15:49:25.000Z";
    const repoRoot = await makeTempGitRepo();
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    await fsPromises.mkdir(hookPath, { recursive: true });
    const result = await runHookInstall(repoRoot, ["--force"]);
    expect(result.exitCode).toBe(0);
    const backupPath = path.join(
      repoRoot,
      ".git",
      "hooks",
      "pre-commit.viberevert-backup-20260608T154925Z",
    );
    const backupStat = await fsPromises.lstat(backupPath);
    expect(backupStat.isDirectory()).toBe(true);
    const newHook = await readHookFile(repoRoot);
    expect(newHook.equals(Buffer.from(HOOK_SCRIPT_TEMPLATE, "utf8"))).toBe(true);
  });

  it.skipIf(isWindows)(
    "A41: existing pre-commit is a symlink to a marker-bearing file -> NOT marker-read; refuses; symlink target untouched",
    async () => {
      const repoRoot = await makeTempGitRepo();
      const targetPath = path.join(repoRoot, "managed-elsewhere");
      const targetContent = `#!/bin/sh\n${MANAGED_BY_MARKER}\n# elsewhere\n`;
      await fsPromises.writeFile(targetPath, targetContent);
      const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
      await fsPromises.mkdir(path.join(repoRoot, ".git", "hooks"), { recursive: true });
      await fsPromises.symlink(targetPath, hookPath);
      const result = await runHookInstall(repoRoot);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Refusing to overwrite existing non-viberevert pre-commit hook",
      );
      const after = await fsPromises.readFile(targetPath, "utf8");
      expect(after).toBe(targetContent);
    },
  );

  it.skipIf(isWindows)(
    "A41: --force on the symlink-to-marker-target case renames the symlink (not the target)",
    async () => {
      process.env[VIBEREVERT_TEST_FIXED_NOW] = "2026-06-08T15:49:25.000Z";
      const repoRoot = await makeTempGitRepo();
      const targetPath = path.join(repoRoot, "managed-elsewhere");
      const targetContent = `#!/bin/sh\n${MANAGED_BY_MARKER}\n# elsewhere\n`;
      await fsPromises.writeFile(targetPath, targetContent);
      const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
      await fsPromises.mkdir(path.join(repoRoot, ".git", "hooks"), { recursive: true });
      await fsPromises.symlink(targetPath, hookPath);
      const result = await runHookInstall(repoRoot, ["--force"]);
      expect(result.exitCode).toBe(0);
      const targetAfter = await fsPromises.readFile(targetPath, "utf8");
      expect(targetAfter).toBe(targetContent);
      const backups = await listBackups(repoRoot);
      expect(backups).toHaveLength(1);
      const backupName = backups[0];
      expect(backupName).toBeDefined();
      if (backupName === undefined) {
        throw new Error("Expected one backup entry after --force symlink backup.");
      }
      const backupStat = await fsPromises.lstat(path.join(repoRoot, ".git", "hooks", backupName));
      expect(backupStat.isSymbolicLink()).toBe(true);
    },
  );
});

// =============================================================================
// A40: marker line-2 exact-match with CRLF tolerance (6 cases)
// =============================================================================

describe("viberevert hook install -- A40 marker line-2 exact-match", () => {
  it("case 1: MARKER exactly on line 2 (LF) with DRIFTED body -> managed; 'updated' path proves line-2 alone is enough", async () => {
    const repoRoot = await makeTempGitRepo();
    const managedButDrifted = `#!/bin/sh\n${MANAGED_BY_MARKER}\n# stale body\nexit 0\n`;
    await writeFile(repoRoot, ".git/hooks/pre-commit", managedButDrifted);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `VibeRevert pre-commit hook updated at ${hookPath} (existing managed hook refreshed to current template).\n`,
    );
    const after = await readHookFile(repoRoot);
    expect(after.equals(Buffer.from(HOOK_SCRIPT_TEMPLATE, "utf8"))).toBe(true);
  });

  it("case 2: MARKER + '\\r' on line 2 (CRLF-drifted) -> managed; refreshed to canonical LF", async () => {
    const repoRoot = await makeTempGitRepo();
    const crlfDrifted = `#!/bin/sh\n${MANAGED_BY_MARKER}\r\n# drifted body\n`;
    await writeFile(repoRoot, ".git/hooks/pre-commit", crlfDrifted);
    const hookPath = path.join(repoRoot, ".git", "hooks", "pre-commit");
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `VibeRevert pre-commit hook updated at ${hookPath} (existing managed hook refreshed to current template).\n`,
    );
    const after = await readHookFile(repoRoot);
    expect(after.equals(Buffer.from(HOOK_SCRIPT_TEMPLATE, "utf8"))).toBe(true);
    expect(after.indexOf(0x0d)).toBe(-1);
  });

  it("case 3: MARKER on line 3 -> NOT managed -> refuses without --force", async () => {
    const repoRoot = await makeTempGitRepo();
    const wrongLine = `#!/bin/sh\n# random comment\n${MANAGED_BY_MARKER}\necho hi\n`;
    await writeFile(repoRoot, ".git/hooks/pre-commit", wrongLine);
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Refusing to overwrite existing non-viberevert pre-commit hook",
    );
  });

  it("case 4: MARKER as substring inside a comment on line 5 -> NOT managed", async () => {
    const repoRoot = await makeTempGitRepo();
    const inComment = `#!/bin/sh\n# random\necho ok\n# more\n# wrapper: ${MANAGED_BY_MARKER} embedded\n`;
    await writeFile(repoRoot, ".git/hooks/pre-commit", inComment);
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Refusing to overwrite existing non-viberevert pre-commit hook",
    );
  });

  it("case 5: MARKER + ' extra trailing chars' on line 2 -> NOT managed (exact equality, not startsWith)", async () => {
    const repoRoot = await makeTempGitRepo();
    const withTrailer = `#!/bin/sh\n${MANAGED_BY_MARKER} extra trailing chars\n`;
    await writeFile(repoRoot, ".git/hooks/pre-commit", withTrailer);
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Refusing to overwrite existing non-viberevert pre-commit hook",
    );
  });

  it("case 6: no marker anywhere -> NOT managed", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeFile(repoRoot, ".git/hooks/pre-commit", "#!/bin/sh\necho plain\n");
    const result = await runHookInstall(repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Refusing to overwrite existing non-viberevert pre-commit hook",
    );
  });
});

// =============================================================================
// `--force` does NOT override absolute refusals
// =============================================================================

describe("viberevert hook install -- --force scope (D98.D lock)", () => {
  it("--force does NOT override husky detection (EXACT husky copy)", async () => {
    const repoRoot = await makeTempGitRepo();
    await fsPromises.mkdir(path.join(repoRoot, ".husky"), { recursive: true });
    const result = await runHookInstall(repoRoot, ["--force"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedHuskyDetected(".husky/ directory"));
  });

  it("--force does NOT override lefthook detection (EXACT lefthook copy)", async () => {
    const repoRoot = await makeTempGitRepo();
    await writeFile(repoRoot, "lefthook.yml", "pre-commit:\n");
    const result = await runHookInstall(repoRoot, ["--force"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedLefthookDetected("lefthook.yml"));
  });

  it("--force does NOT override both-detected (EXACT concatenated copy)", async () => {
    const repoRoot = await makeTempGitRepo();
    await fsPromises.mkdir(path.join(repoRoot, ".husky"), { recursive: true });
    await writeFile(repoRoot, "lefthook.yml", "pre-commit:\n");
    const result = await runHookInstall(repoRoot, ["--force"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(expectedBothDetected(".husky/ directory", "lefthook.yml"));
  });
});

// =============================================================================
// Error-class shapes (exported per D98.R; readonly fields for MCP typed-catch)
// =============================================================================

describe("hook-install error classes (exported per D98.R)", () => {
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

  it("ExistingNonViberevertHookError exposes hookPath + backupPath", () => {
    const err = new ExistingNonViberevertHookError("/h/pre-commit", "/h/back");
    expect(err.name).toBe("ExistingNonViberevertHookError");
    expect(err.hookPath).toBe("/h/pre-commit");
    expect(err.backupPath).toBe("/h/back");
  });

  it("HuskyDetectedError exposes signal", () => {
    const err = new HuskyDetectedError(".husky/ directory");
    expect(err.name).toBe("HuskyDetectedError");
    expect(err.signal).toBe(".husky/ directory");
  });

  it("LefthookDetectedError exposes signal", () => {
    const err = new LefthookDetectedError("lefthook.yml");
    expect(err.name).toBe("LefthookDetectedError");
    expect(err.signal).toBe("lefthook.yml");
  });

  it("HookManagersDetectedError exposes both signals + concatenates messages with husky-first ordering", () => {
    const err = new HookManagersDetectedError(".husky/ directory", "lefthook.yml");
    expect(err.name).toBe("HookManagersDetectedError");
    expect(err.huskySignal).toBe(".husky/ directory");
    expect(err.lefthookSignal).toBe("lefthook.yml");
    expect(err.message).toContain("Detected husky configuration");
    expect(err.message).toContain("Detected lefthook configuration");
    expect(err.message.indexOf("Detected husky")).toBeLessThan(
      err.message.indexOf("Detected lefthook"),
    );
  });

  it("BackupCollisionError exposes backupPath", () => {
    const err = new BackupCollisionError("/h/back-20260608T154925Z");
    expect(err.name).toBe("BackupCollisionError");
    expect(err.backupPath).toBe("/h/back-20260608T154925Z");
  });

  it("HookInstallIoError exposes op + path + underlyingMessage", () => {
    const err = new HookInstallIoError("rename", "/h/pre-commit", "EBUSY");
    expect(err.name).toBe("HookInstallIoError");
    expect(err.op).toBe("rename");
    expect(err.path).toBe("/h/pre-commit");
    expect(err.underlyingMessage).toBe("EBUSY");
    expect(err.message).toBe("Failed to rename at /h/pre-commit: EBUSY.");
  });
});

// =============================================================================
// Re-imports sanity
// =============================================================================

describe("hook-install exports", () => {
  it("all 8 install error classes + HookInstallCommand are exported", () => {
    expect(HookInstallCommand).toBeDefined();
    expect(UnsupportedGitHookLayoutError).toBeDefined();
    expect(UnsupportedGitHooksDirectoryError).toBeDefined();
    expect(ExistingNonViberevertHookError).toBeDefined();
    expect(HuskyDetectedError).toBeDefined();
    expect(LefthookDetectedError).toBeDefined();
    expect(HookManagersDetectedError).toBeDefined();
    expect(BackupCollisionError).toBeDefined();
    expect(HookInstallIoError).toBeDefined();
    expect(HookManagerIoError).toBeDefined();
    expect(MalformedPackageJsonError).toBeDefined();
  });
});
