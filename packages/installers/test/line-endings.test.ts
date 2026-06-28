// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { describe, expect, it } from "vitest";

import { detectLineEnding, normalizeToWriteFormat } from "../src/line-endings.js";

describe("detectLineEnding", () => {
  it("returns LF for all-LF content", () => {
    expect(detectLineEnding("a\nb\nc")).toBe("LF");
  });
  it("returns LF for single LF", () => {
    expect(detectLineEnding("a\n")).toBe("LF");
  });
  it("returns CRLF for all-CRLF content", () => {
    expect(detectLineEnding("a\r\nb\r\nc")).toBe("CRLF");
  });
  it("returns CRLF for single CRLF", () => {
    expect(detectLineEnding("a\r\n")).toBe("CRLF");
  });
  it("returns mixed-or-unknown for CRLF + lone LF", () => {
    expect(detectLineEnding("a\r\nb\nc")).toBe("mixed-or-unknown");
  });
  it("returns mixed-or-unknown for CRLF + lone CR", () => {
    expect(detectLineEnding("a\r\nb\rc")).toBe("mixed-or-unknown");
  });
  it("returns mixed-or-unknown for lone CR (no LF)", () => {
    expect(detectLineEnding("a\rb")).toBe("mixed-or-unknown");
  });
  it("returns mixed-or-unknown for LF + lone CR", () => {
    expect(detectLineEnding("a\nb\rc")).toBe("mixed-or-unknown");
  });
  it("returns mixed-or-unknown for no newlines", () => {
    expect(detectLineEnding("abc")).toBe("mixed-or-unknown");
  });
  it("returns mixed-or-unknown for empty string", () => {
    expect(detectLineEnding("")).toBe("mixed-or-unknown");
  });
});

describe("normalizeToWriteFormat", () => {
  // LF input -> LF target (identity).
  it("LF input + LF target returns identical content", () => {
    expect(normalizeToWriteFormat("a\nb\nc", "LF")).toBe("a\nb\nc");
  });
  // LF input -> CRLF target (single-step conversion).
  it("LF input + CRLF target converts to CRLF", () => {
    expect(normalizeToWriteFormat("a\nb\nc", "CRLF")).toBe("a\r\nb\r\nc");
  });
  // CRLF input -> LF target (normalize-down).
  it("CRLF input + LF target converts to LF", () => {
    expect(normalizeToWriteFormat("a\r\nb\r\nc", "LF")).toBe("a\nb\nc");
  });
  // CRLF input -> CRLF target (identity after normalize-and-restore).
  it("CRLF input + CRLF target returns equivalent CRLF content", () => {
    expect(normalizeToWriteFormat("a\r\nb\r\nc", "CRLF")).toBe("a\r\nb\r\nc");
  });
  // Lone CR input (old-Mac classic).
  it("lone CR input + LF target normalizes to LF", () => {
    expect(normalizeToWriteFormat("a\rb\rc", "LF")).toBe("a\nb\nc");
  });
  it("lone CR input + CRLF target converts to CRLF", () => {
    expect(normalizeToWriteFormat("a\rb\rc", "CRLF")).toBe("a\r\nb\r\nc");
  });
  // Mixed input -- normalization, NOT rejection.
  it("mixed CRLF + LF + lone CR + LF target normalizes all to LF", () => {
    expect(normalizeToWriteFormat("a\r\nb\nc\rd", "LF")).toBe("a\nb\nc\nd");
  });
  it("mixed CRLF + LF + lone CR + CRLF target normalizes all to CRLF", () => {
    expect(normalizeToWriteFormat("a\r\nb\nc\rd", "CRLF")).toBe("a\r\nb\r\nc\r\nd");
  });
  // Edge cases.
  it("empty string + LF target returns empty", () => {
    expect(normalizeToWriteFormat("", "LF")).toBe("");
  });
  it("empty string + CRLF target returns empty", () => {
    expect(normalizeToWriteFormat("", "CRLF")).toBe("");
  });
  it("no newlines + LF target returns unchanged", () => {
    expect(normalizeToWriteFormat("abc", "LF")).toBe("abc");
  });
  it("no newlines + CRLF target returns unchanged", () => {
    expect(normalizeToWriteFormat("abc", "CRLF")).toBe("abc");
  });
  // Idempotence.
  it("idempotent on already-LF content (LF -> LF)", () => {
    const once = normalizeToWriteFormat("a\r\nb", "LF");
    expect(normalizeToWriteFormat(once, "LF")).toBe(once);
  });
  it("idempotent on already-CRLF content (CRLF -> CRLF)", () => {
    const once = normalizeToWriteFormat("a\nb", "CRLF");
    expect(normalizeToWriteFormat(once, "CRLF")).toBe(once);
  });
});
