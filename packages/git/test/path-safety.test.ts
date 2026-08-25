// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M 0.8.0 step 4b: the shared lexical path-safety authority extracted from
// diff.ts and path-state.ts.
//
// Two things are proven here:
//
//   1. The rule set itself: which paths are refused, which are accepted, WHICH
//      rule fires when a path violates several, and the exact message text.
//      Message text is pinned with literals rather than recomputed, because
//      the messages are what diff.test.ts and path-state.test.ts assert on and
//      a silent reword would otherwise slip through.
//
//   2. That diff.ts's adapter forwards the shared message unchanged while
//      still raising DiffParseError. That comparison is against the shared
//      helper's output rather than a literal on purpose: the literals are
//      already pinned in (1), so this asserts forwarding, not text.
//
// path-state.ts's adapter is covered the same way by the lexical-guard cases
// already in path-state.test.ts, which assert PathObservationError and its
// `path` field. Adding a test-only export there purely for symmetry would
// widen a module's surface to restate coverage that exists.

import { describe, expect, it } from "vitest";

import { _assertSafeRepoRelativePathForTests, DiffParseError } from "../src/diff.js";
import { repoRelativePathSafetyError } from "../src/path-safety.js";

const CTX = "ctx";

// =============================================================================
// Fixtures
// =============================================================================

/**
 * Paths the rule set accepts. Several are here to pin a BOUNDARY rather than
 * to demonstrate an obvious pass.
 */
const SAFE_PATHS: readonly string[] = [
  "a.txt",
  "src/index.ts",
  "a/b/c/d/e.ts",
  // Dot-prefixed paths are ordinary. Only `.viberevert` itself is special.
  ".gitignore",
  ".github/workflows/ci.yml",
  // Prefix matching is on `.viberevert/` exactly, so neighbours are not caught.
  ".viberevertx",
  ".viberevert-backup/x",
  // Documented scope: the store lives at the REPO ROOT. A nested directory
  // that happens to share the name is a user file and stays observable.
  "src/.viberevert/x",
  // `..` is refused as a whole SEGMENT, not as a substring.
  "a..b",
  "...",
  // Spaces and non-ASCII are not lexical-safety concerns.
  "my file.txt",
  "café/naïve.txt",
  // The drive rule is anchored at exactly one letter followed by a colon, so
  // a two-letter prefix is not a drive.
  "ab:c",
];

/**
 * Paths the rule set refuses, with the message each must produce for context
 * `"ctx"`. Written as literals so a reworded message fails here first.
 */
const UNSAFE: ReadonlyArray<{
  readonly why: string;
  readonly path: string;
  readonly message: string;
}> = [
  { why: "empty string", path: "", message: "ctx: empty path" },
  {
    why: "backslash separator",
    path: "a\\b",
    message: 'ctx: backslash in path "a\\\\b"',
  },
  {
    why: "POSIX absolute path",
    path: "/etc/passwd",
    message: 'ctx: absolute path "/etc/passwd"',
  },
  {
    why: "uppercase Windows drive",
    path: "C:/x",
    message: 'ctx: Windows-drive path "C:/x"',
  },
  {
    why: "lowercase Windows drive",
    path: "z:/x",
    message: 'ctx: Windows-drive path "z:/x"',
  },
  {
    // Consequence of the anchored single-letter rule: a file legitimately
    // named `a:b` on POSIX is refused. Pinned because it is a real cost of
    // the rule, not an accident.
    why: "single letter followed by a colon",
    path: "a:b",
    message: 'ctx: Windows-drive path "a:b"',
  },
  {
    why: "the store directory itself",
    path: ".viberevert",
    message: 'ctx: path under .viberevert/ ".viberevert"',
  },
  {
    why: "a path inside the store",
    path: ".viberevert/objects/ab/cd",
    message: 'ctx: path under .viberevert/ ".viberevert/objects/ab/cd"',
  },
  {
    why: "empty interior segment",
    path: "a//b",
    message: 'ctx: unsafe segment "" in "a//b"',
  },
  {
    why: "trailing slash",
    path: "a/",
    message: 'ctx: unsafe segment "" in "a/"',
  },
  {
    why: "leading dot segment",
    path: "./a",
    message: 'ctx: unsafe segment "." in "./a"',
  },
  {
    why: "trailing dot segment",
    path: "a/.",
    message: 'ctx: unsafe segment "." in "a/."',
  },
  {
    why: "leading parent segment",
    path: "../a",
    message: 'ctx: unsafe segment ".." in "../a"',
  },
  {
    why: "interior parent segment",
    path: "a/../b",
    message: 'ctx: unsafe segment ".." in "a/../b"',
  },
];

