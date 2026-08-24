// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M 0.8.0 step 4a: the observed-state acquisition added to framework-detect.ts,
// plus the invariants that keep it a genuine single source of truth with the
// live detector.
//
// Deliberately a SEPARATE file from framework-detect.test.ts. That suite is
// the behavior-neutrality witness for the acquisition/evaluation split: it
// covers the live detector as it shipped, and it must stay byte-identical so
// its passing proves the refactor changed nothing observable. New surface
// goes here.
//
// Four things are proven:
//   1. FRAMEWORK_OBSERVATION_PATHS really is the derived union of what the
//      detectors probe, in both directions (nothing undeclared is probed,
//      nothing declared is unreachable).
//   2. An incomplete observation map is refused before any signature runs.
//   3. Observed evaluation implements the same signatures.
//   4. Live and observed acquisitions agree on real repositories, EXCEPT for
//      the documented symlink asymmetry, which is asserted rather than
//      glossed over.

import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorktreeState } from "@viberevert/session-format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _detectorsForTests,
  detectFramework,
  detectFrameworksFromObservedStates,
  FRAMEWORK_OBSERVATION_PATHS,
} from "../src/framework-detect.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-frameworkobserved-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// =============================================================================
// Fixtures and helpers
// =============================================================================

/**
 * Detection never inspects a content_ref or target_ref, only `kind`, so a
 * fixed synthetic digest keeps these fixtures readable. If detection ever
 * starts reading the ref, these tests should start failing loudly rather
 * than quietly passing on fabricated content.
 */
const SYNTHETIC_REF = "0".repeat(64);

const ABSENT: WorktreeState = { kind: "absent" };
const DIRECTORY: WorktreeState = { kind: "directory" };
const SYMLINK: WorktreeState = { kind: "symlink", target_ref: SYNTHETIC_REF };

function regular(executable: boolean | null = null): WorktreeState {
  return { kind: "regular", content_ref: SYNTHETIC_REF, executable };
}

/**
 * A complete observation map: every FRAMEWORK_OBSERVATION_PATHS member
 * explicitly `absent`, then the overrides applied. Building from the
 * derived constant rather than a literal means a new signature path
 * automatically joins every fixture instead of silently breaking them.
 */
function observationMap(
  overrides: Readonly<Record<string, WorktreeState>> = {},
): Map<string, WorktreeState> {
  const map = new Map<string, WorktreeState>();
  for (const path of FRAMEWORK_OBSERVATION_PATHS) {
    map.set(path, ABSENT);
  }
  for (const [path, state] of Object.entries(overrides)) {
    map.set(path, state);
  }
  return map;
}

/**
 * Test-local stand-in for what path-state.ts will hand end-capture: observe
 * each signature path with `lstat`, which never follows symlinks.
 *
 * This is a fixture, not a second implementation of the observation layer.
 * It exists so the live-versus-observed cross-check runs against real
 * filesystem state instead of hand-written maps that could agree with the
 * evaluator by construction. Treating every lstat failure as `absent`
 * conflates permission errors with absence, which is fine inside a
 * freshly-created temp directory and would not be fine in production.
 */
function observeFromDisk(root: string): Map<string, WorktreeState> {
  const map = new Map<string, WorktreeState>();
  for (const rel of FRAMEWORK_OBSERVATION_PATHS) {
    try {
      const st = lstatSync(join(root, rel));
      if (st.isSymbolicLink()) {
        map.set(rel, SYMLINK);
      } else if (st.isDirectory()) {
        map.set(rel, DIRECTORY);
      } else if (st.isFile()) {
        map.set(rel, regular());
      } else {
        map.set(rel, { kind: "unsupported", fs_kind: "unknown" });
      }
    } catch {
      map.set(rel, ABSENT);
    }
  }
  return map;
}

/** Every subset of `items`, as arrays. Used to exercise short-circuiting. */
function subsetsOf(items: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let mask = 0; mask < 1 << items.length; mask++) {
    const subset: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item !== undefined && (mask & (1 << i)) !== 0) subset.push(item);
    }
    out.push(subset);
  }
  return out;
}

/**
 * Run one detector against a probe that answers true for exactly `trueSet`
 * and records every path it was asked about, on either predicate.
 */
