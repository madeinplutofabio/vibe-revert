# `viberevert shell` contract

`viberevert shell [--task "..."]` opens a **guarded command loop** inside a
single VibeRevert session: it takes a checkpoint, starts one session, then
prompts for one command at a time, guard-checks each command before running it,
and -- when you leave -- ends the session and points you at `viberevert check`.
It is the interactive companion to `viberevert run`.

It is deliberately boring. **`shell` is a guarded command loop, not a
transparent shell, not a terminal emulator, and not an agent runtime.** It reads
a line, guard-checks it, and spawns exactly one child per accepted command --
with VibeRevert's session semantics wrapped around the whole loop.

This document is the full contract (M G3, decision block D103). For the command
surface see `viberevert shell --help`. Guard/confirm matching semantics are
shared with `run` -- see [`docs/run-contract.md`](run-contract.md).

## What `shell` is -- and what it never pretends to be

`shell` opens ONE session and loops. For each submitted line it tokenizes to an
argv, guard-checks it, and -- if accepted -- spawns exactly ONE child:

```ts
spawn(argv[0], argv.slice(1), { stdio: "inherit", shell: false, cwd: invocationCwd })
```

- **`shell: false` is locked.** There is no shell interpretation: no glob
  expansion, no variable substitution, no operator parsing (`|`, `>`, `&&`), and
  therefore no shell-injection surface. Arguments reach the child exactly as
  tokenized.
- **Not a transparent shell.** To use shell features, invoke a shell
  explicitly: `sh -c "echo hi > out"` / `cmd /c "..."`. The guard then sees that
  literal command.
- **No native terminal bridge.** There is no `node-pty`, no native dependency,
  and no raw `process.stdin` / `process.stdout` in this path. A fully
  transparent terminal bridge (real interactive shell, keystroke-level
  passthrough) is a separate, experimental, opt-in mode --
  [`viberevert shell --pty`](pty-contract.md). Plain `shell` remains the stable
  baseline and is unaffected by it.
- **Guarding applies to the TOP-LEVEL command only.** Commands a spawned child
  runs internally are never seen and never intercepted.
- **Terminal output is NOT captured.** Children own the real terminal via
  `stdio: "inherit"`. VibeRevert sessions capture **file changes**, not
  transcripts.

## The read loop (and the Node-24 readline note)

`shell` creates exactly ONE `node:readline` interface for the whole REPL
(`input: this.context.stdin`, `output: stderr`) and ONE async iterator. **Both**
the command read and the confirmation sub-read consume from that single iterator
via `lines.next()`.

- This is the only read primitive that preserves every buffered line of piped /
  scripted stdin on Node 24. `rl.question` drops lines buffered between calls, so
  `printf 'cmd1\ncmd2\nexit\n' | viberevert shell` must -- and does -- run both
  commands, not just the first.
- **The interface is NOT paused around a spawned child.** The async iterator
  reads only during `await lines.next()`, and a child runs *between* reads, so
  there is nothing to protect; worse, pausing/resuming the interface around a
  spawn **closes** the iterator on Node 24 (the next read throws
  `readline was closed`). Child stdin is therefore best-effort in G3; transparent
  stdin hand-off to an interactive child is a G4 concern.
- **EOF ends the loop.** `Ctrl-D` (or the input stream ending) terminates the
  REPL cleanly, exactly like typing `exit`.

## Tokenizing (v1)

Each submitted line is tokenized to an argv by a small v1 parser that does **no
expansion** -- globs, variables, and operators are ordinary characters:

- Whitespace (runs of space/tab) separates tokens; leading/trailing whitespace
  is ignored.
- Single quotes `'...'` group literally (no escapes).
- Double quotes `"..."` group literally, recognizing only `\"` and `\\` as
  escapes; every other backslash is literal (so a Windows path like `C:\proj\x`
  survives untouched).
- A backslash **outside** quotes is literal, not an escape -- quote to embed a
  space; `\ ` does not escape.
- Quoted empty strings are preserved (`node -e ""` -> `["node","-e",""]`).
- An empty or whitespace-only line is a no-op (re-prompt). An unterminated quote
  is a soft error printed to stderr, then re-prompt -- it never crashes the loop.

Guard matching then normalizes the argv the same way `run` does
(`argv.join(" ")`), so `rm  -rf  "/"` tokenizes to `["rm","-rf","/"]` and
normalizes to `rm -rf /`.

## Control words

- The exact single-token line `exit`, or EOF / `Ctrl-D`, terminates the REPL.
- `exit` is handled **before** guard/confirm policy: it is never tokenized for
  policy, spawned, or logged, and it **cannot be guarded** --
  `commands.guard: ["exit"]` does not trap you inside the shell. `exit 3` is not
  the terminator; it tokenizes as an ordinary attempted command.
- **No `cd` in v1.** The REPL runs at the directory where you launched it for its
  whole life. Navigate via cwd-bearing commands (`node sub/build.js`,
  `npm --prefix sub ...`) or an explicit `sh -c "cd sub && make"` (guarded as
  that literal).

## Guard and confirm (per command)

Matching is identical to `run` (see [`docs/run-contract.md`](run-contract.md)):
literal, boundary prefix, `guard` beats `require_confirm`. What differs is the
loop behavior:

- **A guard refusal or a declined confirmation SKIPS that one command and
  CONTINUES the loop** -- unlike `run`, which exits. The next line is read
  normally.
- **Non-TTY confirmation is refused WITHOUT consuming a line.** In a pipe there
  is no way to confirm, so the confirm-required command is skipped and the next
  line stays a command (it is never eaten as a phantom answer).
- **TTY confirmation** prints the matched rule and the normalized command, then
  reads the next submitted line as the answer; you must type exactly `run anyway`
  (surrounding whitespace trimmed).
