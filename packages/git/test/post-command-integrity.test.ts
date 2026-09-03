// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// post-command-integrity.ts targeted tests.
//
// The classifier is pure, so these construct observations directly rather than
// driving a repository. That is deliberate: the interesting behavior is the
// ORDER of the checks and which evidence each outcome is allowed to carry, and
// a repository fixture would prove those only for whichever combinations it
// happened to produce.
//
// The caller obligation, that both domains are complete captures taken with
// identical plan and exclusion inputs, cannot be expressed in these types and
// is not exercised here. It belongs to the orchestration, and rung 5 tests it
// end to end.

import type { PathState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import type { ExclusionBasisFingerprint } from "../src/exclusion-basis.js";
import {
  classifyPostCommandIntegrity,
  type PostCommandObservation,
} from "../src/post-command-integrity.js";
import type { ProtectedDomainSnapshot, TopologyWatch } from "../src/protected-domain.js";

const ABSENT: PathState = { worktree: { kind: "absent" }, index: { kind: "absent" } };
const PRESENT: PathState = {
  worktree: { kind: "regular", content_ref: "c".repeat(64), executable: false },
  index: { kind: "absent" },
};
/** Same bytes, different mode: a change a content-only check would miss. */
const PRESENT_EXECUTABLE: PathState = {
  worktree: { kind: "regular", content_ref: "c".repeat(64), executable: true },
  index: { kind: "absent" },
};

const HEAD_A = "1".repeat(40);
const HEAD_B = "2".repeat(40);

const BASIS: ExclusionBasisFingerprint = {
  infoExclude: { path: "/repo/.git/info/exclude", sha256: "a".repeat(64) },
  globalExcludes: null,
  untrackedIgnoreFiles: [],
  ignoreCase: false,
  precomposeUnicode: false,
};

/** Identical rule files, one evaluation flag flipped: a basis that MOVED. */
const BASIS_MOVED: ExclusionBasisFingerprint = { ...BASIS, ignoreCase: true };

function domainOf(
  states: Readonly<Record<string, PathState>>,
  watches: readonly TopologyWatch[] = [],
): ProtectedDomainSnapshot {
  return {
    states: new Map(Object.entries(states)),
    topologyWatches: new Map(watches.map((watch) => [watch.path, watch])),
  };
}

function observationOf(
  domain: ProtectedDomainSnapshot,
  basis: ExclusionBasisFingerprint,
  headSha: string,
): PostCommandObservation {
  return { domain, basis, headSha };
}

const BASELINE_STATES = { "src/a.ts": PRESENT, "src/b.ts": ABSENT } as const;
const BASELINE = observationOf(domainOf(BASELINE_STATES), BASIS, HEAD_A);

// =============================================================================
// The basis check is a precondition, not a signal alongside the others
// =============================================================================

describe("classifyPostCommandIntegrity basis precedence", () => {
  it("reports basis_changed and carries both fingerprints", () => {
    const after = observationOf(domainOf(BASELINE_STATES), BASIS_MOVED, HEAD_A);

    const result = classifyPostCommandIntegrity(BASELINE, after);

    expect(result).toEqual({ outcome: "basis_changed", before: BASIS, after: BASIS_MOVED });
    if (result.outcome !== "basis_changed") {
      throw new Error("expected basis_changed");
    }
    // The exact objects, not copies: a receipt renders what was observed.
    expect(result.before).toBe(BASIS);
    expect(result.after).toBe(BASIS_MOVED);
  });

  it("short-circuits: reports basis_changed alone even when the domain and HEAD also moved", () => {
    const after = observationOf(
      domainOf({ "src/a.ts": PRESENT_EXECUTABLE, "src/c.ts": PRESENT }),
      BASIS_MOVED,
      HEAD_B,
    );

    const result = classifyPostCommandIntegrity(BASELINE, after);

    // This is the ordering property. Differences and HEAD movement are both
    // computable here, and both are withheld: across a changed basis the domain
    // comparison is meaningless, and pairing an untrustworthy fact with a
    // trustworthy one in a single result invites reading the whole thing as
    // evidence. `toEqual` pins the payload exactly, so an added field fails.
    expect(result).toEqual({ outcome: "basis_changed", before: BASIS, after: BASIS_MOVED });
  });
});

// =============================================================================
// clean
// =============================================================================

describe("classifyPostCommandIntegrity clean", () => {
  it("reports clean when the basis, domain and HEAD all held still", () => {
    const after = observationOf(domainOf(BASELINE_STATES), BASIS, HEAD_A);

    expect(classifyPostCommandIntegrity(BASELINE, after)).toEqual({ outcome: "clean" });
  });
});

// =============================================================================
// project_mutated
// =============================================================================

describe("classifyPostCommandIntegrity project_mutated", () => {
  it("reports a changed path state", () => {
    const after = observationOf(
      domainOf({ "src/a.ts": PRESENT_EXECUTABLE, "src/b.ts": ABSENT }),
      BASIS,
      HEAD_A,
    );

    const result = classifyPostCommandIntegrity(BASELINE, after);

    expect(result.outcome).toBe("project_mutated");
    if (result.outcome !== "project_mutated") {
      throw new Error("expected project_mutated");
    }
    expect(result.differences.changedPaths).toEqual(["src/a.ts"]);
    expect(result.headMoved).toBe(false);
  });

  it("reports a member ADDED by a command", () => {
    const after = observationOf(
      domainOf({ ...BASELINE_STATES, "src/new.ts": PRESENT }),
      BASIS,
      HEAD_A,
    );

    const result = classifyPostCommandIntegrity(BASELINE, after);

    expect(result.outcome).toBe("project_mutated");
    if (result.outcome !== "project_mutated") {
      throw new Error("expected project_mutated");
    }
    // The case that requires both domains to be COMPLETE captures. Observing
    // the second from the first's frozen membership could only re-observe paths
    // that were already members, so a managed untracked path created by a
    // command would be structurally invisible here.
    expect(result.differences.addedPaths).toEqual(["src/new.ts"]);
  });

  it("reports a member removed", () => {
    // The removed path must be one that was PRESENT. Dropping a key whose
    // recorded state is already `absent` would conflate "left the domain" with
    // "was already absent".
    const after = observationOf(domainOf({ "src/b.ts": ABSENT }), BASIS, HEAD_A);

    const result = classifyPostCommandIntegrity(BASELINE, after);

    expect(result.outcome).toBe("project_mutated");
    if (result.outcome !== "project_mutated") {
      throw new Error("expected project_mutated");
    }
    expect(result.differences.removedPaths).toEqual(["src/a.ts"]);
  });

  it("reports a topology watch whose raw membership changed, with states identical", () => {
    const before = observationOf(
      domainOf(BASELINE_STATES, [
        { path: "src", kind: "recursive", members: [{ path: "src/a.ts", kind: "leaf" }] },
      ]),
      BASIS,
      HEAD_A,
    );
    const after = observationOf(
      domainOf(BASELINE_STATES, [
        {
          path: "src",
          kind: "recursive",
          members: [
            { path: "src/a.ts", kind: "leaf" },
            { path: "src/scratch", kind: "leaf" },
          ],
        },
      ]),
      BASIS,
      HEAD_A,
    );

    const result = classifyPostCommandIntegrity(before, after);

    expect(result.outcome).toBe("project_mutated");
    if (result.outcome !== "project_mutated") {
      throw new Error("expected project_mutated");
    }
    // Raw watch membership is isolation evidence, not checkpoint-recoverable
    // state, so it participates in the verdict even when every PathState is
    // byte-identical.
    expect(result.differences.changedPaths).toEqual([]);
    expect(result.differences.topologyWatchDifferences).toHaveLength(1);
    expect(result.differences.topologyWatchDifferences[0]?.reason).toBe("membership_changed");
  });

  it("reports HEAD movement alone, with an empty difference", () => {
    const after = observationOf(domainOf(BASELINE_STATES), BASIS, HEAD_B);

    const result = classifyPostCommandIntegrity(BASELINE, after);

    expect(result.outcome).toBe("project_mutated");
    if (result.outcome !== "project_mutated") {
      throw new Error("expected project_mutated");
    }
    // A command that commits, resets, or checks out another revision leaves
    // every managed path exactly as verified. A bytes-and-index-only check
    // would pass this.
    expect(result.headMoved).toBe(true);
    expect(result.differences.addedPaths).toEqual([]);
    expect(result.differences.removedPaths).toEqual([]);
    expect(result.differences.changedPaths).toEqual([]);
    expect(result.differences.topologyWatchDifferences).toEqual([]);
  });

  it("reports both when HEAD and the domain moved together", () => {
    const after = observationOf(
      domainOf({ "src/a.ts": PRESENT_EXECUTABLE, "src/b.ts": ABSENT }),
      BASIS,
      HEAD_B,
    );

    const result = classifyPostCommandIntegrity(BASELINE, after);

    expect(result.outcome).toBe("project_mutated");
    if (result.outcome !== "project_mutated") {
      throw new Error("expected project_mutated");
    }
    // Carried separately so a receipt can name which fired without re-deriving.
    expect(result.headMoved).toBe(true);
    expect(result.differences.changedPaths).toEqual(["src/a.ts"]);
  });
});
