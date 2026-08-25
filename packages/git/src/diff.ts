// packages/git/src/diff.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// D56 diff helpers — git-ref base AND checkpoint/session base.
//
// Public exports:
//
//   getDiffSinceRef(repoRoot, ref, opts)
//     Diff base = a git ref (HEAD, main, SHA, tag).
//     Two-call algorithm:
//       (1) `git diff --name-status -z -M [--cached] <sha>` — authoritative
//           status + previous_path (rename detection).
//       (2) `git diff --no-color -U0 --binary -M --no-ext-diff --no-textconv
//           --src-prefix=a/ --dst-prefix=b/ [--cached] <sha>` — hunks +
//           binary markers.
//     Plus, when NOT staged: enumerate untracked-not-ignored via
//     `git ls-files -z --others --exclude-standard` and synthesize "added"
//     entries (bounded-read content; see MAX_UNTRACKED_TEXT_BYTES).
//
//   getDiffSinceCheckpoint(repoRoot, checkpointDir, opts)
//     Diff base = a captured checkpoint's working state.
//     The scratch lifecycle — tempRoot, the linked worktree at
//     manifest.git.head_sha, the restoreCheckpoint overlay using the
//     manifest's CAPTURED untracked.exclude_patterns, and best-effort
//     cleanup — belongs to withCheckpointOracle in checkpoint-oracle.ts.
//     Layout inside the oracle's single bounded tempRoot:
//       tempRoot/worktree/   linked worktree at manifest.git.head_sha
//       tempRoot/base/       copy of candidate regular files (base side)
//       tempRoot/live/       copy of candidate regular files (live side)
//     The two mirror dirs are created through the oracle's prepareTempRoot
//     hook, which runs BEFORE the worktree is added; that position preserves
//     the shipped failure ordering and is documented in checkpoint-oracle.ts.
//     This function then enumerates candidate paths from BOTH sides via
//     `git ls-files -z --cached --others --exclude-standard`, filters by
//     opts.liveExcludePatterns + the always-on .viberevert/
//     defense-in-depth, copies regular files into sanitized mirror dirs,
//     runs one bounded:
//       `git diff --no-color -U0 --binary -M --no-ext-diff --no-textconv
//        --src-prefix=a/ --dst-prefix=b/ --no-index -- base live`
//     with cwd=tempRoot (basename operands; exit 1 = differences exist =
//     success per --no-index contract). The unified parser strips the
//     `base/` and `live/` mirror prefixes via additionalStripPrefixes,
//     and derives status from unified-diff headers (new file mode /
//     deleted file mode / rename from-to / old-mode vs new-mode).
//     That invocation and its parse live in parsePreparedMirrors below,
//     shared with M 0.8.0's contribution capture; checkpoint mode passes
//     detectRenames: true, so its argv is unchanged.
//
// Package-internal exports (NOT in the barrel):
//
//   diffPreparedMirrors(tempRoot, baseDirName, liveDirName, opts)
//     Diffs two ALREADY-PREPARED sibling directories under tempRoot and
//     returns CONTENT ONLY: path, isBinary, hunks. It performs no
//     enumeration, no filtering, no copying, and owns no scratch
//     lifecycle; the caller prepares both sides.
//
//     Rename detection is a REQUIRED parameter with no default, and "off"
//     is spelled `--no-renames` rather than by omitting `-M`: `diff.renames`
//     config would otherwise re-enable it, and the flag would then promise
//     a determinism the argv did not deliver.
//
//     The seam deliberately does NOT expose derivedStatus or previous_path.
//     Those are precisely the two facts M 0.8.0's derivation contract says a
//     mirror may not authorize, so the richer ParsedUnifiedEntry stays
//     private here and only getDiffSinceCheckpoint consumes it.
//
//   parseNameStatus(buf, opts) + NameStatusEntry + ParseNameStatusOptions
//     Parser for `git diff --name-status -z` output. Shared with M 0.8.0's
//     contribution capture, which reads the committed delta
//     `<before_head>..<after_head>` for rename PROPOSALS. Exported rather
//     than reimplemented there: a second copy of a git-output parser is the
//     same drift this package just finished removing from its path guards.
//     Its fail-closed handling of copy tokens is load-bearing for that
//     caller, since a `C` entry must never reach a rename-proposal set.
//
//     `opts.validatePath` injects the caller's path policy and defaults to
//     this module's DiffParseError-raising guard, so ref mode is unchanged.
//     Contribution capture needs a different policy for exactly one rule:
//     `.viberevert/**` is HARD-EXCLUDED there rather than fatal, because a
//     tracked or force-added store path must not make `end` fail outright.
//
//     That exclusion cannot live inside this parser. A rename
//     `src/a.ts -> .viberevert/a.ts` must still surface BOTH aliases, so
//     the caller can drop the store-side destination while keeping
//     `src/a.ts` as an ordinary session deletion candidate. Filtering the
//     whole entry here would silently lose the non-store side, which is why
//     the seam is a validator rather than a filter.
//
//   PICOMATCH_OPTIONS
//     This package's one glob-semantics definition, shared with contribution
//     capture's untracked-exclude filtering. Exported rather than copied
//     because glob drift would silently change which untracked files enter a
//     recovery artifact, and neither the type system nor the test suite would
//     necessarily notice two configurations disagreeing.
//
// Both public helpers return DiffResult { diff, cleanupWarnings }. Cleanup
// failures are NEVER thrown (D29 + D17c terminal-write rule): they
// populate cleanupWarnings; the CLI inspects that field and decides
// whether to log to its OWN stderr. When the main algorithm throws and
// cleanup ALSO produces warnings, those warnings are attached to the
// thrown error as a `cleanupWarnings` property so they survive the throw.
// For the checkpoint base that behavior now lives in withCheckpointOracle;
// getDiffSinceRef owns no scratch state and always returns an empty list.
//
// Non-regular files (symlinks, sockets, FIFOs, devices) are SILENTLY
// SKIPPED during untracked enumeration and mirror construction —
// documented M C limitation. Symlink target changes and mode-only
// changes are NOT surfaced for checkpoint/session bases. Git-ref mode
// may still emit native `T` entries when present in name-status output.
//
// Quoted-path limitation: `git diff --name-status -z` already emits
// paths without C-style quoting in the -z form, so this parser
// intentionally does NOT implement `core.quotepath`-style decoding.
// The unified-diff header parser ENFORCES the limitation: any header
// containing `"` OR not parsing as exactly two space-separated tokens
// throws DiffParseError. A regression test for the -z assumption AND
// for the header strictness lives in diff.test.ts.
//
// Path safety: every repo-relative path is validated via
// assertSafeRepoRelativePath BEFORE any filesystem join/copy. Unsafe
// paths THROW DiffParseError — never silently skipped. Bans absolute
// paths (POSIX `/` lead, Windows drive `X:`), backslashes, empty / `.` /
// `..` segments, and the `.viberevert/` prefix. The rules themselves live
// once in path-safety.ts, shared with path-state.ts and contribution.ts;
// the local wrapper below exists only to choose the error type, since M C
// callers catch DiffParseError specifically.
//
// Parse contract: parseUnifiedDiff fails closed via DiffParseError on
// non-empty input with zero `diff --git` chunks. parseEntry fails closed
// on rename entries that contain only one of `rename from` / `rename to`
// (the pair MUST appear together; an isolated half is malformed input).
// parseNameStatus fails closed on unknown tokens, on malformed rename
// tokens (R must be R<digits>), on copy tokens (C — not supported in
// M C), AND on empty status tokens (malformed -z output).
//
// Option-injection defense: getDiffSinceRef delegates ref-to-SHA resolution
// to resolveCommitRef in git-cli.ts (the package's single source of truth
// for commit-ref resolution), which uses `--end-of-options` so a
// user-controlled ref starting with `-` cannot be interpreted as a git
// option. CommitRefNotFoundError thrown by that helper is wrapped back
// into DiffRefNotFoundError below for backward compatibility with M C
// callers that catch the diff-specific error type.

