// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit + integration tests for packages/cli/src/gitignore.ts — the M B
// corrective helper that ensures `.viberevert/` is gitignored after
// `viberevert init`. NOT exported from the CLI's public surface, so we
// import directly via the source path.
//
// What's load-bearing here:
//   - `containsEffectiveViberevertRule` MUST honor gitignore's
//     last-match-wins precedence for our 4 exact rules. A file that
//     positively ignores `.viberevert/` followed by an un-ignoring
//     negation (`!.viberevert/`) is NOT effectively ignored, and the
//     helper must return false so init appends a fresh rule and
//     restores the invariant. This is the exact trust-critical contract
//     the M B fix is correcting.
//   - `containsEffectiveViberevertRule` MUST treat leading whitespace as
//     part of the pattern (NOT strip it) — per gitignore(5), a line with
//     leading whitespace is a different pattern from one without, and
//     would not match `.viberevert/` under Git's own parser.
//   - `ensureViberevertGitignore` MUST be idempotent on re-run.
//   - Newline style of an existing `.gitignore` MUST be preserved
//     (CRLF stays CRLF; LF stays LF) when appending.
//
// What these tests deliberately do NOT prove:
//   - User-authored broader patterns (`.vib*`, `**` globs) being
//     recognized as effective — they're explicitly NOT recognized per
//     the helper's locked limitations; an explicit `.viberevert/`
//     append is harmless and preserves user intent.
//   - Backslash-escaped trailing spaces (gitignore(5) edge case) being
//     preserved — also explicitly NOT modeled; benign duplicate append
//     if it occurs.
//   - Concurrent writers to the same `.gitignore` (TOCTOU). `.gitignore`
//     is user-facing state, not internal `.viberevert/` state — the M B
//     atomic-write rule (D13) explicitly does not apply here.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { containsEffectiveViberevertRule, ensureViberevertGitignore } from "../src/gitignore.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "viberevert-cli-gitignore-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// --- containsEffectiveViberevertRule (pure) -------------------------------

describe("containsEffectiveViberevertRule", () => {
  it("returns false on empty content", () => {
    expect(containsEffectiveViberevertRule("")).toBe(false);
  });

  it("returns false on whitespace-only content", () => {
    expect(containsEffectiveViberevertRule("\n\n   \n\t\n")).toBe(false);
  });

  it("returns false when only comments are present", () => {
    expect(containsEffectiveViberevertRule("# top comment\n# another\n")).toBe(false);
  });

  it("recognizes each of the 4 effective canonical forms", () => {
    expect(containsEffectiveViberevertRule(".viberevert/\n")).toBe(true);
    expect(containsEffectiveViberevertRule(".viberevert\n")).toBe(true);
    expect(containsEffectiveViberevertRule("/.viberevert/\n")).toBe(true);
    expect(containsEffectiveViberevertRule("/.viberevert\n")).toBe(true);
  });

  it("recognizes rules with trailing whitespace (stripped per gitignore(5))", () => {
    expect(containsEffectiveViberevertRule(".viberevert/   \n")).toBe(true);
    expect(containsEffectiveViberevertRule(".viberevert\t\n")).toBe(true);
  });

  it("does NOT recognize leading-whitespace patterns as effective exact rules", () => {
    // gitignore(5): leading whitespace is part of the pattern. A line
    // with leading whitespace is a DIFFERENT pattern from one without
    // and would not match `.viberevert/` under Git's own parser.
    expect(containsEffectiveViberevertRule("   .viberevert/\n")).toBe(false);
    expect(containsEffectiveViberevertRule("\t.viberevert\n")).toBe(false);
  });

  it("returns true with unrelated entries surrounding the effective rule", () => {
    expect(containsEffectiveViberevertRule("node_modules/\ndist/\n.viberevert/\ncoverage/\n")).toBe(
      true,
    );
  });

  it("does NOT recognize broader user-authored patterns (locked limitation)", () => {
    expect(containsEffectiveViberevertRule(".vib*\n")).toBe(false);
    expect(containsEffectiveViberevertRule("**/.viberevert\n")).toBe(false);
    expect(containsEffectiveViberevertRule(".viberevert/manifest.json\n")).toBe(false);
  });

  it("returns false for a negation-only file (no positive rule ever set)", () => {
    expect(containsEffectiveViberevertRule("!.viberevert/\n")).toBe(false);
  });

  it("returns false when last relevant rule is a negation (last-match-wins)", () => {
    // The trust-critical edge case: an earlier positive followed by a
    // negation means `.viberevert/` is NOT ignored under git semantics.
    expect(containsEffectiveViberevertRule(".viberevert/\n!.viberevert/\n")).toBe(false);
    expect(containsEffectiveViberevertRule(".viberevert\n!.viberevert\n")).toBe(false);
  });

  it("returns true when last relevant rule is positive after an earlier negation", () => {
    expect(containsEffectiveViberevertRule("!.viberevert/\n.viberevert/\n")).toBe(true);
  });

  it("ignores negations of unrelated paths", () => {
    expect(containsEffectiveViberevertRule(".viberevert/\n!build/\n")).toBe(true);
  });

  it("handles CRLF line endings the same as LF", () => {
    expect(containsEffectiveViberevertRule("node_modules/\r\n.viberevert/\r\n")).toBe(true);
    expect(containsEffectiveViberevertRule(".viberevert/\r\n!.viberevert/\r\n")).toBe(false);
  });

  it("handles mixed CRLF and LF line endings", () => {
    expect(containsEffectiveViberevertRule("node_modules/\ndist/\r\n.viberevert/\n")).toBe(true);
  });

  it("handles multiple repeated positive rules", () => {
    expect(containsEffectiveViberevertRule(".viberevert/\n.viberevert\n/.viberevert/\n")).toBe(
      true,
    );
  });
});

