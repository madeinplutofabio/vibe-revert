// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Package-private helper for managing the repo's `.gitignore` to ensure
// `.viberevert/` is ignored. Used by `viberevert init` (M A / M B
// trust-critical invariant: the VibeRevert working directory MUST be
// gitignored so checkpoint and session writes don't leak into the user's
// git status).
//
// The M A plan locked the invariant ("init adds .viberevert/ to .gitignore")
// but the M A init implementation never wrote the gitignore entry — M B
// tests masked the gap by writing .gitignore manually in their fixtures.
// This module is the corrective M B-trust-critical fix that closes the gap
// before M C ships (M C Step 0 verifies the same invariant end-to-end).
//
// NOT exported from the CLI's public surface. Internal helper consumed by
// `init.ts` and (potentially) future commands that need to verify the same
// invariant (e.g., `viberevert doctor` could call
// `containsEffectiveViberevertRule` against the repo's current .gitignore
// as a diagnostic).

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Result of `ensureViberevertGitignore`. Lets callers print an accurate
 * status line ("created" / "appended" / "already-present").
 */
export type GitignoreAction = "created" | "appended" | "already-present";

/**
 * The set of `.gitignore` lines we recognize as a (positive or negated)
 * rule for the `.viberevert/` working directory. All four forms match the
 * repo-root `.viberevert/` directory:
 *   - `.viberevert/`    (canonical — the form `init` writes)
 *   - `.viberevert`     (without trailing slash; git still matches dirs)
 *   - `/.viberevert/`   (rooted explicitly)
 *   - `/.viberevert`    (rooted, no trailing slash)
 *
 * Anything broader (e.g., `.vib*`, `**` patterns) is NOT considered an
 * effective match — those are user-authored patterns whose intent we
 * don't want to second-guess. If the user's pattern happens to cover
 * `.viberevert/` we'll still append our explicit rule; the duplication
 * is harmless (git's last-rule-wins makes both ignore the same path).
 */
const EFFECTIVE_VIBEREVERT_RULES: ReadonlySet<string> = new Set<string>([
  ".viberevert/",
  ".viberevert",
  "/.viberevert/",
  "/.viberevert",
]);

/**
 * Returns true iff the given `.gitignore` content's LAST relevant rule
 * for `.viberevert/` is positive (i.e., the directory is currently
 * ignored under gitignore's last-match-wins precedence).
 *
 * Honors gitignore semantics for our 4 exact forms: a file like
 *   `.viberevert/`
 *   `!.viberevert/`
 * does NOT ignore the directory (the negation overrides the earlier
 * positive rule), so this function returns false and the caller appends
 * a fresh `.viberevert/` line — restoring the trust-critical invariant.
 *
 * Whitespace handling (per `gitignore(5)`):
 *   - Trailing spaces and tabs are stripped before matching (gitignore
 *     ignores them unless escaped with backslash — we don't model the
 *     backslash-escape edge case; it's vanishingly rare and a benign
 *     duplicate `.viberevert/` append is harmless if it occurs).
 *   - Leading whitespace is NOT stripped. Per gitignore semantics, a
 *     line with leading whitespace is a DIFFERENT pattern from one
 *     without — Git would not treat `   .viberevert/` as ignoring
 *     `.viberevert/`, so neither do we. A line with leading whitespace
 *     never matches our 4 exact forms.
 *
 * Other limitations (locked, documented):
 *   - Only checks the four exact forms in `EFFECTIVE_VIBEREVERT_RULES`.
 *     User-authored broader patterns (e.g., `.vib*`) are NOT recognized
 *     and will trigger an additional explicit `.viberevert/` append.
 *   - Skips comment lines (`#`-prefixed) and blank lines entirely.
 *   - Reads only the file passed in — does NOT recurse into nested
 *     `.gitignore` files (init operates on the repo-root `.gitignore` only).
 */
export function containsEffectiveViberevertRule(gitignoreContent: string): boolean {
  let lastRelevantRuleIsPositive: boolean | undefined;

  for (const rawLine of gitignoreContent.split(/\r?\n/)) {
    // Right-trim trailing spaces/tabs only (per gitignore(5)); preserve
    // leading whitespace so leading-whitespace lines never match our
    // exact-form set.
    const line = rawLine.replace(/[ \t]+$/u, "");

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("!")) {
      const negated = line.slice(1);
      if (EFFECTIVE_VIBEREVERT_RULES.has(negated)) {
        lastRelevantRuleIsPositive = false;
      }
      continue;
    }

    if (EFFECTIVE_VIBEREVERT_RULES.has(line)) {
      lastRelevantRuleIsPositive = true;
    }
  }

  return lastRelevantRuleIsPositive === true;
}

/**
 * Ensures `<repoRoot>/.gitignore` contains an effective rule for the
 * `.viberevert/` working directory. Idempotent on re-run.
 *
 *   - File missing            -> create with `.viberevert/\n` (returns "created").
 *   - File exists, no effective positive rule -> append `.viberevert/`
 *                                with the file's detected newline style
 *                                (preserves CRLF if already CRLF; ensures
 *                                the new rule lands on its own line);
 *                                returns "appended".
 *   - File exists, rule found -> no write (returns "already-present").
 *
 * Uses plain `writeFile` (no atomic temp+rename). `.gitignore` is
 * user-facing state, not internal `.viberevert/` state — symmetric with
 * how `init` already writes `.viberevert.yml` (plain `writeFile` per
 * `init.ts`). A torn-apart `.gitignore` from a crash mid-write would be
 * obvious to the user and trivially recoverable, unlike the trust-critical
 * `.viberevert/` artifacts which DO use atomic writes per D13.
 */
export async function ensureViberevertGitignore(repoRoot: string): Promise<GitignoreAction> {
  const gitignorePath = join(repoRoot, ".gitignore");

  let existing: string | undefined;
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      existing = undefined;
    } else {
      throw err;
    }
  }

  if (existing === undefined) {
    // Fresh file: plain `\n` is fine (no existing newlines to mix with).
    await writeFile(gitignorePath, ".viberevert/\n", "utf8");
    return "created";
  }

  if (containsEffectiveViberevertRule(existing)) {
    return "already-present";
  }

  // Preserve the existing file's newline style. If the file contains any
  // CRLF sequence, use CRLF for the appended content; otherwise plain LF.
  // This avoids mixing line endings within a single `.gitignore`.
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  // Ensure the new rule lands on its own line if the existing content
  // didn't end with a newline.
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : newline;
  await writeFile(gitignorePath, `${existing}${prefix}.viberevert/${newline}`, "utf8");
  return "appended";
}
