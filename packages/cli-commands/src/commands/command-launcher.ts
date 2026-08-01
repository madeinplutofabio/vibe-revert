// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Command launch-plan builder (M H11.1, ADR 0005 — "Resolve-then-launch
 * command resolution with bounded Windows shim mediation").
 *
 * Given an ALREADY-RESOLVED command target (the caller resolves it, e.g. via
 * `executable-probe.ts`), a platform, and — for `.cmd` mediation — a
 * caller-validated `cmd.exe` `ComSpec`, this PURE module decides how the target
 * should be launched and returns a structured launch PLAN. It is
 * launch-PLANNING ONLY and deliberately does NOT (ADR 0005 Decision 2): spawn,
 * forward signals, handle Ctrl+C, kill/scope process trees, translate exit
 * status, emit CLI text, hold `run` session logic, or touch the
 * filesystem/environment. Those belong to a production caller or a later
 * execution seam, after the H11.1 spike proves the candidate below.
 *
 * Two plan kinds:
 *   - `direct`      — spawn the resolved native executable directly with
 *                     `shell: false` (POSIX always; Windows `.exe`/`.com`).
 *   - `windows-cmd` — a resolved `.cmd` is not a directly spawnable native
 *                     executable, so it is launched through `cmd.exe` (a
 *                     caller-resolved `ComSpec`) with `windowsVerbatimArguments:
 *                     true`, so Node performs NO Windows argument quoting and
 *                     this builder owns the ENTIRE `cmd.exe` command line.
 *
 * H11.1 CANDIDATE STATUS. Nothing here is validated yet. The `cmd.exe`
 * invocation form and the argument encoder are CANDIDATES evaluated by the
 * H11.1 Windows spike (File 4). No production caller may use a plan from this
 * module until that suite passes. Prior art was surveyed only as reference —
 * cross-spawn's `escapeArgument`/`escapeCommand`, Node's own cmd-shell
 * command-line construction, and Rust's post-CVE-2024-24576 batch handling with
 * its conservative rejection conditions — and this remains a narrow, auditable
 * local implementation, not inherited proof of safety.
 *
 * CANDIDATE ENCODER (conservative). `cmd.exe` interprets `"`, `%`, and `!` in
 * ways this first candidate does not attempt to support (quote toggling,
 * environment expansion, delayed expansion), and command lines cannot carry
 * NUL/CR/LF. This candidate REJECTS any value containing those characters with
 * a structured `unsafe-windows-cmd-argument` result. Every other value falls
 * within the candidate's accepted subset and is quote-wrapped (trailing
 * backslashes doubled so the closing quote is not consumed by a child's
 * `CommandLineToArgvW` reconstruction). The candidate invocation additionally
 * sets `/v:off` so delayed expansion is deterministically disabled rather than
 * inherited (defense in depth alongside the `!` rejection). An `ok` result
 * means only that the value is within the accepted subset — NOT that the
 * construction is proven; File 4 must establish argument fidelity and the
 * absence of any command execution outside the intended fixture before
 * production use. Relaxing any rejection is a later, separately-proven
 * refinement, never a silent best-effort.
 */

import { posix as posixPath, win32 as winPath } from "node:path";

/** Windows extensions treated as directly spawnable native executables. */
const WINDOWS_NATIVE_EXTS = new Set([".exe", ".com"]);

/** Metacharacters the candidate encoder rejects (see CANDIDATE ENCODER). */
const CMD_REJECTED_METACHARS = new Set(['"', "%", "!"]);

/**
 * What a resolved Windows target is, so callers/tests get structured
 * classification instead of a stringly-typed extension. v1 launches `native`
 * directly and mediates `cmd-shim`; every other kind is `unsupported-target`.
 */
export type ResolvedTargetKind =
  | "native"
  | "cmd-shim"
  | "batch-file"
  | "powershell-script"
  | "script"
  | "extensionless"
  | "unknown";

