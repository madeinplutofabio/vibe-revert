// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Decision 7 Stage A operator harness (operator tooling; NOT product code, NOT a
// Vitest test). Owns the entire process lifecycle -- CLI dispatch, spawning, the
// SIGINT handler, prompts, cleanup, the three-axis experiment classification, the
// harness state machine, and process exit -- and imports scripts/decision7/
// decision7-lib.mjs for every deterministic validation/serialization primitive.
//
// Subcommands: attest | preflight | run. Exit codes: 0 sealed complete; 2
// CLI/preflight failure (no experiment); 3 experiment recorded but sealing/cleanup
// incomplete; 4 unexpected internal failure after allocation. Exit 0 means evidence
// was safely recorded, never "the lifecycle passed". Eligibility is a MATRIX-level
// conclusion (summarize-matrix.mjs), never asserted by a single run. The token is
// carried only by the token-bound JSONL event streams (not metadata/result JSON);
// it binds events to one run and is not secret after the run.

import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, release, tmpdir, version } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  ATTESTATION_SCHEMA_VERSION,
  assertAttestedBuildCommand,
  assertRealDirectory,
  assertRealRegularFile,
  assertSafeEvidenceDir,
  assertStateTransition,
  assertUsableInterpolatedPath,
  assertValidAttestation,
  buildWrapperBytes,
  CANDIDATE_WRAPPER_COMPLETION,
  computeEligibilityConstraints,
  computeManifestText,
  Decision7Error,
  EXPERIMENT_VALIDITY,
  finalizeAttestation,
  HARNESS_IMPLEMENTATION_VERSION,
  INTEGRITY_STATUS,
  INTERACTIVE_DELIVERY,
  LIVENESS,
  MATRIX_DEFINITION,
  MATRIX_DEFINITION_VERSION,
  matrixCaseId,
  PROTOCOL_VERSION,
  parseCliArgs,
  parseJsonl,
  REQUIRED_REPETITIONS,
  RESULT_SCHEMA_VERSION,
  readFileBounded,
  readJsonFile,
  SHELL_HOSTS,
  sha256File,
  sha256String,
  survivalFromLiveness,
  TERMINAL_HOSTS,
  validateAttestationFreshness,
  validateAttestationIdentity,
  validateFixtureEvents,
  verifyManifest,
  verifyWrapperBytes,
  writeEvidenceAtomic,
  writeFileAtomic,
} from "./decision7-lib.mjs";
import { buildConsoleTemplate, buildOperatorTemplate } from "./operator-template.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const HARNESS_PATH = fileURLToPath(import.meta.url);
const LIB_PATH = fileURLToPath(new URL("./decision7-lib.mjs", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("./fixture-agent.mjs", import.meta.url));
const SRC_PATH = join(
  REPO_ROOT,
  "packages",
  "cli-commands",
  "src",
  "commands",
  "command-launcher.ts",
);
const DIST_URL = new URL(
  "../../packages/cli-commands/dist/commands/command-launcher.js",
  import.meta.url,
);
const DIST_PATH = fileURLToPath(DIST_URL);
const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.windir ?? null;

const EXIT_OK = 0;
const EXIT_PREFLIGHT = 2;
const EXIT_INCOMPLETE = 3;
const EXIT_INTERNAL = 4;

const SHORT_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 600_000;
const SHORT_MAXBUFFER = 1024 * 1024;
const BUILD_MAXBUFFER = 16 * 1024 * 1024;

const PNPM_BUILD_TAIL = "--filter @viberevert/cli-commands... build";
const PNPM_VERSION_TAIL = "--version";
const PNPM_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ALLOWED_PNPM_TAILS = new Set([PNPM_BUILD_TAIL, PNPM_VERSION_TAIL]);
const FIXTURE_REQUESTED_COMMAND = "decision7-fixture";

const MAX_EVENT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_HARNESS_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_EVENTS = 20_000;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

const POLL_MS = 50;
const STABLE_READ_INTERVAL_MS = 100;
const STABLE_READ_REQUIRED_INTERVALS = 2;
const STABLE_READ_MAX_ATTEMPTS = 20;
const PROBE_DEAD_ATTEMPTS = 10;
const PROBE_DEAD_INTERVAL_MS = 50;

const ATTEST_SCHEMA = {
  "evidence-dir": { type: "string", default: ".tmp/decision7-evidence" },
  "attestation-dir": { type: "string" },
  "allow-dirty": { type: "boolean" },
};

const RUN_SCHEMA = {
  "attestation-dir": { type: "string", required: true },
  "terminal-host": { type: "enum", values: TERMINAL_HOSTS, required: true },
  "shell-host": { type: "enum", values: SHELL_HOSTS, required: true },
  repetition: { type: "integer", min: 1, max: REQUIRED_REPETITIONS, required: true },
  "host-label": { type: "string", required: true },
  "evidence-dir": { type: "string", default: ".tmp/decision7-evidence" },
  "observation-seconds": { type: "integer", min: 1, default: 10 },
  "operator-response-seconds": { type: "integer", min: 1, default: 60 },
  "readiness-seconds": { type: "integer", min: 1, default: 15 },
  "heartbeat-ms": { type: "integer", min: 1, default: 500 },
  "allow-dirty": { type: "boolean" },
  "allow-noninteractive": { type: "boolean" },
  "new-attempt": { type: "boolean" },
};
// `run` deliberately omits --allow-attestation-mismatch (parseCliArgs rejects it as unknown).
const PREFLIGHT_SCHEMA = { ...RUN_SCHEMA, "allow-attestation-mismatch": { type: "boolean" } };

const USAGE = [
  "usage: operator-harness.mjs <attest|preflight|run> [options]  (Windows only)",
  "",
  "attest    [--evidence-dir <p>] [--attestation-dir <p>] [--allow-dirty]",
  "preflight/run:",
  "  --attestation-dir <p> --terminal-host <windows-terminal|conhost|vscode-integrated|other>",
  "  --shell-host <powershell|cmd|other> --repetition <1..3> --host-label <text>",
  "  [--evidence-dir <p>] [--observation-seconds n] [--operator-response-seconds n]",
  "  [--readiness-seconds n] [--heartbeat-ms n] [--allow-dirty] [--allow-noninteractive]",
  "  [--new-attempt]   (preflight also accepts --allow-attestation-mismatch)",
  "",
].join("\n");

function fail(message, code = EXIT_PREFLIGHT) {
  process.stderr.write(`decision7 harness: ${message}\n`);
  process.exit(code);
}

function out(text) {
  process.stdout.write(`${text}\n`);
}

function nowStamp() {
  return { ts: new Date().toISOString(), monotonicMs: performance.now() };
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function isAbsoluteWindowsPath(p) {
  return /^[a-zA-Z]:\\/.test(p) || p.startsWith("\\\\");
}

// Single bounded child invocation: per-op timeout + maxBuffer, distinct result
// fields. `clean` means no spawn/timeout/buffer error and exit 0. A timeout or a
// maxBuffer breach is a FAILED operation, not a successful truncated one.
function boundedSpawn(executable, args, opts) {
  const start = performance.now();
  const r = spawnSync(executable, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: opts.windowsVerbatimArguments === true,
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer,
  });
  const durationMs = performance.now() - start;
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  const errorCode = r.error?.code ?? null;
  const errorMessage = r.error?.message ?? null;
  const timedOut = errorCode === "ETIMEDOUT";
  const bufferExceeded =
    errorCode === "ENOBUFS" ||
    (typeof errorMessage === "string" && /maxBuffer/i.test(errorMessage));
  const clean = !r.error && r.status === 0;
  return {
    clean,
    timedOut,
    bufferExceeded,
    exitCode: r.status ?? null,
    signal: r.signal ?? null,
    errorCode,
    errorMessage,
    durationMs,
    stdout,
    stderr,
  };
}

function gitCapture(gitArgs) {
  const r = boundedSpawn("git", gitArgs, {
    timeoutMs: SHORT_TIMEOUT_MS,
    maxBuffer: SHORT_MAXBUFFER,
  });
  return r.clean ? r.stdout.trim() : null;
}

function gitDirty() {
  const porcelain = gitCapture(["status", "--porcelain"]);
  return porcelain === null ? null : porcelain.length > 0;
}

// Native taskkill.exe from %SystemRoot% only, with the same absolute drive/UNC
// contract as where.exe. No PATH fallback: if it cannot be validated, destructive
// cleanup is unavailable and therefore incomplete.
const TASKKILL = (() => {
  if (SYSTEM_ROOT === null || !isAbsoluteWindowsPath(SYSTEM_ROOT)) {
    return { available: false, reason: "invalid_or_missing_system_root" };
  }
  try {
    const candidate = join(SYSTEM_ROOT, "System32", "taskkill.exe");
    if (!isAbsoluteWindowsPath(candidate)) {
      return { available: false, reason: "invalid_native_taskkill_path" };
    }
    const { realPath } = assertRealRegularFile(candidate, "taskkill.exe");
    if (basename(realPath).toLowerCase() !== "taskkill.exe") {
      return { available: false, reason: "taskkill_basename_mismatch" };
    }
    return { available: true, realPath };
  } catch (error) {
    return { available: false, reason: error?.message ?? "native_taskkill_unavailable" };
  }
})();

// Resolve + reparse-check ComSpec; invoke and record the canonical real path.
function resolveComSpec() {
  const declared = process.env.ComSpec ?? process.env.COMSPEC;
  if (!declared || declared.length === 0) {
    throw new Decision7Error("comspec", "ComSpec is not set");
  }
  if (!isAbsolute(declared) || !isAbsoluteWindowsPath(declared)) {
    throw new Decision7Error(
      "comspec",
      `ComSpec is not an absolute drive or UNC path: ${declared}`,
    );
  }
  const { declaredPath, realPath } = assertRealRegularFile(declared, "ComSpec");
  if (basename(realPath).toLowerCase() !== "cmd.exe") {
    throw new Decision7Error("comspec", `ComSpec basename is not cmd.exe: ${realPath}`);
  }
  return { declaredPath, realPath, sha256: sha256File(realPath) };
}

// Resolve the native where.exe from %SystemRoot% (never `where` via PATH, never a
// fabricated Windows root).
function resolveWhereExe() {
  if (SYSTEM_ROOT === null) {
    throw new Decision7Error(
      "where",
      "neither SystemRoot nor windir is set; cannot locate where.exe",
    );
  }
  const wherePath = join(SYSTEM_ROOT, "System32", "where.exe");
  if (!isAbsoluteWindowsPath(wherePath)) {
    throw new Decision7Error(
      "where",
      `where.exe path is not an absolute drive or UNC path: ${wherePath}`,
    );
  }
  const { declaredPath, realPath } = assertRealRegularFile(wherePath, "where.exe");
  if (basename(realPath).toLowerCase() !== "where.exe") {
    throw new Decision7Error("where", `resolved where.exe basename mismatch: ${realPath}`);
  }
  return {
    declaredPath,
    realPath,
    systemRootSource: process.env.SystemRoot ? "SystemRoot" : "windir",
  };
}

// Resolve pnpm.cmd via the native where.exe. Requires a clean where.exe run and at
// least one candidate; validates EVERY distinct raw candidate (absolute, ordinary
// regular file, named pnpm.cmd) and refuses on any anomaly rather than selecting
// around it; then canonical, case-insensitive dedup must leave exactly one path.
function resolvePnpmShim(whereRealPath) {
  const r = boundedSpawn(whereRealPath, ["pnpm.cmd"], {
    timeoutMs: SHORT_TIMEOUT_MS,
    maxBuffer: SHORT_MAXBUFFER,
  });
  if (!r.clean) {
    throw new Decision7Error(
      "pnpm-resolve",
      `where.exe failed (timedOut=${r.timedOut} bufferExceeded=${r.bufferExceeded} exit=${r.exitCode} error=${r.errorCode})`,
      { stdout: r.stdout, stderr: r.stderr },
    );
  }
  const rawCandidates = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (rawCandidates.length === 0) {
    throw new Decision7Error("pnpm-resolve", "where.exe returned no pnpm.cmd candidates");
  }
  const distinctRaw = new Map();
  for (const candidate of rawCandidates) {
    if (!distinctRaw.has(candidate.toLowerCase())) {
      distinctRaw.set(candidate.toLowerCase(), candidate);
    }
  }
  const validations = [];
  for (const candidate of distinctRaw.values()) {
    if (!isAbsoluteWindowsPath(candidate)) {
      validations.push({ raw: candidate, valid: false, reason: "not_absolute" });
      continue;
    }
    let info;
    try {
      info = assertRealRegularFile(candidate, "pnpm.cmd candidate");
    } catch (err) {
      validations.push({ raw: candidate, valid: false, reason: err?.message ?? "invalid" });
      continue;
    }
    if (basename(info.realPath).toLowerCase() !== "pnpm.cmd") {
      validations.push({
        raw: candidate,
        valid: false,
        reason: "wrong_basename",
        realPath: info.realPath,
      });
      continue;
    }
    validations.push({ raw: candidate, valid: true, realPath: info.realPath });
  }
  const invalid = validations.filter((v) => !v.valid);
  if (invalid.length > 0) {
    throw new Decision7Error(
      "pnpm-resolve",
      `where.exe returned invalid pnpm.cmd candidate(s): ${JSON.stringify(invalid)}`,
      { validations, rawCandidates },
    );
  }
  const realPaths = new Map();
  for (const v of validations) {
    realPaths.set(v.realPath.toLowerCase(), v.realPath);
  }
  const selected = [...realPaths.values()];
  if (selected.length !== 1) {
    throw new Decision7Error(
      "pnpm-resolve",
      `expected exactly one distinct pnpm.cmd after canonicalization, found ${selected.length}`,
      { validations, rawCandidates },
    );
  }
  const realPath = selected[0];
  assertUsableInterpolatedPath(realPath, "pnpm");
  return { realPath, sha256: sha256File(realPath), rawCandidates };
}

// Fixed outer-quoted bounded command line for a validated pnpm.cmd + one of the two
// allowlisted constant tails: `""<pnpm>" <tail>"`. Exact tail membership, not a
// general validator.
function buildBoundedPnpmLine(pnpmPath, tail) {
  if (!ALLOWED_PNPM_TAILS.has(tail)) {
    throw new Decision7Error("pnpm-tail", `unsupported pnpm command tail: ${JSON.stringify(tail)}`);
  }
  return `""${pnpmPath}" ${tail}"`;
}

function capturePnpmVersion(comSpecPath, pnpmPath, cwd) {
  const line = buildBoundedPnpmLine(pnpmPath, PNPM_VERSION_TAIL);
  const r = boundedSpawn(comSpecPath, ["/d", "/v:off", "/s", "/c", line], {
    cwd,
    timeoutMs: SHORT_TIMEOUT_MS,
    maxBuffer: SHORT_MAXBUFFER,
    windowsVerbatimArguments: true,
  });
  if (!r.clean) {
    throw new Decision7Error(
      "pnpm-version",
      `pnpm --version failed (timedOut=${r.timedOut} exit=${r.exitCode} error=${r.errorCode})`,
    );
  }
  const lines = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length !== 1 || !PNPM_VERSION_RE.test(lines[0])) {
    throw new Decision7Error(
      "pnpm-version",
      `unexpected pnpm --version output: ${JSON.stringify(lines)}`,
    );
  }
  return lines[0];
}

