// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// End-latency characterization (M 0.8.0 step 15).
//
// CHARACTERIZATION, NOT A GATE. This script produces numbers. It asserts
// nothing, fails on nothing slow, and is deliberately not wired into CI. The
// milestone plan is explicit that promoting it to pass/fail would need a
// threshold established up front rather than invented from whatever the first
// run happened to measure, and no such threshold exists.
//
// =============================================================================
// What is being measured, and why this number
// =============================================================================
//
// `viberevert end` captures the session's contribution, and to find the
// candidate set it takes a raw SHA-256 of every present tracked regular file,
// then does it again at the coherence fence. That is the largest single latency
// risk the milestone introduced: it is proportional to repository content
// rather than to what the session changed, so a session that edited one file in
// a large repository still pays for the whole inventory.
//
// It is precedented rather than novel. `viberevert start` already hashes the
// same set to build the checkpoint. Measuring both is what makes the comparison
// meaningful: if `end` is roughly the same order as `start`, the cost is the
// one the tool already had, and the interesting number is the multiple.
//
// =============================================================================
// Method
// =============================================================================
//
// For each fixture size: build a real git repository of N tracked files, run
// `viberevert init`, commit, then repeat a start / modify / end cycle R times,
// timing `start` and `end` separately. Each cycle is a genuine session, so no
// state is reused between runs and every `end` pays full price.
//
// Reported per size: file count, total bytes, and for each command the median
// and the tail. Median rather than mean because a single scheduler stall or
// antivirus scan would drag a mean around and say nothing about typical cost.
// The tail is reported precisely because it is the part a mean hides.
//
// Run count defaults low. This is a characterization on one machine, not a
// statistical study, and the honest use of the output is an order of magnitude.
//
// Usage:
//   pnpm build && pnpm tsx scripts/bench-end-latency.ts
//   pnpm tsx scripts/bench-end-latency.ts --sizes 200,1000 --runs 3

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "packages", "cli", "dist", "index.js");

/** ~1 KiB each, so total bytes scale predictably with the file count. */
const FILE_BODY = `${"x".repeat(1000)}\n`;

interface Options {
  readonly sizes: readonly number[];
  readonly runs: number;
}

function parseArgs(argv: readonly string[]): Options {
  const read = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const sizes = (read("--sizes") ?? "200,1000,4000")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10));
  if (sizes.some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new Error("--sizes must be a comma-separated list of positive integers");
  }
  const runs = Number.parseInt(read("--runs") ?? "5", 10);
  if (!Number.isFinite(runs) || runs <= 0) {
    throw new Error("--runs must be a positive integer");
  }
  return { sizes, runs };
}

const git = async (cwd: string, args: readonly string[]): Promise<void> => {
  await execFileAsync("git", [...args], { cwd, windowsHide: true, maxBuffer: 1 << 26 });
};

/**
 * Run the built CLI and return how long it took, in milliseconds.
 *
 * The BUILT entry point on purpose: an in-process call would measure the
 * library rather than the command a user runs, and would omit process start,
 * module load, and config resolution, which are part of the latency being
 * characterized.
 */
async function timeCli(cwd: string, args: readonly string[]): Promise<number> {
  const started = performance.now();
  await execFileAsync(process.execPath, [CLI, ...args], {
    cwd,
    windowsHide: true,
    maxBuffer: 1 << 26,
  });
  return performance.now() - started;
}

/** Nearest-rank percentile over a copy, so the caller's array is untouched. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

const ms = (n: number): string => `${n.toFixed(0)} ms`;

interface SizeResult {
  readonly files: number;
  readonly bytes: number;
  readonly start: readonly number[];
  readonly end: readonly number[];
}

async function measureSize(files: number, runs: number): Promise<SizeResult> {
  const parent = await mkdtemp(join(tmpdir(), "viberevert-bench-"));
  const repo = join(parent, "repo");
  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "bench@example.com"]);
    await git(repo, ["config", "user.name", "Bench"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await git(repo, ["config", "core.autocrlf", "false"]);

    let bytes = 0;
    for (let i = 0; i < files; i += 1) {
      const body = `// file ${i}\n${FILE_BODY}`;
      bytes += Buffer.byteLength(body);
      await writeFile(join(repo, "src", `f${i}.ts`), body);
    }

    await execFileAsync(process.execPath, [CLI, "init"], { cwd: repo, windowsHide: true });
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "bench baseline"]);

    const startTimes: number[] = [];
    const endTimes: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      startTimes.push(await timeCli(repo, ["start", "--task", `bench run ${run}`]));
      // A DELIBERATELY TINY edit. The point of the measurement is that `end`
      // pays for the whole inventory regardless of how little changed, so a
      // large edit would hide the very cost being characterized.
      await writeFile(join(repo, "src", "f0.ts"), `// touched on run ${run}\n${FILE_BODY}`);
      endTimes.push(await timeCli(repo, ["end"]));
    }

    return { files, bytes, start: startTimes, end: endTimes };
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function reportEnvironment(): void {
  const cpu = cpus();
  console.log("## Environment\n");
  console.log(`- platform: ${process.platform} ${process.arch}`);
  console.log(`- node: ${process.version}`);
  console.log(`- cpu: ${cpu[0]?.model ?? "unknown"} (${cpu.length} logical)`);
  console.log(`- memory: ${(totalmem() / 1024 ** 3).toFixed(1)} GiB`);
  console.log(`- measured: ${new Date().toISOString()}`);
  console.log("");
}

async function main(): Promise<void> {
  const { sizes, runs } = parseArgs(process.argv.slice(2));

  reportEnvironment();
  console.log(`## Results (${runs} runs per size)\n`);
  console.log(
    "| Tracked files | Total bytes | start median | start p95 | end median | end p95 | end/start |",
  );
  console.log("|---:|---:|---:|---:|---:|---:|---:|");

  for (const size of sizes) {
    const result = await measureSize(size, runs);
    const startMedian = percentile(result.start, 50);
    const endMedian = percentile(result.end, 50);
    console.log(
      `| ${result.files} | ${(result.bytes / 1024).toFixed(0)} KiB | ${ms(startMedian)} | ` +
        `${ms(percentile(result.start, 95))} | ${ms(endMedian)} | ` +
        `${ms(percentile(result.end, 95))} | ${(endMedian / startMedian).toFixed(2)}x |`,
    );
  }

  console.log("\nCharacterization only. No threshold is enforced anywhere.");
}

await main();
