// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M H6 — hostile-archive coverage for the restore preflight archive-shape
// guard (`assertArchiveEntries` in restore-preflight.ts).
//
// The production capture pipeline only ever writes clean archives, so these
// negative branches are unreachable with a captured tarball. Two layers:
//   1. Exhaustive UNIT matrix against the `_assertArchiveEntriesForTests` alias
//      with hand-crafted hostile tar-gz buffers (./hostile-archive.ts). Table-
//      driven for the entry-type and unsafe-path families; each case asserts the
//      intended guard fires (category phrase + offending path/type), and — where
//      two guards could match — that the earlier one wins.
//   2. Two INTEGRATION cases driving the real, non-mutating `loadRestorePreflight`
//      pipeline with a corrupted untracked archive, proving preflight invokes the
//      guard and surfaces CheckpointCorruptError. No restore mutation is entered
//      (loadRestorePreflight is validation-only; the captured file is asserted
//      unchanged after the rejection).
//
// Expectations are grounded in a node-tar 7.5.21 characterization (see
// hostile-archive.ts): `list()` preserves dot segments, repeated slashes,
// leading slashes, and drive-qualified paths; it normalizes `\` to `/`, applies
// PAX `path=` overrides to the effective `entry.path`, and reports
// CharacterDevice/BlockDevice/etc. verbatim.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createCheckpoint, loadCheckpoint } from "../src/checkpoint.js";
import * as gitExports from "../src/index.js";
import { _assertArchiveEntriesForTests, loadRestorePreflight } from "../src/restore-preflight.js";
import {
  blockDeviceEntry,
  charDeviceEntry,
  dirEntry,
  fifoEntry,
  fileEntry,
  hardlinkEntry,
  makeTarGz,
  paxPathOverride,
  symlinkEntry,
  type TarEntrySpec,
} from "./hostile-archive.js";

type ArchiveLabel = "untracked" | "tracked-dirty";

// checkpointDir is only interpolated into error messages in the unit matrix —
// no filesystem access happens there, so a synthetic path is fine.
const DIR = "/synthetic/checkpoint";

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function rejectBuf(
  buf: Buffer,
  expectedPaths: readonly string[],
  messageRe: RegExp,
  label: ArchiveLabel = "untracked",
): Promise<void> {
  // Single promise, awaited twice: the guard runs once, both assertions observe
  // the same rejection. `.rejects` fails clearly if it resolves instead.
  const promise = _assertArchiveEntriesForTests(DIR, buf, label, expectedPaths);
  await expect(promise).rejects.toMatchObject({ name: "CheckpointCorruptError" });
  await expect(promise).rejects.toThrow(messageRe);
}

function reject(
  entries: readonly TarEntrySpec[],
  expectedPaths: readonly string[],
  messageRe: RegExp,
  label: ArchiveLabel = "untracked",
): Promise<void> {
  return rejectBuf(makeTarGz(entries), expectedPaths, messageRe, label);
}

// Entry type → the exact node-tar `entry.type` name the guard reports.
const NON_REGULAR_CASES: readonly (readonly [string, TarEntrySpec, string])[] = [
  ["symlink", symlinkEntry("a.txt", "/etc/passwd"), "SymbolicLink"],
  ["hard link", hardlinkEntry("a.txt", "b.txt"), "Link"],
  ["directory", dirEntry("a"), "Directory"],
  ["fifo", fifoEntry("a"), "FIFO"],
  ["character device", charDeviceEntry("a"), "CharacterDevice"],
  ["block device", blockDeviceEntry("a"), "BlockDevice"],
];

// Separator / platform path forms and the effective `entry.path` node-tar
// reports (`\`->`/` on read; dot segments, `//`, leading `/`, drive preserved).
const UNSAFE_PATH_CASES: readonly (readonly [input: string, effectivePath: string])[] = [
  ["../evil", "../evil"],
  ["a/../../evil", "a/../../evil"],
  ["/etc/evil", "/etc/evil"],
  ["./file", "./file"],
  ["a//b", "a//b"],
  ["a/../b", "a/../b"],
  ["..\\evil", "../evil"],
  ["C:\\evil", "C:/evil"],
  ["C:/evil", "C:/evil"],
  ["\\\\server\\share\\evil", "//server/share/evil"],
];

