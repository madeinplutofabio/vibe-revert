# `viberevert run` contract

`viberevert run [--task "..."] <command> [args...]` runs a single command
inside a VibeRevert session: it takes a checkpoint, starts a session, spawns
the command, ends the session when the command exits, and points you at
`viberevert check` to review what changed.

It is deliberately boring. **`run` is not a shell, not a terminal emulator,
and not an agent runtime.** It wraps exactly one child process with
VibeRevert's existing session semantics wrapped around it.

This document is the full contract (M G2, decision block D102). For the
command surface see `viberevert run --help`.

## What `run` wraps -- and what it never pretends to wrap

`run` spawns exactly ONE child from the command you give it:

```ts
spawn(argv[0], argv.slice(1), { stdio: "inherit", shell: false, cwd: process.cwd() })
```

- **`shell: false` is locked.** There is no shell interpretation: no glob
  expansion, no variable substitution, no operator parsing (`|`, `>`, `&&`),
  and therefore no shell-injection surface introduced by `run`. Arguments
  reach the child exactly as written.
- **Guarding applies to the TOP-LEVEL invocation only.** Commands the wrapped
  program runs internally -- an agent's tool calls, subshells, scripts it
  invokes -- are never seen by `run` and are never intercepted.
- **Terminal output is NOT captured.** The child owns the real terminal via
  `stdio: "inherit"`. VibeRevert sessions capture **file changes**, not
  transcripts.

### Argument boundary

`run` uses a proxy for the wrapped command, so flags after the command flow to
the child untouched:

- `viberevert run -- npm test --watch` -- the leading `--` is consumed once by
  the argument parser; the child receives `npm test --watch`.
- `viberevert run --task "refactor auth" claude` -- `--task` is parsed by `run`
  because it appears **before** the command.
- `viberevert run node script.js --task x` -- `--task` appears **after** the
  command, so it flows to the child; the session carries no task.

An empty command name is refused (exit 1) before any session is created.

## Lifecycle

`run` owns the whole session, in this fixed order:

1. Resolve the repo root.
2. Load `.viberevert.yml` (**required** -- like `viberevert start`).
3. Guard check (D102.C).
4. `require_confirm` check (D102.D).
5. Start the session (takes a checkpoint).
6. Append one entry to the session's `commands.log` (D102.F).
7. Spawn the child and wait.
8. End the session (captures post-run git status).
9. Print the two-line summary.

The wrapped child **never runs under the session-start lock** -- the lock is
released once the session is established, before the child is spawned.

If the child itself ends the session (e.g. it runs `viberevert end`), `run`
notices at step 8, prints a note, and still propagates the child's exit code
and prints the summary.

## Guard and confirm matching (v1)

Matching is intentionally literal -- no regex, no globs, no path resolution.

- **Normalization:** the command is `argv.join(" ")`. There is no shell
  parsing and no case folding. This loses shell quoting by design:
  `["echo", "a b"]` normalizes to `echo a b`. That is the v1 contract, not a
  bug.
- **Match rule:** an entry `E` matches the normalized command `C` iff
  `C === E` **or** `C` starts with `E` followed by a space (a prefix ending at
  a word boundary).
- **Precedence:** `guard` is checked before `require_confirm`. A command that
  matches both is refused outright -- **guard always wins**; confirmation can
  never override a guard.
- Absent `commands`, `commands.guard`, or `commands.require_confirm` means "no
  guards / no confirms" -- everything is allowed.

### Worked examples

With `commands.guard: ["rm -rf /"]`:

| Command | Result |
|---|---|
| `viberevert run rm -rf /` | refused (exact match) |
| `viberevert run rm -rf / --no-preserve-root` | refused (boundary prefix) |
| `viberevert run rm -rf /x` | **allowed** -- `rm -rf /x` does not start with `rm -rf /` followed by a space |

The last row is the point of the boundary rule: `guard` entries match whole
leading tokens, not arbitrary substrings.

### Where the rules come from

`commands.guard` / `commands.require_confirm` live in `.viberevert.yml`. The
init profiles seed them differently:

- The **generic** profile ships a **commented** `# commands:` example you
  uncomment to opt in.
- The **framework** profiles (nextjs, laravel, rails, python, lovable) ship
  **live**, framework-tailored `guard` / `require_confirm` defaults (e.g. the
  rails profile guards `rails db:drop` and confirms `rails db:migrate`).

Either way, these rules take effect **only under `viberevert run`**. They do
nothing on their own; running the underlying command directly bypasses them.

## The confirmation flow

When a command matches `require_confirm`:

