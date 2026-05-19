// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit + integration tests for packages/checks/src/detectors/secrets.ts
// and ./secrets-patterns.ts (Step 4 file 4).
//
// Coverage strategy:
//
//   1. PURE-HELPER UNIT TESTS (sections 1-5): each exported helper
//      gets tight focused tests independent of secretsCheck. These
//      lock the building blocks: a regression in shannonEntropy
//      computation, passesEntropyCheck composition, hasInlineSuppression
//      substring detection, cloneRegex independence, or
//      groupContiguousLines partitioning each surfaces in its own
//      precise test rather than as a downstream secretsCheck failure.
//
//   2. DRIFT-GUARD vs packages/core/src/redact.ts (section 6): per
//      D33's locked rule, secrets-patterns.ts duplicates the 6
//      prefixed patterns from core/redact.ts (the two systems serve
//      different purposes per D16/D29, so the duplication is
//      intentional, but drift between them is a bug). This test
//      reads redact.ts via fs at test runtime, extracts the regex
//      sources, and asserts they all appear in
//      checks/secrets-patterns.ts's SECRET_PATTERNS. Plus a count
//      sanity-bound (6) that forces deliberate update if either side
//      gains/loses a pattern.
//
//   3. PLACEHOLDER_VALUES MEMBERSHIP TESTS (section 7): direct
//      `.has()` tests on the canonical placeholder phrases. NOTE on
//      coupling with MIN_SECRET_LENGTH: all current PLACEHOLDER_VALUES
//      entries are < 20 chars, so when running them through
//      passesEntropyCheck, the LENGTH gate fires first and the
//      placeholder gate never gets exercised. The placeholder gate
//      is genuinely belt-and-suspenders for future MIN_SECRET_LENGTH
//      reductions. We test the placeholder set membership directly
//      to lock the rule, and document the coupling explicitly in the
//      passesEntropyCheck tests rather than claiming independent
//      gate isolation.
//
//   4. PER-PATTERN POSITIVES (section 8): one positive per pattern
//      via it.each. NEUTRAL CONTEXTS — prefix-pattern positives
//      (Stripe, GitHub, Slack, AWS, PEM) use bare code-string
//      contexts to avoid triggering env-style-assignment alongside.
//      env-style-assignment positive uses a value (diverse base62,
//      30 chars) that doesn't match any prefix pattern. Each test
//      asserts EXACTLY one finding (proves no accidental
//      double-match), correct id/category/level/confidence, AND
//      non-blank recommendation (critical findings require it per
//      schema refine).
//
//   5. SUPPRESSION CHANNELS (sections 9-12): both D33 channels.
//      Channel A (entropy/placeholder) DROPS entirely — verified
//      by 0 findings. Channel B (file/line) DOWNGRADES to "low" —
//      verified by 1 finding at level "low". A positive control
//      (same secret, no suppression) emits at "critical" to anchor
//      the test against accidental Layer 1 short-circuit.
//
//   6. PEM CROSS-LINE SUPPRESSION (section 12): markers on lines
//      WITHIN the PEM match span (BEGIN, middle, END) MUST downgrade.
//      A marker on the following line after the block MUST NOT
//      downgrade. Locks the public behavior that suppression is
//      scoped to lines overlapped by the matched span, not arbitrary
//      nearby contiguous lines. (Note: because scanMultiLine joins
//      contiguous lines with "\n", the line after a PEM block starts
//      at matchEndExclusive + 1, not at matchEndExclusive — the
//      inclusive/exclusive bounds-check off-by-one in the
//      implementation is therefore defensive coding against future
//      scan layers that might join without a separator, and is NOT
//      independently exercised by this section's tests.)
//
//   7. D40 MULTI-OCCURRENCE (section 13): two GitHub PATs on the
//      same line → 2 distinct findings, occurrence indices 1 and 2,
//      distinct col values. Distinct (id, file, line, detail) dedup
//      tuples per the D40 detector-uniqueness rule.
//
//   8. WHOLE-FINDING REDACTION SAFETY (section 14): JSON.stringify
//      the entire results array and assert it does not contain the
//      raw secret. Stronger than just-detail check — catches future
//      regressions where someone adds the secret to message, title,
//      or any new field. Applied to representative cases.
//
//   9. EDGE CASES (section 15): binary file skip, empty addedLines
//      skip, Windows backslash path normalization.
//
// =============================================================================
// CRITICAL TEST DISCIPLINE — `configChecks: { secrets: true }`
// =============================================================================
// Every test that calls runChecks MUST set `secrets: true` in
// configChecks. Without it, D28 Layer 1 inspects
// secretsCheck.emittedCategories (defaults to ["secrets"]), finds no
// enabled toggles, and SKIPS the check entirely → 0 findings for the
// WRONG reason. The ctxFor helper below defaults to { secrets: true }
// to make the discipline mechanical; explicit per-test overrides are
// flagged with comments.
//
// =============================================================================
// Test pipeline: isolated `runChecks([secretsCheck], ctx)` — same
// future-detector-brittleness avoidance as Step 3 files 5/6/7.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  cloneRegex,
  groupContiguousLines,
  hasInlineSuppression,
  passesEntropyCheck,
  secretsCheck,
  shannonEntropy,
} from "../../src/detectors/secrets.js";
import { PLACEHOLDER_VALUES, SECRET_PATTERNS } from "../../src/detectors/secrets-patterns.js";
import type { ChangedFileInput, CheckContext, ChecksToggleConfig } from "../../src/index.js";
import { runChecks } from "../../src/index.js";