// Repository/worktree identity: real paths for the checkout root, git toplevel, and
// git common dir (relative --git-common-dir normalized against the repo root).
function gatherRepoIdentity() {
  const { declaredPath: repoRootDeclaredPath, realPath: repoRootRealPath } = assertRealDirectory(
    REPO_ROOT,
    "repo root",
  );
  const gitShowToplevel = gitCapture(["rev-parse", "--show-toplevel"]);
  if (gitShowToplevel === null) {
    throw new Decision7Error("git", "git rev-parse --show-toplevel failed");
  }
  const { realPath: gitShowToplevelRealPath } = assertRealDirectory(
    gitShowToplevel,
    "git toplevel",
  );
  const commonRaw = gitCapture(["rev-parse", "--git-common-dir"]);
  if (commonRaw === null) {
    throw new Decision7Error("git", "git rev-parse --git-common-dir failed");
  }
  const gitCommonDir = isAbsolute(commonRaw) ? commonRaw : resolve(REPO_ROOT, commonRaw);
  const { realPath: gitCommonDirRealPath } = assertRealDirectory(gitCommonDir, "git common dir");
  return {
    repoRootDeclaredPath,
    repoRootRealPath,
    gitShowToplevel,
    gitShowToplevelRealPath,
    gitCommonDir,
    gitCommonDirRealPath,
  };
}

function gatherMachine() {
  return { computerName: hostname(), osVersion: version(), osBuild: release() };
}

// Reparse-check + hash a critical file, recording declared/real paths.
function hashCritical(path, label) {
  const { declaredPath, realPath } = assertRealRegularFile(path, label);
  return { declaredPath, realPath, sha256: sha256File(realPath) };
}

async function importPlanner() {
  if (!existsSync(DIST_PATH)) {
    throw new Decision7Error(
      "planner",
      `compiled launcher not found: ${DIST_PATH}. Run \`attest\` first.`,
    );
  }
  let mod;
  try {
    mod = await import(DIST_URL.href);
  } catch (err) {
    throw new Decision7Error(
      "planner",
      `failed to import compiled launcher: ${err?.message ?? err}`,
    );
  }
  if (typeof mod.buildCommandLaunchPlan !== "function") {
    throw new Decision7Error("planner", "compiled launcher does not export buildCommandLaunchPlan");
  }
  return mod.buildCommandLaunchPlan;
}

// Generate the throwaway/real `.cmd` wrapper through the library helpers, byte-verified.
function generateWrapper(tempDir) {
  const wrapperPath = join(tempDir, "decision7-fixture.cmd");
  const wrapperBytes = buildWrapperBytes(process.execPath, FIXTURE_PATH);
  writeFileSync(wrapperPath, wrapperBytes, "utf8");
  const wrapperSha256 = verifyWrapperBytes(wrapperPath, wrapperBytes);
  return { wrapperPath, wrapperSha256 };
}

// Exact no-argument mediation shape for THIS fixture (derived from the product's
// encodeCmdCommandLine/quoteForCmd: a validated wrapper never ends in a backslash,
// so the candidate line is `"<wrapper>"` and the plan wraps it once more).
function assertExactPlan(planResult, wrapperPath, comSpecPath) {
  if (!planResult.ok) {
    throw new Decision7Error(
      "plan",
      `launch planner rejected the fixture: ${JSON.stringify(planResult)}`,
    );
  }
  const plan = planResult.plan;
  const expectedArgs = ["/d", "/v:off", "/s", "/c", `""${wrapperPath}""`];
  const ok =
    plan.kind === "windows-cmd" &&
    plan.strategy === "windows-cmd-bounded-v1" &&
    plan.command === comSpecPath &&
    plan.shell === false &&
    plan.windowsVerbatimArguments === true &&
    plan.resolvedTarget === wrapperPath &&
    plan.requestedCommand === FIXTURE_REQUESTED_COMMAND &&
    Array.isArray(plan.args) &&
    plan.args.length === expectedArgs.length &&
    expectedArgs.every((a, i) => plan.args[i] === a);
  if (!ok) {
    throw new Decision7Error(
      "plan",
      `plan is not the exact Decision 7 mediation shape: ${JSON.stringify(plan)}`,
    );
  }
  return plan;
}

