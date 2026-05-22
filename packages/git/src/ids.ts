// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// ID factory for @viberevert/git: checkpoint IDs (`cp_<ULID>`).
// Per D5/D16 in the M B plan, each package owns its own ID-space
// monotonic factory: git owns checkpoint here, @viberevert/core owns
// session + report.
//
// =============================================================================
// Architectural locks (must be preserved by all changes here)
// =============================================================================
//
// 1. **D5/D16 — independent ID spaces.** Checkpoint uses a SEPARATE
//    monotonicFactory() instance, in a SEPARATE package from
//    @viberevert/core's session and report factories. No cross-
//    coordination on monotonic sequence or timestamp.
//
// 2. **D17b — caller owns paths, factory owns IDs.** The factory
//    returns `cp_<ULID>` strings; callers use them verbatim in
//    storage paths (e.g., `.viberevert/checkpoints/${checkpointId}/`).
//    NEVER prepend `cp_` again.
//
// 3. **D49 Precondition 2 — env-var-driven determinism for fixtures.**
//    Four behavior modes, keyed on the two test-only env vars:
//
//      a) Neither set (production path): `monotonicFactory()` +
//         `Date.now()`. Unchanged from M B.
//      b) `VIBEREVERT_TEST_FIXED_NOW` only: `monotonicFactory()` +
//         parsed NOW as the ULID time component. Time-deterministic;
//         random suffix still varies per-call. Useful for tests that
//         pin wall-clock time but tolerate random IDs.
//      c) `VIBEREVERT_TEST_FIXED_ULID_SEED` only: seeded PRNG
//         (Mulberry32 from FNV-1a 32-bit hash of `${seed}|${namespace}`,
//         per-namespace subseeded so each factory's random progression
//         is independent — otherwise multiple factories with the same
//         seed would emit ULIDs with identical random-suffix
//         progressions, a subtle bug surface). Time component falls
//         back to the locked default `2026-01-01T00:00:00Z`. Fully
//         deterministic.
//      d) Both env vars set (M C Step 10 fixture-harness path):
//         seeded PRNG + parsed NOW as time component. Fully
//         deterministic. The byte-stable mode goldens depend on.
//
//    Validation: `VIBEREVERT_TEST_FIXED_NOW` (when set) MUST match
//    the exact second-precision ISO 8601 with Z-offset shape AND
//    round-trip canonically through `new Date(ms).toISOString()`.
//    Lenient JS date parsing (e.g., "2026-02-30T..." silently
//    normalized to March 2) would otherwise let a typo produce
//    non-deterministic-from-user-perspective output. Plain `Error`
//    on violation. `VIBEREVERT_TEST_FIXED_ULID_SEED` (when set) MUST
//    be non-empty.
//
// 4. **Lazy env-keyed factory cache (per namespace).** Env is read
//    on EVERY call, not just at module load — tests that
//    set/restore `process.env[VIBEREVERT_TEST_FIXED_*]` per-test
//    need the factory to rebuild when the env state changes.
//    Cache key is constructed via `cacheKey(namespace, seed, fixedNow)`
//    which JSON-stringifies a tuple so `undefined` and `""` are
//    distinguishable (collapsing them would let a malformed empty
//    env value silently reuse a cached production factory,
//    bypassing the validation that should fire on the new env
//    state). A stable key means we keep the existing monotonic
//    sequence going (correct production behavior + correct seeded
//    determinism); a key change rebuilds the factory from scratch.
//
// 5. **No CLI-typed errors.** Git cannot import the CLI's
//    `RuntimeEnvInvalidError` per the dep-direction rule. Invalid
//    `VIBEREVERT_TEST_FIXED_NOW` or empty `VIBEREVERT_TEST_FIXED_ULID_SEED`
//    values throw a plain `Error` with a precise message naming
//    the offending env var and the violated expectation.
//
// 6. **Helpers duplicated with @viberevert/core/src/ids.ts.** The
//    Mulberry32 PRNG, FNV-1a hash, parseFixedTimeMs, and cacheKey
//    are duplicated across the two ID modules per D17c's trivial-
//    helper discipline. Both copies must stay byte-identical — if
//    you change one, mirror the change to the other.

import {
  VIBEREVERT_TEST_FIXED_NOW,
  VIBEREVERT_TEST_FIXED_ULID_SEED,
} from "@viberevert/session-format";
import { monotonicFactory, type PRNG } from "ulid";

// =============================================================================
// Locked constants
// =============================================================================

