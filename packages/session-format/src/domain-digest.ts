// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Versioned, domain-separated digest construction.
//
// M 0.9.0 step 0A. Extracted from two shipped derivations rather than invented:
// `deriveChangeGroupId` and `deriveFindingId` already built their digests this
// exact way, each with its own private copy of the NUL separator and its own
// inline `createHash` sequence. This module is that construction stated once.
//
// =============================================================================
// Why 0.9.0 needs this fixed NOW, before the records that use it exist
// =============================================================================
//
// Authority digests written by 0.9.0 are read by 1.0.0, which freezes the
// compatibility contract. If their construction is decided casually and
// reinterpreted later, 1.0.0 has to reinterpret historical 0.9.0 authority
// records, which is exactly the migration the versioned-artifact discipline
// exists to avoid. So the construction is fixed here, with vectors, while it is
// still cheap.
//
// =============================================================================
// The three properties, and why each one earns its cost
// =============================================================================
//
// 1. DOMAIN SEPARATION. Two digests over identical bytes in different roles must
//    differ. Without it, a value computed for one position could be replayed in
//    another: an authority digest presented as a scope digest, say. The domain
//    is part of the hashed input, not a prefix on the output, so a consumer
//    cannot strip it.
//
// 2. VERSIONING, inside the domain tag. The tag is `viberevert-<domain>-v<N>`,
//    matching the shipped `viberevert-change-group-v1` and
//    `viberevert-finding-v1` literals byte for byte. Bumping a version changes
//    every digest in that domain, which is the point: a construction change must
//    not silently produce values that look like the old ones.
//
// 3. UNAMBIGUOUS PART BOUNDARIES. Parts are joined with a NUL byte, which cannot
//    occur in any of the inputs these digests take (session ids, rule ids, and
//    JSON-serialized canonical path arrays). Plain concatenation would let
//    `["ab", "c"]` and `["a", "bc"]` collide.
//
// The NUL is a hash INPUT only and never reaches a persisted file, where a raw
// 0x00 byte would make git treat the artifact as binary.
//
// =============================================================================
// What this module deliberately does NOT do
// =============================================================================
//
// It declares no domain registry and no digest for any 0.9.0 artifact. The
// authority snapshot, the scope contract and the expansion record are step 0B,
// held until the discovery finding lands, and a domain constant for a record
// whose shape is unsettled would be a placeholder pretending to be a decision.
// Callers pass their own domain; the two shipped ones are below as the worked
// examples and the regression anchors.

import { createHash } from "node:crypto";

/**
 * The part separator: a single NUL byte.
 *
 * One definition. It previously existed as a private `NUL_SEPARATOR` in both
 * `contribution.ts` and `finding-identity.ts`, which is two authorities over one
 * constant. They now import this.
 */
const PART_SEPARATOR = new Uint8Array([0]);

/**
 * A digest domain and its construction version.
 *
 * Kept as a pair rather than a pre-joined string so the version cannot be
 * forgotten: there is no way to spell a domain without also spelling its
 * version.
 */
export interface DigestDomain {
  /** Lowercase, hyphenated, no version suffix. For example `change-group`. */
  readonly domain: string;
  /** Construction version, starting at 1. Bumping it changes every digest. */
  readonly version: number;
}

/** The hashed domain tag, for example `viberevert-change-group-v1`. */
export function digestDomainTag(domain: DigestDomain): string {
  return `viberevert-${domain.domain}-v${domain.version}`;
}

/**
 * Hex SHA-256 over the domain tag followed by each part, NUL-separated.
 *
 * Returns the bare hex digest with no prefix. A caller that wants
 * `cg_<hex>` or `fnd_<hex>` adds its own, because the prefix belongs to the id
 * format rather than to the digest.
 *
 * Parts are hashed in the order given and the order is significant. A caller
 * whose input is logically a SET must canonicalize before calling, exactly as
 * both shipped derivations do via `normalizePathArray`. This function will not
 * sort for you: doing so silently would make an ordered input unhashable.
 */
export function domainSeparatedDigest(domain: DigestDomain, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(digestDomainTag(domain), "utf8");
  for (const part of parts) {
    hash.update(PART_SEPARATOR);
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

/**
 * The two domains in use today, both shipped in 0.8.0 and both pinned by fixed
 * vectors in their own test files. They are listed here because this module's
 * correctness claim is that it reproduces them byte for byte.
 */
export const CHANGE_GROUP_DOMAIN: DigestDomain = { domain: "change-group", version: 1 };
export const FINDING_DOMAIN: DigestDomain = { domain: "finding", version: 1 };
