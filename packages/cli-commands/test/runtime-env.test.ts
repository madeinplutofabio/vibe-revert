// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// runtime-env.ts — C.2 targeted tests for the three D49 fixture-
// determinism resolvers + the RuntimeEnvInvalidError class.
//
// Strategy: every test passes an explicit `env` object so the default
// `= process.env` fallback never interferes with deterministic
// assertions. ONE assertion-light smoke-test per resolver confirms the
// default arg works (no throw, sensible return SHAPE — but no strict
// equality, because the test process may have VIBEREVERT_TEST_FIXED_*
// vars set in its env when the golden-fixture harness lands).

import { describe, expect, it } from "vitest";

import pkg from "../package.json" with { type: "json" };
import {
  RuntimeEnvInvalidError,
  resolveNowForCliTimestamp,
  resolveProductVersionForReport,
  resolveSinceResolvedShaForReport,
  VIBEREVERT_TEST_FIXED_NOW,
  VIBEREVERT_TEST_FIXED_SHA,
  VIBEREVERT_TEST_FIXED_VERSION,
} from "../src/runtime-env.js";

const ISO_SECONDS_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const VALID_SHA = "0".repeat(40);
const ANOTHER_VALID_SHA = "abcdef0123456789abcdef0123456789abcdef01";

// =============================================================================
// resolveNowForCliTimestamp
// =============================================================================