describe("assertArchiveEntries — hostile archive matrix (unit)", () => {
  it("accepts a clean regular-file archive whose entry set matches expected", async () => {
    await expect(
      _assertArchiveEntriesForTests(
        DIR,
        makeTarGz([fileEntry("a.txt", "x"), fileEntry("b/c.txt", "y")]),
        "untracked",
        ["a.txt", "b/c.txt"],
      ),
    ).resolves.toBeUndefined();
  });

  it.each(
    NON_REGULAR_CASES,
  )("rejects non-regular entry type: %s", async (_name, entry, typeName) => {
    // expectedPaths includes the entry path, so parity would pass — the ONLY
    // reason to reject is the type, isolating the type guard.
    await reject([entry], [entry.path], new RegExp(`non-regular entry of type "${typeName}"`));
  });

  it.each(UNSAFE_PATH_CASES)("rejects unsafe path: %s", async (inputPath, effectivePath) => {
    await reject(
      [fileEntry(inputPath, "x")],
      [],
      new RegExp(`non-canonical path.*${escapeRegExp(effectivePath)}`),
    );
  });

  it("internal-storage guard fires before the canonical check (`.viberevert/../x`)", async () => {
    // node-tar reports `..` raw; isVibeRevertInternalPath does not resolve `..`,
    // so `.viberevert/../x` still starts with `.viberevert/` (internal = true)
    // while isSafeStoredRelativePath rejects it for the `..` segment. The
    // internal-storage message (not "non-canonical") proves the internal guard
    // runs first.
    await reject(
      [fileEntry(".viberevert/../x", "x")],
      [],
      new RegExp(`VibeRevert internal storage path.*${escapeRegExp(".viberevert/../x")}`),
    );
  });

  it("rejects a plain `.viberevert/**` entry as internal storage", async () => {
    await reject(
      [fileEntry(".viberevert/data", "x")],
      [],
      new RegExp(`VibeRevert internal storage path.*${escapeRegExp(".viberevert/data")}`),
    );
  });

  it("rejects a PAX `path=` override resolving to a traversal path", async () => {
    // node-tar applies a PAX `path=` record to the following entry and reports
    // it as the effective entry.path, so the guard evaluates `../evil`, not the
    // harmless 100-byte USTAR name — the guard is not fooled by extension records.
    await reject(
      paxPathOverride("../evil"),
      [],
      new RegExp(`non-canonical path.*${escapeRegExp("../evil")}`),
    );
  });

  it("rejects a PAX `path=` override resolving under `.viberevert/`", async () => {
    await reject(
      paxPathOverride(".viberevert/x"),
      [],
      new RegExp(`VibeRevert internal storage path.*${escapeRegExp(".viberevert/x")}`),
    );
  });

  it("rejects duplicate entries with the same effective path", async () => {
    // Non-canonical aliases (`a//b`, `a/./b`) are rejected before duplicate
    // detection, while two entries using the same effective canonical path are
    // rejected here even when their contents differ.
    await reject([fileEntry("dup", "a"), fileEntry("dup", "b")], ["dup"], /duplicate entry: dup/);
  });

  it("rejects an entry absent from manifest file_hashes (untracked label)", async () => {
    await reject(
      [fileEntry("extra.txt", "x")],
      [],
      /entry NOT in manifest\.untracked\.file_hashes: extra\.txt/,
    );
  });

  it("rejects an entry absent from manifest file_hashes (tracked-dirty names snapshots)", async () => {
    await reject(
      [fileEntry("extra.txt", "x")],
      [],
      /entry NOT in manifest\.snapshots\.file_hashes: extra\.txt/,
      "tracked-dirty",
    );
  });

  it("rejects a manifest-declared entry missing from the archive", async () => {
    await reject(
      [fileEntry("present.txt", "x")],
      ["present.txt", "gone.txt"],
      /is missing manifest-declared entry: gone\.txt/,
    );
  });

  it("rejects a truncated (undecompressable) archive as a parse failure", async () => {
    // Dropping the 8-byte gzip trailer makes zlib fail deterministically with
    // "unexpected end of file" (characterized under node-tar 7.5.21 / Node).
    const valid = makeTarGz([fileEntry("a.txt", "x")]);
    await rejectBuf(valid.subarray(0, valid.length - 8), ["a.txt"], /archive failed to parse/);
  });
});