/**
 * Paths violating more than one rule. The message must name the FIRST rule in
 * check order, which is what makes reordering the checks an observable change
 * rather than a refactor.
 */
const PRECEDENCE: ReadonlyArray<{
  readonly why: string;
  readonly path: string;
  readonly message: string;
}> = [
  {
    why: "backslash is checked before the drive rule",
    path: "C:\\x",
    message: 'ctx: backslash in path "C:\\\\x"',
  },
  {
    why: "absolute is checked before segments",
    path: "/../x",
    message: 'ctx: absolute path "/../x"',
  },
  {
    why: "absolute is checked before the store rule",
    path: "/.viberevert/x",
    message: 'ctx: absolute path "/.viberevert/x"',
  },
  {
    why: "the store rule is checked before segments",
    path: ".viberevert/../x",
    message: 'ctx: path under .viberevert/ ".viberevert/../x"',
  },
];

// =============================================================================
// The rule set
// =============================================================================

describe("repoRelativePathSafetyError: accepted paths", () => {
  it.each(SAFE_PATHS)("returns null for %j", (path) => {
    expect(repoRelativePathSafetyError(path, CTX)).toBeNull();
  });
});

describe("repoRelativePathSafetyError: refused paths", () => {
  it.each(
    UNSAFE.map((u) => [u.why, u.path, u.message] as const),
  )("refuses %s", (_why, path, message) => {
    expect(repoRelativePathSafetyError(path, CTX)).toBe(message);
  });
});

describe("repoRelativePathSafetyError: check order", () => {
  it.each(
    PRECEDENCE.map((p) => [p.why, p.path, p.message] as const),
  )("%s", (_why, path, message) => {
    expect(repoRelativePathSafetyError(path, CTX)).toBe(message);
  });
});

describe("repoRelativePathSafetyError: message construction", () => {
  it("echoes the caller's context verbatim at the head of the message", () => {
    expect(repoRelativePathSafetyError("", "parseNameStatus.previous_path")).toBe(
      "parseNameStatus.previous_path: empty path",
    );
  });

  it("JSON-quotes the offending path so it cannot corrupt a diagnostic line", () => {
    // A raw interpolation would emit an unbalanced quote here.
    expect(repoRelativePathSafetyError('/a"b', CTX)).toBe('ctx: absolute path "/a\\"b"');
  });

  it("never throws, for accepted or refused input alike", () => {
    for (const path of [...SAFE_PATHS, ...UNSAFE.map((u) => u.path)]) {
      expect(() => repoRelativePathSafetyError(path, CTX)).not.toThrow();
    }
  });
});

// =============================================================================
// diff.ts forwards the shared message under its own error type
// =============================================================================

describe("diff.ts adapter", () => {
  it.each(
    UNSAFE.map((u) => [u.why, u.path] as const),
  )("throws DiffParseError carrying the shared message for %s", (_why, path) => {
    let thrown: unknown;
    try {
      _assertSafeRepoRelativePathForTests(path, CTX);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DiffParseError);
    // Compared against the shared helper, not a literal: the literals are
    // pinned above, so what this asserts is that the adapter forwards the
    // message unchanged rather than reformatting it.
    expect((thrown as Error).message).toBe(repoRelativePathSafetyError(path, CTX));
  });

  it.each(SAFE_PATHS)("accepts %j without throwing", (path) => {
    expect(() => _assertSafeRepoRelativePathForTests(path, CTX)).not.toThrow();
  });
});
