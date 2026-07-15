// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// M G4 Step 5a -- unit tests for the PTY interception audit hygiene + representation.
//
// Control characters in test inputs are written as \x.. escapes (which survive
// the source-authoring layer literally); Unicode bidi controls, astral emoji,
// accented/CJK text, and the ellipsis marker glyph are built via
// String.fromCodePoint so NO literal control/bidi character sits in this source.
// ALL_BIDI_CONTROLS is an INDEPENDENT copy of the production set: an accidental
// omission must not be able to hide identically in both places.

import { describe, expect, it } from "vitest";

import {
  buildAuditedCommandArgv,
  PTY_INTERCEPTION_AUDIT_MAX_LINE_LENGTH,
  sanitizeInterceptedCommandLine,
} from "../src/commands/pty-interception-audit.js";

const ESC = "\x1b";
const BEL = "\x07";
const CSI_RED = `${ESC}[31m`;
const CSI_RESET = `${ESC}[0m`;
const CLEAR_SCREEN = `${ESC}[2J`;
const OSC_TITLE = `${ESC}]0;window-title-injection${BEL}`;

const RLO = String.fromCodePoint(0x202e); // right-to-left override
const LRO = String.fromCodePoint(0x202d); // left-to-right override
const LRI = String.fromCodePoint(0x2066); // left-to-right isolate
const PDI = String.fromCodePoint(0x2069); // pop directional isolate
const ALM = String.fromCodePoint(0x061c); // arabic letter mark

// Independent copy of the production bidi set (do NOT import the private constant).
const ALL_BIDI_CONTROLS = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
].map((cp) => String.fromCodePoint(cp));

// Complete control-code set: C0 (0x00-0x1f), DEL (0x7f), and the FULL C1 range
// (0x80-0x9f) -- independently pins the CONTROL_CODE regex.
const ALL_CONTROL_CODES = [
  ...Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)),
  String.fromCharCode(0x7f),
  ...Array.from({ length: 0x20 }, (_, offset) => String.fromCharCode(0x80 + offset)),
].join("");

const EMOJI = String.fromCodePoint(0x1f600); // astral: 1 code point, 2 UTF-16 units
const ELLIPSIS = String.fromCodePoint(0x2026); // the truncation marker's leading glyph
const CAFE = `caf${String.fromCodePoint(0xe9)}`; // café
const JP = String.fromCodePoint(0x65e5, 0x672c, 0x8a9e); // 日本語

const codePointLength = (value: string): number => Array.from(value).length;

const hasControlCode = (value: string): boolean => {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
};

const hasNewline = (value: string): boolean => value.includes("\x0a") || value.includes("\x0d");

const hasAnyBidi = (value: string): boolean => ALL_BIDI_CONTROLS.some((b) => value.includes(b));

// Detects an unpaired UTF-16 surrogate by walking code units (no \u.. escapes,
// which would embed a lone surrogate into this source).
const hasLoneSurrogate = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++; // valid pair -- skip the low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // low surrogate with no preceding high
    }
  }
  return false;
};

const parseTruncation = (result: string): { dropped: number; retained: string } => {
  const captured = result.match(/\[\+(\d+) chars\]$/)?.[1];
  if (captured === undefined) {
    throw new Error(`expected a truncation marker in: ${JSON.stringify(result.slice(-40))}`);
  }
  const dropped = Number(captured);
  const marker = ` ${ELLIPSIS}[+${dropped} chars]`;
  return { dropped, retained: result.slice(0, result.length - marker.length) };
};

const assertSanitizedInvariants = (result: string): void => {
  expect(codePointLength(result)).toBeLessThanOrEqual(PTY_INTERCEPTION_AUDIT_MAX_LINE_LENGTH);
  expect(hasControlCode(result)).toBe(false);
  expect(hasAnyBidi(result)).toBe(false);
  expect(hasNewline(result)).toBe(false);
  expect(sanitizeInterceptedCommandLine(result)).toBe(result); // idempotent
};

