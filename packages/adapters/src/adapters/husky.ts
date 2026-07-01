// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Husky adapter for @viberevert/adapters.
 *
 * Installs the VibeRevert pre-commit gate as a sentinel-wrapped block
 * appended to <repo>/.husky/pre-commit. Per D101.A (adapter discipline)
 * this module reads filesystem state only to decide detection + plan
 * shape; it never mutates the filesystem and never reads
 * .viberevert/integrations.json.
 *
 * Per D101.K (locked adapter coexistence model):
 *   - Husky's .husky/pre-commit is a SHARED file that the user's other
 *     husky-managed commands compose into sequentially. Unlike
 *     direct-hook (which OWNS the entirety of .git/hooks/pre-commit and
 *     can unconditionally `exit "$EC"`), the husky sentinel body MUST
 *     NOT short-circuit subsequent user husky commands on a viberevert
 *     check success.
 *   - When a VibeRevert-managed direct .git/hooks/pre-commit is present
 *     ON DISK (line-2 MANAGED_BY_MARKER check, CRLF-tolerant per D98.A11)
 *     AND ctx.options.migrateFromHookInstall !== true, the adapter
 *     RETURNS a RefusedPlan (never throws) with reasonCode
 *     "vr-direct-hook-present". The user can re-run with
 *     --migrate-from-hook-install to migrate; that flag flips the
 *     refusal to an applicable plan and ALSO sets
 *     plan.meta.migrateFromDirectHook = "true" so the higher-level
 *     install choreography can remove the direct hook after the husky
 *     install commits (the actual removal does NOT live in this adapter
 *     -- adapters are read-only).
 *
 * Per D101.A: detect() decides auto-discovery; plan() describes the
 * requested install. plan() stays declarative -- it does NOT call
 * detectHookManagers a second time, does NOT validate .husky/ shape
 * (the engine's preflight handles missing-parent / wrong-type-parent /
 * symlink refusals), and does NOT emit any op touching
 * .git/hooks/pre-commit. The direct-hook marker check is ONLY for the
 * refusal-vs-migration branch decision.
 *
 * Per D101.F: target is repo-local (.husky/pre-commit) -- never a home
 * directory or global path.
 *
 * Per D101.D: pathRelative uses POSIX forward slashes on all platforms.
 *
 * Per D101.B: ctx.options.migrateFromHookInstall is narrowly scoped --
 * it ONLY overrides the vr-direct-hook-present refusal branch. It does
 * NOT act as a general force flag. It does NOT bypass other future
 * refusals. It does NOT set the migration meta marker on its own --
 * migrateFromDirectHook="true" is set ONLY when an actual VR direct
 * hook exists on disk AND the flag is true (i.e., we are actually
 * migrating, not merely passing the flag).
 *
 * detect() flow (host-driven; intent-independent):
 *   1. detectHookManagers(ctx.repoRoot) -- the SINGLE source for
 *      hook-manager detection signals (D98.M.8 amendment lock).
 *   2. detection.husky.detected === true -> detected:true with signal
 *      carrying the husky.signal vocabulary verbatim.
 *   3. Otherwise not-detected with reason naming the missing signals.
 *
 * detect() does NOT inspect .git/hooks/pre-commit. The direct-hook
 * conflict is a plan()-time concern, not a detect()-time concern;
 * mixing them would couple two distinct layering decisions (auto-
 * discovery vs. install applicability).
 *
 * plan() flow (re-inspects vr direct hook on disk; stateless):
 *   1. isVrDirectHookPresentOnDisk(ctx.repoRoot) -- strict line-2
 *      marker check on .git/hooks/pre-commit (regular file only).
 *   2. vr direct hook present AND !migrateFromHookInstall -> RefusedPlan
 *      reasonCode "vr-direct-hook-present" with user-facing message
 *      naming ".git/hooks/pre-commit" and pointing the user at the
 *      --migrate-from-hook-install flag via manualSnippet.
 *   3. Otherwise ApplicablePlan with a single sentinel-block-insert op
 *      against <repo>/.husky/pre-commit:
 *        blockId: "viberevert-husky-pre-commit" (namespaced so the
 *          sentinel markers inside the user-owned file are
 *          unmistakable)
 *        content: HUSKY_SENTINEL_BODY (the husky-citizen body -- see
 *          comment above HUSKY_SENTINEL_BODY_LINES)
 *        anchor: { mode: "append" }
 *      meta.migrateFromDirectHook = "true" iff vr direct hook present
 *      on disk AND migrateFromHookInstall true. The migrate flag alone
 *      WITHOUT a vr direct hook to migrate is a no-op signal (meta
 *      stays empty).
 *
 * Every nested value returned by plan() (target object, ops array,
 * meta object) is freshly constructed per call so external mutation
 * of one returned plan cannot leak into a subsequent plan() invocation.
 * HUSKY_SENTINEL_BODY is a primitive string (immutable) and is
 * included by reference.
 */

