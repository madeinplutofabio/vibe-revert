// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M H (H1) -- COMPOUND / MULTILINE PTY interception CHARACTERIZATION.
//
// The interception hook is a Bash `DEBUG` trap that fires once per SIMPLE
// command via `$BASH_COMMAND` (re-entrancy-guarded), and runs the command ONLY
// when the parent replies with the byte-exact allow frame for that request id;
// a non-allow frame, a timeout, or a closed socket all SKIP it. A single
// submitted line that is a pipeline / `&&` / `;` / subshell / function / loop /
// heredoc can therefore produce MULTIPLE hook events -- multiple independent
// parent decisions. The exact event structure per construct is Bash behavior
// VibeRevert does not re-tokenize or normalize; `docs/pty-contract.md` records
// it as "not a tested compatibility promise". This suite DISCOVERS that
// structure on a real PTY and PINS the machine-checkable safety invariants that
// must hold regardless of it -- it does NOT presuppose universal interception,
// and it does NOT make Bash's event granularity a hidden compatibility promise.
//
// Rigor split (H1):
//   * MACHINE ASSERTIONS on the parent's own deterministic ledger + ordered
//     timeline: (1) every event is dispositioned, and an allow-frame WRITE is
//     only STARTED after the synthetic audit record was appended; (2) no blocked
//     event executes; (3) an audit-prerequisite failure never authorizes the
//     command; (4) synthetic audit records correspond exactly, one-to-one by id,
//     with interceptions for which the parent STARTED an allow-frame write --
//     "parent-authorized", NOT "delivered" and NOT "executed".
//   * CHARACTERIZATION RECORD -- the observed Bash hook-event sequence and
//     whether each command part executed are printed as CI evidence, NOT
//     hard-asserted to a shape; constructs / event granularity may differ.
//   * MAINTAINER VERDICT -- contract-consistent limitation vs safety
//     contradiction vs insufficient evidence, recorded in the contract (H1c).
//
// The parent's synthetic "accepted-command audit records" are an in-memory model
// of the audit prerequisite, NOT the real commands.log; the real append path is
// already proven by the G4 live production test (shell-pty-live-smoke). H1a
// proves ORDERING + CORRESPONDENCE while characterizing Bash's event stream.
//
// Evidence boundary: the harness proves the parent BEGAN the allow-frame write
// after appending the audit record. It does NOT prove transport delivery to
// Bash; execution is observed separately (marker output) and never equated with
// authorization.
//
// This is H1a: the content-aware "policy" parent (envelope-validating,
// fail-closed, with an ordered timeline) plus the simplest compound probe -- a
// `;` sequence in three modes: allow-all, policy-block-B, audit-failure-for-B.
// H1b reuses the policy-parent and ledger machinery, extending the PTY driver
// where constructs require multiline input or continuation-prompt handling; H1c
// records the matrix + verdict in the contract.
//
// Gated: POSIX + node-pty loadable + host shell resolves to Bash. This
// development host is Windows and SKIPs. The required release evidence is the
// Linux CI run; another POSIX host (e.g. macOS with an eligible Bash) may also
// run the test when node-pty and an eligible Bash are available.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PTY_INTERCEPTION_PROTOCOL_VERSION } from "../src/commands/pty-interception.js";
import { generateBashInterceptionHook } from "../src/commands/pty-interception-hook.js";
import { loadPtyModule, type PtyModule, type PtyProcess } from "../src/commands/pty-loader.js";
import { resolveHostInteractiveShell } from "../src/commands/shell-pty.js";

const PROMPT = "viberevert$ ";
const NONCE = "compoundcharnonce";

const PROMPT_DEADLINE_MS = 20_000;
const SETTLE_DEADLINE_MS = 15_000;
const EXIT_BACKSTOP_MS = 80_000;
const CLEANUP_EXIT_MS = 5_000;
const TEST_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_CHARS = 64_000;