import type { Stats } from "node:fs";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import picomatch from "picomatch";

import { withCheckpointOracle } from "./checkpoint-oracle.js";
import {
  CommitRefNotFoundError,
  resolveCommitRef,
  runGit,
  runGitText,
  splitNulList,
} from "./git-cli.js";
import { repoRelativePathSafetyError } from "./path-safety.js";

// ============================================================================
// Public types
// ============================================================================

export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "type_changed";

export interface LineChunk {
  readonly kind: "add" | "remove" | "context";
  readonly text: string;
}

export interface RawDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly LineChunk[];
}

export interface RawDiffEntry {
  readonly path: string;
  readonly previous_path?: string;
  readonly status: ChangedFileStatus;
  readonly isBinary: boolean;
  readonly hunks: readonly RawDiffHunk[];
}

export interface RawDiff {
  readonly entries: readonly RawDiffEntry[];
}

export interface DiffSinceCheckpointOptions {
  /**
   * The CURRENT resolved config's `rollback.exclude` patterns (D3 symmetry).
   * Used to filter candidate paths BEFORE mirror construction. Default `[]`.
   * Production CLI paths MUST always pass the resolved value.
   */
  readonly liveExcludePatterns?: readonly string[];
}

export interface DiffResult {
  readonly diff: RawDiff;
  /**
   * Empty in normal flows. Populated when worktree-remove or mirror
   * cleanup partially failed. NEVER causes a throw from these helpers.
   */
  readonly cleanupWarnings: readonly string[];
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Raised by `getDiffSinceRef` when its ref-to-SHA resolution step fails.
 * Wraps `CommitRefNotFoundError` (from `resolveCommitRef` in git-cli.ts —
 * the package's single source of truth for commit-ref resolution) so that
 * M C callers that catch the diff-specific error type continue to work.
 *
 * Diagnostic-safety: the `ref` interpolation uses `JSON.stringify(ref)`
 * rather than bare `${ref}`. Refs are user-controlled (`--since <ref>`
 * from the CLI) and the message flows through direct stderr writes plus
 * structured JSON error envelopes; JSON-quoting prevents embedded
 * newlines, terminal escape sequences, or text that mimics another git
 * error fragment from corrupting the diagnostic line.
 *
 * Cause preservation: when `getDiffSinceRef` wraps the underlying
 * `CommitRefNotFoundError`, that original error is preserved
 * on `this.cause` via the standard `Error` options API (the `{ cause }`
 * argument to `super`). This is intentionally SYMMETRIC to
 * `CommitRefNotFoundError`'s own cause handling — both error classes use
 * the same options-API form. Notably, the options-API form makes
 * `cause` NON-enumerable (per the standard `Error` cause-options
 * convention), so `JSON.stringify(err)` does NOT leak the cause chain
 * into structured output, and `Object.keys(err)` does NOT include
 * `cause`. Tests that read `err.cause` directly via property access
 * still work — direct access reads non-enumerable own properties just
 * fine. The earlier-draft manual `(this as { cause?: unknown }).cause =
 * cause;` assignment created an ENUMERABLE `cause` and was asymmetric
 * with `CommitRefNotFoundError`; the symmetry fix (D.1.pre file 2 v2)
 * standardizes both classes on the same spec-compliant pattern.
 *
 * The message also surfaces the shallow-clone hint, which is the single
 * most common cause of this error in CI (where a clone may not contain
 * the requested ref in its local history).
 */
export class DiffRefNotFoundError extends Error {
  override readonly name = "DiffRefNotFoundError";
  constructor(
    readonly ref: string,
    cause?: unknown,
  ) {
    super(
      `Could not resolve ref ${JSON.stringify(ref)}. If this is a shallow clone, run \`git fetch --unshallow\` first.`,
      cause === undefined ? undefined : { cause },
    );
  }
}

export class DiffParseError extends Error {
  override readonly name = "DiffParseError";
  constructor(
    message: string,
    readonly raw?: string,
  ) {
    super(message);
  }
}

// ============================================================================
// Constants
// ============================================================================

/** 1 MiB cap on untracked-file text reads. Oversize → isBinary=true, no body. */
const MAX_UNTRACKED_TEXT_BYTES = 1_048_576;

/** Bytes scanned for NUL when classifying untracked files as binary. */
const BINARY_SCAN_BYTES = 8_000;

/**
 * Locked picomatch options — IDENTICAL across @viberevert/git and
 * @viberevert/checks. Single source of truth for glob semantics.
 * Uses `as const` rather than an explicit type annotation because
 * `posixSlashes` and `nonegate` aren't reliably exported in
 * @types/picomatch across versions; picomatch's runtime accepts the
 * object regardless.
 *
 * Package-internal export (NOT in the barrel) so contribution.ts shares this
 * exact object instead of declaring a second one. Two glob configurations
 * inside one package, one of which decides which untracked files enter a
 * recovery artifact, is a drift nothing would fail on.
 */
export const PICOMATCH_OPTIONS = {
  dot: true,
  nocase: false,
  posixSlashes: true,
  nonegate: true,
} as const;

/**
 * `git diff --name-status` token → ChangedFileStatus.
 * Renames (R<score>) and copies (C<score>) are handled explicitly elsewhere.
 * Anything not in this map is a fail-closed parse error.
 */
const NAME_STATUS_MAP: Readonly<Record<string, ChangedFileStatus>> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "type_changed",
};

/** Basename of the base-side mirror dir inside tempRoot. */
const MIRROR_BASE_DIR = "base";
/** Basename of the live-side mirror dir inside tempRoot. */
const MIRROR_LIVE_DIR = "live";

/**
 * mkdtemp prefix for this module's checkpoint-oracle scratch root. Passed
 * explicitly because the prefix appears verbatim in cleanup warnings, so each
 * oracle consumer names its own.
 */
const DIFF_TEMP_DIR_PREFIX = "viberevert-diff-";

// ============================================================================
// Path safety (throws — never silent skip)
// ============================================================================

/**
 * Error-contract adapter over the package's shared lexical authority.
 *
 * The rules, their order, and their exact message text live once in
 * path-safety.ts. This wrapper only chooses the error type, because M C
 * callers catch DiffParseError specifically and a deduplication must not
 * change which error reaches a call site. See path-safety.ts for why the
 * shared helper returns a message rather than throwing.
 */
function assertSafeRepoRelativePath(path: string, context: string): void {
  const message = repoRelativePathSafetyError(path, context);
  if (message !== null) {
    throw new DiffParseError(message);
  }
}

// ============================================================================
// Name-status parser
// ============================================================================

/**
 * One entry from `git diff --name-status -z`.
 *
 * `previous_path` is populated only for renames, which the -z format follows
 * with an extra NUL-separated old-path token.
 */
export interface NameStatusEntry {
  readonly status: ChangedFileStatus;
  readonly path: string;
  readonly previous_path?: string;
}

export interface ParseNameStatusOptions {
  /**
   * Path policy applied to every emitted path and rename alias. Defaults to
   * this module's guard, which raises DiffParseError.
   *
   * A VALIDATOR, never a filter. See the parser's doc comment for why the
   * distinction is load-bearing.
   */
  readonly validatePath?: (path: string, context: string) => void;
}

/**
 * Parse `git diff --name-status -z` output.
 *
 * Package-internal (not barrel-exported). Consumed by ref mode here and by
 * M 0.8.0's contribution capture for its committed-delta read.
 *
 * **`opts.validatePath` is a validator, not a filter, on purpose.**
 * Contribution capture hard-excludes `.viberevert/**` instead of failing on
 * it, so that a tracked or force-added store path leaves `end` working. But
 * that exclusion belongs at candidate assembly, not here: a rename
 * `src/a.ts -> .viberevert/a.ts` must still surface both aliases so the
 * caller can drop the store-side destination while keeping `src/a.ts` as an
 * ordinary session deletion. Discarding the entry at this layer would lose
 * the non-store side with no way to recover it.
 *
 * Copy tokens stay fail-closed regardless of policy, which is what keeps a
 * `C` entry from ever reaching a rename-proposal set.
 */
export function parseNameStatus(
  buf: Buffer,
  opts: ParseNameStatusOptions = {},
): readonly NameStatusEntry[] {
  const validatePath = opts.validatePath ?? assertSafeRepoRelativePath;
  if (buf.length === 0) return [];
  const tokens = splitNulList(buf);
  const out: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const rawStatus = tokens[i];
    if (rawStatus === undefined) break; // unreachable in practice; satisfies TS noUncheckedIndexedAccess
    if (rawStatus === "") {
      throw new DiffParseError(
        `parseNameStatus: empty status token at index ${i} (malformed -z output)`,
      );
    }
    // Rename: token MUST match R<digits>. Anything starting with R but not
    // matching that is a fail-closed parse error.
    if (rawStatus.startsWith("R")) {
      if (!/^R\d+$/.test(rawStatus)) {
        throw new DiffParseError(
          `parseNameStatus: malformed rename token ${JSON.stringify(rawStatus)} (expected R<score>)`,
        );
      }
      const previous = tokens[i + 1];
      const current = tokens[i + 2];
      if (previous === undefined || current === undefined) {
        throw new DiffParseError(
          `parseNameStatus: truncated rename pair after ${JSON.stringify(rawStatus)}`,
        );
      }
      validatePath(previous, "parseNameStatus.previous_path");
      validatePath(current, "parseNameStatus.path");
      out.push({ status: "renamed", path: current, previous_path: previous });
      i += 3;
      continue;
    }
    // Copies are not supported in M C — fail-closed.
    if (rawStatus.startsWith("C")) {
      throw new DiffParseError(
        `parseNameStatus: copy detection not supported (token ${JSON.stringify(rawStatus)})`,
      );
    }
    const mapped = NAME_STATUS_MAP[rawStatus];
    if (mapped === undefined) {
      throw new DiffParseError(
        `parseNameStatus: unknown status token ${JSON.stringify(rawStatus)}`,
      );
    }
    const path = tokens[i + 1];
    if (path === undefined) {
      throw new DiffParseError(
        `parseNameStatus: truncated entry after status ${JSON.stringify(rawStatus)}`,
      );
    }
    validatePath(path, "parseNameStatus.path");
    out.push({ status: mapped, path });
    i += 2;
  }
  return out;
}

