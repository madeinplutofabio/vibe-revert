// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Lefthook adapter for @viberevert/adapters.
 *
 * Installs the VibeRevert pre-commit gate as a sentinel-wrapped block
 * inserted into the user's lefthook config under pre-commit.commands.
 * Per D101.A (adapter discipline) this module reads filesystem state
 * only to decide detection + plan shape; it never mutates the
 * filesystem and never reads .viberevert/integrations.json.
 *
 * Per D101.A "Lefthook applicable means VibeRevert will actually run
 * through Lefthook" (locked principle): an ApplicablePlan returned by
 * this adapter MUST produce a functional install -- not an
 * instructional-comment-only sentinel block, not a top-level fake YAML
 * key. If the engine cannot insert a working command (e.g., supported
 * config shape absent), the adapter returns a RefusedPlan with a
 * pasteable manualSnippet -- never a placeholder applicable plan.
 *
 * Per D101.K (locked v1 limitations):
 *   - v1 supports BLOCK-FORM lefthook YAML only: pre-commit: followed
 *     IMMEDIATELY by indented commands:. Flow-style
 *     (pre-commit: { commands: {} }), sibling keys between pre-commit:
 *     and commands: (e.g., pre-commit:\n  parallel: true\n  commands:),
 *     and tab indentation are all refused with lefthook-config-shape
 *     in v1. YAML-aware merge handling these richer shapes is deferred
 *     to followup-4.
 *   - v1 targets one of 4 COMMITTED config variants in precedence
 *     order: lefthook.yml > lefthook.yaml > .lefthook.yml >
 *     .lefthook.yaml. lefthook-local.yml is intentionally excluded
 *     from the install target (typically gitignored; not safe for
 *     team-wide install). If only lefthook-local.yml exists -> refuse
 *     lefthook-config-only-in-local.
 *   - v1 refuses if MULTIPLE committed variants exist -> refuse
 *     lefthook-config-ambiguous, naming the detected files (user must
 *     keep one).
 *   - v1 refuses if ANY existing variant (committed or
 *     lefthook-local.yml) is not a regular file (directory, symlink,
 *     fifo, etc.) -> refuse lefthook-config-shape. lstat is used
 *     consistently so symlinks fail isFile() and surface as non-file.
 *   - v1 refuses if MULTIPLE top-level pre-commit.commands blocks
 *     match the supported regex (defensive vs. invalid duplicate
 *     pre-commit: keys; protects against insertion ambiguity).
 *
 * Per D101.J: detect() is host-driven via detectHookManagers (Step 1
 * D98.M.8 amendment lock -- single source for hook-manager detection
 * signals). Husky-style layering: detect() does NOT inspect lefthook
 * config files for structure -- that is plan()'s concern.
 *
 * Per the sentinel.ts findWholeLine API: the after-marker anchor mode
 * uses the FIRST whole-line occurrence of the marker string. Two
 * lefthook hook sections (e.g., commit-msg.commands and
 * pre-commit.commands) routinely have BYTE-IDENTICAL commands: lines
 * at the same indent. Plan must therefore PRE-VALIDATE uniqueness:
 * count exact occurrences of the captured commands: line content; if
 * > 1, refuse lefthook-config-shape (ambiguous). Extending sentinel.ts
 * for multi-line markers is deferred (out of scope for 4B).
 *
 * Per D101.F: target is repo-local (one of the 4 committed lefthook
 * config variants) -- never a home directory or global path.
 *
 * Per D101.D: pathRelative uses POSIX forward slashes on all platforms.
 *
 * Per D101.B: lefthook adapter has NO migration-from-direct-hook
 * branch (unlike husky). ctx.options.migrateFromHookInstall is
 * ignored.
 *
 * detect() flow (host-driven; intent-independent):
 *   1. detectHookManagers(ctx.repoRoot).
 *   2. detection.lefthook.detected === true -> detected:true with
 *      signal carrying the lefthook.signal vocabulary verbatim.
 *   3. Otherwise not-detected with reason naming the missing signals.
 *
 * plan() flow (re-inspects config files; stateless):
 *   1. resolveLefthookConfigTarget -- lstat each of the 4 committed
 *      variants + lefthook-local.yml; classify result as ok |
 *      non-file | ambiguous | local-only | none.
 *   2. non-file -> RefusedPlan lefthook-config-shape (naming the
 *      offending paths). Wins over ambiguous: a directory at a
 *      standard lefthook config path is suspicious even if another
 *      committed variant is a valid file.
 *   3. ambiguous / local-only / none -> RefusedPlan with appropriate
 *      reason code + message + (for shape refusals) manualSnippet.
 *   4. Read the resolved config file's bytes.
 *   5. matchAll PRE_COMMIT_COMMANDS_RE (with /g) for block-form
 *      pre-commit.commands. 0 matches -> RefusedPlan
 *      lefthook-config-shape. >1 matches -> RefusedPlan
 *      lefthook-config-shape (multiple pre-commit.commands blocks).
 *   6. Build commandsLine from the single match's captures.
 *   7. Uniqueness pre-validation on commandsLine content (CRLF-
 *      tolerant). > 1 occurrence -> RefusedPlan lefthook-config-shape
 *      (ambiguous commands: line shared across hook sections).
 *   8. Existing-install check:
 *        if our SENTINEL_BEGIN_MARKER is present -> SKIP duplicate-
 *          command refusal (engine classifier handles noop/safe-update
 *          for managed sentinel content).
 *        else if 'viberevert-check:' OR /run:\s*viberevert check\b/
 *          appears -> RefusedPlan lefthook-viberevert-command-already-
 *          present (manual install detected; conservative refusal).
 *   9. detectChildIndent -- inspect the first non-empty non-comment
 *      line after commands: to determine the user's nesting style.
 *      If a deeper indent is found, use it; otherwise fall back to
 *      commandsIndent + TWO SPACES (default 2-space deeper). This
 *      keeps the inserted viberevert-check sibling-aligned with
 *      existing commands (e.g., aligned with eslint:), and uses a
 *      sensible default for empty commands: sections.
 *  10. Build sentinel content via [...lines].join("\n") per D98.M.14.
 *      Adapter emits canonical LF content; the installer engine handles
 *      target line-ending normalization (D101.Q) at apply time.
 *  11. Emit ApplicablePlan with sentinel-block-insert anchored after
 *      the EXACT matched commandsLine (not a generic " commands:" --
 *      keeps the engine insertion tied to the structural line the
 *      adapter validated).
 *
 * Every nested value returned by plan() (target object, ops array,
 * meta object) is freshly constructed per call so external mutation
 * of one returned plan cannot leak into a subsequent plan() invocation.
 */

