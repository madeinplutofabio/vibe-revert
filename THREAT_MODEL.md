# VibeRevert threat model

## Purpose and how to read this

This document states what VibeRevert **defends against**, what it **does not**,
and the trust boundaries in between. It is **normative**: MUST / MUST NOT
describe behavior pinned by the contracts and tests it links. It exists so that
VibeRevert's public claims never exceed its actual guarantees.

*Informative:* it complements the behavioral contracts --
[rollback](docs/rollback-contract.md), [PTY interception](docs/pty-contract.md),
and the audit rules in the run/shell/PTY contracts -- by stating the security
posture those behaviors add up to.

## What VibeRevert is (for this analysis)

VibeRevert records an AI coding session, flags risky changes, and can restore the
project state represented by the session checkpoint -- tracked working-tree
content, the index, and untracked content captured at session start -- to how it
was before the session, including uncommitted work. It runs **locally**; the
default workflow requires no account, network, or telemetry.

## Assets

- **The user's working-tree state** -- committed and, critically, **uncommitted**
  changes captured by the session checkpoint.
- **The local audit and session record** -- `commands.log`, session artifacts,
  checkpoints, and receipts under `.viberevert/`.

## Trust boundaries

The **local account and operating environment are trusted**. **Repository content
and agent-produced changes are treated as potentially hostile inputs**, but
VibeRevert is **not a sandbox for executing a malicious repository**: it hardens
its own parsing and file handling against hostile input; it does not contain what
a program in the repository does when run.

## Security postures

| # | Threat | Posture | What it means |
|---|---|---|---|
| **P1** | Accidental or agent-introduced changes to your project | **Strong -- for captured state** | The session checkpoint + `rollback` restore the repository state VibeRevert captured; `guard`/`check` flag risky edits on a **best-effort** basis. It strongly protects **captured** state -- not every working-directory artifact (see below). |
| **P2** | Malicious *repository content* fed to VibeRevert | **Partial / defensive** | Lexical path confinement, manifest/schema hostile-input handling, audit-log control-char/bidi hygiene, archive-entry + patch-header validation, and control-plane protection harden VibeRevert against hostile inputs. This is **defensive hardening, not a sandbox**. |
| **P3** | A malicious *local user or process* | **Out of scope by construction** | A user (or a process running as them) with write access to the repo or `.viberevert/` can edit artifacts, disable the guard, or bypass interception. The PTY hook self-tamper block is a **safety net, not a security boundary**. |
| **P4** | Reversing *external effects* / containment | **Not guaranteed** | `rollback` restores checkpointed repository filesystem and index state only. It does **not** reverse database changes, deployments, package publishes, external API calls, environment mutations, or OS-level state, and it is **not atomic** (see below). |

## Specific risk surfaces

### Checkpoint / rollback covers captured state, not everything

`rollback` restores the state the session **captured**. It does not protect every
working-directory artifact: files created after `end`, or paths excluded by
`rollback.exclude`, are outside the captured set, and **uncaptured untracked
files are deleted** by a rollback (see the
[rollback contract](docs/rollback-contract.md)). "Your project files as they
were" means *the state the checkpoint captured* -- tracked content, the index,
and untracked content captured at session start -- not an arbitrary directory
snapshot.

### Rollback is non-atomic

A rollback can fail **mid-mutation** -- a post-restore verification failure
surfaces in the receipt's `failures[]` and the operation exits non-zero; it is
not silently "half-done and reported successful." VibeRevert's mitigation is a
**mandatory emergency pre-rollback checkpoint**: `--apply` never mutates without
first capturing a recoverable snapshot, and if that snapshot cannot be created
the rollback **aborts before touching anything**. Recovery from a bad or partial
rollback is via that checkpoint. VibeRevert MUST NOT be described as an atomic or
transactional restore.

### PTY interception is best-effort coverage, fail-closed disposition