// Non-spawning validation that the just-built compiled planner produces the exact
// bound mediation shape for a validated throwaway wrapper. Removing the temp dir is
// mandatory for an eligible attestation.
function plannerSanityCheck(buildCommandLaunchPlan, comSpecPath) {
  const tempDir = mkdtempSync(join(tmpdir(), "decision7-attest-"));
  let primaryError = null;
  try {
    const { wrapperPath } = generateWrapper(tempDir);
    const planResult = buildCommandLaunchPlan({
      platform: process.platform,
      resolvedTarget: wrapperPath,
      requestedCommand: FIXTURE_REQUESTED_COMMAND,
      args: [],
      resolvedComSpec: comSpecPath,
    });
    assertExactPlan(planResult, wrapperPath, comSpecPath);
  } catch (error) {
    primaryError = error;
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (cleanupError) {
    if (primaryError === null) {
      throw new Decision7Error(
        "planner",
        `cannot remove planner-sanity directory ${tempDir}: ${cleanupError?.message ?? cleanupError}`,
      );
    }
  }
  if (primaryError !== null) {
    throw primaryError;
  }
}

async function attest(rest) {
  let args;
  try {
    args = parseCliArgs(rest, ATTEST_SCHEMA);
  } catch (err) {
    fail(`${err.message}\n\n${USAGE}`);
    return;
  }
  try {
    const allowDirty = args["allow-dirty"];
    const repo = gatherRepoIdentity();
    const requestedAttestationDir = args["attestation-dir"]
      ? resolve(args["attestation-dir"])
      : join(resolve(args["evidence-dir"]), "decision7-build-attestation");
    const attestationDir = assertSafeEvidenceDir(requestedAttestationDir, {
      repoRootRealPath: repo.repoRootRealPath,
    });
    if (existsSync(attestationDir)) {
      throw new Decision7Error(
        "attest",
        `build-attestation bundle already exists (write-once): ${attestationDir}`,
      );
    }

    const gitCommit = gitCapture(["rev-parse", "HEAD"]);
    if (gitCommit === null || !/^[0-9a-f]{40}$/.test(gitCommit)) {
      throw new Decision7Error("git", "cannot resolve a 40-hex HEAD");
    }
    const dirtyBefore = gitDirty();
    if (dirtyBefore !== false && !allowDirty) {
      throw new Decision7Error(
        "git",
        "working tree is dirty before build (use --allow-dirty for a diagnostic attestation)",
      );
    }

    const comSpec = resolveComSpec();
    const whereExe = resolveWhereExe();
    const pnpm = resolvePnpmShim(whereExe.realPath);
    out(
      `resolved pnpm.cmd: ${pnpm.realPath}${pnpm.rawCandidates.length > 1 ? `  (raw candidates: ${pnpm.rawCandidates.join(", ")})` : ""}`,
    );
    const pnpmVersion = capturePnpmVersion(comSpec.realPath, pnpm.realPath, repo.repoRootRealPath);

    const buildLine = buildBoundedPnpmLine(pnpm.realPath, PNPM_BUILD_TAIL);
    const buildArgs = ["/d", "/v:off", "/s", "/c", buildLine];
    out(`building: ${buildLine}`);
    const startedAt = nowStamp();
    const build = boundedSpawn(comSpec.realPath, buildArgs, {
      cwd: repo.repoRootRealPath,
      timeoutMs: BUILD_TIMEOUT_MS,
      maxBuffer: BUILD_MAXBUFFER,
      windowsVerbatimArguments: true,
    });
    const completedAt = nowStamp();
    if (build.stdout.length > 0) {
      process.stdout.write(build.stdout);
    }
    if (build.stderr.length > 0) {
      process.stderr.write(build.stderr);
    }
    if (build.timedOut) {
      throw new Decision7Error("build", `build timed out after ${BUILD_TIMEOUT_MS}ms`);
    }
    if (build.bufferExceeded) {
      throw new Decision7Error(
        "build",
        "build output exceeded the capture buffer; refusing attestation",
      );
    }
    if (!build.clean) {
      throw new Decision7Error(
        "build",
        `build failed (exit=${build.exitCode} error=${build.errorCode})`,
      );
    }

    const dirtyAfter = gitDirty();
    if (dirtyAfter !== false && !allowDirty) {
      throw new Decision7Error("git", "working tree is dirty after build");
    }

    const buildCommandLaunchPlan = await importPlanner();
    plannerSanityCheck(buildCommandLaunchPlan, comSpec.realPath);

    const node = hashCritical(process.execPath, "node");
    const source = hashCritical(SRC_PATH, "source");
    const compiled = hashCritical(DIST_PATH, "compiled");
    const fixture = hashCritical(FIXTURE_PATH, "fixture");
    const harness = hashCritical(HARNESS_PATH, "harness");
    const lib = hashCritical(LIB_PATH, "library");

    mkdirSync(dirname(attestationDir), { recursive: true });
    try {
      mkdirSync(attestationDir);
    } catch (err) {
      if (err?.code === "EEXIST") {
        throw new Decision7Error(
          "attest",
          `build-attestation bundle already exists (write-once): ${attestationDir}`,
        );
      }
      throw err;
    }
    const rawDir = join(attestationDir, "raw");
    mkdirSync(rawDir);

    const stdoutName = "decision7-build.stdout.txt";
    const stderrName = "decision7-build.stderr.txt";
    const attestationName = "decision7-build-attestation.json";
    writeFileAtomic(join(rawDir, stdoutName), build.stdout);
    writeFileAtomic(join(rawDir, stderrName), build.stderr);
    const stdoutBlock = {
      path: stdoutName,
      sha256: sha256File(join(rawDir, stdoutName)),
      byteCount: Buffer.byteLength(build.stdout, "utf8"),
      truncated: false,
    };
    const stderrBlock = {
      path: stderrName,
      sha256: sha256File(join(rawDir, stderrName)),
      byteCount: Buffer.byteLength(build.stderr, "utf8"),
      truncated: false,
    };

    const withoutDigest = {
      schemaVersion: ATTESTATION_SCHEMA_VERSION,
      matrixDefinitionVersion: MATRIX_DEFINITION_VERSION,
      harnessImplementationVersion: HARNESS_IMPLEMENTATION_VERSION,
      gitCommit,
      gitDirtyBeforeBuild: dirtyBefore !== false,
      gitDirtyAfterBuild: dirtyAfter !== false,
      nodeVersion: process.version,
      pnpmVersion,
      pnpmPath: pnpm.realPath,
      pnpmSha256: pnpm.sha256,
      platform: process.platform,
      arch: process.arch,
      sourceSha256: source.sha256,
      compiledSha256: compiled.sha256,
      fixtureSha256: fixture.sha256,
      harnessSha256: harness.sha256,
      librarySha256: lib.sha256,
      comSpecPath: comSpec.realPath,
      comSpecSha256: comSpec.sha256,
      repoRootDeclaredPath: repo.repoRootDeclaredPath,
      repoRootRealPath: repo.repoRootRealPath,
      gitShowToplevel: repo.gitShowToplevel,
      gitShowToplevelRealPath: repo.gitShowToplevelRealPath,
      gitCommonDir: repo.gitCommonDir,
      gitCommonDirRealPath: repo.gitCommonDirRealPath,
      criticalPaths: {
        comSpec: { declaredPath: comSpec.declaredPath, realPath: comSpec.realPath },
        whereExe: {
          declaredPath: whereExe.declaredPath,
          realPath: whereExe.realPath,
          systemRootSource: whereExe.systemRootSource,
        },
        pnpm: { realPath: pnpm.realPath, rawCandidates: pnpm.rawCandidates },
        node: { declaredPath: node.declaredPath, realPath: node.realPath },
        source: { declaredPath: source.declaredPath, realPath: source.realPath },
        compiled: { declaredPath: compiled.declaredPath, realPath: compiled.realPath },
        fixture: { declaredPath: fixture.declaredPath, realPath: fixture.realPath },
        harness: { declaredPath: harness.declaredPath, realPath: harness.realPath },
        library: { declaredPath: lib.declaredPath, realPath: lib.realPath },
      },
      build: {
        executable: comSpec.realPath,
        args: buildArgs,
        cwd: repo.repoRootRealPath,
        exitCode: build.exitCode,
        durationMs: build.durationMs,
        startedAt,
        completedAt,
        stdoutCaptured: true,
        stderrCaptured: true,
        stdout: stdoutBlock,
        stderr: stderrBlock,
      },
      machine: gatherMachine(),
      createdAt: new Date().toISOString(),
    };
    const attestation = finalizeAttestation(withoutDigest);
    assertValidAttestation(attestation, { eligible: !allowDirty });
    assertAttestedBuildCommand(attestation, {
      executable: comSpec.realPath,
      args: buildArgs,
      cwd: repo.repoRootRealPath,
    });
    writeEvidenceAtomic(join(rawDir, attestationName), attestation);

    const manifestText = computeManifestText(rawDir, "raw");
    const manifestPath = join(attestationDir, "manifest.sha256");
    writeFileAtomic(manifestPath, manifestText);
    const manifestDigest = verifyManifest(rawDir, "raw", { path: manifestPath });

    out(`\nbuild-attestation bundle : ${attestationDir}`);
    out(`attestationDigest        : ${attestation.attestationDigest}`);
    out(`manifest.sha256 digest   : ${manifestDigest}`);
    process.exit(EXIT_OK);
  } catch (err) {
    if (err instanceof Decision7Error) {
      fail(err.message);
      return;
    }
    throw err;
  }
}

function probeLiveness(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return LIVENESS.INDETERMINATE;
  }
  try {
    process.kill(pid, 0);
    return LIVENESS.ALIVE;
  } catch (err) {
    if (err?.code === "ESRCH") {
      return LIVENESS.DEAD;
    }
    if (err?.code === "EPERM") {
      return LIVENESS.ALIVE;
    }
    return LIVENESS.INDETERMINATE;
  }
}

async function probeUntilDead(pid) {
  let state = probeLiveness(pid);
  for (let i = 0; i < PROBE_DEAD_ATTEMPTS && state === LIVENESS.ALIVE; i += 1) {
    await sleep(PROBE_DEAD_INTERVAL_MS);
    state = probeLiveness(pid);
  }
  return state;
}

// Cleanup success requires clean + no timeout + no buffer breach, not merely exit 0.
function taskkill(pid, tree) {
  const args = tree ? ["/T", "/F", "/PID", String(pid)] : ["/F", "/PID", String(pid)];
  const r = boundedSpawn(TASKKILL.realPath, args, {
    timeoutMs: SHORT_TIMEOUT_MS,
    maxBuffer: SHORT_MAXBUFFER,
  });
  const ok = r.clean === true && r.timedOut === false && r.bufferExceeded === false;
  return {
    args,
    ok,
    timedOut: r.timedOut,
    bufferExceeded: r.bufferExceeded,
    exitCode: r.exitCode,
    errorCode: r.errorCode,
    durationMs: r.durationMs,
    raw: `# ${TASKKILL.realPath} ${args.join(" ")} (ok=${ok} exit=${r.exitCode} timedOut=${r.timedOut} bufferExceeded=${r.bufferExceeded})\n${r.stdout}${r.stderr}`,
  };
}

