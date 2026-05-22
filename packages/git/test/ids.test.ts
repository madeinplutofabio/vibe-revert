// packages/git/test/ids.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// ids.ts — focused coverage for generateCheckpointId. Until M C this
// function was tested implicitly via end-to-end checkpoint tests in
// restore.test.ts / diff.test.ts / find-checkpoint-by-name.test.ts /
// checkpoint.test.ts. M C's D49 Precondition 2 (env-var-driven ULID
// determinism for the fixture harness) makes the contract worth
// locking explicitly: shape, monotonicity, Crockford alphabet, AND
// the four-mode env-driven behavior matrix with its cache-bypass
// regression coverage.
//
// The "env-var-driven determinism" describe block mirrors the same
// block in @viberevert/core/test/ids.test.ts — both packages share
// the duplicated parseFixedTimeMs + cacheKey helpers per D17c, so
// the per-package tests independently lock both copies' behavior.

import {
  VIBEREVERT_TEST_FIXED_NOW,
  VIBEREVERT_TEST_FIXED_ULID_SEED,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { generateCheckpointId } from "../src/ids.js";

const CHECKPOINT_ID_RE = /^cp_[0-9A-HJKMNP-TV-Z]{26}$/;
const FORBIDDEN_CROCKFORD = /[ILOU]/;

/**
 * Per-test scoped env mutation with restore-over-delete semantics.
 *
 * Duplicated from @viberevert/core/test/ids.test.ts per D17c
 * trivial-helper discipline (the helper itself is ~30 LOC; the
 * alternative would be a shared test-utils package, which would
 * widen the dep graph for a test-only convenience).
 *
 * See the core copy's docstring for the full contract, especially
 * the cache-state caveat: restoring env at the end of `fn` does
 * NOT itself rebuild the cached factory in ids.ts — rebuild only
 * fires on the NEXT generate*Id() call when its recomputed cache
 * key differs from the cached one. Reproducibility tests that need
 * a real factory rebuild between seeded-mode blocks must sandwich
 * them with an intervening `withFixedEnv({}, () => generate*Id())`
 * call (the seeded-reproducibility test below illustrates).
 */
function withFixedEnv(env: { seed?: string; now?: string }, fn: () => void): void {
  const previousSeed = process.env[VIBEREVERT_TEST_FIXED_ULID_SEED];
  const previousNow = process.env[VIBEREVERT_TEST_FIXED_NOW];
  try {
    if (env.seed === undefined) {
      delete process.env[VIBEREVERT_TEST_FIXED_ULID_SEED];
    } else {
      process.env[VIBEREVERT_TEST_FIXED_ULID_SEED] = env.seed;
    }
    if (env.now === undefined) {
      delete process.env[VIBEREVERT_TEST_FIXED_NOW];
    } else {
      process.env[VIBEREVERT_TEST_FIXED_NOW] = env.now;
    }
    fn();
  } finally {
    if (previousSeed === undefined) {
      delete process.env[VIBEREVERT_TEST_FIXED_ULID_SEED];
    } else {
      process.env[VIBEREVERT_TEST_FIXED_ULID_SEED] = previousSeed;
    }
    if (previousNow === undefined) {
      delete process.env[VIBEREVERT_TEST_FIXED_NOW];
    } else {
      process.env[VIBEREVERT_TEST_FIXED_NOW] = previousNow;
    }
  }
}

describe("generateCheckpointId", () => {
  it("returns the cp_<26-char Crockford base32 ULID> shape", () => {
    const id = generateCheckpointId();
    expect(id).toMatch(CHECKPOINT_ID_RE);
  });

  it("100 consecutive calls are distinct AND already lex-sorted (monotonic factory + ULID timestamp prefix)", () => {
    const ids = Array.from({ length: 100 }, () => generateCheckpointId());
    expect(new Set(ids).size).toBe(ids.length);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("body never contains I/L/O/U (drift guard against regex-authoring typos)", () => {
    for (let i = 0; i < 100; i += 1) {
      const body = generateCheckpointId().slice("cp_".length);
      expect(body).not.toMatch(FORBIDDEN_CROCKFORD);
    }
  });
});

describe("env-var-driven determinism (D49 Precondition 2)", () => {
  it("production mode (no env vars): IDs match shape AND are distinct", () => {
    withFixedEnv({}, () => {
      const id1 = generateCheckpointId();
      const id2 = generateCheckpointId();
      expect(id1).toMatch(CHECKPOINT_ID_RE);
      expect(id2).toMatch(CHECKPOINT_ID_RE);
      // Monotonic factory makes consecutive IDs strictly distinct
      // even at sub-millisecond resolution.
      expect(id1).not.toBe(id2);
    });
  });

  it("seeded mode produces reproducible checkpoint IDs across factory cache rebuilds", () => {
    // Generate one ID under seed alpha, force a real factory rebuild
    // via an intervening production-key call, then re-enter seed
    // alpha and generate again. The FIRST ID after each (re)entry
    // must be identical — that's the reproducibility contract the
    // golden harness depends on.
    //
    // IMPORTANT: just calling withFixedEnv({...alpha}) twice in a
    // row does NOT force a rebuild — withFixedEnv only mutates env,
    // not the factory cache. Cache rebuild only fires inside
    // generateCheckpointId() when the recomputed cache key differs
    // from the cached one. The middle withFixedEnv({}) +
    // generateCheckpointId() is the rebuild trigger.
    let firstFromAttempt1 = "";
    let firstFromAttempt2 = "";
    withFixedEnv({ seed: "fixture-seed-alpha" }, () => {
      firstFromAttempt1 = generateCheckpointId();
    });
    withFixedEnv({}, () => {
      generateCheckpointId(); // production-key call → forces rebuild on next seeded entry
    });
    withFixedEnv({ seed: "fixture-seed-alpha" }, () => {
      firstFromAttempt2 = generateCheckpointId();
    });
    expect(firstFromAttempt1).toBe(firstFromAttempt2);
    expect(firstFromAttempt1).toMatch(CHECKPOINT_ID_RE);
  });

  it("env toggle mid-test rebuilds the factory (different IDs for different seeds)", () => {
    withFixedEnv({ seed: "seed-A" }, () => {
      const a = generateCheckpointId();
      // Mutate env mid-test — the next call MUST see the new key
      // (`seed-B` instead of `seed-A`) and rebuild the factory.
      process.env[VIBEREVERT_TEST_FIXED_ULID_SEED] = "seed-B";
      const b = generateCheckpointId();
      // Random portion must differ across seeds; time prefix is the
      // same fixed fallback so we focus the assertion on the random
      // suffix.
      const aRandom = a.slice("cp_".length + 10);
      const bRandom = b.slice("cp_".length + 10);
      expect(aRandom).not.toBe(bRandom);
    });
  });

  it("VIBEREVERT_TEST_FIXED_NOW set to regex-failing garbage throws on next ID call", () => {
    withFixedEnv({ now: "not-an-iso-date" }, () => {
      expect(() => generateCheckpointId()).toThrow(/VIBEREVERT_TEST_FIXED_NOW/);
    });
  });

  it("VIBEREVERT_TEST_FIXED_NOW with calendar-invalid canonical drift throws", () => {
    // "2026-02-30T00:00:00Z" passes the regex shape check but is
    // calendar-invalid. Depending on V8 strictness, Date.parse may
    // either return NaN (caught by the Number.isFinite check) OR
    // silently normalize to "2026-03-02T00:00:00Z" (caught by the
    // canonical round-trip check). Either way, the OUTCOME contract
    // is the same: invalid NOW throws with the env-var name in the
    // message. This test locks that outcome regardless of which
    // validation branch fires.
    withFixedEnv({ now: "2026-02-30T00:00:00Z" }, () => {
      expect(() => generateCheckpointId()).toThrow(/VIBEREVERT_TEST_FIXED_NOW/);
    });
  });

  it("setting VIBEREVERT_TEST_FIXED_ULID_SEED='' AFTER a production call throws (cacheKey distinguishes unset vs empty)", () => {
    // Prime the cache with a production-mode factory FIRST.
    withFixedEnv({}, () => {
      generateCheckpointId();
    });
    // Now toggle SEED to empty string. The cacheKey for this state
    // (`["git:checkpoint", "", null]`) MUST differ from the cached
    // production-state key (`["git:checkpoint", null, null]`),
    // forcing buildFactory to run and throw the empty-seed error.
    // A naive delimited cache key would collapse these two states
    // and the throw would be silently bypassed — this test is the
    // regression gate for that bug class.
    withFixedEnv({ seed: "" }, () => {
      expect(() => generateCheckpointId()).toThrow(/VIBEREVERT_TEST_FIXED_ULID_SEED/);
    });
  });

  it("setting VIBEREVERT_TEST_FIXED_NOW='' AFTER a production call throws (cacheKey distinguishes unset vs empty)", () => {
    // Same regression class as the SEED='' test above, but for NOW.
    // Empty NOW fails parseFixedTimeMs's regex check; the cacheKey
    // distinction ensures we actually REACH parseFixedTimeMs instead
    // of cache-hitting the prior production factory.
    withFixedEnv({}, () => {
      generateCheckpointId();
    });
    withFixedEnv({ now: "" }, () => {
      expect(() => generateCheckpointId()).toThrow(/VIBEREVERT_TEST_FIXED_NOW/);
    });
  });
});
