# `viberevert shell --pty` contract (experimental)

`viberevert shell --pty` opens a **real interactive Bash session** inside a
pseudo-terminal (`node-pty`), bridges your keystrokes to it raw, and wraps one
VibeRevert session around the whole thing. Commands submitted at that Bash prompt
are checked against the **same configured guard rules** `run` and `shell` use,
via PTY mode's single-element `[rawLine]` policy representation (described
below), and accepted, auditable interceptions are recorded in `commands.log`
before they are released; hygiene-only no-ops are released without an audit
entry, as described below.

It is the experimental companion to [`viberevert shell`](shell-contract.md), the
plain guarded command loop. `shell` (no flag) stays the stable,
native-dependency-free, always-available baseline on every platform; `--pty` is
opt-in.

**This document is NORMATIVE.** MUST / MUST NOT describe behavior that is
implemented and pinned by tests. **"Best effort" applies only to interception
coverage** -- never to what happens to a command once intercepted. Explanatory
asides are marked *informative*.

## What this is, what it is not, and what is still mandatory

Read these three together. The second is routinely misread.

**1. What PTY mode does.** It intercepts commands at **Bash's interactive prompt
boundary**: before Bash runs a command submitted at that prompt, a hook reports
it to the VibeRevert parent over a private loopback channel; the parent evaluates
policy and audits; only an explicit allow lets the command run. *Informative:*
the current mechanism is an interactive Bash `DEBUG` trap with `extdebug`,
installed via a private rc file. The durable contract is the prompt-boundary
behavior; the private hook mechanism may change.

**2. What PTY mode is NOT.** It is **not a sandbox** and does not mediate the
system. Interception **coverage is best effort**: it covers commands that
traverse the installed hook, and nothing else. It is not terminal-byte parsing,
not syscall mediation, not subprocess mediation, and not shell-wide enforcement.

**3. What remains mandatory.** For any command the hook **does** intercept, the
policy decision and the audit prerequisite are **not** best effort. Such a
command MUST NOT be released unless policy allows it **and** its audit
prerequisite is satisfied. Every failure -- refusal, timeout, malformed frame,
nonce mismatch, unreadable session, failed append -- results in the command being
**skipped**.

> **Coverage is best effort. Disposition is fail-closed.** A command outside
> coverage is never seen. A command inside coverage is never released on doubt.
> This MUST NOT be read as "sometimes fails open."

## Interception coverage and its bypasses

*Informative:* the boundary is a property of where the hook sits, not a list of
blocked programs. Commands **not** intercepted, by category:

- **Commands run inside an already-running interactive program** -- an editor, a
  REPL, a pager, an agent, a nested `ssh`/`tmux` session. What a program you
  launched does next is its own business.
- **Commands in alternate shells or processes that do not traverse the installed
  hook** -- a subshell, a script, a `make` recipe, another shell binary, a
  program spawning children directly.
- **Deliberate tampering with the hook.** The hook hard-blocks the obvious local
  self-tamper patterns (its private namespace, the `DEBUG` trap,
  `extdebug`/`functrace`, disabling `trap`) **before** consulting policy, and
  those internal refusals are not overridable by `commands.guard` or
  `require_confirm`. This is a **safety net, not a security boundary**: a
  determined user in their own shell with their own privileges can defeat it.

**PTY mode MUST NOT be described as complete command interception, as security
enforcement, or as a sandbox.** It is a prompt-level safety net for commands you
type.

## Availability (and how it refuses)

`--pty` MUST refuse, clearly and non-zero, rather than silently degrade to the
REPL. It never auto-selects and never falls back.

| Requirement | If unmet |
| --- | --- |
| A real interactive TTY | refused |
| `node-pty` loads | refused |
| An interactive shell resolves | refused |
| That shell is **Bash** | refused |
| Interception installs (hook + channel) | refused -- **no shell is spawned** |

*Informative:* the internal diagnostic codes for these (`not_tty`,
`pty_unavailable`, `no_shell`, `unsupported_shell`) are current implementation
identifiers, not a public CLI contract; the normative guarantee is the refusal
itself, non-zero and never a silent fallback.

- **Bash only, v1.** PowerShell, non-Bash POSIX shells, and any future shell
  family are refused. This is written to fail closed: anything that is not Bash
  is refused by default rather than allowed by omission.
- **Bash 4.1 or newer.** The hook requires dynamic file descriptors; an
  incompatible Bash fails the hook's setup closed rather than running unguarded.