describe("resolveNowForCliTimestamp", () => {
  it("live path (env unset): returns a canonical second-precision Z-offset ISO string", () => {
    const ts = resolveNowForCliTimestamp({});
    expect(ts).toMatch(ISO_SECONDS_Z_RE);
  });

  it("fixed path (env set to valid ISO): returns the fixed value (normalized)", () => {
    const ts = resolveNowForCliTimestamp({
      [VIBEREVERT_TEST_FIXED_NOW]: "2026-01-01T00:00:00Z",
    });
    expect(ts).toBe("2026-01-01T00:00:00Z");
  });

  it("strips sub-second precision from a fixed value that carries it", () => {
    const ts = resolveNowForCliTimestamp({
      [VIBEREVERT_TEST_FIXED_NOW]: "2026-01-01T00:00:00.123Z",
    });
    expect(ts).toBe("2026-01-01T00:00:00Z");
  });

  it("normalizes a non-UTC timezone in the fixed value to UTC", () => {
    // 14:30:45 in +05:30 = 09:00:45 UTC.
    const ts = resolveNowForCliTimestamp({
      [VIBEREVERT_TEST_FIXED_NOW]: "2026-06-15T14:30:45+05:30",
    });
    expect(ts).toBe("2026-06-15T09:00:45Z");
  });

  it("empty-string env value throws RuntimeEnvInvalidError", () => {
    let caught: unknown;
    try {
      resolveNowForCliTimestamp({ [VIBEREVERT_TEST_FIXED_NOW]: "" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeEnvInvalidError);
    expect((caught as RuntimeEnvInvalidError).envVar).toBe(VIBEREVERT_TEST_FIXED_NOW);
    expect((caught as Error).message).toContain("not a parseable date string");
  });

  it("garbage env value throws RuntimeEnvInvalidError", () => {
    expect(() =>
      resolveNowForCliTimestamp({ [VIBEREVERT_TEST_FIXED_NOW]: "not a date at all" }),
    ).toThrow(RuntimeEnvInvalidError);
  });

  it("default env arg works: no-arg call returns a valid second-precision ISO without throwing", () => {
    // Assertion-light by design: shape only. Passes whether process.env has
    // VIBEREVERT_TEST_FIXED_NOW unset (live wall clock) or set to a valid
    // override (e.g. when the golden-fixture harness sets it).
    const ts = resolveNowForCliTimestamp();
    expect(ts).toMatch(ISO_SECONDS_Z_RE);
  });
});

// =============================================================================
// resolveSinceResolvedShaForReport
// =============================================================================

describe("resolveSinceResolvedShaForReport", () => {
  it("production path: valid SHA returned verbatim", () => {
    const result = resolveSinceResolvedShaForReport(VALID_SHA, {});
    expect(result).toBe(VALID_SHA);
  });

  it("env-override path: valid env SHA wins over realSha", () => {
    const result = resolveSinceResolvedShaForReport(VALID_SHA, {
      [VIBEREVERT_TEST_FIXED_SHA]: ANOTHER_VALID_SHA,
    });
    expect(result).toBe(ANOTHER_VALID_SHA);
  });

  it("production path: empty realSha throws plain Error mentioning the context", () => {
    let caught: unknown;
    try {
      resolveSinceResolvedShaForReport("", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(RuntimeEnvInvalidError);
    expect((caught as Error).message).toContain("resolveSinceResolvedShaForReport(realSha)");
    expect((caught as Error).message).toContain("40-character lowercase-hex SHA");
  });

  it("production path: short realSha (39 chars) rejected", () => {
    expect(() => resolveSinceResolvedShaForReport("0".repeat(39), {})).toThrow(Error);
  });

  it("production path: long realSha (41 chars) rejected", () => {
    expect(() => resolveSinceResolvedShaForReport("0".repeat(41), {})).toThrow(Error);
  });

  it("production path: uppercase realSha rejected (canonical form is lowercase)", () => {
    expect(() =>
      resolveSinceResolvedShaForReport("ABCDEF0123456789ABCDEF0123456789ABCDEF01", {}),
    ).toThrow(Error);
  });

  it("production path: non-hex char rejected", () => {
    // 40 chars, but contains 'g' which is outside [0-9a-f].
    expect(() => resolveSinceResolvedShaForReport("g".repeat(40), {})).toThrow(Error);
  });

  it("env-override path: malformed env SHA throws RuntimeEnvInvalidError (NOT plain Error)", () => {
    let caught: unknown;
    try {
      resolveSinceResolvedShaForReport(VALID_SHA, { [VIBEREVERT_TEST_FIXED_SHA]: "nope" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeEnvInvalidError);
    expect((caught as RuntimeEnvInvalidError).envVar).toBe(VIBEREVERT_TEST_FIXED_SHA);
  });

  it("default env arg works with a valid realSha (no-arg env, returns a canonical SHA)", () => {
    // Assertion-light by design: SHA-shape only. Passes whether
    // process.env[VIBEREVERT_TEST_FIXED_SHA] is unset (returns realSha) or
    // set to a valid override (returns that). Both outcomes are canonical.
    const result = resolveSinceResolvedShaForReport(VALID_SHA);
    expect(result).toMatch(SHA_RE);
  });
});

// =============================================================================
// resolveProductVersionForReport
// =============================================================================

describe("resolveProductVersionForReport", () => {
  it("production fallback: env unset returns pkg.version from package.json", () => {
    const result = resolveProductVersionForReport({});
    expect(result).toBe(pkg.version);
    expect(result.length).toBeGreaterThan(0);
  });

  it("env override: valid string returned", () => {
    const result = resolveProductVersionForReport({
      [VIBEREVERT_TEST_FIXED_VERSION]: "1.2.3-test",
    });
    expect(result).toBe("1.2.3-test");
  });

  it("empty-string env throws RuntimeEnvInvalidError (must be non-blank)", () => {
    let caught: unknown;
    try {
      resolveProductVersionForReport({ [VIBEREVERT_TEST_FIXED_VERSION]: "" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeEnvInvalidError);
    expect((caught as Error).message).toContain("non-blank");
  });

  it("whitespace-only env throws RuntimeEnvInvalidError (blank after trim)", () => {
    expect(() =>
      resolveProductVersionForReport({ [VIBEREVERT_TEST_FIXED_VERSION]: "   " }),
    ).toThrow(RuntimeEnvInvalidError);
  });

  it("leading whitespace rejected (would silently embed in markdown footer)", () => {
    let caught: unknown;
    try {
      resolveProductVersionForReport({ [VIBEREVERT_TEST_FIXED_VERSION]: " 1.2.3" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeEnvInvalidError);
    expect((caught as Error).message).toContain("whitespace");
  });

  it("trailing whitespace rejected", () => {
    expect(() =>
      resolveProductVersionForReport({ [VIBEREVERT_TEST_FIXED_VERSION]: "1.2.3 " }),
    ).toThrow(RuntimeEnvInvalidError);
  });

  it("default env arg works: no-arg call returns a non-blank version-like string without throwing", () => {
    // Assertion-light by design: non-blank + no surrounding whitespace.
    // Passes whether the default path returns pkg.version (env unset) or
    // a valid fixed override (env set by the golden-fixture harness).
    const result = resolveProductVersionForReport();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe(result.trim());
  });
});

// =============================================================================
// RuntimeEnvInvalidError shape
// =============================================================================

describe("RuntimeEnvInvalidError", () => {
  it("instanceof Error AND has the expected `name`", () => {
    const err = new RuntimeEnvInvalidError("FOO", "bar", "because");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RuntimeEnvInvalidError");
  });

  it("carries envVar, value, reason fields verbatim", () => {
    const err = new RuntimeEnvInvalidError("FOO_BAR", "the-bad-value", "the reason");
    expect(err.envVar).toBe("FOO_BAR");
    expect(err.value).toBe("the-bad-value");
    expect(err.reason).toBe("the reason");
  });

  it("message format includes the env-var name, JSON-stringified value, and reason", () => {
    const err = new RuntimeEnvInvalidError("FOO", "value with spaces", "because");
    // JSON-stringified so values with spaces / control chars / quotes are
    // unambiguous in the diagnostic.
    expect(err.message).toBe('FOO="value with spaces" is not a valid override: because');
  });
});
