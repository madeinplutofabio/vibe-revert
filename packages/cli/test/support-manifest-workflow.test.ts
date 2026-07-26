// packages/cli/test/support-manifest-workflow.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M H7 Step 2.3: tests for the cross-file workflow-mapping validator. The
// canonical fixtures are the REAL checked-in support.yml, .github/workflows/ci.yml
// and package.json, loaded through the production seams (YAML via
// parseSupportManifest/parseWorkflow; package.json via JSON.parse) and cloned per
// case. So the positive test also proves the three committed files agree, and
// every negative mutates the actual files rather than a copied approximation. The
// parseWorkflow seam has its own duplicate-key test, which object mutation cannot
// represent.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseSupportManifest, parseWorkflow } from "../../../scripts/support-manifest-parser.js";
import { validateWorkflowMapping } from "../../../scripts/support-manifest-workflow.js";

const SUPPORT_MANIFEST_URL = new URL("../../../support.yml", import.meta.url);
const WORKFLOW_URL = new URL("../../../.github/workflows/ci.yml", import.meta.url);
const PACKAGE_JSON_URL = new URL("../../../package.json", import.meta.url);

const SUPPORT_MANIFEST_COMMAND = "pnpm check:support-manifest";
const SETUP_NODE_PREFIX = "actions/setup-node@";

// Fresh deep clones of the real files on every call, so a mutation in one case
// cannot leak into another.
function validSupport(): unknown {
  return structuredClone(parseSupportManifest(readFileSync(SUPPORT_MANIFEST_URL, "utf8")));
}
function validWorkflow(): unknown {
  return structuredClone(parseWorkflow(readFileSync(WORKFLOW_URL, "utf8")));
}
function validPackageJson(): unknown {
  return structuredClone(JSON.parse(readFileSync(PACKAGE_JSON_URL, "utf8")));
}

interface Inputs {
  // biome-ignore lint/suspicious/noExplicitAny: negative fixtures mutate arbitrary nested fields across the three inputs
  support: any;
  // biome-ignore lint/suspicious/noExplicitAny: negative fixtures mutate arbitrary nested fields across the three inputs
  workflow: any;
  // biome-ignore lint/suspicious/noExplicitAny: negative fixtures mutate arbitrary nested fields across the three inputs
  pkg: any;
}

function validInputs(): Inputs {
  return { support: validSupport(), workflow: validWorkflow(), pkg: validPackageJson() };
}

// Minimal step shape for the filter predicates below. The workflow is cloned from
// `any`, so calling `.filter` on it does not contextually type the callback; this
// annotation supplies the parameter type without resorting to `any`.
interface WorkflowStep {
  readonly uses?: unknown;
  readonly run?: unknown;
  readonly name?: unknown;
}

interface NegativeCase {
  readonly name: string;
  readonly mutate: (i: Inputs) => void;
  readonly code: string;
}