- If stdin is **not a TTY**, `run` refuses (exit 2) -- interactive confirmation
  is impossible in a pipe.
- If stdin **is a TTY**, `run` prints the matched rule and the normalized
  command, then prompts:

  ```text
  Type "run anyway" to run this command:
  ```

  You must type exactly `run anyway` (surrounding whitespace is trimmed).
  Anything else refuses the command (exit 2). It is deliberately **not** "yes"
  (too reflexive) and **not** "retype the command" (hostile for long commands,
  no security gain).

Confirmation happens **before the session starts**, so a declined command
leaves zero session residue.

## Output streams

All of `run`'s own output -- refusals, the confirmation prompt, warnings, and
the final summary -- goes to **stderr**. The child owns stdout (and stderr) via
`stdio: "inherit"`; `run` never writes to stdout, so it can't pollute a
pipeline the wrapped command feeds.

The end-of-run summary is exactly two lines on stderr:

```text
Session: sess_<id>
Next: viberevert check --since sess_<id>
```

`run` **never runs `check` for you** -- the second line is a hint. (A `--check`
opt-in flag may come later; it is not in G2.)

## Exit codes

The child's exit code is propagated **verbatim**. `run`'s own codes can
therefore collide with a child that legitimately exits 1/2/126/127 -- the same
ambiguity every shell wrapper has.

| Outcome | Exit code |
|---|---|
| Guard refusal / confirmation declined / confirm required but non-TTY | `2` |
| Config / repo-root / internal error; session already active; empty command name; start failure | `1` |
| Spawn failed -- command not found (`ENOENT`) | `127` |
| Spawn failed -- found but not executable (`EACCES`) | `126` |
| Windows: spawning a `.bat`/`.cmd` directly with shell disabled (`EINVAL`) | `1` + hint |
| Child exited with code `N` | `N` (verbatim) |
| Child killed by a POSIX signal | `128 + signal number` |
| Session could not be closed after the child ran | `1` (the child's own exit status is printed to stderr) |

The last row is the one exception to verbatim propagation: a broken session
means the wrapper failed its core job, so it reports `1` -- while still telling
you what the child did.

## `commands.log` (audit) and the privacy boundary

Each `run` session appends exactly one JSON line to
`.viberevert/sessions/<id>/commands.log`:

```json
{"at":"2026-07-05T12:34:56Z","cwd":".","argv":["npm","test"]}
```

- `at` is an ISO-8601 UTC timestamp at second precision.
- `cwd` is **repo-relative and POSIX-normalized** -- `"."` at the repo root, or
  the subdirectory name when you invoke `run` from inside the repo. It is
  never an absolute path.
- `argv` is the command **recorded verbatim**.

**Privacy boundary:** `commands.log` does **not** redact secrets. If you pass a
secret as a command-line argument, it is written to `commands.log` as-is. Do
not pass secrets as command-line arguments.

## Signals and cleanup

The child is spawned non-detached, so it shares the process group (POSIX) or
console (Windows) with `run`. The terminal delivers Ctrl+C to **both**.

While the child runs, `run` installs record-only `SIGINT`/`SIGTERM` handlers so
it does not die before ending the session. When the child exits, `run` removes
the handlers, ends the session, and exits per the table above. `run` does not
forward signals in v1.

- **Windows:** `SIGTERM` is never delivered to a process; this is a platform
  limitation, not a `run` behavior.
- **Hard kill / terminal close / wrapper crash:** if `run` is `SIGKILL`ed or
  the terminal is closed, a stale `.viberevert/active-session.json` is left
  behind. Recovery is the existing path: the next `viberevert start` refuses
  and points you at `viberevert end`; run `viberevert end` to close the stale
  session.

## Windows `.bat` / `.cmd`

Because `run` spawns with `shell: false`, Node refuses to execute `.bat`/`.cmd`
files directly (the post-CVE-2024-27980 behavior). `run` reports exit `1` with
a hint:

```text
viberevert run cmd /c <script>
```

Run the script through `cmd /c` explicitly. The guard then sees the
`cmd /c ...` form of the command.

## Not in scope (deferred)

- PTY bridge / interactive TTY passthrough -> G3. `run` is pipe-less
  `stdio: "inherit"`; it is not a PTY.
- Terminal output capture / transcripts -> G3+ (raises redaction questions).
- Inner / nested command interception -> never claimed. Guarding is top-level
  only.
- Guard globs / regex / path normalization / case-insensitive matching -> a
  possible followup after v1 feedback.
- `--check` auto-check flag -> a possible followup.
- An MCP `run` tool -> not in G2 (interactive stdio is incompatible with MCP's
  captured-sink harness).
