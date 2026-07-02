// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * `viberevert install` command -- selects one or more adapters, drives
 * the detect/plan/apply pipeline through @viberevert/installers, and
 * emits per-adapter status lines in a locked vocabulary.
 *
 * === Command surface (M G1b Step 6) ===
 *
 * viberevert install
 *   [--cursor | --claude | --direct | --husky | --lefthook | --github-action | --all]
 *   [--dry-run] [--force-reinstall] [--migrate-from-hook-install]
 *
 * Locked flag rules (enforced in validateFlags):
 *   1. Exactly one of the 7 target selectors must be present. --all and
 *      any explicit adapter flag are mutually exclusive; multiple
 *      explicit flags are rejected; no target at all is rejected.
 *   2. --migrate-from-hook-install requires --husky alone. Rejected
 *      with --all and with multi-adapter combinations.
 *   3. --dry-run + --migrate-from-hook-install is a semantic conflict.
 *
 * === Output vocabulary (5 categories) ===
 *
 *   [skipped: <adapter>: <reason>]                            (detect: false)
 *   [refused: <adapter>: <code>: <message>]                   (any refusal)
 *   [noop:    <adapter>: <reason>]                            (engine noop)
 *   [applied: <adapter>: <humanSummary>]                      (apply succeeded)
 *   [applicable: <adapter>: <humanSummary>] + indented diff   (--dry-run only)
 *
 * Bracket vocabulary is reserved for the adapter-iteration phase. Pre-
 * iteration errors (usage validation, RepoRootNotFoundError) use plain
 * stderr + exit 1.
 *
 * === Exit code discipline ===
 *
 * 0 iff no [refused] line was emitted. 1 otherwise.
 *
 * === Error handling ===
 *
 * Known errors format as [refused: <adapter>: <err.name>: <err.message>]:
 *   - InstallerError subclasses (engine-side)
 *   - AdapterError subclasses (adapter-side) plus HookManagerIoError +
 *     MalformedPackageJsonError which historically extend Error directly
 *     (M G1b-followup: unify under AdapterError).
 *
 * RepoRootNotFoundError is plain stderr. Unknown errors are RETHROWN.
 *
 * === Force flag discipline (D101.B) ===
 *
 * --force-reinstall flows only into ctx.options.forceReinstall.
 *
 * === No installer-record access ===
 *
 * This command does NOT read .viberevert/integrations.json. All record-
 * driven decisions live in the installer engine.
 *
 * === Migration choreography (--migrate-from-hook-install) ===
 *
 * Locked 5-step ordering with plan-meta gate:
 *   1. Husky plan() emits meta.migrateFromDirectHook === "true".
 *   2. Apply Husky first via the standard iteration.
 *   3. Cleanup runs ONLY if ALL of:
 *      (a) --migrate-from-hook-install flag is set
 *      (b) Husky plan meta.migrateFromDirectHook === "true"
 *      (c) Husky outcome status is "applied" or "noop"
 *      Absent (b), the flag alone does NOT authorize direct-hook removal.
 *   4. On cleanup refusal / known-error throw -> [refused: Direct hook: ...],
 *      exit 1.
 *   5. NEVER remove direct-hook before the installer has returned a
 *      valid Husky applied/noop outcome (guaranteed by control flow:
 *      cleanup runs only after Husky's outcome is emitted).
 *
 * The migration cleanup line is EMITTED SEPARATELY. A "not-installed"
 * cleanup outcome emits NO line (silent success -- nothing to migrate).
 */

import {
  type Adapter,
  type AdapterContext,
  AdapterError,
  type AdapterPlan,
  claudeAdapter,
  cursorAdapter,
  type DetectResult,
  directHookAdapter,
  githubActionAdapter,
  HookManagerIoError,
  huskyAdapter,
  lefthookAdapter,
  MalformedPackageJsonError,
} from "@viberevert/adapters";
import { RepoRootNotFoundError, resolveRepoRoot } from "@viberevert/core";
import {
  apply,
  InstallerError,
  type InstallOutcome,
  type PreviewDiff,
  type PreviewOutcome,
  preview,
  type RecordKey,
  type UninstallContext,
  type UninstallOutcome,
  uninstall,
} from "@viberevert/installers";
import { Command, Option } from "clipanion";

import pkg from "../../package.json" with { type: "json" };
import { resolveNowForCliTimestamp } from "../runtime-env.js";

// ---------------------------------------------------------------------------
// CLI version -- sourced from cli-commands package.json.
// ---------------------------------------------------------------------------

const CLI_VERSION: string = pkg.version;

// ---------------------------------------------------------------------------
// Adapter matrix -- narrative ship order. GitHub Action is in the matrix
// but excluded from --all per D101.J.
// ---------------------------------------------------------------------------

type AdapterFlag = "cursor" | "direct" | "husky" | "lefthook" | "claude" | "github-action";

interface AdapterMatrixEntry {
  readonly flag: AdapterFlag;
  readonly adapter: Adapter;
  readonly recordKey: RecordKey;
  readonly inAll: boolean;
}

const ADAPTER_MATRIX: readonly AdapterMatrixEntry[] = [
  { flag: "cursor", adapter: cursorAdapter, recordKey: "cursor", inAll: true },
  { flag: "direct", adapter: directHookAdapter, recordKey: "direct-hook", inAll: true },
  { flag: "husky", adapter: huskyAdapter, recordKey: "husky", inAll: true },
  { flag: "lefthook", adapter: lefthookAdapter, recordKey: "lefthook", inAll: true },
  { flag: "claude", adapter: claudeAdapter, recordKey: "claude", inAll: true },
  { flag: "github-action", adapter: githubActionAdapter, recordKey: "github-action", inAll: false },
];

// Display name for migration-cleanup line. Sourced from the adapter
// instance to avoid display-name drift.
const DIRECT_HOOK_DISPLAY_NAME: string = directHookAdapter.name;

// ---------------------------------------------------------------------------
// Output formatters -- byte-exact, LF-terminated per line.
// ---------------------------------------------------------------------------

function formatSkipped(name: string, reason: string): string {
  return `[skipped: ${name}: ${reason}]\n`;
}

function formatRefused(name: string, code: string, message: string): string {
  return `[refused: ${name}: ${code}: ${message}]\n`;
}

function formatNoop(name: string, reason: string): string {
  return `[noop: ${name}: ${reason}]\n`;
}

function formatApplied(name: string, humanSummary: string): string {
  return `[applied: ${name}: ${humanSummary}]\n`;
}

/**
 * Dry-run only. Emits an "[applicable: ...]" header followed by
 * indented per-file diff blocks. Empty perFile emits only the header.
 * Trailing newline on unifiedDiff is normalized (one trailing "\n" is
 * stripped before indenting) so we do NOT emit a phantom indented
 * blank line at the end of each block.
 */
function formatApplicable(name: string, humanSummary: string, diff: PreviewDiff): string {
  const header = `[applicable: ${name}: ${humanSummary}]\n`;
  const diffBody = diff.perFile
    .map((f) => {
      const normalized = f.unifiedDiff.endsWith("\n") ? f.unifiedDiff.slice(0, -1) : f.unifiedDiff;
      const indented = normalized
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n");
      return `  ${f.pathRelative} (${f.opKind})\n${indented}\n`;
    })
    .join("");
  return `${header}${diffBody}`;
}

// ---------------------------------------------------------------------------
// Error classification.
// ---------------------------------------------------------------------------

/**
 * True iff the thrown value is a known adapter or installer error we
 * should format as a [refused] line. Checks AdapterError base plus
 * HookManagerIoError + MalformedPackageJsonError (which historically
 * extend Error directly rather than AdapterError; M G1b-followup will
 * unify them under AdapterError).
 */
function isKnownAdapterOrInstallerError(err: unknown): err is Error {
  return (
    err instanceof InstallerError ||
    err instanceof AdapterError ||
    err instanceof HookManagerIoError ||
    err instanceof MalformedPackageJsonError
  );
}

/**
 * Return err.name if it's non-empty and not the generic "Error"
 * fallback; otherwise fall back to err.constructor.name. Prevents
 * unset err.name from surfacing as "Error" in the [refused] line.
 */
function knownErrorName(err: Error): string {
  if (err.name.length > 0 && err.name !== "Error") return err.name;
  return err.constructor.name;
}

// ---------------------------------------------------------------------------
// InstallCommand
// ---------------------------------------------------------------------------

export class InstallCommand extends Command {
  static override paths = [["install"]];

  static override usage = Command.Usage({
    category: "Integrations",
    description: "Install VibeRevert integrations for one adapter or the safe set (--all)",
    details: `
      Selects an adapter (or the --all safe set: cursor, direct-hook,
      husky, lefthook, claude) and drives the detect -> plan -> apply
      pipeline through @viberevert/installers.

      Exactly one selector must be provided: one of the six per-adapter
      flags OR --all. --all iterates the five safe adapters in ship
      order. GitHub Action is excluded from --all because installing a
      CI workflow is an explicit intent.

      --dry-run prints "[applicable: ...]" with per-file unified diffs
      instead of writing. --force-reinstall flows into the engine's
      drift handling. --migrate-from-hook-install triggers a two-step
      Husky migration (Husky first, then direct-hook cleanup) but ONLY
      if the Husky plan itself signals a migration is needed.
    `,
    examples: [
      ["Install the Cursor MCP server", "viberevert install --cursor"],
      ["Install the safe set", "viberevert install --all"],
      ["Preview an install", "viberevert install --cursor --dry-run"],
      ["Migrate a direct hook to Husky", "viberevert install --husky --migrate-from-hook-install"],
    ],
  });

  cursor = Option.Boolean("--cursor", false, {
    description: "Install the Cursor integration (writes into <repo>/.cursor/mcp.json).",
  });

  direct = Option.Boolean("--direct", false, {
    description: "Install the direct-hook integration (writes .git/hooks/pre-commit).",
  });

  husky = Option.Boolean("--husky", false, {
    description: "Install the Husky integration (writes into .husky/pre-commit).",
  });

  lefthook = Option.Boolean("--lefthook", false, {
    description: "Install the Lefthook integration (writes into lefthook.yml).",
  });

  claude = Option.Boolean("--claude", false, {
    description: "Install the Claude Code integration (writes into <repo>/.mcp.json).",
  });

  githubAction = Option.Boolean("--github-action", false, {
    description: "Install the GitHub Action workflow (writes .github/workflows/viberevert.yml).",
  });

  all = Option.Boolean("--all", false, {
    description:
      "Install the safe adapter set (cursor + direct-hook + husky + lefthook + claude). GitHub Action is excluded.",
  });

  dryRun = Option.Boolean("--dry-run", false, {
    description: "Preview per-file diffs instead of writing. Exit 0 iff no adapter is refused.",
  });

  forceReinstall = Option.Boolean("--force-reinstall", false, {
    description:
      "Flow through to the installer engine as ctx.options.forceReinstall. Narrow scope.",
  });

  migrateFromHookInstall = Option.Boolean("--migrate-from-hook-install", false, {
    description:
      "Migrate an existing VibeRevert direct hook into Husky (only if Husky plan signals it). Requires --husky alone; incompatible with --dry-run.",
  });

  override async execute(): Promise<number> {
    return this.executeUnwrapped();
  }

  private async executeUnwrapped(): Promise<number> {
    // Step 0: flag validation (plain stderr, no brackets). Runs BEFORE
    // repo resolution so bad flag combinations fail even outside a
    // git repo.
    const validationError = this.validateFlags();
    if (validationError !== null) {
      this.context.stderr.write(`${validationError}\n`);
      return 1;
    }

    // Step 1: repo root. Plain stderr on failure (pre-iteration).
    let repoRoot: string;
    try {
      repoRoot = resolveRepoRoot();
    } catch (err) {
      if (err instanceof RepoRootNotFoundError) {
        this.context.stderr.write(`${err.message}\n`);
        return 1;
      }
      throw err;
    }

    // Step 2: adapter selection in ship order.
    const selection = this.buildSelection();

    // Step 3: adapter context.
    const now = new Date(resolveNowForCliTimestamp());
    const adapterCtx: AdapterContext = {
      repoRoot,
      now,
      cliVersion: CLI_VERSION,
      intent: this.all ? "all" : "explicit",
      options: {
        forceReinstall: this.forceReinstall,
        migrateFromHookInstall: this.migrateFromHookInstall,
        forceUninstall: false,
      },
    };

    // Step 4: per-adapter iteration.
    let hasRefusal = false;
    // Locked migration gate: only true when Husky's plan itself signals
    // that a direct-hook migration was identified. --migrate-from-
    // hook-install alone does NOT authorize direct-hook removal.
    let shouldCleanupMigratedDirectHook = false;
    const outcomeByFlag = new Map<AdapterFlag, InstallOutcome | PreviewOutcome>();

    for (const entry of selection) {
      const name = entry.adapter.name;

      // detect
      let detectResult: DetectResult;
      try {
        detectResult = await entry.adapter.detect(adapterCtx);
      } catch (err) {
        if (isKnownAdapterOrInstallerError(err)) {
          this.context.stdout.write(formatRefused(name, knownErrorName(err), err.message));
          hasRefusal = true;
          continue;
        }
        throw err;
      }

      if (!detectResult.detected) {
        this.context.stdout.write(formatSkipped(name, detectResult.reason));
        continue;
      }

      // plan
      let plan: AdapterPlan;
      try {
        plan = await entry.adapter.plan(adapterCtx);
      } catch (err) {
        if (isKnownAdapterOrInstallerError(err)) {
          this.context.stdout.write(formatRefused(name, knownErrorName(err), err.message));
          hasRefusal = true;
          continue;
        }
        throw err;
      }

      if (plan.status === "refused") {
        this.context.stdout.write(formatRefused(name, plan.reasonCode, plan.message));
        hasRefusal = true;
        continue;
      }

      // Capture Husky migration signal AT PLAN TIME. The applicable
      // plan is where meta.migrateFromDirectHook="true" is emitted by
      // the Husky adapter when it identifies a vr-managed direct hook
      // to migrate. Anything else (plan absent, husky adapter did not
      // set the meta, migration flag not passed) does NOT authorize
      // cleanup.
      if (
        entry.flag === "husky" &&
        plan.status === "applicable" &&
        // biome-ignore lint/complexity/useLiteralKeys: TS4111 requires bracket notation for index-signature access on JsonObject
        plan.meta["migrateFromDirectHook"] === "true"
      ) {
        shouldCleanupMigratedDirectHook = true;
      }

      // apply OR preview
      if (this.dryRun) {
        let outcome: PreviewOutcome;
        try {
          outcome = await preview(plan, adapterCtx);
        } catch (err) {
          if (err instanceof InstallerError) {
            this.context.stdout.write(formatRefused(name, knownErrorName(err), err.message));
            hasRefusal = true;
            continue;
          }
          throw err;
        }
        outcomeByFlag.set(entry.flag, outcome);
        if (outcome.status === "applicable") {
          this.context.stdout.write(formatApplicable(name, outcome.humanSummary, outcome.diff));
        } else if (outcome.status === "noop") {
          this.context.stdout.write(formatNoop(name, outcome.reason));
        } else {
          this.context.stdout.write(formatRefused(name, outcome.reasonCode, outcome.message));
          hasRefusal = true;
        }
      } else {
        let outcome: InstallOutcome;
        try {
          outcome = await apply(plan, adapterCtx);
        } catch (err) {
          if (err instanceof InstallerError) {
            this.context.stdout.write(formatRefused(name, knownErrorName(err), err.message));
            hasRefusal = true;
            continue;
          }
          throw err;
        }
        outcomeByFlag.set(entry.flag, outcome);
        if (outcome.status === "applied") {
          this.context.stdout.write(formatApplied(name, outcome.receipt.humanSummary));
        } else if (outcome.status === "noop") {
          this.context.stdout.write(formatNoop(name, outcome.reason));
        } else {
          this.context.stdout.write(formatRefused(name, outcome.reasonCode, outcome.message));
          hasRefusal = true;
        }
      }
    }

    // Step 5: migration choreography (apply-mode only; validation
    // rejected --dry-run + --migrate-from-hook-install upfront). Gate
    // requires BOTH the flag AND the plan-meta signal AND a valid
    // Husky record (applied/noop).
    if (this.migrateFromHookInstall && !this.dryRun && shouldCleanupMigratedDirectHook) {
      const huskyOutcome = outcomeByFlag.get("husky") as InstallOutcome | undefined;
      if (
        huskyOutcome !== undefined &&
        (huskyOutcome.status === "applied" || huskyOutcome.status === "noop")
      ) {
        const uninstallCtx: UninstallContext = {
          repoRoot,
          now,
          cliVersion: CLI_VERSION,
          options: { forceUninstall: false },
        };
        let cleanupOutcome: UninstallOutcome;
        try {
          cleanupOutcome = await uninstall("direct-hook", uninstallCtx);
        } catch (err) {
          if (err instanceof InstallerError) {
            this.context.stdout.write(
              formatRefused(DIRECT_HOOK_DISPLAY_NAME, knownErrorName(err), err.message),
            );
            return 1;
          }
          throw err;
        }
        if (cleanupOutcome.status === "uninstalled") {
          this.context.stdout.write(
            formatApplied(DIRECT_HOOK_DISPLAY_NAME, "removed migrated direct hook"),
          );
        } else if (cleanupOutcome.status === "refused") {
          this.context.stdout.write(
            formatRefused(
              DIRECT_HOOK_DISPLAY_NAME,
              cleanupOutcome.reasonCode,
              cleanupOutcome.message,
            ),
          );
          hasRefusal = true;
        }
        // "not-installed" -> no line (silent success).
      }
    }

    return hasRefusal ? 1 : 0;
  }

  private validateFlags(): string | null {
    const explicit: AdapterFlag[] = [];
    if (this.cursor) explicit.push("cursor");
    if (this.direct) explicit.push("direct");
    if (this.husky) explicit.push("husky");
    if (this.lefthook) explicit.push("lefthook");
    if (this.claude) explicit.push("claude");
    if (this.githubAction) explicit.push("github-action");

    if (this.all && explicit.length > 0) {
      const explicitList = explicit.map((f) => `--${f}`).join(", ");
      return `--all cannot be combined with explicit adapter flags (got: ${explicitList}). Choose either --all or a single adapter flag.`;
    }

    if (!this.all && explicit.length === 0) {
      return "No target adapter selected. Pass exactly one of --cursor, --claude, --direct, --husky, --lefthook, --github-action, or --all.";
    }
    if (explicit.length > 1) {
      const explicitList = explicit.map((f) => `--${f}`).join(", ");
      return `Multiple explicit adapter flags provided (${explicitList}). Choose exactly one adapter, or use --all to iterate the safe set.`;
    }

    if (this.migrateFromHookInstall) {
      if (this.all) {
        return "--migrate-from-hook-install cannot be combined with --all. It is a Husky-specific migration flag; use --husky --migrate-from-hook-install.";
      }
      if (explicit.length !== 1 || explicit[0] !== "husky") {
        return "--migrate-from-hook-install requires --husky alone. It orchestrates removal of a VibeRevert direct hook after Husky is recorded.";
      }
      if (this.dryRun) {
        return "--dry-run is incompatible with --migrate-from-hook-install. Migration cleanup is a mutating orchestration, not a preview-only operation.";
      }
    }

    return null;
  }

  private buildSelection(): AdapterMatrixEntry[] {
    if (this.all) {
      return ADAPTER_MATRIX.filter((entry) => entry.inAll);
    }
    return ADAPTER_MATRIX.filter((entry) => this.isFlagSet(entry.flag));
  }

  private isFlagSet(flag: AdapterFlag): boolean {
    switch (flag) {
      case "cursor":
        return this.cursor;
      case "direct":
        return this.direct;
      case "husky":
        return this.husky;
      case "lefthook":
        return this.lefthook;
      case "claude":
        return this.claude;
      case "github-action":
        return this.githubAction;
    }
  }
}
