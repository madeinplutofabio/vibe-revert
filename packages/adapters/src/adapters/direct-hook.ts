// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct-hook adapter for @viberevert/adapters.
 *
 * Installs the VibeRevert pre-commit hook script directly into
 * <repo>/.git/hooks/pre-commit. Per D101.A (adapter discipline) this
 * module reads filesystem state only to decide detection + plan op
 * kind; it never mutates the filesystem and never reads
 * .viberevert/integrations.json.
 *
 * Per D101.K (locked adapter coexistence model):
 *   - Direct-hook is the standalone "VibeRevert owns the .git/hooks/
 *     pre-commit file" install path. When a hook manager (husky /
 *     lefthook) is present, the adapter REFUSES detection and points
 *     the user at the manager-specific adapter.
 *   - User content preservation for an existing non-vr hook is handled
 *     by the engine's backup-and-write op kind (byte-faithful backup
 *     before overwrite + uninstall restore from backup). Sentinel
 *     insert/replace coexistence is reserved for husky/lefthook
 *     (Step 4) where the host file is user-owned.
 *
 * Per D101.K mode discipline: HOOK_MODE = 0o755 is recorded on the
 * write-new / backup-and-write op so the engine chmods the resulting
 * file on POSIX. Engine no-ops chmod on Windows.
 *
 * Per D101.F: target is repo-local (.git/hooks/pre-commit) -- never
 * a home directory or global hook path.
 *
 * detect() flow (binary, intent-independent):
 *   1. detectHookManagers(ctx.repoRoot) -- if husky OR lefthook
 *      detected via fs signals, return detected:false with reason
 *      pointing the user at the appropriate adapter.
 *   2. Else inspect .git/hooks/pre-commit:
 *        absent      -> detected:true, signal.hookState = "absent"
 *        vr-managed  -> detected:true, signal.hookState = "vr-managed"
 *                       (line 2 of content matches MANAGED_BY_MARKER
 *                       per D98.A11; tolerates trailing \r for CRLF-
 *                       drifted hooks)
 *        user-owned  -> detected:true, signal.hookState = "user-owned"
 *        non-file    -> detected:true, signal.hookState = "non-file"
 *                       (engine preflight refuses non-file targets via
 *                       IntegrationTargetNotFileError; adapter passes
 *                       through declaratively)
 *
 * plan() flow:
 *   Re-inspects hook file state (cheap; supports standalone plan()
 *   use). user-owned existing hook -> ApplicablePlan { backup-and-
 *   write } so the engine backs up the user's hook bytes before
 *   overwrite. everything else -> ApplicablePlan { write-new }
 *   (absent: nothing to back up; vr-managed: classifier handles
 *   adoption/noop/safe-update via record SHA; non-file: engine
 *   preflight refuses cleanly with IntegrationTargetNotFileError).
 *
 * plan() ALWAYS returns ApplicablePlan -- detect() is the hook-manager
 * gate. Callers that invoke plan() despite detect()=false accept the
 * risk; the engine cannot detect hook-manager presence on its own.
 *
 * Every nested value returned by plan() (target object, ops array,
 * meta object) is freshly constructed per call so external mutation
 * of one returned plan cannot leak into a subsequent plan() invocation.
 * HOOK_SCRIPT_TEMPLATE is a primitive string (immutable) and is
 * included by reference.
 */

import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { detectHookManagers, type HookManagerDetection } from "../hook-managers.js";
import { HOOK_SCRIPT_TEMPLATE, MANAGED_BY_MARKER } from "../hook-script.js";
import type { Adapter, AdapterContext, AdapterPlan, DetectResult, RecordKey } from "../types.js";

// Display-only adapter name (CLI output + logs). Distinct from
// RECORD_KEY which is the durable storage key.
const ADAPTER_NAME = "Direct hook";

// Durable storage key written into .viberevert/integrations.json
// records[]. Locked per D101.O; matches the RecordKey enum.
const RECORD_KEY: RecordKey = "direct-hook";

// Repo-relative target -- POSIX forward slashes per D101.D.
const TARGET_PATH_RELATIVE = ".git/hooks/pre-commit";
const TARGET_PATH_TEMPLATE = `{repo}/${TARGET_PATH_RELATIVE}`;

// POSIX executable bit -- engine chmods after writeFileAtomic on
// POSIX; no-ops silently on Windows per D101.K mode discipline.
const HOOK_MODE = 0o755;

// Human-readable summaries surfaced by preview/apply receipts.
const HUMAN_SUMMARY_WRITE = "Install the VibeRevert pre-commit hook into .git/hooks/pre-commit";
const HUMAN_SUMMARY_BACKUP =
  "Back up the existing pre-commit hook and install the VibeRevert pre-commit hook";

