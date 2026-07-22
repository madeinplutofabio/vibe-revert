// packages/cli/test/license-sri.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Boundary tests for the strict SRI verifier (scripts/refresh-sri.ts): algorithm
// selection, any-match among equally strong digests, padded/unpadded base64, sha1
// validated-but-non-selectable, whole-string rejection on any malformed token,
// ASCII-only whitespace (accept the five permitted separators, reject others), and
// input bounds.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parseIntegrity, verifyIntegrity } from "../../../scripts/refresh-sri.js";

const BYTES = Buffer.from("the quick brown fox jumps over the lazy dog", "utf8");

type Algo = "sha1" | "sha256" | "sha384" | "sha512";

function sri(algo: Algo, bytes: Buffer = BYTES, opts: { unpadded?: boolean } = {}): string {
  const b64 = createHash(algo).update(bytes).digest("base64");
  return `${algo}-${opts.unpadded ? b64.replace(/=+$/, "") : b64}`;
}

describe("verifyIntegrity", () => {
  it("verifies sha256/sha384/sha512 over the exact bytes", () => {
    for (const algo of ["sha256", "sha384", "sha512"] as const) {
      expect(verifyIntegrity(BYTES, sri(algo))).toEqual({ ok: true, algorithm: algo });
    }
  });

  it("accepts a canonical unpadded base64 digest", () => {
    expect(verifyIntegrity(BYTES, sri("sha256", BYTES, { unpadded: true })).ok).toBe(true);
    expect(verifyIntegrity(BYTES, sri("sha512", BYTES, { unpadded: true })).ok).toBe(true);
  });

  it("selects the strongest supported algorithm across tokens", () => {
    expect(verifyIntegrity(BYTES, `${sri("sha256")} ${sri("sha512")}`)).toEqual({
      ok: true,
      algorithm: "sha512",
    });
  });

  it("accepts when any digest of the strongest algorithm matches", () => {
    const wrong = sri("sha512", Buffer.from("other bytes"));
    expect(verifyIntegrity(BYTES, `${wrong} ${sri("sha512")}`)).toEqual({
      ok: true,
      algorithm: "sha512",
    });
  });

  it("accepts every permitted ASCII token separator", () => {
    for (const separator of [" ", "\t", "\n", "\f", "\r"]) {
      expect(verifyIntegrity(BYTES, `${sri("sha256")}${separator}${sri("sha512")}`)).toEqual({
        ok: true,
        algorithm: "sha512",
      });
    }
  });

  it("validates but never selects sha1; a co-present sha512 verifies", () => {
    expect(verifyIntegrity(BYTES, `${sri("sha1")} ${sri("sha512")}`)).toEqual({
      ok: true,
      algorithm: "sha512",
    });
  });

  it("rejects sha1-only as unsupported (no downgrade)", () => {
    const r = verifyIntegrity(BYTES, sri("sha1"));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("no supported algorithm");
  });

  it("rejects a digest mismatch", () => {
    const r = verifyIntegrity(BYTES, sri("sha512", Buffer.from("other bytes")));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("mismatch");
  });

  it("rejects the whole integrity when any token is malformed, incl. a bad sha1", () => {
    // sha1-AAAA decodes to 3 bytes (not 20); a valid sha512 is co-present.
    expect(verifyIntegrity(BYTES, `sha1-AAAA ${sri("sha512")}`).ok).toBe(false);
  });

  it("rejects an unknown algorithm", () => {
    const md5 = `md5-${createHash("md5").update(BYTES).digest("base64")}`;
    expect(verifyIntegrity(BYTES, md5).ok).toBe(false);
  });

  it("rejects a token separated by non-ASCII (Unicode) whitespace", () => {
    const nbsp = String.fromCharCode(0xa0); // U+00A0, not an ASCII separator
    expect(verifyIntegrity(BYTES, `${sri("sha512")}${nbsp}${sri("sha256")}`).ok).toBe(false);
  });

  it("rejects empty and over-length integrity", () => {
    expect(verifyIntegrity(BYTES, "").ok).toBe(false);
    expect(verifyIntegrity(BYTES, `sha512-${"A".repeat(20_000)}`).ok).toBe(false);
  });

  it("rejects more than the token cap", () => {
    const many = Array.from({ length: 65 }, () => sri("sha512")).join(" ");
    const r = verifyIntegrity(BYTES, many);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("tokens");
  });
});

describe("parseIntegrity", () => {
  it("returns only supported-algorithm digests (sha1 excluded)", () => {
    const r = parseIntegrity(`${sri("sha1")} ${sri("sha256")} ${sri("sha512")}`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.digests.map((d) => d.algo)].sort()).toEqual(["sha256", "sha512"]);
    }
  });

  it("rejects a wrong-length (malformed) digest", () => {
    const base = createHash("sha256").update(BYTES).digest("base64"); // 44 chars, trailing '='
    const wrongLength = base.replace(/=$/, "A"); // 44 unpadded chars -> 33 bytes, not 32
    expect(parseIntegrity(`sha256-${wrongLength}`).ok).toBe(false);
  });

  it("rejects non-canonical or misplaced base64 padding", () => {
    const digest = sri("sha256").slice("sha256-".length); // canonical, 44 chars, trailing '='
    const body = digest.replace(/=$/, ""); // 43 base64 chars, unpadded
    expect(parseIntegrity(`sha256-${digest}=`).ok).toBe(false); // excess padding: 45 chars (len % 4 === 1)
    expect(parseIntegrity(`sha256-${body}===`).ok).toBe(false); // too many pad chars (> 2)
    expect(parseIntegrity("sha256-AAAA=AAAA").ok).toBe(false); // padding in the middle
  });

  it("rejects an empty token list", () => {
    expect(parseIntegrity("   ").ok).toBe(false);
  });
});
