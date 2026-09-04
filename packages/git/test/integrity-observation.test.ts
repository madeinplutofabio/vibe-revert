// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// integrity-observation.ts targeted tests.
//
// The tear rule lives entirely in `resolveObservationSample`, which is pure, so
// it is tested exhaustively here by constructing samples directly. That is the
// reason the module is split: the verdict never depends on winning a race.
//
// `sampleObservation` is tested against a real repository for the coherent path
// and for the structural claims that matter. No test forces a real concurrent
// mutation between the brackets, because doing so would require a test seam in
// production code. The torn path is therefore proven at the resolver, not end to
// end, and this comment exists so that coverage is not read as stronger than it
// is.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PathState } from "@viberevert/session-format";
import { describe, expect, it } from "vitest";

import type { ExclusionBasisFingerprint } from "../src/exclusion-basis.js";
import {
  type ObservationSample,
  resolveObservationSample,
  sampleObservation,
} from "../src/integrity-observation.js";
import type { ProtectedDomainSnapshot } from "../src/protected-domain.js";

const execFileAsync = promisify(execFile);

const GROUP = "cg_0000000000000000000000000000000000000000000000000000000000000001";

const PRESENT: PathState = {
  worktree: { kind: "regular", content_ref: "c".repeat(64), executable: false },
  index: { kind: "absent" },
};
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
const BASIS_MOVED: ExclusionBasisFingerprint = { ...BASIS, ignoreCase: true };

function domainOf(states: Readonly<Record<string, PathState>>): ProtectedDomainSnapshot {
  return { states: new Map(Object.entries(states)), topologyWatches: new Map() };
}

const DOMAIN = domainOf({ "src/a.ts": PRESENT });
const DOMAIN_MOVED = domainOf({ "src/a.ts": PRESENT_EXECUTABLE });

function sampleOf(parts: Partial<ObservationSample> = {}): ObservationSample {
  return {
    basisBefore: BASIS,
    basisAfter: BASIS,
    headShaBefore: HEAD_A,
    headShaAfter: HEAD_A,
    domainBefore: DOMAIN,
    domainAfter: DOMAIN,
    ...parts,
  };
}

// =============================================================================
// Coherent
// =============================================================================

describe("resolveObservationSample coherent", () => {
  it("accepts a sample whose basis, HEAD and two domain captures all agree", () => {
    const result = resolveObservationSample(sampleOf());

    expect(result.outcome).toBe("coherent");
    if (result.outcome !== "coherent") {
      throw new Error("expected coherent");
    }
    expect(result.observation).toEqual({ domain: DOMAIN, basis: BASIS, headSha: HEAD_A });
  });

  it("records the CLOSING samples, not the opening ones", () => {
    // Equal by value, distinct by identity, so identity proves which end was
    // taken. The observation must describe one moment rather than a mixture.
    const domainAfter = domainOf({ "src/a.ts": PRESENT });
    const basisAfter: ExclusionBasisFingerprint = { ...BASIS };
    const result = resolveObservationSample(sampleOf({ domainAfter, basisAfter }));

    if (result.outcome !== "coherent") {
      throw new Error("expected coherent");
    }
    expect(result.observation.domain).toBe(domainAfter);
    expect(result.observation.basis).toBe(basisAfter);
  });
});

// =============================================================================
// Torn: basis first, and the domain is then never compared
// =============================================================================

describe("resolveObservationSample torn with a moved basis", () => {
  it("reports not_comparable and carries no domain", () => {
    const result = resolveObservationSample(sampleOf({ basisAfter: BASIS_MOVED }));

    // `toEqual` pins the exact payload, so a domain snapshot leaking into the
    // torn arm fails here.
    expect(result).toEqual({
      outcome: "torn",
      basisMoved: true,
      headMoved: false,
      domainStatus: "not_comparable",
      basisBefore: BASIS,
      basisAfter: BASIS_MOVED,
      headShaBefore: HEAD_A,
      headShaAfter: HEAD_A,
    });
  });

  it("never inspects the domain at all once the basis has moved", () => {
    // A domain that throws on ANY property read. Asserting `not_comparable`
    // against an ordinary snapshot would only show that the comparison's result
    // was discarded; this shows the comparison never happened, which is the
    // actual short-circuit claim.
    const unreadableDomain = new Proxy(DOMAIN_MOVED, {
      get() {
        throw new Error("domain must not be inspected");
      },
    });

    const result = resolveObservationSample(
      sampleOf({ basisAfter: BASIS_MOVED, domainAfter: unreadableDomain }),
    );

    if (result.outcome !== "torn") {
      throw new Error("expected torn");
    }
    expect(result.domainStatus).toBe("not_comparable");
  });

  it("still reports HEAD movement, which does not depend on the ignore rules", () => {
    const result = resolveObservationSample(
      sampleOf({ basisAfter: BASIS_MOVED, headShaAfter: HEAD_B }),
    );

    if (result.outcome !== "torn") {
      throw new Error("expected torn");
    }
    expect(result.basisMoved).toBe(true);
    expect(result.headMoved).toBe(true);
    expect(result.domainStatus).toBe("not_comparable");
  });
});

