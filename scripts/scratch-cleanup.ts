// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Verified scratch-directory removal, shared by the latency scripts.
//
// It lives in its own module rather than in `bench-end-latency.ts` because both
// of those scripts are ENTRY POINTS: each ends in a top-level `await main()`.
// Importing a helper out of one of them therefore runs it. That was real, not
// theoretical: `probe-end-phases.ts` imported this function from the benchmark
// and so ran the entire benchmark before doing any of its own work, quietly
// doubling every probe and prefixing its output with a table it did not
// produce. A module with no top-level effects cannot do that to a caller.

import { rm, stat } from "node:fs/promises";

/**
 * Delete a scratch root and PROVE it is gone.
 *
 * `rm -rf` is best-effort by design: `force` swallows the error that says the
 * directory is still there. On Windows a live handle from an indexer or a
 * scanner defeats the delete silently, and a run that leaves scratch git
 * worktrees behind is not a clean run. Leftovers accumulate into filesystem
 * permission failures in unrelated test fixtures later, which is a genuinely
 * expensive thing to debug from the far end.
 *
 * So the removal is verified rather than assumed, and a survivor is reported
 * loudly with its path. Reported rather than thrown: the measurement itself
 * already succeeded, and losing the numbers to a cleanup problem would be the
 * wrong trade.
 */
export async function removeAndVerify(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const survived = await stat(root).then(
    () => true,
    () => false,
  );
  if (survived) {
    console.error(
      `WARNING: scratch root survived cleanup and must be removed by hand: ${root}\n` +
        "         Leftover scratch worktrees cause permission failures in later fixture runs.",
    );
  }
}