describe("sanitizeInterceptedCommandLine -- terminal-control hygiene (D104.L)", () => {
  it("returns a clean printable line unchanged", () => {
    expect(sanitizeInterceptedCommandLine("git status --short")).toBe("git status --short");
  });

  it("strips ANSI CSI color and clear-screen sequences, leaving no ESC or tail", () => {
    const result = sanitizeInterceptedCommandLine(
      `${CSI_RED}rm -rf /tmp${CSI_RESET}${CLEAR_SCREEN}`,
    );
    expect(result).toBe("rm -rf /tmp");
    expect(result.includes(ESC)).toBe(false);
    expect(result.includes("[31m")).toBe(false);
    expect(result.includes("[2J")).toBe(false);
  });

  it("strips an OSC window-title-injection sequence", () => {
    expect(sanitizeInterceptedCommandLine(`${OSC_TITLE}whoami`)).toBe("whoami");
  });

  it("neutralizes every C0/DEL/C1 control code to a space", () => {
    const result = sanitizeInterceptedCommandLine(`a${ALL_CONTROL_CODES}b`);
    expect(hasControlCode(result)).toBe(false);
    expect(result).toBe("a b");
  });

  it("collapses embedded newlines / CR / tab into a single line", () => {
    const result = sanitizeInterceptedCommandLine("echo a\x0a\x0decho b\x09c");
    expect(result).toBe("echo a echo b c");
    expect(hasNewline(result)).toBe(false);
    expect(sanitizeInterceptedCommandLine("a\x0a\x0ab")).toBe("a b");
  });

  it("neutralizes the control code in an UNTERMINATED CSI sequence (floor only)", () => {
    const result = sanitizeInterceptedCommandLine(`${ESC}[31unterminated`);
    expect(hasControlCode(result)).toBe(false);
    expect(result.includes(ESC)).toBe(false);
    expect(codePointLength(result)).toBeGreaterThan(0);
  });

  it("neutralizes the control code in an UNTERMINATED OSC sequence (floor only)", () => {
    const result = sanitizeInterceptedCommandLine(`${ESC}]0;unterminated-title`);
    expect(hasControlCode(result)).toBe(false);
    expect(result.includes(ESC)).toBe(false);
    expect(codePointLength(result)).toBeGreaterThan(0);
  });

  it("bounds a long unterminated OSC without throwing (near the 64 KiB wire cap)", () => {
    const input = `${ESC}]0;${"A".repeat(64 * 1024)}`;
    let result = "";
    expect(() => {
      result = sanitizeInterceptedCommandLine(input);
    }).not.toThrow();
    expect(hasControlCode(result)).toBe(false);
    expect(result.includes(ESC)).toBe(false);
    expect(codePointLength(result)).toBeLessThanOrEqual(PTY_INTERCEPTION_AUDIT_MAX_LINE_LENGTH);
    expect(result).toMatch(/\[\+\d+ chars\]$/);
  });
});

describe("sanitizeInterceptedCommandLine -- Unicode bidi hygiene (visual reordering)", () => {
  it("neutralizes a mix of bidi controls, preserving logical order on one line", () => {
    const result = sanitizeInterceptedCommandLine(`git${RLO}${LRO}${LRI}${PDI}${ALM} push`);
    expect(result).toBe("git push");
    expect(result.indexOf("git")).toBeLessThan(result.indexOf("push"));
  });

  it.each(
    ALL_BIDI_CONTROLS.map((b, i) => [i, b] as const),
  )("removes declared bidi control #%i", (_index, bidi) => {
    expect(sanitizeInterceptedCommandLine(`a${bidi}b`)).toBe("a b");
  });

  it("removes every declared bidi control when joined together", () => {
    expect(sanitizeInterceptedCommandLine(`a${ALL_BIDI_CONTROLS.join("")}b`)).toBe("a b");
  });
});

describe("sanitizeInterceptedCommandLine -- ordinary Unicode is preserved", () => {
  it("preserves accented, CJK, and emoji text", () => {
    const input = `echo ${CAFE} ${JP} ${EMOJI}`;
    expect(sanitizeInterceptedCommandLine(input)).toBe(input);
  });
});

describe("sanitizeInterceptedCommandLine -- empty / no-meaningful-text", () => {
  it("reduces an empty or whitespace-only line to the empty string", () => {
    expect(sanitizeInterceptedCommandLine("")).toBe("");
    expect(sanitizeInterceptedCommandLine("   \x09  ")).toBe("");
  });

  it("reduces a CONTROL-ONLY line to empty (no meaningful command text)", () => {
    expect(sanitizeInterceptedCommandLine(`${CLEAR_SCREEN}\x00${BEL}`)).toBe("");
  });

  it("reduces a BIDI-ONLY line to empty", () => {
    expect(sanitizeInterceptedCommandLine(`${RLO}${LRI}${PDI}${ALM}`)).toBe("");
  });
});

