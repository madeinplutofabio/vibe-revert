# ADR 0008: End-of-session oracle materialization cost

- Status: **Open**, 2026-09-05. Substantially addressed: two fixes took 67 percent off `end` at 4000 files, from 24.3 s to 7.9 s. A reduced structural cost remains and is deferred past 0.8.0.
- Milestone: 0.8.0 (surgical recovery), step 15
- Related: [performance](../performance.md), [ADR 0006: Session contribution and object store](0006-session-contribution-and-object-store.md); `packages/git/src/checkpoint-oracle.ts`, `packages/git/src/restore.ts`

## Context

`viberevert end` is slower than it should be, and 0.8.0 ships knowing exactly
why.

The 0.8.0 plan predicted the end-of-session capture would cost about what
`viberevert start` already costs, on the grounds that both hash every present
tracked regular file. Measured, that is wrong, and the gap widens with
repository size:

| Tracked files | `start` median | `end` median | ratio |
|---:|---:|---:|---:|
| 200 | 929 ms | 3395 ms | 3.65x |
| 1000 | 1236 ms | 8419 ms | 6.81x |
| 4000 | 2367 ms | 24305 ms | 10.27x |

The plan expected the raw-byte inventory to be the cost, and named it "the first
number step 15 should measure". It is not the cost. Attributing the time
(`scripts/probe-end-phases.ts`) gives:

| Tracked files | `end` median | oracle lifecycle | oracle share | everything else |
|---:|---:|---:|---:|---:|
| 200 | 3401 ms | 1898 ms | 56% | 1503 ms |
| 1000 | 8643 ms | 6522 ms | 75% | 2121 ms |
| 4000 | 23718 ms | 17972 ms | 76% | 5746 ms |

"Everything else" contains BOTH raw inventories, rename derivation, mirror
diffing, contribution assembly and persistence. Splitting the oracle further:

| Tracked files | `git worktree add` | `restoreCheckpoint` | teardown |
|---:|---:|---:|---:|
| 200 | 195 ms | 1599 ms | 75 ms |
| 1000 | 560 ms | 5148 ms | 185 ms |
| 4000 | 1971 ms | 18572 ms | 605 ms |

`restoreCheckpoint` into the scratch worktree is 79 to 88 percent of the oracle
lifecycle, and therefore roughly two thirds of everything `end` does.

## Why it costs what it costs

The oracle materializes the entire pre-session tree so that BEFORE state can be
observed for the handful of paths a session actually changed. Building it
touches every tracked file three times:

1. `git worktree add --detach` checks out every file at the captured HEAD.
2. `restoreTrackedDirtyContent` then rewrites the exact captured bytes of every
   entry in `snapshots.file_hashes`, which is every present tracked regular
   file, dirty and clean. This exists because git's clean and smudge filters can
   re-materialize content with different line endings than were captured.
3. Post-restore verification hashes every captured file again, on both the
   tracked and untracked sides.

So a session that edited one file in a 4000-file repository writes 8000 files
and hashes 4000 more, to learn about one.

## Fix one: bounded concurrency

A CPU profile of one `end` on the 4000-file fixture was **82 percent idle**.
The loops that walk every tracked file were issuing one `await`ed filesystem
call per iteration, so libuv's thread pool held a single request at a time.
Measured, 4000 files, one read plus one write each: 4305 ms sequential against
641 ms at four in flight, flat beyond.

Bounded concurrency was applied to the post-restore hash verification, the
tracked-content copy, and the raw-byte inventory scan, and the per-file
recursive `mkdir` was hoisted out of the copy loop. Same paths reconstructed,
same paths verified, payloads still consumed rather than retained so memory
stays bounded by the concurrency limit.

Two contracts were preserved deliberately. Results and failures are ordered by
INPUT index rather than by completion, so an error naming a path is
reproducible across runs. And the caller-injected `storeObject` sink in
`contribution.ts` is wrapped so it is still invoked one call at a time:
observation was parallelized, the sink's contract was not silently widened into
"must be reentrant", which no existing caller agreed to.

Result on the identical benchmark: `end` at 4000 files went 24305 ms to
19206 ms, a 21 percent improvement, and the `end`/`start` ratio fell from
10.27x to 7.77x.

**It was not enough.** 19 seconds for 4000 small files is still slow, and the
fix was to the constant factor rather than to the shape.

## Fix two: a fresh-worktree oracle path

The scoped-oracle design is blocked on ordering, as stated below. But the
oracle's own caller licenses a narrower change that needs no restructure.

`withCheckpointOracle` has just run `git worktree add --detach` at the captured
HEAD. At the moment the checkpoint is materialized the worktree is therefore
known to be clean, at the right commit, and free of untracked files.
`restoreCheckpoint` cannot assume any of that, because its real caller is
`viberevert rollback` against a live repository that may be in any state. Those
are different preconditions, and the general function was paying for the
general case in a place where it does not apply.

`materializeCheckpointIntoFreshWorktree` is the same restore under those
starting conditions. It skips the `git reset --hard` and the uncaptured-untracked
delete sweep, both provable no-ops in a fresh worktree at the captured HEAD, and
it replaces the unconditional rewrite of every captured path with a hash of every
tracked path followed by a restore of only the paths whose bytes actually
differ. Preflight, archive validation, patch replay, untracked conflict
handling, tracked-dirty parity and the full post-restore hash verification are
unchanged, and there is no `allowHeadMismatch`. It is package-internal, has
exactly one caller, and a barrel-guard test asserts both.