function removeTempDir(dir) {
  if (!dir) {
    return true;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function readEvents(path) {
  return readFileBounded(path, MAX_EVENT_FILE_BYTES);
}

// Stable read: byte length AND full bounded text must hold steady for a bounded
// number of intervals (same-length content changes are not "stable").
async function stableReadEvents(path) {
  let previous = readEvents(path);
  let attempts = 1;
  let stableIntervals = 0;
  while (attempts < STABLE_READ_MAX_ATTEMPTS) {
    await sleep(STABLE_READ_INTERVAL_MS);
    const current = readEvents(path);
    attempts += 1;
    const same =
      current.byteCount === previous.byteCount &&
      current.missing === previous.missing &&
      current.truncated === previous.truncated &&
      current.text === previous.text;
    stableIntervals = same ? stableIntervals + 1 : 0;
    previous = current;
    if (stableIntervals >= STABLE_READ_REQUIRED_INTERVALS) {
      return {
        read: current,
        stableRead: {
          attempts,
          requiredStableIntervals: STABLE_READ_REQUIRED_INTERVALS,
          intervalMs: STABLE_READ_INTERVAL_MS,
          finalByteLength: current.byteCount,
          stabilized: true,
        },
      };
    }
  }
  return {
    read: previous,
    stableRead: {
      attempts,
      requiredStableIntervals: STABLE_READ_REQUIRED_INTERVALS,
      intervalMs: STABLE_READ_INTERVAL_MS,
      finalByteLength: previous.byteCount,
      stabilized: false,
    },
  };
}

function classifyDelivery(eventProtocolValid, ready, sigint) {
  if (!eventProtocolValid) {
    return INTERACTIVE_DELIVERY.INDETERMINATE;
  }
  if (sigint) {
    return INTERACTIVE_DELIVERY.RECEIVED;
  }
  if (ready) {
    return INTERACTIVE_DELIVERY.NOT_RECEIVED;
  }
  return INTERACTIVE_DELIVERY.INDETERMINATE;
}

function classifyCandidate(f) {
  if (!f.eventProtocolValid) {
    return CANDIDATE_WRAPPER_COMPLETION.INDETERMINATE;
  }
  if (f.processRelationshipValid === false) {
    return CANDIDATE_WRAPPER_COMPLETION.INDETERMINATE;
  }
  if (f.wrapperClose.observed && f.wrapperCloseBeforeCtrlC) {
    return CANDIDATE_WRAPPER_COMPLETION.INDETERMINATE;
  }
  if (f.wrapperAlive === LIVENESS.ALIVE) {
    return CANDIDATE_WRAPPER_COMPLETION.FORCED_RECOVERY;
  }
  if (f.wrapperAlive === LIVENESS.DEAD && f.fixtureAlive === LIVENESS.ALIVE) {
    return CANDIDATE_WRAPPER_COMPLETION.ORPHANED;
  }
  if (
    f.wrapperClose.observed &&
    f.wrapperClosedWithinWindow &&
    f.fixtureSigintRecorded &&
    f.wrapperAlive === LIVENESS.DEAD &&
    f.fixtureAlive === LIVENESS.DEAD
  ) {
    return CANDIDATE_WRAPPER_COMPLETION.CLEAN_EXIT;
  }
  return CANDIDATE_WRAPPER_COMPLETION.INDETERMINATE;
}

// Strip the raw taskkill log for the result document (the strict serializer rejects
// `undefined` properties, so omit rather than set undefined).
function serializableCleanup(cleanup) {
  if (!cleanup || typeof cleanup !== "object") {
    return cleanup;
  }
  const out = {};
  for (const key of Object.keys(cleanup)) {
    if (key !== "rawLog") {
      out[key] = cleanup[key];
    }
  }
  return out;
}

function harnessEvidenceFailed(obs) {
  return obs.harnessEventLimitExceeded || obs.harnessEventWriteError !== null;
}

// Sibling scan: lstat (reject symlink dirs), bounded metadata read. Incomplete dirs
// (no valid raw/metadata.json) are recorded; malformed metadata, a differing digest,
// or identity-inconsistency under a matching digest are refusals.
function scanSiblings(caseDir, attestation) {
  const scan = {
    present: false,
    siblings: [],
    incomplete: [],
    malformed: [],
    digestConflict: false,
  };
  if (!existsSync(caseDir)) {
    return scan;
  }
  scan.present = true;
  for (const name of readdirSync(caseDir)) {
    const dir = join(caseDir, name);
    let ls;
    try {
      ls = lstatSync(dir);
    } catch {
      scan.malformed.push(`${name}:unstatable`);
      continue;
    }
    if (ls.isSymbolicLink()) {
      scan.malformed.push(`${name}:symlink`);
      continue;
    }
    if (!ls.isDirectory()) {
      scan.incomplete.push(`${name}:non_directory`);
      continue;
    }
    const metaPath = join(dir, "raw", "metadata.json");
    if (!existsSync(metaPath)) {
      scan.incomplete.push(`${name}:no_metadata`);
      continue;
    }
    let meta;
    try {
      const r = readFileBounded(metaPath, MAX_METADATA_BYTES);
      if (r.missing || r.truncated) {
        scan.malformed.push(`${name}:metadata_${r.truncated ? "too_large" : "missing"}`);
        continue;
      }
      meta = JSON.parse(r.text);
    } catch {
      scan.malformed.push(`${name}:unreadable_metadata`);
      continue;
    }
    const identity = meta && typeof meta === "object" ? meta.identity : null;
    const digest =
      identity && typeof identity === "object" ? identity.attestationDigest : undefined;
    if (typeof digest !== "string" || digest.length === 0) {
      scan.malformed.push(`${name}:missing_attestation_digest`);
      continue;
    }
    if (digest !== attestation.attestationDigest) {
      scan.digestConflict = true;
      scan.siblings.push({ name, attestationDigest: digest, matches: false });
      continue;
    }
    const mism = [];
    if (identity.gitCommit !== attestation.gitCommit) {
      mism.push("gitCommit");
    }
    if (identity.nodeVersion !== attestation.nodeVersion) {
      mism.push("nodeVersion");
    }
    if (identity.comSpecSha256 !== attestation.comSpecSha256) {
      mism.push("comSpecSha256");
    }
    if ((meta.harnessImplementationVersion ?? null) !== HARNESS_IMPLEMENTATION_VERSION) {
      mism.push("harnessImplementationVersion");
    }
    if ((meta.matrixDefinition?.matrixDefinitionVersion ?? null) !== MATRIX_DEFINITION_VERSION) {
      mism.push("matrixDefinitionVersion");
    }
    if (mism.length > 0) {
      scan.malformed.push(`${name}:identity_mismatch_despite_digest:${mism.join("+")}`);
      continue;
    }
    scan.siblings.push({ name, attestationDigest: digest, matches: true });
  }
  return scan;
}

function enforceSiblingPolicy(ctx) {
  const s = ctx.siblingScan;
  if (s.malformed.length > 0) {
    throw new Decision7Error(
      "sibling",
      `matrix case ${ctx.caseId} has malformed sibling evidence: ${s.malformed.join(", ")}`,
    );
  }
  if (s.digestConflict) {
    throw new Decision7Error(
      "sibling",
      `matrix case ${ctx.caseId} mixes attestation digests (one built identity per case)`,
    );
  }
  if (!ctx.newAttempt) {
    const baseLeaf = join(ctx.caseDir, `repetition-${ctx.repetition}`);
    if (existsSync(baseLeaf)) {
      throw new Decision7Error(
        "sibling",
        `repetition ${ctx.repetition} already recorded at ${baseLeaf} (use --new-attempt)`,
      );
    }
  }
}

// The attested build is never relaxed: exactly the three expected artifacts, each
// bounded, hash-bound, and never truncated.
function verifyBuildArtifacts(attestationRawDir, attestation) {
  const rawEntries = readdirSync(attestationRawDir).sort();
  const expected = [
    "decision7-build-attestation.json",
    "decision7-build.stderr.txt",
    "decision7-build.stdout.txt",
  ];
  if (rawEntries.length !== expected.length || expected.some((n, i) => rawEntries[i] !== n)) {
    throw new Decision7Error(
      "attestation",
      `build-attestation raw set is not exactly the expected artifacts: ${rawEntries.join(", ")}`,
    );
  }
  for (const stream of ["stdout", "stderr"]) {
    const block = attestation.build[stream];
    const name = stream === "stdout" ? "decision7-build.stdout.txt" : "decision7-build.stderr.txt";
    if (block.path !== name) {
      throw new Decision7Error("attestation", `build.${stream}.path is not ${name}: ${block.path}`);
    }
    if (block.truncated !== false) {
      throw new Decision7Error(
        "attestation",
        `build.${stream}.truncated must be false (a truncated build output is never usable)`,
      );
    }
    const filePath = join(attestationRawDir, name);
    const r = readFileBounded(filePath, BUILD_MAXBUFFER);
    if (r.missing || r.truncated) {
      throw new Decision7Error(
        "attestation",
        `build ${stream} artifact ${r.missing ? "missing" : "exceeds the bounded read"}: ${filePath}`,
      );
    }
    if (block.byteCount !== r.byteCount) {
      throw new Decision7Error(
        "attestation",
        `build.${stream}.byteCount does not match the artifact (${block.byteCount} != ${r.byteCount})`,
      );
    }
    if (block.sha256 !== sha256File(filePath)) {
      throw new Decision7Error(
        "attestation",
        `build.${stream}.sha256 does not match the artifact: ${name}`,
      );
    }
  }
}

async function preparePreflight(args, options) {
  const allowAttestationMismatch = options.allowAttestationMismatch === true;
  const stdinTTY = process.stdin.isTTY === true;
  const stdoutTTY = process.stdout.isTTY === true;
  const stderrTTY = process.stderr.isTTY === true;
  const allowNoninteractive = args["allow-noninteractive"];
  if (!(stdinTTY && stdoutTTY && stderrTTY) && !allowNoninteractive) {
    throw new Decision7Error(
      "tty",
      "no interactive console (stdin/stdout/stderr not all TTYs); --allow-noninteractive is diagnostic only",
    );
  }
  const allowDirty = args["allow-dirty"];
  const eligibility = computeEligibilityConstraints({
    allowDirty,
    allowNoninteractive,
    buildOverride: false,
    attestationMismatchOverride: allowAttestationMismatch,
  });

  const comSpec = resolveComSpec();
  const whereExe = resolveWhereExe();
  const pnpm = resolvePnpmShim(whereExe.realPath);
  const repo = gatherRepoIdentity();
  const pnpmVersion = capturePnpmVersion(comSpec.realPath, pnpm.realPath, repo.repoRootRealPath);
  const machine = gatherMachine();

  const gitCommit = gitCapture(["rev-parse", "HEAD"]);
  const dirty = gitDirty();
  const originMain = gitCapture(["rev-parse", "--verify", "origin/main"]);
  const headMatchesOriginMain = gitCommit && originMain ? gitCommit === originMain : null;
  if (dirty !== false && !allowDirty) {
    throw new Decision7Error(
      "git",
      dirty === null
        ? "cannot determine git cleanliness (--allow-dirty is diagnostic only)"
        : "working tree is dirty (--allow-dirty is diagnostic only)",
    );
  }

  const attestationDir = assertSafeEvidenceDir(resolve(args["attestation-dir"]), {
    repoRootRealPath: repo.repoRootRealPath,
  });
  const attestationRawDir = join(attestationDir, "raw");
  const attestationManifest = join(attestationDir, "manifest.sha256");
  if (!existsSync(attestationManifest) || !existsSync(attestationRawDir)) {
    throw new Decision7Error(
      "attestation",
      `build-attestation bundle not found or incomplete: ${attestationDir}`,
    );
  }
  verifyManifest(attestationRawDir, "raw", { path: attestationManifest });
  const attestation = readJsonFile(join(attestationRawDir, "decision7-build-attestation.json"));
  // The attested BUILD is never relaxed by --allow-attestation-mismatch.
  assertValidAttestation(attestation, { eligible: false });
  verifyBuildArtifacts(attestationRawDir, attestation);
  if (
    !allowDirty &&
    (attestation.gitDirtyBeforeBuild !== false || attestation.gitDirtyAfterBuild !== false)
  ) {
    throw new Decision7Error(
      "attestation",
      "build attestation was created from a dirty tree; --allow-dirty is diagnostic only",
    );
  }
  const expectedBuildArgs = [
    "/d",
    "/v:off",
    "/s",
    "/c",
    buildBoundedPnpmLine(attestation.pnpmPath, PNPM_BUILD_TAIL),
  ];
  assertAttestedBuildCommand(attestation, {
    executable: attestation.comSpecPath,
    args: expectedBuildArgs,
    cwd: attestation.repoRootRealPath,
  });

  if (!existsSync(DIST_PATH)) {
    throw new Decision7Error(
      "planner",
      `compiled launcher not found: ${DIST_PATH}. Run \`attest\` first.`,
    );
  }
  const src = hashCritical(SRC_PATH, "source");
  const compiled = hashCritical(DIST_PATH, "compiled");
  const fixture = hashCritical(FIXTURE_PATH, "fixture");
  const harnessFile = hashCritical(HARNESS_PATH, "harness");
  const libFile = hashCritical(LIB_PATH, "library");
  hashCritical(process.execPath, "node");

  const current = {
    sourceSha256: src.sha256,
    compiledSha256: compiled.sha256,
    fixtureSha256: fixture.sha256,
    harnessSha256: harnessFile.sha256,
    librarySha256: libFile.sha256,
    comSpecSha256: comSpec.sha256,
    pnpmSha256: pnpm.sha256,
    gitCommit: gitCommit ?? "",
    nodeVersion: process.version,
    pnpmVersion,
    platform: process.platform,
    arch: process.arch,
    comSpecPath: comSpec.realPath,
    pnpmPath: pnpm.realPath,
    repoRootRealPath: repo.repoRootRealPath,
    gitShowToplevelRealPath: repo.gitShowToplevelRealPath,
    gitCommonDirRealPath: repo.gitCommonDirRealPath,
    matrixDefinitionVersion: MATRIX_DEFINITION_VERSION,
    harnessImplementationVersion: HARNESS_IMPLEMENTATION_VERSION,
  };
  const freshness = validateAttestationFreshness(attestation, current);
  const identity = validateAttestationIdentity(attestation, current);
  const machineMismatches = ["computerName", "osVersion", "osBuild"].filter(
    (f) => attestation.machine[f] !== machine[f],
  );
  const machineMatch = machineMismatches.length === 0;
  const enforce = !allowAttestationMismatch;
  if (enforce && !freshness.fresh) {
    throw new Decision7Error(
      "attestation",
      `attestation is stale (${freshness.mismatches.join(", ")}); re-run \`attest\``,
    );
  }
  if (enforce && !identity.matches) {
    throw new Decision7Error(
      "attestation",
      `attestation environment identity mismatch (${identity.mismatches.join(", ")})`,
    );
  }
  if (enforce && !machineMatch) {
    throw new Decision7Error(
      "attestation",
      `attestation machine identity mismatch (${machineMismatches.join(", ")})`,
    );
  }

  const mtime = {
    sourceMtimeMs: statSync(SRC_PATH).mtimeMs,
    compiledMtimeMs: statSync(DIST_PATH).mtimeMs,
    compiledPredatesSource: false,
  };
  mtime.compiledPredatesSource = mtime.compiledMtimeMs < mtime.sourceMtimeMs;

  const buildCommandLaunchPlan = await importPlanner();
  const tempDir = mkdtempSync(join(tmpdir(), "decision7-run-"));
  try {
    const tempDirRealPath = assertRealDirectory(tempDir, "temp wrapper dir").realPath;
    const wrapper = generateWrapper(tempDir);
    const planResult = buildCommandLaunchPlan({
      platform: process.platform,
      resolvedTarget: wrapper.wrapperPath,
      requestedCommand: FIXTURE_REQUESTED_COMMAND,
      args: [],
      resolvedComSpec: comSpec.realPath,
    });
    const plan = assertExactPlan(planResult, wrapper.wrapperPath, comSpec.realPath);

    const terminalHost = args["terminal-host"];
    const shellHost = args["shell-host"];
    const caseId = matrixCaseId(terminalHost, shellHost);
    const evidenceDir = assertSafeEvidenceDir(resolve(args["evidence-dir"]), {
      repoRootRealPath: repo.repoRootRealPath,
      tempDirRealPath,
    });
    const caseDir = join(evidenceDir, caseId);
    const siblingScan = scanSiblings(caseDir, attestation);

    return {
      args,
      allowNoninteractive,
      allowAttestationMismatch,
      eligibility,
      ttys: { stdinTTY, stdoutTTY, stderrTTY },
      comSpec,
      whereExe,
      pnpm,
      pnpmVersion,
      repo,
      machine,
      gitCommit,
      dirty,
      headMatchesOriginMain,
      attestationDir,
      attestation,
      freshness,
      identity,
      machineMatch,
      machineMismatches,
      mtime,
      tempDir,
      tempDirRealPath,
      wrapper,
      plan,
      terminalHost,
      shellHost,
      caseId,
      evidenceDir,
      caseDir,
      repetition: args.repetition,
      hostLabel: args["host-label"],
      newAttempt: args["new-attempt"],
      siblingScan,
      config: {
        observationSeconds: args["observation-seconds"],
        operatorResponseSeconds: args["operator-response-seconds"],
        readinessSeconds: args["readiness-seconds"],
        heartbeatMs: args["heartbeat-ms"],
      },
    };
  } catch (error) {
    const removed = removeTempDir(tempDir);
    if (!removed) {
      if (error instanceof Decision7Error) {
        error.details = { ...(error.details ?? {}), tempCleanupFailed: tempDir };
        throw error;
      }
      throw new Decision7Error(
        "temp-cleanup",
        `preflight failed and the temporary directory could not be removed: ${tempDir}`,
        { primaryError: error?.message ?? String(error) },
      );
    }
    throw error;
  }
}

function printSummary(ctx) {
  const s = ctx.siblingScan;
  out("");
  out("================ DECISION 7 - Stage A ================");
  out(
    `  matrixCaseId : ${ctx.caseId}  repetition ${ctx.repetition}/${REQUIRED_REPETITIONS}${ctx.newAttempt ? " (new attempt)" : ""}`,
  );
  out(`  host label   : ${ctx.hostLabel}`);
  out(`  node         : ${process.version} (${process.arch})`);
  out(
    `  git commit   : ${ctx.gitCommit ?? "unknown"}  dirty=${ctx.dirty}  head==origin/main=${ctx.headMatchesOriginMain}`,
  );
  out(`  ComSpec      : ${ctx.comSpec.realPath}`);
  out(`  pnpm.cmd     : ${ctx.pnpm.realPath}  (v${ctx.pnpmVersion})`);
  out(`  attestation  : ${ctx.attestationDir}  digest=${ctx.attestation.attestationDigest}`);
  out(
    `  fresh=${ctx.freshness.fresh} identity=${ctx.identity.matches} machine=${ctx.machineMatch} compiledPredatesSource=${ctx.mtime.compiledPredatesSource}`,
  );
  out(`  plan         : ${ctx.plan.strategy}`);
  out(
    `  eligibility  : satisfied=${ctx.eligibility.eligibility_constraints_satisfied} overrides=[${ctx.eligibility.diagnostic_overrides.join(",")}]`,
  );
  out(
    `  siblings     : ${s.siblings.length} valid, incomplete=[${s.incomplete.join(",")}] malformed=[${s.malformed.join(",")}] digestConflict=${s.digestConflict}`,
  );
  out("=====================================================");
}

async function runPreflightOnly(rest) {
  let ctx;
  try {
    const args = parseCliArgs(rest, PREFLIGHT_SCHEMA);
    ctx = await preparePreflight(args, {
      allowAttestationMismatch: args["allow-attestation-mismatch"],
    });
  } catch (err) {
    if (err instanceof Decision7Error) {
      fail(err.message);
      return;
    }
    throw err;
  }
  let refusal = null;
  try {
    enforceSiblingPolicy(ctx);
  } catch (err) {
    if (err instanceof Decision7Error) {
      refusal = err.message;
    } else {
      removeTempDir(ctx.tempDir);
      throw err;
    }
  }
  const tempRemoved = removeTempDir(ctx.tempDir);
  printSummary(ctx);
  if (ctx.siblingScan.incomplete.length > 0) {
    out(
      `NOTE: incomplete sibling debris (ignored, no valid metadata): ${ctx.siblingScan.incomplete.join(", ")}`,
    );
  }
  if (refusal !== null) {
    fail(
      `preflight refusal (run would refuse): ${refusal}${tempRemoved ? "" : ` [ALSO: could not remove temp dir ${ctx.tempDir}]`}`,
    );
    return;
  }
  if (!tempRemoved) {
    fail(`cannot remove preflight temporary directory: ${ctx.tempDir}`);
    return;
  }
  out("\npreflight OK (no bundle created, no child spawned).");
  process.exit(EXIT_OK);
}

function confirm(ctx) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(
      `Type the matrixCaseId ("${ctx.caseId}") to start, or anything else to abort: `,
      (answer) => {
        rl.close();
        process.stdin.pause();
        res(answer.trim() === ctx.caseId);
      },
    );
  });
}

