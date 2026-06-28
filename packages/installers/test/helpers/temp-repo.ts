// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Test helpers for installer tests that need temp repos and (optional)
// symlink fixtures.
//
// createTempRepo() returns { repoRoot, cleanup }. Use vitest's
// beforeEach/afterEach pattern; cleanup uses { recursive: true,
// force: true } so partial/corrupted state under repoRoot (left by
// a test that intentionally broke lock/journal/store) is removed
// regardless.
//
// SYMLINKS_SUPPORTED is probed once at module load: on Windows
// without Developer Mode or admin privileges, fs.symlinkSync throws
// EPERM. Symlink-specific tests use it.skipIf(!SYMLINKS_SUPPORTED)
// (or describe.skipIf) to skip silently rather than fail.
//
// createDirectorySymlink wraps symlink() with the Windows-compatible
// "dir" third argument. On POSIX the third arg is ignored.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_PREFIX = "viberevert-installers-";

export async function createTempRepo(): Promise<{
  readonly repoRoot: string;
  readonly cleanup: () => Promise<void>;
}> {
  const repoRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  return {
    repoRoot,
    cleanup: async () => {
      await rm(repoRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Create a directory symlink in a Windows-compatible way. On POSIX
 * the third arg is ignored. On Windows, "dir" tells fs to create
 * a directory-mode symlink (otherwise NTFS may refuse or create
 * a junction with different semantics). Tests gate on
 * SYMLINKS_SUPPORTED before calling.
 */
export async function createDirectorySymlink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, "dir");
}

/**
 * Probe at module load: can we create a directory symlink on this
 * platform? Result cached as SYMLINKS_SUPPORTED. Cleanup is
 * best-effort -- a probe failure leaves SYMLINKS_SUPPORTED=false
 * regardless of whether the probe directory cleaned up.
 */
function probeSymlinkSupport(): boolean {
  let probeDir: string | null = null;
  try {
    probeDir = mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}symlink-probe-`));
    const target = join(probeDir, "target");
    const link = join(probeDir, "link");
    mkdirSync(target);
    symlinkSync(target, link, "dir");
    return true;
  } catch {
    return false;
  } finally {
    if (probeDir !== null) {
      try {
        rmSync(probeDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; probe result is what matters.
      }
    }
  }
}

export const SYMLINKS_SUPPORTED: boolean = probeSymlinkSupport();
