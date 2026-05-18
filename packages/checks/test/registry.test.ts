// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/checks/src/registry.ts.
//
// Covers:
//   - BUILTIN_CHECKS shape (array, currently empty in Step 2)
//   - CHECKS_TOGGLE_MAP shape (locked 8-key map per D28):
//     - exactly the 8 locked toggle keys
//     - each key maps to its locked category list
//     - the cluster-summary category "summary" is NOT in any value
//   - deriveEnabledCategories reverse-lookup behavior:
//     - missing keys treated as false
//     - true keys enable ALL their mapped categories (multi-category fan-out)
//     - returns the union across all enabled keys
//     - unknown toggle keys silently ignored (forward-compat)
//     - "summary" specifically rejected as a toggle key (engine-only)
//     - returns a fresh Set on each call (no shared mutation surface)
//   - Registry invariants (LOCK against future drift):
//     - NO registered check emits "summary" directly or via emittedCategories
//       (clusters live in the engine post-process, never in the registry)
//     - every check id is unique (duplicates would collide in dedup)
//     - every check's emittedCategories includes its primary category
//       (otherwise layer-1 pre-run skip can disable a check while its
//       toggle is enabled — counterintuitive failure mode)
//     - no category is mapped by more than one toggle key (would create
//       conflicting toggle semantics)
//     - every toggle value is non-empty and dedup-free (no dead keys,
//       no silent duplicates)
//     - every category in every check's emittedCategories appears in
//       CHECKS_TOGGLE_MAP (engine's toggle filter would silently drop
//       findings from unmapped categories)
//
// The check-related invariants pass trivially in Step 2 because
// BUILTIN_CHECKS is empty. They become load-bearing in Steps 3-7 as real
// checks join the registry — locking the contract NOW means future check
// additions get validated automatically. The CHECKS_TOGGLE_MAP-only
// invariants (mapping uniqueness, value shape) fire today.

import { describe, expect, it } from "vitest";

import type { ChecksToggleConfig } from "../src/index.js";
import { BUILTIN_CHECKS, CHECKS_TOGGLE_MAP, deriveEnabledCategories } from "../src/index.js";

// =============================================================================
// BUILTIN_CHECKS shape
// =============================================================================

describe("BUILTIN_CHECKS", () => {
  it("is an array", () => {
    expect(Array.isArray(BUILTIN_CHECKS)).toBe(true);
  });

  it("is empty in Step 2 (real checks populated by Steps 3-7)", () => {
    expect(BUILTIN_CHECKS).toHaveLength(0);
  });
});

// =============================================================================
// CHECKS_TOGGLE_MAP shape
// =============================================================================

describe("CHECKS_TOGGLE_MAP", () => {
  it("has the locked 8 toggle keys per D28", () => {
    expect(Object.keys(CHECKS_TOGGLE_MAP).sort()).toEqual(
      [
        "auth",
        "dependencies",
        "infra",
        "migrations",
        "payments",
        "scope_expansion",
        "secrets",
        "tests",
      ].sort(),
    );
  });

  it("maps each toggle key to its locked category list", () => {
    // Iterate via Object.entries with a variable key to satisfy both:
    //   - biome's useLiteralKeys (fires only on string-literal indexing)
    //   - TS's noPropertyAccessFromIndexSignature (forbids dot notation
    //     on Record types)
    const expected: Readonly<Record<string, readonly string[]>> = {
      secrets: ["secrets"],
      dependencies: ["dependencies"],
      migrations: ["database"],
      auth: ["auth"],
      payments: ["payments"],
      infra: ["infra", "deployment"],
      tests: ["test-gap"],
      scope_expansion: ["scope-expansion"],
    };
    for (const [key, value] of Object.entries(expected)) {
      expect(CHECKS_TOGGLE_MAP[key]).toEqual(value);
    }
  });

  it("does NOT contain the cluster-summary 'summary' category as a mapped value", () => {
    // Per D28 + D40 lock: "summary" is the engine's clustering category
    // emitted only by clusterFindings. It is NOT user-toggleable, NOT in
    // CHECKS_TOGGLE_MAP. The engine's post-toggle filter runs BEFORE
    // clustering, so cluster summaries always survive regardless of
    // which `checks.*` keys are enabled.
    for (const categories of Object.values(CHECKS_TOGGLE_MAP)) {
      expect(categories).not.toContain("summary");
    }
  });
});

