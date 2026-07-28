# ADR 0004: Best-effort, fail-closed PTY interception

- Status: Accepted — 2026-07-28 (records a decision shipped in Milestone G4)
- Milestone: G4 (shell --pty); characterized in H1; recorded in H8.4
- Related: [PTY contract](../pty-contract.md), [shell contract](../shell-contract.md), [compatibility](../compatibility.md); `packages/cli-commands/src/commands/pty-loader.ts`

## Context

`viberevert shell` (no flag) is a plain guarded command loop: it checks each
command typed at its own prompt. Some workflows instead need a real interactive
terminal — a raw Bash session, or an agent that drives one — where commands are
entered at Bash's own prompt rather than VibeRevert's loop.

Guarding commands typed at a real shell prompt, without becoming a sandbox, is a
constrained problem. Fully mediating what a shell and its children do would
require sandboxing or syscall interception: heavy, platform-specific machinery
that is out of scope for a local developer tool. The design question was how much
to attempt, and how to behave at the edges of what is attempted.

## Decisions

### 1. Intercept at the interactive prompt boundary

`shell --pty` runs a real Bash session in a pseudo-terminal and intercepts
commands at Bash's interactive prompt boundary: before Bash runs a command
submitted at that prompt, a hook reports it to the VibeRevert parent, which
evaluates the same configured `commands.guard` and `commands.require_confirm`
entries, using the same literal exact-or-whitespace-prefix matching, and audits
accepted commands before they run. PTY mode has a different v1 disposition for
confirmation-required commands: it blocks them, because the raw bridge has no
confirmation UI. The current mechanism is a Bash `DEBUG` trap; the durable
contract is the prompt-boundary behavior, not the specific hook. See the
[PTY contract](../pty-contract.md).

### 2. Coverage is best-effort; disposition is fail-closed

Interception covers only commands that traverse the installed hook — not commands
run inside an already-running program, not subshells or scripts or other shells,
and not anything that bypasses the hook. That coverage is best-effort, and PTY
mode is not a sandbox or security enforcement. For any command the hook *does*
intercept, however, the policy decision and audit are mandatory and fail-closed:
on any failure — refusal, timeout, malformed message, failed audit — the command
is skipped rather than released. A command outside coverage is never seen; a
command inside coverage is never released on doubt.

Replacing the hook mechanism without changing this coverage/disposition boundary
does not supersede this ADR; allowing an intercepted command to proceed when
policy or audit is unresolved would.

### 3. It is opt-in, experimental, and refuses rather than degrades

`--pty` is opt-in; the flagless `shell` remains the non-PTY baseline and does not
require the optional native `node-pty` dependency. `--pty` requires a real TTY,
the `node-pty` dependency, and an interactive Bash (4.1+); if any prerequisite is
unmet it refuses non-zero and spawns no shell, rather than silently falling back.
The feature is experimental (see [compatibility](../compatibility.md)), and only
Linux is covered by live CI.

## Alternatives considered

- **A sandbox, or syscall / subprocess mediation.** Would give complete coverage
  but requires heavy, platform-specific enforcement machinery outside the scope of
  a local tool.
- **Parsing the terminal byte stream.** Reconstructing commands from PTY output is
  fragile and does not cleanly identify what is about to run.
- **A raw PTY with no interception.** Would guard nothing; the flagless `shell`
  already covers the no-native-PTY-dependency baseline for commands entered at
  VibeRevert's own loop.

## Consequences

- Commands typed at the Bash prompt are checked with the same rules as `run` and
  `shell`, but commands run by nested programs, subshells, scripts, or other
  shells are not intercepted. `--pty` must not be read as complete command
  coverage or as a sandbox.
- Because disposition is fail-closed, an intercepted command in doubt is skipped
  and a decision timeout blocks.
- The self-tamper block on the hook is a safety net, not a security boundary: a
  determined user in their own shell can defeat it.
- Compound and multiline decomposition is characterized only on the tested
  Bash/Readline configuration. Regardless of how decomposition occurs, every
  command event that reaches the interception protocol is handled fail-closed;
  events that never traverse the hook remain outside coverage.
- `node-pty` is an optional dependency: when it is absent, only `--pty` refuses;
  `--help` and the flagless `shell` keep working.
