// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Exclusion-basis fingerprinting: the ignore rules that decide which paths are
// OUTSIDE the protected domain.
//
// The protected domain `S` is defined by subtraction: tracked paths, plus
// untracked-but-not-ignored paths. "Ignored" is therefore not a property of a
// path, it is a verdict produced by a set of rules. If those rules change
// between two observations of `S`, the observations are not measuring the same
// domain, and comparing them proves nothing: a path can leave `S` without
// anyone touching it, purely because the yardstick moved.
//
// That is the hole a verification command can drive through. A command that
// appends one line to a `.gitignore` makes a path it also modified vanish from
// the post-command observation, and the domain comparison reports clean.
// Fingerprinting the rules themselves closes it: the transaction can prove the
// yardstick held still, and refuse to interpret the comparison when it did not.
//
// Three inputs make up the basis:
//
//   - `$GIT_COMMON_DIR/info/exclude`, which lives inside the git directory and
//     is therefore never a member of `S`;
//   - the global excludes file, which is USUALLY outside the repository but
//     need not be: `core.excludesFile` can name a repo-relative path, in which
//     case the same file is also a member of `S`. It is fingerprinted either
//     way. The overlap is intentional and conservative: at worst this reports a
//     basis change for a file the domain comparison could also have caught,
//     whereas skipping it on the assumption `S` covers it would miss the change
//     entirely whenever the file is ignored or lives outside the tree;
//   - UNTRACKED `.gitignore` files, whether or not git itself ignores them;
//   - the EVALUATION configuration that decides how those rules are applied.
//     `core.ignoreCase` is the MEASURED member: with it enabled the rule
//     `BUILD.LOG` matches `build.log`, and with it disabled the same bytes match
//     nothing. `core.precomposeUnicode` is fingerprinted CONSERVATIVELY, and no
//     claim is made here about whether it alters ignore evaluation; it changes
//     how git interprets paths on macOS, which is enough reason not to compare
//     across a change in it. Both live in `.git/config`, outside `S`, so a
//     command can toggle either and move the yardstick without touching any
//     fingerprinted file. The basis is every input to the ignore VERDICT, not
//     only the rule text.
//
// macOS CI still owes the behavioral characterization of
// `core.precomposeUnicode`. It does not owe the safety coverage: recording the
// setting means a mid-transaction toggle yields a conservative refusal rather
// than a silently reinterpreted comparison.
//
// The third population is wider than "ignored `.gitignore` files" on purpose.
// An ignored one is invisible to `S` because the rules exclude it. But a
// perfectly visible untracked one can ALSO be absent from `S`, because `S`
// drops untracked paths matching the session-start `rollback.exclude`. A
// command could then edit that file, move the ignore yardstick, and escape both
// checks: the domain comparison never held the file, and a narrower fingerprint
// would not have enumerated it. Enumerating every applicable untracked
// `.gitignore` closes that without reproducing `rollback.exclude`'s matching
// algebra here.
//
// The overlap means an ordinary visible untracked `.gitignore` edit is
// observable by both mechanisms. That is duplicate COVERAGE, not duplicate
// reporting: a basis change short-circuits domain interpretation, so one
// verdict is produced either way.
//
// TRACKED `.gitignore` files are not enumerated by this helper. They stay
// covered by `S`, which holds tracked paths unconditionally: the restore
// contract applies `rollback.exclude` to the untracked surface only.
//
// ENVIRONMENT AUTHORITY. Every environment value is read through
// `getGitEnvironmentVariable`, never from live `process.env`. The runner
// freezes the environment git subprocesses receive at module initialization, so
// a second live read here could describe a different environment than the one
// git actually runs in, producing either a false refusal or a missed change.
//
// SCOPE. This covers the exclusion basis only, not every input that changes how
// git interprets a working tree. `.gitattributes`, and with it `eol` and filter
// behavior, is a different axis and is not represented here.
//
// NOT exported from `./index.ts`. This is a package-internal primitive for the
// selective-restore transaction, not a capability callers assemble themselves.

import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getGitEnvironmentVariable, runGit, runGitText, splitNulList } from "./git-cli.js";
import { sha256File } from "./hashes.js";

/**
 * A `null` sha256 means the file was ABSENT OR UNUSABLE AS A FILE when hashed
 * (see `hashFileIfPresent`). An empty file hashes to the well-known digest of
 * zero bytes, so "no file" and "empty file" are distinct values rather than a
 * shared falsy sentinel.
 *
 * That distinction is conservative rather than semantically meaningful. An
 * absent exclude file and an empty one impose the SAME rules, so keeping them
 * apart detects creation or deletion of the control-plane file itself and can
 * report a basis change while the effective rule set stays empty. It is NOT
 * needed to detect losing populated content: a populated digest differs from
 * both `null` and the empty digest, so that transition is caught either way.
 * The distinction is kept because a false "the yardstick moved" is far cheaper
 * than a false "it held still".
 */