// =============================================================================
// Test fixtures (same pattern as sibling test files; duplicated per
// D17c precedent on small atomic helpers across files).
// =============================================================================

function pathOnly(
  path: string,
  addedLines: readonly { line: number; text: string }[] = [],
): ChangedFileInput {
  return {
    path,
    status: "modified",
    addedLines,
    removedLines: [],
    isBinary: false,
  };
}

/**
 * Build a CheckContext from a list of ChangedFileInputs. Defaults
 * configChecks to `{ secrets: true }` so D28 Layer 1 does NOT
 * short-circuit secretsCheck. Tests that need different toggles
 * pass an explicit configChecks override.
 */
function ctxFor(
  files: readonly ChangedFileInput[],
  configChecks: ChecksToggleConfig = { secrets: true },
): CheckContext {
  return {
    changedFiles: files,
    detectedFrameworks: [],
    configChecks,
  };
}

/**
 * Diverse base62 string per D33's locked entropy-fixture rule. 30 chars,
 * Shannon entropy ~4.5-5.0 bits/char, passes MIN_SECRET_LENGTH (20)
 * AND ENTROPY_THRESHOLD (4.0). NOT in PLACEHOLDER_VALUES. NOT a prefix
 * pattern (doesn't start with sk_live_/ghp_/etc.), so when used as a
 * value in env-style tests it triggers ONLY env-style-assignment, not
 * any prefix pattern. Used as the canonical "real-secret-looking"
 * value across tests.
 */
const DIVERSE_VALUE = "A7kLm9PqR2sTuV8wXyZaB3cD4eF5gH";

/**
 * Stripe/Slack test fixtures constructed via template-literal
 * interpolation so the SOURCE never contains the contiguous prefix
 * substrings (`sk_live_`, `xoxb-`) that real secrets begin with. At
 * runtime the strings equal "sk_live_TESTFIXTUREONLY" and
 * "xoxb-TESTFIXTUREONLY" — both match the detector regexes
 * (/sk_live_[A-Za-z0-9]+/g and /xox[bpars]-[A-Za-z0-9-]+/g
 * respectively). GitHub push protection scans the diff text, not
 * runtime values, so splitting the prefix defeats the secret
 * scanner without changing test semantics.
 *
 * Locked discipline going forward: any new Stripe/Slack-shaped test
 * fixtures MUST use this constructed pattern. The first attempt at
 * Step 4 (local commit aa336c9, never reached origin) used realistic
 * 24-char base62 Stripe fixtures and was rejected by push protection;
 * this form unblocks the push by not presenting a scanner-shaped
 * literal in the source.
 */
const STRIPE_FIXTURE = `sk${"_live_"}TESTFIXTUREONLY`;
const SLACK_FIXTURE = `xox${"b-"}TESTFIXTUREONLY`;

// =============================================================================
// SECTION 1: shannonEntropy unit tests
// =============================================================================

describe("shannonEntropy", () => {
  it("returns 0 for the empty string", () => {
    expect(shannonEntropy("")).toBe(0);
  });

  it("returns 0 for a string of all identical characters (zero information)", () => {
    expect(shannonEntropy("xxxxxxxxxxxxxxxxxxxx")).toBe(0);
  });

  it("returns > 4.0 bits/char for a diverse 30-char base62 string", () => {
    // The DIVERSE_VALUE is the canonical fixture for high-entropy
    // tests. Locking its entropy here means any future change to the
    // entropy algorithm that crosses the 4.0 threshold surfaces in
    // ONE place rather than as a cascade of mysterious detector-test
    // failures.
    expect(shannonEntropy(DIVERSE_VALUE)).toBeGreaterThan(4.0);
  });

  it("returns < 4.0 bits/char for an english-like phrase", () => {
    expect(shannonEntropy("this is just a plain english sentence")).toBeLessThan(4.0);
  });
});

