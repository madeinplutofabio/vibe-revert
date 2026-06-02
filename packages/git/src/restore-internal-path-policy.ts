// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// restore-internal-path-policy — single source of truth for VibeRevert's
// own storage root (".viberevert/**") policy across the restore subsystem.
//
// Owns:
//   - VIBEREVERT_INTERNAL_STORAGE_ROOT (constant)
//   - isVibeRevertInternalPath (path predicate with full normalization)
//   - decodeGitQuotedEscapesForPolicyScan (C-escape decoder)
//   - patchHeaderTargetsVibeRevertInternalPath (patch-header predicate)
//   - VIBEREVERT_INTERNAL_PATH_HEADER_RE (internal regex; not exported)
//
// Consumed by:
//
//   restore-preflight.ts (EVIDENCE side — corrupt-evidence rejects):
//     - manifest.untracked.file_hashes keys
//     - manifest.snapshots.file_hashes keys
//     - manifest.snapshots.tracked_dirty_paths entries
//     - per-entry archive paths
//     - staged.patch / unstaged.patch header references
//
//   restore.ts (MUTATION side — never touch VibeRevert storage):
//     - deleteUncapturedUntracked: skip during untracked deletion
//     - planRestoreCheckpoint's deletion enumeration: skip during dry-run
//     - clearExtractionPathConflicts: LOUD TRIPWIRE conflict (cleanup
//       seeing `.viberevert/**` means an impossible path reached
//       mutation logic — non-mutating but surfaces as
//       RestoreExtractionConflictError rather than silent skip, so the
//       drift becomes visible at the throw point)
//     - extractUntrackedTarball: tar filter reject (defense-in-depth
//       against preflight drift)
//
// =============================================================================
// Centralization rationale (M D Step 3 architectural lock)
// =============================================================================
//
// The `.viberevert/**` policy is TRUST-CRITICAL: a regression that lets
// restore mutate VibeRevert's own storage would destroy the emergency
// pre-rollback checkpoint (the user's safety net) WHILE restore is
// running. There's no recovery path from that — by the time the user
// realizes the emergency checkpoint is gone, the restore has either
// completed or failed, with no rollback option.
//
// Previously the predicate, regex, and decoder were duplicated across
// restore-preflight.ts and restore.ts (each file had its own
// isVibeRevertInternalPath helper with the same body, and only
// restore-preflight.ts had the regex + decoder). That was tolerable for
// one design pass but invites drift — a future change to one wouldn't
// surface as a typecheck failure but as a silent corruption window.
//
// Centralizing here means:
//
//   - **One predicate.** Symmetric normalization (case-insensitive,
//     separator-insensitive, slash-collapse, root dot-segment strip)
//     applies to every restore-subsystem call site identically. If
//     we add a new edge case (e.g., Unicode normalization for fancy
//     `.viberevert` lookalikes), one edit.
//   - **One regex.** The patch-header check has been through several
//     iterations (token-anchored to block nested-bypass, then
//     backslash-normalizing for Windows-form patches, then
//     slash-collapse for combined-escape attacks, then `./`-root
//     handling for dot-segment forms); having one canonical definition
//     means one place to audit and test.
//   - **One decoder.** The C-escape decoder is subtle (octal vs named,
//     greedy matching); having one tested implementation means
//     consistency.
//   - **Direct test surface.** Tests hit the policy module's exported
//     functions without fragile private-helper access patterns. The
//     integration layer in restore-preflight.ts / restore.ts only
//     needs to prove "we call the policy at this surface", not
//     "the policy itself is correct".

/**
 * Path of VibeRevert's storage root, relative to the repo root. Always
 * `.viberevert` on disk; centralized as a constant so future moves
 * (e.g., a configurable storage root, or a versioned subdirectory)
 * have one edit site.
 */
export const VIBEREVERT_INTERNAL_STORAGE_ROOT = ".viberevert" as const;

