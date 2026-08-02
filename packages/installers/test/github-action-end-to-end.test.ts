// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// H11.4 acceptance -- GitHub Action reinstall/update lifecycle (Model W).
//
// Contract: .github/workflows/viberevert.yml is wholly VibeRevert-owned.
// First install and every update share ONE durable operation kind
// (write-new), so the advertised "rerun to update" path works without a
// cross-kind record mismatch, and uninstall restores the original absent
// state by deleting the file. A manual edit is drift: never silently
// overwritten (refused without --force) and, with --force, replaced under
// the engine's existing whole-file write-new semantics.
//
// This file grew from the H11.4 RED reproduction
// (github-action-reinstall-red.test.ts, which pinned the pre-fix
// integrations-record-kind-mismatch) once the adapter's Branch 2 was
// changed from sentinel-block-replace to write-new.
//
// GREEN acceptance items proven below:
//   1. first install plans + records write-new;
//   2. same-input reinstall is a noop;
//   3. a changed generated workflow (a different ctx.cliVersion, which
//      changes the pinned viberevert@<version> bytes) is a safe update
//      that retains write-new;
//   4. uninstall deletes the workflow file and restores the absent state;
//   5. a pre-existing foreign workflow is refused;
//   6. manual drift is refused without --force and never silently
//      overwritten;
//   7. with --force, replacement follows the engine's existing whole-file
//      write-new semantics, including its established backup behavior.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AdapterContext } from "@viberevert/adapters";
import { githubActionAdapter } from "@viberevert/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { apply } from "../src/engine-apply.js";
import type { InstallOutcome, UninstallContext } from "../src/engine-types.js";
import { uninstall } from "../src/engine-uninstall.js";
import { readIntegrationsFile } from "../src/integrations-store.js";

import { createTempRepo } from "./helpers/temp-repo.js";

const CLI_VERSION = "0.7.1-beta.0-smoke";
// A distinct pinned CLI version. Reinstalling under this value changes the
// generated workflow bytes (the `viberevert@<version>` pin), which is the
// exact input that turns a reinstall into a safe update.
const CLI_VERSION_NEXT = "0.7.1-beta.1-smoke";
const FIXED_NOW = new Date("2026-06-29T12:00:00.000Z");

const GITHUB_ACTION_RECORD_KEY = "github-action" as const;
const GITHUB_ACTION_ADAPTER_NAME = "GitHub Action";
const TARGET_REL = ".github/workflows/viberevert.yml";

const DRIFT_REASON_CODE = "integrations-content-drift";
const NON_VR_REASON_CODE = "non-vr-workflow-present";

// A user-owned workflow at the same path that does NOT contain our
// sentinel -- the adapter must refuse rather than overwrite it.
const FOREIGN_WORKFLOW = [
  "name: user CI",
  "on: [push]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hello",
  "",
].join("\n");

let repoRoot: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const tmp = await createTempRepo();
  repoRoot = tmp.repoRoot;
  cleanup = tmp.cleanup;
});

afterEach(async () => {
  await cleanup();
});

function adapterCtx(
  overrides: { readonly forceReinstall?: boolean; readonly cliVersion?: string } = {},
): AdapterContext {
  return {
    repoRoot,
    now: FIXED_NOW,
    cliVersion: overrides.cliVersion ?? CLI_VERSION,
    intent: "explicit",
    options: {
      forceReinstall: overrides.forceReinstall ?? false,
      migrateFromHookInstall: false,
      forceUninstall: false,
    },
  };
}

function uninstallCtx(): UninstallContext {
  return {
    repoRoot,
    now: FIXED_NOW,
    cliVersion: CLI_VERSION,
    options: { forceUninstall: false },
  };
}

/** plan() then apply() the GitHub Action adapter under the current repo. */
async function installGitHubAction(
  overrides: { readonly forceReinstall?: boolean; readonly cliVersion?: string } = {},
): Promise<InstallOutcome> {
  const plan = await githubActionAdapter.plan(adapterCtx(overrides));
  return apply(plan, adapterCtx(overrides));
}