describe("test-only alias is not part of the package's public surface", () => {
  it("`_assertArchiveEntriesForTests` is not exported from the @viberevert/git barrel", () => {
    expect("_assertArchiveEntriesForTests" in gitExports).toBe(false);
  });
});

// =============================================================================
// Integration — the real loadRestorePreflight pipeline invokes the guard
// =============================================================================

const execFileAsync = promisify(execFile);
const CAPTURED_CONTENT = "captured content\n";

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd, windowsHide: true });
}

interface IntegrationRepo {
  readonly repoRoot: string;
  readonly checkpointDir: string;
  readonly cleanup: () => Promise<void>;
}

// Minimal repo + checkpoint with a single captured untracked file, so the
// untracked archive is non-empty and reachable by the preflight guard.
async function buildCheckpointWithUntracked(): Promise<IntegrationRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-h6-archive-"));
  const repoRoot = join(tmp, "repo");
  const checkpointDir = join(tmp, "checkpoint");
  await mkdir(repoRoot, { recursive: true });
  await runGit(repoRoot, ["init", "-b", "main"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test User"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  await writeFile(join(repoRoot, "captured.txt"), CAPTURED_CONTENT);
  await mkdir(checkpointDir, { recursive: true });
  await createCheckpoint({ repoRoot, checkpointDir, rollbackExcludePatterns: [] });
  return { repoRoot, checkpointDir, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

async function overwriteUntrackedArchive(repo: IntegrationRepo, buf: Buffer): Promise<void> {
  // No archive digest/size exists in the manifest (loadCheckpoint validates
  // existence + regular-file type only), so replacing the archive with a valid
  // regular file reaches assertArchiveEntries directly — nothing to refresh.
  const manifest = await loadCheckpoint(repo.checkpointDir);
  await writeFile(join(repo.checkpointDir, manifest.untracked.archive_path), buf);
}

async function expectPreflightRejects(repo: IntegrationRepo, messageRe: RegExp): Promise<void> {
  const promise = loadRestorePreflight(repo.checkpointDir, {
    repoRoot: repo.repoRoot,
    rollbackExcludePatterns: [],
    includeArtifactBuffers: false,
  });
  await expect(promise).rejects.toMatchObject({ name: "CheckpointCorruptError" });
  await expect(promise).rejects.toThrow(messageRe);
}

describe("assertArchiveEntries — real loadRestorePreflight call path (integration)", () => {
  it("rejects a hostile symlink entry type (no restore mutation entered)", async () => {
    const repo = await buildCheckpointWithUntracked();
    try {
      await overwriteUntrackedArchive(
        repo,
        makeTarGz([symlinkEntry("captured.txt", "/etc/passwd")]),
      );
      await expectPreflightRejects(repo, /non-regular entry of type "SymbolicLink"/);
      // loadRestorePreflight is validation-only — the captured file is untouched.
      expect(await readFile(join(repo.repoRoot, "captured.txt"), "utf8")).toBe(CAPTURED_CONTENT);
    } finally {
      await repo.cleanup();
    }
  });

  it("rejects a `.viberevert/**` archive path (no restore mutation entered)", async () => {
    const repo = await buildCheckpointWithUntracked();
    try {
      await overwriteUntrackedArchive(repo, makeTarGz([fileEntry(".viberevert/x", "x")]));
      await expectPreflightRejects(
        repo,
        new RegExp(`VibeRevert internal storage path.*${escapeRegExp(".viberevert/x")}`),
      );
      expect(await readFile(join(repo.repoRoot, "captured.txt"), "utf8")).toBe(CAPTURED_CONTENT);
    } finally {
      await repo.cleanup();
    }
  });
});
