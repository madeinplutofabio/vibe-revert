// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkGitignoreMentions, printGitignoreWarning } from "../src/gitignore-check.js";

import { createTempRepo } from "./helpers/temp-repo.js";

let tempRepo: Awaited<ReturnType<typeof createTempRepo>>;

beforeEach(async () => {
  tempRepo = await createTempRepo();
});

afterEach(async () => {
  await tempRepo.cleanup();
});

/**
 * Fake stderr that collects writes into an array. If throwOnWrite
 * is true, write() throws synchronously -- used to verify
 * printGitignoreWarning never propagates write errors.
 */
function makeFakeStderr(throwOnWrite = false): {
  writes: string[];
  stream: NodeJS.WritableStream;
} {
  const writes: string[] = [];
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      if (throwOnWrite) throw new Error("simulated stderr failure");
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { writes, stream };
}

describe("checkGitignoreMentions -- variant matches", () => {
  it("matches '.viberevert' (no slashes)", async () => {
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), ".viberevert\n");
    const result = await checkGitignoreMentions(tempRepo.repoRoot, ".viberevert/");
    expect(result.mentioned).toBe(true);
    expect(result.gitignorePath).toBe(join(tempRepo.repoRoot, ".gitignore"));
  });
  it("matches '.viberevert/' (trailing slash)", async () => {
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), ".viberevert/\n");
    const result = await checkGitignoreMentions(tempRepo.repoRoot, ".viberevert/");
    expect(result.mentioned).toBe(true);
  });
  it("matches '/.viberevert' (leading slash)", async () => {
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), "/.viberevert\n");
    const result = await checkGitignoreMentions(tempRepo.repoRoot, ".viberevert/");
    expect(result.mentioned).toBe(true);
  });
  it("matches '/.viberevert/' (both slashes)", async () => {
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), "/.viberevert/\n");
    const result = await checkGitignoreMentions(tempRepo.repoRoot, ".viberevert/");
    expect(result.mentioned).toBe(true);
  });
});

describe("checkGitignoreMentions -- non-matches", () => {
  it("returns false when .gitignore exists but pattern absent", async () => {
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), "node_modules\ndist\n");
    const result = await checkGitignoreMentions(tempRepo.repoRoot, ".viberevert/");
    expect(result.mentioned).toBe(false);
    expect(result.gitignorePath).toBe(join(tempRepo.repoRoot, ".gitignore"));
  });
  it("returns false when .gitignore is missing", async () => {
    const result = await checkGitignoreMentions(tempRepo.repoRoot, ".viberevert/");
    expect(result.mentioned).toBe(false);
    expect(result.gitignorePath).toBe(null);
  });
});

describe("checkGitignoreMentions -- comments and blanks", () => {
  it("ignores comment lines", async () => {
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), "# .viberevert/\nnode_modules\n");
    const result = await checkGitignoreMentions(tempRepo.repoRoot, ".viberevert/");
    expect(result.mentioned).toBe(false);
  });
  it("ignores blank lines while still finding pattern elsewhere", async () => {
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), "\n\n.viberevert/\n\n");
    const result = await checkGitignoreMentions(tempRepo.repoRoot, ".viberevert/");
    expect(result.mentioned).toBe(true);
  });
});

describe("checkGitignoreMentions -- negation lines", () => {
  it("ignores negation lines (treats as NOT mentioned)", async () => {
    // `!.viberevert/` un-ignores -- which is exactly the situation
    // the warning exists to flag. Treating negation as "mentioned"
    // would suppress a legitimate warning.
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), "!.viberevert/\n");
    const result = await checkGitignoreMentions(tempRepo.repoRoot, ".viberevert/");
    expect(result.mentioned).toBe(false);
  });
});

describe("checkGitignoreMentions -- empty pattern", () => {
  it("returns false for empty pattern", async () => {
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), ".viberevert/\n");
    const result = await checkGitignoreMentions(tempRepo.repoRoot, "");
    expect(result.mentioned).toBe(false);
  });
  it("returns false for whitespace-only pattern", async () => {
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), ".viberevert/\n");
    const result = await checkGitignoreMentions(tempRepo.repoRoot, "   ");
    expect(result.mentioned).toBe(false);
  });
  it("returns false for slash-only pattern", async () => {
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), ".viberevert/\n");
    const result = await checkGitignoreMentions(tempRepo.repoRoot, "//");
    expect(result.mentioned).toBe(false);
  });
});

describe("checkGitignoreMentions -- line endings", () => {
  it("tolerates CRLF-terminated lines", async () => {
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), ".viberevert/\r\nnode_modules\r\n");
    const result = await checkGitignoreMentions(tempRepo.repoRoot, ".viberevert/");
    expect(result.mentioned).toBe(true);
  });
});

describe("checkGitignoreMentions -- read errors return safe false", () => {
  it("returns safe false when .gitignore path is a directory", async () => {
    // Portable read-failure simulation: a directory at the
    // .gitignore path causes readFile to fail (EISDIR on POSIX,
    // similar errors on Windows). The contract is "any read failure
    // returns safe false"; the exact errno is not part of the
    // contract.
    await mkdir(join(tempRepo.repoRoot, ".gitignore"));
    const result = await checkGitignoreMentions(tempRepo.repoRoot, ".viberevert/");
    expect(result.mentioned).toBe(false);
    expect(result.gitignorePath).toBe(null);
  });
});

describe("printGitignoreWarning", () => {
  it("writes warning content to stderr when .viberevert/ is not mentioned", async () => {
    // Assert on combined output content, NOT on call count. The
    // contract is "warning content reaches stderr"; a future
    // implementation that writes one multi-line string instead of
    // six separate write() calls would be behaviorally identical
    // and must not break this test.
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), "node_modules\n");
    const { writes, stream } = makeFakeStderr();
    await printGitignoreWarning(stream, tempRepo.repoRoot);
    const output = writes.join("");
    expect(output).toContain(".viberevert/");
    expect(output).toContain("not in .gitignore");
    expect(output.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });
  it("writes 0 times when .viberevert/ IS mentioned", async () => {
    // The "mentioned" case's contract IS "no output", so asserting
    // writes.length === 0 is the contract, not a coupling.
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), ".viberevert/\n");
    const { writes, stream } = makeFakeStderr();
    await printGitignoreWarning(stream, tempRepo.repoRoot);
    expect(writes.length).toBe(0);
  });
  it("writes warning content to stderr when .gitignore is missing entirely", async () => {
    const { writes, stream } = makeFakeStderr();
    await printGitignoreWarning(stream, tempRepo.repoRoot);
    const output = writes.join("");
    expect(output).toContain(".viberevert/");
    expect(output.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });
  it("never throws even if stream.write() throws synchronously", async () => {
    await writeFile(join(tempRepo.repoRoot, ".gitignore"), "node_modules\n");
    const { stream } = makeFakeStderr(true);
    await expect(printGitignoreWarning(stream, tempRepo.repoRoot)).resolves.toBeUndefined();
  });
});