// Assert the plan is applicable, emits exactly one op, and return the op
// targeting the workflow file. Every scenario pins the planned op-kind
// (write-new) before applying, so "install and update share one op-kind"
// is proven directly. The single-op check rejects a plan that also targets
// something else.
function requireTargetOp(plan: Awaited<ReturnType<typeof githubActionAdapter.plan>>) {
  if (plan.status !== "applicable") {
    throw new Error("expected GitHub Action plan to be applicable");
  }

  expect(plan.ops).toHaveLength(1);

  const op = plan.ops.find((candidate) => candidate.target.pathRelative === TARGET_REL);
  if (op === undefined) {
    throw new Error("expected GitHub Action workflow operation");
  }

  return op;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function readWorkflow(): Promise<string> {
  return readFile(join(repoRoot, TARGET_REL), "utf8");
}

describe("github-action end-to-end (H11.4: whole-file-owned write-new lifecycle)", () => {
  it("item 1: first install plans and records write-new", async () => {
    const ctx = adapterCtx();
    const plan = await githubActionAdapter.plan(ctx);
    expect(plan.status).toBe("applicable");
    expect(requireTargetOp(plan).kind).toBe("write-new");

    const result = await apply(plan, ctx);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") {
      throw new Error("expected first install to be applied");
    }
    expect(result.receipt.recordKey).toBe(GITHUB_ACTION_RECORD_KEY);
    expect(result.receipt.adapterName).toBe(GITHUB_ACTION_ADAPTER_NAME);
    expect(result.receipt.opsApplied).toBe(1);
    expect(result.receipt.filesWritten).toHaveLength(1);

    expect(await fileExists(join(repoRoot, TARGET_REL))).toBe(true);
    expect(await readWorkflow()).toContain(CLI_VERSION);

    const integrations = await readIntegrationsFile(repoRoot);
    if (integrations === null) {
      throw new Error("integrations.json missing after install");
    }
    const record = integrations.records[GITHUB_ACTION_RECORD_KEY];
    if (record === undefined) {
      throw new Error("github-action record missing after install");
    }
    const op = record.ops[0];
    if (op === undefined) {
      throw new Error("github-action record has no ops");
    }
    expect(op.kind).toBe("write-new");
    expect(typeof op.fullFileSha256AfterWrite).toBe("string");
  });

  it("item 2: same-input reinstall plans write-new and is a noop", async () => {
    const first = await installGitHubAction();
    expect(first.status).toBe("applied");
    const before = await readWorkflow();

    const ctx = adapterCtx();
    const plan = await githubActionAdapter.plan(ctx);
    expect(requireTargetOp(plan).kind).toBe("write-new");

    const result = await apply(plan, ctx);
    expect(result.status).toBe("noop");
    if (result.status !== "noop") {
      throw new Error("expected same-input reinstall to be a noop");
    }
    expect(result.recordKey).toBe(GITHUB_ACTION_RECORD_KEY);

    expect(await readWorkflow()).toBe(before);
  });

  it("item 3: reinstall with a changed cliVersion is a safe update that retains write-new", async () => {
    const first = await installGitHubAction();
    expect(first.status).toBe("applied");
    const before = await readWorkflow();

    // The changed input is ctx.cliVersion: it pins a different
    // viberevert@<version> in the generated workflow, so the bytes differ
    // and the reinstall is a safe update (not a noop).
    const ctx = adapterCtx({ cliVersion: CLI_VERSION_NEXT });
    const plan = await githubActionAdapter.plan(ctx);
    expect(requireTargetOp(plan).kind).toBe("write-new");

    const result = await apply(plan, ctx);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") {
      throw new Error("expected changed-workflow reinstall to be applied (safe update)");
    }
    expect(result.receipt.opsApplied).toBe(1);

    const after = await readWorkflow();
    expect(after).not.toBe(before);
    expect(after).toContain(CLI_VERSION_NEXT);
    expect(after).not.toContain(CLI_VERSION);

    // Record still write-new: one durable op-kind across install + update.
    const integrations = await readIntegrationsFile(repoRoot);
    const record = integrations?.records[GITHUB_ACTION_RECORD_KEY];
    if (record === undefined) {
      throw new Error("github-action record missing after safe update");
    }
    expect(record.ops[0]?.kind).toBe("write-new");
  });

  it("item 4: uninstall deletes the workflow file and restores the absent state", async () => {
    const first = await installGitHubAction();
    expect(first.status).toBe("applied");
    expect(await fileExists(join(repoRoot, TARGET_REL))).toBe(true);

    const result = await uninstall(GITHUB_ACTION_RECORD_KEY, uninstallCtx());
    expect(result.status).toBe("uninstalled");
    if (result.status !== "uninstalled") {
      throw new Error("expected uninstall to succeed");
    }
    expect(result.receipt.filesRemoved).toHaveLength(1);

    // The workflow file is gone (write-new reverses via unlink).
    expect(await fileExists(join(repoRoot, TARGET_REL))).toBe(false);

    // integrations.json persists, but the GitHub Action record is removed.
    const integrations = await readIntegrationsFile(repoRoot);
    if (integrations === null) {
      throw new Error("integrations.json missing after uninstall");
    }
    expect(integrations.records[GITHUB_ACTION_RECORD_KEY]).toBeUndefined();
  });

  it("item 5: a pre-existing foreign workflow is refused and preserved", async () => {
    await mkdir(join(repoRoot, ".github", "workflows"), { recursive: true });
    await writeFile(join(repoRoot, TARGET_REL), FOREIGN_WORKFLOW, "utf8");

    // The adapter refuses at plan level (no sentinel, no force).
    const plan = await githubActionAdapter.plan(adapterCtx());
    expect(plan.status).toBe("refused");
    if (plan.status !== "refused") {
      throw new Error("expected a refused plan for a foreign workflow");
    }
    expect(plan.reasonCode).toBe(NON_VR_REASON_CODE);

    const result = await apply(plan, adapterCtx());
    expect(result.status).toBe("refused");
    if (result.status !== "refused") {
      throw new Error("expected a refused install for a foreign workflow");
    }
    expect(result.reasonCode).toBe(NON_VR_REASON_CODE);

    // The foreign file is untouched.
    expect(await readWorkflow()).toBe(FOREIGN_WORKFLOW);
  });

  it("item 6: manual drift is refused without --force and never silently overwritten", async () => {
    const first = await installGitHubAction();
    expect(first.status).toBe("applied");

    // The user edits the installed VibeRevert workflow by hand (the
    // sentinel markers remain, so it is still recognized as ours).
    const installed = await readWorkflow();
    const drifted = `${installed}# user note appended by hand\n`;
    await writeFile(join(repoRoot, TARGET_REL), drifted, "utf8");

    const ctx = adapterCtx();
    const plan = await githubActionAdapter.plan(ctx);
    expect(requireTargetOp(plan).kind).toBe("write-new");

    const result = await apply(plan, ctx);
    expect(result.status).toBe("refused");
    if (result.status !== "refused") {
      throw new Error("expected drifted reinstall to be refused without --force");
    }
    expect(result.reasonCode).toBe(DRIFT_REASON_CODE);

    // The user's edited bytes are preserved -- never silently overwritten.
    expect(await readWorkflow()).toBe(drifted);
  });

  it("item 7: --force replaces the drifted file under the engine's write-new semantics", async () => {
    const first = await installGitHubAction();
    expect(first.status).toBe("applied");
    const installed = await readWorkflow();

    const drifted = `${installed}# user note appended by hand\n`;
    await writeFile(join(repoRoot, TARGET_REL), drifted, "utf8");

    const ctx = adapterCtx({ forceReinstall: true });
    const plan = await githubActionAdapter.plan(ctx);
    expect(requireTargetOp(plan).kind).toBe("write-new");

    const result = await apply(plan, ctx);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") {
      throw new Error("expected forced reinstall over drift to be applied");
    }
    expect(result.receipt.opsApplied).toBe(1);
    // Grounded in the engine contract: needsNewBackup (engine-apply.ts)
    // returns false for any op that is not backup-and-write, so a forced
    // write-new replacement writes no backup -- backupsCreated is empty.
    expect(result.receipt.backupsCreated).toEqual([]);

    // Whole-file semantics: the file is the canonical VibeRevert workflow
    // again; the user's hand-appended line is gone.
    const after = await readWorkflow();
    expect(after).toBe(installed);
    expect(after).not.toContain("# user note appended by hand");
  });
});