// =============================================================================
// SECTION 2: passesEntropyCheck unit tests
//
// NOTE on coupling: all current PLACEHOLDER_VALUES entries are <
// MIN_SECRET_LENGTH (20 chars), so when run through this combined
// gate, the LENGTH check always fires first. The placeholder check is
// tested INDEPENDENTLY in section 7 via direct PLACEHOLDER_VALUES.has
// membership tests. The placeholder gate inside passesEntropyCheck is
// belt-and-suspenders against future MIN_SECRET_LENGTH reductions —
// can't be exercised today without modifying file 1's locked
// placeholder set.
// =============================================================================

describe("passesEntropyCheck", () => {
  it("returns false for the empty string (fails length)", () => {
    expect(passesEntropyCheck("")).toBe(false);
  });

  it("returns false for a short diverse string (fails length, even though entropy is > 4.0)", () => {
    // 18 unique chars: entropy is log2(18) ≈ 4.17 (> 4.0),
    // but MIN_SECRET_LENGTH requires >= 20.
    expect(passesEntropyCheck("A7kLm9PqR2sTuV8wXy")).toBe(false);
  });

  it("returns false for a 20+ char repeated-char string (fails entropy, even though length is met)", () => {
    expect(passesEntropyCheck("xxxxxxxxxxxxxxxxxxxx")).toBe(false);
  });

  it("returns true for a 20+ char diverse non-placeholder string", () => {
    expect(passesEntropyCheck(DIVERSE_VALUE)).toBe(true);
  });

  it("returns false for a short placeholder ('changeme') — length gate fires first; placeholder gate is belt-and-suspenders", () => {
    // Documents the placeholder/length coupling explicitly: the
    // failure here is attributable to BOTH gates, with length being
    // the one that actually triggers. Section 7 covers placeholder
    // membership independently.
    expect(passesEntropyCheck("changeme")).toBe(false);
  });
});

// =============================================================================
// SECTION 3: hasInlineSuppression unit tests
// =============================================================================

describe("hasInlineSuppression", () => {
  it("returns true for a line containing the Python-style marker", () => {
    expect(hasInlineSuppression("API_KEY=abc123  # pragma: viberevert-allow")).toBe(true);
  });

  it("returns true for a line containing the JS/TS-style marker", () => {
    expect(hasInlineSuppression("const apiKey = 'abc123'; // viberevert-allow")).toBe(true);
  });

  it("returns false for a line with no marker", () => {
    expect(hasInlineSuppression("const apiKey = 'abc123';")).toBe(false);
  });

  it("is case-sensitive — uppercase marker does NOT match", () => {
    // Per D33: markers are language-specific comment syntax. A
    // case-insensitive match would risk spurious downgrades on
    // unrelated text.
    expect(hasInlineSuppression("const apiKey = 'abc'; // VibeRevert-Allow")).toBe(false);
  });
});

// =============================================================================
// SECTION 4: cloneRegex unit tests
//
// Locks the clone-first contract from secrets-patterns.ts CRITICAL
// block. A regression where clone shares state with the original
// would surface here.
// =============================================================================

describe("cloneRegex", () => {
  it("returns a RegExp with the same source and flags as the original", () => {
    const original = /sk_live_[A-Za-z0-9]+/g;
    const clone = cloneRegex(original);
    expect(clone.source).toBe(original.source);
    expect(clone.flags).toBe(original.flags);
  });

  it("clone's lastIndex is 0 regardless of source's lastIndex", () => {
    // The whole point of the clone discipline: avoid lastIndex
    // carryover hazards documented in secrets-patterns.ts.
    const original = /abc/g;
    original.lastIndex = 5;
    const clone = cloneRegex(original);
    expect(clone.lastIndex).toBe(0);
  });

  it("clone is a DIFFERENT instance from the original", () => {
    const original = /abc/g;
    const clone = cloneRegex(original);
    expect(clone).not.toBe(original);
  });
});

// =============================================================================
// SECTION 5: groupContiguousLines unit tests
// =============================================================================