async function awaitReadiness(ctx, eventFile, ids, obs) {
  const deadline = performance.now() + ctx.config.readinessSeconds * 1000;
  while (performance.now() < deadline) {
    if (harnessEvidenceFailed(obs)) {
      return { status: "harness_evidence_failure" };
    }
    if (obs.spawnError !== null) {
      return { status: "spawn_error" };
    }
    const read = readEvents(eventFile);
    if (read.truncated) {
      return { status: "truncated" };
    }
    if (!read.missing) {
      const parsed = parseJsonl(read.text, {
        maxLineBytes: MAX_LINE_BYTES,
        maxEvents: MAX_EVENTS,
        sourceTruncated: read.truncated,
      });
      const v = validateFixtureEvents(parsed, ids, obs.wrapperPid);
      if (v.eventProtocolValid && v.ready !== null && v.heartbeats.length >= 1) {
        const hb = v.heartbeats[0];
        return {
          status: "ready",
          fixturePid: v.fixturePid,
          parentMatchesWrapper: v.parentMatchesWrapper,
          firstHeartbeat: {
            fixtureTs: hb.ts,
            fixtureMonotonicMs: hb.monotonicMs,
            observedAt: nowStamp(),
          },
        };
      }
    }
    await sleep(POLL_MS);
  }
  return { status: "timeout" };
}

