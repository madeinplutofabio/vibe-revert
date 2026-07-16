// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { PTY_INTERCEPTION_PROTOCOL_VERSION } from "../src/commands/pty-interception.js";
import {
  type BashInterceptionHookParams,
  generateBashInterceptionHook,
} from "../src/commands/pty-interception-hook.js";

const OK = { nonce: "abc123NONCE_-", endpoint: "127.0.0.1:54321" } as const;

/** The default-timeout hook used by most structural assertions. */
const hook = generateBashInterceptionHook({ nonce: OK.nonce, endpoint: OK.endpoint });

describe("generateBashInterceptionHook — startup is fail-closed", () => {
  it("gates on Bash >= 4.1 as the very first statement", () => {
    expect(hook).toContain(
      "if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 1) )); then",
    );
    expect(hook.trimStart().startsWith("if (( BASH_VERSINFO[0] < 4")).toBe(true);
  });

  it("checks the Bash version before any dynamic-FD syntax is reached", () => {
    const gateIndex = hook.indexOf("BASH_VERSINFO");
    const fdIndex = hook.indexOf("exec {__vr_fd}<>");
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(fdIndex).toBeGreaterThan(gateIndex);
  });

  it("declares the injected constants readonly and fails closed on failure (default timeout 5)", () => {
    expect(hook).toContain(
      "readonly __viberevert_ic_nonce='abc123NONCE_-' __viberevert_ic_port='54321' __viberevert_ic_timeout='5' 2>/dev/null || exit 125",
    );
  });

  it("initialises the sequence and re-entrancy globals fail-closed", () => {
    expect(hook).toContain("__viberevert_ic_seq=0 || exit 125");
    expect(hook).toContain("__viberevert_ic_active= || exit 125");
  });

  it("clears the private helper namespace before defining any helper, fail-closed", () => {
    const unsetIndex = hook.indexOf(
      "unset -f __viberevert_ic_json_escape __viberevert_ic_is_tamper __viberevert_ic_debug_trap 2>/dev/null || exit 125",
    );
    const firstDefIndex = hook.indexOf("__viberevert_ic_json_escape() {");
    const freezeIndex = hook.indexOf("readonly -f ");
    expect(unsetIndex).toBeGreaterThanOrEqual(0);
    expect(unsetIndex).toBeLessThan(firstDefIndex);
    expect(unsetIndex).toBeLessThan(freezeIndex);
  });

  it("freezes the helper functions and fails closed if the freeze fails", () => {
    expect(hook).toContain(
      "readonly -f __viberevert_ic_json_escape __viberevert_ic_is_tamper __viberevert_ic_debug_trap 2>/dev/null || exit 125",
    );
  });

  it("never degrades a startup step to a non-fatal `|| true`", () => {
    expect(hook).not.toContain("|| true");
  });

  it("enables extdebug fail-closed, then installs the DEBUG trap as the final statement", () => {
    expect(hook).toContain("if ! shopt -s extdebug; then\n  exit 125\nfi");
    const extdebugIndex = hook.indexOf("shopt -s extdebug");
    const trapIndex = hook.indexOf("trap '__viberevert_ic_debug_trap' DEBUG || exit 125");
    expect(extdebugIndex).toBeGreaterThan(0);
    expect(trapIndex).toBeGreaterThan(extdebugIndex);
    expect(hook.trimEnd().endsWith("trap '__viberevert_ic_debug_trap' DEBUG || exit 125")).toBe(
      true,
    );
  });
});