function probedPaths(
  check: (probe: {
    readonly isFile: (relPath: string) => boolean;
    readonly isDirectory: (relPath: string) => boolean;
  }) => boolean,
  trueSet: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const answer = (relPath: string): boolean => {
    seen.add(relPath);
    return trueSet.has(relPath);
  };
  check({ isFile: answer, isDirectory: answer });
  return seen;
}

/** Union of every path a detector probes across every true/false assignment. */
function allPathsEverProbed(detector: (typeof _detectorsForTests)[number]): Set<string> {
  const everProbed = new Set<string>();
  for (const trueList of subsetsOf(detector.paths)) {
    for (const path of probedPaths(detector.check, new Set(trueList))) {
      everProbed.add(path);
    }
  }
  return everProbed;
}

// =============================================================================
// FRAMEWORK_OBSERVATION_PATHS: derived, sorted, complete
// =============================================================================

describe("FRAMEWORK_OBSERVATION_PATHS", () => {
  it("is exactly the expected signature-path set", () => {
    // Written out by hand ON PURPOSE. The source derives this list from the
    // detector declarations; asserting the derived value against a literal
    // is what turns a silent addition or removal of a signature path into a
    // failing test rather than an invisible behavior change at end-capture.
    expect(FRAMEWORK_OBSERVATION_PATHS).toEqual([
      ".lovable",
      "Gemfile",
      "artisan",
      "composer.json",
      "config/routes.rb",
      "manage.py",
      "next.config.cjs",
      "next.config.js",
      "next.config.mjs",
      "next.config.ts",
      "pyproject.toml",
      "requirements.txt",
    ]);
  });

  it("is sorted ascending", () => {
    expect([...FRAMEWORK_OBSERVATION_PATHS]).toEqual([...FRAMEWORK_OBSERVATION_PATHS].sort());
  });

  it("contains no duplicates", () => {
    expect(new Set(FRAMEWORK_OBSERVATION_PATHS).size).toBe(FRAMEWORK_OBSERVATION_PATHS.length);
  });

  it("equals the union of every detector's declared paths", () => {
    const declared = new Set(_detectorsForTests.flatMap((d) => d.paths));
    expect([...FRAMEWORK_OBSERVATION_PATHS].sort()).toEqual([...declared].sort());
  });

  it("uses POSIX separators, so it is comparable with repo-relative paths", () => {
    for (const path of FRAMEWORK_OBSERVATION_PATHS) {
      expect(path).not.toContain("\\");
    }
  });
});

// =============================================================================
// The declaration invariant: `paths` is neither under- nor over-stated
// =============================================================================

describe("detector path declarations", () => {
  it("every detector declares at least one path", () => {
    for (const detector of _detectorsForTests) {
      expect(detector.paths.length, `${detector.profile} declares no paths`).toBeGreaterThan(0);
    }
  });

  // One `it` per detector so a failure names the culprit directly.
  for (const detector of _detectorsForTests) {
    it(`${detector.profile} probes only paths it declares`, () => {
      const declared = new Set(detector.paths);
      for (const path of allPathsEverProbed(detector)) {
        expect(declared.has(path), `${detector.profile} probed undeclared path ${path}`).toBe(true);
      }
    });

    it(`${detector.profile} probes every path it declares under some input`, () => {
      // Short-circuiting means no single input reaches every path: an AND
      // chain stops at the first false, an OR chain at the first true.
      // Sweeping all assignments is what makes a stale declaration visible.
      expect([...allPathsEverProbed(detector)].sort()).toEqual([...detector.paths].sort());
    });
  }

  it("the detectors collectively probe exactly FRAMEWORK_OBSERVATION_PATHS", () => {
    const probed = new Set<string>();
    for (const detector of _detectorsForTests) {
      for (const path of allPathsEverProbed(detector)) probed.add(path);
    }
    expect([...probed].sort()).toEqual([...FRAMEWORK_OBSERVATION_PATHS].sort());
  });
});

// =============================================================================
// Fail-closed: an incomplete observation map is refused
// =============================================================================

