// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Interception CONTRACT for `viberevert shell --pty` (M G4 Step 4a, D104.E/H/J/O).
 *
 * Contract-ONLY: pure types, constants, and the one branded-handle factory --
 * NO socket, NO shell hook, NO PTY wiring, NO shell.ts. Later slices build on
 * these: the parent-side policy service (4b), the shell capability matrix (4c),
 * the bash hook generator (4d), the interception-required PTY wiring (4e), the
 * public `--pty` dispatch (4f), and the audit + invariants + smoke (4g).
 *
 * --- The spine: interception-REQUIRED ---
 *
 * A shell line entered at the supported interactive prompt may EXECUTE only
 * after the parent receives a nonce-bound request over a PRIVATE per-session
 * side channel, evaluates policy, and explicitly returns `allow`. No valid
 * request/decision path -> FAIL CLOSED (block); never execute. This survives
 * any shell / PTY backend: no hook, no channel, no policy decision => no run.
 *
 * The engine may SPAWN only when it holds an `InstalledInterception` handle.
 * Only this module's branded factory can mint one, and production installation
 * obtains that factory through the real-bindings layer; the handle CARRIES the
 * exact spawn material (`shellStartup`), so a guarded-shell spawn spec is
 * inseparable from a genuine install. An unsupported shell, a hook-setup
 * failure, or a channel-setup failure produces NO handle -> no spawn. There is
 * NO observe-only / warn-only path anywhere in public `--pty`.
 *
 * --- Fail-closed taxonomy (one closed set, three surfaces) ---
 *
 * `InterceptionFailureReason` is the complete closed set. It splits into:
 *   INSTALL-time (prevent spawn entirely; no handle is minted) --
 *     `InterceptionInstallFailureReason`
 *       = unsupported_shell | hook_setup_failed | channel_setup_failed
 *   LIVE (a running session fails a command, fail-closed) --
 *     `InterceptionLiveFailureReason` = everything else
 *   DECISION (a normal parent-to-hook BLOCK carries only these) --
 *     `InterceptionDecisionBlockReason`
 *       = blocked_by_policy | policy_error | nonce_mismatch
 * `timeout` (the hook never received a reply), `malformed_request` (the parent
 * could not parse a request, so it may lack a valid `id` to echo), and
 * `malformed_decision` (the hook received a reply it could not validate --
 * wrong version / wrong `id` / bad shape) are LIVE failures but NOT normal
 * id-bearing decisions -- the hook fails closed locally. Every reason refuses.
 *
 * --- Policy mapping (PTY v1) ---
 *
 * The parent evaluates policy against the command text observed at the supported
 * shell's interception boundary as a single synthetic argv `[rawLine]` (D104.H).
 * In PTY v1, BOTH a guard match AND a require_confirm match produce
 * `blocked_by_policy`; a non-match produces `allow`. PTY v1 has NO interactive
 * confirm -- the guarded REPL remains the interactive-confirm path.
 *
 * --- Nonce posture (NOT a sandbox secret) ---
 *
 * The nonce is per-session and nonce-bound: it lets the parent reject accidental,
 * cross-session, or desynced traffic on the private channel. It is NOT a
 * sandbox-grade secret against the same interactive user or the child processes
 * they run -- see the scope caveat.
 *
 * --- Scope (headline honesty; not a sandbox) ---
 *
 * PTY interception guards prompt-level commands entered into the supported
 * interactive shell. It does NOT intercept commands run inside nested shells,
 * editors, REPLs, SSH sessions, tmux/screen, or child programs. It is a
 * best-effort prompt-level safety net, not a sandbox.
 *
 * --- Versioning ---
 *
 * Every request and decision carries `protocolVersion` (currently 1) so future
 * multiline / confirm / shell additions cannot silently desync an old hook.
 */

/** The interception wire-protocol version (bumped on any request/decision change). */
export const PTY_INTERCEPTION_PROTOCOL_VERSION = 1;

/**
 * How long the hook waits for the parent's decision before failing closed
 * (blocking the command). The parent replies near-instantly in-process; this is
 * the channel-failure safety bound, not a normal latency. Not env-configurable
 * in v1. Channel STARTUP may later need its own (different) timeout.
 */
export const PTY_INTERCEPTION_DECISION_TIMEOUT_MS = 5000;

/** The complete closed set of interception failure reasons (all fail closed). */
export type InterceptionFailureReason =
  | "unsupported_shell"
  | "hook_setup_failed"
  | "channel_setup_failed"
  | "nonce_mismatch"
  | "timeout"
  | "malformed_request"
  | "malformed_decision"
  | "policy_error"
  | "blocked_by_policy";

