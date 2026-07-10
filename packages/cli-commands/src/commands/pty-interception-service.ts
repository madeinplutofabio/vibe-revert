// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Parent-side interception SERVICE (M G4 Step 4b, D104.E/H/J/O). The security
 * boundary: a prompt line may execute only after the parent receives a
 * nonce-bound request over a private per-session channel, evaluates policy, and
 * returns `allow`; every other path fails closed.
 *
 * This module is I/O-FREE and SOCKET-FREE -- it never imports `node:net`. The
 * real private-channel transport (a nonce-bound 127.0.0.1 loopback socket, with
 * byte->line framing, a max-line cap, and the read timer) is 4b-iii; the bash
 * hook is 4d. Here we have three layers, pure -> port-driven:
 *
 *   1. DECISION CORE (4b-i): `parseInterceptionRequest` validates ONLY the wire
 *      envelope (never throws for hostile input; normalizes nothing);
 *      `decideInterception` validates the nonce VALUE and maps policy to
 *      allow/block. Every non-allow path fails closed (D104.J).
 *   2. FRAME KERNEL (4b-ii): `encodeDecisionFrame` renders a decision as one
 *      NDJSON line; `handleRequestLine` is the total (never-throwing)
 *      line -> outcome transform (respond with a decision frame, or close with
 *      NO frame). A malformed request has no id, so it can NEVER produce an
 *      id-less decision -- it closes; the ONLY code path that emits a frame is
 *      parse-ok -> decide, which always carries the request id.
 *   3. LIFECYCLE (4b-ii): `createInterceptionService` drives an injected
 *      transport PORT -- accept a connection, read one request line, respond or
 *      close, always close (connection-per-request), sequentially -- and tears
 *      down via `stop()`. It is defensive against a misbehaving transport (every
 *      port call is guarded; an accept failure stops the loop, never hot-loops;
 *      once stop begins, no newly accepted connection is served AND no in-flight
 *      read that resolves after stop is answered) and fails closed on
 *      read-timeout / peer-close / any error.
 */

import type { CommandPolicyDecision, CommandsPolicyConfig } from "../command-guard.js";
import {
  type InterceptionDecision,
  type InterceptionDecisionBlockReason,
  type InterceptionRequest,
  PTY_INTERCEPTION_PROTOCOL_VERSION,
} from "./pty-interception.js";

/** Outcome of parsing untrusted wire bytes into a request envelope. */
export type ParseInterceptionRequestResult =
  | { readonly kind: "ok"; readonly request: InterceptionRequest }
  | { readonly kind: "malformed"; readonly reason: "malformed_request" };

/** True for a present, non-empty, non-whitespace string. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse untrusted wire bytes into an InterceptionRequest ENVELOPE, or a
 * `malformed` result. NEVER throws for hostile input. Validates ONLY the
 * envelope shape -- a non-array object, protocolVersion === 1, nonce/id non-blank
 * strings, rawLine a string (which MAY be empty) -- and normalizes NOTHING
 * (rawLine is preserved byte-for-byte; nonce/id kept as-is; extra fields are
 * ignored). Command semantics, the nonce VALUE, and policy are NOT checked here
 * (that is decideInterception).
 */
export function parseInterceptionRequest(raw: string): ParseInterceptionRequestResult {
  const malformed: ParseInterceptionRequestResult = {
    kind: "malformed",
    reason: "malformed_request",
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return malformed;
  }

  // A non-array object only (reject null, arrays, and primitives).
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return malformed;
  }

  const obj = parsed as {
    protocolVersion?: unknown;
    nonce?: unknown;
    id?: unknown;
    rawLine?: unknown;
  };
  if (obj.protocolVersion !== PTY_INTERCEPTION_PROTOCOL_VERSION) {
    return malformed;
  }
  if (!isNonBlankString(obj.nonce) || !isNonBlankString(obj.id)) {
    return malformed;
  }
  if (typeof obj.rawLine !== "string") {
    return malformed;
  }

  // Preserve the original values (rawLine byte-for-byte; nonce/id kept as-is).
  return {
    kind: "ok",
    request: {
      protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
      nonce: obj.nonce,
      id: obj.id,
      rawLine: obj.rawLine,
    },
  };
}

