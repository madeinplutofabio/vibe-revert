// scripts/refresh-sri.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Strict Subresource-Integrity (SRI) verifier for the M H5 license-metadata
// refresh (see docs/adr/0001-deterministic-license-audit.md). A fetched tarball is
// trusted only if its bytes satisfy the committed lockfile integrity, so this
// module verifies bytes against an SRI string WITHOUT trusting its exact shape:
//   - bounds the integrity string length and token count before any allocation;
//   - tokenizes on ASCII whitespace only (tab/LF/FF/CR/space); Unicode whitespace
//     stays inside a token and is rejected by the token grammar (fail-closed);
//   - validates EVERY token's base64 as canonical (accepting either padded OR
//     unpadded, since npm/ssri emit unpadded digests) and, for a known algorithm,
//     against its exact digest length — sha1 included, so a malformed sha1 token
//     rejects the whole integrity even when a valid sha512 is present;
//   - accepts sha256 / sha384 / sha512 for verification; sha1 is validated but
//     never selectable (no silent downgrade); an unknown algorithm fails closed;
//   - selects the STRONGEST supported algorithm present and succeeds iff at least
//     one committed digest of that algorithm matches the bytes, comparing
//     matching-length digests with timingSafeEqual (the digests are public, so the
//     overall selection is not claimed to be constant-time);
//   - rejects the whole integrity if ANY token is malformed.
// It computes hashes only; URL, HTTPS/SSRF, and network policy live elsewhere.

import { createHash, timingSafeEqual } from "node:crypto";

const MAX_INTEGRITY_LENGTH = 16_384;
const MAX_INTEGRITY_TOKENS = 64;

type SupportedAlgorithm = "sha256" | "sha384" | "sha512";
type KnownAlgorithm = "sha1" | SupportedAlgorithm;

const KNOWN_DIGEST_BYTES: Readonly<Record<KnownAlgorithm, number>> = {
  sha1: 20,
  sha256: 32,
  sha384: 48,
  sha512: 64,
};
const STRENGTH: Readonly<Record<SupportedAlgorithm, number>> = { sha256: 1, sha384: 2, sha512: 3 };

export type SriResult =
  | { readonly ok: true; readonly algorithm: SupportedAlgorithm }
  | { readonly ok: false; readonly reason: string };

interface SupportedDigest {
  readonly algo: SupportedAlgorithm;
  readonly digest: Buffer;
}

function truncate(s: string): string {
  return s.length <= 64 ? s : `${s.slice(0, 64)}… (${s.length} chars)`;
}

function isKnownAlgorithm(a: string): a is KnownAlgorithm {
  return a === "sha1" || a === "sha256" || a === "sha384" || a === "sha512";
}

function isSupportedAlgorithm(a: string): a is SupportedAlgorithm {
  return a === "sha256" || a === "sha384" || a === "sha512";
}

/**
 * Decode a base64 digest that is canonical in EITHER padded or unpadded form (npm
 * and ssri emit unpadded digests), rejecting non-canonical encodings and any digest
 * whose decoded length does not match the algorithm. Returns null on any violation.
 */
function decodeCanonicalDigest(b64: string, expectedBytes: number): Buffer | null {
  // A base64 value can never have a length remainder of 1.
  if (b64.length % 4 === 1) {
    return null;
  }
  const hasPadding = b64.includes("=");
  // Padding is allowed only at the end, at most two "=", and only on a length that
  // is a multiple of four.
  if (hasPadding && (!/^[A-Za-z0-9+/]+={1,2}$/.test(b64) || b64.length % 4 !== 0)) {
    return null;
  }
  const padded = hasPadding ? b64 : `${b64}${"=".repeat((4 - (b64.length % 4)) % 4)}`;
  const decoded = Buffer.from(padded, "base64");
  if (decoded.length !== expectedBytes) {
    return null;
  }
  const canonicalPadded = decoded.toString("base64");
  const canonicalUnpadded = canonicalPadded.replace(/=+$/, "");
  return b64 === canonicalPadded || b64 === canonicalUnpadded ? decoded : null;
}