/** Install-time failures: no `InstalledInterception` is minted, so no spawn. */
export type InterceptionInstallFailureReason = Extract<
  InterceptionFailureReason,
  "unsupported_shell" | "hook_setup_failed" | "channel_setup_failed"
>;

/** Live-session failures: a running command fails closed (blocked). */
export type InterceptionLiveFailureReason = Exclude<
  InterceptionFailureReason,
  InterceptionInstallFailureReason
>;

/**
 * The reasons a NORMAL parent-to-hook BLOCK decision can carry. `timeout` (no
 * reply reached the hook), `malformed_request` (no valid `id` to echo), and
 * `malformed_decision` (the hook could not validate the reply) are live failures
 * but never normal id-bearing decisions.
 */
export type InterceptionDecisionBlockReason = Extract<
  InterceptionFailureReason,
  "blocked_by_policy" | "policy_error" | "nonce_mismatch"
>;

/** A nonce-bound request from the shell hook to the parent, per prompt line. */
export interface InterceptionRequest {
  readonly protocolVersion: typeof PTY_INTERCEPTION_PROTOCOL_VERSION;
  /** Per-session nonce; the parent validates it (4b). */
  readonly nonce: string;
  /** Per-request id; the decision echoes it -- a mismatch is desync -> fail closed. */
  readonly id: string;
  // Command text exposed by the supported shell at its pre-execution interception
  // boundary. For Bash v1 this is `$BASH_COMMAND` from the interactive DEBUG trap.
  // NOT shell-expanded by VibeRevert, NOT parsed by VibeRevert, and NOT a
  // child-process transcript.
  readonly rawLine: string;
}

/** The parent's verdict for one request: allow, or block with a decision reason. */
export type InterceptionDecision =
  | {
      readonly protocolVersion: typeof PTY_INTERCEPTION_PROTOCOL_VERSION;
      readonly id: string;
      readonly kind: "allow";
    }
  | {
      readonly protocolVersion: typeof PTY_INTERCEPTION_PROTOCOL_VERSION;
      readonly id: string;
      readonly kind: "block";
      readonly reason: InterceptionDecisionBlockReason;
    };

/** A reference to the private per-session side channel the hook connects to. */
export interface InterceptionChannelRef {
  // Opaque; interpreted ONLY by the matching channel/hook implementation (4b/4d),
  // never parsed by general code. The concrete transport (a nonce-bound
  // 127.0.0.1 loopback socket is the 4b candidate) is deferred; the contract only
  // requires it be PRIVATE + per-session.
  readonly endpoint: string;
}

/**
 * The exact, validated startup the engine must use to spawn the guarded PTY
 * shell. Carried INSIDE the branded handle (see `InstalledInterception`) so the
 * spawn material is inseparable from a genuinely-installed interception -- there
 * is no separate, forgeable way to obtain a guarded-shell spawn spec. For bash,
 * `args` invoke it with ONLY the private hook rc file
 * (`--noprofile --rcfile <rc> -i`): a clean guarded shell that loads NO user
 * profile/rc -- aliases, prompt customizations, shell plugins, and user startup
 * scripts are intentionally not loaded in v1. The `shellKind` discriminant
 * leaves room for future non-bash startup forms.
 */
export type InterceptionShellStartup = {
  readonly shellKind: "bash";
  readonly executable: string;
  readonly args: readonly string[];
};

// Brand: a REAL, module-PRIVATE Symbol (not exported). The factory stamps it
// onto the handle, so an InstalledInterception is an honest runtime artifact --
// and no other module can name the symbol, so createInstalledInterceptionHandle
// is the only producer (a 4g invariant confines its production import to the
// real-bindings layer).
const interceptionReadyBrand: unique symbol = Symbol("viberevert.pty.interception.ready");

/**
 * The opaque "interception is installed" handle. The PTY engine (4e) may spawn
 * ONLY when it holds one -- making "no interception => no spawn" a type-level
 * property (backstopped by the runtime pre-spawn refusal and a 4g invariant).
 * `shellStartup` is the SOLE carrier of the guarded-shell spawn material, so the
 * spawn spec is inseparable from a genuinely-installed interception. `shellKind`
 * stays narrow (`"bash"`) until PowerShell interception is proven.
 */
export interface InstalledInterception {
  readonly [interceptionReadyBrand]: true;
  readonly shellKind: "bash";
  readonly nonce: string;
  readonly channel: InterceptionChannelRef;
  readonly shellStartup: InterceptionShellStartup;
}