import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { detectHookManagers } from "../hook-managers.js";
import { MANAGED_BY_MARKER } from "../hook-script.js";
import type { Adapter, AdapterContext, AdapterPlan, DetectResult, RecordKey } from "../types.js";

// Display-only adapter name (CLI output + logs). Distinct from
// RECORD_KEY which is the durable storage key.
const ADAPTER_NAME = "Husky";

// Durable storage key written into .viberevert/integrations.json
// records[]. Locked per D101.O.
const RECORD_KEY: RecordKey = "husky";

// Repo-relative target -- POSIX forward slashes per D101.D.
const TARGET_PATH_RELATIVE = ".husky/pre-commit";
const TARGET_PATH_TEMPLATE = `{repo}/${TARGET_PATH_RELATIVE}`;

// Sentinel block identifier. Namespaced with "viberevert-" so the
// rendered BEGIN/END markers inside the user-owned .husky/pre-commit
// file are unmistakable (and grep-distinct from any future blockId
// that another adapter might choose).
const BLOCK_ID = "viberevert-husky-pre-commit";

// Human-readable summary surfaced by preview/apply receipts.
const HUMAN_SUMMARY = "Install the VibeRevert pre-commit gate into Husky's pre-commit chain";

// Refusal copy for the vr-direct-hook-present branch. reasonCode is
// locked + literal-typed via `as const` so it does not widen to
// `string` if RefusedPlan.reasonCode is ever narrowed to a literal
// union. message is user-facing (names .git/hooks/pre-commit + tells
// the user how to proceed); manualSnippet is the exact command for
// CLI re-run.
const REFUSAL_REASON_CODE = "vr-direct-hook-present" as const;
const REFUSAL_MESSAGE =
  "A VibeRevert direct .git/hooks/pre-commit install is already present. " +
  "Re-run with --migrate-from-hook-install to move it into Husky.";
const REFUSAL_MANUAL_SNIPPET = "viberevert install --husky --migrate-from-hook-install";

// Not-detected reason text -- used when detectHookManagers reports
// husky as absent. Names the locked signal vocabulary (.husky/ +
// package.json keys/deps) so the [skipped] CLI line is actionable.
const NOT_DETECTED_REASON =
  "husky not detected (no .husky/ directory and no `husky` key/dep in package.json)";

// Husky sentinel body. Husky's .husky/pre-commit is a SHARED file --
// the user's other husky-managed commands compose sequentially. The
// body MUST NOT short-circuit subsequent user commands on viberevert
// success. Discipline:
//
//   - viberevert check --staged
//   - capture exit code into __VR_EC (namespaced with double-underscore
//     prefix to avoid collisions with a user-defined EC variable
//     earlier in their husky chain)
//   - __VR_EC === 2 (findings block on threshold) -> print prompt-fix
//     tip; exit 1. Husky stops processing subsequent hook commands.
//   - __VR_EC !== 0 AND !== 2 (check itself failed) -> exit with the
//     same code. Husky stops.
//   - __VR_EC === 0 (no blocking findings) -> fall through silently;
//     husky continues with the user's next hook command.
//
// Body uses EXPLICIT exit logic and does NOT assume `set -e` (husky's
// default invocation does not enable it).
//
// Constructed via [...lines].join("\n") per D98.M.14 -- raw multi-line
// template literals introduce CRLF on a CRLF checkout (Windows + git
// autocrlf=true) and would silently drift the rendered sentinel bytes.
// The array-join construction is platform-immune.
//
// Backticks are shell-escaped so the double-quoted echo prints them
// literally instead of triggering command substitution.
const HUSKY_SENTINEL_BODY_LINES: readonly string[] = [
  "viberevert check --staged",
  "__VR_EC=$?",
  "",
  'if [ "$__VR_EC" -eq 2 ]; then',
  '  echo "" >&2',
  `  echo "Tip: run \\\`viberevert prompt-fix\\\` to generate a fix-prompt for your coding agent." >&2`,
  "  exit 1",
  "fi",
  "",
  'if [ "$__VR_EC" -ne 0 ]; then',
  '  exit "$__VR_EC"',
  "fi",
];

const HUSKY_SENTINEL_BODY: string = HUSKY_SENTINEL_BODY_LINES.join("\n");

