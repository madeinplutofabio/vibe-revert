// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// In-process Clipanion harness for the @viberevert/mcp `command-harness`
// backend (M G1a D99.E). Runs a single Command class against a captured
// stdout/stderr without leaking output to the host process and without
// blowing memory on pathological output volumes.
//
// =============================================================================
// Why this exists
// =============================================================================
//
// MCP's `command-harness` backend (D99.E) wraps Commands whose `--json`
// output already carries everything the MCP envelope needs (check_repo,
// explain_diff, classify_risk, list_risky_files). The harness must:
//
//   - Run the Command in the SAME process (no `child_process.spawn` —
//     D99.M.2 forbids it).
//   - Capture stdout as raw bytes (D81 byte-identity for any future
//     binary/non-ASCII outputs).
//   - Capture stderr as decoded UTF-8 text (diagnostic).
//   - Cap captured bytes per stream (D99.W: 8 MiB stdout / 512 KiB
//     stderr defaults) so a runaway Command can't OOM the MCP server.
//   - NEVER forward to the running process's real stdout/stderr (D99.X
//     — would corrupt MCP's stdio protocol framing).
//   - Bind `process.cwd()` to a caller-supplied directory for the
//     execution window (all 14 vibe-revert Commands read `process.cwd()`
//     directly via `resolveRepoRoot()`; the harness chdir-restores).
//   - Faithfully surface exit codes AND unexpected throws — never
//     squash crashes as "exit 1".
//
// =============================================================================
// Locked design (D99.W + D99.X + supporting locks)
// =============================================================================
//
// 1. **Bounded sinks (D99.W).** Custom Writable subclasses with
//    drain-and-discard backpressure: writes are always accepted (no
//    blocking), but bytes past the cap are silently dropped and
//    counted into `bytesOmitted`. Partial-chunk preservation: if a
//    write straddles the cap, the prefix that fits is kept and only
//    the overflow is discarded. Byte counting uses `chunk.byteLength`
//    (Buffer/Uint8Array) or `Buffer.byteLength(str, encoding)`
//    (string) — NEVER `.length` (which counts UTF-16 code units and
//    is wrong for multi-byte chars). Captured chunks are defensively
//    COPIED (`Buffer.from(chunk)`) so a caller mutating the original
//    Buffer after the write can't retroactively change the snapshot.
//
// 2. **No forwarding (D99.X).** The bounded sinks are the ONLY
//    Writable destinations for the Command's `context.stdout.write` /
//    `context.stderr.write` calls. The real `process.stdout` /
//    `process.stderr` are never touched. Substep 7's test
//    monkey-patches `process.std{out,err}.write` and asserts zero
//    calls when a noisy Command runs.
//
// 3. **cwd binding via process.chdir + mandatory restore.** Bound at
//    function entry, restored in `finally` (covers both success and
//    rethrown Command failures). The 11 non-operation-extracted
//    Commands (check, report, end, init, doctor, checkpoints,
//    sessions, version, hook-install, hook-uninstall, rollback) read
//    `process.cwd()` directly; the harness MUST replace it for the
//    execution window. The 3 operation-extracted Commands (start,
//    checkpoint, prompt-fix) call into operations that take explicit
//    `opts.cwd`, but the Commands still pass `process.cwd()` as
//    `opts.cwd` — so the chdir still binds correctly for them.
//
//    `opts.cwd` MUST be absolute. Relative paths reject the returned
//    Promise with a RangeError BEFORE the mutex is acquired. A
//    relative `cwd` is process-global state by definition — it
//    resolves against whatever `process.cwd()` is at call time,
//    which the harness itself temporarily mutates. Enforcing absolute
//    eliminates this foot-gun for MCP callers (who always pass
//    resolved repo roots via D99.P boot-time binding) and any future
//    caller.
//
// 4. **Module-level FIFO serialization mutex.** Because the harness
//    uses `process.chdir` (a single global resource), TWO concurrent
//    `runCommandInProcess` calls would race on `process.cwd()` — the
//    second's chdir would clobber the first's view mid-execution.
//    A module-level Promise-chain lock serializes the entire
//    cwd-bound execution window. Other MCP backends
//    (`direct-core` for get_policy, `typed-operation` for the 3
//    write tools) don't use this harness and can run concurrently.
//
//    Trade-off accepted for v0.7.0-beta: harness-driven MCP tools
//    (the 4 read-only `command-harness` ones) execute sequentially.
//    M G2+ may introduce a context-cwd refactor (all 14 Commands
//    read `this.context.cwd` instead of `process.cwd()`) which would
//    eliminate the need for chdir + the mutex.
//
// 5. **Input validation up front.** Negative, non-integer, NaN, or
//    Infinity caps reject the Promise with a `RangeError` BEFORE any
//    chdir or Command execution. Same treatment for non-absolute
//    `cwd`. Programmer-error class; no recovery path.
//
// 6. **No host state mutation.** `argv` is shallow-copied via spread
//    before passing to `cli.run`. `env` is shallow-copied from
//    `process.env`. Neither the host's `process.argv` nor
//    `process.env` is exposed by reference to the Command.
//
// 7. **Per-call `new Cli(...)`.** Locked by D99.F. Only the target
//    Command is registered; no singleton sharing.
//
// 8. **Encoding contract.** stdout returned as raw `Buffer` (bytes
//    for D81 byte-identity). stderr returned as UTF-8 string,
//    decoded once at the end via `Buffer.concat(chunks).toString("utf8")`.
//    If a stderr cap severs a multi-byte UTF-8 sequence, the
//    decoded boundary may carry a U+FFFD replacement char —
//    tolerable because stderr is diagnostic, not structured.
//
// 9. **Faithful exit / throw behavior.**
//    - Command returns a number from `execute()` (or undefined,
//      treated as 0 via nullish coalescing): captured into
//      `result.exitCode`.
//    - Command's `execute()` THROWS an unexpected error: propagates
//      unwrapped through `cli.run`; the harness rethrows. Caller
//      maps to MCP envelope or surfaces as crash. NEVER squashed
//      into "exit 1".

