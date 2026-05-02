// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { describe, expect, it } from "vitest";
import { redact, SECRET_PATTERN_COUNT } from "../src/index.js";

describe("SECRET_PATTERN_COUNT", () => {
  it("matches the documented pattern set size", () => {
    // If you add or remove a pattern in src/redact.ts, update this number AND
    // the `it.each` cases below. The mismatch is intentional friction to make
    // pattern-set drift visible in code review.
    expect(SECRET_PATTERN_COUNT).toBe(6);
  });
});

describe("redact", () => {
  it("returns input unchanged when no patterns match", () => {
    expect(redact("hello world")).toBe("hello world");
  });

  it("returns empty string for empty input", () => {
    expect(redact("")).toBe("");
  });

  it.each([
    ["sk_live_abc123XYZ", "[REDACTED]"],
    ["ghp_1234567890123456789012345678901234567890", "[REDACTED]"],
    ["github_pat_11ABCDEFG_examplevalue", "[REDACTED]"],
    ["xoxb-12345-67890-abcdef", "[REDACTED]"],
    ["xoxp-1-2-3-abcdef", "[REDACTED]"],
    ["AKIAIOSFODNN7EXAMPLE", "[REDACTED]"],
  ])("redacts %s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("redacts a PEM-armored RSA private key", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    expect(redact(pem)).toBe("[REDACTED]");
  });

  it("redacts a PEM-armored EC private key (matches generic [A-Z ]* prefix)", () => {
    const pem = "-----BEGIN EC PRIVATE KEY-----\ndata\n-----END EC PRIVATE KEY-----";
    expect(redact(pem)).toBe("[REDACTED]");
  });

  it("preserves surrounding context", () => {
    const input = "Token is sk_live_abc123XYZ in config.";
    expect(redact(input)).toBe("Token is [REDACTED] in config.");
  });

  it("replaces all occurrences, not just the first", () => {
    const input = "sk_live_aaa and sk_live_bbb";
    expect(redact(input)).toBe("[REDACTED] and [REDACTED]");
  });

  it("redacts mixed patterns in one string", () => {
    const input = "GitHub: ghp_1234567890123456789012345678901234567890 AWS: AKIAIOSFODNN7EXAMPLE";
    expect(redact(input)).toBe("GitHub: [REDACTED] AWS: [REDACTED]");
  });

  it("does not redact strings that look similar but don't match", () => {
    // Lowercase 'akia' is not the AWS pattern (which requires uppercase).
    expect(redact("akiaIOSFODNN7example")).toBe("akiaIOSFODNN7example");
    // Wrong prefix length / format
    expect(redact("sk_test_abc123")).toBe("sk_test_abc123");
    expect(redact("ghp_short")).toBe("ghp_short");
  });

  it("is a pure function (does not mutate input string)", () => {
    const input = "sk_live_abc123";
    expect(redact(input)).toBe("[REDACTED]");
    expect(input).toBe("sk_live_abc123");
  });

  it("is stable across repeated calls with reused global patterns", () => {
    const input = "sk_live_abc123XYZ and ghp_1234567890123456789012345678901234567890";
    expect(redact(input)).toBe("[REDACTED] and [REDACTED]");
    expect(redact(input)).toBe("[REDACTED] and [REDACTED]");
  });
});