export interface InfoExcludeBasis {
  /** Absolute path, resolved through git so linked worktrees are correct. */
  readonly path: string;
  readonly sha256: string | null;
}

export interface GlobalExcludesBasis {
  /**
   * `"configured"` when `core.excludesFile` resolved through git. `"default"`
   * when it is unset and the path was COMPUTED. Git offers no way to ask for
   * its own default, so the computed value reproduces the resolution order
   * MEASURED against the supported git rather than restating a specification:
   * `XDG_CONFIG_HOME`, then `HOME` on every platform, then `HOMEDRIVE` plus
   * `HOMEPATH` and finally `USERPROFILE` on Windows only.
   *
   * An environment resolving a home by some other route would make this name
   * the wrong file, which can cause EITHER a missed change on the file git
   * actually reads OR a false basis change from an unrelated file at the
   * computed path.
   */
  readonly source: "configured" | "default";
  readonly path: string;
  readonly sha256: string | null;
}

/** One untracked `.gitignore` that git reads. */
export interface UntrackedIgnoreFileBasis {
  /** Repository-relative, forward slashes, exactly as `git ls-files` reports. */
  readonly path: string;
  readonly sha256: string | null;
}

export interface ExclusionBasisFingerprint {
  readonly infoExclude: InfoExcludeBasis | null;
  readonly globalExcludes: GlobalExcludesBasis | null;
  /** Sorted by path, ascending by code point, deduplicated. */
  readonly untrackedIgnoreFiles: readonly UntrackedIgnoreFileBasis[];
  /**
   * Effective `core.ignoreCase`. Unset and explicit `false` are recorded
   * identically because they are the same verdict: unlike `core.excludesFile`,
   * where unset and empty were MEASURED to differ, a boolean has no third state
   * whose evaluation differs.
   */
  readonly ignoreCase: boolean;
  /**
   * Effective `core.precomposeUnicode`, recorded so a mid-transaction change is
   * visible. Not a claim that it affects ignore evaluation.
   */
  readonly precomposeUnicode: boolean;
}

/**
 * Hash `absolutePath`, mapping "not usable as a file" to `null`.
 *
 * ENOENT and EISDIR are the two conditions deliberately normalized here: both
 * mean the same thing for the basis, that no rules come from this path. Other
 * filesystem failures exist and correctly propagate. A permission failure is a
 * genuine inability to observe, and encoding it as `null` would let two
 * unreadable captures with different contents compare equal.
 */
async function hashFileIfPresent(absolutePath: string): Promise<string | null> {
  try {
    return await sha256File(absolutePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") {
      return null;
    }
    throw err;
  }
}

/**
 * Remove the single line terminator git appends to a scalar result, preserving
 * every other byte. General whitespace trimming is WRONG here: a path may
 * legitimately begin or end with a space, and `.trim()` would silently corrupt
 * it into a different path.
 */
function stripOneTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) {
    return text.slice(0, -2);
  }
  if (text.endsWith("\n")) {
    return text.slice(0, -1);
  }
  return text;
}