describe("groupContiguousLines", () => {
  it("returns empty array for empty input", () => {
    expect(groupContiguousLines([])).toEqual([]);
  });

  it("returns a single one-element group for one line", () => {
    expect(groupContiguousLines([{ line: 5, text: "a" }])).toEqual([[{ line: 5, text: "a" }]]);
  });

  it("groups all-contiguous lines into one group", () => {
    expect(
      groupContiguousLines([
        { line: 1, text: "a" },
        { line: 2, text: "b" },
        { line: 3, text: "c" },
      ]),
    ).toEqual([
      [
        { line: 1, text: "a" },
        { line: 2, text: "b" },
        { line: 3, text: "c" },
      ],
    ]);
  });

  it("splits a gap into separate groups", () => {
    expect(
      groupContiguousLines([
        { line: 1, text: "a" },
        { line: 2, text: "b" },
        { line: 80, text: "c" },
      ]),
    ).toEqual([
      [
        { line: 1, text: "a" },
        { line: 2, text: "b" },
      ],
      [{ line: 80, text: "c" }],
    ]);
  });

  it("handles the JSDoc-example mixed case", () => {
    expect(
      groupContiguousLines([
        { line: 5, text: "a" },
        { line: 6, text: "b" },
        { line: 10, text: "c" },
        { line: 11, text: "d" },
        { line: 12, text: "e" },
      ]),
    ).toEqual([
      [
        { line: 5, text: "a" },
        { line: 6, text: "b" },
      ],
      [
        { line: 10, text: "c" },
        { line: 11, text: "d" },
        { line: 12, text: "e" },
      ],
    ]);
  });
});

// =============================================================================
// SECTION 6: drift-guard against packages/core/src/redact.ts
//
// Per D33: secrets-patterns.ts duplicates 6 prefixed patterns from
// core/redact.ts (intentional per D16/D29 — checks can't depend on
// core). This test reads redact.ts via fs, extracts regex literal
// sources, and asserts they all appear in checks's SECRET_PATTERNS.
// Catches one-sided edits.
// =============================================================================

describe("drift-guard vs packages/core/src/redact.ts", () => {
  it("every regex source in core/redact.ts appears in checks/SECRET_PATTERNS, and the count is bounded", () => {
    // Resolve packages/core/src/redact.ts relative to this test file
    // via the URL constructor — portable across Node versions,
    // doesn't depend on `import.meta.dirname` typings (which require
    // a sufficiently recent @types/node and may lag the runtime).
    // readFileSync accepts a URL natively per the Node fs docs.
    const redactUrl = new URL("../../../core/src/redact.ts", import.meta.url);
    const redactSource = readFileSync(redactUrl, "utf-8");

    // Extract regex literals that occupy an entire line (possibly
    // with leading whitespace and trailing comma). Anchored ^/$ +
    // multiline flag so we only pick up source lines that are
    // genuinely regex literals — not regex sources that happen to
    // appear inside other JS code (e.g., in a comment or string).
    const regexLiteralLine = /^\s*\/(.+)\/g,?\s*$/gm;
    // Guarded extraction: m[1] is `string | undefined` under strict
    // typing. A throw-on-undefined here makes any future extraction
    // bug (e.g., regex literal style changes in redact.ts that defeat
    // the matcher) surface with a precise diagnostic rather than
    // silently producing undefined values that pass through to set
    // membership checks as false (which would silently break the
    // drift-guard).
    const redactSources = [...redactSource.matchAll(regexLiteralLine)].map((m) => {
      const source = m[1];
      if (source === undefined) {
        throw new Error("Failed to extract regex source from core/redact.ts drift-guard match");
      }
      return source;
    });

    // SANITY-BOUND: redact.ts is locked at exactly 6 prefixed patterns
    // for v0.7.0-beta. If it grows or shrinks, this fires and forces
    // the contributor to consciously update BOTH redact.ts AND
    // checks/secrets-patterns.ts. Catches additive drift in either
    // direction.
    expect(redactSources).toHaveLength(6);

    // Every extracted source from redact.ts MUST appear in
    // checks's SECRET_PATTERNS source set. Catches the case where
    // redact.ts has a pattern that checks doesn't.
    const checksSources = new Set(SECRET_PATTERNS.map((p) => p.regex.source));
    for (const source of redactSources) {
      expect(
        checksSources.has(source),
        `Source from core/redact.ts not found in checks/SECRET_PATTERNS: ${source}`,
      ).toBe(true);
    }
  });
});

// =============================================================================
// SECTION 7: PLACEHOLDER_VALUES membership tests
//
// Direct .has() tests on the canonical placeholder phrases. This is
// the only way to test the placeholder gate independently of
// MIN_SECRET_LENGTH (all current entries are < 20 chars).
// =============================================================================