// Distinct arithmetic-expanded markers: the OUTPUT (`VRC_A_42`) differs from the
// typed text (`$((20+22))`), so a match proves EXECUTION, not terminal echo. The
// unique `VRC_<X>_` token is also the substring the policy matches on, robust to
// whatever exact `$BASH_COMMAND` text Bash reports.
const A_TOKEN = "VRC_A_";
const B_TOKEN = "VRC_B_";
const A_CMD = "echo VRC_A_$((20+22))";
const B_CMD = "echo VRC_B_$((20+23))";
const A_OUT = "VRC_A_42";
const B_OUT = "VRC_B_43";
const SEQUENCE_LINE = `${A_CMD}; ${B_CMD}`;

function reportEvidence(message: string): void {
  process.stdout.write(`${message}\n`);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Read a property off an unknown object by a VARIABLE key. Satisfies both tsc
 *  `noPropertyAccessFromIndexSignature` (bracket access is allowed) and biome
 *  `useLiteralKeys` (the key is a variable, not a literal) -- the repo idiom for
 *  reading unknown-shaped values. */
function readProp<const Key extends string>(value: object, key: Key): unknown {
  return (value as Record<string, unknown>)[key];
}

/** The parent's deterministic per-request ledger entry. `decision` mirrors the
 *  production service outcome: "allow" (policy passed + audit succeeded +
 *  allow-frame write started), "block" (policy blocked; no audit attempted),
 *  "close" (policy passed but the audit prerequisite FAILED; no write). */
interface RecordedRequest {
  readonly id: string;
  readonly rawLine: string;
  readonly cwd: string;
  readonly decision: "allow" | "block" | "close";
  readonly auditAttempted: boolean;
  readonly auditSucceeded: boolean;
  /** The parent began writing the allow frame for this request. Proves
   *  authorization + write-initiation, NOT transport delivery or execution. */
  readonly allowFrameWriteStarted: boolean;
}

interface AuditRecord {
  readonly id: string;
  readonly rawLine: string;
}

/** A monotonically-sequenced observable event in the parent, used to PROVE the
 *  production order (disposition -> audit append -> allow-frame write start),
 *  not merely the final correspondence. `allow_frame_write_started` is recorded
 *  immediately BEFORE `socket.end(frame)`: it proves the write was initiated
 *  after the audit append, not that Bash physically received the bytes. */
type ParentTimelineEvent =
  | {
      readonly sequence: number;
      readonly kind: "disposition";
      readonly id: string;
      readonly decision: "allow" | "block" | "close";
    }
  | { readonly sequence: number; readonly kind: "audit_appended"; readonly id: string }
  | { readonly sequence: number; readonly kind: "allow_frame_write_started"; readonly id: string };

/** Distributive Omit so recordTimeline's input keeps each variant's
 *  discriminant-specific fields (e.g. `decision` on "disposition"). A plain
 *  `Omit<ParentTimelineEvent, "sequence">` collapses the union and loses them. */
type ParentTimelineEventInput = ParentTimelineEvent extends infer Event
  ? Event extends ParentTimelineEvent
    ? Omit<Event, "sequence">
    : never
  : never;

interface PolicyParentOptions {
  /** Policy BLOCK: write no frame, attempt no audit (models blocked_by_policy). */
  readonly block?: (rawLine: string) => boolean;
  /** Audit-prerequisite FAILURE: policy allows, the audit is ATTEMPTED and
   *  FAILS, so nothing is appended and no frame write starts (fail-closed,
   *  outcome "close"). Consulted only after `block` did not match. */
  readonly failAudit?: (rawLine: string) => boolean;
}

interface PolicyParent {
  readonly port: number;
  requests: () => readonly RecordedRequest[];
  auditRecords: () => readonly AuditRecord[];
  timeline: () => readonly ParentTimelineEvent[];
  /** Envelope-level rejections (malformed JSON, bad protocolVersion/nonce,
   *  missing/blank id, non-string rawLine/cwd, duplicate id). A protocol error
   *  starts NO allow-frame write. Expected empty against a well-behaved hook. */
  protocolErrors: () => readonly string[];
  close(): Promise<void>;
}

/**
 * A content-aware loopback parent that VALIDATES the request envelope
 * fail-closed and then faithfully models the production decision ORDER per
 * request: parse+validate -> policy disposition -> (if allowed) audit
 * prerequisite -> (if audited) APPEND the synthetic accepted-command record ->
 * START the byte-exact allow-frame write. A malformed envelope, a policy block,
 * and an audit failure each start no frame write. Every well-formed request is
 * recorded once with its exact disposition/audit/write-start flags, and every
 * observable step is timestamped on a monotonic timeline -- so the ledger +
 * timeline, not the Bash event stream, are what the machine assertions check.
 */
function startPolicyParent(options: PolicyParentOptions = {}): Promise<PolicyParent> {
  const sockets = new Set<Socket>();
  const recorded: RecordedRequest[] = [];
  const audits: AuditRecord[] = [];
  const timeline: ParentTimelineEvent[] = [];
  const protocolErrors: string[] = [];
  const seenIds = new Set<string>();
  let nextSequence = 1;

  function recordTimeline(event: ParentTimelineEventInput): void {
    timeline.push({ sequence: nextSequence++, ...event });
  }

  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buf = "";
    let replied = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (replied) {
        return;
      }
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) {
        return;
      }
      replied = true;
      const line = buf.slice(0, nl);

      // Envelope validation, FAIL-CLOSED. A malformed request gets no frame write
      // and never enters the disposition ledger.
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        protocolErrors.push(`unparseable request: ${line.slice(0, 120)}`);
        socket.end();
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        protocolErrors.push("request is not a JSON object");
        socket.end();
        return;
      }
      const protocolVersion = readProp(parsed, "protocolVersion");
      if (protocolVersion !== PTY_INTERCEPTION_PROTOCOL_VERSION) {
        protocolErrors.push(`bad protocolVersion: ${String(protocolVersion)}`);
        socket.end();
        return;
      }
      if (readProp(parsed, "nonce") !== NONCE) {
        protocolErrors.push("nonce mismatch");
        socket.end();
        return;
      }
      const id = readProp(parsed, "id");
      if (typeof id !== "string" || id.length === 0) {
        protocolErrors.push("missing or blank id");
        socket.end();
        return;
      }
      const rawLineValue = readProp(parsed, "rawLine");
      if (typeof rawLineValue !== "string") {
        protocolErrors.push(`non-string rawLine for id ${id}`);
        socket.end();
        return;
      }
      const cwdValue = readProp(parsed, "cwd");
      if (typeof cwdValue !== "string") {
        protocolErrors.push(`non-string cwd for id ${id}`);
        socket.end();
        return;
      }
      if (seenIds.has(id)) {
        protocolErrors.push(`duplicate id ${id}`);
        socket.end();
        return;
      }
      seenIds.add(id);
      const rawLine = rawLineValue;
      const cwd = cwdValue;

      // (1) Policy disposition FIRST. A block never reaches the audit step.
      if (options.block?.(rawLine) ?? false) {
        recordTimeline({ kind: "disposition", id, decision: "block" });
        recorded.push({
          id,
          rawLine,
          cwd,
          decision: "block",
          auditAttempted: false,
          auditSucceeded: false,
          allowFrameWriteStarted: false,
        });
        socket.end();
        return;
      }

      // (2) Audit prerequisite, reached ONLY after policy allowed.
      const auditSucceeded = !(options.failAudit?.(rawLine) ?? false);
      if (!auditSucceeded) {
        recordTimeline({ kind: "disposition", id, decision: "close" });
        recorded.push({
          id,
          rawLine,
          cwd,
          decision: "close",
          auditAttempted: true,
          auditSucceeded: false,
          allowFrameWriteStarted: false,
        });
        socket.end();
        return;
      }

      // (3) Audit succeeded -> APPEND the synthetic record, record the request
      // ledger entry, THEN start the allow-frame write. The ledger entry exists
      // before the write begins -- no transient audit/timeline-without-request
      // state -- and the write-start timeline event immediately precedes the
      // actual write, preserving the exact ordering claim.
      recordTimeline({ kind: "disposition", id, decision: "allow" });
      audits.push({ id, rawLine });
      recordTimeline({ kind: "audit_appended", id });
      recorded.push({
        id,
        rawLine,
        cwd,
        decision: "allow",
        auditAttempted: true,
        auditSucceeded: true,
        allowFrameWriteStarted: true,
      });
      recordTimeline({ kind: "allow_frame_write_started", id });
      socket.end(
        `{"protocolVersion":${PTY_INTERCEPTION_PROTOCOL_VERSION},"id":"${id}","kind":"allow"}\n`,
      );
    });
    socket.on("error", () => {
      // Bash may close its side abruptly after reading the reply; ignore.
    });
  });

  return new Promise((resolveStart, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("failed to obtain an ephemeral loopback port"));
        return;
      }
      resolveStart({
        port: addr.port,
        requests: () => recorded,
        auditRecords: () => audits,
        timeline: () => timeline,
        protocolErrors: () => protocolErrors,
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

function waitFor(
  predicate: () => boolean,
  deadlineMs: number,
  phase: string,
  diag: () => string,
): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (predicate()) {
      resolveWait();
      return;
    }
    const poll = setInterval(() => {
      if (predicate()) {
        clearInterval(poll);
        clearTimeout(timer);
        resolveWait();
      }
    }, 50);
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(
        new Error(
          `[compound characterization] timed out waiting for ${phase} after ${deadlineMs}ms.\n--- output ---\n${diag()}`,
        ),
      );
    }, deadlineMs);
  });
}