import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { detectHookManagers } from "../hook-managers.js";
import type { Adapter, AdapterContext, AdapterPlan, DetectResult, RecordKey } from "../types.js";

// Display-only adapter name (CLI output + logs). Distinct from
// RECORD_KEY which is the durable storage key.
const ADAPTER_NAME = "Lefthook";

// Durable storage key written into .viberevert/integrations.json
// records[]. Locked per D101.O.
const RECORD_KEY: RecordKey = "lefthook";

// Sentinel block identifier. Namespaced with "viberevert-" so the
// rendered BEGIN/END markers inside the user-owned lefthook config
// are unmistakable.
const BLOCK_ID = "viberevert-lefthook-pre-commit";

// Exact sentinel BEGIN marker line. Used to skip the
// existing-unmanaged-command refusal when our own block is already
// present (engine classifier handles noop/safe-update for that case).
const SENTINEL_BEGIN_MARKER = `# viberevert:begin:${BLOCK_ID}`;

// Committed config variants in precedence order. lefthook-local.yml
// is INTENTIONALLY excluded from this list -- it's typically
// gitignored and writing team-wide integration into a local-only file
// would silently fail to reach other devs on the team.
const COMMITTED_VARIANTS: readonly string[] = [
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".lefthook.yaml",
];

const LEFTHOOK_LOCAL_FILENAME = "lefthook-local.yml";

// Human-readable summary surfaced by preview/apply receipts.
const HUMAN_SUMMARY = "Install the VibeRevert pre-commit gate into Lefthook's pre-commit.commands";

// Refusal reason codes. Locked + literal-typed via `as const` so they
// do not widen to `string` if RefusedPlan.reasonCode is ever narrowed
// to a literal union. Per the locked "one reason code per failure
// CATEGORY" amendment, multiple shape-related issues all surface as
// lefthook-config-shape with different message detail rather than
// proliferating reason codes.
const REFUSAL_LOCAL_ONLY = "lefthook-config-only-in-local" as const;
const REFUSAL_AMBIGUOUS = "lefthook-config-ambiguous" as const;
const REFUSAL_SHAPE = "lefthook-config-shape" as const;
const REFUSAL_ALREADY_PRESENT = "lefthook-viberevert-command-already-present" as const;