Phase timing on the 4000-file fixture, same scratch worktree, via
`VIBEREVERT_PROFILE_RESTORE`:

| Phase | `restoreCheckpoint` | fresh-worktree path |
|---|---:|---:|
| tracked hash scan | (not separated) | 3582 ms |
| tracked dirty parity | 8476 ms | 74 ms |
| final hash verify | 238 ms | 238 ms |
| preflight and archives | 124 ms | 124 ms |
| patch replay | 40 ms | 40 ms |
| tracked byte restore | (whole set) | 0 ms |
| **total** | **16704 ms** | **4059 ms** |

**The parity collapse from 8476 ms to 74 ms confirms the mechanism.** Parity is
a `git` call. Rewriting every tracked file invalidated git's stat cache, so the
parity call that followed re-read every file to conclude nothing had changed.
Not rewriting files that already hold the correct bytes leaves the cache intact.

Both hash passes were kept. Collapsing the new scan into the final verify was
considered and rejected: the verify costs 238 ms once the cache is warm, and
that is not worth a real post-restore guarantee.

Result on the identical benchmark: `end` at 4000 files went 19206 ms to
7922 ms, and the `end`/`start` ratio to 3.37x. Against the original shipped
figure that is 67 percent faster. `@viberevert/git` passes 757 tests unchanged,
plus a new invariant test for the single-caller rule.

**This clears the threshold that made the release a blocker**, so the
checkpoint archive format is not reopened in 0.8.0.

## The remaining obstacle, stated precisely

A scoped oracle needs to know which paths to reconstruct. The candidate set is
not fully known until the live tree has been hashed, because a file git
considers clean can still have raw bytes that differ from the captured
inventory, and any such file is a candidate. That hashing happens inside the
oracle callback today, so the oracle cannot be scoped to a set that does not
exist when it is created.

Hoisting the live acquisition out of the oracle is what unlocks the scoped
design, and it is a restructure of the contribution-capture ordering rather
than a local change. It also has a subtlety worth naming in advance: the static
candidate sources currently include the oracle's own `git status`, whose rename
aliases are not obviously reproducible from the manifest alone.

## Decision

**Ship 0.8.0 with the two fixes above and the reduced remaining cost,
documented. Defer the scoped oracle.**

An earlier revision of this ADR framed the choice as between two architectural
changes, and listed "an oracle-specific restore mode that skips post-restore
verification and the unconditional byte rewrite" as the cheap, unsafe option.
That framing conflated two independent things, and taking them apart is what
made fix two possible:

- **Skipping the unconditional byte rewrite** is safe when the target worktree
  was just checked out at the captured HEAD, because the bytes are then verified
  against the captured hashes and only the differing ones are written. Nothing
  is assumed; the difference is measured.
- **Skipping post-restore verification** is the unsafe half, and it was not
  done. The oracle IS the evidence the contribution is derived from, so an
  unverified oracle silently produces a wrong contribution rather than failing.

What remains deferred is the real structural fix:

- **A cheaper oracle.** Read BEFORE content per path out of the checkpoint's
  archives instead of materializing the whole tree, making the cost proportional
  to what the session changed rather than to repository size. It replaces the
  oracle's central abstraction, which several 0.8.0 subsystems depend on, and it
  is blocked on the ordering problem above.

That does not belong in a milestone that is otherwise complete and green. The
0.8.0 plan set the correct order: correctness first, one oracle, measure. The
measurement is done, it pointed somewhere the plan did not expect, and it was
acted on twice.

## Consequences

- `viberevert end` still costs more on a large repository than on a small one,
  and this is a stated beta limitation rather than a surprise. See
  [performance](../performance.md) and the changelog.
- The two raw inventories, which the plan flagged as the latency risk, are still
  not worth optimizing. They sit inside "everything else", which is now roughly
  a quarter of the total and barely grows with file count.
- **`restoreCheckpoint` and the oracle path have diverged.** They are two
  functions with a large shared body and different preconditions, and a change
  to the restore contract now has two call sites to satisfy. The invariant test
  pinning the fresh-worktree function to one caller exists so that divergence
  stays bounded rather than spreading.
- **There is now permanent, env-gated phase instrumentation** in
  `packages/git/src/restore-profile.ts`. It is a no-op unless
  `VIBEREVERT_PROFILE_RESTORE` is set. It was kept rather than deleted because
  attributing this cost from the outside got the answer wrong once already, and
  a measurement nobody can reproduce is not evidence.
- **Attribution below the oracle level is now good.** The replicated split
  tracks the measured lifecycle within 3 to 6 percent, improved from 10 to 20,
  because the replication was updated to call the same function production
  calls.
- All measurements are one machine, one platform. Windows filesystem calls are
  slower than Linux for this workload, so these figures are closer to a
  pessimistic bound than a typical one. No cross-platform comparison exists.

## Reopening criteria

Revisit when any of these holds:

- a user reports `end` latency as a practical problem on a real repository;
- a cross-platform measurement shows the cost is not Windows-specific;
- selective restore's own latency becomes a concern, since it builds the same
  oracle through the same lifecycle;
- a repository is measured where `tracked byte restore` is not near zero, since
  that is the case fix two does not help and it would move the ceiling back
  toward the archive format.
