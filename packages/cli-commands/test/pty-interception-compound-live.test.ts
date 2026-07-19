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
//     command; (4) synthetic audit records correspond exactly, one-to-one by the
//     parent-owned connection identity, with interceptions for which the parent
//     STARTED an allow-frame write -- "parent-authorized", NOT "delivered" and
//     NOT "executed".
//   * CHARACTERIZATION RECORD -- the observed Bash hook-event sequence and
//     whether each command part executed are printed as CI evidence, NOT
//     hard-asserted to a shape; constructs / event granularity may differ.
//   * MAINTAINER VERDICT -- contract-consistent limitation vs safety
//     contradiction vs insufficient evidence, recorded in the contract (H1c).
//
// CORRELATION IS CONNECTION-SCOPED. The parent assigns its OWN monotonic
// connectionId per accepted request and keys the ledger, timeline, and audit
// records by it. The client-supplied hook id (`$BASHPID-<seq>`) is validated
// non-empty but is NEVER a uniqueness key: an early nested-construct run showed
// `$$-<seq>` ids colliding across subshells (`$$` is the shell PID, unchanged in
// a subshell, so the forked `<seq>` counter repeats), so the hook was hardened
// to `$BASHPID-<seq>` AND this harness was reworked to trust only its own
// connectionId. A same-hook-id collision is recorded as descriptive evidence,
// never a protocol error.
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

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
  /** Parent-owned monotonic correlation key. The ONLY identity the ledger,
   *  timeline, and audit records join on -- never the client hook id. */
  readonly connectionId: number;
  /** The client-supplied hook request id (`$BASHPID-<seq>`). Validated
   *  non-empty; descriptive only, NOT trusted as unique. */
  readonly hookRequestId: string;
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
  readonly connectionId: number;
  readonly hookRequestId: string;
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
      readonly connectionId: number;
      readonly hookRequestId: string;
      readonly decision: "allow" | "block" | "close";
    }
  | {
      readonly sequence: number;
      readonly kind: "audit_appended";
      readonly connectionId: number;
      readonly hookRequestId: string;
    }
  | {
      readonly sequence: number;
      readonly kind: "allow_frame_write_started";
      readonly connectionId: number;
      readonly hookRequestId: string;
    };

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

/** A hook request id observed on MORE than one connection. Descriptive evidence
 *  that the client id is not globally unique -- NEVER a protocol error. Expected
 *  empty in a bounded single-process-tree run after the `$BASHPID` hardening,
 *  but the harness must remain correct regardless (correlation is by
 *  connectionId). */
interface HookRequestIdCollision {
  readonly hookRequestId: string;
  readonly connectionIds: readonly number[];
}

interface PolicyParent {
  readonly port: number;
  requests: () => readonly RecordedRequest[];
  auditRecords: () => readonly AuditRecord[];
  timeline: () => readonly ParentTimelineEvent[];
  /** Envelope-level rejections (malformed JSON, bad protocolVersion/nonce,
   *  missing/blank id, non-string rawLine/cwd). A protocol error starts NO
   *  allow-frame write. A REPEATED id is NOT an error -- it is recorded via
   *  hookRequestIdCollisions. Expected empty against a well-behaved hook. */
  protocolErrors: () => readonly string[];
  /** Hook ids seen on more than one connection (descriptive; expected empty). */
  hookRequestIdCollisions: () => readonly HookRequestIdCollision[];
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
  const hookIdToConnectionIds = new Map<string, number[]>();
  let nextConnectionId = 1;
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
      // A REPEATED hook id is NOT a protocol error. Correlation is by the
      // parent-owned connectionId; the collision is recorded as evidence.
      const connectionId = nextConnectionId++;
      const priorConnectionIds = hookIdToConnectionIds.get(id);
      if (priorConnectionIds === undefined) {
        hookIdToConnectionIds.set(id, [connectionId]);
      } else {
        priorConnectionIds.push(connectionId);
      }
      const rawLine = rawLineValue;
      const cwd = cwdValue;

