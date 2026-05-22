// packages/core/test/ids.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// ids.ts — M C coverage for generateReportId plus the D27 ID-space
// boundary guarantees. generateSessionId itself is exercised end-to-end
// by M B's session tests; this file adds focused coverage of the M C
// report-id surface and the public properties that prevent the two ID
// spaces from coupling in observable ways.
//
// The "env-var-driven determinism" describe block at the bottom covers
// the D49 Precondition 2 contract added in M C: VIBEREVERT_TEST_FIXED_NOW
// and VIBEREVERT_TEST_FIXED_ULID_SEED behavior, including the
// trust-critical cache-bypass regressions that prove cacheKey()
// distinguishes `undefined` from `""`.

import {
  VIBEREVERT_TEST_FIXED_NOW,
  VIBEREVERT_TEST_FIXED_ULID_SEED,
} from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import { generateReportId, generateSessionId } from "../src/ids.js";

const REPORT_ID_RE = /^rpt_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_ID_RE = /^sess_[0-9A-HJKMNP-TV-Z]{26}$/;
const FORBIDDEN_CROCKFORD = /[ILOU]/;

/**
 * Per-test scoped env mutation with restore-over-delete semantics.
 *
 * Captures the current values of both VIBEREVERT_TEST_FIXED_* env vars,
 * applies the supplied overrides (undefined → delete, string → set),
 * runs `fn`, then restores the originals in `finally` regardless of
 * whether `fn` threw. Safe even when a parent process already pinned
 * either env var — we restore to that value rather than blindly
 * deleting.
 *
 * Test bodies MAY mutate process.env mid-`fn` (e.g., to toggle the
 * seed and prove the factory rebuilds); the restore still resets to
 * the pre-`withFixedEnv` state.
 *
 * IMPORTANT cache-state caveat: restoring env at the end of `fn`
 * does NOT itself rebuild the cached factory in ids.ts. Cache
 * rebuild only fires on the NEXT generate*Id() call when its
 * recomputed cache key differs from the cached one. So a test that
 * needs the second seeded-mode block to start from a freshly-rebuilt
 * factory (not continue a cached mid-sequence) MUST sandwich the
 * two seeded blocks with an intervening `withFixedEnv({}, () => {
 * generate*Id(); })` so the production-key call forces an actual
 * cache rebuild before the next seeded entry. The reproducibility
 * tests below illustrate the pattern.
 *
 * Extracted because 8+ consumers (the env-driven tests below) all
 * use the identical pattern — well past the "extract on 3rd
 * consumer" threshold.
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

describe("env-var-driven determinism (D49 Precondition 2)", () => {
  it("production mode (no env vars): both session AND report IDs match shape AND are distinct", () => {
    withFixedEnv({}, () => {
      const sess1 = generateSessionId();
      const sess2 = generateSessionId();
      const rpt1 = generateReportId();
      const rpt2 = generateReportId();

      expect(sess1).toMatch(SESSION_ID_RE);
      expect(sess2).toMatch(SESSION_ID_RE);
      expect(rpt1).toMatch(REPORT_ID_RE);
      expect(rpt2).toMatch(REPORT_ID_RE);
      // Monotonic factory makes consecutive IDs strictly distinct
      // even at sub-millisecond resolution. Asserted for BOTH ID
      // spaces — locks production parity across the two factories.
      expect(sess1).not.toBe(sess2);
      expect(rpt1).not.toBe(rpt2);
    });
  });

  it("seeded mode produces reproducible session IDs across factory cache rebuilds", () => {
    // Generate one ID under seed alpha, force a real factory rebuild
    // via an intervening production-key call, then re-enter seed
    // alpha and generate again. The FIRST ID after each (re)entry
    // must be identical — that's the reproducibility contract the
    // golden harness depends on.
    //
    // IMPORTANT: just calling withFixedEnv({...alpha}) twice in a
    // row does NOT force a rebuild — withFixedEnv only mutates env,
    // not the factory cache. Cache rebuild only fires inside
    // generate*Id() when the recomputed cache key differs from the
    // cached one. The middle withFixedEnv({}) + generateSessionId()
    // is the rebuild trigger.
    let firstFromAttempt1 = "";
    let firstFromAttempt2 = "";
    withFixedEnv({ seed: "fixture-seed-alpha" }, () => {
      firstFromAttempt1 = generateSessionId();
    });
    withFixedEnv({}, () => {
      generateSessionId(); // production-key call → forces rebuild on next seeded entry
    });
    withFixedEnv({ seed: "fixture-seed-alpha" }, () => {
      firstFromAttempt2 = generateSessionId();
    });
    expect(firstFromAttempt1).toBe(firstFromAttempt2);
    expect(firstFromAttempt1).toMatch(SESSION_ID_RE);
  });

  it("seeded mode produces reproducible report IDs across factory cache rebuilds", () => {
    // Same pattern as the session reproducibility test above —
    // see that test's IMPORTANT note on the intervening-rebuild
    // call.
    let firstFromAttempt1 = "";
    let firstFromAttempt2 = "";
    withFixedEnv({ seed: "fixture-seed-beta" }, () => {
      firstFromAttempt1 = generateReportId();
    });
    withFixedEnv({}, () => {
      generateReportId(); // production-key call → forces rebuild on next seeded entry
    });
    withFixedEnv({ seed: "fixture-seed-beta" }, () => {
      firstFromAttempt2 = generateReportId();
    });
    expect(firstFromAttempt1).toBe(firstFromAttempt2);
    expect(firstFromAttempt1).toMatch(REPORT_ID_RE);
  });

  it("seeded mode: session vs report produce DIFFERENT random portions (namespace subseed)", () => {
    // Under the same outer seed, the per-namespace subseed
    // (`${seed}|core:session` vs `${seed}|core:report`) MUST produce
    // distinct PRNG streams. Time prefix will match (both use the
    // same fixed time component), so we compare ONLY the trailing
    // 16-char random portion.
    withFixedEnv({ seed: "shared-seed-for-namespace-test" }, () => {
      const sessionBody = generateSessionId().slice("sess_".length);
      const reportBody = generateReportId().slice("rpt_".length);
      // ULID = 10-char time + 16-char random. Time portion identical
      // under the locked fallback time; random portion must differ.
      const sessionRandom = sessionBody.slice(10);
      const reportRandom = reportBody.slice(10);
      expect(sessionRandom).not.toBe(reportRandom);
    });
  });

  it("env toggle mid-test rebuilds the factory (different IDs for different seeds)", () => {
    withFixedEnv({ seed: "seed-A" }, () => {
      const a = generateSessionId();
      // Mutate env mid-test — the next call MUST see the new key
      // (`seed-B` instead of `seed-A`) and rebuild the factory.
      process.env[VIBEREVERT_TEST_FIXED_ULID_SEED] = "seed-B";
      const b = generateSessionId();
      // Random portion must differ across seeds; time prefix is the
      // same fixed fallback so we focus the assertion on the random
      // suffix.
      const aRandom = a.slice("sess_".length + 10);
      const bRandom = b.slice("sess_".length + 10);
      expect(aRandom).not.toBe(bRandom);
    });
  });

  it("VIBEREVERT_TEST_FIXED_NOW set to regex-failing garbage throws on next ID call", () => {
    withFixedEnv({ now: "not-an-iso-date" }, () => {
      expect(() => generateSessionId()).toThrow(/VIBEREVERT_TEST_FIXED_NOW/);
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
    // validation branch fires — refactors that weaken EITHER branch
    // would have to compensate via the other to keep this passing.
    withFixedEnv({ now: "2026-02-30T00:00:00Z" }, () => {
      expect(() => generateSessionId()).toThrow(/VIBEREVERT_TEST_FIXED_NOW/);
    });
  });

  it("setting VIBEREVERT_TEST_FIXED_ULID_SEED='' AFTER a production call throws (cacheKey distinguishes unset vs empty)", () => {
    // Prime the cache with a production-mode factory FIRST.
    withFixedEnv({}, () => {
      generateSessionId();
    });
    // Now toggle SEED to empty string. The cacheKey for this state
    // (`["core:session", "", null]`) MUST differ from the cached
    // production-state key (`["core:session", null, null]`), forcing
    // buildFactory to run and throw the empty-seed error. A naive
    // delimited cache key would collapse these two states and the
    // throw would be silently bypassed — this test is the regression
    // gate for that bug class.
    withFixedEnv({ seed: "" }, () => {
      expect(() => generateSessionId()).toThrow(/VIBEREVERT_TEST_FIXED_ULID_SEED/);
    });
  });

  it("setting VIBEREVERT_TEST_FIXED_NOW='' AFTER a production call throws (cacheKey distinguishes unset vs empty)", () => {
    // Same regression class as the SEED='' test above, but for NOW.
    // Empty NOW fails parseFixedTimeMs's regex check; the cacheKey
    // distinction ensures we actually REACH parseFixedTimeMs instead
    // of cache-hitting the prior production factory.
    withFixedEnv({}, () => {
      generateSessionId();
    });
    withFixedEnv({ now: "" }, () => {
      expect(() => generateSessionId()).toThrow(/VIBEREVERT_TEST_FIXED_NOW/);
    });
  });
});
