#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// scripts/mcp-stdio-probe.mjs -- Phase 12f Node-side MCP stdio probe.
//
// Driven by scripts/smoke-test.ps1. PowerShell owns smoke
// orchestration AND product-shape invariant checks (8-tool order,
// reserved-name hiding, Cat 2 denial shapes, audit record contracts,
// R31 reflection locks). This script owns the transport contract:
// spawn the packed viberevert MCP server as a direct node child,
// drive an interactive request-response transcript via UTF-8 Buffer
// writes, capture diagnostics, enforce close code 0 + empty stderr.
//
// Single source of truth: PowerShell writes the input transcript
// to --input as no-BOM UTF-8 JSONL. This probe reads --input and
// dispatches each line as a frame in order. There is no embedded
// frame catalog. Frames whose JSON has a null/undefined id are
// notifications and produce no response; all others are requests
// and the probe waits for a response with matching id before
// sending the next frame. Since the transcript is serialized, any
// response with an id different from the expected one is treated
// as an immediate protocol failure -- only id-less notifications
// are tolerated side frames.
//
// Architectural rationale: PowerShell 5.1's Process.StandardInput
// auto-StreamWriter was injecting a UTF-8 BOM preamble before our
// first JSON-RPC frame on GHA windows-latest, causing the SDK's
// JSON.parse to reject the initialize frame. Moving the byte-level
// transport into Node eliminates every PowerShell/.NET encoding
// variable.
//
// Dependency-free: built-ins only (node:child_process, node:fs,
// node:process).
//
// CLI args (all required, --flag value form):
//   --cwd <path>     scratch dir; child process cwd; .viberevert/ lives here
//   --entry <path>   absolute path to node_modules/viberevert/dist/index.js
//   --input <path>   read input transcript JSONL from here (PowerShell wrote it)
//   --output <path>  write received responses as JSONL here (PowerShell parses)
//   --stderr <path>  write child stderr here (diagnostic)
//   --audit <path>   path to .viberevert/mcp-audit.log (used in failure diagnostics)
//
// Strictness:
//   - --input must not start with UTF-8 BOM (EF BB BF).
//   - --input must not contain duplicate JSON-RPC ids.
//   - stdout must contain exactly one response per request id, in
//     send order. Out-of-order or duplicate response ids fail
//     immediately (serialized transcript invariant).
//   - Non-JSON stdout lines are protocol corruption (D99.D).
//   - Top-level JSON-RPC error envelopes on responses are rejected
//     (D99.O: Cat 2 denials use result.isError on success envelope).
//   - Trailing stdout lines after all expected responses fail.
//   - Child must close (stdio fully drained) with code 0 and empty
//     stderr.
//
// Lifecycle:
//   - The childClosePromise is registered IMMEDIATELY after spawn
//     to avoid missing an early close.
//   - The final wait uses the "close" event, not "exit", so stdio
//     is fully drained before we read stderrBuf or the trailing
//     stdout queue.
//   - On failure (transcript or post-close check), we kill the
//     child tree, then await close (5s cap) before writing
//     artifacts so mcp-stderr.txt is complete.
//
// Exit codes:
//   0 -- all expected responses received exactly once, child closed
//        with code 0, stderr empty, no trailing stdout lines
//   1 -- any failure; stderr carries the diagnostic
//
// On success this script writes NOTHING to its own stdout or
// stderr. PowerShell asserts this (silent-on-success contract).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

// ============================================================================
// CLI argument parsing
// ============================================================================

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (typeof key !== "string" || !key.startsWith("--")) {
      throw new Error(`expected --flag at argv[${i}], got: ${key}`);
    }
    if (value === undefined) {
      throw new Error(`missing value for ${key}`);
    }
    out[key.slice(2)] = value;
  }
  for (const required of ["cwd", "entry", "input", "output", "stderr", "audit"]) {
    if (typeof out[required] !== "string" || out[required].length === 0) {
      throw new Error(`missing required arg: --${required}`);
    }
  }
  return out;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`mcp-stdio-probe: argument parse error: ${err.message}\n`);
  process.exit(1);
}

