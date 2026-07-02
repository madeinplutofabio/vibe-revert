// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub Action adapter for @viberevert/adapters.
 *
 * Installs a pinned VibeRevert check workflow at
 * <repo>/.github/workflows/viberevert.yml. Per D101.A this module reads
 * fs state only to decide plan branch; never mutates; never reads
 * .viberevert/integrations.json.
 *
 * Per D101.K:
 *   - Version PINNED via ctx.cliVersion (NOT `@beta` / `latest`).
 *   - `permissions: { contents: read }` at the workflow level.
 *   - NO `pull_request_target` trigger (fork-PR contents:write risk).
 *   - Excluded from --all at the CLI (InstallCommand, Step 6); adapter
 *     always reports detected.
 *
 * Per D101.Q: LF line endings (template + sentinel helpers).
 *
 * detect() flow (always positive):
 *   Returns { detected: true } regardless of intent. No on-disk
 *   evidence is needed -- the workflow is a fresh install (write-new)
 *   or a safe update (sentinel-block-replace). The --all exclusion is
 *   a CLI-level concern, not an adapter-level one.
 *
 * plan() flow (four branches; D101.B force-flag discipline):
 *   1. File absent -> ApplicablePlan { write-new } with wrapped content.
 *   2. File exists WITH our sentinel -> ApplicablePlan
 *      { sentinel-block-replace } with interior only. Installer
 *      classifier decides noop/safe-update/refuse via SHA.
 *   3. File exists WITHOUT our sentinel AND !forceReinstall ->
 *      RefusedPlan { non-vr-workflow-present }.
 *   4. File exists WITHOUT our sentinel AND forceReinstall ->
 *      ApplicablePlan { backup-and-write } with wrapped content.
 *
 * Force flag scope (D101.B): forceReinstall ONLY overrides branch 3.
 * It does NOT change branches 1 or 2 -- those are safe by construction.
 *
 * Non-regular-file target (dir/symlink/etc at the workflow path): the
 * adapter does not read it. Without force it follows the same non-vr
 * refusal path; with force it returns backup-and-write and engine
 * preflight performs the final target-shape/symlink refusal.
 */

import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { findSentinelBlock, renderSentinelBlock } from "../sentinel.js";
import type { Adapter, AdapterContext, AdapterPlan, DetectResult, RecordKey } from "../types.js";
import { renderGitHubActionWorkflowInterior } from "./github-action-template.js";

// Display name (CLI output + logs). Distinct from RECORD_KEY.
const ADAPTER_NAME = "GitHub Action";

// Durable storage key per D101.O.
const RECORD_KEY: RecordKey = "github-action";

// POSIX forward slashes per D101.D.
const TARGET_PATH_RELATIVE = ".github/workflows/viberevert.yml";
const TARGET_PATH_TEMPLATE = `{repo}/${TARGET_PATH_RELATIVE}`;

// Sentinel block identifier. Namespaced "github-action-workflow" so
// rendered BEGIN/END markers are grep-distinct from other adapters.
const BLOCK_ID = "github-action-workflow";

const HUMAN_SUMMARY_WRITE_NEW =
  "Install the VibeRevert check workflow at .github/workflows/viberevert.yml";
const HUMAN_SUMMARY_REPLACE = "Update the VibeRevert check workflow to the current CLI version";
const HUMAN_SUMMARY_BACKUP =
  "Back up the existing workflow file and install the VibeRevert check workflow";

// Refusal copy for the non-vr-workflow-present branch. reasonCode
// literal-typed via `as const`.
const REFUSAL_REASON_CODE = "non-vr-workflow-present" as const;
const REFUSAL_MESSAGE =
  "A workflow file already exists at .github/workflows/viberevert.yml that VibeRevert did not create. " +
  "Re-run with --force-reinstall to back it up and install the VibeRevert workflow.";
const REFUSAL_MANUAL_SNIPPET = "viberevert install --github-action --force-reinstall";

/**
 * lstat the path; return null on ENOENT; propagate any other I/O
 * error. Same pattern as cursor / claude / husky / direct-hook.
 */
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export const githubActionAdapter: Adapter = {
  name: ADAPTER_NAME,

  detect(): Promise<DetectResult> {
    return Promise.resolve({ detected: true, signal: { detectPolicy: "always" } });
  },

  async plan(ctx: AdapterContext): Promise<AdapterPlan> {
    const targetPath = join(ctx.repoRoot, ".github", "workflows", "viberevert.yml");
    const stat = await lstatOrNull(targetPath);

    const interior = renderGitHubActionWorkflowInterior(ctx.cliVersion);
    const wrapped = renderSentinelBlock(BLOCK_ID, interior);
    const target = {
      scope: "repo" as const,
      pathTemplate: TARGET_PATH_TEMPLATE,
      pathRelative: TARGET_PATH_RELATIVE,
    };

    // Branch 1: file absent -> write-new with wrapped content.
    if (stat === null) {
      return {
        status: "applicable",
        adapterName: ADAPTER_NAME,
        humanSummary: HUMAN_SUMMARY_WRITE_NEW,
        ops: [{ kind: "write-new", target, content: wrapped }],
        recordKey: RECORD_KEY,
        meta: {},
      };
    }

    // File exists. Only read for sentinel content if it's a regular
    // file; non-files can't contain our sentinel. If forceReinstall
    // later makes the plan applicable, engine preflight owns the final
    // target-shape refusal.
    let existingContent: string | null = null;
    if (stat.isFile()) {
      existingContent = await readFile(targetPath, "utf8");
    }

    // Branch 2: sentinel present -> sentinel-block-replace (interior
    // only; installer wraps markers). Force flag doesn't change this
    // branch -- sentinel-replace IS the safe-update path.
    if (existingContent !== null && findSentinelBlock(existingContent, BLOCK_ID) !== null) {
      return {
        status: "applicable",
        adapterName: ADAPTER_NAME,
        humanSummary: HUMAN_SUMMARY_REPLACE,
        ops: [{ kind: "sentinel-block-replace", target, blockId: BLOCK_ID, content: interior }],
        recordKey: RECORD_KEY,
        meta: {},
      };
    }

    // Branch 4: no sentinel + forceReinstall -> backup-and-write.
    // Force flag ONLY overrides the non-vr-workflow-present refusal.
    if (ctx.options.forceReinstall) {
      return {
        status: "applicable",
        adapterName: ADAPTER_NAME,
        humanSummary: HUMAN_SUMMARY_BACKUP,
        ops: [{ kind: "backup-and-write", target, content: wrapped }],
        recordKey: RECORD_KEY,
        meta: {},
      };
    }

    // Branch 3: no sentinel + no force -> refuse.
    return {
      status: "refused",
      adapterName: ADAPTER_NAME,
      reasonCode: REFUSAL_REASON_CODE,
      message: REFUSAL_MESSAGE,
      manualSnippet: REFUSAL_MANUAL_SNIPPET,
    };
  },
};
