// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Secret-detection pattern set + threshold constants + suppression
// constants. Per D33 in the M C plan, this file is DATA-ONLY: the
// actual detector logic lives in ./secrets.ts (Step 4 file 2).
//
// =============================================================================
// NOTE ON GLOBSTAR REFERENCES IN COMMENTS
// =============================================================================
// Where prose references picomatch's recursive `**` operator followed
// by a path separator, this file uses the placeholder `<globstar>/`
// (same convention as packages/checks/src/classifiers/path-rules.ts).
// Reason: the literal sequence `**` immediately followed by `/`
// terminates a `/** */` block-comment early, breaking the TypeScript
// parser. Using `<globstar>/` keeps the convention safe across BOTH
// `//` line comments AND `/** */` JSDoc blocks, so future
// restructuring of comments (e.g., promoting a `//` block to a
// const-level JSDoc) cannot silently reintroduce the parser bug.
// Actual picomatch patterns in string literals (e.g., the entries in
// SUPPRESSION_FILE_PATTERNS below) use the real `**` syntax — string
// literals do not terminate comments.
//
// =============================================================================
// CRITICAL — GLOBAL REGEXP STATE WARNING
// =============================================================================
// Every pattern in SECRET_PATTERNS carries the /g flag. JavaScript's
// global-flag RegExp instances are STATEFUL: `RegExp.prototype.lastIndex`
// persists between `exec()` calls on the same instance. If a caller
// uses `exec()` in a loop AND the same RegExp instance is later
// scanned against a different input, lastIndex carries over and
// matches at the start of the new input are SILENTLY SKIPPED — a
// quintessential heisenbug that surfaces only under specific call
// orderings.
//
// SUBTLER trap: `String.prototype.matchAll(sharedRegex)` does NOT
// mutate the shared regex's lastIndex (so it's safe in that
// direction), BUT per ECMA-262 §22.2.5.10 it SEEDS the iterator's
// internal matcher from the shared regex's CURRENT lastIndex value
// at call time. So if some earlier code path left `sharedRegex.lastIndex`
// at N > 0 (e.g., via a prior `exec()` in a loop), a later
// `input.matchAll(sharedRegex)` will start iterating at position N of
// the new input and silently skip matches at positions 0..N-1. The
// shared regex is not mutated, but its lastIndex is READ. Calling
// matchAll directly on the shared regex is therefore UNSAFE.
//
// MITIGATION (locked discipline for ./secrets.ts):
//   - Before scanning, the detector CLONES the regex via
//     `new RegExp(pattern.regex.source, pattern.regex.flags)` and
//     then calls `matchAll()` on the clone. The clone is freshly
//     constructed so its `lastIndex` starts at 0 (per the RegExp
//     constructor's initialization), regardless of what state the
//     shared `pattern.regex` instance is in. matchAll on the clone
//     seeds its matcher from `clone.lastIndex` (= 0), so iteration
//     always starts at position 0 of the input.
//   - Future contributors editing the detector MUST preserve this
//     discipline. Do NOT call `pattern.regex.exec()`,
//     `pattern.regex.test()`, OR `input.matchAll(pattern.regex)`
//     directly on the shared instances in SECRET_PATTERNS. Always
//     clone first. (Resetting `.lastIndex = 0` on the shared
//     instance would also work but mutates shared state and is
//     fragile under concurrent / re-entrant access; cloning is
//     side-effect-free and safer.)
//
// Why this warning lives in secrets-patterns.ts (not secrets.ts):
// the data layer owns the RegExp instances. Any future consumer of
// SECRET_PATTERNS — not just secrets.ts — inherits the shared-mutable-
// state hazard. Putting the warning at the definition site is the
// only place that catches every future consumer, not just today's
// detector.
//
// =============================================================================
// DUPLICATION RATIONALE
// =============================================================================
// Patterns #1-6 are DUPLICATED from `packages/core/src/redact.ts`,
// NOT imported. Per D16/D29 the checks package cannot depend on
// core. The two systems serve different purposes (core.redact()
// scrubs known-leaked text before sync output; this detector scans
// diffs to surface possibly-leaked secrets to the user). Duplicating
// 6 regex sources is the locked precedent (D17c on atomic helper
// duplication across packages).
//
// A drift-guard test in test/detectors/secrets.test.ts (Step 4 file 4)
// asserts the regex sources declared in core/redact.ts's documented
// pattern set appear in this file's SECRET_PATTERNS array, catching
// one-sided edits that would otherwise let core and checks drift.
//
// =============================================================================
// ENTROPY HEURISTIC (pattern #7 only — env-style assignments)
// =============================================================================
// Pattern #7 (ENV-style NAME=VALUE) is the only pattern broad enough
// to need entropy-based confirmation. Its regex matches the form
// `STRIPE_SECRET=sk_live_abc` but would ALSO match
// `STRIPE_SECRET=changeme` — the former is a real key, the latter
// is a placeholder.
//
// The detector applies THREE conditions to pattern #7's value-group
// match before emitting a finding:
//   (a) Shannon entropy of the value > ENTROPY_THRESHOLD bits/char,
//   (b) value length >= MIN_SECRET_LENGTH,
//   (c) lowercased value is NOT in PLACEHOLDER_VALUES.
// All three must pass. If ANY fails, the match is SUPPRESSED ENTIRELY
// (not downgraded to "low" — that's a different suppression channel,
// see below).
//
// Random base62 strings have ~5.95 bits/char; human-readable phrases
// sit around 2-3 bits/char. 4.0 bits/char is the gate that admits
// random-looking values and rejects english-looking ones.
//
// The detector keeps entropy computation pure-JS (no node:crypto
// import — banned by D29). A 20-line frequency-count + log2 helper
// lives in ./secrets.ts.
//
// =============================================================================
// SUPPRESSION RULES (downgrade-to-low, distinct from entropy suppression)
// =============================================================================
// Two channels downgrade a secret finding to `level: "low"` (still
// emitted for audit but won't trip the gate by default):
//
//   FILE-BASED — SUPPRESSION_FILE_PATTERNS:
//   Findings on files matching any of these picomatch globs are
//   downgraded. Locked: `*.example`, `*.template` + the nested
//   monorepo variants (`<globstar>/*.example`, `<globstar>/*.template`).
//   Same discipline as PATH_RULES — root + nested alternatives so
//   `apps/web/.env.example` is also covered.
//
//   LINE-BASED — INLINE_SUPPRESSION_MARKERS:
//   Findings on lines containing any of these substrings are
//   downgraded. Single-line escape hatch for developers who need to
//   commit a test-fixture secret intentionally.
//
// IMPORTANT: file/line suppression DOWNGRADES to "low" (preserves
// the finding for audit). Entropy/placeholder suppression DROPS the
// finding ENTIRELY (no audit trail). The two channels serve
// different intents — the detector applies them in distinct code
// paths.