describe("sanitizeInterceptedCommandLine -- length cap (marker included, code points)", () => {
  it("caps the COMPLETE result at the default code-point cap, with a marker", () => {
    const result = sanitizeInterceptedCommandLine(
      "a".repeat(PTY_INTERCEPTION_AUDIT_MAX_LINE_LENGTH + 5000),
    );
    expect(codePointLength(result)).toBeLessThanOrEqual(PTY_INTERCEPTION_AUDIT_MAX_LINE_LENGTH);
    expect(/\[\+(\d+) chars\]$/.test(result)).toBe(true);
  });

  it("caps at a custom maxLength INCLUDING the marker", () => {
    const result = sanitizeInterceptedCommandLine("b".repeat(500), { maxLength: 50 });
    expect(codePointLength(result)).toBeLessThanOrEqual(50);
    expect(/\[\+(\d+) chars\]$/.test(result)).toBe(true);
  });

  it("never splits a surrogate pair and counts the dropped total in code points", () => {
    const result = sanitizeInterceptedCommandLine(EMOJI.repeat(100), { maxLength: 30 });
    expect(codePointLength(result)).toBeLessThanOrEqual(30);
    expect(hasLoneSurrogate(result)).toBe(false);
    const { dropped, retained } = parseTruncation(result);
    expect(Array.from(retained).every((ch) => ch === EMOJI)).toBe(true);
    expect(codePointLength(retained) + dropped).toBe(100);
  });

  it.each([
    41, 50, 130, 131, 1030, 1031, 10030,
  ])("keeps the fixed-point truncation internally consistent for input length %i (maxLength 40)", (inputLength) => {
    const result = sanitizeInterceptedCommandLine("z".repeat(inputLength), { maxLength: 40 });
    expect(codePointLength(result)).toBeLessThanOrEqual(40);
    const { dropped, retained } = parseTruncation(result);
    expect(codePointLength(retained) + dropped).toBe(inputLength);
  });

  it.each([
    1, 2, 3,
  ])("never exceeds a tiny maxLength of %i (hard-bounded ellipsis)", (maxLength) => {
    const result = sanitizeInterceptedCommandLine("abcdefghij", { maxLength });
    expect(codePointLength(result)).toBeLessThanOrEqual(maxLength);
    expect(result).toBe(ELLIPSIS);
  });

  it("does not add a marker when input length exactly equals the cap", () => {
    expect(sanitizeInterceptedCommandLine("abcde", { maxLength: 5 })).toBe("abcde");
  });
});

describe("sanitizeInterceptedCommandLine -- maxLength validation", () => {
  it("uses the reviewed default when maxLength is omitted", () => {
    const result = sanitizeInterceptedCommandLine(
      "c".repeat(PTY_INTERCEPTION_AUDIT_MAX_LINE_LENGTH + 1),
    );
    expect(codePointLength(result)).toBeLessThanOrEqual(PTY_INTERCEPTION_AUDIT_MAX_LINE_LENGTH);
  });

  it("throws RangeError on an invalid explicit maxLength", () => {
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => sanitizeInterceptedCommandLine("x", { maxLength: bad })).toThrow(RangeError);
    }
  });
});

describe("sanitizeInterceptedCommandLine -- idempotence + universal invariants", () => {
  it("is idempotent on a mixed control/bidi/escape input", () => {
    const once = sanitizeInterceptedCommandLine(`${CSI_RED}git${RLO}\x09status${CSI_RESET}`);
    expect(sanitizeInterceptedCommandLine(once)).toBe(once);
  });

  const corpus: readonly string[] = [
    "git status --short",
    `echo ${CAFE} ${JP} ${EMOJI}`,
    `${CSI_RED}rm -rf /tmp${CSI_RESET}`,
    `${ESC}[31unterminated`,
    `${OSC_TITLE}whoami`,
    `${ESC}]0;unterminated-title`,
    `a${ALL_CONTROL_CODES}b`,
    `git${RLO}${LRO}${LRI}${PDI} push`,
    "echo a\x0a\x0decho b\x09c",
    "z".repeat(9000),
    EMOJI.repeat(300),
    EMOJI.repeat(9000),
  ];

  it.each(
    corpus.map((input, i) => [i, input] as const),
  )("every non-empty sanitized result of corpus #%i satisfies the universal contract", (_index, input) => {
    const result = sanitizeInterceptedCommandLine(input);
    if (result === "") {
      return;
    }
    expect(hasLoneSurrogate(result)).toBe(false);
    assertSanitizedInvariants(result);
  });
});

describe("buildAuditedCommandArgv -- D104.H representation", () => {
  it("wraps a meaningful sanitized line as a single-element argv", () => {
    expect(buildAuditedCommandArgv("git status")).toEqual(["git status"]);
  });

  it("returns null for an empty / whitespace / control-only / bidi-only line", () => {
    expect(buildAuditedCommandArgv("")).toBeNull();
    expect(buildAuditedCommandArgv("   ")).toBeNull();
    expect(buildAuditedCommandArgv(`${CLEAR_SCREEN}\x00`)).toBeNull();
    expect(buildAuditedCommandArgv(`${RLO}${PDI}`)).toBeNull();
  });

  it("produces a non-empty, control-free and bidi-free argv[0]", () => {
    const argv = buildAuditedCommandArgv(`${CSI_RED}rm${RLO} x`);
    expect(argv).not.toBeNull();
    if (argv === null) {
      throw new Error("expected a non-null argv");
    }
    const [command] = argv;
    expect(command).toBe("rm x");
    expect(command.length).toBeGreaterThan(0);
    expect(hasControlCode(command)).toBe(false);
    expect(command.includes(RLO)).toBe(false);
  });
});