export type CommandLaunchPlan =
  | {
      readonly kind: "direct";
      readonly strategy: "direct-v1";
      readonly command: string;
      readonly args: readonly string[];
      readonly shell: false;
      readonly requestedCommand: string;
      readonly resolvedTarget: string;
    }
  | {
      readonly kind: "windows-cmd";
      readonly strategy: "windows-cmd-bounded-v1";
      /** Caller-resolved `cmd.exe` `ComSpec` path. */
      readonly command: string;
      /** `["/d","/v:off","/s","/c", <candidate command line>]` — evaluated by the H11.1 spike. */
      readonly args: readonly string[];
      readonly shell: false;
      /** REQUIRED: Node must not re-quote a command line this builder already escaped. */
      readonly windowsVerbatimArguments: true;
      readonly requestedCommand: string;
      /** Resolved `.cmd` path. */
      readonly resolvedTarget: string;
      /** Load-bearing properties of this strategy, made explicit (not comment-only). */
      readonly assumptions: {
        /** `cmd /d` skips AutoRun. */
        readonly autoRunDisabled: true;
        /** `cmd /v:off` disables delayed expansion. */
        readonly delayedExpansionDisabled: true;
        /** `windowsVerbatimArguments: true` disables Node's Windows quoting. */
        readonly nodeArgumentQuotingDisabled: true;
      };
    };

export type CommandLaunchPlanError =
  | {
      readonly error: "invalid-requested-command";
      readonly reason: "empty" | "contains-control-character";
    }
  | { readonly error: "command-not-found"; readonly requestedCommand: string }
  | {
      readonly error: "invalid-resolved-target";
      readonly resolvedTarget: string;
      readonly reason: "empty" | "not-absolute" | "contains-control-character";
    }
  | {
      readonly error: "invalid-argument";
      readonly argumentIndex: number;
      readonly reason: "contains-nul";
    }
  | {
      readonly error: "unsupported-target";
      readonly resolvedTarget: string;
      readonly targetKind: ResolvedTargetKind;
    }
  | { readonly error: "comspec-not-found" }
  | {
      readonly error: "invalid-comspec";
      readonly resolvedComSpec: string;
      readonly reason: "not-absolute" | "contains-control-character" | "unsupported-interpreter";
    }
  | {
      readonly error: "unsafe-windows-cmd-argument";
      readonly subject: "target" | "argument";
      readonly argumentIndex?: number;
      readonly rejectedCodePoint: number;
    };

export type CommandLaunchPlanResult =
  | { readonly ok: true; readonly plan: CommandLaunchPlan }
  | ({ readonly ok: false } & CommandLaunchPlanError);

/** Inputs for the pure builder. Target resolution + ComSpec discovery are the caller's. */
export interface BuildCommandLaunchPlanInput {
  /** Usually `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** The EXACT resolved target path, or `null` if the caller's resolver found nothing. */
  readonly resolvedTarget: string | null;
  /** The original requested command name. */
  readonly requestedCommand: string;
  /** Child arguments, verbatim. */
  readonly args: readonly string[];
  /**
   * Absolute path to a caller-resolved and filesystem-validated `cmd.exe`.
   * Required only for `.cmd` mediation.
   */
  readonly resolvedComSpec?: string | null;
}

/**
 * PURE launch-plan builder: platform + resolved target + args (+ resolved
 * ComSpec for `.cmd`) → a `CommandLaunchPlanResult`. No filesystem access, no
 * environment access, no spawning.
 */