describe("detectFrameworksFromObservedStates: completeness enforcement", () => {
  it.each(
    FRAMEWORK_OBSERVATION_PATHS.map((path) => [path] as const),
  )("throws when the observation for %s is missing", (missing) => {
    const states = observationMap();
    states.delete(missing);
    expect(() => detectFrameworksFromObservedStates(states)).toThrow(
      `missing required observation for ${JSON.stringify(missing)}`,
    );
  });

  it("throws on an empty map", () => {
    expect(() => detectFrameworksFromObservedStates(new Map())).toThrow(
      /missing required observation/,
    );
  });

  it("refuses BEFORE evaluating, even when the answer would be unaffected", () => {
    // composer.json absent already decides laravel false, so a lazy check
    // would never reach artisan and would accept this incomplete input. The
    // detection answer here is [] either way; what is being asserted is
    // that the contract is enforced on the INPUT, not inferred from the
    // output happening to be right.
    const states = observationMap();
    states.delete("artisan");
    expect(() => detectFrameworksFromObservedStates(states)).toThrow(
      /missing required observation for "artisan"/,
    );
  });

  it("accepts a complete map of explicit absences and detects nothing", () => {
    expect(detectFrameworksFromObservedStates(observationMap())).toEqual([]);
  });

  it("accepts a superset carrying non-signature paths", () => {
    // End-capture passes the whole observation set, which is the candidate
    // set unioned with the signature paths. Extra entries must not disturb
    // detection.
    const states = observationMap({ "composer.json": regular(), artisan: regular() });
    states.set("src/index.ts", regular());
    states.set("docs/notes.md", ABSENT);
    expect(detectFrameworksFromObservedStates(states)).toEqual(["laravel"]);
  });
});

// =============================================================================
// Observed evaluation implements the same signatures
// =============================================================================

describe("detectFrameworksFromObservedStates: signatures", () => {
  it("detects laravel when composer.json AND artisan are both regular", () => {
    const states = observationMap({ "composer.json": regular(), artisan: regular() });
    expect(detectFrameworksFromObservedStates(states)).toEqual(["laravel"]);
  });

  it.each([
    ["absent", ABSENT],
    ["a directory", DIRECTORY],
    ["a symlink", SYMLINK],
    ["an unsupported kind", { kind: "unsupported", fs_kind: "fifo" } as WorktreeState],
  ])("does NOT detect laravel when artisan is %s", (_label, artisanState) => {
    const states = observationMap({ "composer.json": regular(), artisan: artisanState });
    expect(detectFrameworksFromObservedStates(states)).toEqual([]);
  });

  it.each([
    "next.config.js",
    "next.config.ts",
    "next.config.mjs",
    "next.config.cjs",
  ])("detects nextjs from %s alone", (configPath) => {
    const states = observationMap({ [configPath]: regular() });
    expect(detectFrameworksFromObservedStates(states)).toEqual(["nextjs"]);
  });

  it.each([
    "pyproject.toml",
    "manage.py",
    "requirements.txt",
  ])("detects python from %s alone", (markerPath) => {
    const states = observationMap({ [markerPath]: regular() });
    expect(detectFrameworksFromObservedStates(states)).toEqual(["python"]);
  });

  it("detects rails when Gemfile AND config/routes.rb are both regular", () => {
    const states = observationMap({ Gemfile: regular(), "config/routes.rb": regular() });
    expect(detectFrameworksFromObservedStates(states)).toEqual(["rails"]);
  });

  it("does NOT detect rails from Gemfile alone", () => {
    const states = observationMap({ Gemfile: regular() });
    expect(detectFrameworksFromObservedStates(states)).toEqual([]);
  });

  it("detects lovable when .lovable is a directory", () => {
    const states = observationMap({ ".lovable": DIRECTORY });
    expect(detectFrameworksFromObservedStates(states)).toEqual(["lovable"]);
  });

  it("does NOT detect lovable when .lovable is a regular file", () => {
    const states = observationMap({ ".lovable": regular() });
    expect(detectFrameworksFromObservedStates(states)).toEqual([]);
  });

  it.each([
    ["null (not observable)", null],
    ["false", false],
    ["true", true],
  ])("ignores the executable bit (%s) when matching a signature", (_label, executable) => {
    const states = observationMap({
      "composer.json": regular(executable),
      artisan: regular(executable),
    });
    expect(detectFrameworksFromObservedStates(states)).toEqual(["laravel"]);
  });

  it("returns multiple matches sorted alphabetically", () => {
    const states = observationMap({
      "composer.json": regular(),
      artisan: regular(),
      ".lovable": DIRECTORY,
      "next.config.ts": regular(),
    });
    expect(detectFrameworksFromObservedStates(states)).toEqual(["laravel", "lovable", "nextjs"]);
  });
});