// Complete pasteable manual snippet for shape/local-only refusals.
// Constructed via array.join per D98.M.14. LF-only (it's CLI/help
// text, not target-file bytes -- engine handles target file line
// endings separately).
const COMPLETE_MANUAL_SNIPPET_LINES: readonly string[] = [
  "pre-commit:",
  "  commands:",
  "    viberevert-check:",
  "      run: viberevert check --staged",
];
const COMPLETE_MANUAL_SNIPPET: string = COMPLETE_MANUAL_SNIPPET_LINES.join("\n");

// Not-detected reason text -- used when detectHookManagers reports
// lefthook as absent. Names the locked signal vocabulary so the
// [skipped] CLI line is actionable.
const NOT_DETECTED_REASON =
  "lefthook not detected (no lefthook config file in standard locations and no `lefthook` key/dep in package.json)";

// Strict block-form regex with indentation capture. Horizontal
// whitespace only ([ \t]*, not \s*) to avoid greedy cross-line
// backtracking and to enforce single-line "pre-commit:" / "commands:"
// lines. Group 1: the indent of the commands: line (spaces only --
// YAML 1.2 disallows tabs for indentation). Group 2: the literal
// "commands:" text with any trailing horizontal whitespace (no line
// terminator, by virtue of placing (?:\r?\n|$) OUTSIDE the group).
//
// /g flag enables matchAll so plan() can detect MULTIPLE top-level
// pre-commit.commands blocks (defensive refusal). /m flag enables
// `^` to match at any line start.
//
// Refused by no-match (all surface as lefthook-config-shape):
//   - missing pre-commit.commands entirely
//   - flow-style: pre-commit: { commands: {} }
//   - sibling key between: pre-commit:\n  parallel: true\n  commands:
//   - tab-indented commands: line
const PRE_COMMIT_COMMANDS_RE = /^pre-commit:[ \t]*\r?\n( +)(commands:[ \t]*)(?:\r?\n|$)/gm;

// Heuristic regex for an existing unmanaged VibeRevert command in
// the user's config. Bias: false positive causes a REFUSAL (not a
// bad write). Used in concert with the literal text search for
// "viberevert-check:". Conservative per locked amendment.
const EXISTING_VR_RUN_RE = /run:\s*viberevert check\b/;

// ---------------------------------------------------------------------------
// Internal types.
// ---------------------------------------------------------------------------

type ConfigTargetResolution =
  | {
      readonly kind: "ok";
      readonly configFile: string;
      readonly absolutePath: string;
    }
  | { readonly kind: "non-file"; readonly configFiles: readonly string[] }
  | { readonly kind: "ambiguous"; readonly committedFiles: readonly string[] }
  | { readonly kind: "local-only"; readonly localPath: string }
  | { readonly kind: "none" };

// ---------------------------------------------------------------------------
// Helpers (private; duplicated from sibling adapters per the locked
// 4A/4B "no helper extraction yet; each adapter is self-contained"
// pattern. Extraction can wait for a future cleanup if the pattern
// repeats more than twice across adapters).
// ---------------------------------------------------------------------------

/**
 * lstat the path; return null on ENOENT; propagate any other I/O
 * error. Same pattern as cursor / direct-hook / husky adapters.
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
 * Resolve which lefthook config file plan() should target. lstats
 * each of the 4 committed variants + lefthook-local.yml. Returns one
 * of:
 *   - "ok": exactly one committed variant exists AS A REGULAR FILE.
 *   - "non-file": at least one existing config path (committed OR
 *     lefthook-local.yml) is not a regular file (directory, symlink,
 *     fifo, etc.). Wins over ambiguous + local-only -- a directory
 *     at a standard lefthook config path is suspicious regardless of
 *     other variants. Symlinks fall through this branch because
 *     lstat does not follow symlinks (isFile() returns false on
 *     symlink Stats).
 *   - "ambiguous": 2+ committed variants exist AS REGULAR FILES.
 *   - "local-only": no committed variants but lefthook-local.yml
 *     exists AS A REGULAR FILE.
 *   - "none": no lefthook config file at all (defensive -- if
 *     detectHookManagers returned lefthook-not-detected the CLI
 *     would not call plan(), but plan() is safe to call standalone).
 *
 * Co-existence with lefthook-local.yml: if a committed variant exists
 * AND lefthook-local.yml also exists (both as regular files), the
 * committed variant wins (this function returns "ok" with the
 * committed variant; local file is ignored). lefthook-local.yml is
 * only a problem when it's the ONLY config file present.
 */