import { isAbsolute, resolve } from "node:path";
import { PassThrough, type Readable, Writable } from "node:stream";

import { type BaseContext, Cli, type CommandClass } from "clipanion";

// =============================================================================
// Cap validation
// =============================================================================

const DEFAULT_STDOUT_CAP = 8 * 1024 * 1024; // 8 MiB
const DEFAULT_STDERR_CAP = 512 * 1024; //       512 KiB

function validateCap(name: string, cap: number): void {
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new RangeError(
      `runCommandInProcess: ${name} must be a non-negative safe integer; got ${String(cap)}`,
    );
  }
}

// =============================================================================
// Module-level FIFO serialization mutex (D99.W lock #4)
// =============================================================================

/**
 * Tail of the FIFO promise chain. Each `withRunCommandInProcessLock`
 * call awaits the prior tail (its slot in the queue), then runs `fn`,
 * then releases its slot. Module-scoped so a single VM-wide queue
 * serializes ALL `runCommandInProcess` invocations across every
 * caller in the process — required because `process.chdir` is a
 * VM-wide global resource.
 */
let runCommandInProcessTail: Promise<void> = Promise.resolve();

async function withRunCommandInProcessLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void = () => {};
  const previous = runCommandInProcessTail;
  runCommandInProcessTail = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

// =============================================================================
// BoundedSink — Writable subclass with drain-and-discard backpressure
// =============================================================================

