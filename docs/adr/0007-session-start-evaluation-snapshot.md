# ADR 0007: Session-start evaluation snapshot

- Status: Accepted, 2026-08-23 (records a decision made in M 0.8.0 step 0; the schema ships, the producer does not yet exist)
- Milestone: 0.8.0 (surgical recovery), step 0
- Related: [session format](../session-format.md), [ADR 0003: Deterministic risk classification](0003-deterministic-risk-classification.md), [ADR 0006: Session contribution and object store](0006-session-contribution-and-object-store.md); `packages/session-format/src/evaluation-snapshot.ts`

## Context

`.viberevert.yml` configures which checks run, what risk level blocks, what
paths rollback excludes, and, from 0.8.0, what commands verify the project after
a selective restore.

That file lives in the repository, which means **the agent VibeRevert is wrapping
can edit it during its own session**. Nothing prevents it. It is an ordinary
tracked file, and an agent asked to "make the checks pass" has an obvious and
entirely mechanical path to doing so.

Trusting live configuration at evaluation time therefore produces two distinct
safety inversions:

- **The evaluation inversion.** An agent sets `checks: { payments: false }`
  mid-session, and `viberevert check` before `end` reports clean because the
  agent turned off the check that would have caught it.
- **The recovery inversion.** An agent rewrites `verify.commands`, and rollback
  executes an agent-chosen command at the exact moment a human is trying to
  recover from that agent's work. This is worse than the first: the tool would
  be running agent-influenced commands during the recovery operation the user
  reached for because they no longer trust the agent.

The second is not hypothetical in the ordinary sense. It requires no
adversarial intent, only an agent that edited a config file and a user who later
ran `rollback`.

The relevant repository fact is that the configuration is already fully resolved
before a session begins: session start holds a validated config, merged with
defaults, before any agent runs.

## Decisions

### 1. Session start persists a resolved evaluation snapshot

At `start`, VibeRevert records the **resolved** evaluation inputs: risk
thresholds, the complete check toggle set after defaults, the framework
resolution, the rollback exclude list, and the project verification commands.

Resolved, not sparse. A snapshot that omitted an unmentioned toggle would
reintroduce exactly the ambiguity resolution removes: a reader could not
distinguish "explicitly disabled" from "not mentioned".

### 2. The snapshot is embedded in the session record, not a separate file

It has the same lifetime, the same writer, and the same reader as `session.json`.
Embedding it avoids a second persistence and synchronization surface for state
that has no independent lifetime or identity. `SESSION_STATE_SCHEMA_VERSION`
owns its evolution, and there is no `evaluation_snapshot_path` or independent
integrity binding.

### 3. Session-bound evaluation always reads the snapshot, never live config

This holds for active sessions, for ended sessions, and for selective rollback.
A session's own configuration is fixed at the moment it started.

Bases that are not session-bound, meaning an ad-hoc git ref or a bare
checkpoint, continue to read live configuration exactly as today. There is no
session whose configuration could have been tampered with, so there is nothing
to freeze.

### 4. Frameworks are snapshotted for audit but resolved by union

Frameworks are the one input that is partly configuration and partly
repository-derived evidence: when the configured list is absent or empty,
VibeRevert detects frameworks from the repository. Freezing the start-time
detection would create a third inversion, the mirror of the first: an agent
introduces a framework mid-session and its framework-specific checks never
activate, because detection ran before the framework existed.

So:

- **Explicit mode** snapshots the configured list and uses it verbatim. An
  explicit list is a human decision, and unioning detection into it would
  override that decision.
- **Auto mode** snapshots `detected_at_start` for audit, and evaluation uses the
  union of that with the end-state detection: current detection for an active
  session, and the contribution's `detected_frameworks_at_end` for an ended one.

The union is what makes both directions safe. Adding a framework activates its
rules; deleting a framework signature cannot make its risk rules disappear.

End-state detection deliberately does not run against a changed-files-only view.
Detection needs companion paths that are frequently unchanged, so it reads a
wider observation set captured at end. That is why `detected_frameworks_at_end`
lives on the contribution rather than in this snapshot: it is an observation of
the end state, not a session-start input.

### 5. Verification commands are structured argv

`{ command, args }`, not a shell string. With no shell, `"npm test"` is not an
executable, and something would have to tokenize it. The object form also leaves
room for `name`, `cwd`, and `timeout` later as backward-compatible optional
fields, without replacing the representation.

The command list is an ordered **sequence** and is not canonicalized. Sorting or
deduplicating it would silently change execution behavior. The exclude list, by
contrast, is an unordered **set** and is stored sorted and deduplicated.

### 6. The snapshot does not change what `rollback.exclude` governs

The existing restore contract applies the exclude list to the **untracked
surface only**; tracked changes are captured and restored even when their paths
match an exclude pattern. Snapshotting the list changes which values are used,
not what they apply to. Broadening it would break the property that selecting
every contribution unit is equivalent to a full-session restore.

## Alternatives considered

- **Read live configuration at evaluation time.** The status quo, and the source
  of both inversions above.
- **Hash the configuration at start and refuse if it changed.** Turns a
  legitimate mid-session config edit into a hard failure, still leaves open what
  to evaluate against, and does nothing for a session that already ended.
- **Snapshot the raw configuration source rather than the resolved view.**
  Re-running the merge later would re-run framework detection and default
  resolution at the wrong moment, which is the behavior being eliminated.
- **A separate `evaluation-snapshot.json`.** Rejected because it would split one
  session record across two coordinated files, creating another persistence,
  synchronization, and compatibility surface for state with no independent
  lifetime or identity.
- **Freeze the framework list along with everything else.** Rejected under
  decision 4: it converts a safety measure into a way to hide new frameworks.

## Consequences

- A session that rewrites `verify.commands` or disables a check mid-session
  influences neither its own bound evaluation nor any later selective rollback.
  That is the point.
- A **legitimate** mid-session configuration change also does not take effect for
  that session. This is a real cost, accepted deliberately: the alternative
  cannot distinguish a legitimate edit from a self-serving one, and the failure
  directions are not symmetric.
- Sessions started before 0.8.0 and still active at upgrade have no snapshot.
  Path-based selective restore remains available to them; the risk and finding
  selectors, project verification commands, and snapshot-bound checks do not.
  For those sessions the untracked exclude policy falls back to the exclude list
  their own checkpoint recorded at capture time, so the policy source is defined
  rather than implied.
- Reproducing an auto-mode evaluation needs two artifacts, not one: this
  snapshot and the contribution's end-state detection. A snapshot alone is
  sufficient only for explicit mode.
- The snapshot is larger and more redundant than the configuration file it came
  from, because it is the resolved view. That redundancy is what makes it
  readable without re-running resolution logic.