async function awaitCtrlC(ctx, obs) {
  const deadline = performance.now() + ctx.config.operatorResponseSeconds * 1000;
  while (obs.sigintStamps.length === 0) {
    if (harnessEvidenceFailed(obs)) {
      return "harness_evidence_failure";
    }
    if (performance.now() >= deadline) {
      return "timeout";
    }
    await sleep(POLL_MS);
  }
  return "sigint";
}

async function observeWindow(ctx, obs) {
  const deadline = obs.ctrlCObservedAt.monotonicMs + ctx.config.observationSeconds * 1000;
  while (performance.now() < deadline) {
    if (harnessEvidenceFailed(obs)) {
      return "harness_evidence_failure";
    }
    await sleep(POLL_MS);
  }
  return "complete";
}

function buildMetadata(ctx, extra) {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    harnessImplementationVersion: HARNESS_IMPLEMENTATION_VERSION,
    matrixDefinition: MATRIX_DEFINITION,
    runId: extra.runId,
    matrixCaseId: ctx.caseId,
    repetition: ctx.repetition,
    requiredRepetitions: REQUIRED_REPETITIONS,
    newAttempt: ctx.newAttempt,
    attempt: {
      leaf: extra.leaf,
      attemptCreatedAt: extra.attemptCreatedAt,
      attemptTimestamp: extra.attemptTimestamp,
    },
    terminalHost: ctx.terminalHost,
    shellHost: ctx.shellHost,
    hostLabel: ctx.hostLabel,
    startedAt: nowStamp(),
    identity: {
      gitCommit: ctx.gitCommit,
      gitDirty: ctx.dirty,
      headMatchesOriginMain: ctx.headMatchesOriginMain,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      comSpecPath: ctx.comSpec.realPath,
      comSpecSha256: ctx.comSpec.sha256,
      pnpmPath: ctx.pnpm.realPath,
      pnpmSha256: ctx.pnpm.sha256,
      pnpmVersion: ctx.pnpmVersion,
      repoRootRealPath: ctx.repo.repoRootRealPath,
      gitShowToplevelRealPath: ctx.repo.gitShowToplevelRealPath,
      gitCommonDirRealPath: ctx.repo.gitCommonDirRealPath,
      attestationDir: ctx.attestationDir,
      attestationDigest: ctx.attestation.attestationDigest,
      generatedWrapperPath: ctx.wrapper.wrapperPath,
      generatedWrapperSha256: ctx.wrapper.wrapperSha256,
      operatorTemplateSha256: extra.operatorTemplateSha256,
      consoleTemplateSha256: extra.consoleTemplateSha256,
    },
    attestationFreshness: ctx.freshness,
    attestationIdentity: ctx.identity,
    machineIdentity: {
      matches: ctx.machineMatch,
      mismatches: ctx.machineMismatches,
      attested: ctx.attestation.machine,
      current: ctx.machine,
    },
    mtime: ctx.mtime,
    pnpmCandidates: ctx.pnpm.rawCandidates,
    siblingScan: ctx.siblingScan,
    eligibilityConstraints: ctx.eligibility,
    environment: {
      stdioMode: "inherit",
      consoleOutputCapturedByHarness: false,
      stdinIsTTY: ctx.ttys.stdinTTY,
      stdoutIsTTY: ctx.ttys.stdoutTTY,
      stderrIsTTY: ctx.ttys.stderrTTY,
      WT_SESSION: process.env.WT_SESSION ?? null,
      TERM_PROGRAM: process.env.TERM_PROGRAM ?? null,
      ConEmuPID: process.env.ConEmuPID ?? null,
    },
    machine: ctx.machine,
    plan: {
      mechanism: ctx.plan.strategy,
      command: ctx.plan.command,
      args: ctx.plan.args,
      shell: ctx.plan.shell,
      windowsVerbatimArguments: ctx.plan.windowsVerbatimArguments,
      requestedCommand: ctx.plan.requestedCommand,
      resolvedTarget: ctx.plan.resolvedTarget,
      assumptions: ctx.plan.assumptions ?? null,
      containsSecrets: false,
    },
    config: ctx.config,
    limits: {
      maxEventFileBytes: MAX_EVENT_FILE_BYTES,
      maxHarnessFileBytes: MAX_HARNESS_FILE_BYTES,
      maxLineBytes: MAX_LINE_BYTES,
      maxEvents: MAX_EVENTS,
    },
  };
}