/** Injected facts for the pure decision (all-or-none per call). */
export interface DecideInterceptionDeps {
  /** The session nonce the request's nonce must match. */
  readonly sessionNonce: string;
  /** The guard/confirm policy snapshotted at PTY-shell start. */
  readonly commandsPolicy: CommandsPolicyConfig | undefined;
  /** The shared guard evaluator (injected so the policy-error path is testable). */
  readonly evaluateCommandPolicy: (
    argv: readonly string[],
    policy: CommandsPolicyConfig | undefined,
  ) => CommandPolicyDecision;
}

/** Build a block decision echoing the request id (every block fails closed). */
function block(id: string, reason: InterceptionDecisionBlockReason): InterceptionDecision {
  return { protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION, id, kind: "block", reason };
}

/**
 * The security decision for one PARSED request (D104.J fail-closed). A nonce
 * mismatch -> block(nonce_mismatch) BEFORE any policy evaluation. Then the policy
 * seam is evaluated inside a try that ALSO covers the verdict switch, so ANY
 * misbehaviour -- a throw, a malformed/null return (reading `.kind` throws), or
 * an unknown/future decision kind -- fails closed as block(policy_error). A guard
 * OR require_confirm match -> block(blocked_by_policy) (PTY v1 has NO interactive
 * confirm); ONLY an explicit `allow` -> allow. Policy is evaluated against the
 * raw prompt line as a SINGLE synthetic argv `[rawLine]` (D104.H) -- no
 * tokenizing, splitting, or trimming. The decision echoes id + protocolVersion.
 */
export function decideInterception(
  request: InterceptionRequest,
  deps: DecideInterceptionDeps,
): InterceptionDecision {
  if (request.nonce !== deps.sessionNonce) {
    return block(request.id, "nonce_mismatch");
  }

  try {
    const decision = deps.evaluateCommandPolicy([request.rawLine], deps.commandsPolicy);
    switch (decision.kind) {
      case "guard":
      case "confirm":
        return block(request.id, "blocked_by_policy");
      case "allow":
        return {
          protocolVersion: PTY_INTERCEPTION_PROTOCOL_VERSION,
          id: request.id,
          kind: "allow",
        };
      default:
        return block(request.id, "policy_error");
    }
  } catch {
    return block(request.id, "policy_error");
  }
}

// --- Frame kernel (M G4 Step 4b-ii) -----------------------------------------

/**
 * Render a decision as ONE NDJSON frame: a single-line JSON object plus a
 * trailing newline. The input is exactly an `InterceptionDecision` -- the ONLY
 * outbound wire type (never a generic object / `unknown`), so no id-less or error
 * frame can be produced. `JSON.stringify` of a plain decision emits no embedded
 * newlines and cannot throw.
 */
export function encodeDecisionFrame(decision: InterceptionDecision): string {
  return `${JSON.stringify(decision)}\n`;
}

/** Injected facts for the service decision (reused verbatim from the core). */
export type InterceptionServiceDeps = DecideInterceptionDeps;

/** What to do with one connection after reading its request line. */
export type InterceptionFrameOutcome =
  | { readonly kind: "respond"; readonly frame: string }
  | { readonly kind: "close" };

/**
 * The TOTAL (never-throwing) request-line -> outcome transform. The line is
 * handed to `parseInterceptionRequest` byte-for-byte (no trimming; CRLF /
 * max-line cap / byte accumulation are the transport's job, 4b-iii). A malformed
 * envelope -> `close` with NO frame (it has no id, so it must never yield an
 * InterceptionDecision). A well-formed envelope -> `decideInterception` -> one
 * encoded decision frame (allow OR block, always id-bearing). The decide + encode
 * run inside one try so that ANY misbehaviour -- including an (impossible) encode
 * failure -- fails closed as `close`, never an escape from the loop.
 */