// ============================================================================
// Unified-diff parser
// ============================================================================

interface ParsedUnifiedEntry {
  readonly path: string;
  readonly previous_path?: string;
  /** Status derived from unified-diff headers (used by checkpoint mode). */
  readonly derivedStatus?: ChangedFileStatus;
  readonly isBinary: boolean;
  readonly hunks: readonly RawDiffHunk[];
}

interface ParseUnifiedDiffOpts {
  /** When true, strip leading `a/` and `b/` from header path tokens. */
  readonly stripPrefixes: boolean;
  /**
   * Additional path prefixes (each ending in `/`) to strip after a/ b/
   * stripping. Used by checkpoint mode to peel mirror-dir basenames
   * (`base/`, `live/`).
   */
  readonly additionalStripPrefixes?: readonly string[];
}

function parseUnifiedDiff(text: string, opts: ParseUnifiedDiffOpts): readonly ParsedUnifiedEntry[] {
  if (text.length === 0) return [];
  const chunks = text.split(/^diff --git /m).slice(1);
  if (chunks.length === 0 && text.trim().length > 0) {
    const head = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    throw new DiffParseError(
      "parseUnifiedDiff: non-empty input with zero `diff --git` chunks",
      head,
    );
  }
  return chunks.map((c) => parseEntry(c, opts));
}

