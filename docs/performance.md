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

**What is NOT yet measured** is which component dominates. `end` does the raw
inventory twice, materializes the session-start checkpoint into a scratch
worktree, and derives the contribution. The worktree materialization is the
obvious suspect, since it is a full checkout rather than a hash pass, but that
is a hypothesis and no one has profiled it. Attributing the cost is the first
step for anyone optimizing this, and doing it before choosing a strategy would
avoid optimizing the wrong half.

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