function compareCodePoints(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/** Repository-relative parent directory, or `null` for a root-level path. */
function parentOf(path: string): string | null {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : null;
}

function nonEmptyGitEnvironmentVariable(name: string): string | null {
  const value = getGitEnvironmentVariable(name);
  return value === undefined || value === "" ? null : value;
}

/**
 * `rev-parse --git-path` rather than `join(repoRoot, ".git", ...)`: in a linked
 * worktree `.git` is a FILE, and `info/exclude` lives in the shared common
 * directory, which is what gitignore(5) names as the input. The oracle creates
 * linked worktrees, so this is a real case here.
 *
 * The path is part of the fingerprint, not just its content: a change in WHICH
 * common directory supplies the file is a change of basis even when the bytes
 * match. `rev-parse` has no `-z`, so exactly one trailing newline is removed.
 * Output is relative to the git process cwd, which `runGit` pins to `repoRoot`.
 */
async function captureInfoExclude(repoRoot: string): Promise<InfoExcludeBasis | null> {
  const reported = stripOneTrailingNewline(
    await runGitText(repoRoot, ["rev-parse", "--git-path", "info/exclude"]),
  );
  if (reported === "") {
    return null;
  }
  const path = resolve(repoRoot, reported);
  return { path, sha256: await hashFileIfPresent(path) };
}

/**
 * The home directory git derives, in MEASURED precedence order: `HOME`, then
 * `HOMEDRIVE`+`HOMEPATH`, then `USERPROFILE`. All three are live routes on Git
 * for Windows, established by pointing each at a distinct ignore file and
 * observing which rule applied.
 *
 * The last two are gated to Windows. They are Git-for-Windows fallbacks, and
 * consulting them elsewhere would let an unrelated environment variable name a
 * home that git would never derive on that platform.
 *
 * `null` when none applies. That is not a shortfall: with the applicable
 * variables absent, git applied no default excludes file at all, so inventing a
 * path here would fingerprint a file git never consults.
 */
function gitHomeDirectory(): string | null {
  const home = nonEmptyGitEnvironmentVariable("HOME");
  if (home !== null) {
    return home;
  }
  if (process.platform !== "win32") {
    return null;
  }
  const drive = nonEmptyGitEnvironmentVariable("HOMEDRIVE");
  const path = nonEmptyGitEnvironmentVariable("HOMEPATH");
  if (drive !== null && path !== null) {
    return `${drive}${path}`;
  }
  return nonEmptyGitEnvironmentVariable("USERPROFILE");
}

/**
 * Git's default when `core.excludesFile` is unset: `$XDG_CONFIG_HOME/git/ignore`,
 * else `<home>/.config/git/ignore`.
 *
 * RELATIVE values are honored for `XDG_CONFIG_HOME`, `HOME` and `USERPROFILE`
 * alike, each measured rather than assumed: with the variable set to a relative
 * directory, git applied the ignore file beneath it, resolved against its own
 * cwd. Discarding relative values as the XDG specification suggests would skip
 * a live exclude source. `repoRoot` is the correct base because `runGit` pins
 * every invocation's cwd to it, so this names the file the transaction's own
 * git commands consult.
 */
function defaultGlobalExcludesPath(repoRoot: string): string | null {
  const xdg = nonEmptyGitEnvironmentVariable("XDG_CONFIG_HOME");
  if (xdg !== null) {
    return resolve(repoRoot, xdg, "git", "ignore");
  }
  const home = gitHomeDirectory();
  if (home === null) {
    return null;
  }
  return resolve(repoRoot, home, ".config", "git", "ignore");
}

/**
 * `--path` makes git perform tilde expansion rather than this module
 * reimplementing it, and `--null` frames the value so no byte of the path is
 * lost to line-ending or whitespace handling.
 *
 * UNSET and EXPLICITLY EMPTY are different states, measured: unset exits 1 with
 * zero bytes and git falls back to its default excludes file, while an empty
 * value exits 0 with exactly one NUL byte and DISABLES the default entirely.
 * Collapsing them would fingerprint a file git does not consult, so the RAW
 * buffer is inspected before any tokenization.
 *
 * `--path` does NOT absolutize a relative value; it returns it verbatim. The
 * repository-root resolution is measured too: with a relative
 * `core.excludesFile`, git consults the file at the REPOSITORY ROOT, and does
 * so identically when git runs from a subdirectory.
 *
 * The value-count check is framing defense, not multi-declaration detection:
 * `--get` returns the effective last value, so more than one value here would
 * mean the framing was misread rather than that the config declares several.
 */
async function captureGlobalExcludes(repoRoot: string): Promise<GlobalExcludesBasis | null> {
  const raw = await runGit(repoRoot, ["config", "--null", "--path", "--get", "core.excludesFile"], {
    allowedExitCodes: [1],
  });
  if (raw.length === 0) {
    const fallback = defaultGlobalExcludesPath(repoRoot);
    if (fallback === null) {
      return null;
    }
    return { source: "default", path: fallback, sha256: await hashFileIfPresent(fallback) };
  }
  if (raw.length === 1 && raw[0] === 0) {
    // Explicitly empty: git consults no global excludes file at all. `null`
    // records that absence, and a later capture that finds a default will
    // compare unequal, which is the transition this needs to detect.
    return null;
  }
  const values = splitNulList(raw);
  if (values.length !== 1) {
    throw new Error(`core.excludesFile produced ${values.length} values; expected exactly one`);
  }
  const configured = values[0];
  if (configured === undefined || configured === "") {
    throw new Error("core.excludesFile returned invalid NUL framing");
  }
  const path = resolve(repoRoot, configured);
  return { source: "configured", path, sha256: await hashFileIfPresent(path) };
}

/**
 * Which of `paths` git considers ignored, as a SET.
 *
 * `check-ignore` reports only the matching paths, with no guaranteed
 * correspondence to input positions, so the result must be consumed as
 * membership rather than aligned row by row. Exit 1 means nothing matched.
 *
 * `--stdin -z` rather than argv: `check-ignore` rejects `-z` in the argument
 * form, which would force newline-delimited, quote-escaped output that cannot
 * represent a path containing a newline. It also removes any ARG_MAX ceiling.
 *
 * `--no-index` is REQUIRED, and was measured. Without it `check-ignore`
 * consults the index and stops reporting a directory as ignored once it holds
 * a tracked file, which answers a different question than this filter asks.
 * The question here is whether the ignore RULES exclude the directory, and
 * tracked content does not change that: in a repository where `secret/` is
 * ignored and `secret/tracked.txt` is tracked, every untracked entry beneath it
 * is still excluded wholesale by the parent rule, and a sibling matching no
 * nested rule is excluded too. So `secret/.gitignore` contributes nothing, and
 * an index-aware verdict would wrongly admit it to the basis.
 */
async function selectIgnoredPaths(
  repoRoot: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  const out = await runGit(repoRoot, ["check-ignore", "--no-index", "--stdin", "-z"], {
    stdin: `${paths.join("\0")}\0`,
    allowedExitCodes: [1],
  });
  return new Set(splitNulList(out));
}

/**
 * Read a boolean config value, falling back to `defaultValue` when unset.
 *
 * Uses the `--get --bool` idiom already established by
 * `gitCheckoutSymlinksEnabled`; exit 1 means unset. `--bool` normalizes git's
 * many truthy spellings to exactly `true` or `false`, so anything else means
 * the framing was misread and is refused rather than coerced.
 */
async function captureBooleanConfig(
  repoRoot: string,
  key: string,
  defaultValue: boolean,
): Promise<boolean> {
  const raw = await runGitText(repoRoot, ["config", "--get", "--bool", key], {
    allowedExitCodes: [1],
  });
  const value = stripOneTrailingNewline(raw);
  if (value === "") {
    return defaultValue;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${key} produced an invalid boolean value`);
}

/**
 * Whether `absolutePath` is a REGULAR file, via `lstat` so a symlink is not
 * silently resolved to its target.
 *
 * Git does not read an in-tree `.gitignore` through a symlink, while
 * `sha256File` follows one. Hashing the target would therefore record rules git
 * never applies, and would report a basis change when only the target moved.
 * Excluding symlinks makes membership itself the signal: a regular-file to
 * symlink transition changes the list, which is a real change of basis.
 *
 * NOTE: git's refusal to follow the link is NOT verified on Windows, where
 * `core.symlinks` is false and no symlink can be created to test it. The
 * POSIX-gated test is the measurement, and CI on Linux and macOS supplies it.
 */
async function isRegularFile(absolutePath: string): Promise<boolean> {
  try {
    return (await lstat(absolutePath)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * Enumerate untracked `.gitignore` files that git reads.
 *
 * `--others` with NEITHER `--ignored` NOR `--exclude-standard`: the population
 * is every untracked candidate, ignored or visible, for the `rollback.exclude`
 * reason in the header. `--directory` is deliberately not used, since
 * collapsing untracked directories would hide candidates beneath them.
 *
 * `:(glob)` states the `**` semantics explicitly instead of relying on default
 * wildmatch flags. The bare `.gitignore` pattern covers the root, which a
 * `**`-anchored pattern is not guaranteed to reach.
 *
 * APPLICABILITY. An excluded parent directory is terminal: git does not
 * enumerate its untracked contents, so patterns in files inside it have no
 * effect on untracked discovery. Tracked files inside such a directory do not
 * change that, which was measured rather than reasoned: with a tracked file
 * present, git still attributed every untracked entry beneath the directory to
 * the PARENT rule, including one matching no nested pattern.
 *
 * So an ignored parent is sufficient to exclude the candidate, and only the
 * IMMEDIATE parent is queried: `check-ignore` already accounts for ancestor
 * rules, reporting `a/b` as ignored when only `a/` matches.
 *
 * Cost: the walk descends into ignored directories. Output stays small because
 * of the pathspec, but the traversal is not avoidable through any documented
 * option that does not also risk dropping an applicable file.
 */
async function captureUntrackedIgnoreFiles(
  repoRoot: string,
): Promise<readonly UntrackedIgnoreFileBasis[]> {
  const candidates = splitNulList(
    await runGit(repoRoot, [
      "ls-files",
      "--others",
      "-z",
      "--",
      ":(glob)**/.gitignore",
      ".gitignore",
    ]),
  );
  if (candidates.length === 0) {
    return [];
  }

  const parents = new Set<string>();
  for (const candidate of candidates) {
    const parent = parentOf(candidate);
    if (parent !== null) {
      parents.add(parent);
    }
  }
  const ignoredParents =
    parents.size === 0 ? new Set<string>() : await selectIgnoredPaths(repoRoot, [...parents]);

  const applicable = new Set<string>();
  for (const candidate of candidates) {
    const parent = parentOf(candidate);
    if (parent === null || !ignoredParents.has(parent)) {
      applicable.add(candidate);
    }
  }

  // Ordering is a comparison input, so it is established here rather than
  // inherited from git's traversal order. Code points, not `localeCompare`,
  // which varies by locale.
  const sorted = [...applicable].sort(compareCodePoints);

  // Sequential, not `Promise.all`. This set is not guaranteed small: an
  // untrusted verification command can create thousands of non-ignored
  // directories each holding a `.gitignore`, and unbounded concurrent opens
  // would then be a resource-exhaustion path. Measured bounded concurrency
  // belongs in the step 15 characterization work, if it proves necessary.
  const basis: UntrackedIgnoreFileBasis[] = [];
  for (const path of sorted) {
    const absolute = join(repoRoot, ...path.split("/"));
    if (!(await isRegularFile(absolute))) {
      continue;
    }
    basis.push({ path, sha256: await hashFileIfPresent(absolute) });
  }
  return basis;
}

/**
 * Capture the exclusion basis for `repoRoot`.
 *
 * The three components are independent and are captured CONCURRENTLY, which
 * narrows the window in which the fingerprint can be internally torn by a
 * change landing mid-capture. `Promise.all` preserves positional order, so the
 * result is deterministic regardless of completion order.
 */
export async function captureExclusionBasis(repoRoot: string): Promise<ExclusionBasisFingerprint> {
  const [infoExclude, globalExcludes, untrackedIgnoreFiles, ignoreCase, precomposeUnicode] =
    await Promise.all([
      captureInfoExclude(repoRoot),
      captureGlobalExcludes(repoRoot),
      captureUntrackedIgnoreFiles(repoRoot),
      captureBooleanConfig(repoRoot, "core.ignoreCase", false),
      captureBooleanConfig(repoRoot, "core.precomposeUnicode", false),
    ]);
  return { infoExclude, globalExcludes, untrackedIgnoreFiles, ignoreCase, precomposeUnicode };
}

function infoExcludeChanged(
  before: InfoExcludeBasis | null,
  after: InfoExcludeBasis | null,
): boolean {
  if (before === null || after === null) {
    return before !== after;
  }
  return before.path !== after.path || before.sha256 !== after.sha256;
}

function globalExcludesChanged(
  before: GlobalExcludesBasis | null,
  after: GlobalExcludesBasis | null,
): boolean {
  if (before === null || after === null) {
    return before !== after;
  }
  return (
    before.source !== after.source || before.path !== after.path || before.sha256 !== after.sha256
  );
}

/**
 * Whether the ignore rules moved between two captures.
 *
 * A path change with matching content counts as a change: the same bytes at a
 * different location is a different configuration, and a later edit to either
 * file would diverge. Element-wise list comparison is sound only because
 * `captureUntrackedIgnoreFiles` sorts and deduplicates.
 */
export function exclusionBasisChanged(
  before: ExclusionBasisFingerprint,
  after: ExclusionBasisFingerprint,
): boolean {
  if (infoExcludeChanged(before.infoExclude, after.infoExclude)) {
    return true;
  }
  if (globalExcludesChanged(before.globalExcludes, after.globalExcludes)) {
    return true;
  }
  if (before.ignoreCase !== after.ignoreCase) {
    return true;
  }
  if (before.precomposeUnicode !== after.precomposeUnicode) {
    return true;
  }
  const beforeFiles = before.untrackedIgnoreFiles;
  const afterFiles = after.untrackedIgnoreFiles;
  if (beforeFiles.length !== afterFiles.length) {
    return true;
  }
  for (let i = 0; i < beforeFiles.length; i += 1) {
    const lhs = beforeFiles[i];
    const rhs = afterFiles[i];
    if (lhs === undefined || rhs === undefined) {
      return true;
    }
    if (lhs.path !== rhs.path || lhs.sha256 !== rhs.sha256) {
      return true;
    }
  }
  return false;
}
