# ADR 0006: Session contribution and content-addressed object store

- Status: Accepted, 2026-08-23 (records a decision made in M 0.8.0 step 0; the schemas, the object store, and the git-side capture pipeline now ship, but `end` does not yet publish a contribution)
- Milestone: 0.8.0 (surgical recovery), step 0
- Related: [session format](../session-format.md), [ADR 0002: State-based rollback](0002-state-based-rollback.md); `packages/session-format/src/contribution.ts`, `packages/session-format/src/path-state.ts`, `packages/core/src/object-store.ts`, `packages/git/src/path-state.ts`, `packages/git/src/contribution.ts`

## Context

ADR 0002 established that VibeRevert restores state from a snapshot rather than
from history. That snapshot describes what existed **before** a session. Nothing
durable captures the session's contribution as exact, recoverable
before-and-after state.

The always-written end-state artifacts are `after-status.txt` and its machine
form, which carry Git status rather than content, content identities, or full
index state. A later `report.json`, when one is produced, can describe changed
files and findings, but it is an evaluation artifact rather than a recovery
oracle. Once the user edits again, neither surface can reconstruct the exact
state the session left behind.

Restore is whole-tree by construction and ends in full-set dirty parity, so no
flag can make it path-scoped.

The consequence is that "undo only the payment change this agent made" cannot be
expressed, let alone verified. Selective recovery is the visible motivation, but
the missing thing underneath it is an artifact that outlives the session.

## Decisions

### 1. A session's contribution is a durable, validated artifact

At `end`, VibeRevert persists a `SessionContributionFile` describing what the
session did: per-path operations, before and after path state, and content
deltas. The session record binds to it by path and by SHA-256 over the
serialized bytes. A session is not terminal until that artifact is persisted
under VibeRevert's existing persistence contract and validated.

This is deliberately not a durability claim. 0.8.0 does not change the project's
fsync behavior, and nothing here should be read as promising survival of a
power loss.

### 2. Path state has two independent axes, not one

A path's worktree state and its index state are recorded separately. A single
discriminant cannot express an unstaged deletion, where HEAD and the index hold
the file and the worktree does not, nor a staged deletion with a worktree file
present. Collapsing them would make those states unrepresentable rather than
merely awkward.

There is deliberately no `matches_worktree` flag: under `core.autocrlf`,
worktree bytes and blob identity are not comparable that simplistically. HEAD is
a third contextual axis and lives on the contribution header.

The guarantee covers **supported** index state: entry, blob, mode, and the
staged-versus-worktree distinction. Git's special index metadata, meaning
intent-to-add, skip-worktree, and assume-unchanged, is not preserved by the
existing checkpoint and cannot be invented by reconstruction. It is outside the
0.8.0 guarantee and stated as such.

### 3. Content lives in a content-addressed object store; the checkpoint format is untouched

Referenced content is stored by digest rather than inlined, and only the changed
subset is materialized, on both sides. The checkpoint archive format is a
shipped, migration-gated artifact designed for whole-tree pre-state capture;
0.8.0 adds a new store beside it rather than reworking it.

Writing an object is verify-or-refuse. Identical bytes at an existing digest
path succeed; different bytes at that path are corruption and are never
overwritten. Reads always verify against the requested digest.

### 4. Operation words are not a mutually exclusive verb set

`operation` mirrors the existing changed-file vocabulary rather than inventing
`mode_change` as a peer of `modify`. One change can be both content-modified and
chmodded, or both renamed and modified. A mutually exclusive enum would bake an
ambiguous model into the substrate that later milestones depend on. Orthogonal
facts live in `facets` and are derivable from the two path states.

### 5. Content delta is a discriminated union

`text` with hunks, `binary`, or `none`. The obvious alternative, an `isBinary`
flag beside optional hunks, cannot distinguish a binary content change from a
mode-only change that legitimately has no hunks. The union makes reconstruction
exact instead of inferential.

### 6. Change-group identity is a derived contract with exactly one implementation

A change group is identified by a domain-separated SHA-256 over the session id
and the canonicalized alias set, not by a random id. Two consequences follow: the
identity is reproducible from the artifact itself, and a rename's two aliases
resolve to one group without a lookup table. The derivation is exported from
`@viberevert/session-format` so a producer cannot reimplement the byte algorithm
and drift from what the schemas verify.

### 7. Consumers walk the evidence chain before mutating

Session metadata, then contribution bytes, then the contribution digest, then
each referenced object and its digest. Any break refuses before mutation rather
than partway through it.

## Alternatives considered

- **Reuse the existing since-checkpoint diff as the contribution model.** It is
  not one. Its mirror copy skips every non-regular entry on both sides, and
  diffing copied files sees no index and no git mode bits, so the two axes
  decision 2 depends on are structurally absent. It also owns and destroys its
  scratch worktree privately, so it cannot be the shared oracle.
- **Extend the checkpoint archive format to carry the after-state.** Couples a
  shipped whole-tree pre-state format to a change-scoped after-state with
  different cardinality and different lifetime, and forces a migration of an
  artifact already on users' disks.
- **Snapshot the entire after-tree.** Cost scales with repository size rather
  than with what changed, on every session end.
- **A single `kind` per path.** Rejected under decision 2: it cannot represent
  states Git produces routinely.
- **Random change-group identifiers.** Would require a persisted mapping to
  survive, and would make identity unverifiable from the artifact alone.

## Consequences

- `end` becomes measurably more expensive. Capture hashes every present tracked
  regular file, and the coherence fence repeats it. That is the same order of
  work checkpoint creation already does at `start`, so it is precedented rather
  than novel, but it is the first number worth measuring.
- Disk usage grows per session with the size of what changed, not with the size
  of the repository.
- Sessions that ended before 0.8.0 **cannot** be back-filled. Their after-state
  is gone, so selective operations refuse on missing evidence. Whole-session
  rollback continues to work unchanged for them.
- The change-group derivation becomes a format contract. Changing its bytes
  changes every id and is a breaking format change, not an implementation
  detail.
- The derived JSON Schema exports carry field shapes, not the derivation and not
  the cross-field rules. A consumer validating a contribution structurally has
  not verified its evidence, and the schema module says so explicitly.
- The substrate outlives its first consumer. Selective rollback is what 0.8.0
  builds on it, but contribution-backed checks, scope-expansion attribution, and
  anything later that needs to address a past session's work read the same
  artifact.