/**
 * Custom Writable that captures up to `cap` bytes into memory and
 * silently discards overflow. ALWAYS calls the write callback
 * synchronously — the upstream Command never blocks on backpressure.
 * NEVER throws inside `_write` — bounded-sink failure is by design
 * silent (the truncated flag + bytesOmitted are the signal).
 *
 * Byte counting (D99.W lock #1):
 *   - Buffer / Uint8Array chunks: `chunk.byteLength`.
 *   - String chunks: `Buffer.byteLength(chunk, encoding)`.
 *   - NEVER `.length` (which is UTF-16 code-unit count — wrong for
 *     multi-byte characters).
 *
 * Default Writable settings — `decodeStrings: true` — convert string
 * chunks to Buffer BEFORE `_write` is called, using the provided
 * encoding. So inside `_write`, the chunk is always Buffer (or
 * Uint8Array if the upstream passes one). Defensive narrowing covers
 * both.
 *
 * Captured chunks are defensively COPIED via `Buffer.from(...)` so a
 * caller that writes a mutable Buffer and modifies it AFTER the
 * write call returns can't retroactively change our snapshot.
 */
class BoundedSink extends Writable {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private omittedBytes = 0;
  private isTruncated = false;

  constructor(private readonly cap: number) {
    super();
  }