// =============================================================================
// deriveEnabledCategories
// =============================================================================

describe("deriveEnabledCategories", () => {
  it("returns an empty set when all toggles are false", () => {
    const config: ChecksToggleConfig = {
      secrets: false,
      dependencies: false,
      migrations: false,
      auth: false,
      payments: false,
      infra: false,
      tests: false,
      scope_expansion: false,
    };
    const enabled = deriveEnabledCategories(config);
    expect([...enabled]).toEqual([]);
  });

  it("returns an empty set for empty config (all keys treated as false)", () => {
    const enabled = deriveEnabledCategories({});
    expect([...enabled]).toEqual([]);
  });

  it("enables a single category when its toggle key is true", () => {
    const enabled = deriveEnabledCategories({ secrets: true });
    expect([...enabled]).toEqual(["secrets"]);
  });

  it("enables BOTH categories for a multi-category toggle key (infra → infra + deployment)", () => {
    const enabled = deriveEnabledCategories({ infra: true });
    expect([...enabled].sort()).toEqual(["deployment", "infra"]);
  });

  it("returns the union of all enabled categories across all enabled keys", () => {
    const config: ChecksToggleConfig = {
      secrets: true,
      payments: true,
      infra: true,
      scope_expansion: true,
      dependencies: false,
      migrations: false,
      auth: false,
      tests: false,
    };
    const enabled = deriveEnabledCategories(config);
    expect([...enabled].sort()).toEqual(
      ["deployment", "infra", "payments", "scope-expansion", "secrets"].sort(),
    );
  });

  it("silently ignores unknown toggle keys (forward-compat for future config additions)", () => {
    const enabled = deriveEnabledCategories({ secrets: true, future_thing: true });
    expect([...enabled]).toEqual(["secrets"]);
  });

  it("does not enable 'summary' even if config contains summary: true", () => {
    // "summary" is a special engine-only category (per D40 cluster
    // post-process), not just another unknown key. The
    // "silently ignores unknown toggle keys" test above covers the
    // generic case via `future_thing`; this test locks the IMPORTANT
    // NAMED case explicitly. If someone later tries to make `summary`
    // user-toggleable — by adding it to CHECKS_TOGGLE_MAP, or by
    // changing deriveEnabledCategories's unknown-key handling — this
    // test fails immediately.
    const enabled = deriveEnabledCategories({ summary: true });
    expect([...enabled]).toEqual([]);
  });

  it("returns a fresh Set on each invocation (no shared mutation surface)", () => {
    const set1 = deriveEnabledCategories({ secrets: true });
    const set2 = deriveEnabledCategories({ secrets: true });
    expect(set1).not.toBe(set2);
    // Cast away ReadonlySet to test that even if a caller mutates the
    // returned Set, the next invocation produces a fresh result that
    // reflects the toggle config, not prior mutation.
    (set1 as Set<string>).add("MUTATED");
    const set3 = deriveEnabledCategories({ secrets: true });
    expect([...set3]).toEqual(["secrets"]);
  });
});

// =============================================================================
// Registry invariants (LOCK against future drift)
//
// These tests guard the contracts that protect engine.ts from silently
// dropping findings, prevent duplicate-id dedup collisions, and lock the
// CHECKS_TOGGLE_MAP shape. The check-related invariants pass trivially
// in Step 2 because BUILTIN_CHECKS is empty; they become load-bearing
// in Steps 3-7 as checks join the registry.
// =============================================================================