/**
 * Fallback ULID time component when `VIBEREVERT_TEST_FIXED_ULID_SEED`
 * is set but `VIBEREVERT_TEST_FIXED_NOW` is not. Same sentinel as the
 * Step 10 fixture harness uses for `VIBEREVERT_TEST_FIXED_NOW` —
 * keeping the default-case ULID time prefix identical whether the
 * caller sets both env vars or just SEED.
 */
const FALLBACK_FIXED_NOW = "2026-01-01T00:00:00Z";

/**
 * Exact second-precision ISO 8601 shape required by
 * `VIBEREVERT_TEST_FIXED_NOW` consumers. Matches
 * `z.iso.datetime({ precision: 0, offset: true })` on the persisted
 * artifact schemas. Brittle-by-design: a malformed env value should
 * fail loudly at test time, not silently produce non-deterministic
 * output.
 */
const FIXED_NOW_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// =============================================================================
// Fixed-NOW parsing + validation (used by buildFactory in both seeded and
// NOW-only paths)
// =============================================================================

/**
 * Validate and parse `VIBEREVERT_TEST_FIXED_NOW`'s value to
 * millisecond epoch time, suitable for `monotonicFactory(prng)(timeMs)`.
 *
 * Three independent checks:
 *   1. Regex shape — `YYYY-MM-DDTHH:mm:ssZ`.
 *   2. `Date.parse` returns a finite number.
 *   3. Round-trip canonical equality — `new Date(ms).toISOString()`
 *      stripped to second precision MUST equal the input string.
 *      Catches lenient JS calendar normalization (e.g., a regex-
 *      matching but calendar-invalid `2026-02-30T00:00:00Z` would
 *      `Date.parse` to a valid number that round-trips as
 *      `2026-03-02T00:00:00Z` — silent non-determinism from the
 *      user's perspective).
 *
 * Throws plain `Error` with the env-var name, the offending value,
 * and the expected shape on any failure. Distinct messages for each
 * check so the test-author sees which axis broke.
 */
function parseFixedTimeMs(value: string): number {
  if (!FIXED_NOW_SHAPE.test(value)) {
    throw new Error(
      `${VIBEREVERT_TEST_FIXED_NOW}=${JSON.stringify(value)} is not valid: ` +
        `expected second-precision ISO 8601 with Z offset (YYYY-MM-DDTHH:mm:ssZ).`,
    );
  }

  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(
      `${VIBEREVERT_TEST_FIXED_NOW}=${JSON.stringify(value)} is not valid: ` +
        `expected parseable second-precision ISO 8601 with Z offset (YYYY-MM-DDTHH:mm:ssZ).`,
    );
  }

  const canonical = new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (canonical !== value) {
    throw new Error(
      `${VIBEREVERT_TEST_FIXED_NOW}=${JSON.stringify(value)} is not valid: ` +
        `expected canonical second-precision ISO 8601 with Z offset (YYYY-MM-DDTHH:mm:ssZ).`,
    );
  }

  return ms;
}

// =============================================================================
// Duplicated helpers (mirror in @viberevert/core/src/ids.ts; keep byte-identical)
// =============================================================================

/**
 * 32-bit FNV-1a hash. Stable across Node versions, runs, and
 * platforms — deterministic by spec. Used to convert the
 * `${seed}|${namespace}` string into an integer seed for Mulberry32.
 */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Mulberry32 deterministic PRNG. NOT cryptographic — never used
 * outside test paths gated by `VIBEREVERT_TEST_FIXED_ULID_SEED`.
 * Returns a function `() => number` producing values in `[0, 1)`,
 * matching the `PRNG` shape `monotonicFactory` expects.
 */
