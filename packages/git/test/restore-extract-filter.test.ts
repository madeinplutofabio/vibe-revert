// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M H6 Step 2 — extraction-time defense-in-depth filter for the untracked
// tarball (extractUntrackedTarball in restore.ts).
//
// assertArchiveEntries (restore-preflight.ts) is the PRIMARY guard — it throws
// on a hostile archive. extractUntrackedTarball keeps an independent per-entry
// tar.extract filter (regular-file + safe-path + non-`.viberevert/**`) as belt-
// and-braces, so a future preflight drift can't become a write. These tests
// drive that filter DIRECTLY via `_extractUntrackedTarballForTests`, bypassing
// preflight (which would otherwise reject the archive first).
//
// The filter SKIPS a rejected entry silently (no throw), so the guarantee proved
// here is WRITE PREVENTION, not a restoration-count contract — the function
// returns Promise<void>; "skipped != restored" is enforced downstream by the
// post-extraction hash check (RestoreVerificationError). Expectations are
// grounded in an observed node-tar 7.5.21 extract characterization: clean files
// write; the hostile cases covered here (non-regular type, `.viberevert/**`,
// `../` traversal, PAX-overridden path) are skipped with nothing written inside
// or outside repoRoot. Absence is checked with lstat (not access/readFile) so a
// dangling symlink or special node counts as failure.

import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _extractUntrackedTarballForTests } from "../src/restore.js";
import {
  dirEntry,
  fileEntry,
  hardlinkEntry,
  makeTarGz,
  paxPathOverride,
  symlinkEntry,
  type TarEntrySpec,
} from "./hostile-archive.js";

// lstat-based absence: any node (regular, symlink, dir, special) fails the test.
async function assertAbsent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("extractUntrackedTarball — extraction-time defense-in-depth filter", () => {
  const tmpRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  // Extract `entries` into `<tmp>/repo`. Returns tmp (parent) + repoRoot so a
  // traversal escape above the root is observable. Resolves for hostile inputs
  // (silent-skip contract); a throw here fails the test.
  async function extract(
    entries: readonly TarEntrySpec[],
  ): Promise<{ tmp: string; repoRoot: string }> {
    const tmp = await mkdtemp(join(tmpdir(), "viberevert-h6-extract-"));
    tmpRoots.push(tmp);
    const repoRoot = join(tmp, "repo");
    await mkdir(repoRoot, { recursive: true });
    await _extractUntrackedTarballForTests(makeTarGz(entries), repoRoot);
    return { tmp, repoRoot };
  }

  it("writes a clean regular-file entry with exact bytes", async () => {
    const { repoRoot } = await extract([fileEntry("ok.txt", "hello world")]);
    expect(await readFile(join(repoRoot, "ok.txt"), "utf8")).toBe("hello world");
  });

  it("skips a symlink entry — no node created", async () => {
    const { repoRoot } = await extract([symlinkEntry("evil-link", "/etc/passwd")]);
    await assertAbsent(join(repoRoot, "evil-link"));
  });

  it("skips a hard-link entry — no node created", async () => {
    const { repoRoot } = await extract([hardlinkEntry("evil-hl", "ok.txt")]);
    await assertAbsent(join(repoRoot, "evil-hl"));
  });

  it("skips a directory entry — no node created", async () => {
    const { repoRoot } = await extract([dirEntry("evil-dir")]);
    await assertAbsent(join(repoRoot, "evil-dir"));
  });

  it("skips a `.viberevert/**` entry — no node created", async () => {
    const { repoRoot } = await extract([fileEntry(".viberevert/x", "x")]);
    await assertAbsent(join(repoRoot, ".viberevert", "x"));
    await assertAbsent(join(repoRoot, ".viberevert"));
  });

  it("does not write a `../evil` traversal entry inside or outside repoRoot", async () => {
    const { tmp, repoRoot } = await extract([fileEntry("../evil", "x")]);
    await assertAbsent(join(tmp, "evil")); // escaped above repoRoot
    await assertAbsent(join(repoRoot, "evil")); // stripped-to-in-root
  });

  it("does not write a PAX `path=` override under `.viberevert/`", async () => {
    const { repoRoot } = await extract(paxPathOverride(".viberevert/pax-evil"));
    await assertAbsent(join(repoRoot, ".viberevert", "pax-evil"));
    await assertAbsent(join(repoRoot, "harmless")); // PAX-overridden placeholder also unwritten
  });
});