async function resolveLefthookConfigTarget(repoRoot: string): Promise<ConfigTargetResolution> {
  const committedFiles: string[] = [];
  const nonFileVariants: string[] = [];
  for (const variant of COMMITTED_VARIANTS) {
    const stat = await lstatOrNull(join(repoRoot, variant));
    if (stat === null) continue;
    if (!stat.isFile()) {
      nonFileVariants.push(variant);
    } else {
      committedFiles.push(variant);
    }
  }

  // Also stat lefthook-local.yml so a non-file there is caught even
  // when committed variants are all OK or absent.
  const localStat = await lstatOrNull(join(repoRoot, LEFTHOOK_LOCAL_FILENAME));
  const localExistsAsFile = localStat?.isFile() === true;
  if (localStat !== null && !localStat.isFile()) {
    nonFileVariants.push(LEFTHOOK_LOCAL_FILENAME);
  }

  // non-file wins over every other resolution -- even if another
  // committed variant is a valid file, a directory/symlink at a
  // standard lefthook config path is suspicious enough to refuse.
  if (nonFileVariants.length > 0) {
    return { kind: "non-file", configFiles: nonFileVariants };
  }

  if (committedFiles.length > 1) {
    return { kind: "ambiguous", committedFiles };
  }
  if (committedFiles.length === 1) {
    const variant = committedFiles[0];
    if (variant === undefined) {
      throw new Error("unreachable: committedFiles.length === 1 but committedFiles[0] undefined");
    }
    return {
      kind: "ok",
      configFile: variant,
      absolutePath: join(repoRoot, variant),
    };
  }
  if (localExistsAsFile) {
    return { kind: "local-only", localPath: LEFTHOOK_LOCAL_FILENAME };
  }
  return { kind: "none" };
}

/**
 * Inspect the first non-empty, non-comment line AFTER the matched
 * commands: line to determine the indent style of existing children.
 * Returns the indent string (e.g., "    ") if found, or null if:
 *   - the commandsLine cannot be located in the split lines
 *     (defensive -- caller passes commandsLine derived from regex
 *     match so it should always be present)
 *   - no qualifying child line exists (commands: is empty, or only
 *     followed by lines at <= commandsIndent depth)
 *   - the first qualifying line is at column 0 (not a child of
 *     commands:)
 *
 * CRLF-tolerant: splits on "\n" then strips trailing "\r" from each
 * line before comparison. Matches the uniqueness-check split pattern.
 *
 * The caller falls back to commandsIndent + TWO SPACES (a 2-space-
 * deeper default) when this helper returns null. This keeps the
 * inserted viberevert-check sibling-aligned with existing commands
 * (e.g., aligned with eslint:) when they exist, and uses a sensible
 * default for empty commands: sections.
 */