/**
 * Shannon entropy threshold (bits per character) for pattern #7's
 * value-group match. Values with entropy at or below this threshold
 * are treated as non-random (likely human-readable) and suppressed.
 * Random base62 strings score ~5.95 bits/char; english phrases score
 * ~2-3 bits/char. 4.0 is the locked gate.
 */
export const ENTROPY_THRESHOLD = 4.0;

/**
 * Minimum length (in characters) for a pattern #7 value-group match
 * to be considered a candidate secret. Values shorter than this are
 * suppressed without entropy/placeholder checks. Locked at 20 per D33.
 */
export const MIN_SECRET_LENGTH = 20;

/**
 * Lowercase placeholder values that suppress pattern #7 (env-style)
 * matches even when entropy + length thresholds pass. The detector
 * normalizes the matched value to lowercase before comparison
 * (EXACT match against this set, not substring).
 *
 * INCLUSION RULE (locked discipline): ONLY SPECIFIC placeholder
 * phrases. NEVER bare domain words like `secret`, `password`,
 * `token`, `test`, `demo` — those are too broad and would suppress
 * legitimate values that happen to equal those words. Future
 * contributors adding entries MUST stick to phrases that are
 * obviously meta-references (e.g. `your_X_here`, `replace_me`,
 * `changeme`) and not bare nouns.
 *
 * NOTE on redundancy with length check: short placeholders (<20
 * chars) are also auto-suppressed by MIN_SECRET_LENGTH, so this
 * list mainly serves as belt-and-suspenders + explicit documentation
 * of the suppression intent. If MIN_SECRET_LENGTH ever drops in a
 * future revision, this list still catches the canonical placeholders.
 */