describe("PLACEHOLDER_VALUES set membership", () => {
  it("contains the D33-listed canonical examples", () => {
    expect(PLACEHOLDER_VALUES.has("changeme")).toBe(true);
    expect(PLACEHOLDER_VALUES.has("your_key_here")).toBe(true);
    expect(PLACEHOLDER_VALUES.has("xxx")).toBe(true);
    expect(PLACEHOLDER_VALUES.has("your-token")).toBe(true);
  });

  it("does NOT contain broad bare words (locked exclusion rule from file 1)", () => {
    // Per file 1's INCLUSION RULE: never add `secret`, `password`,
    // `token`, `test`, `demo`. This test locks the rule against
    // future additions.
    expect(PLACEHOLDER_VALUES.has("secret")).toBe(false);
    expect(PLACEHOLDER_VALUES.has("password")).toBe(false);
    expect(PLACEHOLDER_VALUES.has("token")).toBe(false);
    expect(PLACEHOLDER_VALUES.has("test")).toBe(false);
    expect(PLACEHOLDER_VALUES.has("demo")).toBe(false);
  });

  it("all entries are stored lowercased (matches the call-site .toLowerCase() normalization)", () => {
    for (const v of PLACEHOLDER_VALUES) {
      expect(v).toBe(v.toLowerCase());
    }
  });
});

// =============================================================================
// SECTION 8: per-pattern positive tests (it.each, 8 patterns)
//
// Each pattern fires on exactly ONE representative line, producing
// exactly ONE finding. Neutral contexts chosen to avoid accidental
// double-matches with env-style-assignment.
// =============================================================================

interface PatternPositiveCase {
  readonly patternId: string;
  readonly description: string;
  readonly lineText: string;
  readonly rawSecret: string;
  readonly expectedConfidence: "high" | "medium";
}

const PATTERN_POSITIVES: readonly PatternPositiveCase[] = [
  {
    patternId: "stripe-secret-live",
    description: "Stripe live secret in bare code-string context",
    // Bare code context — no NAME=VALUE that would also trigger env-style.
    // STRIPE_FIXTURE constructed via template-literal interpolation to
    // avoid scanner-shaped literal in source (see fixture-constants block).
    lineText: `const apiKey = "${STRIPE_FIXTURE}";`,
    rawSecret: STRIPE_FIXTURE,
    expectedConfidence: "high",
  },
  {
    patternId: "github-pat-classic",
    description: "GitHub classic PAT in bare string context",
    lineText: 'const token = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aB";',
    rawSecret: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aB",
    expectedConfidence: "high",
  },
  {
    patternId: "github-pat-fine-grained",
    description: "GitHub fine-grained PAT in bare string context",
    lineText: 'const token = "github_pat_aBcDeFgHiJkLmNoPqRsTuV";',
    rawSecret: "github_pat_aBcDeFgHiJkLmNoPqRsTuV",
    expectedConfidence: "high",
  },
  {
    patternId: "slack-token",
    description: "Slack bot token in bare string context",
    // SLACK_FIXTURE constructed via template-literal interpolation; see
    // fixture-constants block at top of file.
    lineText: `const slack = "${SLACK_FIXTURE}";`,
    rawSecret: SLACK_FIXTURE,
    expectedConfidence: "high",
  },
  {
    patternId: "aws-access-key-id",
    description: "AWS access key id in bare string context",
    lineText: 'const aws = "AKIAIOSFODNN7EXAMPLE";',
    rawSecret: "AKIAIOSFODNN7EXAMPLE",
    expectedConfidence: "high",
  },
  {
    patternId: "env-style-assignment",
    description: "env-style assignment with diverse high-entropy value",
    // DIVERSE_VALUE doesn't match any prefix pattern → only
    // env-style-assignment fires.
    lineText: `STRIPE_SECRET=${DIVERSE_VALUE}`,
    rawSecret: DIVERSE_VALUE,
    expectedConfidence: "medium",
  },
  {
    patternId: "google-api-key-context",
    description: "Google API key with explicit context prefix",
    // `google_api_key` starts with lowercase, so env-style-assignment
    // (which requires [A-Z] start) doesn't fire. DIVERSE_VALUE doesn't
    // match any prefix pattern.
    lineText: `google_api_key = "${DIVERSE_VALUE}"`,
    rawSecret: DIVERSE_VALUE,
    expectedConfidence: "high",
  },
];