/**
 * Returns `true` for any path under `.viberevert/` (the VibeRevert
 * storage root), after normalization. The predicate handles five
 * normalization steps so it's resistant to tampering tricks that
 * preserve the effective target path while changing the surface form:
 *
 *   1. **Backslash → forward slash** (`.replace(/\\/g, "/")`). On
 *      case-insensitive filesystems (Windows NTFS, macOS HFS+/APFS
 *      default), `\` is a separator equivalent to `/`. Tampered paths
 *      using backslashes would resolve to the same on-disk location.
 *
 *   2. **Collapse sequential slashes** (`.replace(/\/+/g, "/")`).
 *      `.viberevert//foo` resolves to `.viberevert/foo` per POSIX
 *      path rules; the duplicate-slash form is just a tampering
 *      vector.
 *
 *   3. **Lowercase** (`.toLowerCase()`). Case-insensitive filesystems
 *      address `.VIBEREVERT/foo` and `.viberevert/foo` as the same
 *      directory; a tampered manifest could declare any casing
 *      variant.
 *
 *   4. **Strip leading `./` segments** (`.replace(/^(?:\.\/)+/, "")`).
 *      `./.viberevert/foo` is identical to `.viberevert/foo` after
 *      dot-segment resolution; the leading-`./` form is just a
 *      tampering vector. Anchored at `^` so nested mid-path
 *      `./` segments are NOT stripped (correctly preserves
 *      `foo/./.viberevert/bar` as a nested-and-thus-not-ours form).
 *
 *   5. **Equal-or-startsWith** check against `.viberevert` /
 *      `.viberevert/`. Equal handles the bare-root case
 *      (`.viberevert` with no children); startsWith handles paths
 *      with children.
 *
 * Order matters for ops 1-4:
 *   - Backslash → slash BEFORE slash-collapse (so `.\\.viberevert/foo`
 *     normalizes correctly via `\\` → `//` → `/`).
 *   - Slash-collapse BEFORE strip (so `.//.viberevert/foo` collapses
 *     to `./.viberevert/foo` before the strip can recognize it).
 *   - Lowercase position vs strip is interchangeable (the `./` strip
 *     regex is ASCII); kept in the documented sequence for clarity.
 *
 * The predicate is policy-only — it makes no decision about WHAT to do
 * when matched (skip / throw / tripwire-conflict). Each caller applies
 * its own response per the call-site contract documented in restore.ts
 * file header invariant #6 and restore-preflight.ts's
 * "VibeRevert internal path is corrupt evidence" block.
 *
 * **Test obligations (direct unit tests on the predicate):**
 *
 *   Positive (must return `true`):
 *     - `.viberevert` (bare root, no children)
 *     - `.viberevert/foo`
 *     - `.VIBEREVERT/foo` (case variant)
 *     - `.viberevert\foo` (backslash separator)
 *     - `.viberevert//foo` (double slash)
 *     - `./.viberevert/foo` (root dot-segment)
 *     - `.//.viberevert/foo` (root dot + double slash)
 *     - `././.viberevert/foo` (multiple root dot-segments)
 *     - `.VIBEREVERT\foo` (case + backslash combined)
 *
 *   Negative (must return `false`):
 *     - `foo/.viberevert/bar` (nested)
 *     - `foo/./.viberevert/bar` (nested with intermediate dot-segment;
 *       mid-path `./` NOT stripped since strip is `^`-anchored)
 *     - `foo.viberevert/bar` (suffix-named directory)
 *     - `.viberevertish/foo` (longer name starting with `.viberevert`)
 *     - `viberevert/foo` (missing leading dot)
 *     - `` (empty string)
 */
export function isVibeRevertInternalPath(path: string): boolean {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase()
    .replace(/^(?:\.\/)+/, "");

  return (
    normalized === VIBEREVERT_INTERNAL_STORAGE_ROOT ||
    normalized.startsWith(`${VIBEREVERT_INTERNAL_STORAGE_ROOT}/`)
  );
}

