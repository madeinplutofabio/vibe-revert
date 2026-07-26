// scripts/support-manifest-workflow.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M H7 Step 2.3: cross-file authority. Proves support.yml's declared CI contract
// matches ci.yml and package.json. Pure (takes parsed values), so it is directly
// table-testable; the executable owns reading and parsing the three files.
//
// The workflow is read STRUCTURALLY -- gates + compat runners, the single
// setup-node step per job, the matrix include list, and the exact flag-gated
// steps by identity. No regex, no generic step modelling. These lock the current
// workflow's structural contract, so a deliberate rename, an added smoke, or a
// syntax change requires an intentional update here (the same policy as the
// manifest's unknown-key rejection).

import type { Violation } from "./support-manifest-core.js";

const SETUP_NODE_PREFIX = "actions/setup-node@";
const SUPPORT_MANIFEST_COMMAND = "pnpm check:support-manifest";
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions matrix expression, not a JS template
const MATRIX_OS_EXPRESSION = "${{ matrix.os }}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions matrix expression, not a JS template
const MATRIX_NODE_EXPRESSION = "${{ matrix.node }}";
const SOURCE_BUILD_IF = "matrix.source_build";
const RELEASE_SMOKE_IF = "matrix.release_smoke";
const COMPAT_CELL_KEYS = ["label", "os", "node", "source_build", "release_smoke"] as const;

// The exact flag-gated steps the compat job must contain: step identity (name)
// bound to its reserved condition. Each must occur exactly once, and NO other
// step may use a reserved condition -- so removing the real step while leaving an
// unrelated step gated on the same flag is rejected. The declared release flags
// therefore provably control the intended evidence, not merely appear somewhere.
const FLAG_GATED_STEPS = [
  { name: "Native build prerequisites (Linux)", condition: SOURCE_BUILD_IF },
  { name: "Smoke (PowerShell 7+, pwsh)", condition: RELEASE_SMOKE_IF },
  { name: "Smoke (Windows PowerShell 5.1, powershell.exe)", condition: RELEASE_SMOKE_IF },
] as const;
const RESERVED_CONDITIONS: ReadonlySet<string> = new Set([SOURCE_BUILD_IF, RELEASE_SMOKE_IF]);

type Err = (code: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProp(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Navigate a path of mapping keys, returning undefined at the first non-mapping.
function readPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = readProp(current, key);
  }
  return current;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
  err: Err,
): void {
  const allowedSet = new Set<string>(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      err(at, `unknown field ${JSON.stringify(key)}`);
    }
  }
}

// Collision-proof composite key: a JSON-encoded pair. Injective, so values that
// themselves contain spaces (e.g. step names) cannot alias, and it stays
// printable (no NUL separators in source).
function tupleKey(first: string, second: string): string {
  return JSON.stringify([first, second]);
}

interface ProfileEvidence {
  readonly name: string;
  readonly runner: string;
  readonly node: string;
  readonly sourceBuild: boolean;
  readonly releaseSmoke: boolean;
}

interface CellEvidence {
  readonly os: string;
  readonly node: string;
  readonly sourceBuild: boolean;
  readonly releaseSmoke: boolean;
}

// Setup-node versions + wired support-manifest command occurrences in a job.
function scanJobSteps(steps: readonly unknown[]): {
  readonly setupNodeVersions: unknown[];
  readonly supportManifestSteps: number;
} {
  const setupNodeVersions: unknown[] = [];
  let supportManifestSteps = 0;
  for (const step of steps) {
    if (!isRecord(step)) {
      continue;
    }
    const uses = readProp(step, "uses");
    if (typeof uses === "string" && uses.startsWith(SETUP_NODE_PREFIX)) {
      setupNodeVersions.push(readPath(step, ["with", "node-version"]));
    }
    const run = readProp(step, "run");
    if (typeof run === "string" && run.trim() === SUPPORT_MANIFEST_COMMAND) {
      supportManifestSteps += 1;
    }
  }
  return { setupNodeVersions, supportManifestSteps };
}