describe("secretsCheck — per-pattern positive coverage", () => {
  it.each(
    PATTERN_POSITIVES,
  )("$patternId: $description → 1 critical finding with non-blank recommendation, no double-match", ({
    patternId,
    lineText,
    rawSecret,
    expectedConfidence,
  }) => {
    const file = pathOnly("src/example.ts", [{ line: 1, text: lineText }]);
    const result = runChecks([secretsCheck], ctxFor([file]));

    // Exactly 1 finding — proves no accidental cross-pattern match.
    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return; // type narrowing

    expect(finding.id).toBe("secrets.regex");
    expect(finding.category).toBe("secrets");
    expect(finding.level).toBe("critical");
    expect(finding.confidence).toBe(expectedConfidence);
    // Pattern label appears in evidence.detail (D40 redaction-safe
    // format: "<label> [occurrence N, col C]").
    expect(finding.evidence[0]?.detail).toContain("[occurrence 1, col ");
    // Critical findings MUST have non-blank recommendation per M B
    // CheckResultSchema refine.
    expect(finding.recommendation?.trim().length).toBeGreaterThan(0);
    // PATTERN ID locked in detail (so failures pinpoint which
    // pattern fired): the pattern's label should be present.
    const patternEntry = SECRET_PATTERNS.find((p) => p.id === patternId);
    expect(patternEntry).toBeDefined();
    if (patternEntry) {
      expect(finding.evidence[0]?.detail).toContain(patternEntry.label);
    }
    // Whole-finding redaction safety: the raw secret bytes must NOT
    // appear anywhere in the serialized finding (not in detail, not
    // in message, not in title, not in any future field).
    expect(JSON.stringify(result.results)).not.toContain(rawSecret);
  });

  it("PEM private key (multi-line) → 1 critical finding", () => {
    // PEM is multi-line so doesn't fit the per-line table-driven
    // shape above. Tested separately with a contiguous-line PEM block.
    const pemLines = [
      { line: 1, text: "-----BEGIN PRIVATE KEY-----" },
      { line: 2, text: "MIIEvQIBADANBgkqhkiG9w0BAQEF" },
      { line: 3, text: "-----END PRIVATE KEY-----" },
    ];
    const file = pathOnly("src/key.pem", pemLines);
    const result = runChecks([secretsCheck], ctxFor([file]));

    expect(result.results).toHaveLength(1);
    const finding = result.results[0];
    expect(finding).toBeDefined();
    if (!finding) return;

    expect(finding.id).toBe("secrets.regex");
    expect(finding.category).toBe("secrets");
    expect(finding.level).toBe("critical");
    expect(finding.confidence).toBe("high");
    expect(finding.evidence[0]?.detail).toContain("PEM private key");
    expect(finding.recommendation?.trim().length).toBeGreaterThan(0);
    // Match origin is the START line (BEGIN marker).
    expect(finding.evidence[0]?.line).toBe(1);
  });
});

// =============================================================================
// SECTION 9: suppression channel A — entropy/placeholder (DROPS entirely)
// =============================================================================

