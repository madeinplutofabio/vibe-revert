// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Bash interception HOOK generator (M G4 Step 4d, D104.E/O). Pure: emits the
 * nonce-bound bash `DEBUG`-trap script string; no spawn, no I/O. The mechanic
 * (validated interactively via node-pty in a real PTY, matching the intended
 * runtime environment; non-interactive Bash tests exhibit different DEBUG-trap
 * behaviour): `shopt -s extdebug` makes a DEBUG-trap function's non-zero return
 * SKIP the about-to-run command.
 *
 * Fail-closed by construction: the trap defaults to skip (status 1) and runs a
 * command (status 0) ONLY when the private loopback channel returns a decision
 * line byte-for-byte equal to the exact expected allow for that request id. Any
 * failure -- channel down, timeout, EOF, malformed/wrong-id/block frame, a
 * missing helper, a missing global, or a failed JSON escape -- leaves skip. The
 * whole SETUP is fail-closed too: an incompatible bash (< 4.1, no dynamic FDs),
 * or a failure to declare the readonly globals, clear the private helper
 * namespace, freeze the defined helpers, enable extdebug, or install the trap,
 * exits the shell (125) -- interception unavailable means no usable PTY shell.
 *
 * Self-tamper: direct prompt-level attempts matching the protected hook markers
 * (the private prefix, the DEBUG trap, extdebug/functrace, or disabling `trap`)
 * are hard-blocked LOCALLY before policy evaluation. This is a SAFETY NET, not a
 * sandbox: indirect evaluation (eval), sourced programs, nested/replacement
 * shells, and child processes remain outside the documented PTY interception
 * scope. The hook is nounset-safe (defaulted expansions). The nonce/endpoint/
 * timeout are validated and injected (never hard-coded); an unsafe value throws
 * -> no hook -> no InstalledInterception -> no spawn.
 */

import {
  PTY_INTERCEPTION_DECISION_TIMEOUT_MS,
  PTY_INTERCEPTION_PROTOCOL_VERSION,
} from "./pty-interception.js";

/** Injected parameters for the generated hook. */
export interface BashInterceptionHookParams {
  readonly nonce: string;
  readonly endpoint: string;
  readonly readTimeoutSeconds?: number;
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_NONCE_LENGTH = 256;
const ENDPOINT_PATTERN = /^127\.0\.0\.1:([0-9]+)$/;
const TIMEOUT_DECIMAL_PATTERN = /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/;
const DEFAULT_READ_TIMEOUT_SECONDS = PTY_INTERCEPTION_DECISION_TIMEOUT_MS / 1000;

/** Validate the nonce: 1..256 shell-safe chars (embeds in a single-quoted string). */
function validatedNonce(nonce: string): string {
  if (!NONCE_PATTERN.test(nonce) || nonce.length > MAX_NONCE_LENGTH) {
    throw new Error("interception hook nonce must be 1..256 chars matching [A-Za-z0-9_-]");
  }
  return nonce;
}

/** Parse+validate the endpoint into a loopback port (1..65535), rejecting anything else. */
function validatedPort(endpoint: string): string {
  const match = ENDPOINT_PATTERN.exec(endpoint);
  if (match === null) {
    throw new Error(`interception hook endpoint must be 127.0.0.1:<port>, got "${endpoint}"`);
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`interception hook endpoint port out of range: ${match[1]}`);
  }
  return String(port);
}

/**
 * Validate the read timeout: finite, in (0, 60], AND rendered as a plain decimal
 * (rejecting scientific notation like 1e-7 that would be shell-hostile).
 */
function validatedTimeoutSeconds(seconds: number): string {
  const rendered = String(seconds);
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 60 ||
    !TIMEOUT_DECIMAL_PATTERN.test(rendered)
  ) {
    throw new Error(
      `interception hook readTimeoutSeconds must be a plain decimal in (0, 60], got ${seconds}`,
    );
  }
  return rendered;
}

/**
 * Generate the bash interception hook rc-script. Byte-for-byte the pattern
 * validated interactively (Bash>=4.1 gate; readonly globals; private-helper
 * namespace cleared; helpers defined + frozen; fail-closed setup; function-return
 * DEBUG trap + re-entrancy flag; fail-closed decision; helper/global presence
 * guards; self-tamper hard-block). Throws on an unsafe nonce/endpoint/timeout.
 */