export const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  // D33-listed examples.
  "changeme",
  "your_key_here",
  "xxx",
  "your-token",
  // Natural separator variants of the D33-listed examples.
  "change-me",
  "your-key-here",
  "your_token",
  "xxxx",
  // Other well-known placeholder phrases (specific, not bare nouns).
  "your_secret_here",
  "your-secret-here",
  "replace_me",
  "replace-me",
]);

/**
 * One secret-detection pattern entry. Discriminated union on
 * `entropyCheck`: when `true`, `valueGroup` MUST be set to the
 * RegExp capture-group index containing the candidate-secret value
 * (so the detector knows which group to feed into the entropy +
 * placeholder + length checks). When `false`, the entire match is
 * the secret and no value-group is needed.
 *
 * The discriminated-union shape (rather than `valueGroup?: number`
 * with a runtime invariant) makes it a TYPE ERROR to declare an
 * entropy-check pattern without specifying its value group — exactly
 * the "module-load data shape should make invalid entropy patterns
 * hard to write" discipline we want.
 *
 * `label` is a redaction-safe human-readable name used in
 * `evidence.detail`. Per D40's locked secrets evidence rule, the
 * detector NEVER places the raw secret value in evidence — only
 * pattern identity + occurrence index + (optionally) column.
 */
export type SecretPattern =
  | {
      readonly id: string;
      readonly regex: RegExp;
      readonly label: string;
      readonly entropyCheck: false;
    }
  | {
      readonly id: string;
      readonly regex: RegExp;
      readonly label: string;
      readonly entropyCheck: true;
      readonly valueGroup: number;
    };