// --- ensureViberevertGitignore (filesystem) -------------------------------

describe("ensureViberevertGitignore", () => {
  it("creates .gitignore with `.viberevert/` when none exists", async () => {
    const action = await ensureViberevertGitignore(workDir);
    expect(action).toBe("created");
    const content = await readFile(join(workDir, ".gitignore"), "utf8");
    expect(content).toBe(".viberevert/\n");
  });

  it("appends `.viberevert/` to an existing .gitignore without the rule", async () => {
    await writeFile(join(workDir, ".gitignore"), "node_modules/\ndist/\n", "utf8");
    const action = await ensureViberevertGitignore(workDir);
    expect(action).toBe("appended");
    const content = await readFile(join(workDir, ".gitignore"), "utf8");
    expect(content).toBe("node_modules/\ndist/\n.viberevert/\n");
  });

  it("is a no-op when the rule is already present", async () => {
    const original = "node_modules/\n.viberevert/\ndist/\n";
    await writeFile(join(workDir, ".gitignore"), original, "utf8");
    const action = await ensureViberevertGitignore(workDir);
    expect(action).toBe("already-present");
    const content = await readFile(join(workDir, ".gitignore"), "utf8");
    expect(content).toBe(original);
  });

  it("recognizes equivalent forms as already-present (no append)", async () => {
    // Each form, one fresh dir per case, asserting unchanged content.
    for (const form of [".viberevert", "/.viberevert/", "/.viberevert"]) {
      const subDir = await mkdtemp(join(workDir, "form-"));
      const original = `${form}\n`;
      await writeFile(join(subDir, ".gitignore"), original, "utf8");
      const action = await ensureViberevertGitignore(subDir);
      expect(action).toBe("already-present");
      expect(await readFile(join(subDir, ".gitignore"), "utf8")).toBe(original);
    }
  });

  it("appends a leading newline when the existing file lacks a trailing newline", async () => {
    await writeFile(join(workDir, ".gitignore"), "node_modules/", "utf8");
    const action = await ensureViberevertGitignore(workDir);
    expect(action).toBe("appended");
    const content = await readFile(join(workDir, ".gitignore"), "utf8");
    expect(content).toBe("node_modules/\n.viberevert/\n");
  });

  it("appends with CRLF when the existing file uses CRLF (preserves newline style)", async () => {
    await writeFile(join(workDir, ".gitignore"), "node_modules/\r\ndist/\r\n", "utf8");
    const action = await ensureViberevertGitignore(workDir);
    expect(action).toBe("appended");
    const content = await readFile(join(workDir, ".gitignore"), "utf8");
    expect(content).toBe("node_modules/\r\ndist/\r\n.viberevert/\r\n");
  });

  it("appends with CRLF + leading-CRLF when existing CRLF file lacks a trailing newline", async () => {
    await writeFile(join(workDir, ".gitignore"), "node_modules/\r\ndist/", "utf8");
    const action = await ensureViberevertGitignore(workDir);
    expect(action).toBe("appended");
    const content = await readFile(join(workDir, ".gitignore"), "utf8");
    expect(content).toBe("node_modules/\r\ndist/\r\n.viberevert/\r\n");
  });

  it("appends a fresh positive rule when the file ends with a negation (trust-critical)", async () => {
    // The trust-critical scenario: existing file has `!.viberevert/` as
    // the last relevant rule, so the directory is NOT currently ignored.
    // The helper MUST append a positive rule so the invariant is restored.
    await writeFile(
      join(workDir, ".gitignore"),
      "node_modules/\n.viberevert/\n!.viberevert/\n",
      "utf8",
    );
    const action = await ensureViberevertGitignore(workDir);
    expect(action).toBe("appended");
    const content = await readFile(join(workDir, ".gitignore"), "utf8");
    expect(content).toBe("node_modules/\n.viberevert/\n!.viberevert/\n.viberevert/\n");
  });

  it("appends to an empty .gitignore file (file exists, content is empty string)", async () => {
    await writeFile(join(workDir, ".gitignore"), "", "utf8");
    const action = await ensureViberevertGitignore(workDir);
    expect(action).toBe("appended");
    const content = await readFile(join(workDir, ".gitignore"), "utf8");
    // Empty existing content: no leading prefix needed; just the rule.
    expect(content).toBe(".viberevert/\n");
  });

  it("is idempotent: a second call after `created` is `already-present`", async () => {
    const first = await ensureViberevertGitignore(workDir);
    expect(first).toBe("created");
    const second = await ensureViberevertGitignore(workDir);
    expect(second).toBe("already-present");
    const content = await readFile(join(workDir, ".gitignore"), "utf8");
    expect(content).toBe(".viberevert/\n");
  });

  it("is idempotent: a second call after `appended` is `already-present`", async () => {
    await writeFile(join(workDir, ".gitignore"), "node_modules/\n", "utf8");
    const first = await ensureViberevertGitignore(workDir);
    expect(first).toBe("appended");
    const second = await ensureViberevertGitignore(workDir);
    expect(second).toBe("already-present");
    const content = await readFile(join(workDir, ".gitignore"), "utf8");
    expect(content).toBe("node_modules/\n.viberevert/\n");
  });
});