const PER_RESPONSE_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 30_000;
const FAILURE_CLOSE_WAIT_MS = 5_000;

// ============================================================================
// Pre-flight
// ============================================================================

if (!existsSync(args.entry)) {
  process.stderr.write(`mcp-stdio-probe: viberevert entry not found: ${args.entry}\n`);
  process.exit(1);
}
if (!existsSync(args.input)) {
  process.stderr.write(`mcp-stdio-probe: input transcript not found: ${args.input}\n`);
  process.exit(1);
}

// ============================================================================
// Read + BOM-guard + parse input
// ============================================================================

const inputBytes = readFileSync(args.input);

if (
  inputBytes.length >= 3 &&
  inputBytes[0] === 0xef &&
  inputBytes[1] === 0xbb &&
  inputBytes[2] === 0xbf
) {
  process.stderr.write(
    `mcp-stdio-probe: --input starts with UTF-8 BOM (EF BB BF). PowerShell must write with UTF8Encoding($false). Path: ${args.input}\n`,
  );
  process.exit(1);
}

const inputText = inputBytes.toString("utf8");
const inputLines = inputText
  .split("\n")
  .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
  .filter((line) => line.trim().length > 0);

if (inputLines.length === 0) {
  process.stderr.write(`mcp-stdio-probe: --input has no non-empty frames: ${args.input}\n`);
  process.exit(1);
}

const frames = [];
const seenInputIds = new Set();
for (let i = 0; i < inputLines.length; i++) {
  const line = inputLines[i];
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    process.stderr.write(
      `mcp-stdio-probe: --input line ${i + 1} is not valid JSON: ${JSON.stringify(line)}\n`,
    );
    process.exit(1);
  }
  const expectsResponse = parsed.id !== undefined && parsed.id !== null;
  if (expectsResponse) {
    const key = String(parsed.id);
    if (seenInputIds.has(key)) {
      process.stderr.write(
        `mcp-stdio-probe: --input contains duplicate JSON-RPC id ${key} (line ${i + 1})\n`,
      );
      process.exit(1);
    }
    seenInputIds.add(key);
  }
  frames.push({ line, expectsResponse, id: expectsResponse ? parsed.id : null });
}

const expectedIds = frames.filter((f) => f.expectsResponse).map((f) => String(f.id));

// ============================================================================
// Spawn + wire (close listener + error handler registered IMMEDIATELY)
// ============================================================================

const child = spawn(process.execPath, [args.entry, "mcp", "serve"], {
  cwd: args.cwd,
  stdio: ["pipe", "pipe", "pipe"],
});

let childSpawnError = null;
child.on("error", (err) => {
  childSpawnError = err;
});

const childClosePromise = new Promise((resolve) => {
  child.once("close", (code, signal) => {
    resolve({ code, signal });
  });
});

function getSpawnErrorText() {
  return childSpawnError
    ? `\nChild spawn error: ${childSpawnError.name}: ${childSpawnError.message}`
    : "";
}

let stderrBuf = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrBuf += chunk;
});

const stdoutQueue = [];
let stdoutResolver = null;
let stdoutEOF = false;
let stdoutBuf = Buffer.alloc(0);

function pushLine(line) {
  if (stdoutResolver) {
    const r = stdoutResolver;
    stdoutResolver = null;
    r(line);
  } else {
    stdoutQueue.push(line);
  }
}