      // (1) Policy disposition FIRST. A block never reaches the audit step.
      if (options.block?.(rawLine) ?? false) {
        recordTimeline({ kind: "disposition", connectionId, hookRequestId: id, decision: "block" });
        recorded.push({
          connectionId,
          hookRequestId: id,
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
        recordTimeline({ kind: "disposition", connectionId, hookRequestId: id, decision: "close" });
        recorded.push({
          connectionId,
          hookRequestId: id,
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
      recordTimeline({ kind: "disposition", connectionId, hookRequestId: id, decision: "allow" });
      audits.push({ connectionId, hookRequestId: id, rawLine });
      recordTimeline({ kind: "audit_appended", connectionId, hookRequestId: id });
      recorded.push({
        connectionId,
        hookRequestId: id,
        rawLine,
        cwd,
        decision: "allow",
        auditAttempted: true,
        auditSucceeded: true,
        allowFrameWriteStarted: true,
      });
      recordTimeline({ kind: "allow_frame_write_started", connectionId, hookRequestId: id });
      // The reply echoes the client hook id as UNTRUSTED metadata: JSON.stringify
      // so an id with quotes/backslashes/control chars can never produce a
      // malformed frame. For the `$BASHPID-<seq>` ids that actually occur this is
      // byte-identical to the allow frame the hook waits for; connectionId is
      // internal to the parent and never leaves it.
      socket.end(
        `${JSON.stringify({
          protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
          id,
          kind: "allow",
        })}\n`,
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
        // Deterministic for stable CI evidence: groups sorted by hookRequestId,
        // each connectionIds array numerically sorted. Ordering only -- not a
        // behavioural contract.
        hookRequestIdCollisions: () =>
          [...hookIdToConnectionIds.entries()]
            .filter(([, connectionIds]) => connectionIds.length > 1)
            .map(([hookRequestId, connectionIds]) => ({
              hookRequestId,
              connectionIds: [...connectionIds].sort((x, y) => x - y),
            }))
            .sort((a, b) => {
              if (a.hookRequestId < b.hookRequestId) {
                return -1;
              }
              if (a.hookRequestId > b.hookRequestId) {
                return 1;
              }
              return 0;
            }),
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
 * Machine assertions (1), (3), (4) on the parent's ledger + timeline, keyed by
 * the parent-owned CONNECTION identity (never the client hook id). Proves:
 * unique connectionIds; every hook id non-empty (NOT required unique); no orphan
 * timeline/audit connectionIds; exactly one disposition per request; for an
 * allow, exactly one audit append and one write-start, ORDERED disposition <
 * audit_appended < allow_frame_write_started; for a block, no audit and no
 * write-start; for a close (audit-failed), no append and no write-start; and
 * synthetic audit records one-to-one by connectionId with interceptions for
 * which an allow-frame write was started, none for one that was not.
 */
function assertLedgerConsistent(active: PolicyParent): void {
  const reqs = active.requests();
  const audits = active.auditRecords();
  const timeline = active.timeline();

  // Hook ids must be non-empty but need NOT be unique; the parent-owned
  // connectionId is the correlation key and MUST be unique.
  expect(reqs.every((r) => r.hookRequestId.length > 0)).toBe(true);
  const connectionIds = reqs.map((r) => r.connectionId);
  expect(new Set(connectionIds).size).toBe(connectionIds.length);
  expect(new Set(audits.map((a) => a.connectionId)).size).toBe(audits.length);

  // No orphan timeline / audit connectionIds: each must belong to a request.
  const requestConnectionIds = new Set(connectionIds);
  for (const event of timeline) {
    expect(
      requestConnectionIds.has(event.connectionId),
      `timeline event must belong to a recorded request: connection ${event.connectionId}`,
    ).toBe(true);
  }
  for (const a of audits) {
    expect(
      requestConnectionIds.has(a.connectionId),
      `audit record must belong to a recorded request: connection ${a.connectionId}`,
    ).toBe(true);
  }

  for (const r of reqs) {
    const tl = timeline.filter((e) => e.connectionId === r.connectionId);
    const dispositions = tl.filter((e) => e.kind === "disposition");
    const appended = tl.filter((e) => e.kind === "audit_appended");
    const writeStarted = tl.filter((e) => e.kind === "allow_frame_write_started");
    const auditForConnection = audits.filter((a) => a.connectionId === r.connectionId);

    // Metadata consistency WITHIN a connection: the descriptive hookRequestId
    // (and the audit rawLine) must never be crossed between connections, even
    // though hookRequestId is not a join key.
    for (const event of tl) {
      expect(
        event.hookRequestId,
        `timeline hook id must match request for connection ${r.connectionId}`,
      ).toBe(r.hookRequestId);
    }
    for (const audit of auditForConnection) {
      expect(
        audit.hookRequestId,
        `audit hook id must match request for connection ${r.connectionId}`,
      ).toBe(r.hookRequestId);
      expect(
        audit.rawLine,
        `audit rawLine must match request for connection ${r.connectionId}`,
      ).toBe(r.rawLine);
    }

    expect(dispositions, `exactly one disposition for ${r.rawLine}`).toHaveLength(1);

    if (r.decision === "allow") {
      expect(
        r.auditAttempted && r.auditSucceeded && r.allowFrameWriteStarted,
        `allow must be audited + write-started: ${r.rawLine}`,
      ).toBe(true);
      expect(appended).toHaveLength(1);
      expect(writeStarted).toHaveLength(1);
      expect(auditForConnection).toHaveLength(1);
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
      expect(auditForConnection).toHaveLength(0);
    } else {
      expect(
        r.auditAttempted && !r.auditSucceeded && !r.allowFrameWriteStarted,
        `close must attempt audit, not succeed, start no write: ${r.rawLine}`,
      ).toBe(true);
      expect(appended).toHaveLength(0);
      expect(writeStarted).toHaveLength(0);
      expect(auditForConnection).toHaveLength(0);
    }
  }

  const writeStartedConnectionIds = reqs
    .filter((r) => r.allowFrameWriteStarted)
    .map((r) => r.connectionId);
  expect(
    audits
      .map((a) => a.connectionId)
      .slice()
      .sort((x, y) => x - y),
  ).toEqual(writeStartedConnectionIds.slice().sort((x, y) => x - y));
  const noWriteStartedConnectionIds = new Set(
    reqs.filter((r) => !r.allowFrameWriteStarted).map((r) => r.connectionId),
  );
  for (const a of audits) {
    expect(
      noWriteStartedConnectionIds.has(a.connectionId),
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
    env: { ...process.env, SHELL: host.bashPath, VR_CASE_DIR: rcDir },
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

// ===========================================================================
// M H1b1 -- construct matrix on the PS1 driver (data-driven). Reuses the H1a
// policy parent + ledger machinery. Complete PS1 inputs only; PS2/continuation
// constructs are H1b2.
//
// POLICY TARGETING vs MARKER IDENTITY: a marker's output token is used only for
// EXECUTION evidence. Policy (block / audit-fail) selects requests by an EXACT
// (trim-normalized) match of the inner simple command -- NOT by textual token
// containment. For nested constructs the outer `$BASH_COMMAND` (a function
// definition, a subshell, a substitution's outer echo, a loop) may itself
// contain the inner token; matching by containment would block the OUTER and
// hide the exact coverage question. The target's SAFETY verdict is derived from
// the matcher; token containment stays descriptive coverage evidence
// (outerContainingMarkerRequestIds).
// ===========================================================================

type InterceptionExpectation =
  | "must_surface" // reachable top-level simple command (&& / || element)
  | "may_be_unreached" // shell control flow may skip it (native short-circuit)
  | "coverage_under_characterization"; // Bash evaluates it, but the hook may not inherit

/** Positive/negative control for a marker's execution. `characterize` records
 *  the observed value without asserting -- used for deny/audit-fail markers,
 *  whose safety is governed by the matcher-based target verdict. */
type ExecutionExpectation = "must_execute" | "must_not_execute" | "characterize";

type MatchingAuthorization = "none" | "all_authorized" | "some_not_authorized";

type CoverageOutcome =
  | "intercepted_authorized_executed"
  | "intercepted_authorized_not_observed_executing"
  | "intercepted_blocked_not_executed"
  | "intercepted_blocked_but_executed" // the ONLY safety contradiction
  | "not_intercepted_not_executed" // native short-circuit / unreached / outer-prevented
  | "executed_without_matching_interception"; // coverage gap -> H1c verdict input

type ReviewPosture =
  | "contract_consistent"
  | "coverage_gap"
  | "safety_contradiction"
  | "insufficient_evidence";

function classifyMarker(authorization: MatchingAuthorization, executed: boolean): CoverageOutcome {
  if (authorization === "none") {
    return executed ? "executed_without_matching_interception" : "not_intercepted_not_executed";
  }
  if (authorization === "all_authorized") {
    return executed
      ? "intercepted_authorized_executed"
      : "intercepted_authorized_not_observed_executing";
  }
  return executed ? "intercepted_blocked_but_executed" : "intercepted_blocked_not_executed";
}

function deriveReviewPosture(
  outcome: CoverageOutcome,
  expectation: InterceptionExpectation,
): ReviewPosture {
  if (outcome === "intercepted_blocked_but_executed") {
    return "safety_contradiction";
  }
  if (outcome === "executed_without_matching_interception") {
    return "coverage_gap";
  }
  if (outcome === "not_intercepted_not_executed") {
    return expectation === "may_be_unreached" ? "contract_consistent" : "insufficient_evidence";
  }
  return "contract_consistent";
}

/** Trim-only normalization. Deliberately does NOT collapse internal whitespace,
 *  strip quotes, or parse shell syntax. */
function normalizeRawLine(rawLine: string): string {
  return rawLine.trim();
}

/** Exact-only. Containment matching was intentionally removed: for nested
 *  constructs it cannot distinguish an inner interception from an outer event
 *  that merely contains the inner token. */
interface RequestMatcher {
  readonly kind: "exact";
  readonly rawLine: string;
}

function matchesRequest(matcher: RequestMatcher, rawLine: string): boolean {
  return normalizeRawLine(rawLine) === normalizeRawLine(matcher.rawLine);
}

function authorizationOf(requests: readonly RecordedRequest[]): MatchingAuthorization {
  if (requests.length === 0) {
    return "none";
  }
  return requests.every((r) => r.allowFrameWriteStarted) ? "all_authorized" : "some_not_authorized";
}

type MarkerExecution =
  | { readonly kind: "output"; readonly out: string }
  | { readonly kind: "fsSentinel"; readonly file: string };

interface MarkerSpec {
  readonly label: string;
  readonly token: string;
  readonly execution: MarkerExecution;
  readonly expectation: ExecutionExpectation;
}

type ConstructMode =
  | { readonly kind: "allow-all" }
  | {
      readonly kind: "block";
      readonly targetMarker: string;
      readonly requestMatcher: RequestMatcher;
      readonly expectation: InterceptionExpectation;
    }
  | {
      readonly kind: "audit-fail";
      readonly targetMarker: string;
      readonly requestMatcher: RequestMatcher;
      readonly expectation: InterceptionExpectation;
    };

interface ConstructCase {
  readonly caseId: string;
  readonly inputs: readonly string[];
  readonly markers: readonly MarkerSpec[];
  readonly mode: ConstructMode;
}

interface RuntimeMeta {
  readonly bashVersion: string;
  readonly bashVersionError: string | null;
  readonly bashPath: string;
  readonly nodeVersion: string;
  readonly platform: string;
}

function readRuntimeMeta(host: { bashPath: string }): RuntimeMeta {
  let bashVersion = "unknown";
  let bashVersionError: string | null = null;
  try {
    bashVersion = execFileSync(
      host.bashPath,
      ["--noprofile", "--norc", "-c", 'printf %s "$BASH_VERSION"'],
      { encoding: "utf8", env: { ...process.env, BASH_ENV: "" } },
    ).trim();
    if (bashVersion.length === 0) {
      bashVersionError = "empty $BASH_VERSION";
    }
  } catch (err) {
    bashVersionError = err instanceof Error ? err.message : String(err);
  }
  return {
    bashVersion,
    bashVersionError,
    bashPath: host.bashPath,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

const CASES: readonly ConstructCase[] = [
  {
    caseId: "and-allow",
    inputs: ["echo VRC_AND_A_$((20+22)) && echo VRC_AND_B_$((20+23))"],
    markers: [
      {
        label: "A",
        token: "VRC_AND_A_",
        execution: { kind: "output", out: "VRC_AND_A_42" },
        expectation: "must_execute",
      },
      {
        label: "B",
        token: "VRC_AND_B_",
        execution: { kind: "output", out: "VRC_AND_B_43" },
        expectation: "must_execute",
      },
    ],
    mode: { kind: "allow-all" },
  },
  {
    caseId: "and-deny",
    inputs: ["echo VRC_AND2_A_$((20+22)) && echo VRC_AND2_B_$((20+23))"],
    markers: [
      {
        label: "A",
        token: "VRC_AND2_A_",
        execution: { kind: "output", out: "VRC_AND2_A_42" },
        expectation: "characterize",
      },
      {
        label: "B",
        token: "VRC_AND2_B_",
        execution: { kind: "output", out: "VRC_AND2_B_43" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "block",
      targetMarker: "VRC_AND2_B_",
      requestMatcher: { kind: "exact", rawLine: "echo VRC_AND2_B_$((20+23))" },
      expectation: "must_surface",
    },
  },
  {
    caseId: "or-allow",
    inputs: ["echo VRC_OR_A_$((20+22)) || echo VRC_OR_B_$((20+23))"],
    markers: [
      {
        label: "A",
        token: "VRC_OR_A_",
        execution: { kind: "output", out: "VRC_OR_A_42" },
        expectation: "must_execute",
      },
      {
        label: "B",
        token: "VRC_OR_B_",
        execution: { kind: "output", out: "VRC_OR_B_43" },
        expectation: "must_not_execute",
      },
    ],
    mode: { kind: "allow-all" },
  },
  {
    caseId: "or-deny-reachable",
    inputs: ["false || echo VRC_ORD_DENY_$((20+23))"],
    markers: [
      {
        label: "DENY",
        token: "VRC_ORD_DENY_",
        execution: { kind: "output", out: "VRC_ORD_DENY_43" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "block",
      targetMarker: "VRC_ORD_DENY_",
      requestMatcher: { kind: "exact", rawLine: "echo VRC_ORD_DENY_$((20+23))" },
      expectation: "must_surface",
    },
  },
  {
    caseId: "or-deny-unreached",
    inputs: ["echo VRC_ORU_A_$((20+22)) || echo VRC_ORU_DENY_$((20+23))"],
    markers: [
      {
        label: "A",
        token: "VRC_ORU_A_",
        execution: { kind: "output", out: "VRC_ORU_A_42" },
        expectation: "characterize",
      },
      {
        label: "DENY",
        token: "VRC_ORU_DENY_",
        execution: { kind: "output", out: "VRC_ORU_DENY_43" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "block",
      targetMarker: "VRC_ORU_DENY_",
      requestMatcher: { kind: "exact", rawLine: "echo VRC_ORU_DENY_$((20+23))" },
      expectation: "may_be_unreached",
    },
  },
  {
    caseId: "pipe-allow",
    inputs: ['touch "$VR_CASE_DIR/VRC_PIPE_INNER_42.sentinel" | cat'],
    markers: [
      {
        label: "INNER",
        token: "VRC_PIPE_INNER_",
        execution: { kind: "fsSentinel", file: "VRC_PIPE_INNER_42.sentinel" },
        expectation: "must_execute",
      },
    ],
    mode: { kind: "allow-all" },
  },
  {
    caseId: "pipe-deny",
    inputs: ['touch "$VR_CASE_DIR/VRC_PIPE2_INNER_42.sentinel" | cat'],
    markers: [
      {
        label: "INNER",
        token: "VRC_PIPE2_INNER_",
        execution: { kind: "fsSentinel", file: "VRC_PIPE2_INNER_42.sentinel" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "block",
      targetMarker: "VRC_PIPE2_INNER_",
      requestMatcher: {
        kind: "exact",
        rawLine: 'touch "$VR_CASE_DIR/VRC_PIPE2_INNER_42.sentinel"',
      },
      expectation: "coverage_under_characterization",
    },
  },
  {
    caseId: "subst-allow",
    inputs: ["echo VRC_SUBST_OUTER_$((20+22))_cap=$(echo VRC_SUBST_INNER_$((20+23)))"],
    markers: [
      {
        label: "OUTER",
        token: "VRC_SUBST_OUTER_",
        execution: { kind: "output", out: "VRC_SUBST_OUTER_42_cap=" },
        expectation: "must_execute",
      },
      {
        label: "INNER",
        token: "VRC_SUBST_INNER_",
        execution: { kind: "output", out: "_cap=VRC_SUBST_INNER_43" },
        expectation: "must_execute",
      },
    ],
    mode: { kind: "allow-all" },
  },
  {
    caseId: "subst-deny",
    inputs: ["echo VRC_SUBST2_OUTER_$((20+22))_cap=$(echo VRC_SUBST2_INNER_$((20+23)))"],
    markers: [
      {
        label: "OUTER",
        token: "VRC_SUBST2_OUTER_",
        execution: { kind: "output", out: "VRC_SUBST2_OUTER_42_cap=" },
        expectation: "characterize",
      },
      {
        label: "INNER",
        token: "VRC_SUBST2_INNER_",
        execution: { kind: "output", out: "_cap=VRC_SUBST2_INNER_43" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "block",
      targetMarker: "VRC_SUBST2_INNER_",
      requestMatcher: { kind: "exact", rawLine: "echo VRC_SUBST2_INNER_$((20+23))" },
      expectation: "coverage_under_characterization",
    },
  },
  {
    caseId: "subshell-allow",
    inputs: ["( echo VRC_SUB_A_$((20+22)); echo VRC_SUB_B_$((20+23)) )"],
    markers: [
      {
        label: "A",
        token: "VRC_SUB_A_",
        execution: { kind: "output", out: "VRC_SUB_A_42" },
        expectation: "must_execute",
      },
      {
        label: "B",
        token: "VRC_SUB_B_",
        execution: { kind: "output", out: "VRC_SUB_B_43" },
        expectation: "must_execute",
      },
    ],
    mode: { kind: "allow-all" },
  },
  {
    caseId: "subshell-deny",
    inputs: ["( echo VRC_SUB2_A_$((20+22)); echo VRC_SUB2_B_$((20+23)) )"],
    markers: [
      {
        label: "A",
        token: "VRC_SUB2_A_",
        execution: { kind: "output", out: "VRC_SUB2_A_42" },
        expectation: "characterize",
      },
      {
        label: "B",
        token: "VRC_SUB2_B_",
        execution: { kind: "output", out: "VRC_SUB2_B_43" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "block",
      targetMarker: "VRC_SUB2_B_",
      requestMatcher: { kind: "exact", rawLine: "echo VRC_SUB2_B_$((20+23))" },
      expectation: "coverage_under_characterization",
    },
  },
  {
    caseId: "function-allow",
    inputs: ["vr_h1_func_a(){ echo VRC_FUNC_BODY_$((20+22)); }", "vr_h1_func_a"],
    markers: [
      {
        label: "BODY",
        token: "VRC_FUNC_BODY_",
        execution: { kind: "output", out: "VRC_FUNC_BODY_42" },
        expectation: "must_execute",
      },
    ],
    mode: { kind: "allow-all" },
  },
  {
    caseId: "function-deny",
    inputs: ["vr_h1_func_b(){ echo VRC_FUNC2_BODY_$((20+22)); }", "vr_h1_func_b"],
    markers: [
      {
        label: "BODY",
        token: "VRC_FUNC2_BODY_",
        execution: { kind: "output", out: "VRC_FUNC2_BODY_42" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "block",
      targetMarker: "VRC_FUNC2_BODY_",
      requestMatcher: { kind: "exact", rawLine: "echo VRC_FUNC2_BODY_$((20+22))" },
      expectation: "coverage_under_characterization",
    },
  },
  {
    caseId: "loop-allow",
    inputs: ["for i in 1 2; do echo VRC_LOOP_BODY_$((20+22)); done"],
    markers: [
      {
        label: "BODY",
        token: "VRC_LOOP_BODY_",
        execution: { kind: "output", out: "VRC_LOOP_BODY_42" },
        expectation: "must_execute",
      },
    ],
    mode: { kind: "allow-all" },
  },
  {
    caseId: "loop-deny",
    inputs: ["for i in 1 2; do echo VRC_LOOP2_BODY_$((20+22)); done"],
    markers: [
      {
        label: "BODY",
        token: "VRC_LOOP2_BODY_",
        execution: { kind: "output", out: "VRC_LOOP2_BODY_42" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "block",
      targetMarker: "VRC_LOOP2_BODY_",
      requestMatcher: { kind: "exact", rawLine: "echo VRC_LOOP2_BODY_$((20+22))" },
      expectation: "coverage_under_characterization",
    },
  },
  {
    caseId: "andmid-deny",
    inputs: ["echo VRC_AM_A_$((20+22)) && echo VRC_AM_MID_$((20+23)) && echo VRC_AM_C_$((20+24))"],
    markers: [
      {
        label: "A",
        token: "VRC_AM_A_",
        execution: { kind: "output", out: "VRC_AM_A_42" },
        expectation: "characterize",
      },
      {
        label: "MID",
        token: "VRC_AM_MID_",
        execution: { kind: "output", out: "VRC_AM_MID_43" },
        expectation: "characterize",
      },
      {
        label: "C",
        token: "VRC_AM_C_",
        execution: { kind: "output", out: "VRC_AM_C_44" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "block",
      targetMarker: "VRC_AM_MID_",
      requestMatcher: { kind: "exact", rawLine: "echo VRC_AM_MID_$((20+23))" },
      expectation: "must_surface",
    },
  },
  {
    caseId: "auditfail-and",
    inputs: ["true && echo VRC_AF_TARGET_$((20+22))"],
    markers: [
      {
        label: "TARGET",
        token: "VRC_AF_TARGET_",
        execution: { kind: "output", out: "VRC_AF_TARGET_42" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "audit-fail",
      targetMarker: "VRC_AF_TARGET_",
      requestMatcher: { kind: "exact", rawLine: "echo VRC_AF_TARGET_$((20+22))" },
      expectation: "must_surface",
    },
  },
  {
    caseId: "auditfail-subst",
    inputs: ["echo VRC_AFS_OUTER_$((20+22))_cap=$(echo VRC_AFS_INNER_$((20+23)))"],
    markers: [
      {
        label: "OUTER",
        token: "VRC_AFS_OUTER_",
        execution: { kind: "output", out: "VRC_AFS_OUTER_42_cap=" },
        expectation: "characterize",
      },
      {
        label: "INNER",
        token: "VRC_AFS_INNER_",
        execution: { kind: "output", out: "_cap=VRC_AFS_INNER_43" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "audit-fail",
      targetMarker: "VRC_AFS_INNER_",
      requestMatcher: { kind: "exact", rawLine: "echo VRC_AFS_INNER_$((20+23))" },
      expectation: "coverage_under_characterization",
    },
  },
];

// Collection-time guards: unique caseIds and unique fs-sentinel filenames.
{
  const caseIds = CASES.map((c) => c.caseId);
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error(`duplicate caseId in H1b1 CASES: ${caseIds.join(", ")}`);
  }
  const sentinels = CASES.flatMap((c) => c.markers)
    .map((m) => m.execution)
    .filter((e): e is { kind: "fsSentinel"; file: string } => e.kind === "fsSentinel")
    .map((e) => e.file);
  if (new Set(sentinels).size !== sentinels.length) {
    throw new Error(`duplicate fs-sentinel filename in H1b1 CASES: ${sentinels.join(", ")}`);
  }
}

async function runConstructCase(
  host: { pty: PtyModule; bashPath: string },
  meta: RuntimeMeta,
  spec: ConstructCase,
): Promise<void> {
  const caseKey = spec.caseId.toUpperCase().replace(/-/g, "_");
  const usabilityToken = `VRC_${caseKey}_USABLE_`;
  const usabilityOut = `${usabilityToken}42_ok`;
  const usabilityCmd = `echo ${usabilityToken}$((6*7))_ok`;

  // Case-spec validation (fails clearly BEFORE spawning Bash).
  const tokens = spec.markers.map((m) => m.token);
  expect(new Set(tokens).size, `[${spec.caseId}] marker tokens must be unique`).toBe(tokens.length);
  for (const m of spec.markers) {
    if (m.execution.kind === "output") {
      expect(
        m.execution.out.includes(m.token),
        `[${spec.caseId}] ${m.label} out must contain its token`,
      ).toBe(true);
      expect(
        m.execution.out,
        `[${spec.caseId}] ${m.label} out must differ from the typed token`,
      ).not.toBe(m.token);
    } else {
      expect(m.execution.file, `[${spec.caseId}] ${m.label} sentinel must be a basename`).toBe(
        basename(m.execution.file),
      );
    }
  }
  let parentOpts: PolicyParentOptions = {};
  if (spec.mode.kind !== "allow-all") {
    const { targetMarker, requestMatcher, expectation } = spec.mode;
    expect(
      tokens.includes(targetMarker),
      `[${spec.caseId}] targetMarker must be a case marker token`,
    ).toBe(true);
    expect(
      normalizeRawLine(requestMatcher.rawLine).length,
      `[${spec.caseId}] exact matcher non-empty`,
    ).toBeGreaterThan(0);
    expect(
      spec.inputs.some((inp) => inp.includes(requestMatcher.rawLine)),
      `[${spec.caseId}] exact matcher must appear in an input`,
    ).toBe(true);
    expect(
      spec.inputs.every(
        (inp) => normalizeRawLine(inp) !== normalizeRawLine(requestMatcher.rawLine),
      ),
      `[${spec.caseId}] exact matcher must be a proper part, not the whole construct`,
    ).toBe(true);
    expect(
      matchesRequest(requestMatcher, usabilityCmd),
      `[${spec.caseId}] matcher must not match the usability probe`,
    ).toBe(false);
    if (expectation === "must_surface") {
      const joined = spec.inputs.join(" ; ");
      expect(
        joined.includes("false &&") || joined.includes("true ||"),
        `[${spec.caseId}] must_surface target not behind a short-circuit`,
      ).toBe(false);
    }
    parentOpts =
      spec.mode.kind === "block"
        ? { block: (rawLine) => matchesRequest(requestMatcher, rawLine) }
        : { failAudit: (rawLine) => matchesRequest(requestMatcher, rawLine) };
  }

  const activeParent = await startPolicyParent(parentOpts);
  parent = activeParent;
  const { output, forceKilled } = await runGuardedSession(host, activeParent, [
    ...spec.inputs,
    usabilityCmd,
  ]);
  const caseDir = rcDir;
  const expectedDir = await realpath(caseDir);

  expect(activeParent.protocolErrors(), `[${spec.caseId}] no protocol errors`).toEqual([]);
  expect(forceKilled, `[${spec.caseId}] no forced cleanup`).toBe(false);
  assertLedgerConsistent(activeParent);

  const executedOf = (m: MarkerSpec): boolean =>
    m.execution.kind === "output"
      ? output.includes(m.execution.out)
      : existsSync(join(caseDir, m.execution.file));

  // Positive/negative execution controls (proves allow-all constructs are valid
  // and reachable; deny/audit-fail markers are `characterize`).
  for (const m of spec.markers) {
    const executed = executedOf(m);
    if (m.expectation === "must_execute") {
      expect(executed, `[${spec.caseId}] positive-control marker ${m.label} must execute`).toBe(
        true,
      );
    } else if (m.expectation === "must_not_execute") {
      expect(executed, `[${spec.caseId}] marker ${m.label} must not execute`).toBe(false);
    }
  }

  // Descriptive per-marker (token-based) coverage evidence -- NOT the safety verdict.
  const markerEvidence = spec.markers.map((m) => ({
    label: m.label,
    token: m.token,
    expectation: m.expectation,
    executed: executedOf(m),
    tokenOutcome: classifyMarker(
      authorizationOf(activeParent.requests().filter((r) => r.rawLine.includes(m.token))),
      executedOf(m),
    ),
  }));

  // Usability (distinct token, always allowed): proves the shell is alive AND
  // interception is still active.
  const usabilityOutcome = classifyMarker(
    authorizationOf(activeParent.requests().filter((r) => r.rawLine.includes(usabilityToken))),
    output.includes(usabilityOut),
  );
  expect(
    usabilityOutcome,
    `[${spec.caseId}] usability probe must be intercepted, authorized, and executed`,
  ).toBe("intercepted_authorized_executed");

  // Target safety verdict -- MATCHER-based (never token containment).
  let targetEvidence:
    | {
        targetMarker: string;
        requestMatcher: RequestMatcher;
        expectation: InterceptionExpectation;
        targetExecuted: boolean;
        matchingConnectionIds: number[];
        matchingHookRequestIds: string[];
        outerContainingConnectionIds: number[];
        targetOutcome: CoverageOutcome;
        reviewPosture: ReviewPosture;
      }
    | undefined;
  if (spec.mode.kind !== "allow-all") {
    const { targetMarker, requestMatcher, expectation } = spec.mode;
    const targetMarkerSpec = spec.markers.find((m) => m.token === targetMarker);
    if (targetMarkerSpec === undefined) {
      throw new Error(`[${spec.caseId}] unreachable: targetMarker has no marker spec`);
    }
    const targetRequests = activeParent
      .requests()
      .filter((r) => matchesRequest(requestMatcher, r.rawLine));
    const targetExecuted = executedOf(targetMarkerSpec);
    const targetOutcome = classifyMarker(authorizationOf(targetRequests), targetExecuted);
    const reviewPosture = deriveReviewPosture(targetOutcome, expectation);

    expect(
      targetOutcome,
      `[${spec.caseId}] target: a blocked/closed event must not execute`,
    ).not.toBe("intercepted_blocked_but_executed");
    if (expectation === "must_surface") {
      expect(
        targetRequests.length,
        `[${spec.caseId}] must_surface target must surface`,
      ).toBeGreaterThanOrEqual(1);
    }
    const requiredDecision = spec.mode.kind === "block" ? "block" : "close";
    for (const r of targetRequests) {
      expect(
        r.decision,
        `[${spec.caseId}] surfaced target must be dispositioned ${requiredDecision}`,
      ).toBe(requiredDecision);
    }

    targetEvidence = {
      targetMarker,
      requestMatcher,
      expectation,
      targetExecuted,
      matchingConnectionIds: targetRequests.map((r) => r.connectionId),
      matchingHookRequestIds: targetRequests.map((r) => r.hookRequestId),
      outerContainingConnectionIds: activeParent
        .requests()
        .filter(
          (r) => r.rawLine.includes(targetMarker) && !matchesRequest(requestMatcher, r.rawLine),
        )
        .map((r) => r.connectionId),
      targetOutcome,
      reviewPosture,
    };
  }

  // After the `$BASHPID` hardening no hook-id collision is expected within a
  // single bounded process tree. The harness never DEPENDS on this (it keys on
  // connectionId); asserting it here documents the post-fix expectation and
  // surfaces PID reuse if it ever occurred, without weakening correctness.
  const hookRequestIdCollisions = activeParent.hookRequestIdCollisions();
  expect(
    hookRequestIdCollisions,
    `[${spec.caseId}] no hook-request-id collisions expected after $BASHPID`,
  ).toEqual([]);

  const cwdEqualsExpectedDir = activeParent.requests().every((r) => r.cwd === expectedDir);
  const events = activeParent.requests().map((r) => {
    const tl = activeParent.timeline().filter((e) => e.connectionId === r.connectionId);
    return {
      connectionId: r.connectionId,
      hookRequestId: r.hookRequestId,
      cwd: r.cwd,
      rawLine: r.rawLine,
      decision: r.decision,
      writeStarted: r.allowFrameWriteStarted,
      timeline: {
        disposition: tl.find((e) => e.kind === "disposition")?.sequence,
        auditAppended: tl.find((e) => e.kind === "audit_appended")?.sequence,
        allowFrameWriteStarted: tl.find((e) => e.kind === "allow_frame_write_started")?.sequence,
      },
    };
  });

  reportEvidence(
    `[compound-characterization] ${JSON.stringify({
      ...meta,
      caseId: spec.caseId,
      mode: spec.mode.kind,
      inputMode: "complete",
      inputs: spec.inputs,
      markerEvidence,
      usabilityOutcome,
      target: targetEvidence,
      cwdEqualsExpectedDir,
      protocolErrors: activeParent.protocolErrors(),
      hookRequestIdCollisions,
      forceKilled,
      events,
    })}`,
  );
}

describe("compound PTY interception -- construct matrix on the PS1 driver (M H1b1)", () => {
  for (const spec of CASES) {
    it(
      spec.caseId,
      async (ctx) => {
        const host = await resolveHostBash();
        if (host === null) {
          reportEvidence(
            `[compound-characterization] SKIP ${spec.caseId}: not a POSIX Bash + node-pty host`,
          );
          ctx.skip();
          return;
        }
        const meta = readRuntimeMeta(host);
        await runConstructCase(host, meta, spec);
      },
      TEST_TIMEOUT_MS,
    );
  }
});

// ===========================================================================
// M H1b -- ARCHITECTURAL REGRESSION: the parent correlates strictly by its own
// connectionId and must stay correct when separate connections present the SAME
// hook id. Deterministic (raw sockets, no PTY) so it runs on every platform,
// including the Windows dev host. Locks the four invariants that outlive the
// `$BASHPID` fix: (1) correlation is by parent connectionId, never the client
// id; (2) the hook id is validated non-empty but NOT a uniqueness key; (3) two
// same-id connections are independently dispositioned, get distinct
// connectionIds, and each is answered on its own socket; (4) the id collision is
// recorded as descriptive evidence, never a protocol error. The two exchanges
// are initiated concurrently, but the test does NOT force both requests to
// coexist in parent state at once (Node drains the `data` events serially); a
// deterministic forced-overlap test would need an explicit parent barrier,
// unnecessary unless production later gains shared in-flight request state.
// ===========================================================================

/** One raw request/response against the policy parent. Resolves with the reply
 *  line (trailing newline stripped), or "" if the parent closed without a frame
 *  (a block/close disposition). Never uses the PTY hook. */
function exchange(port: number, request: Record<string, unknown>): Promise<string> {
  return new Promise((resolveExchange, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
    });
    socket.on("close", () => resolveExchange(buf.replace(/\n$/, "")));
    socket.on("error", reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("collision-regression exchange timed out"));
    });
  });
}

describe("policy parent -- same hook id, connection-scoped disposition (M H1b regression)", () => {
  it("dispositions two same-hook-id connections independently, by parent connectionId", async () => {
    // The block policy targets ONLY the second command's exact text. Capture a
    // local const: `parent` is module-level and reassigned by afterEach, so
    // TypeScript widens it back to `| undefined` after each await.
    const activeParent = await startPolicyParent({
      block: (rawLine) => rawLine === "echo VRC_COLLIDE_BLOCK_2",
    });
    parent = activeParent;
    const collidingId = "1234-1"; // identical client id on BOTH connections

    // The exchanges are initiated concurrently with the SAME id. The test does
    // not depend on connection acceptance or disposition order; requests are
    // identified by rawLine, never by connectionId assignment order. Array order
    // (not resolution order) maps each reply to its request.
    const [allowReply, blockReply] = await Promise.all([
      exchange(activeParent.port, {
        protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
        nonce: NONCE,
        id: collidingId,
        rawLine: "echo VRC_COLLIDE_ALLOW_1",
        cwd: "/tmp/vr-collide",
      }),
      exchange(activeParent.port, {
        protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
        nonce: NONCE,
        id: collidingId,
        rawLine: "echo VRC_COLLIDE_BLOCK_2",
        cwd: "/tmp/vr-collide",
      }),
    ]);

    // (4) A repeated id is NOT a protocol error.
    expect(activeParent.protocolErrors()).toEqual([]);

    // (3) Each connection is answered on its OWN socket: the allowed one gets an
    // allow frame echoing the shared client id (asserted SEMANTICALLY, not by
    // serialization order); the blocked one gets no frame (empty).
    expect(JSON.parse(allowReply)).toEqual({
      protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
      id: collidingId,
      kind: "allow",
    });
    expect(blockReply).toBe("");

    // (1)+(3) Two ledger entries: SAME hook id, DISTINCT parent connectionIds.
    const reqs = activeParent.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs.every((r) => r.hookRequestId === collidingId)).toBe(true);
    expect(new Set(reqs.map((r) => r.connectionId)).size).toBe(2);

    // Independently dispositioned by CONTENT, not by id.
    const allowReq = reqs.find((r) => r.rawLine === "echo VRC_COLLIDE_ALLOW_1");
    const blockReq = reqs.find((r) => r.rawLine === "echo VRC_COLLIDE_BLOCK_2");
    expect(allowReq?.decision).toBe("allow");
    expect(allowReq?.allowFrameWriteStarted).toBe(true);
    expect(blockReq?.decision).toBe("block");
    expect(blockReq?.allowFrameWriteStarted).toBe(false);

    // (2) The collision is recorded as descriptive evidence: one group, the
    // shared id, both connectionIds (getter returns them numerically sorted).
    const collisions = activeParent.hookRequestIdCollisions();
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.hookRequestId).toBe(collidingId);
    expect(collisions[0]?.connectionIds.slice().sort((x, y) => x - y)).toEqual(
      reqs
        .map((r) => r.connectionId)
        .slice()
        .sort((x, y) => x - y),
    );

    // The ledger stays internally consistent under the collision (keys on
    // connectionId, so a repeated hook id does not break correspondence).
    assertLedgerConsistent(activeParent);

    reportEvidence(
      `[compound-collision-regression] ${JSON.stringify({
        hookRequestId: collidingId,
        connectionIds: reqs.map((r) => r.connectionId),
        decisions: reqs.map((r) => r.decision),
        collisions,
      })}`,
    );
  });
});

// ===========================================================================
// M H1b2 -- PS2 / MULTILINE characterization. Extends the H1a/H1b1 harness with
// a multiline-aware input driver; the connection-scoped policy parent + ledger
// (startPolicyParent, assertLedgerConsistent, the classifier/matcher/collision
// machinery) are REUSED UNCHANGED. Covers the locked constructs: backslash
// continuation, heredoc, and single_write_multiline input, with explicit PS1/PS2
// transition handling and a post-deny / post-failure usability probe.
//
// COMPLETION IS NEVER INFERRED FROM TIME OR OUTPUT APPEARANCE. Distinct PS1/PS2
// markers are set in the rc; each write captures prompt-count baselines BEFORE
// writing and asserts the exact delta afterward. The ORDERED sequence of newly
// appended prompts is derived by POSITION in the output (both prompts can arrive
// in one PTY chunk), so a premature completion -- or a PS2 after completion -- is
// caught, not masked.
//
// "single_write_multiline" is exactly that -- one child.write() of a
// \n-separated block. It is NOT the terminal bracketed-paste protocol and makes
// no claim about it; bracketed paste is a distinct surface, out of scope here.
// ===========================================================================

const PS1_MARKER = "vr-ps1> ";
const PS2_MARKER = "vr-ps2> ";

/** A typed physical line and the prompt expected once it is submitted: PS2 =
 *  continuation (logical command not yet complete), PS1 = logical completion. */
interface TypedLine {
  readonly text: string;
  readonly expectAfter: "PS1" | "PS2";
}

type ConstructInput =
  | {
      readonly kind: "typed";
      readonly constructKind: "backslash_continuation" | "heredoc";
      readonly lines: readonly TypedLine[];
    }
  | {
      readonly kind: "single_write_multiline";
      readonly block: string;
      readonly logicalCommands: number;
      readonly minPs2Transitions: number;
      readonly exactPromptSequence?: readonly ("PS1" | "PS2")[];
    };

/** Filesystem execution proof for the heredoc case: terminal output cannot
 *  distinguish `cat`'s output from the echoed heredoc body, so execution is
 *  proven by the written file's exact content. `commandPrefix` is a
 *  CHARACTERIZATION prefix (never policy targeting) used to confirm the heredoc
 *  command itself surfaced, tolerant of how Bash renders the delimiter. */
interface HeredocResult {
  readonly file: string; // basename written under $VR_CASE_DIR
  readonly content: string; // exact expected file content
  readonly bodyToken: string; // must not surface as an independent command
  readonly delimiter: string; // must not surface as an independent command
  readonly commandPrefix: string; // the heredoc command must surface with this prefix
}

interface MultilineCase {
  readonly caseId: string;
  readonly construct: ConstructInput;
  readonly markers: readonly MarkerSpec[];
  readonly mode: ConstructMode;
  readonly heredocResult?: HeredocResult;
}

/** One write's ordered prompt-transition evidence. newPromptSequence is the
 *  full ordered list of prompts appended by this write, resolved by POSITION. */
interface PromptStepEvidence {
  readonly writeIndex: number;
  readonly inputKind: "typed_line" | "single_write_multiline";
  readonly bytesWritten: number;
  readonly expectedAfter: "PS1" | "PS2" | "multiple_ps1";
  readonly ps1Before: number;
  readonly ps2Before: number;
  readonly ps1After: number;
  readonly ps2After: number;
  readonly firstNewPrompt: "PS1" | "PS2" | "none";
  readonly newPromptSequence: readonly ("PS1" | "PS2")[];
}

interface MultilineWrite {
  readonly kind: "typed_line" | "single_write_multiline";
  readonly bytes: string;
  readonly expectedAfter: "PS1" | "PS2" | "multiple_ps1";
  readonly logicalCommands: number; // for multiple_ps1; 1 otherwise
  readonly minPs2Transitions: number; // for single-write; 0 otherwise
  readonly exactPromptSequence?: readonly ("PS1" | "PS2")[];
}

/** The ORDERED prompt kinds newly appended in a segment, by position -- so
 *  `PS2 -> PS1 -> PS2` is distinguishable from `PS2 -> PS2 -> PS1`, which totals
 *  and a single "first prompt" cannot separate. */
function newPromptSequenceOf(segment: string): ("PS1" | "PS2")[] {
  const found: { position: number; kind: "PS1" | "PS2" }[] = [];
  const markers: readonly (readonly [string, "PS1" | "PS2"])[] = [
    [PS1_MARKER, "PS1"],
    [PS2_MARKER, "PS2"],
  ];
  for (const [marker, kind] of markers) {
    let position = segment.indexOf(marker);
    while (position !== -1) {
      found.push({ position, kind });
      position = segment.indexOf(marker, position + marker.length);
    }
  }
  return found.sort((a, b) => a.position - b.position).map((p) => p.kind);
}

/** Deterministic backslash-continuation join: a line ending in `\` continues to
 *  the next with the backslash removed and NOTHING inserted -- so the exact
 *  pre-expansion $BASH_COMMAND has no fragile whitespace to predict. The test
 *  derives the joined command from the typed lines rather than guessing it. */
function joinBackslashContinuation(lines: readonly TypedLine[]): string {
  let joined = "";
  for (const line of lines) {
    joined += line.text.endsWith("\\") ? line.text.slice(0, -1) : line.text;
  }
  return joined;
}

/**
 * Drive a guarded interactive Bash with distinct PS1/PS2 markers over an ordered
 * list of writes, asserting the exact prompt transition each produces (deltas +
 * the full ordered prompt sequence). Returns ordered PromptStepEvidence, the
 * collected output, and whether the cleanup backstop force-killed the child.
 * Sets the module-level `rcDir` for afterEach.
 */
async function runGuardedMultilineSession(
  host: { pty: PtyModule; bashPath: string },
  activeParent: PolicyParent,
  writes: readonly MultilineWrite[],
): Promise<{ output: string; forceKilled: boolean; promptSteps: PromptStepEvidence[] }> {
  const hook = generateBashInterceptionHook({
    nonce: NONCE,
    endpoint: `127.0.0.1:${activeParent.port}`,
  });
  rcDir = await mkdtemp(join(tmpdir(), "vr-multiline-"));
  const rcPath = join(rcDir, "hook.rc");
  await writeFile(rcPath, `PS1='${PS1_MARKER}'\nPS2='${PS2_MARKER}'\nPROMPT_COMMAND=\n${hook}`, {
    mode: 0o600,
  });

  const child = host.pty.spawn(host.bashPath, ["--noprofile", "--rcfile", rcPath, "-i"], {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd: rcDir,
    env: { ...process.env, SHELL: host.bashPath, VR_CASE_DIR: rcDir },
  });

  const childExit = waitForPtyExit(child, EXIT_BACKSTOP_MS);
  let exitEvent: { exitCode: number; signal: number | undefined } | undefined;
  void childExit.then(
    (event) => {
      exitEvent = event;
    },
    () => {
      // backstop/kill surfaced by the per-phase deadlines
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

  const promptSteps: PromptStepEvidence[] = [];
  let forceKilled = false;
  try {
    // The initial PS1 is the BASELINE, never a transition caused by test input.
    await waitFor(
      () => occurrences(output, PS1_MARKER) >= 1 || exitEvent !== undefined,
      PROMPT_DEADLINE_MS,
      "initial guarded PS1",
      diag,
    );
    if (occurrences(output, PS1_MARKER) < 1) {
      throw new Error(
        `child exited (code ${exitEvent?.exitCode}) before the guarded PS1.\n${diag()}`,
      );
    }
    // Startup must be exactly one PS1 and no PS2; otherwise the per-write deltas
    // below would be measured against a corrupted baseline.
    expect(occurrences(output, PS1_MARKER), "[multiline] exactly one startup PS1").toBe(1);
    expect(occurrences(output, PS2_MARKER), "[multiline] no startup PS2").toBe(0);

    for (const [writeIndex, w] of writes.entries()) {
      // Truncation would break the position math; these cases are tiny, so it
      // must not occur.
      expect(truncated, `[multiline] output truncated before write ${writeIndex}`).toBe(false);
      const ps1Before = occurrences(output, PS1_MARKER);
      const ps2Before = occurrences(output, PS2_MARKER);
      const lenBefore = output.length;
      child.write(w.bytes);

      if (w.expectedAfter === "PS2") {
        await waitFor(
          () =>
            occurrences(output, PS2_MARKER) > ps2Before ||
            occurrences(output, PS1_MARKER) > ps1Before ||
            exitEvent !== undefined,
          SETTLE_DEADLINE_MS,
          `PS2 after typed line ${writeIndex}`,
          diag,
        );
      } else if (w.expectedAfter === "PS1") {
        await waitFor(
          () =>
            occurrences(output, PS1_MARKER) > ps1Before ||
            occurrences(output, PS2_MARKER) > ps2Before ||
            exitEvent !== undefined,
          SETTLE_DEADLINE_MS,
          `PS1 after typed line ${writeIndex}`,
          diag,
        );
      } else {
        await waitFor(
          () =>
            occurrences(output, PS1_MARKER) >= ps1Before + w.logicalCommands ||
            exitEvent !== undefined,
          SETTLE_DEADLINE_MS,
          `${w.logicalCommands} PS1 after single-write block ${writeIndex}`,
          diag,
        );
      }

      if (exitEvent !== undefined) {
        throw new Error(
          `child exited (code ${exitEvent.exitCode}) during write ${writeIndex}.\n${diag()}`,
        );
      }

      const ps1After = occurrences(output, PS1_MARKER);
      const ps2After = occurrences(output, PS2_MARKER);
      const newPromptSequence = newPromptSequenceOf(output.slice(lenBefore));
      const firstNewPrompt: "PS1" | "PS2" | "none" = newPromptSequence[0] ?? "none";
      promptSteps.push({
        writeIndex,
        inputKind: w.kind,
        bytesWritten: w.bytes.length,
        expectedAfter: w.expectedAfter,
        ps1Before,
        ps2Before,
        ps1After,
        ps2After,
        firstNewPrompt,
        newPromptSequence,
      });

      // Exact per-write transition assertions (deltas + ordered prompt sequence).
      if (w.expectedAfter === "PS2") {
        expect(ps2After - ps2Before, `[multiline] write ${writeIndex} PS2 delta`).toBe(1);
        expect(ps1After - ps1Before, `[multiline] write ${writeIndex} PS1 delta`).toBe(0);
        expect(newPromptSequence, `[multiline] write ${writeIndex} prompt sequence`).toEqual([
          "PS2",
        ]);
      } else if (w.expectedAfter === "PS1") {
        expect(ps1After - ps1Before, `[multiline] write ${writeIndex} PS1 delta`).toBe(1);
        expect(ps2After - ps2Before, `[multiline] write ${writeIndex} PS2 delta`).toBe(0);
        expect(newPromptSequence, `[multiline] write ${writeIndex} prompt sequence`).toEqual([
          "PS1",
        ]);
      } else {
        expect(
          ps1After - ps1Before,
          `[multiline] write ${writeIndex} PS1 delta (single-write)`,
        ).toBe(w.logicalCommands);
        expect(
          ps2After - ps2Before,
          `[multiline] write ${writeIndex} PS2 delta >= min`,
        ).toBeGreaterThanOrEqual(w.minPs2Transitions);
        if (w.exactPromptSequence !== undefined) {
          expect(
            newPromptSequence,
            `[multiline] write ${writeIndex} exact prompt sequence`,
          ).toEqual(w.exactPromptSequence);
        } else {
          expect(
            newPromptSequence[newPromptSequence.length - 1],
            `[multiline] write ${writeIndex} single-write ends on PS1`,
          ).toBe("PS1");
          expect(
            newPromptSequence.filter((p) => p === "PS1").length,
            `[multiline] write ${writeIndex} single-write PS1 count`,
          ).toBe(w.logicalCommands);
          expect(
            newPromptSequence.filter((p) => p === "PS2").length,
            `[multiline] write ${writeIndex} single-write PS2 count`,
          ).toBeGreaterThanOrEqual(w.minPs2Transitions);
        }
      }
    }

    // Position math held for every write.
    expect(truncated, "[multiline] output truncated during the run").toBe(false);

    child.write("\x04"); // EOF: never intercepted -> always leaves
    await childExit;
  } finally {
    dataSub.dispose();
    if (exitEvent === undefined) {
      forceKilled = true;
      try {
        child.kill();
      } catch {
        // best-effort cleanup
      }
    }
    await awaitCleanupExit(childExit);
  }

  return { output, forceKilled, promptSteps };
}

/**
 * Run one multiline case: fail-fast spec validation, then drive the construct +
 * a post-case usability probe, then assert the ledger, executions, heredoc
 * filesystem proof + command-surfaced invariant, usability, matcher-based target
 * verdict, and no collisions. Emits `[multiline-characterization]` evidence.
 */
async function runMultilineCase(
  host: { pty: PtyModule; bashPath: string },
  meta: RuntimeMeta,
  spec: MultilineCase,
): Promise<void> {
  const caseKey = spec.caseId.toUpperCase().replace(/-/g, "_");
  const usabilityToken = `VRC_${caseKey}_USABLE_`;
  const usabilityOut = `${usabilityToken}42_ok`;
  const usabilityCmd = `echo ${usabilityToken}$((6*7))_ok`;

  // ---- Fail-fast spec validation (BEFORE spawning Bash) ----
  const tokens = spec.markers.map((m) => m.token);
  expect(new Set(tokens).size, `[${spec.caseId}] marker tokens must be unique`).toBe(tokens.length);
  for (const m of spec.markers) {
    if (m.execution.kind === "output") {
      expect(
        m.execution.out.includes(m.token),
        `[${spec.caseId}] ${m.label} out must contain its token`,
      ).toBe(true);
      expect(
        m.execution.out,
        `[${spec.caseId}] ${m.label} out must differ from the typed token`,
      ).not.toBe(m.token);
    } else {
      expect(m.execution.file, `[${spec.caseId}] ${m.label} sentinel must be a basename`).toBe(
        basename(m.execution.file),
      );
    }
  }

  const inputStrings: string[] = [usabilityToken, usabilityCmd];
  if (spec.construct.kind === "typed") {
    const lines = spec.construct.lines;
    for (const line of lines) {
      inputStrings.push(line.text);
    }
    if (spec.construct.constructKind === "backslash_continuation") {
      expect(
        lines.length,
        `[${spec.caseId}] backslash construct needs >= 2 lines`,
      ).toBeGreaterThanOrEqual(2);
      for (const line of lines.slice(0, -1)) {
        expect(
          line.text.endsWith("\\"),
          `[${spec.caseId}] non-final backslash line must end with '\\'`,
        ).toBe(true);
        expect(line.expectAfter, `[${spec.caseId}] non-final backslash line must expect PS2`).toBe(
          "PS2",
        );
      }
      const last = lines[lines.length - 1];
      expect(
        last?.text.endsWith("\\"),
        `[${spec.caseId}] final backslash line must not end with '\\'`,
      ).toBe(false);
      expect(last?.expectAfter, `[${spec.caseId}] final backslash line must expect PS1`).toBe(
        "PS1",
      );
    } else {
      // constructKind === "heredoc"
      expect(
        spec.heredocResult,
        `[${spec.caseId}] heredoc construct requires heredocResult`,
      ).not.toBeUndefined();
      expect(
        lines.length,
        `[${spec.caseId}] heredoc needs opener + body + terminator`,
      ).toBeGreaterThanOrEqual(3);
      expect(lines[0]?.expectAfter, `[${spec.caseId}] heredoc opener must expect PS2`).toBe("PS2");
      for (const line of lines.slice(1, -1)) {
        expect(line.expectAfter, `[${spec.caseId}] heredoc body line must expect PS2`).toBe("PS2");
      }
      expect(
        lines[lines.length - 1]?.expectAfter,
        `[${spec.caseId}] heredoc terminator must expect PS1`,
      ).toBe("PS1");
      if (spec.heredocResult !== undefined) {
        const hr = spec.heredocResult;
        expect(
          lines.some((l) => l.text === hr.bodyToken),
          `[${spec.caseId}] body token must appear as a complete input line`,
        ).toBe(true);
        expect(
          lines.filter((l) => l.text === hr.delimiter).length,
          `[${spec.caseId}] delimiter must appear exactly once as a complete input line`,
        ).toBe(1);
        expect(
          lines[lines.length - 1]?.text,
          `[${spec.caseId}] terminator line must be the delimiter`,
        ).toBe(hr.delimiter);
        expect(
          lines[0]?.text.startsWith(hr.commandPrefix),
          `[${spec.caseId}] commandPrefix must prefix the heredoc opener`,
        ).toBe(true);
      }
    }
  } else {
    inputStrings.push(spec.construct.block);
    expect(
      spec.heredocResult,
      `[${spec.caseId}] single-write must not carry a heredocResult`,
    ).toBeUndefined();
    expect(
      spec.construct.block.endsWith("\n"),
      `[${spec.caseId}] single-write block must end with \\n`,
    ).toBe(true);
    expect(
      spec.construct.block.slice(0, -1).includes("\n"),
      `[${spec.caseId}] single-write block must be multiline (a newline before the final one)`,
    ).toBe(true);
    expect(
      spec.construct.logicalCommands,
      `[${spec.caseId}] logicalCommands must be >= 1`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      spec.construct.minPs2Transitions,
      `[${spec.caseId}] minPs2Transitions must be >= 0`,
    ).toBeGreaterThanOrEqual(0);
    if (spec.construct.exactPromptSequence !== undefined) {
      const seq = spec.construct.exactPromptSequence;
      expect(seq[seq.length - 1], `[${spec.caseId}] exact prompt sequence must end in PS1`).toBe(
        "PS1",
      );
      expect(
        seq.filter((prompt) => prompt === "PS1").length,
        `[${spec.caseId}] exact prompt sequence PS1 count must equal logicalCommands`,
      ).toBe(spec.construct.logicalCommands);
      expect(
        seq.filter((prompt) => prompt === "PS2").length,
        `[${spec.caseId}] exact prompt sequence must satisfy minPs2Transitions`,
      ).toBeGreaterThanOrEqual(spec.construct.minPs2Transitions);
    }
  }
  for (const m of spec.markers) {
    if (m.execution.kind === "output") {
      inputStrings.push(m.execution.out);
    }
  }
  if (spec.heredocResult !== undefined) {
    const hr = spec.heredocResult;
    inputStrings.push(hr.content, hr.bodyToken, hr.delimiter, hr.commandPrefix);
    expect(basename(hr.file), `[${spec.caseId}] heredoc result must be a basename`).toBe(hr.file);
    expect(
      hr.delimiter.length,
      `[${spec.caseId}] heredoc delimiter must be non-empty`,
    ).toBeGreaterThan(0);
    expect(
      hr.commandPrefix.length,
      `[${spec.caseId}] heredoc commandPrefix must be non-empty`,
    ).toBeGreaterThan(0);
  }
  for (const s of inputStrings) {
    expect(s.includes(PS1_MARKER), `[${spec.caseId}] PS1 marker must not appear in inputs`).toBe(
      false,
    );
    expect(s.includes(PS2_MARKER), `[${spec.caseId}] PS2 marker must not appear in inputs`).toBe(
      false,
    );
  }

  let parentOpts: PolicyParentOptions = {};
  if (spec.mode.kind !== "allow-all") {
    const { targetMarker, requestMatcher } = spec.mode;
    expect(
      tokens.includes(targetMarker),
      `[${spec.caseId}] targetMarker must be a case marker token`,
    ).toBe(true);
    expect(
      normalizeRawLine(requestMatcher.rawLine).length,
      `[${spec.caseId}] exact matcher non-empty`,
    ).toBeGreaterThan(0);
    expect(
      matchesRequest(requestMatcher, usabilityCmd),
      `[${spec.caseId}] matcher must not match the usability probe`,
    ).toBe(false);
    // The exact matcher is validated per typed constructKind. Backslash cases are
    // checked against the COMPUTED join (no prediction); any other typed kind must
    // define its own rule rather than being silently treated as a backslash join.
    if (spec.construct.kind === "typed") {
      if (spec.construct.constructKind === "backslash_continuation") {
        expect(
          normalizeRawLine(requestMatcher.rawLine),
          `[${spec.caseId}] matcher must equal the computed backslash join`,
        ).toBe(normalizeRawLine(joinBackslashContinuation(spec.construct.lines)));
      } else {
        throw new Error(
          `[${spec.caseId}] no exact-matcher validation rule for typed constructKind '${spec.construct.constructKind}'`,
        );
      }
    }
    parentOpts =
      spec.mode.kind === "block"
        ? { block: (rawLine) => matchesRequest(requestMatcher, rawLine) }
        : { failAudit: (rawLine) => matchesRequest(requestMatcher, rawLine) };
  }

  // ---- Run ----
  const activeParent = await startPolicyParent(parentOpts);
  parent = activeParent;

  const writes: MultilineWrite[] = [];
  if (spec.construct.kind === "typed") {
    for (const line of spec.construct.lines) {
      writes.push({
        kind: "typed_line",
        bytes: `${line.text}\r`,
        expectedAfter: line.expectAfter,
        logicalCommands: 1,
        minPs2Transitions: 0,
      });
    }
  } else {
    writes.push({
      kind: "single_write_multiline",
      bytes: spec.construct.block,
      expectedAfter: "multiple_ps1",
      logicalCommands: spec.construct.logicalCommands,
      minPs2Transitions: spec.construct.minPs2Transitions,
      ...(spec.construct.exactPromptSequence !== undefined
        ? { exactPromptSequence: spec.construct.exactPromptSequence }
        : {}),
    });
  }
  // Post-case usability probe: a fresh single-line PS1 command proving
  // interception is STILL active (especially after a deny / audit failure).
  writes.push({
    kind: "typed_line",
    bytes: `${usabilityCmd}\r`,
    expectedAfter: "PS1",
    logicalCommands: 1,
    minPs2Transitions: 0,
  });

  const { output, forceKilled, promptSteps } = await runGuardedMultilineSession(
    host,
    activeParent,
    writes,
  );
  const caseDir = rcDir;
  const expectedDir = await realpath(caseDir);

  expect(activeParent.protocolErrors(), `[${spec.caseId}] no protocol errors`).toEqual([]);
  expect(forceKilled, `[${spec.caseId}] no forced cleanup`).toBe(false);
  assertLedgerConsistent(activeParent);

  const constructKind =
    spec.construct.kind === "typed" ? spec.construct.constructKind : "single_write_multiline";
  const inputMode = spec.construct.kind === "typed" ? "typed" : "single_write_multiline";

  // ---- Marker execution controls ----
  const executedOf = (m: MarkerSpec): boolean =>
    m.execution.kind === "output"
      ? output.includes(m.execution.out)
      : existsSync(join(caseDir, m.execution.file));
  for (const m of spec.markers) {
    const executed = executedOf(m);
    if (m.expectation === "must_execute") {
      expect(executed, `[${spec.caseId}] positive-control marker ${m.label} must execute`).toBe(
        true,
      );
    } else if (m.expectation === "must_not_execute") {
      expect(executed, `[${spec.caseId}] marker ${m.label} must not execute`).toBe(false);
    }
  }
  const markerEvidence = spec.markers.map((m) => ({
    label: m.label,
    token: m.token,
    expectation: m.expectation,
    executed: executedOf(m),
    tokenOutcome: classifyMarker(
      authorizationOf(activeParent.requests().filter((r) => r.rawLine.includes(m.token))),
      executedOf(m),
    ),
  }));

  // ---- Heredoc: filesystem execution proof + command-surfaced + non-surfacing ----
  let heredocEvidence:
    | {
        file: string;
        expectedContent: string;
        contentMatches: boolean;
        commandSurfaced: boolean;
        heredocCommandConnectionIds: number[];
        bodySurfacedAsCommand: boolean;
        delimiterSurfacedAsCommand: boolean;
        heredocContainingBodyConnectionIds: number[];
      }
    | undefined;
  if (spec.heredocResult !== undefined) {
    const hr = spec.heredocResult;
    const resultPath = join(caseDir, hr.file);
    expect(existsSync(resultPath), `[${spec.caseId}] heredoc result file must exist`).toBe(true);
    const actual = await readFile(resultPath, "utf8");
    expect(actual, `[${spec.caseId}] heredoc result content must be exact`).toBe(hr.content);

    const requests = activeParent.requests();
    // The heredoc COMMAND itself must have surfaced (>= 1). Prefix match, not
    // exact: characterization only, tolerant of how Bash renders the delimiter.
    // No "exactly one" claim until Linux evidence establishes it across versions.
    const commandRequests = requests.filter((r) =>
      normalizeRawLine(r.rawLine).startsWith(hr.commandPrefix),
    );
    expect(
      commandRequests.length,
      `[${spec.caseId}] heredoc command must surface as an interception`,
    ).toBeGreaterThanOrEqual(1);

    // NARROW security property: the body / delimiter must not surface as an
    // INDEPENDENTLY intercepted command. A shell that echoes some heredoc source
    // text inside the `cat` command's own $BASH_COMMAND stays contract-consistent.
    const bodySurfacedAsCommand = requests.some(
      (r) => normalizeRawLine(r.rawLine) === hr.bodyToken,
    );
    const delimiterSurfacedAsCommand = requests.some(
      (r) => normalizeRawLine(r.rawLine) === hr.delimiter,
    );
    expect(
      bodySurfacedAsCommand,
      `[${spec.caseId}] heredoc body must not surface as an independently intercepted command`,
    ).toBe(false);
    expect(
      delimiterSurfacedAsCommand,
      `[${spec.caseId}] heredoc delimiter must not surface as an independently intercepted command`,
    ).toBe(false);

    heredocEvidence = {
      file: hr.file,
      expectedContent: hr.content,
      contentMatches: actual === hr.content,
      commandSurfaced: commandRequests.length >= 1,
      heredocCommandConnectionIds: commandRequests.map((r) => r.connectionId),
      bodySurfacedAsCommand,
      delimiterSurfacedAsCommand,
      heredocContainingBodyConnectionIds: requests
        .filter((r) => r.rawLine.includes(hr.bodyToken))
        .map((r) => r.connectionId),
    };
  }

  // ---- Usability probe (distinct token; always allowed) ----
  const usabilityOutcome = classifyMarker(
    authorizationOf(activeParent.requests().filter((r) => r.rawLine.includes(usabilityToken))),
    output.includes(usabilityOut),
  );
  expect(
    usabilityOutcome,
    `[${spec.caseId}] usability probe must be intercepted, authorized, and executed`,
  ).toBe("intercepted_authorized_executed");

  // ---- Matcher-based target verdict (block / audit-fail) ----
  let targetEvidence:
    | {
        targetMarker: string;
        requestMatcher: RequestMatcher;
        expectation: InterceptionExpectation;
        targetExecuted: boolean;
        matchingConnectionIds: number[];
        matchingHookRequestIds: string[];
        targetOutcome: CoverageOutcome;
        reviewPosture: ReviewPosture;
      }
    | undefined;
  if (spec.mode.kind !== "allow-all") {
    const { targetMarker, requestMatcher, expectation } = spec.mode;
    const targetMarkerSpec = spec.markers.find((m) => m.token === targetMarker);
    if (targetMarkerSpec === undefined) {
      throw new Error(`[${spec.caseId}] unreachable: targetMarker has no marker spec`);
    }
    const targetRequests = activeParent
      .requests()
      .filter((r) => matchesRequest(requestMatcher, r.rawLine));
    const targetExecuted = executedOf(targetMarkerSpec);
    const targetOutcome = classifyMarker(authorizationOf(targetRequests), targetExecuted);
    const reviewPosture = deriveReviewPosture(targetOutcome, expectation);

    expect(
      targetOutcome,
      `[${spec.caseId}] target: a blocked/closed event must not execute`,
    ).not.toBe("intercepted_blocked_but_executed");
    if (expectation === "must_surface") {
      expect(
        targetRequests.length,
        `[${spec.caseId}] must_surface target must surface`,
      ).toBeGreaterThanOrEqual(1);
    }
    const requiredDecision = spec.mode.kind === "block" ? "block" : "close";
    for (const r of targetRequests) {
      expect(
        r.decision,
        `[${spec.caseId}] surfaced target must be dispositioned ${requiredDecision}`,
      ).toBe(requiredDecision);
    }

    targetEvidence = {
      targetMarker,
      requestMatcher,
      expectation,
      targetExecuted,
      matchingConnectionIds: targetRequests.map((r) => r.connectionId),
      matchingHookRequestIds: targetRequests.map((r) => r.hookRequestId),
      targetOutcome,
      reviewPosture,
    };
  }

  // ---- Collisions + connection-scoped events (reused, unchanged) ----
  const hookRequestIdCollisions = activeParent.hookRequestIdCollisions();
  expect(
    hookRequestIdCollisions,
    `[${spec.caseId}] no hook-request-id collisions expected after $BASHPID`,
  ).toEqual([]);

  const cwdEqualsExpectedDir = activeParent.requests().every((r) => r.cwd === expectedDir);
  const events = activeParent.requests().map((r) => {
    const tl = activeParent.timeline().filter((e) => e.connectionId === r.connectionId);
    return {
      connectionId: r.connectionId,
      hookRequestId: r.hookRequestId,
      cwd: r.cwd,
      rawLine: r.rawLine,
      decision: r.decision,
      writeStarted: r.allowFrameWriteStarted,
      timeline: {
        disposition: tl.find((e) => e.kind === "disposition")?.sequence,
        auditAppended: tl.find((e) => e.kind === "audit_appended")?.sequence,
        allowFrameWriteStarted: tl.find((e) => e.kind === "allow_frame_write_started")?.sequence,
      },
    };
  });

  reportEvidence(
    `[multiline-characterization] ${JSON.stringify({
      ...meta,
      caseId: spec.caseId,
      mode: spec.mode.kind,
      constructKind,
      inputMode,
      markerEvidence,
      heredoc: heredocEvidence,
      usabilityOutcome,
      target: targetEvidence,
      promptSteps,
      ps1Total: occurrences(output, PS1_MARKER),
      ps2Total: occurrences(output, PS2_MARKER),
      cwdEqualsExpectedDir,
      protocolErrors: activeParent.protocolErrors(),
      hookRequestIdCollisions,
      forceKilled,
      events,
    })}`,
  );
}

const MULTILINE_CASES: readonly MultilineCase[] = [
  // 1) backslash continuation, allow-all: joins to ONE simple command that runs.
  {
    caseId: "bs-allow",
    construct: {
      kind: "typed",
      constructKind: "backslash_continuation",
      lines: [
        { text: "echo VRC_BSA_A_$((20+22))_\\", expectAfter: "PS2" },
        { text: "VRC_BSA_B_$((20+23))", expectAfter: "PS1" },
      ],
    },
    markers: [
      {
        label: "A",
        token: "VRC_BSA_A_",
        execution: { kind: "output", out: "VRC_BSA_A_42_VRC_BSA_B_43" },
        expectation: "must_execute",
      },
      {
        label: "B",
        token: "VRC_BSA_B_",
        execution: { kind: "output", out: "VRC_BSA_A_42_VRC_BSA_B_43" },
        expectation: "must_execute",
      },
    ],
    mode: { kind: "allow-all" },
  },
  // 2) backslash continuation, BLOCK the joined command (+ usability after deny).
  {
    caseId: "bs-deny",
    construct: {
      kind: "typed",
      constructKind: "backslash_continuation",
      lines: [
        { text: "echo VRC_BSD_A_$((20+22))_\\", expectAfter: "PS2" },
        { text: "VRC_BSD_B_$((20+23))", expectAfter: "PS1" },
      ],
    },
    markers: [
      {
        label: "A",
        token: "VRC_BSD_A_",
        execution: { kind: "output", out: "VRC_BSD_A_42_VRC_BSD_B_43" },
        expectation: "characterize",
      },
      {
        label: "B",
        token: "VRC_BSD_B_",
        execution: { kind: "output", out: "VRC_BSD_A_42_VRC_BSD_B_43" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "block",
      targetMarker: "VRC_BSD_B_",
      requestMatcher: { kind: "exact", rawLine: "echo VRC_BSD_A_$((20+22))_VRC_BSD_B_$((20+23))" },
      expectation: "must_surface",
    },
  },
  // 3) backslash continuation, AUDIT-FAIL the joined command (+ usability after failure).
  {
    caseId: "bs-auditfail",
    construct: {
      kind: "typed",
      constructKind: "backslash_continuation",
      lines: [
        { text: "echo VRC_BSF_A_$((20+22))_\\", expectAfter: "PS2" },
        { text: "VRC_BSF_B_$((20+23))", expectAfter: "PS1" },
      ],
    },
    markers: [
      {
        label: "A",
        token: "VRC_BSF_A_",
        execution: { kind: "output", out: "VRC_BSF_A_42_VRC_BSF_B_43" },
        expectation: "characterize",
      },
      {
        label: "B",
        token: "VRC_BSF_B_",
        execution: { kind: "output", out: "VRC_BSF_A_42_VRC_BSF_B_43" },
        expectation: "characterize",
      },
    ],
    mode: {
      kind: "audit-fail",
      targetMarker: "VRC_BSF_B_",
      requestMatcher: { kind: "exact", rawLine: "echo VRC_BSF_A_$((20+22))_VRC_BSF_B_$((20+23))" },
      expectation: "must_surface",
    },
  },
  // 4) heredoc, allow-all: the `cat` command surfaces; body/delimiter never surface
  //    as commands; execution PROVEN by the written file's exact content.
  {
    caseId: "heredoc-allow",
    construct: {
      kind: "typed",
      constructKind: "heredoc",
      lines: [
        { text: `cat > "$VR_CASE_DIR/VRC_HEREDOC_RESULT.txt" <<'VREOF'`, expectAfter: "PS2" },
        { text: "VRC_HEREDOC_BODY_42", expectAfter: "PS2" },
        { text: "VREOF", expectAfter: "PS1" },
      ],
    },
    markers: [],
    mode: { kind: "allow-all" },
    heredocResult: {
      file: "VRC_HEREDOC_RESULT.txt",
      content: "VRC_HEREDOC_BODY_42\n",
      bodyToken: "VRC_HEREDOC_BODY_42",
      delimiter: "VREOF",
      commandPrefix: `cat > "$VR_CASE_DIR/VRC_HEREDOC_RESULT.txt" <<`,
    },
  },
  // 5) single_write_multiline: two simple commands in one write -> two interceptions.
  {
    caseId: "single-write-simple-allow",
    construct: {
      kind: "single_write_multiline",
      block: "echo VRC_SWS_A_$((20+22))\necho VRC_SWS_B_$((20+23))\n",
      logicalCommands: 2,
      minPs2Transitions: 0,
      exactPromptSequence: ["PS1", "PS1"],
    },
    markers: [
      {
        label: "A",
        token: "VRC_SWS_A_",
        execution: { kind: "output", out: "VRC_SWS_A_42" },
        expectation: "must_execute",
      },
      {
        label: "B",
        token: "VRC_SWS_B_",
        execution: { kind: "output", out: "VRC_SWS_B_43" },
        expectation: "must_execute",
      },
    ],
    mode: { kind: "allow-all" },
  },
  // 6) single_write_multiline: a loop spanning physical lines -> PS2 entered
  //    mid-block, the loop body surfaces and executes.
  {
    caseId: "single-write-loop-allow",
    construct: {
      kind: "single_write_multiline",
      block: "for VRC_i in 1\ndo echo VRC_SWL_$((20+22))\ndone\n",
      logicalCommands: 1,
      minPs2Transitions: 2,
    },
    markers: [
      {
        label: "BODY",
        token: "VRC_SWL_",
        execution: { kind: "output", out: "VRC_SWL_42" },
        expectation: "must_execute",
      },
    ],
    mode: { kind: "allow-all" },
  },
];

{
  // Collection-time uniqueness guards: malformed tables fail at import, before
  // any Bash is spawned.
  const caseIds = MULTILINE_CASES.map((spec) => spec.caseId);
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error(`duplicate caseId in H1b2 cases: ${caseIds.join(", ")}`);
  }
  const allTokens = MULTILINE_CASES.flatMap((spec) => spec.markers.map((m) => m.token));
  if (new Set(allTokens).size !== allTokens.length) {
    throw new Error(`duplicate marker token in H1b2 cases: ${allTokens.join(", ")}`);
  }
  const files: string[] = [];
  for (const spec of MULTILINE_CASES) {
    for (const m of spec.markers) {
      if (m.execution.kind === "fsSentinel") {
        files.push(m.execution.file);
      }
    }
    if (spec.heredocResult !== undefined) {
      files.push(spec.heredocResult.file);
    }
  }
  if (new Set(files).size !== files.length) {
    throw new Error(`duplicate result filename in H1b2 cases: ${files.join(", ")}`);
  }
}

describe("compound PTY interception -- PS2 / multiline characterization (M H1b2)", () => {
  for (const spec of MULTILINE_CASES) {
    it(
      spec.caseId,
      async (ctx) => {
        const host = await resolveHostBash();
        if (host === null) {
          reportEvidence(
            `[multiline-characterization] SKIP ${spec.caseId}: not a POSIX Bash + node-pty host`,
          );
          ctx.skip();
          return;
        }
        const meta = readRuntimeMeta(host);
        await runMultilineCase(host, meta, spec);
      },
      TEST_TIMEOUT_MS,
    );
  }
});