// =============================================================================
// Torn: trustworthy basis, so the domain verdict is meaningful
// =============================================================================

describe("resolveObservationSample torn with a stable basis", () => {
  it("reports a moved HEAD with the domain confirmed unchanged", () => {
    const result = resolveObservationSample(sampleOf({ headShaAfter: HEAD_B }));

    if (result.outcome !== "torn") {
      throw new Error("expected torn");
    }
    expect(result.basisMoved).toBe(false);
    expect(result.headMoved).toBe(true);
    // `unchanged` rather than `not_comparable`: the comparison was performed
    // and it held. Only the sample as a whole is unusable.
    expect(result.domainStatus).toBe("unchanged");
  });

  it("reports a moved domain with HEAD steady", () => {
    const result = resolveObservationSample(sampleOf({ domainAfter: DOMAIN_MOVED }));

    if (result.outcome !== "torn") {
      throw new Error("expected torn");
    }
    expect(result.headMoved).toBe(false);
    expect(result.domainStatus).toBe("moved");
  });

  it("reports both when HEAD and the domain moved together", () => {
    const result = resolveObservationSample(
      sampleOf({ headShaAfter: HEAD_B, domainAfter: DOMAIN_MOVED }),
    );

    if (result.outcome !== "torn") {
      throw new Error("expected torn");
    }
    expect(result.headMoved).toBe(true);
    expect(result.domainStatus).toBe("moved");
  });
});

// =============================================================================
// sampleObservation against a real repository
// =============================================================================

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args as string[], { cwd, windowsHide: true });
}

interface TestRepo {
  readonly repoRoot: string;
  cleanup: () => Promise<void>;
}

async function setupRepo(): Promise<TestRepo> {
  const tmp = await mkdtemp(join(tmpdir(), "viberevert-intobs-"));
  const repoRoot = join(tmp, "repo");
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await git(repoRoot, ["config", "commit.gpgsign", "false"]);
  await git(repoRoot, ["config", "core.autocrlf", "false"]);
  await git(repoRoot, ["config", "core.excludesFile", ""]);
  // HEAD must be born before `getHeadSha` can sample it.
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "init"]);
  return {
    repoRoot,
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

const EMPTY_ELIGIBLE_PLAN = {
  outcome: "eligible",
  capabilities: { symlinkCheckout: true },
  selectedChangeGroupIds: [GROUP],
  classifications: [],
  topologyDependencyPaths: [],
  operations: [],
  conflicts: [],
} as const;

describe("sampleObservation", () => {
  it("returns distinct bracketed snapshots and resolves coherent on a quiet repository", async () => {
    const repo = await setupRepo();
    try {
      const sample = await sampleObservation({
        repoRoot: repo.repoRoot,
        plan: EMPTY_ELIGIBLE_PLAN,
        rollbackExcludePatterns: [],
      });

      // Distinct objects that compare equal. This shows the two ends are
      // separate snapshots rather than one value reused for both, which would
      // make the bracket vacuous. It does not by itself establish that two
      // capture calls ran in that order; the production sequence does that.
      expect(sample.domainBefore).not.toBe(sample.domainAfter);
      expect(sample.headShaBefore).toBe(sample.headShaAfter);

      const result = resolveObservationSample(sample);

      expect(result.outcome).toBe("coherent");
      if (result.outcome !== "coherent") {
        throw new Error("expected coherent");
      }
      expect(result.observation.domain).toBe(sample.domainAfter);
      expect(result.observation.basis).toBe(sample.basisAfter);
      expect(result.observation.headSha).toBe(sample.headShaAfter);
    } finally {
      await repo.cleanup();
    }
  });
});
