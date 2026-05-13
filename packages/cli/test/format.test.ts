// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for the package-private display-formatting helpers in
// packages/cli/src/format.ts. NOT exported from any public CLI
// surface, so we import directly via the source path.
//
// Each helper encodes a locked plan decision (D5/D12/D18); these
// tests lock those contracts at the unit level, separate from the
// integration tests in listing.test.ts. A regression in any of:
//   - the 14-char post-prefix truncation (D5)
//   - the 7-char SHA truncation (D12)
//   - the 48-char task truncation with `…` ellipsis (D18)
//   - the `-` fallback for null/undefined task (D12)
//   - the no-separator defensive branch in truncateIdForDisplay
// would flip a test here with a precise failure pointing at the
// helper, before the integration tests fail more diffusely.

import { describe, expect, it } from "vitest";

import {
  truncateIdForDisplay,
  truncateShaForDisplay,
  truncateTaskForDisplay,
} from "../src/format.js";

describe("truncateIdForDisplay", () => {
  it("truncates `cp_<ULID>` and `sess_<ULID>` to prefix + 14 body chars", () => {
    // Crockford ULIDs (no I, L, O, U) — same fixture pattern as
    // packages/core/test/session.test.ts.
    expect(truncateIdForDisplay("cp_01JV8Y7W2M7ABCDEFGHJKMNPQR")).toBe("cp_01JV8Y7W2M7ABC");
    expect(truncateIdForDisplay("sess_01JV8Z0N6E7ABCDEFGHJKMNPQR")).toBe("sess_01JV8Z0N6E7ABC");
  });

  it("returns input unchanged when there is no underscore separator", () => {
    // Defensive branch — protects against an unexpected ID format
    // (e.g., a future un-prefixed ID type) from being silently
    // sliced. format.ts returns the input as-is in that case.
    expect(truncateIdForDisplay("noprefix01JV8Y7W2M7ABCDEFGHJKMNPQR")).toBe(
      "noprefix01JV8Y7W2M7ABCDEFGHJKMNPQR",
    );
    expect(truncateIdForDisplay("")).toBe("");
  });

  it("returns input unchanged when post-separator portion is shorter than 14 chars", () => {
    // slice(0, sepIdx + 1 + 14) past end of string is a no-op — the
    // full input string is returned. Locks the slice-past-end
    // behavior for short inputs.
    expect(truncateIdForDisplay("cp_short")).toBe("cp_short");
    expect(truncateIdForDisplay("sess_")).toBe("sess_");
  });
});

describe("truncateShaForDisplay", () => {
  it("truncates SHA-1 (40 chars) and SHA-256 (64 chars) to 7 chars", () => {
    // SHA-1: 40 hex chars
    expect(truncateShaForDisplay("a1b2c3d4e5f6789012345678901234567890abcd")).toBe("a1b2c3d");
    // SHA-256: 64 hex chars
    expect(
      truncateShaForDisplay("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
    ).toBe("0123456");
  });

  it("returns input unchanged when shorter than 7 chars", () => {
    expect(truncateShaForDisplay("abc")).toBe("abc");
    expect(truncateShaForDisplay("")).toBe("");
  });
});

describe("truncateTaskForDisplay", () => {
  it("returns `-` for null and undefined", () => {
    // D12: "TASK is truncated... `-` if no task"
    expect(truncateTaskForDisplay(null)).toBe("-");
    expect(truncateTaskForDisplay(undefined)).toBe("-");
  });

  it("returns input unchanged at the 48-char boundary (no truncation)", () => {
    // Boundary case: exactly 48 chars must NOT be truncated.
    // Off-by-one regression here would silently truncate
    // legitimate task strings that happen to fit exactly.
    const exactly48 = "x".repeat(48);
    expect(exactly48.length).toBe(48);
    expect(truncateTaskForDisplay(exactly48)).toBe(exactly48);
  });

  it("truncates to 47 chars + `…` (U+2026) when longer than 48 chars", () => {
    // Boundary +1: 49 chars must truncate to first 47 + ellipsis,
    // totalling 48 display chars (D18: "fixed maximum of 48").
    const fortyNine = "x".repeat(49);
    expect(fortyNine.length).toBe(49);
    const truncated = truncateTaskForDisplay(fortyNine);
    expect(truncated).toBe(`${"x".repeat(47)}…`);
    // Verify total display width is exactly 48 chars (47 x's + 1
    // ellipsis char). Locks D18's "fixed maximum of 48 characters"
    // promise — including the ellipsis in the count.
    expect(truncated.length).toBe(48);
  });

  it("uses single-char ellipsis (U+2026), NOT three dots", () => {
    // D18 explicitly specifies the single horizontal-ellipsis
    // character. With three dots ("..."), the truncated total
    // would be 50 chars — wrong column width and wrong contract.
    const longString = "x".repeat(100);
    const truncated = truncateTaskForDisplay(longString);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.endsWith("...")).toBe(false);
  });
});