function mulberry32(seed: number): PRNG {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =============================================================================
// Env-keyed factory cache
// =============================================================================

/**
 * Internal callable shape: returns a string ULID body (no prefix).
 * The exported function (`generateCheckpointId`) prepends the
 * `cp_` prefix.
 *
 * - Production mode: `monotonicFactory()` invoked with no args
 *   (uses `Date.now()` internally).
 * - NOW-only mode: `monotonicFactory()` invoked with the parsed
 *   fixed time.
 * - Seeded modes (SEED-only, SEED+NOW): `monotonicFactory(prng)`
 *   invoked with the parsed fixed time.
 *
 * All four modes return a string via the same `() => string` thunk.
 */
type UlidThunk = () => string;

interface CachedFactory {
  readonly key: string;
  readonly factory: UlidThunk;
}

/**
 * Construct a cache key for the (namespace, seed, fixedNow) triple.
 *
 * MUST distinguish `undefined` from `""`: a naive
 * `${seed ?? ""}|${fixedNow ?? ""}|${namespace}` would collapse the
 * two, letting a malformed empty env value silently reuse a cached
 * production factory and BYPASS the validation that should fire on
 * the new env state. JSON-stringifying a tuple of
 * `[namespace, seed ?? null, fixedNow ?? null]` keeps `undefined`
 * (→ `null`) and the empty string (→ `""`) as distinct serialized
 * forms. Also avoids delimiter-collision risk (a literal `|` inside
 * a value would shift parsing of the old delimited form).
 */
function cacheKey(
  namespace: string,
  seed: string | undefined,
  fixedNow: string | undefined,
): string {
  return JSON.stringify([namespace, seed ?? null, fixedNow ?? null]);
}

/**
 * Build the (key, factory) pair for the current env state under the
 * given namespace. Pure: reads `process.env` but does not mutate
 * anything. Throws plain `Error` if:
 *   - `VIBEREVERT_TEST_FIXED_ULID_SEED` is set but empty;
 *   - `VIBEREVERT_TEST_FIXED_NOW` is set but malformed (either in
 *     unseeded NOW-only mode OR in seeded mode).
 *
 * Returns the constructed factory in all four behavior modes per
 * lock #3.
 */
function buildFactory(namespace: string): CachedFactory {
  const seed = process.env[VIBEREVERT_TEST_FIXED_ULID_SEED];
  const fixedNow = process.env[VIBEREVERT_TEST_FIXED_NOW];
  const key = cacheKey(namespace, seed, fixedNow);

  if (seed !== undefined && seed.length === 0) {
    throw new Error(`${VIBEREVERT_TEST_FIXED_ULID_SEED} must not be empty when set.`);
  }

  // Unseeded path:
  //   - no NOW: original production behavior, monotonicFactory()
  //     samples Date.now() internally on every call.
  //   - NOW only: random suffix still varies (default crypto PRNG),
  //     but ULID time component is fixed by the parsed NOW value.
  if (seed === undefined) {
    const monotonic = monotonicFactory();
    if (fixedNow === undefined) {
      return { key, factory: () => monotonic() };
    }
    const fixedTimeMs = parseFixedTimeMs(fixedNow);
    return { key, factory: () => monotonic(fixedTimeMs) };
  }

  // Seeded path: deterministic PRNG + deterministic time component.
  // Time sources from NOW when set, falls back to the locked default
  // otherwise. parseFixedTimeMs validates BOTH the user-supplied
  // value AND (defensively) the hardcoded fallback — paranoia, but
  // cheap.
  const fixedTimeMs = parseFixedTimeMs(fixedNow ?? FALLBACK_FIXED_NOW);
  const seedInt = fnv1a32(`${seed}|${namespace}`);
  const prng = mulberry32(seedInt);
  const monotonic = monotonicFactory(prng);

  return { key, factory: () => monotonic(fixedTimeMs) };
}

/**
 * Per-namespace cache. Module-level Map; this package has a single
 * namespace (`git:checkpoint`) but the Map shape mirrors core's
 * for parity (and to keep the byte-identical helpers genuinely
 * byte-identical).
 */
const factoryCache = new Map<string, CachedFactory>();

/**
 * Return the current factory for `namespace`, rebuilding it if the
 * env state changed since the last call. The (env, namespace) key is
 * recomputed on every call so test env toggles take effect on the
 * very next ID generation — no module-reload required.
 */
function getFactory(namespace: string): UlidThunk {
  const seed = process.env[VIBEREVERT_TEST_FIXED_ULID_SEED];
  const fixedNow = process.env[VIBEREVERT_TEST_FIXED_NOW];
  const currentKey = cacheKey(namespace, seed, fixedNow);

  const cached = factoryCache.get(namespace);
  if (cached !== undefined && cached.key === currentKey) {
    return cached.factory;
  }

  const fresh = buildFactory(namespace);
  factoryCache.set(namespace, fresh);
  return fresh.factory;
}

// =============================================================================
// Public API (D5): generateCheckpointId
// =============================================================================

/**
 * Returns a fresh checkpoint id of the form `cp_<ULID>` — e.g.
 * `cp_01JV8Y7W2M7AABCDEFGHIJKLMN`.
 *
 * The returned string is the FULL id including the `cp_` prefix. Never
 * prepend `cp_` to the result, or paths and lookups will double up
 * (`cp_cp_...`). Per D17b in the M B plan, all storage paths use the
 * returned id verbatim: `.viberevert/checkpoints/${checkpointId}/`.
 *
 * Under `VIBEREVERT_TEST_FIXED_ULID_SEED` (per D49 Precondition 2),
 * this factory produces a deterministic ULID sequence keyed on the
 * subseed `git:checkpoint`. See the file header for the full env-var
 * contract.
 */
export function generateCheckpointId(): string {
  return `cp_${getFactory("git:checkpoint")()}`;
}
