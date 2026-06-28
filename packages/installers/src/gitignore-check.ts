// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Warn-only check that `.viberevert/` is mentioned in the user's
// .gitignore per D101.P. NEVER throws; never blocks install.
//
// VibeRevert stores local artifacts (integrations.json, backups,
// recovery journals, audit logs) under .viberevert/. These are
// per-clone state and should not be committed. The installer warns
// once per install if the user's .gitignore does not mention the
// directory, but proceeds either way — auto-editing .gitignore
// would expand the installer's surface beyond what was requested
// (rule 14: VibeRevert touches only what you asked it to).
//
// Matching is LITERAL only. Four variant forms of the input
// pattern are checked:
//   <base>     <base>/     /<base>     /<base>/
// (Input is trimmed first, then leading/trailing slashes stripped;
// if the resulting base is empty the variant set is empty and
// nothing matches.) Wildcard or glob entries in .gitignore (e.g.
// `**/.viberevert`, `*.local`) are NOT parsed — supporting them
// would require shipping a full gitignore engine. If the user uses
// a glob to cover .viberevert/, the warning will fire spuriously;
// install still proceeds; we recommend the literal form for
// unambiguous semantics.
//
// Negation lines (leading `!`) are skipped: if the user wrote
// `!.viberevert/`, they have explicitly UN-gitignored it, which is
// exactly the situation the warning is for; treating negation as
// "mentioned" would suppress a legitimate warning.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read `<repoRoot>/.gitignore` (if present) and return whether any
 * of the four literal variants of `pattern` is mentioned.
 *
 * Returns:
 *   - { mentioned: true,  gitignorePath: "<repoRoot>/.gitignore" } if a match is found.
 *   - { mentioned: false, gitignorePath: "<repoRoot>/.gitignore" } if .gitignore exists but no variant matches (including the empty-pattern case where the derived variant set is empty).
 *   - { mentioned: false, gitignorePath: null } if .gitignore does
 *     not exist, or could not be read for any reason (ENOENT, EACCES,
 *     etc.). This function never throws — read errors are swallowed.
 */
export async function checkGitignoreMentions(
  repoRoot: string,
  pattern: string,
): Promise<{ readonly mentioned: boolean; readonly gitignorePath: string | null }> {
  const gitignorePath = join(repoRoot, ".gitignore");
  let content: string;
  try {
    content = await readFile(gitignorePath, "utf8");
  } catch {
    // Any read error (missing file, permissions, weird kind) →
    // safe default. This is a warning-only path; do not block.
    return { mentioned: false, gitignorePath: null };
  }
  const variants = new Set(deriveGitignoreVariants(pattern));
  if (variants.size === 0) {
    // Empty/slash-only/whitespace-only input — nothing to match. Avoid scanning.
    return { mentioned: false, gitignorePath };
  }
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
    if (variants.has(line)) {
      return { mentioned: true, gitignorePath };
    }
  }
  return { mentioned: false, gitignorePath };
}

function deriveGitignoreVariants(pattern: string): readonly string[] {
  const stripped = pattern.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (stripped.length === 0) return [];
  return [stripped, `${stripped}/`, `/${stripped}`, `/${stripped}/`];
}

/**
 * Check the gitignore via checkGitignoreMentions; if `.viberevert/`
 * is not mentioned, write a 6-line warning (5 content + 1 trailing
 * blank) to `stderr`. Never synchronously throws from this warning
 * path — all errors swallowed via try/catch so install proceeds.
 * (Asynchronous stream errors via 'error' events are not catchable
 * here and are out of scope; callers that need stream-event
 * robustness should wire their own listeners.)
 */
export async function printGitignoreWarning(
  stderr: NodeJS.WritableStream,
  repoRoot: string,
): Promise<void> {
  try {
    const { mentioned } = await checkGitignoreMentions(repoRoot, ".viberevert/");
    if (mentioned) return;
    const lines = [
      "warning: .viberevert/ is not in .gitignore.",
      "warning: VibeRevert stores local artifacts (integrations.json, backups, journal, audit logs) under .viberevert/.",
      "warning: These should not be committed. Add the following line to your .gitignore:",
      "warning:   .viberevert/",
      "warning: (Install will proceed; this is a warning, not an error.)",
      "",
    ];
    for (const line of lines) {
      stderr.write(`${line}\n`);
    }
  } catch {
    // Belt-and-braces: any unexpected sync error (e.g., destroyed
    // stderr that throws on write) must not block install.
  }
}