function detectChildIndent(
  content: string,
  commandsLine: string,
  commandsIndent: string,
): string | null {
  const lines = content.split("\n");
  const commandsLineIdx = lines.findIndex(
    (line) => line === commandsLine || line === `${commandsLine}\r`,
  );
  if (commandsLineIdx < 0) return null;
  for (let i = commandsLineIdx + 1; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indentMatch = line.match(/^([ \t]+)/);
    if (indentMatch === null) return null;
    const childIndent = indentMatch[1];
    if (childIndent === undefined) return null;
    // Strictly deeper than commandsIndent -- a line at the same indent
    // or less is NOT a child of commands:.
    if (childIndent.length <= commandsIndent.length) return null;
    return childIndent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Refusal builders. Each carries the locked reason code + a message
// detailing WHY; manualSnippet only on shape/local-only refusals where
// a pasteable starting point is actionable.
// ---------------------------------------------------------------------------

function refuseLocalOnly(localPath: string): AdapterPlan {
  return {
    status: "refused",
    adapterName: ADAPTER_NAME,
    reasonCode: REFUSAL_LOCAL_ONLY,
    message:
      `Only ${localPath} found (typically gitignored; not safe for team-wide installs). ` +
      "Create a committed lefthook config (lefthook.yml, lefthook.yaml, .lefthook.yml, or .lefthook.yaml) " +
      "to install VibeRevert across the team.",
    manualSnippet: COMPLETE_MANUAL_SNIPPET,
  };
}

function refuseNonFile(configFiles: readonly string[]): AdapterPlan {
  const list = configFiles.join(", ");
  return {
    status: "refused",
    adapterName: ADAPTER_NAME,
    reasonCode: REFUSAL_SHAPE,
    message:
      `Lefthook config path(s) exist but are not regular files: ${list}. ` +
      "Each lefthook config file (lefthook.yml, lefthook.yaml, .lefthook.yml, .lefthook.yaml, " +
      "lefthook-local.yml) must be a regular file (not a directory, symlink, or other inode type) " +
      "for v1 install to proceed.",
    manualSnippet: COMPLETE_MANUAL_SNIPPET,
  };
}

function refuseAmbiguous(committedFiles: readonly string[]): AdapterPlan {
  return {
    status: "refused",
    adapterName: ADAPTER_NAME,
    reasonCode: REFUSAL_AMBIGUOUS,
    message:
      `Multiple committed lefthook config variants detected: ${committedFiles.join(", ")}. ` +
      "Keep one and remove the others to disambiguate the install target.",
  };
}

function refuseShape(detail: string): AdapterPlan {
  return {
    status: "refused",
    adapterName: ADAPTER_NAME,
    reasonCode: REFUSAL_SHAPE,
    message: detail,
    manualSnippet: COMPLETE_MANUAL_SNIPPET,
  };
}

function refuseAlreadyPresent(configFile: string): AdapterPlan {
  return {
    status: "refused",
    adapterName: ADAPTER_NAME,
    reasonCode: REFUSAL_ALREADY_PRESENT,
    message:
      `${configFile} appears to already contain a VibeRevert command ` +
      "(found 'viberevert-check:' or a 'run: viberevert check' line outside our sentinel block). " +
      "Remove the manual entry, or let VibeRevert manage it via the sentinel block.",
  };
}

export const lefthookAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(ctx: AdapterContext): Promise<DetectResult> {
    // detectHookManagers is the SINGLE source for hook-manager
    // detection signals (D98.M.8 amendment lock). detect() does NOT
    // inspect lefthook config files for STRUCTURE -- that is plan()'s
    // concern. Layering: detect = auto-discovery; plan = applicability.
    const detection = await detectHookManagers(ctx.repoRoot);
    if (detection.lefthook.detected) {
      return {
        detected: true,
        signal: { lefthook: { signal: detection.lefthook.signal } },
      };
    }
    return {
      detected: false,
      reason: NOT_DETECTED_REASON,
      signal: { lefthook: { detected: false } },
    };
  },

  async plan(ctx: AdapterContext): Promise<AdapterPlan> {
    // 1. Resolve target file (or refuse). non-file wins over every
    // other resolution; ambiguous and local-only and none fall through
    // to their respective refusal builders.
    const targetResolution = await resolveLefthookConfigTarget(ctx.repoRoot);
    if (targetResolution.kind === "non-file") {
      return refuseNonFile(targetResolution.configFiles);
    }
    if (targetResolution.kind === "none") {
      return refuseShape(
        "No lefthook configuration file found in any standard location " +
          "(lefthook.yml, lefthook.yaml, .lefthook.yml, .lefthook.yaml, lefthook-local.yml). " +
          "Create a committed lefthook.yml first.",
      );
    }
    if (targetResolution.kind === "local-only") {
      return refuseLocalOnly(targetResolution.localPath);
    }
    if (targetResolution.kind === "ambiguous") {
      return refuseAmbiguous(targetResolution.committedFiles);
    }

    // 2. Read config bytes (target is guaranteed to be a regular file
    // by resolveLefthookConfigTarget's non-file check above).
    const content = await readFile(targetResolution.absolutePath, "utf8");

    // 3. matchAll for block-form pre-commit.commands shape. Use
    // matchAll (not exec) to detect MULTIPLE top-level
    // pre-commit.commands blocks; refuse if found (defensive vs.
    // invalid duplicate pre-commit: keys).
    const allMatches = [...content.matchAll(PRE_COMMIT_COMMANDS_RE)];
    if (allMatches.length === 0) {
      return refuseShape(
        `${targetResolution.configFile} does not contain a recognized pre-commit.commands block. ` +
          "v1 supports block-form YAML only: `pre-commit:` followed IMMEDIATELY by indented `commands:`. " +
          "Flow-style (pre-commit: { commands: {} }), sibling keys between pre-commit: and commands:, " +
          "and tab indentation are not yet supported (YAML-aware merge is planned for a future release).",
      );
    }
    if (allMatches.length > 1) {
      return refuseShape(
        `${targetResolution.configFile} contains ${allMatches.length} top-level pre-commit.commands blocks. ` +
          "v1 supports configs with a single pre-commit.commands block. Multiple blocks at top level are " +
          "usually invalid YAML (duplicate `pre-commit:` keys); consolidate into one block.",
      );
    }
    const match = allMatches[0];
    if (match === undefined) {
      throw new Error("unreachable: allMatches.length === 1 but allMatches[0] undefined");
    }
    const commandsIndent = match[1];
    const commandsLineContent = match[2];
    if (commandsIndent === undefined || commandsLineContent === undefined) {
      throw new Error("unreachable: PRE_COMMIT_COMMANDS_RE matched but capture groups missing");
    }
    const commandsLine = `${commandsIndent}${commandsLineContent}`;

    // 4. Uniqueness pre-validation -- sentinel.ts findWholeLine returns
    // the FIRST whole-line match with no fromIndex; if two hook sections
    // (e.g., commit-msg.commands and pre-commit.commands) share a
    // byte-identical commands: line, the engine would insert into the
    // wrong section. Conservative refusal. CRLF-tolerant comparison
    // because a CRLF file split on "\n" leaves "\r" on each line.
    const sameCommandsLineCount = content
      .split("\n")
      .filter((line) => line === commandsLine || line === `${commandsLine}\r`).length;
    if (sameCommandsLineCount > 1) {
      return refuseShape(
        `${targetResolution.configFile} contains ambiguous '${commandsLineContent.trim()}' line ` +
          `(appears ${sameCommandsLineCount} times across hook sections). ` +
          "v1 cannot safely target pre-commit.commands when another hook section has an identical " +
          "commands: line. Remove the conflicting hook section, or wait for YAML-aware merge support " +
          "in a future release.",
      );
    }

    // 5. Existing-install check. SKIP if our sentinel BEGIN marker is
    // present (engine classifier handles noop/safe-update for managed
    // sentinel content). Otherwise refuse if any unmanaged
    // viberevert-check appears (conservative; false positive = refusal,
    // not bad write).
    const sentinelPresent = content.includes(SENTINEL_BEGIN_MARKER);
    if (!sentinelPresent) {
      if (content.includes("viberevert-check:") || EXISTING_VR_RUN_RE.test(content)) {
        return refuseAlreadyPresent(targetResolution.configFile);
      }
    }

    // 6. Detect existing child indent for sibling alignment; fall back
    // to commandsIndent + TWO SPACES (2 chars deeper) when commands:
    // is empty or has no qualifying child line.
    const detectedChildIndent = detectChildIndent(content, commandsLine, commandsIndent);
    const commandIndent = detectedChildIndent ?? `${commandsIndent}  `;
    const runIndent = `${commandIndent}  `;

    // 7. Build sentinel block content via array.join per D98.M.14.
    // Content lines indent to commandIndent / runIndent so the YAML
    // parses correctly (the sentinel BEGIN/END marker lines render at
    // column 0 by sentinel.ts -- they are YAML comments and lefthook
    // skips them during parse).
    //
    // The adapter emits canonical LF content; the installer engine
    // handles target line-ending normalization (D101.Q) at apply time.
    // 4B does NOT inspect the target's existing line ending and does
    // NOT emit CRLF -- that decision lives in the engine.
    const contentLines: readonly string[] = [
      `${commandIndent}viberevert-check:`,
      `${runIndent}run: viberevert check --staged`,
    ];
    const sentinelBlockContent: string = contentLines.join("\n");

    // 8. Fresh nested values per call (target object, ops array, meta
    // object). Mutation safety per locked discipline.
    const target = {
      scope: "repo" as const,
      pathTemplate: `{repo}/${targetResolution.configFile}`,
      pathRelative: targetResolution.configFile,
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
          content: sentinelBlockContent,
          // After-marker with the EXACT matched commands: line (not a
          // generic " commands:") -- keeps the engine insertion tied
          // to the structural line the adapter validated.
          anchor: { mode: "after-marker", marker: commandsLine },
        },
      ],
      recordKey: RECORD_KEY,
      meta: {},
    };
  },
};