export function buildCommandLaunchPlan(
  input: BuildCommandLaunchPlanInput,
): CommandLaunchPlanResult {
  const { platform, resolvedTarget, requestedCommand, args } = input;

  // 1. Validate the original request before anything else.
  const requestedReason = checkRequestedCommand(requestedCommand);
  if (requestedReason !== null) {
    return { ok: false, error: "invalid-requested-command", reason: requestedReason };
  }

  // 2. Resolution outcome.
  if (resolvedTarget === null) {
    return { ok: false, error: "command-not-found", requestedCommand };
  }

  // 3. Resolved-target invariants ("resolve before launch" must stay absolute).
  const invariant = checkResolvedTargetInvariants(platform, resolvedTarget);
  if (invariant !== null) {
    return { ok: false, error: "invalid-resolved-target", resolvedTarget, reason: invariant };
  }

  // 4. Reject NUL in any argument (universally impossible for spawn) before
  //    selecting a launch strategy. CR/LF stay valid for direct launches and
  //    are rejected only on the `.cmd` path by the candidate encoder.
  const nulArgumentIndex = firstArgumentContainingNul(args);
  if (nulArgumentIndex !== null) {
    return {
      ok: false,
      error: "invalid-argument",
      argumentIndex: nulArgumentIndex,
      reason: "contains-nul",
    };
  }

  // 5. Classify + build.
  const targetKind = classifyResolvedTarget(platform, resolvedTarget);
  if (targetKind === "native") {
    return { ok: true, plan: buildDirectLaunchPlan(requestedCommand, resolvedTarget, args) };
  }
  if (targetKind === "cmd-shim") {
    return buildWindowsCmdLaunchPlan(input, resolvedTarget);
  }
  return { ok: false, error: "unsupported-target", resolvedTarget, targetKind };
}

function checkRequestedCommand(
  requestedCommand: string,
): "empty" | "contains-control-character" | null {
  if (requestedCommand.length === 0) {
    return "empty";
  }
  if (containsControlCharacter(requestedCommand)) {
    return "contains-control-character";
  }
  return null;
}

/**
 * "Resolve before launch" must not silently regress into OS re-resolution, so a
 * resolved target must be a non-empty, control-character-free, absolute path.
 */
function checkResolvedTargetInvariants(
  platform: NodeJS.Platform,
  resolvedTarget: string,
): "empty" | "not-absolute" | "contains-control-character" | null {
  if (resolvedTarget.length === 0) {
    return "empty";
  }
  if (containsControlCharacter(resolvedTarget)) {
    return "contains-control-character";
  }
  const pathApi = platform === "win32" ? winPath : posixPath;
  if (!pathApi.isAbsolute(resolvedTarget)) {
    return "not-absolute";
  }
  return null;
}

/**
 * Classify a resolved target. POSIX targets are always `native` (spawned
 * directly). Windows classifies by extension; v1 launches `native` and mediates
 * `cmd-shim`, and returns a specific kind for everything else so support can be
 * added later without changing existing outcomes.
 */
function classifyResolvedTarget(
  platform: NodeJS.Platform,
  resolvedTarget: string,
): ResolvedTargetKind {
  if (platform !== "win32") {
    return "native";
  }
  const ext = winPath.extname(resolvedTarget).toLowerCase();
  if (WINDOWS_NATIVE_EXTS.has(ext)) {
    return "native";
  }
  switch (ext) {
    case ".cmd":
      return "cmd-shim";
    case ".bat":
      return "batch-file";
    case ".ps1":
      return "powershell-script";
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".py":
    case ".rb":
    case ".pl":
    case ".sh":
    case ".vbs":
      return "script";
    case "":
      return "extensionless";
    default:
      return "unknown";
  }
}

function buildDirectLaunchPlan(
  requestedCommand: string,
  resolvedTarget: string,
  args: readonly string[],
): CommandLaunchPlan {
  return {
    kind: "direct",
    strategy: "direct-v1",
    command: resolvedTarget,
    args: [...args],
    shell: false,
    requestedCommand,
    resolvedTarget,
  };
}

