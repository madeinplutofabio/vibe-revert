// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Bounded-concurrency mapping for filesystem work.
//
// PACKAGE-INTERNAL. Not re-exported from `src/index.ts`.
//
// =============================================================================
// Why this exists
// =============================================================================
//
// Several loops in this package walk every tracked file and `await` one
// filesystem call per iteration. That shape is easy to read and, on a large
// repository, extremely slow: each `await` is a full round trip through
// libuv's thread pool with nothing else in flight, so the pool sits idle
// waiting for one answer at a time.
//
// Measured on the reference machine, 4000 small files, one read plus one write
// each:
//
//     sequential await   4305 ms
//     concurrency 4       641 ms
//     concurrency 8       636 ms
//     concurrency 16      674 ms
//     concurrency 32      621 ms
//
// The entire win arrives at 4, which is `UV_THREADPOOL_SIZE`'s default, and
// the curve is flat after that. A CPU profile of `viberevert end` on the same
// fixture was 82 percent idle, which is what waiting one syscall at a time
// looks like from the inside.
//
// =============================================================================
// What this does NOT change
// =============================================================================
//
// Nothing about WHICH paths are touched, WHAT is written, or WHAT is verified.
// It changes only how many of the same operations are in flight at once.
// Results are returned in INPUT ORDER regardless of completion order, so any
// caller that builds a list from them stays deterministic.
//
// Use it only where the per-item work is genuinely independent. Loops with
// ordering semantics between items, such as the ancestors-before-descendants
// walk in `clearExtractionPathConflicts`, must stay sequential.

/**
 * The default in-flight limit.
 *
 * 16 rather than 4: the measured win saturates at the thread pool's default
 * size, and a slightly higher number keeps the pool busy if a host raises
 * `UV_THREADPOOL_SIZE` without needing a change here. It stays small because
 * some callers hold a whole file's bytes per in-flight item, and an unbounded
 * `Promise.all` over a large repository would hold all of them at once.
 */
export const DEFAULT_FS_CONCURRENCY = 16;

/**
 * Map `items` through `fn` with at most `limit` calls in flight.
 *
 * Results come back in INPUT ORDER. The first rejection propagates, matching
 * `Promise.all`; work already in flight is allowed to settle rather than being
 * cancelled, because these are filesystem operations with no cancellation
 * story and abandoning them mid-write would be worse than letting them finish.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = DEFAULT_FS_CONCURRENCY,
): Promise<R[]> {
  if (items.length === 0) return [];
  const effective = Math.max(1, Math.min(limit, items.length));

  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      // `items[index]` is in range by the guard above; the non-null assertion
      // is avoided by reading through a local that TypeScript can narrow.
      const item = items[index] as T;
      results[index] = await fn(item, index);
    }
  };

  await Promise.all(Array.from({ length: effective }, worker));
  return results;
}