async function executeRun(rest) {
  let ctx;
  try {
    const args = parseCliArgs(rest, RUN_SCHEMA);
    ctx = await preparePreflight(args, { allowAttestationMismatch: false });
  } catch (err) {
    if (err instanceof Decision7Error) {
      fail(err.message);
      return;
    }
    throw err;
  }
  try {
    enforceSiblingPolicy(ctx);
  } catch (err) {
    const removed = removeTempDir(ctx.tempDir);
    if (err instanceof Decision7Error) {
      fail(`${err.message}${removed ? "" : ` [ALSO: could not remove temp dir ${ctx.tempDir}]`}`);
      return;
    }
    throw err;
  }

  printSummary(ctx);
  if (ctx.ttys.stdinTTY && !ctx.allowNoninteractive) {
    const ok = await confirm(ctx);
    if (!ok) {
      const removed = removeTempDir(ctx.tempDir);
      fail(
        `aborted at confirmation; no evidence bundle created.${removed ? "" : ` [ALSO: could not remove temp dir ${ctx.tempDir}]`}`,
      );
      return;
    }
  }

  const runId = randomUUID();
  const token = randomUUID();
  const ids = { runId, token };
  const created = new Date();
  const attemptCreatedAt = created.toISOString();
  const attemptTimestamp = attemptCreatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const leaf = ctx.newAttempt
    ? `repetition-${ctx.repetition}__attempt-${attemptTimestamp}-${runId}`
    : `repetition-${ctx.repetition}`;
  const bundleDir = join(ctx.caseDir, leaf);

  let phase = "preflight";
  let harnessEventsPath = null;
  let harnessBytes = 0;
  let rawDir = null;
  let resultWritten = false;
  let bundleAllocated = false;
  let acceptingHarnessEvents = true;
  const harnessBuffer = [];
  const obs = {
    wrapperPid: null,
    fixturePid: null,
    wrapperExit: { observed: false, code: null, signal: null, monotonicMs: null },
    wrapperClose: { observed: false, code: null, signal: null, monotonicMs: null },
    spawnError: null,
    sigintStamps: [],
    ctrlCObservedAt: null,
    readyAt: null,
    firstHeartbeat: null,
    promptAt: null,
    windowEndedAt: null,
    harnessEventLimitExceeded: false,
    harnessEventWriteError: null,
  };
  const recordHarness = (event) => {
    if (
      !acceptingHarnessEvents ||
      obs.harnessEventLimitExceeded ||
      obs.harnessEventWriteError !== null
    ) {
      return false;
    }
    const envelope = {
      ...event,
      source: "harness",
      protocolVersion: PROTOCOL_VERSION,
      harnessImplementationVersion: HARNESS_IMPLEMENTATION_VERSION,
      runId,
      token,
      ...nowStamp(),
    };
    const line = `${JSON.stringify(envelope)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (harnessBytes + lineBytes > MAX_HARNESS_FILE_BYTES) {
      obs.harnessEventLimitExceeded = true;
      return false;
    }
    if (harnessEventsPath !== null) {
      try {
        appendFileSync(harnessEventsPath, line, "utf8");
      } catch (error) {
        obs.harnessEventWriteError = error?.message ?? String(error);
        return false;
      }
    }
    harnessBytes += lineBytes;
    harnessBuffer.push(line);
    return true;
  };
  const transition = (to) => {
    assertStateTransition(phase, to);
    const from = phase;
    phase = to;
    recordHarness({ type: "phase", from, to });
  };
  const sigintHandler = () => {
    obs.sigintStamps.push(nowStamp());
    if (obs.sigintStamps.length === 1) {
      obs.ctrlCObservedAt = obs.sigintStamps[0];
      recordHarness({ type: "harness_sigint", ordinal: 1 });
    } else {
      recordHarness({
        type: "harness_sigint_extra",
        ordinal: obs.sigintStamps.length,
        note: "operator_protocol_violation",
      });
    }
  };
  const freezeHarnessWriters = () => {
    acceptingHarnessEvents = false;
    try {
      process.off("SIGINT", sigintHandler);
    } catch {
      // handler may not be attached
    }
  };

  let cleanupPromise = null;
  const doCleanup = async (fixturePid) => {
    const rawLog = [];
    const cleanupTarget = async (pid, tree, label) => {
      const t = {
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
        initial_liveness: LIVENESS.DEAD,
        authorized_by_immediate_alive_probe: false,
        kill_attempted: false,
        kill: null,
        alive_after: LIVENESS.DEAD,
        resolved: true,
      };
      if (t.pid === null) {
        return t;
      }
      t.initial_liveness = probeLiveness(t.pid);
      t.authorized_by_immediate_alive_probe = t.initial_liveness === LIVENESS.ALIVE;
      if (t.initial_liveness === LIVENESS.DEAD) {
        return t;
      }
      if (t.initial_liveness === LIVENESS.INDETERMINATE) {
        t.alive_after = probeLiveness(t.pid);
        t.resolved = false;
        return t;
      }
      if (!TASKKILL.available) {
        t.alive_after = probeLiveness(t.pid);
        t.resolved = false;
        t.kill = { skipped: TASKKILL.reason ?? "native_taskkill_unavailable" };
        return t;
      }
      const r = taskkill(t.pid, tree);
      t.kill_attempted = true;
      t.kill = {
        ok: r.ok,
        timedOut: r.timedOut,
        bufferExceeded: r.bufferExceeded,
        exitCode: r.exitCode,
        errorCode: r.errorCode,
        durationMs: r.durationMs,
      };
      rawLog.push(r.raw);
      recordHarness({
        type: `cleanup_${label}`,
        pid: t.pid,
        ok: r.ok,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
      });
      t.alive_after = await probeUntilDead(t.pid);
      t.resolved = r.ok && t.alive_after === LIVENESS.DEAD;
      return t;
    };
    const wrapper = await cleanupTarget(obs.wrapperPid, true, "wrapper_tree");
    const fixture = await cleanupTarget(fixturePid, false, "fixture_pid");
    const temporary_directory_removed = removeTempDir(ctx.tempDir);
    const completed = wrapper.resolved && fixture.resolved && temporary_directory_removed;
    return {
      taskkillAvailable: TASKKILL.available,
      taskkillReason: TASKKILL.available ? null : (TASKKILL.reason ?? null),
      pidReuseRacePossible: true,
      wrapper,
      fixture,
      temporary_directory_removed,
      completed,
      rawLog,
    };
  };
  const cleanupOnce = (fixturePid) => {
    if (cleanupPromise === null) {
      cleanupPromise = doCleanup(fixturePid);
    }
    return cleanupPromise;
  };

  process.on("exit", (code) => {
    if (bundleAllocated && cleanupPromise === null) {
      process.stderr.write(
        `decision7 harness: WARNING exiting (code ${code}) with an allocated bundle and no cleanup performed.\n`,
      );
    }
  });

  const finalize = async (reason) => {
    obs.windowEndedAt = obs.windowEndedAt ?? nowStamp();
    transition("cleaning_up");

    let fixturePid = obs.fixturePid;
    if (fixturePid === null && rawDir !== null) {
      const transient = readEvents(join(rawDir, "fixture-events.jsonl"));
      if (!transient.missing && !transient.truncated) {
        const tv = validateFixtureEvents(
          parseJsonl(transient.text, {
            maxLineBytes: MAX_LINE_BYTES,
            maxEvents: MAX_EVENTS,
            sourceTruncated: transient.truncated,
          }),
          ids,
          obs.wrapperPid,
        );
        if (tv.eventProtocolValid && tv.fixturePid !== null) {
          fixturePid = tv.fixturePid;
        }
      }
    }

    // Freeze pre-cleanup process observations at the window boundary.
    const wrapperAlive = probeLiveness(obs.wrapperPid);
    const fixtureAlive = probeLiveness(fixturePid);
    const wrapperExit = { ...obs.wrapperExit };
    const wrapperClose = { ...obs.wrapperClose };

    // Cleanup (kills survivors, proves dead), THEN stable final read of the frozen stream.
    const cleanup = await cleanupOnce(fixturePid);
    const stable = await stableReadEvents(join(rawDir, "fixture-events.jsonl"));
    const parsed = parseJsonl(stable.read.text, {
      maxLineBytes: MAX_LINE_BYTES,
      maxEvents: MAX_EVENTS,
      sourceTruncated: stable.read.truncated,
    });
    const v = validateFixtureEvents(parsed, ids, obs.wrapperPid);

    const ctrlCMono = obs.ctrlCObservedAt ? obs.ctrlCObservedAt.monotonicMs : null;
    const windowEndMono = obs.windowEndedAt.monotonicMs;
    const wrapperCloseBeforeCtrlC =
      wrapperClose.observed && ctrlCMono !== null && wrapperClose.monotonicMs < ctrlCMono;
    const wrapperClosedWithinWindow =
      wrapperClose.observed && ctrlCMono !== null && wrapperClose.monotonicMs <= windowEndMono;
    const wrapperExitedWithinWindow =
      wrapperExit.observed && ctrlCMono !== null && wrapperExit.monotonicMs <= windowEndMono;
    const fixtureSigintRecorded = v.eventProtocolValid && v.sigint !== null;
    const firstSigint = obs.sigintStamps[0] ?? null;
    const ctrlCBeforeReady =
      firstSigint !== null &&
      (obs.readyAt === null || firstSigint.monotonicMs < obs.readyAt.monotonicMs);
    const extraDuring = obs.sigintStamps.slice(1).some((s) => s.monotonicMs <= windowEndMono);

    const interactiveDelivery = classifyDelivery(v.eventProtocolValid, v.ready, v.sigint);
    const candidate = classifyCandidate({
      eventProtocolValid: v.eventProtocolValid,
      processRelationshipValid: v.processRelationshipValid,
      wrapperClose,
      wrapperCloseBeforeCtrlC,
      wrapperClosedWithinWindow,
      fixtureSigintRecorded,
      wrapperAlive,
      fixtureAlive,
    });

    const eventEvidenceWithinLimits = !stable.read.truncated && !parsed.limitExceeded;

    const anomalies = [];
    let validity;
    if (obs.spawnError) {
      anomalies.push(`spawn_error:${obs.spawnError}`);
      validity = EXPERIMENT_VALIDITY.INDETERMINATE;
    } else if (ctrlCBeforeReady) {
      anomalies.push("operator_ctrl_c_before_ready");
      validity = EXPERIMENT_VALIDITY.INVALID;
    } else if (!v.eventProtocolValid) {
      validity = EXPERIMENT_VALIDITY.INVALID;
    } else if (extraDuring) {
      anomalies.push("second_ctrl_c_during_experiment");
      validity = EXPERIMENT_VALIDITY.INVALID;
    } else if (
      reason === "readiness_timeout" ||
      reason === "operator_response_timeout" ||
      reason === "event_file_truncated" ||
      reason === "harness_evidence_failure"
    ) {
      anomalies.push(reason);
      validity = EXPERIMENT_VALIDITY.INDETERMINATE;
    } else if (!stable.stableRead.stabilized) {
      anomalies.push("event_file_never_stabilized");
      validity = EXPERIMENT_VALIDITY.INDETERMINATE;
    } else if (wrapperAlive === LIVENESS.INDETERMINATE || fixtureAlive === LIVENESS.INDETERMINATE) {
      anomalies.push("liveness_indeterminate");
      validity = EXPERIMENT_VALIDITY.INDETERMINATE;
    } else {
      validity = EXPERIMENT_VALIDITY.VALID;
    }

    writeFileAtomic(
      join(rawDir, "cleanup.txt"),
      cleanup.rawLog.length > 0
        ? `${cleanup.rawLog.join("\n\n")}\n`
        : "no cleanup actions required\n",
    );

    // Final harness events (last writes to harness-events.jsonl), THEN freeze all raw
    // writers, THEN compute the definitive integrity flags.
    recordHarness({
      type: "classified_result",
      experiment_validity: validity,
      candidate,
      interactive_delivery: interactiveDelivery,
    });
    transition("sealing");
    freezeHarnessWriters();

    const harnessEvidenceOk = !obs.harnessEventLimitExceeded && obs.harnessEventWriteError === null;
    if (obs.harnessEventLimitExceeded) {
      anomalies.push("harness_event_limit_exceeded");
    }
    if (obs.harnessEventWriteError !== null) {
      anomalies.push("harness_event_write_error");
    }
    if (obs.sigintStamps.slice(1).some((s) => s.monotonicMs > windowEndMono)) {
      anomalies.push("extra_ctrl_c_during_cleanup");
    }
    const rawEvidenceComplete =
      cleanup.completed &&
      eventEvidenceWithinLimits &&
      harnessEvidenceOk &&
      stable.stableRead.stabilized &&
      !stable.read.missing;
    const integrityStatus = rawEvidenceComplete
      ? INTEGRITY_STATUS.COMPLETE
      : INTEGRITY_STATUS.INCOMPLETE;

    const elapsed = (mark) =>
      mark.observed && ctrlCMono !== null ? mark.monotonicMs - ctrlCMono : null;
    const machine = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      harnessImplementationVersion: HARNESS_IMPLEMENTATION_VERSION,
      runId,
      matrixCaseId: ctx.caseId,
      repetition: ctx.repetition,
      finalize_reason: reason,
      rawEvidenceComplete,
      integrity_status: integrityStatus,
      internal_failure: false,
      experiment_validity: validity,
      harness_anomalies: anomalies,
      interactive_delivery: interactiveDelivery,
      candidate_wrapper_completion: candidate,
      event_protocol_valid: v.eventProtocolValid,
      event_protocol_anomalies: v.eventProtocolAnomalies,
      process_relationship_valid: v.processRelationshipValid,
      process_relationship_anomalies: v.processRelationshipAnomalies,
      event_counts: {
        parsed: v.parsedEventCount,
        claimed: v.claimedEventCount,
        validated: v.validatedEventCount,
        rejected: v.rejectedEventCount,
        records: parsed.recordCount,
      },
      evidence_within_limits: { events: eventEvidenceWithinLimits, harness: harnessEvidenceOk },
      harness_event_write_error: obs.harnessEventWriteError,
      stable_read: stable.stableRead,
      observations: {
        fixture_sigint_recorded: fixtureSigintRecorded,
        fixture_exit_intent: v.sigint ? (v.sigint.exit_intent ?? null) : null,
        harness_sigint_received: obs.sigintStamps.length > 0,
        harness_sigint_count: obs.sigintStamps.length,
        wrapper_pid: obs.wrapperPid,
        fixture_pid: fixturePid,
        fixture_ppid: v.fixturePpid,
        fixture_parent_matches_wrapper: v.parentMatchesWrapper,
      },
      wrapper_exit: {
        observed: wrapperExit.observed,
        code: wrapperExit.code,
        signal: wrapperExit.signal,
        elapsed_after_ctrl_c_ms: elapsed(wrapperExit),
      },
      wrapper_close: {
        observed: wrapperClose.observed,
        code: wrapperClose.code,
        signal: wrapperClose.signal,
        elapsed_after_ctrl_c_ms: elapsed(wrapperClose),
      },
      wrapper_close_before_ctrl_c: wrapperCloseBeforeCtrlC,
      wrapper_exited_within_window: wrapperExitedWithinWindow,
      wrapper_closed_within_window: wrapperClosedWithinWindow,
      wrapper_alive_after_window: wrapperAlive,
      fixture_alive_after_window: fixtureAlive,
      fixture_survived_after_window: survivalFromLiveness(fixtureAlive),
      eligibility_constraints: ctx.eligibility,
      cleanup: serializableCleanup(cleanup),
      timing: {
        readyAt: obs.readyAt,
        firstHeartbeat: obs.firstHeartbeat,
        promptAt: obs.promptAt,
        ctrlCObservedAt: obs.ctrlCObservedAt,
        windowEndedAt: obs.windowEndedAt,
      },
    };
    writeEvidenceAtomic(join(rawDir, "result.machine.json"), machine);
    resultWritten = true;

    let sealed = false;
    let manifestDigest = null;
    let sealError = null;
    if (rawEvidenceComplete) {
      try {
        const manifestText = computeManifestText(rawDir, "raw");
        const manifestPath = join(bundleDir, "manifest.sha256");
        writeFileAtomic(manifestPath, manifestText);
        manifestDigest = verifyManifest(rawDir, "raw", { path: manifestPath });
        sealed = true;
      } catch (e) {
        sealError = e?.message ?? String(e);
      }
    }

    out("");
    out("----------------- run recorded -----------------");
    out(`  bundle                      : ${bundleDir}`);
    out(`  experiment_validity         : ${validity}`);
    out(`  interactive_delivery        : ${interactiveDelivery}`);
    out(`  candidate_wrapper_completion: ${candidate}`);
    out(
      `  integrity_status            : ${integrityStatus} (rawEvidenceComplete=${rawEvidenceComplete})`,
    );
    out(`  sealed (manifest verified)  : ${sealed}${manifestDigest ? ` [${manifestDigest}]` : ""}`);
    out("  NEXT: fill operator/result.operator.yaml + operator/console-observation.txt.");
    out("  Eligibility is a MATRIX-level conclusion (summarize-matrix.mjs), not this run.");
    out("------------------------------------------------");
    if (sealError !== null) {
      process.stderr.write(
        `decision7 harness: sealing failed after a complete raw result: ${sealError}\n`,
      );
    }
    process.exit(sealed ? EXIT_OK : EXIT_INCOMPLETE);
  };

  const emergency = async (reason, err) => {
    recordHarness({ type: "internal_failure", reason, message: err?.message ?? String(err) });
    let fixturePid = obs.fixturePid;
    try {
      if (rawDir !== null) {
        const r = readFileBounded(join(rawDir, "fixture-events.jsonl"), MAX_EVENT_FILE_BYTES);
        if (!r.missing && !r.truncated) {
          const v = validateFixtureEvents(
            parseJsonl(r.text, {
              maxLineBytes: MAX_LINE_BYTES,
              maxEvents: MAX_EVENTS,
              sourceTruncated: r.truncated,
            }),
            ids,
            obs.wrapperPid,
          );
          if (v.eventProtocolValid && v.fixturePid !== null) {
            fixturePid = v.fixturePid;
          }
        }
      }
    } catch {
      // best-effort recovery of the token-bound fixture pid
    }
    let cleanup = null;
    try {
      cleanup = await cleanupOnce(fixturePid);
    } catch (e) {
      cleanup = { completed: false, error: e?.message ?? String(e) };
    }
    freezeHarnessWriters();
    try {
      if (rawDir !== null && !resultWritten) {
        const machine = {
          schemaVersion: RESULT_SCHEMA_VERSION,
          harnessImplementationVersion: HARNESS_IMPLEMENTATION_VERSION,
          runId,
          matrixCaseId: ctx.caseId,
          repetition: ctx.repetition,
          finalize_reason: reason,
          rawEvidenceComplete: false,
          integrity_status: INTEGRITY_STATUS.INCOMPLETE,
          internal_failure: true,
          experiment_validity: EXPERIMENT_VALIDITY.INDETERMINATE,
          harness_anomalies: [`internal_failure:${err?.message ?? String(err)}`],
          interactive_delivery: INTERACTIVE_DELIVERY.INDETERMINATE,
          candidate_wrapper_completion: CANDIDATE_WRAPPER_COMPLETION.INDETERMINATE,
          cleanup: serializableCleanup(cleanup),
        };
        writeEvidenceAtomic(join(rawDir, "result.machine.json"), machine);
        resultWritten = true;
        if (cleanup?.completed) {
          try {
            const manifestPath = join(bundleDir, "manifest.sha256");
            writeFileAtomic(manifestPath, computeManifestText(rawDir, "raw"));
            verifyManifest(rawDir, "raw", { path: manifestPath });
          } catch {
            // best-effort tamper-evidence over an explicitly-incomplete bundle
          }
        }
      }
    } catch {
      // best-effort emergency result
    }
    process.stderr.write(`decision7 harness: internal failure (${reason}): ${err?.stack ?? err}\n`);
    process.exit(EXIT_INTERNAL);
  };

  // Allocation (exit 2 on failure) is OUTSIDE the emergency boundary.
  transition("confirmed");
  try {
    mkdirSync(ctx.caseDir, { recursive: true });
    mkdirSync(bundleDir);
  } catch (error) {
    const removed = removeTempDir(ctx.tempDir);
    const note = removed ? "" : ` [ALSO: could not remove temp dir ${ctx.tempDir}]`;
    if (error?.code === "EEXIST") {
      fail(`evidence bundle already exists: ${bundleDir} (use --new-attempt)${note}`);
      return;
    }
    fail(`cannot allocate evidence bundle ${bundleDir}: ${error?.message ?? error}${note}`);
    return;
  }
  bundleAllocated = true;

  try {
    rawDir = join(bundleDir, "raw");
    const operatorDir = join(bundleDir, "operator");
    mkdirSync(rawDir);
    mkdirSync(operatorDir);
    harnessEventsPath = join(rawDir, "harness-events.jsonl");
    for (const line of harnessBuffer) {
      appendFileSync(harnessEventsPath, line, "utf8");
    }
    const eventFile = join(rawDir, "fixture-events.jsonl");
    writeFileSync(eventFile, "", { encoding: "utf8", flag: "wx" });
    transition("bundle_allocated");

    const operatorTemplate = buildOperatorTemplate(runId, ctx.caseId, ctx.repetition);
    const consoleTemplate = buildConsoleTemplate();
    writeFileAtomic(join(operatorDir, "result.operator.yaml"), operatorTemplate);
    writeFileAtomic(join(operatorDir, "console-observation.txt"), consoleTemplate);
    const metadata = buildMetadata(ctx, {
      runId,
      leaf,
      attemptCreatedAt,
      attemptTimestamp,
      operatorTemplateSha256: sha256String(operatorTemplate),
      consoleTemplateSha256: sha256String(consoleTemplate),
    });
    writeEvidenceAtomic(join(rawDir, "metadata.json"), metadata);

    process.on("SIGINT", sigintHandler);

    const child = spawn(ctx.plan.command, ctx.plan.args, {
      shell: false,
      windowsVerbatimArguments: true,
      stdio: "inherit",
      detached: false,
      env: {
        ...process.env,
        DECISION7_RUN_ID: runId,
        DECISION7_TOKEN: token,
        DECISION7_EVENT_FILE: eventFile,
        DECISION7_HEARTBEAT_MS: String(ctx.config.heartbeatMs),
      },
    });
    obs.wrapperPid = child.pid ?? null;
    child.on("exit", (code, signal) => {
      obs.wrapperExit = { observed: true, code, signal, monotonicMs: performance.now() };
    });
    child.on("close", (code, signal) => {
      obs.wrapperClose = { observed: true, code, signal, monotonicMs: performance.now() };
    });
    child.on("error", (e) => {
      obs.spawnError = e.message;
    });
    recordHarness({ type: "spawned", wrapperPid: obs.wrapperPid, command: ctx.plan.command });
    transition("spawned");

    const readiness = await awaitReadiness(ctx, eventFile, ids, obs);
    if (readiness.status === "harness_evidence_failure") {
      await finalize("harness_evidence_failure");
      return;
    }
    if (readiness.status === "spawn_error") {
      await finalize("spawn_error");
      return;
    }
    if (readiness.status === "truncated") {
      await finalize("event_file_truncated");
      return;
    }
    if (readiness.status === "timeout") {
      await finalize("readiness_timeout");
      return;
    }
    obs.readyAt = nowStamp();
    obs.fixturePid = readiness.fixturePid;
    obs.firstHeartbeat = readiness.firstHeartbeat;
    recordHarness({
      type: "readiness_observed",
      fixturePid: obs.fixturePid,
      parentMatchesWrapper: readiness.parentMatchesWrapper,
    });
    transition("ready");

    obs.promptAt = nowStamp();
    out(
      `\nFixture READY (agent pid ${obs.fixturePid}). Press Ctrl+C ONCE now. Do NOT press any other key for ${ctx.config.observationSeconds}s after.`,
    );
    transition("awaiting_ctrl_c");
    const ctrlC = await awaitCtrlC(ctx, obs);
    if (ctrlC === "harness_evidence_failure") {
      await finalize("harness_evidence_failure");
      return;
    }
    if (ctrlC === "timeout") {
      await finalize("operator_response_timeout");
      return;
    }
    recordHarness({ type: "observation_window_start", seconds: ctx.config.observationSeconds });
    transition("observing");
    const windowResult = await observeWindow(ctx, obs);
    obs.windowEndedAt = nowStamp();
    recordHarness({ type: "observation_window_end" });
    transition("classified");
    await finalize(
      windowResult === "harness_evidence_failure"
        ? "harness_evidence_failure"
        : "observation_complete",
    );
  } catch (err) {
    await emergency("internal_failure", err);
  }
}

async function main() {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (process.platform !== "win32") {
    fail("Decision 7 Stage A requires Windows with an inherited interactive console.");
  }
  if (sub === "attest") {
    await attest(rest);
    return;
  }
  if (sub === "preflight") {
    await runPreflightOnly(rest);
    return;
  }
  if (sub === "run") {
    await executeRun(rest);
    return;
  }
  fail(`unknown subcommand: ${sub ?? "(none)"}\n\n${USAGE}`);
}

main().catch((err) => {
  fail(`unexpected failure: ${err?.stack ?? err}`, EXIT_PREFLIGHT);
});
