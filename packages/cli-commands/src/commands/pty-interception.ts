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
 * The engine may SPAWN only when it holds an `InstalledInterception` handle,
 * which only the installer can mint (branded; see below). An unsupported shell,
 * a hook-setup failure, or a channel-setup failure produces NO handle -> no
 * spawn. There is NO observe-only / warn-only path anywhere in public `--pty`.
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
 * The parent evaluates policy against the raw prompt line as a single synthetic
 * argv `[rawLine]` (D104.H). In PTY v1, BOTH a guard match AND a require_confirm
 * match produce `blocked_by_policy`; a non-match produces `allow`. PTY v1 has NO
 * interactive confirm -- the guarded REPL remains the interactive-confirm path.
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
  // Exact prompt line observed by the supported shell hook before execution.
  // NOT shell-expanded, NOT parsed by VibeRevert, NOT a child-process transcript.
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

// Brand: a REAL, module-PRIVATE Symbol (not exported). The factory stamps it
// onto the handle, so an InstalledInterception is an honest runtime artifact --
// and no other module can name the symbol, so createInstalledInterceptionHandle
// is the only producer (a 4g invariant confines its production callers to the
// installer).
const interceptionReadyBrand: unique symbol = Symbol("viberevert.pty.interception.ready");

/**
 * The opaque "interception is installed" handle. The PTY engine (4e) may spawn
 * ONLY when it holds one -- making "no interception => no spawn" a type-level
 * property (backstopped by the runtime pre-spawn refusal and a 4g invariant).
 * `shellKind` stays narrow (`"bash"`) until PowerShell interception is proven.
 */
export interface InstalledInterception {
  readonly [interceptionReadyBrand]: true;
  readonly shellKind: "bash";
  readonly nonce: string;
  readonly channel: InterceptionChannelRef;
}

/**
 * The SOLE producer of the branded handle. Production callers: the installer
 * (4d) only, after a real, successful hook + channel install (this contract's
 * unit test also calls it). Barrel-guarded (internal); a 4g invariant confines
 * production callers to the installer. The brand is stamped LAST so a future
 * field change cannot accidentally overwrite it.
 */
export function createInstalledInterceptionHandle(fields: {
  shellKind: "bash";
  nonce: string;
  channel: InterceptionChannelRef;
}): InstalledInterception {
  return { ...fields, [interceptionReadyBrand]: true };
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