  override _write(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    // Normalize to Buffer. With default `decodeStrings: true`,
    // strings have already been converted to Buffer using `encoding`
    // before this method runs — so the string branch is defensive
    // (covers a future configuration change or a direct .write(str)
    // path that bypasses the conversion).
    let buf: Buffer;
    if (Buffer.isBuffer(chunk)) {
      buf = chunk;
    } else if (chunk instanceof Uint8Array) {
      buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else {
      buf = Buffer.from(chunk, encoding);
    }

    const remaining = this.cap - this.capturedBytes;
    if (remaining >= buf.byteLength) {
      // Entire chunk fits within the remaining cap budget. Defensive
      // copy so the caller can mutate the original buffer after the
      // write without retroactively changing our snapshot.
      this.chunks.push(Buffer.from(buf));
      this.capturedBytes += buf.byteLength;
    } else if (remaining > 0) {
      // Partial-chunk preservation: keep the prefix that fits, count
      // only the overflow as omitted. `subarray` is a view; wrap in
      // `Buffer.from` to materialize an owned copy.
      this.chunks.push(Buffer.from(buf.subarray(0, remaining)));
      this.capturedBytes += remaining;
      this.omittedBytes += buf.byteLength - remaining;
      this.isTruncated = true;
    } else {
      // Cap full — discard everything; count it all as omitted.
      this.omittedBytes += buf.byteLength;
      this.isTruncated = true;
    }

    // Always succeed; never block. The Command's
    // context.stdout/stderr.write() call returns immediately.
    callback();
  }

  /** Return the captured bytes as a single concatenated Buffer. */
  asBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Decode the captured bytes as UTF-8. May end with U+FFFD if the
   *  cap severed a multi-byte sequence — tolerable per D99.W lock #8. */
  asString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  get bytesOmitted(): number {
    return this.omittedBytes;
  }

  get truncated(): boolean {
    return this.isTruncated;
  }
}

// =============================================================================
// Public surface
// =============================================================================

export type RunCommandInProcessOpts = {
  /** Directory to bind as `process.cwd()` for the Command's execution
   *  window. MUST be an absolute path; relative paths reject the
   *  returned Promise with a RangeError BEFORE the mutex is acquired.
   *  Rationale: a relative `cwd` is process-global state by
   *  definition — it resolves against whatever `process.cwd()`
   *  happens to be at call time, which the harness itself temporarily
   *  mutates. The harness normalizes the accepted absolute path via
   *  `path.resolve` (no-op on already-absolute paths). Restored to
   *  the prior cwd in `finally`. */
  cwd: string;
  /** Bounded stdout capture cap in BYTES. Default 8 MiB. Must be a
   *  non-negative safe integer; otherwise a RangeError rejects the
   *  Promise BEFORE any side effects. */
  stdoutCap?: number;
  /** Bounded stderr capture cap in BYTES. Default 512 KiB. Same
   *  validation as stdoutCap. */
  stderrCap?: number;
};

export type RunCommandInProcessResult = {
  /** The Command's exit code. Always a number — Clipanion's possible
   *  `undefined` (from a Command's `execute()` returning void) is
   *  normalized to 0 via nullish coalescing. */
  exitCode: number;
  /** Captured stdout bytes (raw `Buffer`; up to `stdoutCap`). Bytes
   *  for byte-identity contracts (D81 prompt-fix). NEVER decoded to
   *  string at this layer — the consumer (MCP handler) decodes at the
   *  envelope boundary if the schema expects string. */
  stdoutBytes: Buffer;
  /** Captured stderr decoded as UTF-8 (up to `stderrCap` bytes). May
   *  end with U+FFFD replacement char if the cap severed a multi-byte
   *  sequence. */
  stderrText: string;
  stdoutTruncated: boolean;
  stdoutBytesOmitted: number;
  stderrTruncated: boolean;
  stderrBytesOmitted: number;
};

/**
 * Run a single Clipanion Command in-process with captured stdout/stderr.
 *
 * Locks (see file header for full discussion):
 *   - D99.W bounded sinks (cap + drain-and-discard)
 *   - D99.X capture-never-forwards (no real process.std{out,err} writes)
 *   - D99.F per-call `new Cli`
 *   - VM-wide FIFO serialization (process.chdir requires it)
 *   - Cap validation up front
 *   - Absolute cwd enforcement (relative paths reject with RangeError)
 *   - cwd resolve + chdir + mandatory restore (even on rethrow)
 *   - Faithful exit code AND faithful unexpected-throw passthrough
 *   - argv/env shallow-copied so host state can't be mutated by reference
 */
export async function runCommandInProcess(
  commandClass: CommandClass<BaseContext>,
  argv: readonly string[],
  opts: RunCommandInProcessOpts,
): Promise<RunCommandInProcessResult> {
  const stdoutCap = opts.stdoutCap ?? DEFAULT_STDOUT_CAP;
  const stderrCap = opts.stderrCap ?? DEFAULT_STDERR_CAP;

  // Cap validation BEFORE any side effects (no chdir, no Command
  // execution). Programmer error — rejects the returned Promise.
  validateCap("stdoutCap", stdoutCap);
  validateCap("stderrCap", stderrCap);

  // Enforce absolute `cwd` BEFORE any side effects (no mutex entry,
  // no chdir, no Command execution). Relative paths are
  // process-global state by definition — see file header section 3.
  // Programmer error: rejects the returned Promise.
  if (!isAbsolute(opts.cwd)) {
    throw new RangeError(
      `runCommandInProcess: cwd must be an absolute path; got ${JSON.stringify(opts.cwd)}`,
    );
  }
  // `resolve` is a no-op on already-absolute paths but normalizes
  // any leftover `..`/`.` segments.
  const cwd = resolve(opts.cwd);

  return withRunCommandInProcessLock(async () => {
    const stdoutSink = new BoundedSink(stdoutCap);
    const stderrSink = new BoundedSink(stderrCap);

    // Empty stdin — Commands that read from stdin (none of vibe-revert's
    // do at the time of M G1a) would see EOF immediately.
    const stdin = new PassThrough();
    stdin.end();

    // Shallow-copy argv and env so the Command can't mutate the host's
    // process.argv / process.env via shared reference. Per D99.W lock #6.
    const commandArgv = [...argv];
    const env = { ...process.env };

    const cli = new Cli<BaseContext>({
      binaryName: "viberevert",
      binaryLabel: "VibeRevert",
      binaryVersion: "0.0.0",
      // Deterministic: NEVER let clipanion auto-infer color support
      // from the env. The harness captures into bounded memory
      // sinks; ANSI codes would corrupt the captured-byte contract
      // and also leak into MCP envelopes downstream. Setting
      // explicitly also keeps `command.cli.enableColors` non-
      // undefined so the bridge's conditional-spread always
      // includes the field — see the D99.X regression test in
      // run-command-in-process.test.ts.
      enableColors: false,
    });
    cli.register(commandClass);

    const originalCwd = process.cwd();
    // chdir is synchronous; if it throws (e.g., ENOENT on a missing
    // cwd), originalCwd was never replaced and the finally restore is
    // unnecessary. The try block runs only AFTER chdir succeeds, so
    // the restore in finally is always valid when reached.
    process.chdir(cwd);
    try {
      // Use cli.process() + command.validateAndExecute() instead of
      // cli.run() so an unexpected Command throw propagates to us
      // with OBJECT IDENTITY preserved. cli.run() wraps execute in
      // a try/catch that converts thrown errors into a stderr
      // write + exit code 1 — which would force MCP's envelope
      // mapping to screen-scrape stderr to recover the typed error
      // class. D99.E forbids that. The file-header lock #5
      // ("faithfully surface unexpected throws") requires the
      // exception object to reach the caller as an instanceof-able
      // class instance.
      //
      // We MUST mirror clipanion's `command.cli` bridge that
      // Cli.run sets up (clipanion 3.2.1 Cli.js line 205) — the
      // shape is copied from there verbatim, not invented. The
      // MiniCli<Context> type lives in Cli.d.ts:92. Leaving
      // command.cli unset would make `this.cli.*` access inside
      // ANY Command crash with TypeError, creating a hidden
      // compatibility cliff vs. real CLI execution. The bridge
      // delegates back to the outer `cli` instance, threading
      // `harnessContext` through nested process/run subcommand
      // dispatch (subContext shallow-overrides per clipanion's
      // own pattern).
      const harnessContext = {
        stdin: stdin as Readable,
        stdout: stdoutSink,
        stderr: stderrSink,
        env,
        colorDepth: 0,
      };
      const command = cli.process(commandArgv, harnessContext);
      // `exactOptionalPropertyTypes: true` (tsconfig.base.json) means
      // optional fields on MiniCli must be ABSENT when their source
      // value is undefined — they CANNOT be set to `undefined`
      // explicitly. The 3 optional fields (binaryLabel, binaryVersion,
      // enableColors) are conditionally spread to honor that
      // contract; the runtime shape is identical to clipanion's own
      // assignment in Cli.js:205 (the JS there isn't subject to
      // strict TS rules).
      command.cli = {
        binaryName: cli.binaryName,
        enableCapture: cli.enableCapture,
        ...(cli.binaryLabel !== undefined ? { binaryLabel: cli.binaryLabel } : {}),
        ...(cli.binaryVersion !== undefined ? { binaryVersion: cli.binaryVersion } : {}),
        ...(cli.enableColors !== undefined ? { enableColors: cli.enableColors } : {}),
        definitions: () => cli.definitions(),
        error: (err, opts) => cli.error(err, opts),
        format: (colored) => cli.format(colored),
        process: (input, subContext) => cli.process(input, { ...harnessContext, ...subContext }),
        run: (input, subContext) => cli.run(input, { ...harnessContext, ...subContext }),
        usage: (cmd, opts) => cli.usage(cmd, opts),
      };
      const cliExitCode = await command.validateAndExecute();

      // Normalize Clipanion's possible undefined / null to 0 via
      // nullish coalescing. Numeric 0 stays 0 (correct: success
      // with no special exit code).
      const exitCode = cliExitCode ?? 0;

      return {
        exitCode,
        stdoutBytes: stdoutSink.asBuffer(),
        stderrText: stderrSink.asString(),
        stdoutTruncated: stdoutSink.truncated,
        stdoutBytesOmitted: stdoutSink.bytesOmitted,
        stderrTruncated: stderrSink.truncated,
        stderrBytesOmitted: stderrSink.bytesOmitted,
      };
    } finally {
      // Mandatory cwd restore — even when validateAndExecute() threw
      // an unexpected error. Faithful Command execution requires the
      // host process's cwd to be exactly as it was before this call.
      process.chdir(originalCwd);
    }
  });
}