function waitForPtyExit(
  child: PtyProcess,
  deadlineMs: number,
): Promise<{ exitCode: number; signal: number | undefined }> {
  return new Promise((resolveExit, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sub: { dispose(): void } | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      sub?.dispose();
    };

    const settleExit = (event: { exitCode: number; signal: number | undefined }): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolveExit(event);
    };

    const registeredSub = child.onExit((event) => {
      settleExit({ exitCode: event.exitCode, signal: event.signal });
    });
    sub = registeredSub;

    if (settled) {
      sub.dispose();
      return;
    }

    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`PTY did not exit within ${deadlineMs}ms`));
    }, deadlineMs);
    timer.unref?.();
  });
}

async function awaitCleanupExit(
  childExit: Promise<unknown>,
  deadlineMs = CLEANUP_EXIT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      childExit.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function resolveHostBash(): Promise<{ pty: PtyModule; bashPath: string } | null> {
  if (process.platform === "win32") {
    return null;
  }
  const pty = await loadPtyModule();
  if (pty === null) {
    return null;
  }
  const shell = resolveHostInteractiveShell();
  if (shell === null || shell.kind !== "bash") {
    return null;
  }
  return { pty, bashPath: shell.path };
}

function requestsFor(active: PolicyParent, token: string): readonly RecordedRequest[] {
  return active.requests().filter((r) => r.rawLine.includes(token));
}

/**
 * Machine assertions (1), (3), (4) on the parent's ledger + timeline, by request
 * IDENTITY. Proves: unique non-empty ids; no orphan timeline/audit ids; exactly
 * one disposition per request; for an allow, exactly one audit append and one
 * write-start, ORDERED disposition < audit_appended < allow_frame_write_started;
 * for a block, no audit and no write-start; for a close (audit-failed), no
 * append and no write-start; and synthetic audit records one-to-one by id with
 * interceptions for which an allow-frame write was started, none for one that
 * was not.
 */
function assertLedgerConsistent(active: PolicyParent): void {
  const reqs = active.requests();
  const audits = active.auditRecords();
  const timeline = active.timeline();

  const ids = reqs.map((r) => r.id);
  expect(ids.every((id) => id.length > 0)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  expect(new Set(audits.map((a) => a.id)).size).toBe(audits.length);

  // No orphan timeline / audit ids: every one must belong to a recorded request.
  const requestIds = new Set(ids);
  for (const event of timeline) {
    expect(
      requestIds.has(event.id),
      `timeline event must belong to a recorded request: ${event.id}`,
    ).toBe(true);
  }
  for (const a of audits) {
    expect(requestIds.has(a.id), `audit record must belong to a recorded request: ${a.id}`).toBe(
      true,
    );
  }

  for (const r of reqs) {
    const tl = timeline.filter((e) => e.id === r.id);
    const dispositions = tl.filter((e) => e.kind === "disposition");
    const appended = tl.filter((e) => e.kind === "audit_appended");
    const writeStarted = tl.filter((e) => e.kind === "allow_frame_write_started");
    const auditForId = audits.filter((a) => a.id === r.id);

    expect(dispositions, `exactly one disposition for ${r.rawLine}`).toHaveLength(1);

    if (r.decision === "allow") {
      expect(
        r.auditAttempted && r.auditSucceeded && r.allowFrameWriteStarted,
        `allow must be audited + write-started: ${r.rawLine}`,
      ).toBe(true);
      expect(appended).toHaveLength(1);
      expect(writeStarted).toHaveLength(1);
      expect(auditForId).toHaveLength(1);
      // ORDER: dispositioned, then audit appended, then allow-frame write started.
      expect(dispositions[0]?.sequence ?? -1).toBeLessThan(appended[0]?.sequence ?? -1);
      expect(appended[0]?.sequence ?? -1).toBeLessThan(writeStarted[0]?.sequence ?? -1);
    } else if (r.decision === "block") {
      expect(
        !r.auditAttempted && !r.auditSucceeded && !r.allowFrameWriteStarted,
        `block must attempt no audit and start no write: ${r.rawLine}`,
      ).toBe(true);
      expect(appended).toHaveLength(0);
      expect(writeStarted).toHaveLength(0);
      expect(auditForId).toHaveLength(0);
    } else {
      expect(
        r.auditAttempted && !r.auditSucceeded && !r.allowFrameWriteStarted,
        `close must attempt audit, not succeed, start no write: ${r.rawLine}`,
      ).toBe(true);
      expect(appended).toHaveLength(0);
      expect(writeStarted).toHaveLength(0);
      expect(auditForId).toHaveLength(0);
    }
  }

  const writeStartedIds = reqs.filter((r) => r.allowFrameWriteStarted).map((r) => r.id);
  expect(
    audits
      .map((a) => a.id)
      .slice()
      .sort(),
  ).toEqual(writeStartedIds.slice().sort());
  const noWriteStarted = new Set(reqs.filter((r) => !r.allowFrameWriteStarted).map((r) => r.id));
  for (const a of audits) {
    expect(
      noWriteStarted.has(a.id),
      `no audit entry for a non-write-started request: ${a.rawLine}`,
    ).toBe(false);
  }
}

let rcDir = "";
let parent: PolicyParent | undefined;

afterEach(async () => {
  if (parent !== undefined) {
    await parent.close();
    parent = undefined;
  }
  if (rcDir) {
    await rm(rcDir, { recursive: true, force: true });
    rcDir = "";
  }
});

/**
 * Spawn a guarded interactive Bash against `activeParent`, submit each COMPLETE
 * input string and wait for the next primary prompt (`PS1`), leave via EOF
 * (never intercepted), and tear down. Sets the module-level `rcDir` for
 * afterEach. Returns the collected output and whether the cleanup backstop had
 * to force-kill the child.
 *
 * NOTE: this handles COMPLETE submitted constructs only -- one `PS1` return per
 * input string. Multiline paste, heredocs, and `\` continuation (which surface
 * `PS2` before completion) need extended driving; H1b adds that where required
 * rather than treating each physical line as an independently completed command.
 */
async function runGuardedSession(
  host: { pty: PtyModule; bashPath: string },
  activeParent: PolicyParent,
  lines: readonly string[],
): Promise<{ output: string; forceKilled: boolean }> {
  const hook = generateBashInterceptionHook({
    nonce: NONCE,
    endpoint: `127.0.0.1:${activeParent.port}`,
  });
  rcDir = await mkdtemp(join(tmpdir(), "vr-compound-"));
  const rcPath = join(rcDir, "hook.rc");
  await writeFile(rcPath, `PS1='${PROMPT}'\nPROMPT_COMMAND=\n${hook}`, { mode: 0o600 });

  const child = host.pty.spawn(host.bashPath, ["--noprofile", "--rcfile", rcPath, "-i"], {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd: rcDir,
    env: { ...process.env, SHELL: host.bashPath },
  });

  const childExit = waitForPtyExit(child, EXIT_BACKSTOP_MS);
  let exitEvent: { exitCode: number; signal: number | undefined } | undefined;
  void childExit.then(
    (event) => {
      exitEvent = event;
    },
    () => {
      // backstop/kill: surfaced by the per-phase deadlines, not here
    },
  );

  let output = "";
  let truncated = false;
  const dataSub = child.onData((chunk) => {
    output += chunk;
    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(-MAX_OUTPUT_CHARS);
      truncated = true;
    }
  });
  const diag = (): string =>
    `${truncated ? `[output truncated to last ${MAX_OUTPUT_CHARS} chars]\n` : ""}${output}`;

  let forceKilled = false;
  try {
    await waitFor(
      () => output.includes(PROMPT) || exitEvent !== undefined,
      PROMPT_DEADLINE_MS,
      "initial guarded prompt",
      diag,
    );
    if (!output.includes(PROMPT)) {
      throw new Error(
        `child exited (code ${exitEvent?.exitCode}) before the guarded prompt.\n${diag()}`,
      );
    }

    for (const line of lines) {
      const promptsBefore = occurrences(output, PROMPT);
      child.write(`${line}\r`);
      await waitFor(
        () => occurrences(output, PROMPT) > promptsBefore || exitEvent !== undefined,
        SETTLE_DEADLINE_MS,
        `returned prompt after: ${line}`,
        diag,
      );
      if (exitEvent !== undefined) {
        throw new Error(
          `child exited (code ${exitEvent.exitCode}) while running: ${line}\n${diag()}`,
        );
      }
    }

    child.write("\x04"); // EOF: not a command, never intercepted -> always leaves
    await childExit;
  } finally {
    dataSub.dispose();
    if (exitEvent === undefined) {
      forceKilled = true;
      try {
        child.kill();
      } catch {
        // best-effort cleanup only
      }
    }
    await awaitCleanupExit(childExit);
  }

  return { output, forceKilled };
}

describe("compound PTY interception -- `;` sequence characterization (M H1a)", () => {
  it(
    "allow-all: both simple commands are dispositioned, audited, write-started, and execute",
    async (ctx) => {
      const host = await resolveHostBash();
      if (host === null) {
        reportEvidence("[compound `;` allow-all] SKIP: not a POSIX Bash + node-pty host");
        ctx.skip();
        return;
      }
      parent = await startPolicyParent();
      const { output, forceKilled } = await runGuardedSession(host, parent, [SEQUENCE_LINE]);

      expect(requestsFor(parent, A_TOKEN).length).toBeGreaterThanOrEqual(1);
      expect(requestsFor(parent, B_TOKEN).length).toBeGreaterThanOrEqual(1);
      // Allow-all: the whole line runs regardless of event granularity.
      expect(output).toContain(A_OUT);
      expect(output).toContain(B_OUT);

      // Guard against a vacuous "all decisions allow" over an empty event set.
      expect(parent.requests().length).toBeGreaterThan(0);
      for (const r of parent.requests()) {
        expect(r.decision).toBe("allow");
      }
      expect(parent.protocolErrors()).toEqual([]);
      assertLedgerConsistent(parent);
      expect(forceKilled).toBe(false);

      reportEvidence(
        `[compound \`;\` allow-all] events=${parent.requests().length} ` +
          `audited=${parent.auditRecords().length} ` +
          `rawLines=${JSON.stringify(parent.requests().map((r) => r.rawLine))}`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "policy-block B: every B-selected event is dispositioned block and starts no write; B never executes",
    async (ctx) => {
      const host = await resolveHostBash();
      if (host === null) {
        reportEvidence("[compound `;` block-B] SKIP: not a POSIX Bash + node-pty host");
        ctx.skip();
        return;
      }
      parent = await startPolicyParent({ block: (rawLine) => rawLine.includes(B_TOKEN) });
      const { output, forceKilled } = await runGuardedSession(host, parent, [SEQUENCE_LINE]);

      const bReqs = requestsFor(parent, B_TOKEN);
      // False-pass guard: B's interception MUST have surfaced.
      expect(
        bReqs.length,
        "the B interception must have surfaced to the parent",
      ).toBeGreaterThanOrEqual(1);
      // Every event the B policy selected is blocked and starts no write; B absent.
      for (const r of bReqs) {
        expect(r.decision).toBe("block");
        expect(r.allowFrameWriteStarted).toBe(false);
      }
      expect(parent.auditRecords().some((a) => a.rawLine.includes(B_TOKEN))).toBe(false);
      expect(output).not.toContain(B_OUT);

      // A execution is CHARACTERIZATION (granularity-dependent): assert only when
      // A got a SEPARATELY-authorized interception (an allowed event with A but
      // not B). If Bash surfaced the whole line as one event, blocking on B also
      // conservatively blocks A -- a coverage result, not a safety contradiction.
      const aWriteStartedSeparately = parent
        .requests()
        .some(
          (r) =>
            r.rawLine.includes(A_TOKEN) && !r.rawLine.includes(B_TOKEN) && r.allowFrameWriteStarted,
        );
      if (aWriteStartedSeparately) {
        expect(output).toContain(A_OUT);
      }

      expect(parent.protocolErrors()).toEqual([]);
      assertLedgerConsistent(parent);
      expect(forceKilled).toBe(false);

      reportEvidence(
        `[compound \`;\` block-B] events=${parent.requests().length} ` +
          `decisions=${JSON.stringify(parent.requests().map((r) => r.decision))} ` +
          `aWriteStartedSeparately=${aWriteStartedSeparately} aExecuted=${output.includes(A_OUT)} ` +
          `bExecuted=${output.includes(B_OUT)}`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "audit-failure for B: every B-selected event is dispositioned close (audit attempted+failed), starts no write; B never executes",
    async (ctx) => {
      const host = await resolveHostBash();
      if (host === null) {
        reportEvidence("[compound `;` audit-fail-B] SKIP: not a POSIX Bash + node-pty host");
        ctx.skip();
        return;
      }
      parent = await startPolicyParent({ failAudit: (rawLine) => rawLine.includes(B_TOKEN) });
      const { output, forceKilled } = await runGuardedSession(host, parent, [SEQUENCE_LINE]);

      const bReqs = requestsFor(parent, B_TOKEN);
      expect(
        bReqs.length,
        "the B interception must have surfaced to the parent",
      ).toBeGreaterThanOrEqual(1);
      // B: policy passed, audit ATTEMPTED and FAILED -> close, no append, no
      // write start, no execution. The locked invariant distinct from a block.
      for (const r of bReqs) {
        expect(r.decision).toBe("close");
        expect(r.auditAttempted).toBe(true);
        expect(r.auditSucceeded).toBe(false);
        expect(r.allowFrameWriteStarted).toBe(false);
      }
      expect(parent.auditRecords().some((a) => a.rawLine.includes(B_TOKEN))).toBe(false);
      expect(output).not.toContain(B_OUT);

      const aWriteStartedSeparately = parent
        .requests()
        .some(
          (r) =>
            r.rawLine.includes(A_TOKEN) && !r.rawLine.includes(B_TOKEN) && r.allowFrameWriteStarted,
        );
      if (aWriteStartedSeparately) {
        expect(output).toContain(A_OUT);
      }

      expect(parent.protocolErrors()).toEqual([]);
      assertLedgerConsistent(parent);
      expect(forceKilled).toBe(false);

      reportEvidence(
        `[compound \`;\` audit-fail-B] events=${parent.requests().length} ` +
          `decisions=${JSON.stringify(parent.requests().map((r) => r.decision))} ` +
          `aWriteStartedSeparately=${aWriteStartedSeparately} aExecuted=${output.includes(A_OUT)} ` +
          `bExecuted=${output.includes(B_OUT)}`,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