const NEGATIVE_CASES: NegativeCase[] = [
  {
    name: "engines mismatch (package.json drifts from manifest minimum)",
    mutate: ({ pkg }) => {
      pkg.engines.node = ">=20";
    },
    code: "engines",
  },
  {
    name: "blank manifest minimum",
    mutate: ({ support }) => {
      support.runtimes.node.minimum = "   ";
    },
    code: "engines",
  },
  {
    name: "gates runner drift",
    mutate: ({ workflow }) => {
      workflow.jobs.gates["runs-on"] = "ubuntu-22.04";
    },
    code: "gates.runner",
  },
  {
    name: "gates setup-node removed",
    mutate: ({ workflow }) => {
      workflow.jobs.gates.steps = workflow.jobs.gates.steps.filter(
        (s: WorkflowStep) => typeof s.uses !== "string" || !s.uses.startsWith(SETUP_NODE_PREFIX),
      );
    },
    code: "gates.node",
  },
  {
    name: "gates node version drift (manifest side)",
    mutate: ({ support }) => {
      support.gates.node = "20.x";
    },
    code: "gates.node",
  },
  {
    name: "support-manifest gate step removed",
    mutate: ({ workflow }) => {
      workflow.jobs.gates.steps = workflow.jobs.gates.steps.filter(
        (s: WorkflowStep) => s.run !== SUPPORT_MANIFEST_COMMAND,
      );
    },
    code: "gates",
  },
  {
    name: "support-manifest gate step duplicated",
    mutate: ({ workflow }) => {
      workflow.jobs.gates.steps.push({ name: "Check again", run: SUPPORT_MANIFEST_COMMAND });
    },
    code: "gates",
  },
  {
    name: "compat runner hardcoded (matrix os not consumed)",
    mutate: ({ workflow }) => {
      workflow.jobs.compat["runs-on"] = "ubuntu-24.04";
    },
    code: "compat.runner",
  },
  {
    name: "compat setup-node pinned to a literal (matrix node not consumed)",
    mutate: ({ workflow }) => {
      for (const step of workflow.jobs.compat.steps) {
        if (typeof step.uses === "string" && step.uses.startsWith(SETUP_NODE_PREFIX)) {
          step.with["node-version"] = "22.23.1";
        }
      }
    },
    code: "compat.node",
  },
  {
    name: "flag-gated step removed (source_build evidence lost)",
    mutate: ({ workflow }) => {
      workflow.jobs.compat.steps = workflow.jobs.compat.steps.filter(
        (s: WorkflowStep) => s.name !== "Native build prerequisites (Linux)",
      );
    },
    code: "compat.flags",
  },
  {
    name: "unrelated step gated on a reserved condition",
    mutate: ({ workflow }) => {
      workflow.jobs.compat.steps.push({
        name: "Rogue release smoke",
        if: "matrix.release_smoke",
        run: "echo rogue",
      });
    },
    code: "compat.flags",
  },
  {
    name: "unknown matrix-cell field",
    mutate: ({ workflow }) => {
      workflow.jobs.compat.strategy.matrix.include[0].bogus = true;
    },
    code: "include[0]",
  },
  {
    name: "duplicate (os, node) matrix cell",
    mutate: ({ workflow }) => {
      const include = workflow.jobs.compat.strategy.matrix.include;
      include.push({ ...include[0] });
    },
    code: "compat",
  },
  {
    name: "profile without a matching matrix cell",
    mutate: ({ support }) => {
      support.profiles["linux-node20"] = { ...support.profiles["linux-node22"], node: "20.x" };
    },
    code: "compat",
  },
  {
    name: "matrix cell without a matching profile",
    mutate: ({ support }) => {
      delete support.profiles["macos-node24"];
    },
    code: "compat",
  },
  {
    name: "matrix cell matched by multiple profiles",
    mutate: ({ support }) => {
      support.profiles["linux-node22-duplicate"] = {
        ...support.profiles["linux-node22"],
      };
    },
    code: "compat",
  },
  {
    name: "source_build flag disagreement",
    mutate: ({ support }) => {
      support.profiles["linux-node24"].node_pty_source_build = true;
    },
    code: "compat",
  },
  {
    name: "release_smoke flag disagreement",
    mutate: ({ support }) => {
      support.profiles["windows-node22"].release_smoke = false;
    },
    code: "compat",
  },
  {
    name: "empty matrix include",
    mutate: ({ workflow }) => {
      workflow.jobs.compat.strategy.matrix.include = [];
    },
    code: "compat",
  },
];

describe("validateWorkflowMapping", () => {
  it("accepts the committed support.yml + ci.yml + package.json", () => {
    const { support, workflow, pkg } = validInputs();
    expect(validateWorkflowMapping(support, workflow, pkg)).toEqual([]);
  });

  it.each(NEGATIVE_CASES)("rejects: $name", ({ mutate, code }) => {
    const inputs = validInputs();
    mutate(inputs);
    const codes = validateWorkflowMapping(inputs.support, inputs.workflow, inputs.pkg).map(
      (v) => v.code,
    );
    expect(codes).toContain(code);
  });
});

describe("parseWorkflow", () => {
  it("rejects duplicate mapping keys (uniqueKeys stays active)", () => {
    const duplicated = ["jobs:", "  gates: {}", "  gates: {}", ""].join("\n");
    expect(() => parseWorkflow(duplicated)).toThrow();
  });
});
