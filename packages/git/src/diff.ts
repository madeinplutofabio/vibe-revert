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
//     Single bounded tempRoot lifecycle:
//       tempRoot/worktree/   linked worktree at manifest.git.head_sha
//       tempRoot/base/       copy of candidate regular files (base side)
//       tempRoot/live/       copy of candidate regular files (live side)
//     Bootstraps the base via `git worktree add --detach`, overlays dirt
//     via reused restoreCheckpoint() (passing the manifest's CAPTURED
//     untracked.exclude_patterns), enumerates candidate paths from BOTH
//     sides via `git ls-files -z --cached --others --exclude-standard`,
//     filters by opts.liveExcludePatterns + the always-on .viberevert/
//     defense-in-depth, copies regular files into sanitized mirror dirs,
//     runs one bounded:
//       `git diff --no-color -U0 --binary -M --no-ext-diff --no-textconv
//        --src-prefix=a/ --dst-prefix=b/ --no-index -- base live`
//     with cwd=tempRoot (basename operands; exit 1 = differences exist =
//     success per --no-index contract). The unified parser strips the
//     `base/` and `live/` mirror prefixes via additionalStripPrefixes,
//     and derives status from unified-diff headers (new file mode /
//     deleted file mode / rename from-to / old-mode vs new-mode).
//
// Both helpers return DiffResult { diff, cleanupWarnings }. Cleanup
// failures are NEVER thrown (D29 + D17c terminal-write rule): they
// populate cleanupWarnings; the CLI inspects that field and decides
// whether to log to its OWN stderr. When the main algorithm throws and
// cleanup ALSO produces warnings, those warnings are attached to the
// thrown error as a `cleanupWarnings` property so they survive the throw.
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
// `..` segments, and the `.viberevert/` prefix.
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
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import picomatch from "picomatch";

import { loadCheckpoint } from "./checkpoint.js";
import {
  CommitRefNotFoundError,
  resolveCommitRef,
  runGit,
  runGitText,
  splitNulList,
} from "./git-cli.js";
import { restoreCheckpoint } from "./restore.js";

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
 */
const PICOMATCH_OPTIONS = {
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

const VIBEREVERT_DIR_PREFIX = ".viberevert/";

/** Basename of the base-side mirror dir inside tempRoot. */
const MIRROR_BASE_DIR = "base";
/** Basename of the live-side mirror dir inside tempRoot. */
const MIRROR_LIVE_DIR = "live";

// ============================================================================
// Path safety (throws — never silent skip)
// ============================================================================

function assertSafeRepoRelativePath(path: string, context: string): void {
  if (path.length === 0) {
    throw new DiffParseError(`${context}: empty path`);
  }
  if (path.includes("\\")) {
    throw new DiffParseError(`${context}: backslash in path ${JSON.stringify(path)}`);
  }
  if (path.startsWith("/")) {
    throw new DiffParseError(`${context}: absolute path ${JSON.stringify(path)}`);
  }
  if (/^[A-Za-z]:/.test(path)) {
    throw new DiffParseError(`${context}: Windows-drive path ${JSON.stringify(path)}`);
  }
  if (path === ".viberevert" || path.startsWith(VIBEREVERT_DIR_PREFIX)) {
    throw new DiffParseError(`${context}: path under .viberevert/ ${JSON.stringify(path)}`);
  }
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new DiffParseError(
        `${context}: unsafe segment ${JSON.stringify(seg)} in ${JSON.stringify(path)}`,
      );
    }
  }
}

// ============================================================================
// Name-status parser
// ============================================================================

interface NameStatusEntry {
  readonly status: ChangedFileStatus;
  readonly path: string;
  readonly previous_path?: string;
}

function parseNameStatus(buf: Buffer): readonly NameStatusEntry[] {
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
      assertSafeRepoRelativePath(previous, "parseNameStatus.previous_path");
      assertSafeRepoRelativePath(current, "parseNameStatus.path");
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
    assertSafeRepoRelativePath(path, "parseNameStatus.path");
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
// Cleanup (best-effort; populates warnings; never throws)
// ============================================================================

async function cleanupBestEffort(
  repoRoot: string,
  tempRoot: string | null,
  worktreePath: string | null,
  worktreeAdded: boolean,
  warnings: string[],
): Promise<void> {
  if (worktreeAdded && worktreePath !== null) {
    try {
      await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    } catch (e) {
      warnings.push(`git worktree remove --force failed for ${worktreePath}: ${stringifyErr(e)}`);
      try {
        await runGit(repoRoot, ["worktree", "prune"]);
      } catch (e2) {
        warnings.push(`git worktree prune fallback failed: ${stringifyErr(e2)}`);
      }
    }
  }
  if (tempRoot !== null) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch (e) {
      warnings.push(`rm -rf ${tempRoot} failed: ${stringifyErr(e)}`);
    }
  }
}

function stringifyErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
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
  const warnings: string[] = [];
  let tempRoot: string | null = null;
  let worktreePath: string | null = null;
  let worktreeAdded = false;
  let mainError: unknown = null;
  try {
    const manifest = await loadCheckpoint(checkpointDir);
    const headSha = manifest.git.head_sha;

    // Single bounded tempRoot; all scratch state lives under it.
    tempRoot = await mkdtemp(join(tmpdir(), "viberevert-diff-"));
    worktreePath = join(tempRoot, "worktree");
    const mirrorBase = join(tempRoot, MIRROR_BASE_DIR);
    const mirrorLive = join(tempRoot, MIRROR_LIVE_DIR);
    await mkdir(mirrorBase, { recursive: true });
    await mkdir(mirrorLive, { recursive: true });

    // 1. Bootstrap linked worktree at captured HEAD.
    await runGit(repoRoot, ["worktree", "add", "--detach", worktreePath, headSha]);
    worktreeAdded = true;

    // 2. Overlay captured dirt using the CAPTURED exclude patterns (faithful
    //    reproduction of capture state, NOT current config).
    await restoreCheckpoint(checkpointDir, {
      repoRoot: worktreePath,
      rollbackExcludePatterns: manifest.untracked.exclude_patterns ?? [],
    });

    // 3. Enumerate candidate paths from BOTH sides (auto-respects .gitignore).
    const [scratchBuf, liveBuf] = await Promise.all([
      runGit(worktreePath, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
      runGit(repoRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
    ]);
    const scratchPaths = splitNulList(scratchBuf).filter((p) => p.length > 0);
    const livePaths = splitNulList(liveBuf).filter((p) => p.length > 0);

    const candidateSet = new Set<string>();
    for (const p of scratchPaths) candidateSet.add(p);
    for (const p of livePaths) candidateSet.add(p);

    // 4. Filter by liveExcludePatterns + always-on `.viberevert/` defense.
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

    // 5. Copy regular files into sanitized mirror dirs (lstat — skips symlinks).
    await copyToMirror(worktreePath, mirrorBase, filtered);
    await copyToMirror(repoRoot, mirrorLive, filtered);

    // 6. Single bounded mirror-vs-mirror diff with cwd=tempRoot + basename
    //    operands. Exit 1 = differences exist = success per --no-index contract.
    const unifiedText = await runGitText(
      tempRoot,
      [
        "diff",
        "--no-color",
        "-U0",
        "--binary",
        "-M",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--no-index",
        "--",
        MIRROR_BASE_DIR,
        MIRROR_LIVE_DIR,
      ],
      { allowedExitCodes: [1] },
    );

    // 7. Parse; strip `base/` and `live/` mirror prefixes; derive status from
    //    unified-diff headers.
    const unified = parseUnifiedDiff(unifiedText, {
      stripPrefixes: true,
      additionalStripPrefixes: [`${MIRROR_BASE_DIR}/`, `${MIRROR_LIVE_DIR}/`],
    });
    const entries = unifiedToRawEntries(unified);
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { diff: { entries: sorted }, cleanupWarnings: warnings };
  } catch (e) {
    mainError = e;
    throw e;
  } finally {
    await cleanupBestEffort(repoRoot, tempRoot, worktreePath, worktreeAdded, warnings);
    // If the main algorithm threw AND cleanup also produced warnings,
    // attach them to the thrown error so the CLI can surface them.
    if (mainError !== null && warnings.length > 0 && mainError instanceof Error) {
      (mainError as Error & { cleanupWarnings?: readonly string[] }).cleanupWarnings = [
        ...warnings,
      ];
    }
  }
}

// ============================================================================
// Test-only exports (NOT in barrel; _*ForTests convention)
// ============================================================================

export const _parseUnifiedDiffForTests = parseUnifiedDiff;
export const _parseNameStatusForTests = parseNameStatus;
export const _assertSafeRepoRelativePathForTests = assertSafeRepoRelativePath;