// ASCII whitespace that may separate SRI tokens (tab, LF, FF, CR, space). Unicode
// whitespace is deliberately NOT a separator: it stays part of a token and then
// fails the token grammar, so it is rejected rather than silently splitting.
function isAsciiSpace(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

function tokenizeIntegrity(
  integrity: string,
): { ok: true; tokens: readonly string[] } | { ok: false; reason: string } {
  if (integrity.length > MAX_INTEGRITY_LENGTH) {
    return { ok: false, reason: `integrity exceeds ${MAX_INTEGRITY_LENGTH} UTF-16 code units` };
  }
  const tokens: string[] = [];
  let i = 0;
  const n = integrity.length;
  while (i < n) {
    if (isAsciiSpace(integrity.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < n && !isAsciiSpace(integrity.charCodeAt(i))) {
      i += 1;
    }
    if (tokens.length >= MAX_INTEGRITY_TOKENS) {
      return { ok: false, reason: `integrity has more than ${MAX_INTEGRITY_TOKENS} tokens` };
    }
    tokens.push(integrity.slice(start, i));
  }
  if (tokens.length === 0) {
    return { ok: false, reason: "integrity has no tokens" };
  }
  return { ok: true, tokens };
}

/**
 * Parse an SRI string into the supported-algorithm digests it commits to. Exported
 * for direct testing of the parse/validation stage independently of any bytes.
 */
export function parseIntegrity(
  integrity: string,
): { ok: true; digests: readonly SupportedDigest[] } | { ok: false; reason: string } {
  if (typeof integrity !== "string" || integrity.length === 0) {
    return { ok: false, reason: "integrity is empty" };
  }
  const tok = tokenizeIntegrity(integrity);
  if (!tok.ok) {
    return tok;
  }
  const digests: SupportedDigest[] = [];
  for (const token of tok.tokens) {
    const m = /^([a-zA-Z0-9]+)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    const rawAlgo = m?.[1]?.toLowerCase();
    const b64 = m?.[2];
    if (rawAlgo === undefined || b64 === undefined) {
      return { ok: false, reason: `malformed integrity token ${JSON.stringify(truncate(token))}` };
    }
    if (!isKnownAlgorithm(rawAlgo)) {
      return {
        ok: false,
        reason: `unsupported integrity algorithm ${JSON.stringify(truncate(rawAlgo))}`,
      };
    }
    const decoded = decodeCanonicalDigest(b64, KNOWN_DIGEST_BYTES[rawAlgo]);
    if (decoded === null) {
      return { ok: false, reason: `malformed ${rawAlgo} digest in integrity` };
    }
    // sha1 is validated for well-formedness but never selectable for verification.
    if (isSupportedAlgorithm(rawAlgo)) {
      digests.push({ algo: rawAlgo, digest: decoded });
    }
  }
  if (digests.length === 0) {
    return {
      ok: false,
      reason: "integrity has no supported algorithm (need sha256, sha384, or sha512)",
    };
  }
  return { ok: true, digests };
}

/** Verify that `bytes` satisfy the committed SRI `integrity`. */
export function verifyIntegrity(bytes: Buffer, integrity: string): SriResult {
  const parsed = parseIntegrity(integrity);
  if (!parsed.ok) {
    return parsed;
  }
  let strongest: SupportedDigest | undefined;
  for (const d of parsed.digests) {
    if (strongest === undefined || STRENGTH[d.algo] > STRENGTH[strongest.algo]) {
      strongest = d;
    }
  }
  if (strongest === undefined) {
    return { ok: false, reason: "integrity has no supported algorithm" };
  }
  const chosen = strongest;
  const actual = createHash(chosen.algo).update(bytes).digest();
  const matched = parsed.digests.some(
    (d) =>
      d.algo === chosen.algo &&
      d.digest.length === actual.length &&
      timingSafeEqual(d.digest, actual),
  );
  if (!matched) {
    return { ok: false, reason: `${chosen.algo} digest mismatch` };
  }
  return { ok: true, algorithm: chosen.algo };
}