child.stdout.on("data", (chunk) => {
  stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
  for (;;) {
    const lfIdx = stdoutBuf.indexOf(0x0a);
    if (lfIdx === -1) break;
    const lineBytes = stdoutBuf.subarray(0, lfIdx);
    stdoutBuf = stdoutBuf.subarray(lfIdx + 1);
    const trimmed =
      lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 0x0d
        ? lineBytes.subarray(0, lineBytes.length - 1)
        : lineBytes;
    pushLine(trimmed.toString("utf8"));
  }
});
child.stdout.on("end", () => {
  if (stdoutBuf.length > 0) {
    pushLine(stdoutBuf.toString("utf8"));
    stdoutBuf = Buffer.alloc(0);
  }
  stdoutEOF = true;
  if (stdoutResolver) {
    const r = stdoutResolver;
    stdoutResolver = null;
    r(null);
  }
});

function readNextLine(timeoutMs) {
  return new Promise((resolve, reject) => {
    if (stdoutQueue.length > 0) {
      resolve(stdoutQueue.shift());
      return;
    }
    if (stdoutEOF) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      stdoutResolver = null;
      reject(new Error(`timeout after ${timeoutMs}ms waiting for stdout line`));
    }, timeoutMs);
    stdoutResolver = (line) => {
      clearTimeout(timer);
      resolve(line);
    };
  });
}