describe("generateBashInterceptionHook — the decision is fail-closed", () => {
  it("defaults the per-command status to skip (1)", () => {
    expect(hook).toContain("local __vr_status=1");
  });

  it("guards on both helper functions being present", () => {
    expect(hook).toContain(
      "! declare -F __viberevert_ic_is_tamper >/dev/null 2>&1 || ! declare -F __viberevert_ic_json_escape >/dev/null 2>&1",
    );
  });

  it("guards on all three injected globals being present (nounset-safe)", () => {
    expect(hook).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS template literal
      "[[ -z ${__viberevert_ic_nonce-} || -z ${__viberevert_ic_port-} || -z ${__viberevert_ic_timeout-} ]]",
    );
  });

  it("guards re-entrancy and always resets the active flag before returning", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS template literal
    expect(hook).toContain("if [[ -n ${__viberevert_ic_active-} ]]; then\n    return 0\n  fi");
    expect(hook).toContain("__viberevert_ic_active=1");
    expect(hook).toContain('__viberevert_ic_active=\n  return "$__vr_status"');
  });

  it("checks self-tamper BEFORE opening the network channel", () => {
    const tamperIndex = hook.indexOf('__viberevert_ic_is_tamper "$__vr_line"');
    const networkIndex = hook.indexOf("exec {__vr_fd}<>");
    expect(tamperIndex).toBeGreaterThanOrEqual(0);
    expect(networkIndex).toBeGreaterThan(tamperIndex);
  });

  it("requires BOTH a successful read AND an exact allow match before running (status 0)", () => {
    // The request is written, then the reply read -- chained with && inside the
    // command substitution, so any write/read failure short-circuits to an empty
    // decision (fail-closed skip). The read uses the injected timeout.
    expect(hook).toContain('printf \'%s\\n\' "$__vr_request" >&"$__vr_fd" 2>/dev/null &&');
    expect(hook).toContain(
      'IFS= read -r -t "$__viberevert_ic_timeout" __vr_reply <&"$__vr_fd" 2>/dev/null &&',
    );
    // The captured decision must byte-match the expected allow before status 0.
    expect(hook).toContain("__vr_decision=$(");
    expect(hook).toContain('if [[ "$__vr_decision" == "$__vr_expected" ]]; then');
    expect(hook).toContain("__vr_status=0");
  });

  it("confines the channel FD to a subshell so it closes on exit (no prompt-corrupting `exec` close)", () => {
    // The round-trip runs inside a command substitution: the socket FD is opened
    // there and closed automatically when the subshell exits. There is NO
    // persistent `exec {fd}>&-` in the interactive shell -- `exec` fd ops in the
    // DEBUG trap corrupted readline and leaked descriptors (runtime regression:
    // pty-interception-hook-live.test.ts).
    const substIndex = hook.indexOf("__vr_decision=$(");
    const openIndex = hook.indexOf('exec {__vr_fd}<>"/dev/tcp/127.0.0.1/$__viberevert_ic_port"');
    expect(substIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeGreaterThan(substIndex);
    expect(hook).not.toContain("exec {__vr_fd}>&-");
  });

  it("dials the channel by validated port variable, never the raw endpoint string", () => {
    expect(hook).toContain('exec {__vr_fd}<>"/dev/tcp/127.0.0.1/$__viberevert_ic_port"');
    expect(hook).not.toContain("127.0.0.1:54321");
  });
});

describe("generateBashInterceptionHook — self-tamper hard-block patterns", () => {
  it.each([
    "(*__viberevert_ic*)",
    "(*trap*DEBUG*)",
    "(*'trap -'*)",
    "(*extdebug*)",
    "(*functrace*)",
    "(*'set +T'*)",
    "(*'enable -n'*)",
  ])("blocks the %s tamper case", (casePattern) => {
    expect(hook).toContain(`${casePattern} return 0 ;;`);
  });
});