/**
 * Validate the EXACT guarded bash startup shape. The only supported discriminant
 * must invoke bash with precisely `--noprofile --rcfile <non-empty rcPath> -i`,
 * so no branded bash handle can carry an unguarded argument arrangement such as
 * a bare `-i`, an omitted/empty rc path, reordered flags, or extra args. The
 * installer is responsible for supplying the path returned by its OWN successful
 * hook materialization -- the factory validates the SHAPE, not that the path is
 * that specific materialized file. Positional checks also close the sparse-array
 * hole that `Array.prototype.every` would skip; a whitespace-only rc path is
 * rejected as unusable.
 */
function validateBashStartup(startup: InterceptionShellStartup): void {
  const { args } = startup;
  if (
    !Array.isArray(args) ||
    args.length !== 4 ||
    args[0] !== "--noprofile" ||
    args[1] !== "--rcfile" ||
    typeof args[2] !== "string" ||
    args[2].trim().length === 0 ||
    args[3] !== "-i"
  ) {
    throw new Error("InstalledInterception bash startup must be --noprofile --rcfile <rcPath> -i");
  }
}

/**
 * The SOLE producer of the branded handle -- and the validator/freezer of the
 * spawn material it carries. Production orchestration reaches it ONLY through the
 * 4e-iii real-bindings module, which imports it and injects it into the installer
 * (the installer itself never imports it); a 4g invariant confines the
 * real-factory import to that bindings module + tests. Validates the handle
 * fields at RUNTIME (non-blank nonce, non-blank transport-opaque channel
 * endpoint, an object startup that matches shellKind, non-blank executable) and,
 * for the bash discriminant, the EXACT guarded startup shape (`--noprofile
 * --rcfile <rcPath> -i`); a bad payload THROWS, so a stamp-time failure is
 * fail-closed -- never a handle carrying unusable or unguarded spawn material.
 * Copies + freezes every layer -- the channel, the startup payload, its args
 * array, and the handle itself -- so no caller-retained reference can mutate the
 * installed artifact afterward; the brand is stamped LAST so a future field
 * change cannot overwrite it. Runtime guards are deliberate: TS types do not
 * protect this factory from JavaScript callers or unsafe casts.
 */
export function createInstalledInterceptionHandle(fields: {
  shellKind: "bash";
  nonce: string;
  channel: InterceptionChannelRef;
  shellStartup: InterceptionShellStartup;
}): InstalledInterception {
  const { shellKind, nonce, channel, shellStartup } = fields;

  if (typeof nonce !== "string" || nonce.trim().length === 0) {
    throw new Error("InstalledInterception nonce must be a non-blank string");
  }
  if (typeof channel?.endpoint !== "string" || channel.endpoint.trim().length === 0) {
    throw new Error("InstalledInterception channel endpoint must be a non-blank string");
  }
  // Guard through an `unknown` view: a direct `shellStartup === null` would be a
  // TS "no overlap" error since the static type is non-null, but a JS caller can
  // still pass a non-object here.
  const rawStartup = shellStartup as unknown;
  if (typeof rawStartup !== "object" || rawStartup === null) {
    throw new Error("InstalledInterception shellStartup must be an object");
  }
  if (shellStartup.shellKind !== shellKind) {
    throw new Error("InstalledInterception shellStartup.shellKind must match shellKind");
  }
  if (typeof shellStartup.executable !== "string" || shellStartup.executable.trim().length === 0) {
    throw new Error("InstalledInterception shellStartup.executable must be a non-empty string");
  }
  validateBashStartup(shellStartup);

  const frozenChannel: InterceptionChannelRef = Object.freeze({ endpoint: channel.endpoint });
  const frozenStartup: InterceptionShellStartup = Object.freeze({
    shellKind: shellStartup.shellKind,
    executable: shellStartup.executable,
    args: Object.freeze([...shellStartup.args]),
  });
  const handle: InstalledInterception = {
    shellKind,
    nonce,
    channel: frozenChannel,
    shellStartup: frozenStartup,
    [interceptionReadyBrand]: true,
  };
  return Object.freeze(handle);
}

/**
 * The result of the shell capability matrix (the mapping fn is 4c). Posture:
 * bash supported; powershell / posix-non-bash / unknown refused -- never a
 * silent unguarded fallback. The refused shape carries the detected kind for
 * clearer diagnostics/tests.
 */
export type InterceptionShellSupport =
  | { readonly kind: "supported"; readonly shellKind: "bash" }
  | {
      readonly kind: "refused";
      readonly reason: "unsupported_shell";
      readonly detectedShellKind: string;
      readonly message: string;
    };
