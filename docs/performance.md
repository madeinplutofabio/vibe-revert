# Performance characterization

Measured numbers for the operations whose cost scales with repository size.

**These are characterization, not guarantees and not a gate.** Nothing in CI
enforces a latency threshold, and none of these figures is a promise. They exist
so that a decision about optimizing is made against evidence rather than
intuition, and so a user can predict roughly what a large repository will cost
them.

Reproduce with:

```bash
pnpm build && pnpm tsx scripts/bench-end-latency.ts
```

Attribute the result with:

```bash
pnpm tsx scripts/probe-end-phases.ts --sizes "200,1000,4000"
```

For a phase breakdown inside the checkpoint materialization itself, set
`VIBEREVERT_PROFILE_RESTORE=1`. It is off by default, writes to stderr, and
changes no behavior.

## End-of-session latency

`viberevert end` captures the session's contribution. To find the candidate set
it takes a raw SHA-256 of every present tracked regular file, then repeats that
inventory at the coherence fence, and it materializes the session-start
checkpoint into a scratch worktree to derive the changes against. All of that is
proportional to repository content rather than to what the session changed, so a
session that edited one file still pays the full cost.

### Environment

- platform: win32 x64
- node: v24.13.1
- cpu: AMD Ryzen 9 5900X, 24 logical
- memory: 128 GiB
- measured: 2026-09-05
- fixture: N tracked files of about 1 KiB each, one file edited per session
- 5 runs per size, fresh session each run

### Results

Current, after both optimizations described below:

| Tracked files | Total bytes | `start` median | `start` p95 | `end` median | `end` p95 | `end`/`start` |
|---:|---:|---:|---:|---:|---:|---:|
| 200 | 198 KiB | 948 ms | 958 ms | 2099 ms | 2323 ms | 2.21x |
| 1000 | 989 KiB | 1239 ms | 1332 ms | 3638 ms | 4283 ms | 2.94x |
| 4000 | 3960 KiB | 2354 ms | 2382 ms | 7922 ms | 9883 ms | 3.37x |

`end` median across all three stages, same script, same fixtures, same machine:

| Tracked files | Original | After concurrency | After fresh-worktree oracle | Total change |
|---:|---:|---:|---:|---:|
| 200 | 3395 ms | 3250 ms | 2099 ms | 38% faster |
| 1000 | 8419 ms | 7174 ms | 3638 ms | 57% faster |
| 4000 | 24305 ms | 19206 ms | 7922 ms | 67% faster |

Median rather than mean, because one scheduler stall or antivirus scan drags a
mean around and says nothing about typical cost. The p95 is reported precisely
because it is the part a mean hides. At 5 runs per size the p95 is the slowest
observed run, so read it as a worst case seen, not a distribution estimate.

### What the numbers said, and what changed

**The milestone plan's expectation was wrong, and measurably so.** It predicted
that the end-of-session inventory would be "the same order of work
`createCheckpoint` already does at `start`, so it is precedented rather than
novel". As shipped it was not the same order, and the gap widened with
repository size: 3.65x at 200 files, 6.81x at 1000, 10.27x at 4000. At 4000
files, which is a small repository, `end` took 24 seconds.

The plan deliberately deferred optimizing until there was evidence it was
needed. That evidence arrived, and two changes followed: bounded concurrency
for the per-file loops, then a fresh-worktree oracle path. Together they took
`end` at 4000 files from 24.3 seconds to 7.9, and the `end`/`start` ratio from
10.27x to 3.37x.

The ratio still grows with repository size, from 2.21x to 3.37x across a 20x
file-count range, so `end` remains the more size-sensitive of the two. It is no
longer growing at a rate that makes a small repository expensive.

## Where that time goes

Attributed with `pnpm tsx scripts/probe-end-phases.ts`, same machine and
fixtures, 3 runs per size.

As originally shipped:

| Tracked files | `end` median | oracle lifecycle | oracle share | everything else |
|---:|---:|---:|---:|---:|
| 200 | 3401 ms | 1898 ms | 56% | 1503 ms |
| 1000 | 8643 ms | 6522 ms | 75% | 2121 ms |
| 4000 | 23718 ms | 17972 ms | 76% | 5746 ms |

