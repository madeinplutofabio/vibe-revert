// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for timeout.ts.
//
// Five logical groups:
//
//   A. Success path -- resolves with the original value
//   B. Timeout path -- rejects with McpToolTimeoutError after ms
//   C. Timer hygiene -- clearTimeout runs in success AND reject paths
//      (verified via vi.getTimerCount() after withTimeout settles)
//   D. R17 no-cancellation -- the underlying promise continues to
//      settle in the background after timeout fires
//   E. ms validation -- positive safe integer required; everything
//      else rejects with RangeError (as an async rejection, not a
//      synchronous throw, because withTimeout is `async`)
//
// Fake-timer rejection-handler pattern (used in groups B, C-timeout,
// and D):
//
//   `vi.advanceTimersByTimeAsync(N)` fires pending timers AND flushes
//   microtasks inside its own execution. If we await advanceTimers
//   BEFORE attaching a rejection handler to the timeout promise, the
//   timer fires + the rejection propagates + Node sees an unhandled
//   rejection (vitest can fail the test on this). The fix: attach
//   the handler SYNCHRONOUSLY before advancing the clock. Two
//   variants:
//
//     // Variant A: vitest .rejects matcher attaches the handler
//     const assertion = expect(p).rejects.toBeInstanceOf(X);
//     await vi.advanceTimersByTimeAsync(ms);
//     await assertion;
//
//     // Variant B: explicit .catch when we want to inspect the error
//     const caughtPromise = p.catch((err: unknown) => err);
//     await vi.advanceTimersByTimeAsync(ms);
//     const caught = await caughtPromise;
//
//   Both attach a handler at promise-creation time so the rejection
//   is never "unhandled".

import { describe, expect, it, vi } from "vitest";

import { McpToolTimeoutError } from "../src/errors.js";
import { withTimeout } from "../src/timeout.js";

// ============================================================================
// A. Success path
// ============================================================================

describe("withTimeout: success path", () => {
  it("resolves with the original value if the promise settles within ms", async () => {
    const fast = Promise.resolve("fast-value");
    const result = await withTimeout(fast, 1000, "fast_tool");
    expect(result).toBe("fast-value");
  });

  it("propagates the original promise's rejection (NOT a timeout) when it rejects in time", async () => {
    const originalError = new Error("inner failure");
    const failing = Promise.reject(originalError);
    await expect(withTimeout(failing, 1000, "tool")).rejects.toBe(originalError);
  });
});

// ============================================================================
// B. Timeout path
// ============================================================================