function parseEntry(entryText: string, opts: ParseUnifiedDiffOpts): ParsedUnifiedEntry {
  const lines = entryText.split("\n");
  const headerLine = lines[0] ?? "";
  let path = extractPathFromHeader(headerLine, opts);
  let previousPath: string | undefined;
  let derivedStatus: ChangedFileStatus | undefined;
  let isBinary = false;
  let oldMode: string | undefined;
  let newMode: string | undefined;
  let sawRenameFrom = false;
  let sawRenameTo = false;
  const hunks: RawDiffHunk[] = [];
  let i = 1;

  // Header scan: pre-hunk metadata lines.
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.startsWith("@@ ")) break;
    if (line.startsWith("Binary files ")) {
      isBinary = true;
      const p = extractBinaryPath(line, opts);
      if (p !== null) path = p;
    } else if (line === "GIT binary patch") {
      // `git diff --binary` emits this exact header line followed by an
      // inline base85 patch block. We don't decode the block; mark binary
      // and let the hunk loop consume the remaining lines as non-hunk.
      isBinary = true;
    } else if (line.startsWith("new file mode ")) {
      derivedStatus = "added";
    } else if (line.startsWith("deleted file mode ")) {
      derivedStatus = "deleted";
    } else if (line.startsWith("old mode ")) {
      oldMode = line.slice("old mode ".length);
    } else if (line.startsWith("new mode ")) {
      newMode = line.slice("new mode ".length);
    } else if (line.startsWith("rename from ")) {
      previousPath = stripAllPrefixes(line.slice("rename from ".length), opts);
      sawRenameFrom = true;
      derivedStatus = "renamed";
    } else if (line.startsWith("rename to ")) {
      const p = stripAllPrefixes(line.slice("rename to ".length), opts);
      if (p.length > 0) path = p;
      sawRenameTo = true;
      derivedStatus = "renamed";
    } else if (line.startsWith("+++ ")) {
      const raw = line.slice("+++ ".length);
      if (raw !== "/dev/null") {
        const p = stripAllPrefixes(raw, opts);
        if (p.length > 0) path = p;
      }
    }
    i += 1;
  }

  // Rename pair MUST appear together; an isolated half is malformed input.
  if (sawRenameFrom !== sawRenameTo) {
    throw new DiffParseError(
      "parseEntry: rename header has only one of 'rename from' / 'rename to'",
      entryText.length > 500 ? `${entryText.slice(0, 500)}…` : entryText,
    );
  }

  // Mode-only change → type_changed (if no stronger signal).
  if (
    derivedStatus === undefined &&
    oldMode !== undefined &&
    newMode !== undefined &&
    oldMode !== newMode
  ) {
    derivedStatus = "type_changed";
  }

  assertSafeRepoRelativePath(path, "parseEntry.path");
  if (previousPath !== undefined) {
    assertSafeRepoRelativePath(previousPath, "parseEntry.previous_path");
  }

  if (isBinary) {
    return {
      path,
      ...(previousPath !== undefined ? { previous_path: previousPath } : {}),
      ...(derivedStatus !== undefined ? { derivedStatus } : {}),
      isBinary: true,
      hunks: [],
    };
  }

  // Hunk loop.
  while (i < lines.length) {
    const headerCandidate = lines[i];
    if (headerCandidate === undefined) break;
    if (!headerCandidate.startsWith("@@ ")) {
      i += 1;
      continue;
    }
    const header = parseHunkHeader(headerCandidate);
    const hunkLines: LineChunk[] = [];
    i += 1;
    while (i < lines.length) {
      const l = lines[i];
      if (l === undefined) break;
      if (l.startsWith("@@ ") || l.startsWith("diff --git ")) break;
      if (l.length === 0) {
        // Tolerate a single trailing blank line at end-of-entry only.
        if (i === lines.length - 1) {
          i += 1;
          continue;
        }
        throw new DiffParseError(
          `parseEntry: unexpected blank line inside hunk body at index ${i}`,
          entryText.length > 500 ? `${entryText.slice(0, 500)}…` : entryText,
        );
      }
      const prefix = l[0];
      const body = l.slice(1);
      if (prefix === "+") hunkLines.push({ kind: "add", text: body });
      else if (prefix === "-") hunkLines.push({ kind: "remove", text: body });
      else if (prefix === " ") hunkLines.push({ kind: "context", text: body });
      else if (prefix === "\\") {
        // "\ No newline at end of file" — informational, ignore.
      } else {
        throw new DiffParseError(
          `parseEntry: unknown hunk-line prefix ${JSON.stringify(prefix)}`,
          entryText.length > 500 ? `${entryText.slice(0, 500)}…` : entryText,
        );
      }
      i += 1;
    }
    hunks.push({ ...header, lines: hunkLines });
  }

  return {
    path,
    ...(previousPath !== undefined ? { previous_path: previousPath } : {}),
    ...(derivedStatus !== undefined ? { derivedStatus } : {}),
    isBinary: false,
    hunks,
  };
}

