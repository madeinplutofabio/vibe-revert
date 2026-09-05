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
 * Results come back in INPUT ORDER.
 *
 * FAILURE IS DETERMINISTIC BY INPUT INDEX, which `Promise.all` does not give
 * you: it rejects with whichever promise settles first, so the same broken
 * repository could report a different path on each run purely because of
 * scheduling. Here the lowest-index failure always wins, so an error message
 * naming a path is reproducible.
 *
 * On the first failure, workers stop pulling NEW items and everything already
 * in flight is allowed to settle. That is safe for the "lowest index" claim
 * because items are dispatched in increasing index order: any index below the
 * failing one has already been dispatched and will finish. It also matters
 * that in-flight work is not abandoned, since these are filesystem operations
 * with no cancellation story and stopping mid-write would be worse than
 * finishing.
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

  // COLLECTED, not tracked in a single mutable slot. A slot would let
  // TypeScript narrow it from the loop guard and then read the narrowed type
  // in the catch, which is unsound here anyway: another worker can assign
  // between the two points. An array has no narrowing to get wrong.
  const failures: { readonly index: number; readonly error: unknown }[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failures.length > 0) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      // In range by the guard above; read through a local so no non-null
      // assertion is needed.
      const item = items[index] as T;
      try {
        results[index] = await fn(item, index);
      } catch (error) {
        failures.push({ index, error });
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: effective }, worker));

  const first = [...failures].sort((a, b) => a.index - b.index)[0];
  if (first !== undefined) throw first.error;
  return results;
}

/**
 * Serialize calls to one side-effecting function while its callers run
 * concurrently.
 *
 * Exists for INJECTED callbacks. A caller that hands this package a sink was
 * entitled to assume it would be invoked one call at a time, because that is
 * how it was invoked before concurrency was introduced here. Speeding up
 * observation must not silently widen that contract into "your sink must be
 * reentrant", which is a different and much stronger requirement that no
 * existing caller agreed to.
 *
 * Each call queues behind the previous one, and a rejection does not poison
 * the queue for later callers: the failure surfaces to the caller that caused
 * it, and the chain continues.
 */
export function serializeCalls<A extends readonly unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (...args: A): Promise<R> => {
    const run = tail.then(
      () => fn(...args),
      () => fn(...args),
    );
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