function sendFrame(frame) {
  return new Promise((resolve, reject) => {
    child.stdin.write(Buffer.from(`${frame.line}\n`, "utf8"), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function waitForResponse(expectedId) {
  const deadline = Date.now() + PER_RESPONSE_TIMEOUT_MS;
  const sideFrames = [];
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    let line;
    try {
      line = await readNextLine(remaining);
    } catch (err) {
      throw new Error(
        `expected response id=${expectedId}: ${err.message}${sideFrames.length ? `; side frames: ${JSON.stringify(sideFrames)}` : ""}${getSpawnErrorText()}`,
      );
    }
    if (line === null) {
      throw new Error(
        `stdout EOF before response id=${expectedId} received${sideFrames.length ? `; side frames: ${JSON.stringify(sideFrames)}` : ""}${getSpawnErrorText()}`,
      );
    }
    if (line.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(
        `non-JSON stdout line (protocol corruption per D99.D): ${JSON.stringify(line)}`,
      );
    }
    if (parsed.id === undefined || parsed.id === null) {
      // Notification — tolerated side frame; keep waiting.
      sideFrames.push(line);
      continue;
    }
    const actualKey = String(parsed.id);
    if (actualKey !== String(expectedId)) {
      // STRICT: serialized transcript means any non-matching id at
      // this point is invalid (out-of-order or duplicate).
      throw new Error(
        `expected response id=${expectedId}, got id=${actualKey} on serialized request-response transcript (out-of-order or duplicate response). Line: ${JSON.stringify(line)}`,
      );
    }
    if (parsed.error !== undefined) {
      throw new Error(
        `expected JSON-RPC success envelope for id=${expectedId} (D99.O), got top-level error: ${JSON.stringify(parsed.error)}`,
      );
    }
    return parsed;
  }
  throw new Error(
    `timeout after ${PER_RESPONSE_TIMEOUT_MS}ms waiting for response id=${expectedId}${getSpawnErrorText()}`,
  );
}

// ============================================================================
// Diagnostic + cleanup helpers
// ============================================================================

function getAuditDump() {
  if (!existsSync(args.audit)) {
    return `\nAudit log (${args.audit}): NOT PRESENT (server failed before openAuditLog ran -- very early boot failure)`;
  }
  try {
    return `\nAudit log (${args.audit}):\n${readFileSync(args.audit, "utf8")}`;
  } catch (err) {
    return `\nAudit log (${args.audit}): PRESENT but unreadable: ${err.name}: ${err.message}`;
  }
}

function writeArtifacts(responses) {
  const outputBody =
    responses.length > 0 ? `${responses.map((r) => JSON.stringify(r)).join("\n")}\n` : "";
  writeFileSync(args.output, outputBody, { encoding: "utf8" });
  writeFileSync(args.stderr, stderrBuf, { encoding: "utf8" });
}

function killChildTree() {
  try {
    if (process.platform === "win32") {
      if (child.pid) {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      }
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // best-effort
  }
}

function awaitCloseOrTimeout(timeoutMs) {
  return Promise.race([
    childClosePromise,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

// ============================================================================
// Main flow
// ============================================================================

const receivedResponses = [];
const receivedIds = new Set();

try {
  for (const frame of frames) {
    await sendFrame(frame);
    if (frame.expectsResponse) {
      const resp = await waitForResponse(frame.id);
      const key = String(resp.id);
      if (receivedIds.has(key)) {
        throw new Error(`duplicate response received for id=${key}`);
      }
      receivedIds.add(key);
      receivedResponses.push(resp);
    }
  }

  child.stdin.end();

  // Wait for close (not exit) so stdio is fully drained.
  const closeInfo = await Promise.race([
    childClosePromise.then((info) => ({ ...info, timedOut: false })),
    new Promise((resolve) =>
      setTimeout(() => {
        killChildTree();
        resolve({ code: null, signal: null, timedOut: true });
      }, CLOSE_TIMEOUT_MS),
    ),
  ]);

  // If we killed on timeout, wait briefly for close to settle so
  // stderrBuf reflects everything the child emitted.
  if (closeInfo.timedOut) {
    await awaitCloseOrTimeout(FAILURE_CLOSE_WAIT_MS);
  }

  // Trailing-line check: any queued stdout lines after close are
  // unexpected (server emitted more than expected responses).
  const trailingLines = [];
  while (stdoutQueue.length > 0) {
    const line = stdoutQueue.shift();
    if (line !== null && line.trim().length > 0) {
      trailingLines.push(line);
    }
  }

  writeArtifacts(receivedResponses);

  if (closeInfo.timedOut) {
    process.stderr.write(
      `mcp-stdio-probe failure: MCP server did not close within ${CLOSE_TIMEOUT_MS}ms after stdin close; killed via taskkill /T /F.${getAuditDump()}${getSpawnErrorText()}\nStderr:\n${stderrBuf}\n`,
    );
    process.exit(1);
  }
  if (closeInfo.code !== 0) {
    process.stderr.write(
      `mcp-stdio-probe failure: MCP server closed with code ${closeInfo.code}${closeInfo.signal ? ` signal ${closeInfo.signal}` : ""} after stdin close (expected 0).${getAuditDump()}${getSpawnErrorText()}\nStderr:\n${stderrBuf}\n`,
    );
    process.exit(1);
  }
  if (stderrBuf.trim().length > 0) {
    process.stderr.write(
      `mcp-stdio-probe failure: expected EMPTY stderr on successful MCP serve (D99.M.14 -- mcp library MUST NOT write to process.stderr; CLI MCPCommand only writes stderr on failure paths). Got:\n${stderrBuf}\n`,
    );
    process.exit(1);
  }
  if (trailingLines.length > 0) {
    process.stderr.write(
      `mcp-stdio-probe failure: server emitted ${trailingLines.length} unexpected stdout line(s) after all ${expectedIds.length} expected response(s): ${JSON.stringify(trailingLines)}\n`,
    );
    process.exit(1);
  }
  if (receivedResponses.length !== expectedIds.length) {
    process.stderr.write(
      `mcp-stdio-probe failure: expected ${expectedIds.length} responses, got ${receivedResponses.length} (internal logic error in transcript loop)\n`,
    );
    process.exit(1);
  }

  process.exit(0);
} catch (err) {
  killChildTree();
  // Wait for child close (5s cap) so stderrBuf is complete before
  // we write mcp-stderr.txt.
  await awaitCloseOrTimeout(FAILURE_CLOSE_WAIT_MS);
  writeArtifacts(receivedResponses);
  process.stderr.write(
    `mcp-stdio-probe failure: ${err.message}${getAuditDump()}${getSpawnErrorText()}\nStderr captured before failure:\n${stderrBuf}\n`,
  );
  process.exit(1);
}