function buildWindowsCmdLaunchPlan(
  input: BuildCommandLaunchPlanInput,
  resolvedTarget: string,
): CommandLaunchPlanResult {
  const resolvedComSpec = input.resolvedComSpec ?? null;
  if (resolvedComSpec === null || resolvedComSpec.length === 0) {
    return { ok: false, error: "comspec-not-found" };
  }
  if (containsControlCharacter(resolvedComSpec)) {
    return {
      ok: false,
      error: "invalid-comspec",
      resolvedComSpec,
      reason: "contains-control-character",
    };
  }
  if (!winPath.isAbsolute(resolvedComSpec)) {
    return { ok: false, error: "invalid-comspec", resolvedComSpec, reason: "not-absolute" };
  }
  // This builder implements `cmd.exe` grammar specifically; another interpreter
  // (powershell.exe, command.com, a third-party .exe) does not share `/d /v:off
  // /s /c` or this quoting model, so require cmd.exe by basename.
  if (winPath.basename(resolvedComSpec).toLowerCase() !== "cmd.exe") {
    return {
      ok: false,
      error: "invalid-comspec",
      resolvedComSpec,
      reason: "unsupported-interpreter",
    };
  }

  const encoded = encodeCmdCommandLine(resolvedTarget, input.args);
  if (!encoded.ok) {
    return encoded.subject === "argument"
      ? {
          ok: false,
          error: "unsafe-windows-cmd-argument",
          subject: "argument",
          argumentIndex: encoded.argumentIndex,
          rejectedCodePoint: encoded.rejectedCodePoint,
        }
      : {
          ok: false,
          error: "unsafe-windows-cmd-argument",
          subject: "target",
          rejectedCodePoint: encoded.rejectedCodePoint,
        };
  }

  return {
    ok: true,
    plan: {
      kind: "windows-cmd",
      strategy: "windows-cmd-bounded-v1",
      command: resolvedComSpec,
      // H11.1 candidate under test. The Windows spike determines whether this
      // flag set and outer-quote form satisfy ADR 0005.
      args: ["/d", "/v:off", "/s", "/c", `"${encoded.commandLine}"`],
      shell: false,
      windowsVerbatimArguments: true,
      requestedCommand: input.requestedCommand,
      resolvedTarget,
      assumptions: {
        autoRunDisabled: true,
        delayedExpansionDisabled: true,
        nodeArgumentQuotingDisabled: true,
      },
    },
  };
}

type EncodeResult =
  | { readonly ok: true; readonly commandLine: string }
  | { readonly ok: false; readonly subject: "target"; readonly rejectedCodePoint: number }
  | {
      readonly ok: false;
      readonly subject: "argument";
      readonly argumentIndex: number;
      readonly rejectedCodePoint: number;
    };

/**
 * Build the candidate `cmd.exe` command line for `<target> <args...>`, or reject
 * the first value outside the accepted subset. Returns the INNER command line
 * (WITHOUT the outer `/s` quote pair, which the plan adds).
 */
function encodeCmdCommandLine(target: string, args: readonly string[]): EncodeResult {
  const targetRejected = firstUnsafeCmdCodePoint(target);
  if (targetRejected !== null) {
    return { ok: false, subject: "target", rejectedCodePoint: targetRejected };
  }
  const parts = [quoteForCmd(target)];
  for (const [argumentIndex, arg] of args.entries()) {
    const rejectedCodePoint = firstUnsafeCmdCodePoint(arg);
    if (rejectedCodePoint !== null) {
      return { ok: false, subject: "argument", argumentIndex, rejectedCodePoint };
    }
    parts.push(quoteForCmd(arg));
  }
  return { ok: true, commandLine: parts.join(" ") };
}

/** The code point of the first character outside the accepted subset, or null. */
function firstUnsafeCmdCodePoint(value: string): number | null {
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x00 || cp === 0x0d || cp === 0x0a || CMD_REJECTED_METACHARS.has(ch)) {
      return cp;
    }
  }
  return null;
}

/**
 * Quote an already-validated value (no rejected characters) for the candidate
 * `cmd.exe` command line: double-quoted with trailing backslashes doubled so the
 * closing quote is not consumed by a child's `CommandLineToArgvW` reconstruction.
 */
function quoteForCmd(value: string): string {
  const withDoubledTrailingBackslashes = value.replace(/(\\+)$/, "$1$1");
  return `"${withDoubledTrailingBackslashes}"`;
}

/** True if `value` contains NUL, CR, or LF. */
function containsControlCharacter(value: string): boolean {
  return value.includes("\0") || value.includes("\r") || value.includes("\n");
}

/** Index of the first argument containing NUL, or null. */
function firstArgumentContainingNul(args: readonly string[]): number | null {
  for (const [i, arg] of args.entries()) {
    if (arg.includes("\0")) {
      return i;
    }
  }
  return null;
}