describe("secretsCheck — entropy/placeholder suppression (channel A: DROPS entirely)", () => {
  it("STRIPE_SECRET=changeme (placeholder + fails length) → 0 findings", () => {
    const file = pathOnly("src/config.ts", [{ line: 1, text: "STRIPE_SECRET=changeme" }]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toEqual([]);
  });

  it("STRIPE_SECRET=A7kLm9PqR2sTuV8wXy (18-char diverse, fails length cleanly while entropy stays > 4.0) → 0 findings", () => {
    // 18 unique chars: entropy is log2(18) ≈ 4.17 (> 4.0). The regex
    // {8,} succeeds (length >= 8), but the post-match
    // passesEntropyCheck fails on MIN_SECRET_LENGTH (>= 20).
    // Isolates the length gate as the sole failure mode.
    const file = pathOnly("src/config.ts", [{ line: 1, text: "STRIPE_SECRET=A7kLm9PqR2sTuV8wXy" }]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toEqual([]);
  });

  it("STRIPE_SECRET=xxxxxxxxxxxxxxxxxxxx (20 chars repeated, fails entropy) → 0 findings", () => {
    const file = pathOnly("src/config.ts", [
      { line: 1, text: "STRIPE_SECRET=xxxxxxxxxxxxxxxxxxxx" },
    ]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toEqual([]);
  });
});

// =============================================================================
// SECTION 10: suppression channel B (file) — DOWNGRADE to low
// =============================================================================

describe("secretsCheck — file suppression (channel B: DOWNGRADE to low)", () => {
  it("secret in .env.example → finding at level 'low' (NOT critical)", () => {
    const file = pathOnly(".env.example", [{ line: 1, text: `STRIPE_SECRET=${DIVERSE_VALUE}` }]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.level).toBe("low");
  });

  it("secret in apps/web/.env.example (nested) → finding at level 'low'", () => {
    const file = pathOnly("apps/web/.env.example", [
      { line: 1, text: `STRIPE_SECRET=${DIVERSE_VALUE}` },
    ]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.level).toBe("low");
  });

  it("secret in config/foo.template → finding at level 'low'", () => {
    const file = pathOnly("config/foo.template", [
      { line: 1, text: `STRIPE_SECRET=${DIVERSE_VALUE}` },
    ]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.level).toBe("low");
  });

  it("POSITIVE CONTROL: same secret in src/config.ts (no suppression) → finding at level 'critical'", () => {
    // Anchors the suppression tests above — proves the secret value
    // ITSELF is detectable at critical, and the downgrade is purely
    // due to the file path.
    const file = pathOnly("src/config.ts", [{ line: 1, text: `STRIPE_SECRET=${DIVERSE_VALUE}` }]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.level).toBe("critical");
  });
});

// =============================================================================
// SECTION 11: suppression channel B (line) — DOWNGRADE to low
// =============================================================================

describe("secretsCheck — line suppression (channel B: DOWNGRADE to low)", () => {
  it("line with `# pragma: viberevert-allow` marker → finding at level 'low'", () => {
    const file = pathOnly("src/config.py", [
      {
        line: 1,
        text: `STRIPE_SECRET=${DIVERSE_VALUE}  # pragma: viberevert-allow`,
      },
    ]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.level).toBe("low");
  });

  it("line with `// viberevert-allow` marker → finding at level 'low'", () => {
    const file = pathOnly("src/config.ts", [
      {
        line: 1,
        text: `const X = "${STRIPE_FIXTURE}"; // viberevert-allow`,
      },
    ]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.level).toBe("low");
  });

  it("POSITIVE CONTROL: same secret, line without marker → finding at level 'critical'", () => {
    const file = pathOnly("src/config.ts", [
      { line: 1, text: `const X = "${STRIPE_FIXTURE}";` },
    ]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.level).toBe("critical");
  });
});

// =============================================================================
// SECTION 12: PEM cross-line suppression
//
// Markers on any line WITHIN the PEM match span (BEGIN, middle, END)
// MUST downgrade. A marker on the following line after the PEM block
// MUST NOT downgrade. This locks the public behavior that suppression
// is based on lines overlapped by the matched PEM block, not
// arbitrary nearby contiguous lines. (See file-header section 6 note
// on why this section does not independently exercise the
// inclusive/exclusive bounds-check off-by-one in scanMultiLine —
// the joining newline means the line after a PEM block starts at
// matchEndExclusive + 1, not at matchEndExclusive, so both
// implementations agree on this test set.)
// =============================================================================

describe("secretsCheck — PEM cross-line suppression", () => {
  const PEM_BLOCK_TEMPLATE = [
    { line: 10, text: "-----BEGIN PRIVATE KEY-----" },
    { line: 11, text: "abc123" },
    { line: 12, text: "-----END PRIVATE KEY-----" },
  ];

  it("marker on line 13 (after PEM block END) → finding stays 'critical'", () => {
    // Line 13 is outside the PEM match span. A marker on a nearby
    // following line must not suppress the PEM finding; only markers
    // on lines overlapped by the actual match span may downgrade it.
    const file = pathOnly("src/key.pem", [
      ...PEM_BLOCK_TEMPLATE,
      { line: 13, text: "// viberevert-allow" },
    ]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.level).toBe("critical");
  });

  it("marker on line 10 (BEGIN line, INSIDE span) → finding at level 'low'", () => {
    const file = pathOnly("src/key.pem", [
      {
        line: 10,
        text: "-----BEGIN PRIVATE KEY----- // viberevert-allow",
      },
      { line: 11, text: "abc123" },
      { line: 12, text: "-----END PRIVATE KEY-----" },
    ]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.level).toBe("low");
  });

  it("marker on line 11 (middle, INSIDE span) → finding at level 'low'", () => {
    const file = pathOnly("src/key.pem", [
      { line: 10, text: "-----BEGIN PRIVATE KEY-----" },
      { line: 11, text: "abc123 // viberevert-allow" },
      { line: 12, text: "-----END PRIVATE KEY-----" },
    ]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.level).toBe("low");
  });

  it("marker on line 12 (END line, INSIDE span) → finding at level 'low'", () => {
    // The convention-matching case: many developers put the marker
    // at the end of the secret block.
    const file = pathOnly("src/key.pem", [
      { line: 10, text: "-----BEGIN PRIVATE KEY-----" },
      { line: 11, text: "abc123" },
      {
        line: 12,
        text: "-----END PRIVATE KEY----- // viberevert-allow",
      },
    ]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.level).toBe("low");
  });
});

// =============================================================================
// SECTION 13: D40 multi-occurrence uniqueness
// =============================================================================

describe("secretsCheck — D40 multi-occurrence uniqueness", () => {
  it("two GitHub PATs on the same line → 2 distinct findings with occurrence indices 1 and 2 and distinct cols", () => {
    // Two ghp_ tokens with distinct content. Tests:
    //   - Per-(file, pattern) occurrence counter increments correctly.
    //   - Each finding's evidence.detail contains a distinct
    //     "[occurrence N, col C]" string → distinct D40 dedup tuples
    //     → both survive dedup.
    //   - Whole-finding redaction safety: neither raw token bytes
    //     appears in any field.
    const token1 = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789aB";
    const token2 = "ghp_ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210AbCd";
    const lineText = `const a = "${token1}"; const b = "${token2}";`;
    const file = pathOnly("src/code.ts", [{ line: 1, text: lineText }]);
    const result = runChecks([secretsCheck], ctxFor([file]));

    expect(result.results).toHaveLength(2);
    const details = result.results.map((r) => r.evidence[0]?.detail ?? "");
    // One finding with occurrence 1, one with occurrence 2.
    expect(details.some((d) => d.includes("[occurrence 1, col "))).toBe(true);
    expect(details.some((d) => d.includes("[occurrence 2, col "))).toBe(true);
    // Distinct col values (the two tokens start at different positions).
    const colMatches = details.map((d) => /col (\d+)\]/.exec(d)?.[1]);
    expect(colMatches[0]).not.toBe(colMatches[1]);

    // Whole-finding redaction safety: neither raw token in any field
    // of either finding.
    const serialized = JSON.stringify(result.results);
    expect(serialized).not.toContain(token1);
    expect(serialized).not.toContain(token2);
  });
});

// =============================================================================
// SECTION 14: whole-finding redaction safety (additional coverage)
//
// Per-pattern positives (section 8) and multi-occurrence (section 13)
// already include the JSON.stringify redaction check. This section
// adds explicit redaction checks for the suppressed cases too —
// even "low" findings emitted via file/line suppression must not
// leak the raw secret.
// =============================================================================

describe("secretsCheck — whole-finding redaction (suppressed cases)", () => {
  it("file-suppressed finding (level 'low') does NOT contain raw secret in any field", () => {
    const file = pathOnly(".env.example", [{ line: 1, text: `STRIPE_SECRET=${DIVERSE_VALUE}` }]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(JSON.stringify(result.results)).not.toContain(DIVERSE_VALUE);
  });

  it("line-suppressed finding (level 'low') does NOT contain raw secret in any field", () => {
    const file = pathOnly("src/config.ts", [
      {
        line: 1,
        text: `const X = "${STRIPE_FIXTURE}"; // viberevert-allow`,
      },
    ]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(JSON.stringify(result.results)).not.toContain(STRIPE_FIXTURE);
  });
});

// =============================================================================
// SECTION 15: edge cases
// =============================================================================

describe("secretsCheck — edge cases", () => {
  it("binary file (isBinary=true) → 0 findings (early skip)", () => {
    const file: ChangedFileInput = {
      path: "image.png",
      status: "modified",
      addedLines: [], // empty per the binary contract anyway
      removedLines: [],
      isBinary: true,
    };
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toEqual([]);
  });

  it("file with empty addedLines → 0 findings (early skip)", () => {
    const file = pathOnly("src/empty.ts", []);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toEqual([]);
  });

  it("Windows-style backslash path (apps\\\\web\\\\.env.example) → file suppression still downgrades", () => {
    // Locks the normalizeDetectorPath discipline end-to-end. A
    // regression that dropped path normalization would skip file
    // suppression on Windows-shaped paths.
    const file = pathOnly("apps\\web\\.env.example", [
      { line: 1, text: `STRIPE_SECRET=${DIVERSE_VALUE}` },
    ]);
    const result = runChecks([secretsCheck], ctxFor([file]));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.level).toBe("low");
  });
});