function extractPathFromHeader(headerLine: string, opts: ParseUnifiedDiffOpts): string {
  // Quoted-path fail-closed: this parser does not decode core.quotepath
  // output. Any header containing `"` is rejected. As a side effect, this
  // also rejects paths containing literal spaces (which would split into
  // more than 2 tokens) until -z header decoding is deliberately added.
  if (headerLine.includes('"')) {
    throw new DiffParseError(`parseEntry: quoted path in header ${JSON.stringify(headerLine)}`);
  }
  const parts = headerLine.split(" ");
  if (parts.length !== 2) {
    throw new DiffParseError(
      `parseEntry: malformed header (expected exactly 2 space-separated tokens) ${JSON.stringify(headerLine)}`,
    );
  }
  return stripAllPrefixes(parts[1] ?? "", opts);
}

function extractBinaryPath(line: string, opts: ParseUnifiedDiffOpts): string | null {
  // "Binary files a/foo and b/foo differ"
  const m = /^Binary files .+ and (.+) differ$/.exec(line);
  if (m === null) return null;
  const raw = m[1];
  if (raw === undefined || raw === "/dev/null") return null;
  return stripAllPrefixes(raw, opts);
}

function stripAllPrefixes(s: string, opts: ParseUnifiedDiffOpts): string {
  let out = s;
  if (opts.stripPrefixes) {
    if (out.startsWith("a/")) out = out.slice(2);
    else if (out.startsWith("b/")) out = out.slice(2);
  }
  if (opts.additionalStripPrefixes !== undefined) {
    for (const p of opts.additionalStripPrefixes) {
      if (out.startsWith(p)) {
        out = out.slice(p.length);
        break;
      }
    }
  }
  return out;
}

function parseHunkHeader(line: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
} {
  // @@ -oldStart[,oldLines] +newStart[,newLines] @@
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) {
    throw new DiffParseError(`parseHunkHeader: malformed header ${JSON.stringify(line)}`);
  }
  return {
    oldStart: Number.parseInt(m[1] ?? "0", 10),
    oldLines: m[2] === undefined ? 1 : Number.parseInt(m[2], 10),
    newStart: Number.parseInt(m[3] ?? "0", 10),
    newLines: m[4] === undefined ? 1 : Number.parseInt(m[4], 10),
  };
}