- **In practice**, `--pty` runs where `node-pty` is available and Bash 4.1+ can
  be resolved -- including Linux and WSL environments where those prerequisites
  are met, and macOS systems with a sufficiently recent Bash installed. (Stock
  macOS `/bin/bash` predates the 4.1 minimum.) A stock Windows shell normally
  resolves to PowerShell and is refused. Only Linux is covered by live CI; see
  Evidence.
- **`node-pty` is an optional dependency.** If it is absent or its native binding
  fails to load, `viberevert --help`, `viberevert shell --help`, and plain
  `viberevert shell` MUST all keep working; only `--pty` refuses.
- **Not available via MCP or any in-process harness.** `--pty` requires a real
  TTY and raw stdio, which also excludes piped/scripted stdin.
- **The PTY child MUST NOT be spawned unless interception installation has
  succeeded.**

## What gets intercepted, exactly

The hook reports **the command Bash is about to run** (`$BASH_COMMAND`) together
with the prompt-time working directory. VibeRevert does **not** re-tokenize,
expand, or normalize that text.

*Informative, and important for reading guard coverage:*

- The current hook reports `$BASH_COMMAND` for each `DEBUG`-trap event, not
  necessarily the complete line the user typed. One submitted pipeline,
  conditional chain, function invocation, or other construct may therefore cause
  multiple interceptions -- and so multiple policy decisions and multiple audit
  entries. Compound and multiline behavior is **characterized under the tested
  configuration** (see **Compound and multiline characterization**), but the
  specific event shape is not promised across every Bash/Readline version.
- **Policy evaluates the text Bash reports, not a semantically expanded
  command.** How Bash populates that value for aliases, shell functions, and
  expansions is Bash's behavior; VibeRevert neither normalizes it nor tests
  those cases.

## Compound and multiline characterization

*A submitted line is not always one interception.* The hook fires per **simple
command** (`$BASH_COMMAND`) at the `DEBUG`-trap boundary, so one typed pipeline,
chain, substitution, subshell, function, loop, or continuation may produce one
or several interceptions -- each an independent policy decision and audit entry.
This section records what was **characterized on Linux CI** under the production
hook and what is **not** promised. It is the tested elaboration of **What gets
intercepted, exactly**; it does not widen coverage or turn Bash's event
granularity into a cross-version promise.

*Evidence note: characterized on Linux CI in July 2026 using Bash
`5.2.21(1)-release` and Node `22.23.1`. These versions identify the observed
run; they do not define the supported-version contract.*

### Guaranteed contract

Independent of how a construct decomposes into events:

- Each surfaced simple command is dispositioned **before** it may run. The
  mandatory, fail-closed rules this contract states above apply **per
  interception** -- a blocked or audit-failed command MUST NOT run, and an allow
  MUST follow a successful audit. Compound structure grants **no** exemption.
- Correctness is **connection-scoped**: each interception is one loopback
  exchange, dispositioned on its own connection. It MUST NOT depend on the
  client-supplied request id being globally unique.
- Coverage remains **best effort** (a construct MAY decompose differently on
  another Bash/Readline build); disposition remains **fail-closed**.

### Observed Bash 5.2 behavior

*Informative -- the tested decomposition, not a promise.*

- **Simple-command boundary.** `;`, `&&`, `||`, pipelines (`|`), command
  substitutions (`$(...)`), subshells (`( ... )`), function bodies, and loop
  bodies each surfaced at the simple-command boundary; each surfaced element was
  independently dispositioned, and a blocked element did not execute.
- **Nested commands surface.** Under the tested hook configuration, `extdebug`
  caused the `DEBUG` trap to be inherited into nested execution contexts,
  including command substitutions, subshells, functions, and loop bodies. Inner
  commands therefore surfaced and were **independently blockable** -- coverage
  this contract does not *promise* (see below), observed to occur.
- **A hook skip is not a command failure.** In `A && MID && C`, blocking `MID`
  caused the hook to **skip** it, but Bash still proceeded to run `C`. Skipping a
  command is **not** equivalent to a native non-zero exit and does **not**
  short-circuit a `&&` chain. Blocking a command prevents *that* command; it does
  not synthesize the failure semantics a real command's non-zero status would.
- **Native short-circuit.** Conversely, native `||` short-circuiting can leave a
  policy target **legitimately unreachable** (e.g. the right side of
  `true || target`): Bash never evaluates it, so it never surfaces. This is a
  contract-consistent non-event, not a coverage gap.
