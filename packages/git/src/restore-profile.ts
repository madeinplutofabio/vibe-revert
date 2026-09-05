// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Phase timing for `restoreCheckpoint`, off unless asked for.
//
// PACKAGE-INTERNAL and DIAGNOSTIC. Not re-exported from `src/index.ts`, never
// consulted by any decision, and it changes no behavior. When
// `VIBEREVERT_PROFILE_RESTORE` is unset, every call is one property read and a
// no-op.
//
// It exists because the restore path's cost was being attributed from outside,
// by timing the whole function and reasoning about which part must dominate.
// That got the answer wrong once already: the scratch worktree checkout was the
// obvious suspect and turned out to be a ninth of the total. A phase breakdown
// that can be re-run after a change is worth fifteen lines of guarded code, and
// the alternative, instrumenting temporarily and deleting it, makes the next
// measurement unreproducible.
//
// Output goes to stderr so it cannot contaminate a command's stdout contract,
// and the process exit code is untouched.

const ENV_FLAG = "VIBEREVERT_PROFILE_RESTORE";

export interface RestoreProfile {
  /** Time `fn`, attributing it to `phase`. Returns whatever `fn` returns. */
  phase<T>(phase: string, fn: () => Promise<T>): Promise<T>;
  /** Emit the breakdown. No-op when profiling is off. */
  report(label: string): void;
}

const DISABLED: RestoreProfile = {
  phase: (_phase, fn) => fn(),
  report: () => undefined,
};

/**
 * A profile for one restore, or a no-op when the env flag is absent.
 *
 * Read at CALL time rather than module load, so a test or script can set the
 * flag after import without a module-cache surprise.
 */
export function createRestoreProfile(): RestoreProfile {
  if (process.env[ENV_FLAG] === undefined || process.env[ENV_FLAG] === "") {
    return DISABLED;
  }

  const timings = new Map<string, number>();
  return {
    async phase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
      const started = performance.now();
      try {
        return await fn();
      } finally {
        // Recorded in `finally` so a phase that threw still reports the time
        // it spent, which is exactly when the number is most interesting.
        timings.set(phase, (timings.get(phase) ?? 0) + (performance.now() - started));
      }
    },
    report(label: string): void {
      const total = [...timings.values()].reduce((a, b) => a + b, 0);
      const rows = [...timings.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([phase, ms]) => {
          const share = total === 0 ? 0 : (ms / total) * 100;
          return `  ${phase.padEnd(26)} ${ms.toFixed(0).padStart(7)} ms  ${share.toFixed(1).padStart(5)}%`;
        });
      process.stderr.write(
        `[restore-profile] ${label} total ${total.toFixed(0)} ms\n${rows.join("\n")}\n`,
      );
    },
  };
}
