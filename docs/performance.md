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

| Tracked files | Total bytes | `start` median | `start` p95 | `end` median | `end` p95 | `end`/`start` |
|---:|---:|---:|---:|---:|---:|---:|
| 200 | 198 KiB | 929 ms | 954 ms | 3395 ms | 3673 ms | 3.65x |
| 1000 | 989 KiB | 1236 ms | 1285 ms | 8419 ms | 9224 ms | 6.81x |
| 4000 | 3960 KiB | 2367 ms | 2421 ms | 24305 ms | 25844 ms | 10.27x |

Median rather than mean, because one scheduler stall or antivirus scan drags a
mean around and says nothing about typical cost. The p95 is reported precisely
because it is the part a mean hides. At 5 runs per size the p95 is the slowest
observed run, so read it as a worst case seen, not a distribution estimate.

### What the numbers say

**The milestone plan's expectation was wrong, and measurably so.** It predicted
that the end-of-session inventory would be "the same order of work
`createCheckpoint` already does at `start`, so it is precedented rather than
novel". It is not the same order, and the gap widens with repository size:
3.65x at 200 files, 6.81x at 1000, 10.27x at 4000.

The two commands scale differently. Across a 20x increase in file count `start`
grew 2.5x, so it is dominated by fixed cost. `end` grew 7.2x over the same
range: still sublinear in file count, but nearly three times as size-sensitive
as `start`.

**In absolute terms, 4000 files is a small repository and `end` already takes
24 seconds.** That is the finding worth acting on. The plan deliberately
deferred any optimization until there was evidence it was needed, on the
grounds that incremental capture would undermine the agent-independent model.
That evidence now exists.

## Where that time goes

Attributed with `pnpm tsx scripts/probe-end-phases.ts`, same machine and
fixtures, 3 runs per size.

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

**`restoreCheckpoint` into the scratch worktree is the cost.** It is 79 to 88
percent of the oracle lifecycle, and therefore roughly two thirds of everything
`end` does.

**The plan's suspicion was misdirected.** It named the raw-byte inventory as the
latency risk and "the first number step 15 should measure". The inventories are
inside "everything else", which never exceeds a quarter of the total and is
usually far less. Optimizing there would be effort spent on the wrong component.

The reason is structural: the oracle materializes the entire pre-session tree so
BEFORE state can be read for the few paths a session changed, and building it
touches every tracked file three times. `git worktree add` checks out every
file, `restoreTrackedDirtyContent` then rewrites the captured bytes of every
entry in `snapshots.file_hashes`, which is every present tracked regular file,
and post-restore verification hashes them all again. A session that edited one
file in a 4000-file repository writes 8000 files and hashes 4000 more.

**This is a known limitation of 0.8.0, not a defect being hidden.** Fixing it
means either a cheaper oracle that reads BEFORE content per path instead of
materializing the whole tree, or an oracle-specific restore mode that skips
verification, and both are architectural changes to a safety-critical path. The
decision to ship with the cost, and the criteria for reopening it, are recorded
in [ADR 0008](adr/0008-end-of-session-oracle-cost.md).

### A caveat on the split

The three-step table REPLICATES the oracle's sequence rather than instrumenting
it, using the same primitives the production function calls. The script checks
its sum against the independently measured lifecycle, and the two agree within
roughly 10 to 20 percent. That is sound enough to identify the dominant
component and should not be quoted more precisely than that.

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
