// packages/core/test/ids.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// ids.ts — M C coverage for generateReportId plus the D27 ID-space
// boundary guarantees. generateSessionId itself is exercised end-to-end
// by M B's session tests; this file adds focused coverage of the M C
// report-id surface and the public properties that prevent the two ID
// spaces from coupling in observable ways.

import { describe, expect, it } from "vitest";

import { generateReportId, generateSessionId } from "../src/ids.js";

const REPORT_ID_RE = /^rpt_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_ID_RE = /^sess_[0-9A-HJKMNP-TV-Z]{26}$/;
const FORBIDDEN_CROCKFORD = /[ILOU]/;

describe("generateReportId", () => {
  it("returns the rpt_<26-char Crockford base32 ULID> shape", () => {
    const id = generateReportId();
    expect(id).toMatch(REPORT_ID_RE);
  });

  it("100 consecutive calls are distinct AND already lex-sorted (monotonic factory + ULID timestamp prefix)", () => {
    const ids = Array.from({ length: 100 }, () => generateReportId());
    expect(new Set(ids).size).toBe(ids.length);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("body never contains I/L/O/U (drift guard against regex-authoring typos)", () => {
    for (let i = 0; i < 100; i += 1) {
      const body = generateReportId().slice("rpt_".length);
      expect(body).not.toMatch(FORBIDDEN_CROCKFORD);
    }
  });
});

describe("ID-space boundaries (generateSessionId vs generateReportId)", () => {
  it("report-id monotonicity is preserved when interleaved with session-id calls", () => {
    // This locks the public property needed by D27: generating session ids
    // must not disturb the report-id sequence. The implementation-level
    // independence is established in ids.ts by using separate factories.
    const r1 = generateReportId();
    generateSessionId();
    generateSessionId();
    generateSessionId();
    const r2 = generateReportId();
    generateSessionId();
    const r3 = generateReportId();
    expect(r2 > r1).toBe(true);
    expect(r3 > r2).toBe(true);
  });

  it("disjoint prefix spaces — sess_ and rpt_ never bleed into each other", () => {
    const sess = generateSessionId();
    const rpt = generateReportId();
    expect(sess).toMatch(SESSION_ID_RE);
    expect(rpt).toMatch(REPORT_ID_RE);
    expect(sess.startsWith("rpt_")).toBe(false);
    expect(rpt.startsWith("sess_")).toBe(false);
  });
});