// ============================================================================
// Merge name-status (authoritative) with unified-diff hunks — ref mode
// ============================================================================

function mergeNameStatusAndUnified(
  nameStatus: readonly NameStatusEntry[],
  unified: readonly ParsedUnifiedEntry[],
): readonly RawDiffEntry[] {
  const byPath = new Map<string, ParsedUnifiedEntry>();
  for (const u of unified) byPath.set(u.path, u);
  const out: RawDiffEntry[] = [];
  for (const ns of nameStatus) {
    const u = byPath.get(ns.path);
    out.push({
      path: ns.path,
      ...(ns.previous_path === undefined ? {} : { previous_path: ns.previous_path }),
      status: ns.status,
      isBinary: u?.isBinary ?? false,
      hunks: u?.hunks ?? [],
    });
  }
  return out;
}

// ============================================================================
// Unified → RawDiffEntry directly — checkpoint mode (one --no-index call)
// ============================================================================

function unifiedToRawEntries(unified: readonly ParsedUnifiedEntry[]): readonly RawDiffEntry[] {
  return unified.map((u) => ({
    path: u.path,
    ...(u.previous_path === undefined ? {} : { previous_path: u.previous_path }),
    status: u.derivedStatus ?? "modified",
    isBinary: u.isBinary,
    hunks: u.hunks,
  }));
}

// ============================================================================
// Untracked enumeration (bounded read; lstat — skips symlinks)
// ============================================================================

async function getUntrackedEntries(repoRoot: string): Promise<readonly RawDiffEntry[]> {
  const buf = await runGit(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const paths = splitNulList(buf).filter((p) => p.length > 0);
  const entries: RawDiffEntry[] = [];
  for (const p of paths) {
    // Unsafe paths from git ls-files THROW — they're a misconfiguration signal.
    assertSafeRepoRelativePath(p, "getUntrackedEntries.path");
    const abs = join(repoRoot, ...p.split("/"));
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch {
      continue;
    }
    // Skip non-regular files (symlinks, sockets, FIFOs, devices, dirs).
    if (!st.isFile()) continue;
    if (st.size > MAX_UNTRACKED_TEXT_BYTES) {
      entries.push({ path: p, status: "added", isBinary: true, hunks: [] });
      continue;
    }
    let body: Buffer;
    try {
      body = await readFile(abs);
    } catch {
      continue;
    }
    if (looksBinary(body)) {
      entries.push({ path: p, status: "added", isBinary: true, hunks: [] });
      continue;
    }
    const text = body.toString("utf8");
    const textLines = text.length === 0 ? [] : text.split("\n");
    if (textLines.length > 0 && textLines[textLines.length - 1] === "") textLines.pop();
    const lineChunks: LineChunk[] = textLines.map((t) => ({ kind: "add", text: t }));
    const hunks: RawDiffHunk[] =
      lineChunks.length === 0
        ? []
        : [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: lineChunks.length,
              lines: lineChunks,
            },
          ];
    entries.push({ path: p, status: "added", isBinary: false, hunks });
  }
  return entries;
}