describe("Registry invariants", () => {
  it("NO registered check emits category 'summary' directly or via emittedCategories", () => {
    // Per D40 lock: clusters live in the engine post-process, not in
    // registered checks. A check claiming "summary" — as primary
    // category OR via emittedCategories — would collide with
    // cluster-summary identity. Both fields are asserted to keep the
    // engine-only guarantee airtight.
    for (const check of BUILTIN_CHECKS) {
      const emitted = check.emittedCategories ?? [check.category];
      expect(check.category).not.toBe("summary");
      expect(emitted).not.toContain("summary");
    }
  });

  it("every check id is unique", () => {
    // Duplicate ids would collide in D40's identity-based dedup
    // (`(id, category, file, line, detail)` tuple), causing unpredictable
    // "which finding survives" behavior across re-runs.
    const ids = BUILTIN_CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every check's effective emittedCategories includes its primary category", () => {
    // If a check declares emittedCategories that EXCLUDES its primary
    // category, the engine's layer-1 pre-run skip can disable the check
    // while the user's toggle for `category` is enabled — a
    // counterintuitive failure mode. emittedCategories must be a
    // SUPERSET of [category].
    for (const check of BUILTIN_CHECKS) {
      const emitted = check.emittedCategories ?? [check.category];
      expect(
        emitted.includes(check.category),
        `Check '${check.id}' primary category '${check.category}' must be included in emittedCategories`,
      ).toBe(true);
    }
  });

  it("no CHECKS_TOGGLE_MAP category is mapped by more than one toggle key", () => {
    // A category mapped by two keys would create conflicting toggle
    // semantics: enabling key A enables the category, but disabling
    // key B (which also maps it) would NOT disable it (engine takes
    // the union). Users can't reason about that. Enforce single
    // ownership.
    const ownerByCategory = new Map<string, string>();
    for (const [key, categories] of Object.entries(CHECKS_TOGGLE_MAP)) {
      for (const category of categories) {
        const previousOwner = ownerByCategory.get(category);
        expect(
          previousOwner,
          `Category '${category}' is mapped by both '${previousOwner}' and '${key}'`,
        ).toBeUndefined();
        ownerByCategory.set(category, key);
      }
    }
  });

  it("every CHECKS_TOGGLE_MAP value is non-empty and duplicate-free", () => {
    // A toggle key mapped to `[]` would be a dead key — `true` enables
    // nothing. Duplicates would be silent waste. Both are bugs
    // masquerading as valid config.
    for (const [key, categories] of Object.entries(CHECKS_TOGGLE_MAP)) {
      expect(
        categories.length,
        `Toggle key '${key}' must map to at least one category`,
      ).toBeGreaterThan(0);
      expect(new Set(categories).size, `Toggle key '${key}' has duplicate categories`).toBe(
        categories.length,
      );
    }
  });

  it("every category in every check's emittedCategories appears in CHECKS_TOGGLE_MAP", () => {
    // Per D28 lock: if a check emits a category that isn't mapped to a
    // toggle key, the engine's enabled-category set will never include
    // that category, and the post-toggle filter will silently drop those
    // findings. This invariant catches that bug at test time.
    //
    // NO exception for "summary" — that category is engine-only (D40)
    // and is also asserted absent from emittedCategories by the
    // "NO registered check emits category 'summary'" test above. Layered
    // defense: if a check accidentally lists "summary" in
    // emittedCategories, BOTH that test AND this one will fail.
    const allMappedCategories = new Set<string>();
    for (const cats of Object.values(CHECKS_TOGGLE_MAP)) {
      for (const c of cats) allMappedCategories.add(c);
    }
    for (const check of BUILTIN_CHECKS) {
      const emitted = check.emittedCategories ?? [check.category];
      for (const cat of emitted) {
        expect(
          allMappedCategories.has(cat),
          `Check '${check.id}' emits category '${cat}' which is not in CHECKS_TOGGLE_MAP. ` +
            `Add it to a toggle key in registry.ts, or use one of: ${[...allMappedCategories]
              .sort()
              .join(", ")}`,
        ).toBe(true);
      }
    }
  });
});
