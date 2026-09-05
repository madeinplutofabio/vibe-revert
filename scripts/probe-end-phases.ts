// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Bounded phase attribution for `viberevert end` latency (M 0.8.0 step 15
// follow-up).
//
// A DIAGNOSTIC, not a benchmark and not a test. `scripts/bench-end-latency.ts`
// measures what a user waits for; this answers the next question, which is
// where that time goes. Neither is wired into CI and neither asserts anything.
//
// It imports `withCheckpointOracle` from the git package's SOURCE rather than
// its barrel, because the barrel deliberately does not export it: the oracle is
// internal, and a guard test asserts it stays that way. Reaching into the source
// from a throwaway diagnostic is the honest way to measure a private function
// without widening a public surface to suit a script.
//
// The oracle is measured with an EMPTY callback, so the number is exactly the
// lifecycle cost: create a scratch worktree at the captured HEAD, restore the
// checkpoint into it, then tear it down. Subtracting that from the full `end`
// wall time bounds everything else without instrumenting production code at
// all. If the lifecycle dominates, the two raw inventories are a side issue and
// no finer instrumentation is warranted.
//
// Usage:
//   pnpm build && pnpm tsx scripts/probe-end-phases.ts --sizes "200,1000,4000"

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadCheckpoint } from "../packages/git/src/checkpoint.js";
import { withCheckpointOracle } from "../packages/git/src/checkpoint-oracle.js";
import { restoreCheckpoint } from "../packages/git/src/restore.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
const FILE_BODY = `${"x".repeat(1000)}\n`;

const git = async (cwd: string, args: readonly string[]): Promise<void> => {
  await execFileAsync("git", [...args], { cwd, windowsHide: true, maxBuffer: 1 << 26 });
};

async function timeCli(cwd: string, args: readonly string[]): Promise<number> {
  const started = performance.now();
  await execFileAsync(process.execPath, [CLI, ...args], {
    cwd,
    windowsHide: true,
    maxBuffer: 1 << 26,
  });
  return performance.now() - started;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN;
};

const ms = (n: number): string => `${n.toFixed(0)} ms`;
const pct = (part: number, whole: number): string => `${((part / whole) * 100).toFixed(0)}%`;

interface Phase {
  readonly files: number;
  readonly end: number;
  readonly oracle: number;
  readonly start: number;
  /** The three lifecycle steps, timed separately. See `splitOracle`. */
  readonly worktreeAdd: number;
  readonly restore: number;
  readonly teardown: number;
}

/**
 * Time the oracle's three steps individually.
 *
 * REPLICATES the sequence in `withCheckpointOracle` rather than instrumenting
 * it, using the same primitives it calls. That is a real risk of divergence, so
 * the caller checks the sum against the measured lifecycle: if they disagree,
 * this split describes something other than what production does and must not
 * be trusted.
 */
async function splitOracle(
  repo: string,
  checkpointDir: string,
): Promise<{ worktreeAdd: number; restore: number; teardown: number }> {
  const manifest = await loadCheckpoint(checkpointDir);
  const tempRoot = await mkdtemp(join(tmpdir(), "viberevert-probe-split-"));
  const worktreePath = join(tempRoot, "worktree");

  const t0 = performance.now();
  await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, manifest.git.head_sha], {
    cwd: repo,
    windowsHide: true,
    maxBuffer: 1 << 26,
  });
  const t1 = performance.now();

  await restoreCheckpoint(checkpointDir, {
    repoRoot: worktreePath,
    rollbackExcludePatterns: manifest.untracked.exclude_patterns ?? [],
  });
  const t2 = performance.now();

  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repo,
    windowsHide: true,
    maxBuffer: 1 << 26,
  }).catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  const t3 = performance.now();

  return { worktreeAdd: t1 - t0, restore: t2 - t1, teardown: t3 - t2 };
}

async function measure(files: number, runs: number): Promise<Phase> {
  const parent = await mkdtemp(join(tmpdir(), "viberevert-probe-"));
  const repo = join(parent, "repo");
  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "probe@example.com"]);
    await git(repo, ["config", "user.name", "Probe"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await git(repo, ["config", "core.autocrlf", "false"]);

    for (let i = 0; i < files; i += 1) {
      await writeFile(join(repo, "src", `f${i}.ts`), `// file ${i}\n${FILE_BODY}`);
    }
    await execFileAsync(process.execPath, [CLI, "init"], { cwd: repo, windowsHide: true });
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "probe baseline"]);

    const startTimes: number[] = [];
    const endTimes: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      startTimes.push(await timeCli(repo, ["start", "--task", `probe ${run}`]));
      await writeFile(join(repo, "src", "f0.ts"), `// touched ${run}\n${FILE_BODY}`);
      endTimes.push(await timeCli(repo, ["end"]));
    }

    // The session checkpoint `end` materializes. Any completed session's
    // checkpoint is the same shape, so the last one is representative.
    const sessionsDir = join(repo, ".viberevert", "sessions");
    const { readdir } = await import("node:fs/promises");
    const sessions = (await readdir(sessionsDir)).sort();
    const checkpointDir = join(sessionsDir, sessions[sessions.length - 1] as string, "checkpoint");

    const oracleTimes: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      const t0 = performance.now();
      await withCheckpointOracle<null>(repo, checkpointDir, {
        tempDirPrefix: "viberevert-probe-oracle-",
        // EMPTY on purpose: this isolates create plus cleanup and nothing else.
        run: async () => null,
      });
      oracleTimes.push(performance.now() - t0);
    }

    const adds: number[] = [];
    const restores: number[] = [];
    const teardowns: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      const split = await splitOracle(repo, checkpointDir);
      adds.push(split.worktreeAdd);
      restores.push(split.restore);
      teardowns.push(split.teardown);
    }

    return {
      files,
      end: median(endTimes),
      oracle: median(oracleTimes),
      start: median(startTimes),
      worktreeAdd: median(adds),
      restore: median(restores),
      teardown: median(teardowns),
    };
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const sizes = (read("--sizes") ?? "200,1000,4000")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10));
  const runs = Number.parseInt(read("--runs") ?? "3", 10);

  console.log(`platform ${process.platform} ${process.arch}, node ${process.version}`);
  console.log(`cpu ${cpus()[0]?.model ?? "unknown"} (${cpus().length} logical)`);
  console.log(`measured ${new Date().toISOString()}, ${runs} runs per size\n`);

  console.log("| Files | end median | oracle lifecycle | oracle share | everything else |");
  console.log("|---:|---:|---:|---:|---:|");
  const all: Phase[] = [];
  for (const size of sizes) {
    const p = await measure(size, runs);
    all.push(p);
    console.log(
      `| ${p.files} | ${ms(p.end)} | ${ms(p.oracle)} | ${pct(p.oracle, p.end)} | ${ms(p.end - p.oracle)} |`,
    );
  }

  console.log("\n| Files | worktree add | restoreCheckpoint | teardown | split sum vs lifecycle |");
  console.log("|---:|---:|---:|---:|---:|");
  for (const p of all) {
    const sum = p.worktreeAdd + p.restore + p.teardown;
    console.log(
      `| ${p.files} | ${ms(p.worktreeAdd)} | ${ms(p.restore)} | ${ms(p.teardown)} | ` +
        `${ms(sum)} vs ${ms(p.oracle)} (${pct(sum, p.oracle)}) |`,
    );
  }

  console.log("\nDiagnostic only. Nothing here is asserted or enforced.");
}

await main();
