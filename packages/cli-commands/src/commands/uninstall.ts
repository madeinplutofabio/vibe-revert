// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * `viberevert uninstall` command -- removes VibeRevert integrations
 * for one adapter or the safe set (--all). Analogous to install but
 * recordKey-driven: no detect/plan phase, no dry-run, no migration.
 *
 * === Command surface (M G1b Step 6) ===
 *
 * viberevert uninstall
 *   [--cursor | --claude | --direct | --husky | --lefthook | --github-action | --all]
 *   [--force]
 *
 * Locked flag rules:
 *   1. Exactly one of the 7 target selectors must be present.
 *   2. --all excludes github-action (symmetric with install).
 *   3. --force sets ctx.options.forceUninstall (D101.B narrow scope:
 *      overrides content-drift refusals only; does NOT bypass locks,
 *      journals, or structural refusals).
 *
 * === Output vocabulary (3 categories) ===
 *
 *   [uninstalled: <name>: <humanSummary>]     status="uninstalled"
 *   [noop:        <name>: <reason>]           status="not-installed"
 *   [refused:     <name>: <code>: <message>]  status="refused" OR thrown InstallerError
 *
 * There is NO [applied], [applicable], or [skipped] category in
 * uninstall -- those are install-specific. Uninstall has no detect
 * phase; a missing record IS a noop (nothing to remove).
 *
 * === Exit code discipline ===
 *
 * 0 iff no [refused] line was emitted. 1 otherwise. Loop CONTINUES
 * across all selected adapters on both refused outcomes AND known
 * thrown InstallerError. Unknown errors STOP the loop immediately
 * (rethrown; later adapters not attempted).
 *
 * === Error handling ===
 *
 * Known InstallerError throws format as [refused: <name>: <err.name>:
 * <err.message>] via knownErrorName(). RepoRootNotFoundError is plain
 * stderr (pre-iteration). Unknown errors are RETHROWN.
 *
 * === No installer-record access ===
 *
 * This command does NOT read .viberevert/integrations.json. The engine
 * returns UninstallOutcome status="not-installed" if no record exists;
 * we format that as [noop] using the engine's own reason string
 * verbatim -- the CLI does not invent messages.
 *
 * === Display name discipline ===
 *
 * Display names come from the local ADAPTER_MATRIX (via
 * entry.adapter.name), NOT from outcome fields or flag strings. This
 * keeps CLI text stable even if UninstallReceipt.adapterName drifts.
 * RecordKey dispatch also comes from the matrix; the --direct/
 * direct-hook mapping is anchored in one place.
 */

import {
  type Adapter,
  claudeAdapter,
  cursorAdapter,
  directHookAdapter,
  githubActionAdapter,
  huskyAdapter,
  lefthookAdapter,
} from "@viberevert/adapters";
import { RepoRootNotFoundError, resolveRepoRoot } from "@viberevert/core";
import {
  InstallerError,
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
// Adapter matrix -- narrative ship order. DUPLICATED LOCALLY per 6B lock
// (no cross-command coupling with install.ts; extract-to-shared happens
// later once both commands stabilize).
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

// ---------------------------------------------------------------------------
// Output formatters -- byte-exact, LF-terminated per line.
// ---------------------------------------------------------------------------

function formatUninstalled(name: string, humanSummary: string): string {
  return `[uninstalled: ${name}: ${humanSummary}]\n`;
}

function formatNoop(name: string, reason: string): string {
  return `[noop: ${name}: ${reason}]\n`;
}

function formatRefused(name: string, code: string, message: string): string {
  return `[refused: ${name}: ${code}: ${message}]\n`;
}

// ---------------------------------------------------------------------------
// Error classification. Uninstall touches only the installer engine,
// so only InstallerError needs the classifier here (unlike install,
// which also handles adapter-side errors from detect/plan).
// ---------------------------------------------------------------------------

/**
 * Return err.name if non-empty and not the generic "Error" fallback;
 * otherwise fall back to err.constructor.name. Mirrors install.ts's
 * helper; duplicated locally per no-cross-command-coupling lock.
 */
function knownErrorName(err: Error): string {
  if (err.name.length > 0 && err.name !== "Error") return err.name;
  return err.constructor.name;
}

// ---------------------------------------------------------------------------
// UninstallCommand
// ---------------------------------------------------------------------------

export class UninstallCommand extends Command {
  static override paths = [["uninstall"]];

  static override usage = Command.Usage({
    category: "Integrations",
    description: "Uninstall VibeRevert integrations for one adapter or the safe set (--all)",
    details: `
      Removes VibeRevert integrations recorded in
      .viberevert/integrations.json for the selected adapter(s).

      Exactly one selector must be provided: one of the six per-adapter
      flags OR --all. --all iterates the five safe adapters in ship
      order (cursor, direct-hook, husky, lefthook, claude); GitHub
      Action is excluded from --all (explicit-only, symmetric with
      install).

      --force overrides content-drift refusals (D101.B narrow scope:
      does NOT bypass locks, journals, or structural refusals).
    `,
    examples: [
      ["Uninstall the Cursor integration", "viberevert uninstall --cursor"],
      ["Uninstall the safe set", "viberevert uninstall --all"],
      ["Force uninstall a drifted integration", "viberevert uninstall --cursor --force"],
    ],
  });

  cursor = Option.Boolean("--cursor", false, {
    description: "Uninstall the Cursor integration.",
  });

  direct = Option.Boolean("--direct", false, {
    description: "Uninstall the direct-hook integration.",
  });

  husky = Option.Boolean("--husky", false, {
    description: "Uninstall the Husky integration.",
  });

  lefthook = Option.Boolean("--lefthook", false, {
    description: "Uninstall the Lefthook integration.",
  });

  claude = Option.Boolean("--claude", false, {
    description: "Uninstall the Claude Code integration.",
  });

  githubAction = Option.Boolean("--github-action", false, {
    description: "Uninstall the GitHub Action workflow. Not included in --all; explicit only.",
  });

  all = Option.Boolean("--all", false, {
    description: "Uninstall the safe adapter set. GitHub Action is excluded.",
  });

  force = Option.Boolean("--force", false, {
    description:
      "Override content-drift refusals (narrow scope; does NOT bypass locks or journals).",
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

    // Step 3: uninstall context.
    const now = new Date(resolveNowForCliTimestamp());
    const uninstallCtx: UninstallContext = {
      repoRoot,
      now,
      cliVersion: CLI_VERSION,
      options: { forceUninstall: this.force },
    };

    // Step 4: per-adapter iteration. Continues on refused/known-error;
    // rethrows on unknown errors (stops immediately).
    let hasRefusal = false;

    for (const entry of selection) {
      const name = entry.adapter.name;

      let outcome: UninstallOutcome;
      try {
        outcome = await uninstall(entry.recordKey, uninstallCtx);
      } catch (err) {
        if (err instanceof InstallerError) {
          this.context.stdout.write(formatRefused(name, knownErrorName(err), err.message));
          hasRefusal = true;
          continue;
        }
        throw err;
      }

      if (outcome.status === "uninstalled") {
        this.context.stdout.write(formatUninstalled(name, outcome.receipt.humanSummary));
      } else if (outcome.status === "not-installed") {
        this.context.stdout.write(formatNoop(name, outcome.reason));
      } else {
        // "refused"
        this.context.stdout.write(formatRefused(name, outcome.reasonCode, outcome.message));
        hasRefusal = true;
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