- **The policy is a startup snapshot.** `commands.guard` /
  `commands.require_confirm` are read once when the shell starts. Editing
  `.viberevert.yml` during the REPL takes effect in the **next** shell session,
  not mid-session.

## `commands.log` (audit) and the privacy boundary

Each **accepted** command appends exactly one JSON line to the session's
`commands.log`:

```json
{"at":"2026-07-07T12:34:56Z","cwd":".","argv":["node","build.js"]}
```

- "Accepted" means: non-empty line, tokenized successfully, non-empty `argv[0]`,
  not guarded, confirm-accepted (if required), and the append succeeded.
- The entry is appended **before** the spawn. A command that then fails to spawn
  (`ENOENT`, Windows `.cmd` `EINVAL`) **is still logged** -- the audit records
  what you asked VibeRevert to run after policy accepted it, not what
  successfully executed.
- `at` is a **fresh** ISO-8601 UTC second-precision timestamp per command (a
  deliberate divergence from `run`'s single-timestamp policy; deterministic under
  `VIBEREVERT_TEST_FIXED_NOW`).
- `cwd` is repo-relative POSIX (`"."` at the repo root), constant for the
  session. `argv` is recorded verbatim.
- **Privacy boundary:** `commands.log` does not redact secrets. Do not pass
  secrets as command-line arguments.

If the append itself fails (a corrupt log), the command is **not** spawned, the
error is printed, and the loop **continues with the session still open** -- a
divergence from `run`, which closes the session on append failure.

## Per-command results

A spawned child's exit is **displayed and swallowed**, never propagated to the
shell's own exit code:

- Non-zero exit -> `[exit: N]` on stderr.
- POSIX signal death -> `[signal: SIG]` on stderr.
- Exit `0` -> nothing.

The loop then continues to the next prompt. (This is a different contract from
`run`, which propagates the child's code as its own.)

## Active-session integrity and scoped teardown

Because a REPL can outlive its own session (a command it runs could end or
replace the session), `shell` re-checks ownership of `active-session.json`
**before each accepted command is appended/spawned** and **after each child
returns**:

- **Same id** -> continue.
- **Missing** (a command ran `viberevert end` / `rollback`) -> note it, STOP.
- **Different id** (a command ended ours and started another) -> warn, STOP.

**Teardown is scoped: `shell` only ever ends its OWN session.** At the end it
re-reads the lock:

- **Present and ours** -> end the session, print the two-line summary (exit `0`).
- **Missing** -> already ended/lost; do not end anything, no summary (exit `0`).
- **Different id** -> another session owns the lock now; **never end it**, no
  summary (exit `1`).

## Exit codes

The shell's own exit code -- separate from any per-command result:

| Outcome | Exit code |
|---|---|
| Clean exit (`exit` / EOF) that ended, or found already-gone, the shell's own session | `0` |
| Pre-loop refusal: a session is already active; repo-root / config error; empty `--task`; another operation is running | `1` |
| A command replaced the active session with a different one -- the shell stops without touching the other session | `1` |
| The shell's own session could not be closed at teardown | `1` + manual `viberevert end` hint |
| Per-command child exit / signal | displayed (`[exit: N]` / `[signal: SIG]`), never propagated |

## Output streams

All of the shell's own output -- the prompt `viberevert> `, refusals, the
confirmation prompt, per-command `[exit: N]` / `[signal: SIG]` lines, warnings,
and the final two-line summary -- goes to **stderr**. Children own stdout (and
stderr) via `stdio: "inherit"`. The end-of-session summary is exactly:

```text
Session: sess_<id>
Next: viberevert check --since sess_<id>
```

## Signals and cleanup

- **SIGINT at an idle prompt (TTY):** cancels the partially typed line and
  re-prompts, without exiting or ending the session. It does not settle the
  pending read; the same read waits for the next submitted line. It is
  suppressed while a child is running and while a confirm answer is pending
  (`Ctrl+C` mid-confirmation is not a v1 contract). Non-TTY / scripted stdin
  never emits a readline SIGINT.
- **SIGINT during a spawned child:** identical to `run`'s story -- the child is
  non-detached, the terminal delivers `Ctrl+C` to it, and record-only `SIGINT` /
  `SIGTERM` handlers keep the shell alive so the loop can continue. The session
  stays open.
- **Hard kill / terminal close / crash:** leaves a stale
  `.viberevert/active-session.json`; the existing recovery applies (the next
  `viberevert start` refuses; run `viberevert end`).

## Windows `.bat` / `.cmd`

Because `shell` spawns with `shell: false`, Node refuses to execute `.bat` /
`.cmd` files directly. The shell prints a hint and **continues the loop** (the
command is still logged as accepted). Run the script through `cmd /c` explicitly:

```sh
cmd /c npm test
```

The guard then sees the `cmd /c ...` form of the command.

## Not in scope for `shell` (the guarded REPL)

- **Transparent PTY / terminal bridge** -- a real interactive shell inside
  `node-pty`, raw stdin<->pty<->stdout bridging, and prompt-level interception.
  This is deliberately **not** part of `shell`, which stays PTY-free (pinned by
  the D103.M source-shape invariants). It ships separately and experimentally as
  [`viberevert shell --pty`](pty-contract.md), Bash-only and gated on an
  optional native dependency; see that contract for its coverage limits and
  fail-closed behavior.
- **`cd` / working-directory changes** -- the REPL is fixed-cwd in v1, and its
  `commands.log` `cwd` is constant for the session. (PTY mode is not fixed-cwd:
  it audits each command at its prompt-time directory.)
- **Inner / nested command interception** -- never claimed. Guarding is
  top-level only.
- **Guard globs / regex / path normalization** -- shared with `run`; a possible
  followup after v1 feedback.