// hookState discriminator emitted in detect's signal AND used by plan
// to pick op kind. Private to the module; tests exercise it through
// detect() and plan().
type HookState = "absent" | "vr-managed" | "user-owned" | "non-file";

/**
 * lstat the path; return null on ENOENT; propagate any other I/O
 * error. Same pattern as the cursor adapter.
 */
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Check whether the hook file content carries the VibeRevert
 * managed-by marker on line 2. Per hook-script.ts MANAGED_BY_MARKER
 * JSDoc (D98.A11): line 2 (split on "\n") must EXACTLY equal the
 * marker, OR equal the marker + "\r" (narrow CRLF tolerance for
 * CRLF-drifted hooks). NOT content.includes(MARKER); NOT a prefix
 * check.
 */
function isVrManagedHook(content: string): boolean {
  const line2 = content.split("\n")[1];
  if (line2 === undefined) return false;
  return line2 === MANAGED_BY_MARKER || line2 === `${MANAGED_BY_MARKER}\r`;
}

/**
 * Inspect .git/hooks/pre-commit and return its semantic state.
 * Private helper used by both detect() and plan() -- tests exercise
 * it indirectly through the public adapter surface (per the locked
 * "keep internals private" discipline).
 */
async function inspectHookFile(repoRoot: string): Promise<HookState> {
  const hookPath = join(repoRoot, ".git", "hooks", "pre-commit");
  const stat = await lstatOrNull(hookPath);
  if (stat === null) return "absent";
  if (!stat.isFile()) return "non-file";
  const content = await readFile(hookPath, "utf8");
  return isVrManagedHook(content) ? "vr-managed" : "user-owned";
}

/**
 * Compose a human-readable refusal reason naming the detected hook
 * manager(s) and pointing the user at the appropriate adapter. Stable
 * keyword content ("husky" / "lefthook") for diagnostic clarity;
 * tests assert keyword presence, not exact prose.
 */
function refusalReasonForHookManagers(detection: HookManagerDetection): string {
  const parts: string[] = [];
  if (detection.husky.detected) {
    parts.push(`husky (${detection.husky.signal})`);
  }
  if (detection.lefthook.detected) {
    parts.push(`lefthook (${detection.lefthook.signal})`);
  }
  const detectedList = parts.join(", ");
  const alternative =
    detection.husky.detected && detection.lefthook.detected
      ? "use --husky or --lefthook"
      : detection.husky.detected
        ? "use --husky"
        : "use --lefthook";
  return `Hook manager(s) detected: ${detectedList}; ${alternative} instead of --direct`;
}

export const directHookAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(ctx: AdapterContext): Promise<DetectResult> {
    const detection = await detectHookManagers(ctx.repoRoot);
    if (detection.husky.detected || detection.lefthook.detected) {
      return {
        detected: false,
        reason: refusalReasonForHookManagers(detection),
        signal: {
          husky: detection.husky.detected ? { signal: detection.husky.signal } : null,
          lefthook: detection.lefthook.detected ? { signal: detection.lefthook.signal } : null,
        },
      };
    }
    const hookState = await inspectHookFile(ctx.repoRoot);
    return { detected: true, signal: { hookState } };
  },

  async plan(ctx: AdapterContext): Promise<AdapterPlan> {
    // Re-inspect hook state so plan() is safe to call standalone.
    // The user-owned branch needs backup-and-write so the engine can
    // back up the user's bytes before overwrite; every other branch
    // (absent / vr-managed / non-file) uses write-new and the engine's
    // classifier + preflight handle the relevant cases.
    const hookState = await inspectHookFile(ctx.repoRoot);
    const useBackup = hookState === "user-owned";
    const humanSummary = useBackup ? HUMAN_SUMMARY_BACKUP : HUMAN_SUMMARY_WRITE;

    // Fresh target object per call -- mutation of one returned plan's
    // target does not leak into a subsequent plan() invocation. The
    // `as const` on `scope` narrows it to the PathSpec literal type
    // without needing to import PathSpec.
    const target = {
      scope: "repo" as const,
      pathTemplate: TARGET_PATH_TEMPLATE,
      pathRelative: TARGET_PATH_RELATIVE,
    };

    return {
      status: "applicable",
      adapterName: ADAPTER_NAME,
      humanSummary,
      ops: [
        useBackup
          ? {
              kind: "backup-and-write" as const,
              target,
              content: HOOK_SCRIPT_TEMPLATE,
              mode: HOOK_MODE,
            }
          : {
              kind: "write-new" as const,
              target,
              content: HOOK_SCRIPT_TEMPLATE,
              mode: HOOK_MODE,
            },
      ],
      recordKey: RECORD_KEY,
      meta: {},
    };
  },
};