For `shell --pty`, **coverage is best effort**: only commands that traverse the
installed hook are seen (see the [PTY contract](docs/pty-contract.md)). Once a
command **does** surface, its **disposition is fail-closed** -- it runs only on an
explicit allow with a satisfied audit prerequisite, and every failure skips it.
**Fail-closed disposition does not convert best-effort coverage into complete
interception**: commands outside the installed hook's coverage, including commands
executed by separate nested shells, subprocesses, or already-running programs, are
not guaranteed to be seen. This is a prompt-level safety net, not a sandbox or
security enforcement.

### Audit-log hygiene is rendering-safety, not confidentiality or tamper-evidence

`commands.log` stores intercepted command text with ANSI / control / bidi
sequences neutralized, so reading it later cannot rewrite the reader's terminal.
That hygiene **prevents misleading terminal rendering; it provides neither
confidentiality nor tamper evidence.** The log is **not redacted** (it may contain
tokens, URLs, inline environment assignments -- treat it as sensitive) and is
**not tamper-proof** against a local user who can edit the file.

### Archive / patch validation (implemented) vs. hostile fixtures (H6)

Untracked capture/restore uses gzipped tarballs; tracked-dirty state and diffs
replay via patches. Before extraction or replay, the restore preflight validates
this evidence and **throws on anything unsafe**. The **currently implemented**
checks reject: non-regular archive entries (symlinks, hardlinks, directories,
devices), non-canonical paths (parent-directory traversal, absolute paths),
duplicate entries, entries that diverge from the manifest, and any
`.viberevert/**` reference in an archive entry **or** a patch header (including
C-quoted-escape obfuscation) -- the last of which would otherwise let a tampered
checkpoint overwrite VibeRevert's own control plane, including the emergency
pre-rollback checkpoint. *Separately*, **H6 adds an adversarial hostile-tarball
fixture suite** exercising these paths; this document describes the implemented
checks, and the H6 tests are the planned expansion of their evidence.

### Symlinks and the lexical boundary

VibeRevert's repository-boundary checks (e.g. the audited cwd) are **lexical**:
they prove a path lies textually under the repository root, **not** that it is
physically confined (symlinks are not resolved). A lexical result MUST NOT be
reused as a filesystem access-control decision without stronger validation.

## Release-claim invariants (policy guidance)

VibeRevert's public claims MUST match the postures above. **These rules are
policy guidance in this milestone; they are not yet mechanically enforced --
H-FP1 turns the checkable ones into architectural-invariant tests.** Until then
they bind authors, not a CI gate.

- PTY mode MUST NOT be called **"secure"**, **"complete"**, or a **"sandbox"**.
- Copy MUST NOT say VibeRevert **"blocks"**, **"prevents"**, or **"guarantees"**
  where a contract says **"warn"** or **"best-effort"** (the guard is best-effort;
  PTY coverage is best-effort).
- Product copy MUST NOT say **"undo everything"**, **"guaranteed recovery"**,
  **"never lose work"**, or **"reverse any AI mistake"**, and MUST NOT claim to
  reverse **external effects** (deployments, databases, API calls, sent messages).
- A platform MUST NOT be claimed as **fully supported** without matching CI
  evidence. Any platform lacking that evidence MUST be explicitly qualified as
  **experimental** or **unverified**.
- An **experimental** label (e.g. `--pty`) MUST NOT be silently dropped.
- A safety claim MUST NOT contradict the rollback-limitations or the PTY
  best-effort contract.

*Principle:* slogans may dramatize the user's **pain or desired outcome**;
factual product sentences MUST stay literally defensible. Lead with the emotional
consequence; state precisely what VibeRevert records, checks, and restores.

## Reporting a vulnerability

See [`SECURITY.md`](SECURITY.md) for private reporting, scope, and the
acknowledgment target. Rollback limitations and out-of-scope external effects are
**documented behavior, not vulnerabilities**.

## Maintaining this document

Any change to rollback semantics, PTY interception coverage, the audit shape, the
archive / restore path, or the claims VibeRevert makes MUST update this document
(and, once they exist, the H-FP1 release-claim tests) in the same change.