function looksBinary(buf: Buffer): boolean {
  const scanLen = Math.min(buf.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < scanLen; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ============================================================================
// Tracked diff (two-call, ref mode)
// ============================================================================

async function getTrackedDiff(
  repoRoot: string,
  sha: string,
  staged: boolean,
): Promise<readonly RawDiffEntry[]> {
  const cachedFlag = staged ? ["--cached"] : [];
  // Both calls read the same SHA; run in parallel.
  const [nsBuf, unifiedText] = await Promise.all([
    runGit(repoRoot, ["diff", "--name-status", "-z", "-M", ...cachedFlag, sha]),
    runGitText(repoRoot, [
      "diff",
      "--no-color",
      "-U0",
      "--binary",
      "-M",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      ...cachedFlag,
      sha,
    ]),
  ]);
  const ns = parseNameStatus(nsBuf);
  const unified = parseUnifiedDiff(unifiedText, { stripPrefixes: true });
  return mergeNameStatusAndUnified(ns, unified);
}

// ============================================================================
// Mirror construction (lstat — skips symlinks; regular files only)
// ============================================================================

async function copyToMirror(
  sourceRoot: string,
  mirrorRoot: string,
  paths: readonly string[],
): Promise<void> {
  for (const p of paths) {
    assertSafeRepoRelativePath(p, "copyToMirror.path");
    const src = join(sourceRoot, ...p.split("/"));
    let st: Stats;
    try {
      st = await lstat(src);
    } catch {
      // Source doesn't exist on this side — fine; mirror just won't contain it.
      continue;
    }
    if (!st.isFile()) continue; // skip symlinks, sockets, FIFOs, devices, dirs
    const dst = join(mirrorRoot, ...p.split("/"));
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
}

// ============================================================================
// Prepared-mirror diffing (shared seam; NOT barrel-exported)
// ============================================================================

/**
 * What a mirror comparison is allowed to tell a caller: content, and nothing
 * else.
 *
 * `derivedStatus` and `previous_path` are deliberately absent. Mirrors diff
 * copied files with no index and no git mode bits, so a rename or status they
 * appear to show is a heuristic over detached copies rather than a fact any
 * consumer could reproduce from the evidence. M 0.8.0's derivation contract
 * makes that explicit: operation comes from PathStates, and rename identity
 * comes from real git run against real trees and a real index. Exporting the
 * richer shape would hand `contribution.ts` exactly the two fields it is
 * forbidden to use.
 */
export interface PreparedMirrorDiffEntry {
  readonly path: string;
  readonly isBinary: boolean;
  readonly hunks: readonly RawDiffHunk[];
}

/**
 * Reject a mirror directory name this module could not handle safely.
 *
 * The charset is deliberately narrower than "a single path segment", because
 * a valid directory name is not automatically a name this module can round
 * trip. `base dir` is a perfectly good directory and reaches git as one argv
 * operand, but it then appears inside the unified-diff header, where
 * `extractPathFromHeader` requires exactly two space-separated tokens and
 * fails closed. A name containing `"` hits the same parser's quoted-path
 * guard. Accepting inputs the parser will later refuse would make this
 * validator promise more than the module delivers.
 *
 * These are internal scratch identifiers, not user filenames, so there is no
 * product value in allowing spaces, quotes, or non-ASCII. Restricting to ASCII
 * also makes the case-insensitive distinctness check below plain ASCII folding
 * rather than Unicode lowercasing, which is what the contract specifies.
 *
 * The pattern requires at least one character, so the empty name is rejected
 * by the charset rule itself. `.` and `..` match the charset and therefore
 * need their own check.
 *
 * Raises a plain Error rather than DiffParseError: these names are
 * caller-supplied constants, so a violation is a programming error inside this
 * package, not a failure to parse git output that callers catch and handle.
 */
function assertMirrorDirName(name: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      `diffPreparedMirrors: ${label} must contain only ASCII letters, digits, ".", "_", or "-", got ${JSON.stringify(name)}`,
    );
  }
  if (name === "." || name === "..") {
    throw new Error(`diffPreparedMirrors: ${label} must not be ${JSON.stringify(name)}`);
  }
}

/**
 * Run one bounded mirror-vs-mirror diff and parse it. Private because the
 * result still carries `derivedStatus` and `previous_path`, which only
 * checkpoint mode may consume.
 *
 * `cwd` is `tempRoot` and the operands are bare basenames, so no absolute path
 * reaches the git argv. Exit 1 means "differences exist" under the
 * `--no-index` contract and is therefore success.
 *
 * Rename detection is always spelled EXPLICITLY: `--no-renames` rather than
 * omitting `-M`, because `diff.renames` is enabled by default and a merely
 * absent flag would leave detection on while the parameter claimed otherwise.
 *
 * Sorting by path happens here so the seam's output is deterministic for both
 * callers. `unifiedToRawEntries` is an order-preserving 1:1 map, so moving the
 * sort ahead of it leaves checkpoint mode's result unchanged.
 */
async function parsePreparedMirrors(
  tempRoot: string,
  baseDirName: string,
  liveDirName: string,
  opts: { readonly detectRenames: boolean },
): Promise<readonly ParsedUnifiedEntry[]> {
  assertMirrorDirName(baseDirName, "baseDirName");
  assertMirrorDirName(liveDirName, "liveDirName");
  // Case-insensitive because the two names alias on common Windows and macOS
  // filesystems. Equal names would silently self-diff and report no content
  // delta at all, which is the worst possible failure for a comparison whose
  // output decides what gets restored.
  if (baseDirName.toLowerCase() === liveDirName.toLowerCase()) {
    throw new Error(
      `diffPreparedMirrors: mirror directory names must differ, got ${JSON.stringify(baseDirName)} and ${JSON.stringify(liveDirName)}`,
    );
  }

  const renameFlag = opts.detectRenames ? "-M" : "--no-renames";
  const unifiedText = await runGitText(
    tempRoot,
    [
      "diff",
      "--no-color",
      "-U0",
      "--binary",
      renameFlag,
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--no-index",
      "--",
      baseDirName,
      liveDirName,
    ],
    { allowedExitCodes: [1] },
  );

  const unified = parseUnifiedDiff(unifiedText, {
    stripPrefixes: true,
    additionalStripPrefixes: [`${baseDirName}/`, `${liveDirName}/`],
  });
  return [...unified].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Diff two ALREADY-PREPARED sibling directories under `tempRoot`.
 *
 * Package-internal seam shared with M 0.8.0's contribution capture. It
 * performs no enumeration, no filtering, and no copying, and it owns no
 * scratch lifecycle: the caller decides what goes into each side and who
 * cleans up.
 *
 * Both names must match `[A-Za-z0-9._-]+`, must not be `.` or `..`, and must
 * differ case-insensitively. See assertMirrorDirName.
 *
 * `detectRenames` has NO default on purpose. Checkpoint mode wants `-M`;
 * contribution capture must not have it, because it normalizes alias
 * placement so both sides sit at the same path, and rename detection would
 * collapse that pair into rename headers and destroy the same-path hunks the
 * derivation contract needs. A default is how a caller silently inherits the
 * wrong one, and here the wrong one is a correctness bug.
 *
 * Returns content only, sorted by path. See PreparedMirrorDiffEntry.
 */
export async function diffPreparedMirrors(
  tempRoot: string,
  baseDirName: string,
  liveDirName: string,
  opts: { readonly detectRenames: boolean },
): Promise<readonly PreparedMirrorDiffEntry[]> {
  const unified = await parsePreparedMirrors(tempRoot, baseDirName, liveDirName, opts);
  return unified.map((u) => ({ path: u.path, isBinary: u.isBinary, hunks: u.hunks }));
}

// ============================================================================
// Public — git-ref base
// ============================================================================

export async function getDiffSinceRef(
  repoRoot: string,
  ref: string,
  opts: { staged?: boolean } = {},
): Promise<DiffResult> {
  const staged = opts.staged === true;
  // Delegate ref-to-SHA resolution to the single source of truth in
  // git-cli.ts. CommitRefNotFoundError is wrapped back into
  // DiffRefNotFoundError for backward compatibility with M C callers that
  // catch the diff-specific error type. Other error classes (notably
  // GitNotAvailableError) propagate unchanged.
  let sha: string;
  try {
    sha = await resolveCommitRef(repoRoot, ref);
  } catch (cause) {
    if (cause instanceof CommitRefNotFoundError) {
      throw new DiffRefNotFoundError(ref, cause);
    }
    throw cause;
  }
  const tracked = await getTrackedDiff(repoRoot, sha, staged);
  const untracked = staged ? [] : await getUntrackedEntries(repoRoot);
  // De-dup by path: tracked wins over untracked when both appear (extremely
  // rare; defensive).
  const seen = new Set<string>();
  const entries: RawDiffEntry[] = [];
  for (const e of tracked) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    entries.push(e);
  }
  for (const e of untracked) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    entries.push(e);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { diff: { entries }, cleanupWarnings: [] };
}

// ============================================================================
// Public — checkpoint/session base
// ============================================================================

export async function getDiffSinceCheckpoint(
  repoRoot: string,
  checkpointDir: string,
  opts: DiffSinceCheckpointOptions = {},
): Promise<DiffResult> {
  const { value, cleanupWarnings } = await withCheckpointOracle(repoRoot, checkpointDir, {
    tempDirPrefix: DIFF_TEMP_DIR_PREFIX,
    // Mirror dirs are created while NO worktree exists yet. That position is
    // the shipped failure ordering, not a convenience; see
    // checkpoint-oracle.ts.
    prepareTempRoot: async (tempRoot) => {
      await mkdir(join(tempRoot, MIRROR_BASE_DIR), { recursive: true });
      await mkdir(join(tempRoot, MIRROR_LIVE_DIR), { recursive: true });
    },
    run: async ({ tempRoot, worktreePath }) => {
      const mirrorBase = join(tempRoot, MIRROR_BASE_DIR);
      const mirrorLive = join(tempRoot, MIRROR_LIVE_DIR);

      // 1. Enumerate candidate paths from BOTH sides (auto-respects .gitignore).
      const [scratchBuf, liveBuf] = await Promise.all([
        runGit(worktreePath, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
        runGit(repoRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
      ]);
      const scratchPaths = splitNulList(scratchBuf).filter((p) => p.length > 0);
      const livePaths = splitNulList(liveBuf).filter((p) => p.length > 0);

      const candidateSet = new Set<string>();
      for (const p of scratchPaths) candidateSet.add(p);
      for (const p of livePaths) candidateSet.add(p);

      // 2. Filter by liveExcludePatterns + always-on `.viberevert/` defense.
      //    Unsafe paths from ls-files THROW (misconfiguration signal).
      const livePatterns = opts.liveExcludePatterns ?? [];
      const matchers = livePatterns.map((pat) => picomatch(pat, PICOMATCH_OPTIONS));
      const filtered: string[] = [];
      for (const p of candidateSet) {
        assertSafeRepoRelativePath(p, "getDiffSinceCheckpoint.candidate");
        // assertSafeRepoRelativePath already throws on .viberevert/ paths.
        let excluded = false;
        for (const m of matchers) {
          if (m(p)) {
            excluded = true;
            break;
          }
        }
        if (!excluded) filtered.push(p);
      }
      // Deterministic copy + downstream diff order.
      filtered.sort();

      // 3. Copy regular files into sanitized mirror dirs (lstat — skips symlinks).
      await copyToMirror(worktreePath, mirrorBase, filtered);
      await copyToMirror(repoRoot, mirrorLive, filtered);

      // 4. Single bounded mirror-vs-mirror diff, parsed and path-sorted. Shared
      //    with contribution capture via parsePreparedMirrors; `-M` keeps this
      //    path's argv exactly as shipped.
      const unified = await parsePreparedMirrors(tempRoot, MIRROR_BASE_DIR, MIRROR_LIVE_DIR, {
        detectRenames: true,
      });

      // 5. Derive status from unified-diff headers. Checkpoint mode is the only
      //    consumer of those derived fields, which is why they stay private to
      //    this module rather than crossing the seam.
      return unifiedToRawEntries(unified);
    },
  });

  return { diff: { entries: value }, cleanupWarnings };
}

// ============================================================================
// Test-only exports (NOT in barrel; _*ForTests convention)
// ============================================================================

export const _parseUnifiedDiffForTests = parseUnifiedDiff;
// Retained as an alias even though parseNameStatus is now a package-internal
// export: diff.test.ts imports this name, and renaming it there would churn a
// suite whose untouched state is the behavior-neutrality witness for the 4b
// refactors.
export const _parseNameStatusForTests = parseNameStatus;
export const _assertSafeRepoRelativePathForTests = assertSafeRepoRelativePath;