/**
 * lstat the path; return null on ENOENT; propagate any other I/O
 * error. Same pattern as cursor + direct-hook adapters; private per the
 * 4A locked decision (no helper extraction yet; each adapter is
 * self-contained).
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
 * check. Marker on the wrong line (e.g., shebang shifted) is NOT
 * treated as VR-managed -- protects against drift if the file shape
 * ever changes.
 */
function isVrManagedDirectHook(content: string): boolean {
  const line2 = content.split("\n")[1];
  if (line2 === undefined) return false;
  return line2 === MANAGED_BY_MARKER || line2 === `${MANAGED_BY_MARKER}\r`;
}

/**
 * Return true iff <repo>/.git/hooks/pre-commit exists AS A REGULAR
 * FILE AND its content carries the VibeRevert managed-by marker on
 * line 2. Used by plan() to decide between the
 * vr-direct-hook-present refusal and the applicable (fresh-install
 * OR migration) path. Pure on-disk file inspection -- this method
 * NEVER reads .viberevert/integrations.json (per D101.A; the
 * integrations-record-driven guard is a separate cli-commands
 * concern landed in 4D/4E).
 */
async function isVrDirectHookPresentOnDisk(repoRoot: string): Promise<boolean> {
  const hookPath = join(repoRoot, ".git", "hooks", "pre-commit");
  const stat = await lstatOrNull(hookPath);
  if (stat === null || !stat.isFile()) return false;
  const content = await readFile(hookPath, "utf8");
  return isVrManagedDirectHook(content);
}

export const huskyAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(ctx: AdapterContext): Promise<DetectResult> {
    // detectHookManagers is the SINGLE source for hook-manager
    // detection signals (D98.M.8 amendment lock); husky adapter does
    // NOT inspect .husky/ or package.json directly. detect() does NOT
    // inspect .git/hooks/pre-commit either -- the direct-hook conflict
    // is a plan()-time concern, not a detect()-time concern.
    const detection = await detectHookManagers(ctx.repoRoot);
    if (detection.husky.detected) {
      return {
        detected: true,
        signal: { husky: { signal: detection.husky.signal } },
      };
    }
    return {
      detected: false,
      reason: NOT_DETECTED_REASON,
      signal: { husky: { detected: false } },
    };
  },

  async plan(ctx: AdapterContext): Promise<AdapterPlan> {
    // Inspect the direct .git/hooks/pre-commit on disk for the VR
    // marker. This is the ONLY file inspection plan() performs --
    // .husky/ shape (existence + dir-vs-file) is the engine
    // preflight's concern (assertSafeTarget); plan() stays
    // declarative.
    const vrDirectHookPresent = await isVrDirectHookPresentOnDisk(ctx.repoRoot);

    // Refusal branch: vr direct hook present AND migration not
    // requested. Locked per D101.B: the only thing
    // migrateFromHookInstall overrides is THIS specific refusal --
    // not a general force flag.
    if (vrDirectHookPresent && !ctx.options.migrateFromHookInstall) {
      return {
        status: "refused",
        adapterName: ADAPTER_NAME,
        reasonCode: REFUSAL_REASON_CODE,
        message: REFUSAL_MESSAGE,
        manualSnippet: REFUSAL_MANUAL_SNIPPET,
      };
    }

    // migrateFromDirectHook="true" ONLY when we are actually migrating
    // (vr direct hook present on disk AND user requested migration).
    // The flag alone -- without a vr direct hook on disk -- is a
    // no-op signal: the meta marker stays absent because there is
    // nothing to migrate.
    const useMigration = vrDirectHookPresent && ctx.options.migrateFromHookInstall;

    // Fresh nested values per call (target object, ops array, meta
    // object) -- mutation of one returned plan does not leak into a
    // subsequent plan() invocation. The `as const` on scope narrows
    // it to the PathSpec literal type without needing to import
    // PathSpec (same pattern as direct-hook.ts).
    const target = {
      scope: "repo" as const,
      pathTemplate: TARGET_PATH_TEMPLATE,
      pathRelative: TARGET_PATH_RELATIVE,
    };

    return {
      status: "applicable",
      adapterName: ADAPTER_NAME,
      humanSummary: HUMAN_SUMMARY,
      ops: [
        {
          kind: "sentinel-block-insert",
          target,
          blockId: BLOCK_ID,
          content: HUSKY_SENTINEL_BODY,
          anchor: { mode: "append" },
        },
      ],
      recordKey: RECORD_KEY,
      meta: useMigration ? { migrateFromDirectHook: "true" } : {},
    };
  },
};