/**
 * Decode Git-style C-quoted path escapes enough for the policy scan to
 * catch obfuscation attacks.
 *
 * Git's quoted-path format (used in diff headers when paths contain
 * special chars) uses C-style escapes:
 *   - `\NNN` where NNN is 1-3 octal digits: byte value.
 *   - `\a` `\b` `\f` `\n` `\r` `\t` `\v` `\\` `\"` `\'`: standard C
 *     escapes.
 *
 * **The attack vector this closes:** a malicious patch could encode
 * `.viberevert` as `\056viberevert` (where `\056` is octal for `.` =
 * ASCII 46), or `.\166iberevert` (where `\166` is `v`), or fully
 * `\056\166\151\142\145\162\145\166\145\162\164`. Git would decode the
 * escapes during `git apply` and replay against the real
 * `.viberevert/...` path; a raw-text regex wouldn't see the
 * `.viberevert` substring in the encoded form. Decoding BEFORE the
 * regex test closes the bypass.
 *
 * **Encoding caveat (immaterial for the policy check):** each escaped
 * byte is decoded as a single Unicode code point via
 * `String.fromCharCode`. For multi-byte UTF-8 sequences (e.g.,
 * `\303\244` encoding `ä` as two bytes 0xC3 0xA4), the decoder produces
 * two separate U+00C3 U+00A4 code points instead of one U+00E4. This
 * is technically lossy as a general decoder, but the policy scan looks
 * for the all-ASCII string `.viberevert`, where each char is exactly
 * one byte regardless of encoding. So the decode is sound for THIS
 * use; a real Unicode-normalizing decoder would only be needed if the
 * check ever compared non-ASCII content.
 *
 * Unknown escapes fall through unchanged (defensive — git wouldn't
 * accept them either, so they wouldn't decode to `.viberevert` anyway).
 *
 * Exported for direct unit testing; production code goes through
 * `patchHeaderTargetsVibeRevertInternalPath`.
 */