export function generateBashInterceptionHook(params: BashInterceptionHookParams): string {
  const nonce = validatedNonce(params.nonce);
  const port = validatedPort(params.endpoint);
  const timeout = validatedTimeoutSeconds(
    params.readTimeoutSeconds ?? DEFAULT_READ_TIMEOUT_SECONDS,
  );
  const protocolVersion = PTY_INTERCEPTION_PROTOCOL_VERSION;

  return `if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 1) )); then
  exit 125
fi
readonly __viberevert_ic_nonce='${nonce}' __viberevert_ic_port='${port}' __viberevert_ic_timeout='${timeout}' 2>/dev/null || exit 125
__viberevert_ic_seq=0 || exit 125
__viberevert_ic_active= || exit 125
unset -f __viberevert_ic_json_escape __viberevert_ic_is_tamper __viberevert_ic_debug_trap 2>/dev/null || exit 125

__viberevert_ic_json_escape() {
  local __vr_s=$1
  __vr_s=\${__vr_s//\\\\/\\\\\\\\}
  __vr_s=\${__vr_s//\\"/\\\\\\"}
  __vr_s=\${__vr_s//$'\\n'/\\\\n}
  __vr_s=\${__vr_s//$'\\r'/\\\\r}
  __vr_s=\${__vr_s//$'\\t'/\\\\t}
  __vr_s=\${__vr_s//$'\\b'/\\\\b}
  __vr_s=\${__vr_s//$'\\f'/\\\\f}
  printf '%s' "$__vr_s"
}

__viberevert_ic_is_tamper() {
  case $1 in
    (*__viberevert_ic*) return 0 ;;
    (*trap*DEBUG*) return 0 ;;
    (*'trap -'*) return 0 ;;
    (*extdebug*) return 0 ;;
    (*functrace*) return 0 ;;
    (*'set +T'*) return 0 ;;
    (*'enable -n'*) return 0 ;;
    (*) return 1 ;;
  esac
}

__viberevert_ic_debug_trap() {
  if [[ -n \${__viberevert_ic_active-} ]]; then
    return 0
  fi
  __viberevert_ic_active=1
  local __vr_status=1
  local __vr_line=$BASH_COMMAND
  if [[ -z $__vr_line ]]; then
    __vr_status=0
  elif ! declare -F __viberevert_ic_is_tamper >/dev/null 2>&1 || ! declare -F __viberevert_ic_json_escape >/dev/null 2>&1; then
    __vr_status=1
  elif [[ -z \${__viberevert_ic_nonce-} || -z \${__viberevert_ic_port-} || -z \${__viberevert_ic_timeout-} ]]; then
    __vr_status=1
  elif __viberevert_ic_is_tamper "$__vr_line"; then
    __vr_status=1
  else
    __viberevert_ic_seq=$(( \${__viberevert_ic_seq:-0} + 1 ))
    local __vr_id="$$-$__viberevert_ic_seq"
    local __vr_escaped
    if __vr_escaped=$(__viberevert_ic_json_escape "$__vr_line" 2>/dev/null); then
      local __vr_request='{"protocolVersion":${protocolVersion},"nonce":"'"$__viberevert_ic_nonce"'","id":"'"$__vr_id"'","rawLine":"'"$__vr_escaped"'"}'
      local __vr_expected='{"protocolVersion":${protocolVersion},"id":"'"$__vr_id"'","kind":"allow"}'
      local __vr_fd
      local __vr_decision=
      if exec {__vr_fd}<>"/dev/tcp/127.0.0.1/$__viberevert_ic_port" 2>/dev/null; then
        if printf '%s\\n' "$__vr_request" >&"$__vr_fd" 2>/dev/null && IFS= read -r -t "$__viberevert_ic_timeout" __vr_decision <&"$__vr_fd" 2>/dev/null && [[ "$__vr_decision" == "$__vr_expected" ]]; then
          __vr_status=0
        fi
        exec {__vr_fd}>&- 2>/dev/null
      fi
    fi
  fi
  __viberevert_ic_active=
  return "$__vr_status"
}

readonly -f __viberevert_ic_json_escape __viberevert_ic_is_tamper __viberevert_ic_debug_trap 2>/dev/null || exit 125
if ! shopt -s extdebug; then
  exit 125
fi
trap '__viberevert_ic_debug_trap' DEBUG || exit 125
`;
}