// The compat job's flag-gated steps must match the locked identities exactly, and
// no other step may use a reserved condition.
function validateCompatFlagSteps(steps: readonly unknown[], err: Err): void {
  const allowed = new Set(FLAG_GATED_STEPS.map((step) => tupleKey(step.name, step.condition)));
  const counts = new Map<string, number>();
  for (const step of steps) {
    if (!isRecord(step)) {
      continue;
    }
    const ifExpr = readProp(step, "if");
    if (typeof ifExpr !== "string") {
      continue;
    }
    const condition = ifExpr.trim();
    if (!RESERVED_CONDITIONS.has(condition)) {
      continue;
    }
    const name = readProp(step, "name");
    if (!isNonBlankString(name)) {
      err("compat.flags", `a step gated by \`if: ${condition}\` must have a non-blank name`);
      continue;
    }
    const key = tupleKey(name, condition);
    if (allowed.has(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } else {
      err(
        "compat.flags",
        `step ${JSON.stringify(name)} uses reserved condition \`if: ${condition}\` but is not in the locked flag-step list`,
      );
    }
  }
  for (const step of FLAG_GATED_STEPS) {
    const count = counts.get(tupleKey(step.name, step.condition)) ?? 0;
    if (count !== 1) {
      err(
        "compat.flags",
        `expected exactly one jobs.compat step named ${JSON.stringify(step.name)} gated by \`if: ${step.condition}\` (found ${count})`,
      );
    }
  }
}

export function validateWorkflowMapping(
  manifest: unknown,
  workflow: unknown,
  packageJson: unknown,
): Violation[] {
  const violations: Violation[] = [];
  const err: Err = (code, message) => {
    violations.push({ code, message });
  };

  // --- minimum Node range == package.json engines.node (no semver normalization) ---
  const minimum = readPath(manifest, ["runtimes", "node", "minimum"]);
  const engines = readPath(packageJson, ["engines", "node"]);
  if (!isNonBlankString(minimum)) {
    err("engines", "support.yml runtimes.node.minimum must be a non-blank string");
  }
  if (!isNonBlankString(engines)) {
    err("engines", "package.json engines.node must be a non-blank string");
  }
  if (isNonBlankString(minimum) && isNonBlankString(engines) && minimum !== engines) {
    err(
      "engines",
      `runtimes.node.minimum ${JSON.stringify(minimum)} must equal package.json engines.node ${JSON.stringify(engines)}`,
    );
  }

  // --- gates job: runner + single literal setup-node version + wired step ---
  const gatesRunsOn = readPath(workflow, ["jobs", "gates", "runs-on"]);
  const gatesRunner = readPath(manifest, ["gates", "runner"]);
  if (!isNonBlankString(gatesRunsOn)) {
    err("gates.runner", "workflow jobs.gates.runs-on must be a non-blank string");
  } else if (isNonBlankString(gatesRunner) && gatesRunner !== gatesRunsOn) {
    err(
      "gates.runner",
      `manifest gates.runner ${JSON.stringify(gatesRunner)} must equal workflow jobs.gates.runs-on ${JSON.stringify(gatesRunsOn)}`,
    );
  }

  const gatesSteps = readPath(workflow, ["jobs", "gates", "steps"]);
  if (!Array.isArray(gatesSteps)) {
    err("gates", "workflow jobs.gates.steps must be an array");
  } else {
    const scan = scanJobSteps(gatesSteps);
    if (scan.setupNodeVersions.length !== 1) {
      err(
        "gates.node",
        `expected exactly one setup-node step in jobs.gates (found ${scan.setupNodeVersions.length})`,
      );
    } else {
      const workflowNode = scan.setupNodeVersions[0];
      const gatesNode = readPath(manifest, ["gates", "node"]);
      if (!isNonBlankString(workflowNode)) {
        err("gates.node", "workflow setup-node node-version must be a non-blank string");
      } else if (isNonBlankString(gatesNode) && gatesNode !== workflowNode) {
        err(
          "gates.node",
          `manifest gates.node ${JSON.stringify(gatesNode)} must equal workflow setup-node node-version ${JSON.stringify(workflowNode)}`,
        );
      }
    }
    if (scan.supportManifestSteps !== 1) {
      err(
        "gates",
        `expected exactly one jobs.gates step running \`${SUPPORT_MANIFEST_COMMAND}\` (found ${scan.supportManifestSteps})`,
      );
    }
  }

  // --- compat job consumes the matrix: runner + node expressions + gated steps ---
  const compatRunsOn = readPath(workflow, ["jobs", "compat", "runs-on"]);
  if (compatRunsOn !== MATRIX_OS_EXPRESSION) {
    err(
      "compat.runner",
      `workflow jobs.compat.runs-on must be ${JSON.stringify(MATRIX_OS_EXPRESSION)}`,
    );
  }
  const compatSteps = readPath(workflow, ["jobs", "compat", "steps"]);
  if (!Array.isArray(compatSteps)) {
    err("compat.node", "workflow jobs.compat.steps must be an array");
  } else {
    const scan = scanJobSteps(compatSteps);
    if (scan.setupNodeVersions.length !== 1) {
      err(
        "compat.node",
        `expected exactly one setup-node step in jobs.compat (found ${scan.setupNodeVersions.length})`,
      );
    } else if (scan.setupNodeVersions[0] !== MATRIX_NODE_EXPRESSION) {
      err(
        "compat.node",
        `workflow compat setup-node node-version must be ${JSON.stringify(MATRIX_NODE_EXPRESSION)}`,
      );
    }
    validateCompatFlagSteps(compatSteps, err);
  }

  // --- compat matrix cells <-> profiles (bidirectional 1:1, flags exact) ---
  const include = readPath(workflow, ["jobs", "compat", "strategy", "matrix", "include"]);
  if (!Array.isArray(include) || include.length === 0) {
    err("compat", "workflow jobs.compat.strategy.matrix.include must be a non-empty array");
    return violations;
  }

  const cellByKey = new Map<string, CellEvidence>();
  for (let i = 0; i < include.length; i++) {
    const cell: unknown = include[i];
    if (!isRecord(cell)) {
      err("compat", `include[${i}] must be a mapping`);
      continue;
    }
    rejectUnknownKeys(cell, COMPAT_CELL_KEYS, `include[${i}]`, err);
    if (!isNonBlankString(readProp(cell, "label"))) {
      err("compat", `include[${i}].label must be a non-blank string`);
    }
    const os = readProp(cell, "os");
    const node = readProp(cell, "node");
    if (!isNonBlankString(os)) {
      err("compat", `include[${i}].os must be a non-blank string`);
    }
    if (!isNonBlankString(node)) {
      err("compat", `include[${i}].node must be a non-blank string`);
    }
    const sourceBuildRaw = readProp(cell, "source_build");
    const releaseSmokeRaw = readProp(cell, "release_smoke");
    if (sourceBuildRaw !== undefined && typeof sourceBuildRaw !== "boolean") {
      err("compat", `include[${i}].source_build must be a boolean when present`);
    }
    if (releaseSmokeRaw !== undefined && typeof releaseSmokeRaw !== "boolean") {
      err("compat", `include[${i}].release_smoke must be a boolean when present`);
    }
    if (isNonBlankString(os) && isNonBlankString(node)) {
      const key = tupleKey(os, node);
      if (cellByKey.has(key)) {
        err("compat", `duplicate (os, node) cell: (${os}, ${node})`);
      }
      cellByKey.set(key, {
        os,
        node,
        sourceBuild: sourceBuildRaw === true,
        releaseSmoke: releaseSmokeRaw === true,
      });
    }
  }

  const profileList: ProfileEvidence[] = [];
  const profiles = readPath(manifest, ["profiles"]);
  if (isRecord(profiles)) {
    for (const [name, value] of Object.entries(profiles)) {
      if (!isRecord(value)) {
        continue;
      }
      const runner = readProp(value, "runner");
      const node = readProp(value, "node");
      if (!isNonBlankString(runner) || !isNonBlankString(node)) {
        continue;
      }
      profileList.push({
        name,
        runner,
        node,
        sourceBuild: readProp(value, "node_pty_source_build") === true,
        releaseSmoke: readProp(value, "release_smoke") === true,
      });
    }
  }

  const profilesByKey = new Map<string, ProfileEvidence[]>();
  for (const profile of profileList) {
    const key = tupleKey(profile.runner, profile.node);
    const list = profilesByKey.get(key) ?? [];
    list.push(profile);
    profilesByKey.set(key, list);
  }

  // Every profile maps to a cell.
  for (const profile of profileList) {
    if (!cellByKey.has(tupleKey(profile.runner, profile.node))) {
      err(
        "compat",
        `profile ${profile.name} (${profile.runner}, ${profile.node}) has no matching matrix cell`,
      );
    }
  }

  // Every cell maps to exactly one profile, with exact flag agreement.
  for (const [key, cell] of cellByKey) {
    const matches = profilesByKey.get(key) ?? [];
    if (matches.length === 0) {
      err("compat", `matrix cell (${cell.os}, ${cell.node}) has no matching profile`);
      continue;
    }
    if (matches.length > 1) {
      err(
        "compat",
        `matrix cell (${cell.os}, ${cell.node}) is matched by multiple profiles: ${matches.map((p) => p.name).join(", ")}`,
      );
      continue;
    }
    const profile = matches[0];
    if (profile !== undefined && profile.sourceBuild !== cell.sourceBuild) {
      err(
        "compat",
        `profile ${profile.name} node_pty_source_build=${profile.sourceBuild} disagrees with matrix source_build=${cell.sourceBuild}`,
      );
    }
    if (profile !== undefined && profile.releaseSmoke !== cell.releaseSmoke) {
      err(
        "compat",
        `profile ${profile.name} release_smoke=${profile.releaseSmoke} disagrees with matrix release_smoke=${cell.releaseSmoke}`,
      );
    }
  }

  return violations;
}