export function decodeGitQuotedEscapesForPolicyScan(line: string): string {
  return line.replace(/\\([0-7]{1,3}|[abfnrtv\\"'])/g, (_match, esc: string) => {
    if (/^[0-7]{1,3}$/.test(esc)) {
      return String.fromCharCode(Number.parseInt(esc, 8));
    }
    switch (esc) {
      case "a":
        return "\x07";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "v":
        return "\v";
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "'":
        return "'";
      default:
        return esc;
    }
  });
}

/**
 * Regex matching `.viberevert` (case-insensitive) at a TRUE PATH-ROOT
 * position in a unified-diff header line. Used internally by
 * `patchHeaderTargetsVibeRevertInternalPath` after escape decoding +
 * separator normalization + slash-collapse.
 *
 * NOT exported: callers should always go through the predicate, which
 * applies the surrounding line-classification + normalization steps in
 * the correct order. Exposing the bare regex invites callers to forget
 * those upstream steps.
 *
 * Structure (token-anchored to block the nested-bypass that an inner
 * `a/` would otherwise allow):
 *   - `(?:^|[\s"])` — token-start gate: line-start, whitespace, or a
 *     quote character. MUST match a real token boundary; an internal
 *     `/` (mid-path separator) is NOT in the set, so nested paths
 *     can't anchor a match.
 *   - `(?:[ab]\/)?` — optional `a/` or `b/` prefix decoration (the
 *     `diff --git a/X b/Y` / `--- a/X` / `+++ b/Y` conventional prefix
 *     for diff-side paths). The OPTIONAL marker means rename/copy
 *     form (`rename from .viberevert/...`) also matches.
 *   - `(?:\.\/)*` — zero or more `./` dot-segments at the path root.
 *     Closes the dot-segment bypass: `a/./.viberevert/foo` normalizes
 *     to `a/.viberevert/foo` per POSIX path rules; git apply would
 *     apply against `.viberevert/foo` after canonicalization. The
 *     starred quantifier allows `././.viberevert/foo` etc. The
 *     dot-segment is ONLY matched at the path-root position — a
 *     nested `foo/./.viberevert/bar` is still correctly blocked
 *     because the char before `./` (the `/` after `foo`) fails the
 *     token-start gate.
 *   - `\.viberevert` — the literal path component.
 *   - `(?:\/|$|[\s":])` — token-end gate: slash (storage dir has
 *     children — the common case), end-of-string, whitespace, quote,
 *     or colon.
 *
 * Crucially does NOT match:
 *   - `foo/.viberevert/bar` (nested) — char before is `/`, fails gate.
 *   - `foo/a/.viberevert/bar` (deeply nested with inner `a/`) — char
 *     before the inner `a/` is `/`, fails gate.
 *   - `foo/./.viberevert/bar` (nested with intermediate dot-segment)
 *     — char before the `./` is `/`, fails gate even with the new
 *     `(?:\.\/)*` group.
 *   - `foo.viberevert/x` (suffix-named) — char before is `o`, fails.
 *   - `.viberevertish/x` (longer name) — char after is `i`, fails.
 *   - `.viberevert.txt` (filename, not directory) — char after
 *     `.viberevert` is `.`, fails the token-end gate.
 *
 * **Known conservative over-reject**: a quoted path with an embedded
 * space directly before a `.viberevert/` directory component — e.g.,
 * `--- "a/foo .viberevert/bar"` — will match because the space inside
 * the path satisfies the token-start gate. Deliberate trade-off:
 * line-level regex is auditable and bypass-resistant; full path-token
 * extraction would require a Git path parser. False positives are
 * recoverable (rename the offending file); false negatives would be
 * silent storage corruption. Test suite asserts this case explicitly
 * so the behavior is locked rather than hidden.
 */
const VIBEREVERT_INTERNAL_PATH_HEADER_RE =
  /(?:^|[\s"])(?:[ab]\/)?(?:\.\/)*\.viberevert(?:\/|$|[\s":])/i;

/**
 * Returns `true` if `line` is a STRUCTURAL HEADER LINE of a unified-diff
 * patch AND targets `.viberevert/**` (the VibeRevert storage root) as
 * a path-root reference. Returns `false` for:
 *   - Empty lines.
 *   - Hunk content lines (` `, `+`, `-` single-char-prefixed). `+++`
 *     and `---` are PRESERVED as header lines via explicit prefix
 *     check.
 *   - Hunk header lines (`@@ ...`).
 *   - No-newline markers (`\ No newline at end of file`).
 *   - Header lines that don't reference `.viberevert/**` at a path-
 *     root position.
 *
 * **Five-phase check** (order matters):
 *
 *   1. **Line classification.** Skip hunk content / hunk headers /
 *      no-newline markers. Distinguishes `+++ ` / `--- ` (header) from
 *      `+content` / `-content` (hunk content) via explicit prefix
 *      check.
 *
 *   2. **Decode Git C-style escapes** via
 *      `decodeGitQuotedEscapesForPolicyScan` (handles `\NNN` octal +
 *      named C escapes). Closes the `\056viberevert` obfuscation
 *      vector. RUNS FIRST so `\NNN` octal escapes are interpreted as
 *      bytes BEFORE step 3 touches literal backslashes — otherwise
 *      step 3 would convert the leading `\` of `\056` to `/`, leaving
 *      `/056viberevert` which the decoder no longer recognizes as an
 *      escape.
 *
 *   3. **Normalize backslash separators** to forward slashes. A
 *      tampered patch using Windows-style `a\.viberevert\foo` would
 *      normalize to `a/.viberevert/foo` and trigger the
 *      forward-slash-anchored regex. Git normalizes outgoing paths to
 *      forward slashes, but hand-crafted tampered patches might use
 *      backslashes — on Windows, the filesystem treats both as
 *      separators.
 *
 *   4. **Collapse sequential slashes** to one (`//+` → `/`). Closes
 *      the combined-escape vector: `"a/\134.viberevert/foo"` decodes
 *      to `a/\.viberevert/foo` (step 2), normalizes to
 *      `a//.viberevert/foo` (step 3 — because the decoded `\` is then
 *      converted to `/`), and would otherwise miss the regex (char
 *      before `.viberevert` becomes `/`, not in the token-start gate).
 *      Slash-collapse restores `a/.viberevert/foo` so the regex sees
 *      it as `a/.viberevert/foo` — which on Windows is exactly the
 *      path git would actually apply against.
 *
 *   5. **Apply the token-anchored regex** to the fully-normalized
 *      line. The regex itself handles `./` dot-segment forms at the
 *      path root via its `(?:\.\/)*` group; no separate pre-pass
 *      needed.
 *
 * Used by restore-preflight.ts's
 * `assertPatchDoesNotTargetVibeRevertInternalPaths` for both
 * `staged.patch` and `unstaged.patch`.
 *
 * Exported for direct unit testing. Test coverage should include:
 *
 *   Positive (reject):
 *     - Direct root: `--- a/.viberevert/...`
 *     - Case variants: `--- a/.VIBEREVERT/...`
 *     - Backslash variants: `--- a/.viberevert\foo`
 *     - C-escaped: `--- "a/\056viberevert/..."`
 *     - Combined escape + backslash: `--- "a/\134.viberevert/foo"`
 *       (decodes to `a/\.viberevert/foo`, normalizes to
 *       `a/.viberevert/foo` after slash-collapse)
 *     - Dot-segment root: `--- a/./.viberevert/foo`
 *     - Dot-segment + case: `+++ b/./.VIBEREVERT/foo`
 *     - Dot-segment + no prefix: `rename from ./.viberevert/foo`
 *     - Rename (bare): `rename from .viberevert/foo`
 *
 *   Negative (do NOT reject):
 *     - Nested: `--- a/foo/.viberevert/bar`
 *     - Deeply nested with inner `a/`:
 *       `--- a/foo/a/.viberevert/bar`
 *     - Nested with intermediate dot-segment:
 *       `--- a/foo/./.viberevert/bar`
 *     - Suffix-named directory: `--- a/foo.viberevert/bar`
 *     - Longer name starting with .viberevert:
 *       `--- a/.viberevertish/bar`
 *     - Filename not directory: `--- a/.viberevert.txt`
 *     - Hunk content lines (any content allowed, e.g.
 *       `+if (path === '.viberevert/config') ...`)
 *     - Hunk header lines (`@@ -1,3 +1,3 @@`)
 *
 *   Documented over-reject (LOCKED behavior — test asserts):
 *     - Quoted path with embedded space directly before
 *       `.viberevert/`: `--- "a/foo .viberevert/bar"` IS rejected
 *       (line-regex limitation; recoverable false positive vs
 *       catastrophic false negative trade-off).
 */
export function patchHeaderTargetsVibeRevertInternalPath(line: string): boolean {
  if (line.length === 0) return false;

  const first = line[0];
  // Skip hunk content (` `, `+`, `-` single-char-prefixed), hunk
  // headers (`@`), and no-newline markers (`\`). `+++` and `---`
  // are HEADER lines despite starting with `+` / `-`; preserve
  // them via the explicit prefix check.
  if (first === " " || first === "@" || first === "\\") return false;
  if ((first === "+" || first === "-") && !line.startsWith("+++ ") && !line.startsWith("--- ")) {
    return false;
  }

  // Phase 2: decode C-style escapes BEFORE backslash normalization so
  // `\NNN` octal escapes are interpreted as bytes (e.g., `\056` → `.`)
  // before step 3 touches literal backslashes.
  const decoded = decodeGitQuotedEscapesForPolicyScan(line);

  // Phase 3: normalize backslash separators to forward slashes
  // (Windows-form patches; tampered paths with literal backslashes).
  const slashNormalized = decoded.replace(/\\/g, "/");

  // Phase 4: collapse sequential slashes to one. Closes the
  // combined-escape vector documented above. Safe for legitimate paths
  // (which never contain `//` after the diff prefix).
  const collapsed = slashNormalized.replace(/\/+/g, "/");

  // Phase 5: apply the token-anchored regex. The regex's `(?:\.\/)*`
  // group handles `./` dot-segment forms at the path root.
  return VIBEREVERT_INTERNAL_PATH_HEADER_RE.test(collapsed);
}