- **Backslash continuation.** A `\`-newline continuation is joined by Bash before
  it reaches the trap: the physical lines become **one** simple command, reported
  once as a single pre-expansion `$BASH_COMMAND`.
- **Heredoc.** A heredoc surfaced as **one** command whose `$BASH_COMMAND`
  contained the **entire heredoc source** -- command line, body, and delimiter,
  with embedded newlines. The body and delimiter did **not** surface as
  independent commands; execution was confirmed by the file the command wrote.
  *Because policy evaluates the reported text verbatim, a rule can still match
  text drawn from the body -- see **What gets intercepted, exactly**.*
- **Prompt transitions.** PS1/PS2 continuation transitions were driven and
  verified by the **ordered sequence of prompts** the shell emitted, never by
  elapsed time or output appearance.

### Known limitations and non-promises

- **Not a cross-version compatibility promise.** The decomposition above is the
  tested Bash's behavior under the current hook. Another Bash or Readline version
  MAY decompose a construct differently. The guaranteed contract holds regardless;
  the specific event shape does not.
- **Chain/short-circuit semantics are the shell's.** Blocking one element of a
  chain does not reproduce native failure or short-circuit behavior. Users MUST
  NOT assume that blocking one element aborts the rest.
- **Single-write multiline only; not bracketed paste.** Multiline input was
  characterized as a single write of a newline-separated block. The terminal
  **bracketed-paste** protocol (a real emulator's clipboard framing) is a distinct
  surface and is **not** characterized here.
- **No semantic aggregation.** VibeRevert does not reassemble a construct's
  interceptions into one logical command; each is dispositioned on the text Bash
  reported for it.
- **The verdict is not inherited across mechanism changes.** A future change to
  the hook, Bash options, PTY driver, or prompt configuration MUST rerun this
  matrix before the maintainer verdict below is carried forward.

### Maintainer verdict

The tested compound and multiline surface is **contract-consistent**: every
surfaced command was dispositioned fail-closed, no blocked or audit-failed
command executed, and **no safety contradiction was observed** across the
characterized constructs. This is a verdict about the **tested configuration** --
not a blanket compatibility guarantee for every Bash/Readline version. Coverage
stays best effort; disposition stays mandatory.

*Historical note:* the first nested-construct run exposed request ids that
**collided across subshells** -- the pre-fix `$$-<sequence>` id keeps the parent
PID inside a subshell, so the forked sequence repeated. The hook was hardened to
`$BASHPID-<sequence>`, which removed the observed collision, and the harness was
corrected to correlate strictly by connection identity rather than trusting
client ids as unique. The duplicates did not produce a wrong-command
authorization under the connection-per-request protocol, but they weakened
diagnostics and exposed an incorrect uniqueness assumption in the original test
harness.

## Guard and confirm (per intercepted command)

- The parent evaluates the reported text as a **single synthetic argv element**
  -- `[rawLine]` -- against the same `commands.guard` / `commands.require_confirm`
  policy as `run` and `shell`. Prefix rules like `rm -rf /` or `git push` match
  the visible command text.
- *Informative:* this differs from `run`/`shell`, which tokenize to a real argv.
  A real shell line is not clean argv (redirects, pipes, quoting, expansion), and
  VibeRevert does not pretend to reconstruct one.
- **`require_confirm` matches are blocked, not prompted, in PTY mode v1** --
  there is no confirmation UI inside the raw bridge. The policy rule is not
  transformed; only its PTY-mode disposition is "block" for now. (The REPL keeps
  interactive confirm.)
- A blocked command is skipped; the prompt returns; the session stays open.

## Audit (`commands.log`)

Each **accepted, auditable** command appends exactly one JSON line **before** it
is released to run:

```json
{"at":"2026-07-17T12:34:56Z","cwd":"packages/core","argv":["git status --short"]}
```

- **No-op exception:** if hygiene reduces an intercepted line to no meaningful
  command text, the gate treats it as a no-op -- it performs **no** ownership,
  clock, or append work, and records nothing. Everything else in this section
  applies to commands that produce an entry.
- `argv` is a **single element**: the intercepted command text, after hygiene.
  It is **not** the child process's argv. PTY entries are deliberately a
  different audit shape from `run`/`shell` entries in the same file.
- **The audit prerequisite is mandatory.** The parent cannot emit an allow for an
  auditable command without a successful audit. If the audit fails for any
  reason, no allow is sent and the command is skipped.
- **An entry records a successful audit attempt before release -- not proof of
  execution.** The command may still not run: the session may be shutting down
  when the decision would be sent, or the channel may fail after the append. An
  entry means *VibeRevert accepted and recorded this command*, not *this command
  executed*. (`run` and `shell` carry the same caveat for their own reasons.)
- A successful audit invocation appends one entry. *Informative:* the current
  protocol performs a single-shot exchange for each interception, but this is not
  a general exactly-once-delivery guarantee for future protocol versions.
- `at` is a fresh ISO-8601 UTC second-precision timestamp per command.
- **Privacy boundary:** `commands.log` stores command text and does not redact
  anything. That text may contain inline environment assignments, tokens, URLs,
  heredoc-related command text, and anything you pasted. Treat it as sensitive.

### Command-text hygiene

Prompt lines can contain control bytes, ANSI escapes, and pasted blobs. Before
storage, the audited text MUST have ANSI CSI/OSC sequences stripped, every
C0/DEL/C1 control code neutralized to a space, Unicode directional/bidi controls
removed, and the result capped (4096 code points, truncation marker included,
never splitting a surrogate pair). `commands.log` therefore stays valid JSONL and
MUST NOT be able to rewrite the terminal of someone who later `cat`s it.

### The two cwds

These are different values and the distinction matters:

- **Reported prompt-time cwd** -- the shell's **absolute, logical** `$PWD`,
  captured by the hook and bound into the **same nonce-bound, request-id-
  correlated request** as the command text. This is untrusted protocol data.
- **Persisted audit cwd** -- the **canonical repository-relative** value stored
  in `commands.log`; exactly `"."` at the repository root. The absolute path is
  **never** stored.

**PTY mode is not fixed-cwd.** An interactive shell can `cd`, so each command is
audited with the working directory **as of that prompt**, not the directory the
session started in. (A real difference from [`shell`](shell-contract.md), whose
`cwd` is constant for the session.)

Resolution is **lexical**, matching how `run` records `cwd` and the codebase's
deliberate lexical repo-boundary policy. *Informative:* this proves the logical
shell cwd lies lexically under the logical repository root. It is **not** a
physical filesystem-boundary guarantee (symlinks are not resolved) and MUST NOT
be reused for access control without stronger validation. The audit cwd is a
record, never a permission.

A reported cwd is rejected -- and the command consequently skipped -- when it is
empty, oversized, not an absolute POSIX path, contains control characters, line
separators, bidi controls, or malformed UTF-16, or resolves outside the
repository.

### Representable directory names

Awkward directory names are **supported**: leading dashes, spaces, single and
double quotes, and non-ASCII characters all round-trip and are stored exactly.

One category is not. **A literal backslash that survives into the persisted
repository-relative cwd is legal on POSIX but not representable in VibeRevert's
current cross-platform audit path format** -- that format is forward-slash-only,
because on Windows a backslash is a path separator that producers normalize away,
so a stored backslash would be ambiguous. Commands typed in such a directory
therefore **remain fail-closed**: rejected before any session or storage work,
with a cwd reason rather than a misleading append failure.

*Informative:* a backslash **above** the repository root is fine -- it is removed
when the path is made repository-relative and never reaches the log. This is a
limit of the current stored format, not a judgment about your filesystem; lifting
it would require a versioned format change, not a relaxed validator.

## Session lifecycle, and how to leave

`--pty` takes a checkpoint and opens **one** session for the whole PTY session,
re-checks that it still owns `active-session.json` for each auditable
interception before appending its entry, and scope-tears-down on exit -- never
ending a session it does not own.

**`exit` is a command.** It reaches the hook like any other and is subject to the
same mandatory audit. So when the audit prerequisite is **persistently**
unsatisfiable -- an unrepresentable or invalid cwd, or a session that ended
underneath you -- `exit` is blocked too, and the shell will not leave that way.
**Use Ctrl-D (EOF).** EOF is not a command, is never intercepted, and is the
supported non-command exit used by this implementation and its tests. There are
**no lifecycle exemptions**: VibeRevert MUST NOT carve out an unaudited "safe"
command path, because `exit 1`, `logout`, `exec`, and alias shadowing would all
immediately follow.

## Terminal restoration

On every exit path -- clean exit, EOF, an error during startup, a failed teardown
-- VibeRevert MUST attempt raw-mode restoration **first**, then remove the
listeners and PTY subscriptions it installed and complete the remaining teardown
steps. A failure in one teardown step MUST NOT prevent later steps from being
attempted. Teardown failures are collected, do not escape as uncaught exceptions,
and produce wrapper failure status where this contract specifies it.
*Informative:* a wedged terminal is the most user-hostile failure this feature
could have, and teardown is ordered and defensive for that reason.

## Exit codes

- **`0`** -- the PTY session ended and this wrapper ended (or found already gone)
  its own session.
- **`1`** -- wrapper-level setup, ownership, or teardown failures (no TTY,
  `node-pty` unavailable, no/unsupported shell, interception install failure,
  session already active, repo/config error, concurrent operation, teardown
  failure).
- **An intercepted-command audit failure blocks that command**; it does not by
  itself decide the wrapper's exit code, and such failures are summarized after
  teardown.
- **The inner shell's own exit status is displayed, not propagated.** Like
  `shell`, the wrapper's code reflects VibeRevert's job, not your last command.

## Timeouts and channel failures

- The parent's decision timeout is **5000 ms**, and a timeout is a **block**.
  *Informative:* this bounds the hook waiting for a decision. It is **not** a
  limit on how long your command may run -- a slow command is never killed after
  five seconds.
- A request line is capped at **64 KiB** on the wire; an oversized line closes
  the connection and the command is skipped.
- If the channel closes or framing fails, **that** command is skipped. Each
  interception uses its own connection, so one failed exchange does not by itself
  poison later prompts; but a persistently broken channel or session prerequisite
  keeps failing every subsequent command closed.

## Protocol compatibility

The hook/parent wire protocol is **version 1 and currently internal and
unreleased**. Once it ships in a released artifact, any change to the request or
decision fields, the framing, or their semantics MUST bump the version.

## Evidence: what is proven live vs. by unit tests

*Informative, but load-bearing -- do not overread either column.*

**Proven live** (CI, Ubuntu, real `node-pty` PTY, the built CLI, a real git
repository, production session/service wiring):

- A guarded Bash prompt opens; a benign command is intercepted, allowed, and
  actually executes; the prompt returns; `exit` ends the session; the CLI process
  terminates cleanly with no force-kill -- i.e. no handle survives teardown.
- An interactive `cd` into an awkward-but-representable directory is audited at
  `"."`, and the **next** command is audited at the **new** prompt-time cwd, in
  the same session, through the production audit path. Ending with EOF leaves
  exactly two accepted-command entries with the expected canonical
  repository-relative cwds.
- The `node-pty` native binding loads and can allocate a PTY (Linux and Windows).
- The compound and multiline characterization matrix runs live on Linux CI. It
  covers compound chains, pipelines, nested execution contexts, backslash
  continuation, heredoc, and single-write multiline input; every surfaced target
  was dispositioned fail-closed, and no safety contradiction was observed in the
  tested configuration.

**Proven by unit tests** (deterministic, not live):

- **Strict append-before-allow ordering**, and that an allow cannot be emitted
  for an auditable command without a successful audit.
- Deterministic negative and race coverage includes: malformed requests, nonce
  mismatch, policy errors, decision timeouts, audit/append failure, ownership
  loss, session replacement, shutdown races, transport failures, and the cwd
  validator's accept/reject boundaries.

*Informative:* the live tests exist to catch what unit tests structurally cannot
-- disagreements **between** layers that each pass their own suites. The first
real run of the cwd-audit case did exactly that, surfacing a resolver/core
mismatch over backslashes that is now the representability rule above.

## Not in scope

- **Interception of nested/inner commands as a guarantee** -- never claimed.
  (Observed to occur through `functrace` under the tested hook -- see **Compound
  and multiline characterization** -- but not promised.)
- **Interactive confirmation in PTY mode** -- v1 blocks `require_confirm`
  matches instead of prompting.
- **Shells other than Bash**, and any promise about arbitrary Bash builds beyond
  the 4.1 minimum.
- **Terminal transcripts** -- VibeRevert sessions capture **file changes**, not
  scrollback. PTY output is not recorded.
- **Protection against a hostile shell or a determined user** -- out of scope by
  construction.
- **Full POSIX filename coverage in the audit path** -- see representability.

## Maintaining this contract

Any change to interception coverage, the audit shape, cwd representation,
lifecycle behavior, or protocol fields MUST update this document and its
corresponding tests **in the same change**.
