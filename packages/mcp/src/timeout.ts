// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// withTimeout: race a Promise against a setTimeout-driven McpToolTimeoutError
// rejection. Used by the Step 4 dispatcher to wrap class-A (no-side-effect)
// tool handlers per D99.V.
//
// Architectural locks:
//
//   D99.V -- 30-second response timeout for class-A tools only.
//   Class-B (side-effecting) tools are NEVER wrapped: abandoning a
//   side-effecting Command mid-run would destroy audit truth (the
//   Command might still write to .viberevert/ after the MCP envelope
//   already said MCP_TOOL_TIMEOUT). The class-A vs class-B branch
//   lives in the Step 4 dispatcher's tool-registration table; this
//   helper is the primitive both sides could use, but in v0.7.0-beta
//   only class-A wraps.
//
//   R17 -- no cancellation token. The underlying promise CONTINUES
//   running in the background after timeout fires; its eventual
//   resolve/reject is discarded. Acceptable for class A because
//   those tools have no side effects to orphan. M G2+ may add real
//   cancellation tokens, at which point class-B timeout becomes
//   re-considerable.
//
// Implementation notes:
//
//   - ms validated before creating the timeout promise or timer.
//     Invalid ms returns a rejected Promise with RangeError (the
//     function is async, so a thrown error becomes a rejection on
//     the returned Promise -- not a synchronous throw). Programmer-
//     error class; not caught by the dispatcher's audit/envelope
//     layer.
//   - clearTimeout in finally prevents a stray timer from firing
//     AFTER the underlying promise already settled, which would
//     otherwise keep the event loop alive briefly and (in some Node
//     runners) cause "open handle" warnings.
//   - McpToolTimeoutError carries toolName + timeoutMs so the
//     dispatcher can emit `{event:"tool_call", ok:false,
//     error_code:"MCP_TOOL_TIMEOUT", exit_code:null,
//     duration_ms:<ms>}` audit records with the right metadata.
//   - Timer handle typed as `ReturnType<typeof setTimeout>` for
//     portability -- avoids depending on the `NodeJS` global
//     namespace; the runtime is still Node, but the type stays
//     environment-agnostic.

import { McpToolTimeoutError } from "./errors.js";

/**
 * Race `promise` against a timeout. Resolves with the promise's value
 * if it settles within `ms` milliseconds; otherwise rejects with
 * McpToolTimeoutError(toolName, ms).
 *
 * Validates `ms` before creating the timeout promise or timer.
 * Invalid `ms` (non-positive, non-integer, NaN, Infinity) returns a
 * REJECTED Promise with RangeError -- this function is `async`, so
 * a thrown error inside its body surfaces as a Promise rejection at
 * the call site (not a synchronous throw). Programmer-error class;
 * never reaches the dispatcher's envelope mapper.
 *
 * Does NOT cancel `promise` on timeout. The underlying work keeps
 * running in the background and its eventual settlement is dropped.
 * The dispatcher MUST only call this for class-A tools (per D99.V);
 * class-B (side-effecting) tools would orphan their side effects.
 *
 * Always clears the timer in a finally block so a settled `promise`
 * does not leak a pending timer to the Node event loop.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  toolName: string,
): Promise<T> {
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new RangeError(`withTimeout: ms must be a positive safe integer; got ${String(ms)}`);
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new McpToolTimeoutError(toolName, ms));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}
