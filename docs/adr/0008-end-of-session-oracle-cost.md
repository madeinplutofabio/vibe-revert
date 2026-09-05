# ADR 0008: End-of-session oracle materialization cost

- Status: **Open**, 2026-09-05. Partially addressed: a concurrency fix took 21 percent off `end` at 4000 files. The STRUCTURAL cost remains and is deferred past 0.8.0.
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

## What was fixed, and what it was worth

A CPU profile of one `end` on the 4000-file fixture was **82 percent idle**.
The loops that walk every tracked file were issuing one `await`ed filesystem
call per iteration, so libuv's thread pool held a single request at a time.
Measured, 4000 files, one read plus one write each: 4305 ms sequential against
641 ms at four in flight, flat beyond.

Bounded concurrency was applied to the post-restore hash verification, the
tracked-content copy, and the raw-byte inventory scan, and the per-file
recursive `mkdir` was hoisted out of the copy loop. Same paths reconstructed,
same paths verified, payloads still consumed rather than retained so memory
stays bounded by the concurrency limit. All 757 `@viberevert/git` tests pass
unchanged.

Result on the identical benchmark: `end` at 4000 files went 24305 ms to
19206 ms, a 21 percent improvement, and the `end`/`start` ratio fell from
10.27x to 7.77x.

**It is not enough.** 19 seconds for 4000 small files is still slow, and the
fix was to the constant factor rather than to the shape. One changed path still
causes a complete checkout, rewrite and verification of every tracked file.

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

**Ship 0.8.0 with the remaining cost, documented, and defer the structural
fix.**

Reducing it means one of two changes, and both are architectural rather than
local:

- **A cheaper oracle.** Read BEFORE content per path out of the checkpoint's
  archives instead of materializing the whole tree. This is the real fix, since
  it makes the cost proportional to what the session changed rather than to
  repository size. It replaces the oracle's central abstraction, which several
  0.8.0 subsystems depend on.
- **An oracle-specific restore mode** that skips post-restore verification and
  the unconditional byte rewrite. Cheaper to build, but it weakens the property
  that makes the oracle trustworthy: the oracle IS the evidence the contribution
  is derived from, and an unverified oracle silently produces a wrong
  contribution rather than failing. The verification also exists for a measured
  reason (line-ending drift), so removing it needs its own evidence.

Neither belongs in a milestone that is otherwise complete and green. The 0.8.0
plan set the correct order: correctness first, one oracle, measure. The
measurement is now done and it points somewhere the plan did not expect.

## Consequences

- `viberevert end` is slow on large repositories, and this is a stated beta
  limitation rather than a surprise. See [performance](../performance.md) and
  the changelog.
- The two raw inventories, which the plan flagged as the latency risk, are not
  worth optimizing. Anyone who starts there will spend effort on at most a
  quarter of the total and probably much less.
- **Attribution is not yet complete below the oracle level.** The split above
  replicates the lifecycle rather than instrumenting it, and its sum tracks the
  measured lifecycle within roughly 10 to 20 percent. It is sound enough to
  identify the dominant component and should not be quoted more precisely than
  that.
- All measurements are one machine, one platform. Windows filesystem calls are
  slower than Linux for this workload, so these figures are closer to a
  pessimistic bound than a typical one. No cross-platform comparison exists.

## Reopening criteria

Revisit when any of these holds:

- a user reports `end` latency as a practical problem on a real repository;
- a cross-platform measurement shows the cost is not Windows-specific;
- selective restore's own latency becomes a concern, since it builds the same
  oracle and will inherit the same cost.