export function handleRequestLine(
  line: string,
  deps: InterceptionServiceDeps,
): InterceptionFrameOutcome {
  const parsed = parseInterceptionRequest(line);
  if (parsed.kind === "malformed") {
    return { kind: "close" };
  }
  try {
    const decision = decideInterception(parsed.request, deps);
    return { kind: "respond", frame: encodeDecisionFrame(decision) };
  } catch {
    // decideInterception is already fail-closed and encoding a plain decision
    // cannot throw; this is a final backstop so no serialization bug can escape
    // the service loop. Fail closed: no frame.
    return { kind: "close" };
  }
}

// --- Transport port (M G4 Step 4b-ii; real loopback socket implements it in 4b-iii) --

/** The outcome of reading one request from a connection. Errors are DATA. */
export type InterceptionConnectionRead =
  | { readonly kind: "frame"; readonly line: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "closed" };

/**
 * One accepted connection. Connection-per-request: the service reads exactly one
 * request, sends at most one decision frame, and always closes. Every method
 * SHOULD resolve (never reject); the service is defensive regardless.
 */
export interface InterceptionServiceConnection {
  /** Read the next request line (or a timeout / closed signal). */
  read(): Promise<InterceptionConnectionRead>;
  /** Write one response frame. */
  send(frame: string): Promise<void>;
  /**
   * Close the connection. Idempotent. CONTRACT: if read() is pending, close()
   * MUST cause it to resolve, preferably as { kind: "closed" }, so stop() can
   * unblock an in-flight request.
   */
  close(): Promise<void>;
}

/**
 * The private-channel listener seam. `accept` yields the next connection, or
 * `null` once the transport is closed/stopped (which ends the service loop).
 */
export interface InterceptionServiceTransport {
  /** Yield the next connection, or `null` once the transport is closed/stopped. */
  accept(): Promise<InterceptionServiceConnection | null>;
  /**
   * Stop accepting and drop in-flight connections. CONTRACT: `close()` MUST cause
   * any pending or future `accept()` to resolve `null` -- the service owns no
   * timer, so this is what lets `stop()` / `done` resolve. SHOULD resolve (never
   * reject); the service swallows a rejection.
   */
  close(): Promise<void>;
}

// --- Service lifecycle (M G4 Step 4b-ii) ------------------------------------

/** A live interception service. `done` resolves when the accept loop ends. */
export interface InterceptionService {
  /** Resolves (never rejects) when the accept loop has stopped. */
  readonly done: Promise<void>;
  /** Stop accepting + tear down. Concurrent-idempotent; never rejects. */
  stop(): Promise<void>;
}

/**
 * Private loop state shared between `runAcceptLoop` and `stop()`. `stopped`
 * short-circuits a late-accepted connection AND a frame that resolves after stop
 * begins (fail closed); `activeConnection` is the connection currently being
 * served, so `stop()` can close it to unblock a stalled `read()` even if the
 * transport does not drop it.
 */
interface InterceptionServiceState {
  stopped: boolean;
  activeConnection: InterceptionServiceConnection | undefined;
}

/** Close a transport, swallowing any error (fail-closed teardown). */
async function closeTransportQuietly(transport: InterceptionServiceTransport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Best-effort teardown; a failing close must not reject stop()/done.
  }
}

/** Close a connection, swallowing any error (fail-closed teardown). */
async function closeConnectionQuietly(connection: InterceptionServiceConnection): Promise<void> {
  try {
    await connection.close();
  } catch {
    // Best-effort; a failing close must not break the accept loop.
  }
}

/**
 * Best-effort fail-closed teardown, shared by `stop()` and the accept-loop
 * backstop: mark stopped, close the transport (which a well-behaved transport
 * turns into a `null` from any pending/future `accept()`), then close any
 * in-flight connection to unblock a stalled `read()`. Never rejects -- both
 * closers swallow -- so it is safe as a `.catch` handler and inside `stop()`.
 */
async function failClosedTeardown(
  transport: InterceptionServiceTransport,
  state: InterceptionServiceState,
): Promise<void> {
  state.stopped = true;
  await closeTransportQuietly(transport);
  const active = state.activeConnection;
  if (active !== undefined) {
    await closeConnectionQuietly(active);
  }
}