describe("generateBashInterceptionHook — wire protocol from the shared constant", () => {
  it("builds the request and expected-allow frames at the shared protocol version", () => {
    const version = PTY_INTERCEPTION_PROTOCOL_VERSION;
    const requestFrame = `local __vr_request='{"protocolVersion":${version},"nonce":"'"$__viberevert_ic_nonce"'","id":"'"$__vr_id"'","rawLine":"'"$__vr_escaped"'","cwd":"'"$__vr_cwd"'"}'`;
    const expectedFrame = `local __vr_expected='{"protocolVersion":${version},"id":"'"$__vr_id"'","kind":"allow"}'`;
    expect(hook).toContain(requestFrame);
    expect(hook).toContain(expectedFrame);
  });

  it("emits the protocol version from the shared constant (no literal drift)", () => {
    expect(hook).toContain(`"protocolVersion":${PTY_INTERCEPTION_PROTOCOL_VERSION},`);
  });

  it("captures the prompt-time cwd through the SAME reviewed JSON escaper, nounset-safe", () => {
    // $PWD is bash's LOGICAL prompt-time cwd; it is escaped by the same reviewed
    // encoder as $BASH_COMMAND (a directory name may hold quotes, backslashes,
    // spaces, or newlines) and read nounset-safe.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS template literal
    expect(hook).toContain('__vr_cwd=$(__viberevert_ic_json_escape "${PWD-}" 2>/dev/null)');
    // Only the ESCAPED variable reaches the request JSON.
    expect(hook).toContain(`"cwd":"'"$__vr_cwd"'"`);
  });

  it("never interpolates a raw $PWD into the request JSON", () => {
    const start = hook.indexOf("local __vr_request=");
    expect(start).toBeGreaterThanOrEqual(0);
    const requestLine = hook.slice(start, hook.indexOf("\n", start));
    expect(requestLine).not.toContain("$PWD");
    expect(requestLine).toContain('"cwd":"\'"$__vr_cwd"\'"');
  });

  it("fails closed (skip) when EITHER the command or the cwd escape fails", () => {
    // Both escapes are chained with && inside ONE `if`, so a failure of either
    // leaves __vr_status at its skip default (1) and no request is ever sent.
    expect(hook).toContain(
      'if __vr_escaped=$(__viberevert_ic_json_escape "$__vr_line" 2>/dev/null) &&',
    );
  });

  it("derives the request id from the shell PID and monotonic sequence", () => {
    expect(hook).toContain('local __vr_id="$$-$__viberevert_ic_seq"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash arithmetic expansion, not a JS template literal
    expect(hook).toContain("__viberevert_ic_seq=$(( ${__viberevert_ic_seq:-0} + 1 ))");
  });
});

describe("generateBashInterceptionHook — JSON escaping", () => {
  const substitutionLines = hook
    .split("\n")
    .filter((line) => /^\s*__vr_s=\$\{__vr_s\/\//.test(line));
  const controlSubstitutionLines = substitutionLines.filter((line) =>
    /^\s*__vr_s=\$\{__vr_s\/\/\$'/.test(line),
  );

  it("emits exactly seven escape substitutions", () => {
    expect(substitutionLines).toHaveLength(7);
  });

  it("emits five ANSI-C control-char substitutions and two literal ones", () => {
    expect(controlSubstitutionLines).toHaveLength(5);
    expect(substitutionLines.length - controlSubstitutionLines.length).toBe(2);
  });

  it.each([
    "$'\\n'",
    "$'\\r'",
    "$'\\t'",
    "$'\\b'",
    "$'\\f'",
  ])("escapes the %s control character", (token) => {
    expect(hook).toContain(token);
  });

  it("escapes backslash and double-quote (the two non-control substitutions)", () => {
    expect(hook).toContain("//\\\\/"); // backslash pattern part
    expect(hook).toContain('//\\"/'); // double-quote pattern part
  });
});

describe("generateBashInterceptionHook — parameter validation", () => {
  it("defaults the read timeout to 5 seconds", () => {
    expect(hook).toContain("__viberevert_ic_timeout='5'");
  });

  it("accepts a fractional read timeout", () => {
    const fractional = generateBashInterceptionHook({
      nonce: OK.nonce,
      endpoint: OK.endpoint,
      readTimeoutSeconds: 0.5,
    });
    expect(fractional).toContain("__viberevert_ic_timeout='0.5'");
  });

  it("accepts a 256-char nonce and embeds it verbatim", () => {
    const nonce = "a".repeat(256);
    const generated = generateBashInterceptionHook({ nonce, endpoint: OK.endpoint });
    expect(generated).toContain(`__viberevert_ic_nonce='${nonce}'`);
  });

  it("rejects a 257-char nonce", () => {
    expect(() =>
      generateBashInterceptionHook({ nonce: "a".repeat(257), endpoint: OK.endpoint }),
    ).toThrow();
  });

  it.each([
    "",
    "$(x)",
    'a"b',
    "a b",
    "a/b",
    "a;b",
    "a.b",
    "a\\b",
  ])("rejects the unsafe nonce %j", (nonce) => {
    expect(() => generateBashInterceptionHook({ nonce, endpoint: OK.endpoint })).toThrow();
  });

  it.each([
    "localhost:54321",
    "127.0.0.1",
    "127.0.0.1:",
    "127.0.0.1:0",
    "127.0.0.1:70000",
    "0.0.0.0:54321",
    "::1:54321",
    "127.0.0.1:5a",
    "10.0.0.1:80",
  ])("rejects the unsafe endpoint %j", (endpoint) => {
    expect(() => generateBashInterceptionHook({ nonce: OK.nonce, endpoint })).toThrow();
  });

  it.each([
    0,
    -1,
    61,
    100,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e-7,
  ])("rejects the unsafe read timeout %p", (readTimeoutSeconds) => {
    const params: BashInterceptionHookParams = {
      nonce: OK.nonce,
      endpoint: OK.endpoint,
      readTimeoutSeconds,
    };
    expect(() => generateBashInterceptionHook(params)).toThrow();
  });
});