// =============================================================================
// Live and observed acquisitions agree on real repositories
// =============================================================================

/**
 * Fixtures deliberately contain NO symlinks. The two acquisitions diverge
 * there by design, and that divergence is asserted separately below rather
 * than smuggled into an equivalence claim.
 */
const EQUIVALENCE_FIXTURES: ReadonlyArray<{
  readonly name: string;
  readonly setup: (root: string) => Promise<void>;
}> = [
  { name: "empty repo", setup: async () => {} },
  {
    name: "laravel",
    setup: async (root) => {
      await writeFile(join(root, "composer.json"), "{}");
      await writeFile(join(root, "artisan"), "#!/usr/bin/env php\n");
    },
  },
  {
    name: "laravel signature only half present",
    setup: async (root) => {
      await writeFile(join(root, "composer.json"), "{}");
    },
  },
  {
    name: "nextjs",
    setup: async (root) => {
      await writeFile(join(root, "next.config.ts"), "export default {}");
    },
  },
  {
    name: "python",
    setup: async (root) => {
      await writeFile(join(root, "requirements.txt"), "flask==2.0\n");
    },
  },
  {
    name: "rails",
    setup: async (root) => {
      await writeFile(join(root, "Gemfile"), "source 'https://rubygems.org'\n");
      await mkdir(join(root, "config"));
      await writeFile(join(root, "config", "routes.rb"), "");
    },
  },
  {
    name: "lovable",
    setup: async (root) => {
      await mkdir(join(root, ".lovable"));
    },
  },
  {
    name: "lovable marker is a regular file, not a directory",
    setup: async (root) => {
      await writeFile(join(root, ".lovable"), "");
    },
  },
  {
    name: "composer.json is a directory, not a regular file",
    setup: async (root) => {
      await mkdir(join(root, "composer.json"));
      await writeFile(join(root, "artisan"), "");
    },
  },
  {
    name: "several frameworks at once",
    setup: async (root) => {
      await writeFile(join(root, "composer.json"), "{}");
      await writeFile(join(root, "artisan"), "");
      await writeFile(join(root, "next.config.js"), "");
      await writeFile(join(root, "pyproject.toml"), "[project]\nname='x'\n");
      await mkdir(join(root, ".lovable"));
    },
  },
];

describe("live and observed acquisitions", () => {
  it.each(
    EQUIVALENCE_FIXTURES.map((f) => [f.name, f.setup] as const),
  )("agree on %s", async (_name, setup) => {
    await setup(tmpRoot);
    const live = detectFramework(tmpRoot).matches;
    const observed = detectFrameworksFromObservedStates(observeFromDisk(tmpRoot));
    expect(observed).toEqual(live);
  });

  it("diverge on a symlinked signature file, which is the documented asymmetry", async (ctx) => {
    await writeFile(join(tmpRoot, "artisan"), "");
    await writeFile(join(tmpRoot, "composer.real.json"), "{}");
    try {
      await symlink(join(tmpRoot, "composer.real.json"), join(tmpRoot, "composer.json"), "file");
    } catch {
      // Symlink creation needs privileges this host may not grant. Skipping
      // is honest; passing on an un-exercised branch would not be.
      ctx.skip();
      return;
    }

    // statSync follows the link, so the shipped live detector still matches.
    expect(detectFramework(tmpRoot).matches).toEqual(["laravel"]);
    // A captured WorktreeState records `symlink` and digests only the target
    // string, so observed detection has nothing to resolve and must not
    // claim a regular file is present.
    expect(detectFrameworksFromObservedStates(observeFromDisk(tmpRoot))).toEqual([]);
  });
});