/**
 * Serve ONE connection: read a single request, respond with its decision frame
 * or (on malformed / timeout / closed / read error) close with NO frame, then
 * always close. Never throws -- every port call is guarded so the accept loop
 * cannot be broken by a misbehaving transport (fail closed). Re-checks
 * state.stopped AFTER the read so a frame that arrives just as stop() begins is
 * NOT answered -- no decision may be emitted once teardown has started.
 */
async function serveConnection(
  connection: InterceptionServiceConnection,
  deps: InterceptionServiceDeps,
  state: InterceptionServiceState,
): Promise<void> {
  let read: InterceptionConnectionRead | undefined;
  try {
    read = await connection.read();
  } catch {
    // A read failure is not a decision: send nothing, close (fail closed).
    read = undefined;
  }

  if (!state.stopped && read?.kind === "frame") {
    const outcome = handleRequestLine(read.line, deps);
    if (outcome.kind === "respond") {
      try {
        await connection.send(outcome.frame);
      } catch {
        // A failed send delivers no decision; the hook reads EOF and fails
        // closed. Nothing to do but close.
      }
    }
  }

  await closeConnectionQuietly(connection);
}

/**
 * Accept connections and serve them one at a time (the bash hook serializes
 * requests, so there is never a concurrent legitimate request; a stalled
 * connection is bounded by the transport read-timeout). On an `accept` failure
 * the loop STOPS (best-effort transport close) rather than retrying -- a broken
 * transport must not become a hot loop. Once `stop()` has begun, a connection
 * accepted anyway is closed WITHOUT being read or served (fail closed). `null`
 * from `accept` ends the loop cleanly. Always resolves so `done` is safe to await.
 */
async function runAcceptLoop(
  transport: InterceptionServiceTransport,
  deps: InterceptionServiceDeps,
  state: InterceptionServiceState,
): Promise<void> {
  for (;;) {
    let connection: InterceptionServiceConnection | null;
    try {
      connection = await transport.accept();
    } catch {
      // Do not retry -- stop the loop and close so we cannot hot-loop.
      await closeTransportQuietly(transport);
      return;
    }
    if (connection === null) {
      return;
    }
    if (state.stopped) {
      // Teardown has begun: never read or serve a late-accepted connection.
      await closeConnectionQuietly(connection);
      return;
    }
    state.activeConnection = connection;
    try {
      await serveConnection(connection, deps, state);
    } finally {
      // Clear only if still ours, so a future concurrent edit cannot clobber a
      // newer active connection. Held in a finally so a hypothetical throwing
      // serveConnection cannot leave a stale activeConnection behind.
      if (state.activeConnection === connection) {
        state.activeConnection = undefined;
      }
    }
  }
}

/**
 * Create and immediately START a live interception service over the injected
 * transport port. The accept loop begins synchronously -- the service is live on
 * return (there is no separate `start()`); wiring (4e/4f) binds the real
 * transport first, then creates the service, then reads the transport endpoint
 * for the InstalledInterception handle. The loop is not expected to reject, but a
 * `.catch` backstop still runs `failClosedTeardown` so an accidental future
 * uncaught failure tears the transport down and fails closed. `stop()` is
 * concurrent-idempotent: the first call initiates shutdown via
 * `failClosedTeardown` (best-effort, safe if repeated) and awaits the loop; later
 * calls return the same promise. Neither `done` nor `stop()` ever rejects.
 */
export function createInterceptionService(
  transport: InterceptionServiceTransport,
  deps: InterceptionServiceDeps,
): InterceptionService {
  const state: InterceptionServiceState = { stopped: false, activeConnection: undefined };
  const acceptLoop = runAcceptLoop(transport, deps, state);
  const done: Promise<void> = acceptLoop.catch(() => failClosedTeardown(transport, state));
  let stopPromise: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    if (stopPromise === undefined) {
      stopPromise = (async () => {
        await failClosedTeardown(transport, state);
        await done;
      })();
    }
    return stopPromise;
  };

  return { done, stop };
}