describe("withTimeout: timeout path", () => {
  it("rejects with McpToolTimeoutError when ms elapses before the promise settles", async () => {
    vi.useFakeTimers();
    try {
      const slow = new Promise<string>(() => {
        // Never resolves -- the timer wins the race.
      });
      const timeoutPromise = withTimeout(slow, 100, "slow_tool");
      // Attach rejection handler BEFORE advancing timers to avoid an
      // unhandled-rejection race with advanceTimersByTimeAsync's
      // microtask flush.
      const assertion = expect(timeoutPromise).rejects.toBeInstanceOf(McpToolTimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("McpToolTimeoutError carries toolName and timeoutMs fields", async () => {
    vi.useFakeTimers();
    try {
      const slow = new Promise<string>(() => {});
      const timeoutPromise = withTimeout(slow, 250, "my_tool");
      // Variant B: capture the rejection BEFORE advancing timers so
      // we can inspect the error object without unhandled-rejection
      // race.
      const caughtPromise = timeoutPromise.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(250);
      const caught = await caughtPromise;
      expect(caught).toBeInstanceOf(McpToolTimeoutError);
      if (caught instanceof McpToolTimeoutError) {
        expect(caught.toolName).toBe("my_tool");
        expect(caught.timeoutMs).toBe(250);
        // Sanity: mcpCode brand still set on the timeout error.
        expect(caught.mcpCode).toBe("MCP_TOOL_TIMEOUT");
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// C. Timer hygiene (clearTimeout in finally)
// ============================================================================

describe("withTimeout: clears the timer in finally (no leaked timers)", () => {
  it("clears the timer on the success path", async () => {
    vi.useFakeTimers();
    try {
      const fast = Promise.resolve("ok");
      await withTimeout(fast, 1000, "tool");
      // After the race resolves with the fast value, the finally
      // block must have cleared the pending timeout.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timer on the reject path (inner promise rejects)", async () => {
    vi.useFakeTimers();
    try {
      const failing = Promise.reject(new Error("inner fail"));
      try {
        await withTimeout(failing, 1000, "tool");
      } catch {
        // Expected -- the inner rejection propagates.
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timer on the timeout path too (no double-firing)", async () => {
    vi.useFakeTimers();
    try {
      const slow = new Promise<string>(() => {});
      const timeoutPromise = withTimeout(slow, 100, "tool");
      // Attach a .catch BEFORE advancing timers. We don't need to
      // inspect the error here, just need a handler so the rejection
      // doesn't go unobserved during the microtask flush.
      const settled = timeoutPromise.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(100);
      await settled;
      // After the timer fired AND the race rejected, the finally
      // block called clearTimeout on an already-fired handle. Safe
      // (Node tolerates clearTimeout on a fired timer) and confirms
      // no extra pending timers remain.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// D. R17: no cancellation -- background promise continues to settle
// ============================================================================

describe("withTimeout: R17 no cancellation -- background work continues", () => {
  it("the underlying promise keeps running and settles in the background after timeout fires", async () => {
    vi.useFakeTimers();
    try {
      let backgroundSettled = false;
      const slow = new Promise<string>((resolve) => {
        // Background work scheduled at t=500 ms.
        setTimeout(() => {
          backgroundSettled = true;
          resolve("late-value");
        }, 500);
      });

      // Race with a 100 ms timeout.
      const timeoutPromise = withTimeout(slow, 100, "tool");
      const assertion = expect(timeoutPromise).rejects.toBeInstanceOf(McpToolTimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      // At t=100, the background work has NOT yet fired.
      expect(backgroundSettled).toBe(false);

      // Advance to t=500. The background setTimeout fires, the
      // promise resolves, and backgroundSettled flips. This proves
      // withTimeout did NOT cancel the underlying work -- it merely
      // stopped awaiting it.
      await vi.advanceTimersByTimeAsync(400);
      expect(backgroundSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// E. ms validation (async rejection with RangeError)
// ============================================================================
//
// `withTimeout` is `async`, so a `throw` inside its body surfaces as
// a rejected Promise at the call site -- NOT a synchronous throw.
// Tests use `await expect(...).rejects.toThrow(RangeError)`, NOT
// `expect(() => ...).toThrow(...)`.

describe("withTimeout: ms validation", () => {
  it("ms = 0 rejects with RangeError", async () => {
    await expect(withTimeout(Promise.resolve("x"), 0, "tool")).rejects.toThrow(RangeError);
  });

  it("ms = -1 rejects with RangeError", async () => {
    await expect(withTimeout(Promise.resolve("x"), -1, "tool")).rejects.toThrow(RangeError);
  });

  it("ms = NaN rejects with RangeError", async () => {
    await expect(withTimeout(Promise.resolve("x"), Number.NaN, "tool")).rejects.toThrow(RangeError);
  });

  it("ms = Infinity rejects with RangeError", async () => {
    await expect(
      withTimeout(Promise.resolve("x"), Number.POSITIVE_INFINITY, "tool"),
    ).rejects.toThrow(RangeError);
  });

  it("ms = 1.5 (non-integer) rejects with RangeError", async () => {
    await expect(withTimeout(Promise.resolve("x"), 1.5, "tool")).rejects.toThrow(RangeError);
  });

  it("does NOT create a timer when ms validation fails", async () => {
    vi.useFakeTimers();
    try {
      await expect(withTimeout(Promise.resolve("x"), -1, "tool")).rejects.toThrow(RangeError);
      // The validation throws BEFORE setTimeout is called, so no
      // pending timer should exist after the rejection.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