/**
 * The 8 locked secret-detection patterns per D33. SHARED MUTABLE
 * STATE under /g — see the file-header CRITICAL block.
 *
 * The detector in ./secrets.ts CLONES each regex via
 * `new RegExp(pattern.regex.source, pattern.regex.flags)` and calls
 * `matchAll()` on the clone. Do NOT call `matchAll()`, `exec()`, or
 * `test()` directly on the shared regex instance: per ECMA-262
 * §22.2.5.10, matchAll does not mutate the original, but it DOES
 * seed the iterator's matcher from the original regex's current
 * lastIndex value at call time. Any prior exec()-with-lastIndex>0
 * (in this code or anywhere else that ever touches a shared regex
 * here) would cause the next matchAll call to silently skip early
 * matches in the new input. The clone-first discipline is the only
 * safe pattern.
 *
 * Patterns #1-6 are duplicated from core/redact.ts (drift-guard
 * test in test/detectors/secrets.test.ts catches one-sided edits).
 * Patterns #7-8 are new for M C (env-style + Google API key context).
 *
 * Pattern #6 (PEM private key) spans MULTIPLE lines via `[\s\S]*?`.
 * The detector concatenates the addedLines of a single ChangedFileInput
 * (joined with `\n`) BEFORE matching this pattern, so multi-line PEM
 * blocks added in a single diff hunk are caught. Other patterns
 * operate per-line.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // #1 Stripe live secret. From core/redact.ts.
  {
    id: "stripe-secret-live",
    regex: /sk_live_[A-Za-z0-9]+/g,
    label: "Stripe live secret",
    entropyCheck: false,
  },
  // #2 GitHub PAT classic. From core/redact.ts.
  {
    id: "github-pat-classic",
    regex: /ghp_[A-Za-z0-9]{36,}/g,
    label: "GitHub PAT classic",
    entropyCheck: false,
  },
  // #3 GitHub fine-grained PAT. From core/redact.ts.
  {
    id: "github-pat-fine-grained",
    regex: /github_pat_[A-Za-z0-9_]+/g,
    label: "GitHub fine-grained PAT",
    entropyCheck: false,
  },
  // #4 Slack tokens (bot/user/app/refresh/admin via `xox[bpars]`).
  // From core/redact.ts.
  {
    id: "slack-token",
    regex: /xox[bpars]-[A-Za-z0-9-]+/g,
    label: "Slack token",
    entropyCheck: false,
  },
  // #5 AWS access key id. From core/redact.ts. Exactly 16 trailing
  // base32-uppercase chars after the AKIA prefix.
  {
    id: "aws-access-key-id",
    regex: /AKIA[0-9A-Z]{16}/g,
    label: "AWS access key id",
    entropyCheck: false,
  },
  // #6 PEM private key. From core/redact.ts. Multi-line span via
  // `[\s\S]*?`. The `[A-Z ]*` segments handle the optional algorithm
  // prefix (e.g. "RSA ", "OPENSSH ", "EC ", or empty for generic
  // `-----BEGIN PRIVATE KEY-----`).
  {
    id: "pem-private-key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: "PEM private key",
    entropyCheck: false,
  },
  // #7 ENV-style NAME=VALUE assignment (NEW for M C, locked per D33).
  // Matches NAME ending in SECRET/TOKEN/API_KEY/PASSWORD/PASS/KEY:
  //   - \b                            word boundary
  //   - [A-Z]                         one uppercase letter
  //   - [A-Z0-9_]{2,}                 2+ uppercase/digit/underscore
  //   - _                             literal underscore
  //   - (SECRET|TOKEN|API_KEY|PASSWORD|PASS|KEY)   GROUP 1: the suffix
  //   - \s*=\s*                       `=` with optional whitespace
  //   - ['"]?                         optional opening quote
  //   - ([^\s'"]{8,})                 GROUP 2: the value, 8+ chars
  //                                   (this is the entropy-checked value group)
  //
  // valueGroup: 2 points at the second capture group above. The
  // detector feeds GROUP 2's contents into:
  //   1. length check (MIN_SECRET_LENGTH)
  //   2. entropy check (ENTROPY_THRESHOLD)
  //   3. placeholder check (PLACEHOLDER_VALUES, lowercased)
  // All three must pass for the finding to emit. ANY failure
  // SUPPRESSES the match entirely (no audit trail — distinct from
  // the file/line downgrade-to-low channels).
  {
    id: "env-style-assignment",
    regex:
      /\b[A-Z][A-Z0-9_]{2,}_(SECRET|TOKEN|API_KEY|PASSWORD|PASS|KEY)\s*=\s*['"]?([^\s'"]{8,})/g,
    label: "ENV-style secret assignment",
    entropyCheck: true,
    valueGroup: 2,
  },
  // #8 Google API key with explicit `google_api_key` context prefix
  // (NEW for M C, locked per D33). Case-insensitive (gi flag) — the
  // context word may appear as `google_api_key`, `Google_API_Key`,
  // etc. The character class `[A-Za-z0-9-_]` is parsed by ECMA-262
  // §22.2.2.4 as A-Z + a-z + 0-9 + literal `-` + literal `_`
  // (verified: `/[A-Za-z0-9-_]/.test("=")` returns false in V8 —
  // the `-` between `9` and `_` is treated as literal, not as a
  // range, because `9` already terminates the `0-9` range and there's
  // no left-atom for a new range). No entropy check needed — the
  // 20+ base62-with-dash-underscore length already constrains
  // matches to plausible API-key shapes.
  {
    id: "google-api-key-context",
    regex: /\bgoogle_api_key\s*[:=]\s*['"]?([A-Za-z0-9-_]{20,})/gi,
    label: "Google API key",
    entropyCheck: false,
  },
];

/**
 * Picomatch globs identifying files whose secret findings are
 * DOWNGRADED to `level: "low"` (still emitted for audit but won't
 * trip the gate by default). Includes both root and nested-monorepo
 * variants per the same alternation discipline used in PATH_RULES.
 *
 * The detector compiles these via picomatch with the same locked
 * options used elsewhere in the package
 * (`{ dot: true, nocase: false, posixSlashes: true, nonegate: true }`).
 *
 * Distinct from entropy/placeholder suppression: this channel
 * DOWNGRADES (preserves audit trail), it does NOT drop the finding.
 */
export const SUPPRESSION_FILE_PATTERNS: readonly string[] = [
  "*.example",
  "**/*.example",
  "*.template",
  "**/*.template",
];

/**
 * Substring markers: if an `addedLines.text` line CONTAINS any of
 * these substrings (case-sensitive), all secret findings on that
 * line are DOWNGRADED to `level: "low"`. Single-line escape hatch
 * for developers committing intentional test-fixture secrets.
 *
 * Locked per D33: only `# pragma` (Python-style) and `//` (JS/TS
 * style) markers — no shell `#`-comment variants because shell
 * scripts use `#` for comments AND for shebang lines, raising the
 * risk of accidental suppression. Future contributors adding markers
 * should prefer language-specific comment syntax that's unlikely to
 * appear in non-comment contexts.
 */
export const INLINE_SUPPRESSION_MARKERS: readonly string[] = [
  "# pragma: viberevert-allow",
  "// viberevert-allow",
];