The oracle lifecycle is measured by running the real `withCheckpointOracle` with
an empty callback, so the figure is exactly create plus tear down and nothing
else. "Everything else" is the remainder, and it contains BOTH raw inventories,
rename derivation, mirror diffing, contribution assembly and persistence
together.

Splitting the lifecycle into its three steps:

| Tracked files | `git worktree add` | `restoreCheckpoint` | teardown |
|---:|---:|---:|---:|
| 200 | 195 ms | 1599 ms | 75 ms |
| 1000 | 560 ms | 5148 ms | 185 ms |
| 4000 | 1971 ms | 18572 ms | 605 ms |

**Materializing the checkpoint into the scratch worktree was the cost.** It was
79 to 88 percent of the oracle lifecycle, and therefore roughly two thirds of
everything `end` did.

**The plan's suspicion was misdirected.** It named the raw-byte inventory as the
latency risk and "the first number step 15 should measure". The inventories are
inside "everything else", which never exceeds a quarter of the total and is
usually far less. Optimizing there would have been effort spent on the wrong
component.

The reason was structural: the oracle materializes the entire pre-session tree
so BEFORE state can be read for the few paths a session changed, and building it
touched every tracked file three times. `git worktree add` checks out every
file, `restoreTrackedDirtyContent` then rewrote the captured bytes of every
entry in `snapshots.file_hashes`, which is every present tracked regular file,
and post-restore verification hashed them all again. A session that edited one
file in a 4000-file repository wrote 8000 files and hashed 4000 more.

The same attribution after both fixes:

| Tracked files | `end` median | oracle lifecycle | oracle share | everything else |
|---:|---:|---:|---:|---:|
| 200 | 2049 ms | 642 ms | 31% | 1407 ms |
| 1000 | 3832 ms | 1969 ms | 51% | 1863 ms |
| 4000 | 9163 ms | 7018 ms | 77% | 2146 ms |

| Tracked files | `git worktree add` | fresh-worktree materialize | teardown |
|---:|---:|---:|---:|
| 200 | 192 ms | 334 ms | 78 ms |
| 1000 | 570 ms | 1163 ms | 182 ms |
| 4000 | 1947 ms | 4228 ms | 606 ms |

The shape of the problem has changed. `git worktree add`, which was 11 percent
of the lifecycle, is now 28 percent of it, and "everything else" barely grows
with file count at all. What remains inside the materialize step is dominated by
hashing rather than by writing.

### Fix one: waiting one syscall at a time

A CPU profile of a single `end` on the 4000-file fixture was **82 percent
idle**. Only about 4 seconds of 22.5 was computation; the rest was waiting.

The cause was sequential `await` per file. Several loops walked every tracked
file issuing one filesystem call per iteration, so libuv's thread pool sat idle
holding a single request. Measured on this machine, 4000 files, one read plus
one write each:

| In flight | Time |
|---:|---:|
| 1 (sequential await) | 4305 ms |
| 4 | 641 ms |
| 8 | 636 ms |
| 16 | 674 ms |
| 32 | 621 ms |

The whole win arrives at 4, which is `UV_THREADPOOL_SIZE`'s default, and the
curve is flat after. Three loops now use bounded concurrency: the post-restore
hash verification, the tracked-content copy, and the raw-byte inventory scan.
The per-file recursive `mkdir` in the copy loop was also hoisted, since a flat
directory of N files was paying N-1 syscalls that could not create anything.

**Nothing about what is touched, written, or verified changed.** The same paths
are reconstructed and the same paths are verified; only the number of requests
in flight differs. Payloads are still consumed as they are produced rather than
retained, so peak memory is bounded by the concurrency limit instead of by
repository size. All 757 tests in `@viberevert/git` pass unchanged.

### Fix two: stop rewriting files that already have the right bytes

Concurrency made the work faster, not smaller. One changed path still caused a
complete checkout, a rewrite of every tracked file, and verification of every
tracked file, which is why 4000 files still cost 19 seconds afterwards.

The scoped-oracle design is blocked on ordering, as described below, but the
oracle's callers turned out to license a narrower change that needs no
restructure at all. `withCheckpointOracle` has just run `git worktree add
--detach` at the captured HEAD, so at the moment the checkpoint is materialized
the worktree is known to be clean, at the right commit, and free of untracked
files. `restoreCheckpoint` cannot assume any of that, because its real caller is
`viberevert rollback` against a live repository that may be anywhere.

`materializeCheckpointIntoFreshWorktree` is the same restore under those
starting conditions:

- the `git reset --hard` is skipped, since the worktree is already at that
  commit with a clean index;
- the sweep that deletes uncaptured untracked files is skipped, since a fresh
  worktree has none;
- the unconditional rewrite of every captured path becomes a hash of every
  tracked path followed by a restore of only the paths whose bytes differ.

Preflight, archive validation, patch replay, untracked conflict handling,
tracked-dirty parity and the full post-restore hash verification are all
unchanged. There is no `allowHeadMismatch` and no weakened verification: the
function refuses exactly what `restoreCheckpoint` refuses.

Measured with `VIBEREVERT_PROFILE_RESTORE=1` on the 4000-file fixture, before
and after, in the same scratch worktree:

| Phase | `restoreCheckpoint` | fresh-worktree path |
|---|---:|---:|
| tracked hash scan | (not separated) | 3582 ms |
| tracked dirty parity | 8476 ms | 74 ms |
| final hash verify | 238 ms | 238 ms |
| preflight and archives | 124 ms | 124 ms |
| patch replay | 40 ms | 40 ms |
| tracked byte restore | (whole set) | 0 ms |
| **total** | **16704 ms** | **4059 ms** |

**The parity collapse from 8476 ms to 74 ms is the interesting number, and it
confirms the mechanism.** Parity is a `git` call, not a filesystem walk.
Rewriting every tracked file invalidated git's stat cache, so the parity call
that followed had to re-read every file to decide it was unchanged. Not
rewriting files that already hold the correct bytes leaves the stat cache intact
and the same call becomes nearly free.

`tracked byte restore` is 0 ms because on this fixture the checkout already
produces the captured bytes for every path, so nothing needs restoring. A
repository where line-ending filters do change content on checkout would pay
there instead, which is exactly the case the byte restore exists for.

**Both hash passes were kept.** Collapsing the new scan and the final verify
into one was considered and rejected: the final verify costs 238 ms once the
cache is warm, and trading a genuine post-restore guarantee for a saving that
small is a bad exchange.

### What is still not fixed

**The structural cost is reduced, not removed.** One changed path still causes a
complete checkout of every tracked file and a hash of every tracked file. What
no longer happens is the rewrite, and the stat-cache invalidation it caused.

Removing the rest means the oracle must reconstruct only the paths whose BEFORE
state is actually needed. The obstacle is ordering rather than difficulty: the
candidate set is not fully known until the live tree has been hashed, and that
hashing currently happens inside the oracle callback, so the oracle cannot be
scoped to a set that does not exist yet. Hoisting the live acquisition out of
the oracle is what makes a scoped oracle possible, and it is a restructure of
the contribution-capture path rather than a local change.

**This is a known limitation of 0.8.0, not a defect being hidden.** The
decision, the remaining design, and the criteria for reopening are recorded in
[ADR 0008](adr/0008-end-of-session-oracle-cost.md).

### A caveat on the split

The three-step table REPLICATES the oracle's sequence rather than instrumenting
it, using the same primitives the production function calls. The script checks
its sum against the independently measured lifecycle. On the original figures
the two agreed within roughly 10 to 20 percent; on the current ones they agree
within 3 to 6 percent. Either way it identifies the dominant component and
should not be quoted more precisely than that.

The phase breakdown INSIDE the materialize step is a different mechanism: it is
real instrumentation in `packages/git/src/restore-profile.ts`, enabled by
setting `VIBEREVERT_PROFILE_RESTORE` to any non-empty value. It is off by
default, feeds no decision, and changes no behavior.

The two raw inventories are not measured separately from each other. Doing so
would need instrumentation inside production code for a component bounded above
by a quarter of the total, and the conclusion does not depend on it.

### Caveats

- One machine, one platform, one filesystem. Windows filesystem calls are
  slower than Linux for this kind of workload, so these figures are closer to a
  pessimistic bound than a typical one. No cross-platform comparison has been
  measured.
- Uniform ~1 KiB text files. A repository of the same file count with large
  binaries, deep directory nesting, or many untracked files would behave
  differently.
- The fixture edits exactly one file per session. That is deliberate, since the
  cost being characterized is the part that does not depend on the edit, but it
  means these numbers do not describe a session with thousands of changes.
- No warm-up run is discarded, and no attempt is made to control for filesystem
  cache state between sizes.
