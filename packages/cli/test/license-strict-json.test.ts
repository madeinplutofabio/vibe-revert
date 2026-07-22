// packages/cli/test/license-strict-json.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Boundary tests for the strict JSON parser (scripts/strict-json.ts): the
// duplicate-key rejection at every depth (incl. across escape forms) that motivates
// it over JSON.parse, prototype-pollution safety (__proto__/constructor as ordinary
// own keys on a null-prototype object), the escape and number grammar, well-formed
// Unicode (unpaired surrogates rejected), RFC 8259 syntax rejections, and fail-closed
// limits (invalid-limit for bad bounds; in-parse limit errors for depth, node count,
// and string/number token length).

import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../../scripts/license-audit-core.js";
import {
  DEFAULT_STRICT_JSON_LIMITS,
  parseStrictJson,
  type StrictJsonError,
  type StrictJsonLimits,
} from "../../../scripts/strict-json.js";

// A single backslash built from its code point, so the unicode escape sequences fed
// to the parser below reach the file intact instead of being pre-decoded by tooling.
const B = String.fromCharCode(0x5c);

function val(text: string, limits?: Partial<StrictJsonLimits>): JsonValue {
  const r = parseStrictJson(text, limits);
  if (!r.ok) {
    throw new Error(`expected success but got ${r.error.kind}: ${r.error.message}`);
  }
  return r.value;
}

function err(text: string, limits?: Partial<StrictJsonLimits>): StrictJsonError {
  const r = parseStrictJson(text, limits);
  if (r.ok) {
    throw new Error(`expected failure but parsed ${JSON.stringify(text)}`);
  }
  return r.error;
}

describe("parseStrictJson — valid documents", () => {
  it("parses the JSON scalar types at top level", () => {
    expect(val("true")).toBe(true);
    expect(val("false")).toBe(false);
    expect(val("null")).toBeNull();
    expect(val("42")).toBe(42);
    expect(val('"hi"')).toBe("hi");
  });

  it("parses nested objects and arrays with mixed values", () => {
    expect(val('{"a":[1,2],"b":{"c":null},"d":true}')).toEqual({
      a: [1, 2],
      b: { c: null },
      d: true,
    });
  });

  it("accepts empty containers and surrounding/interior whitespace", () => {
    expect(val("  {}  ")).toEqual({});
    expect(val("[]")).toEqual([]);
    expect(val('\t{\n "a" :\r 1 }\n')).toEqual({ a: 1 });
  });

  it("decodes every backslash escape and \\uXXXX, including a surrogate pair", () => {
    expect(val(String.raw`"\"\\\/\b\f\n\r\t"`)).toBe('"\\/\b\f\n\r\t');
    expect(val(`"${B}u0041${B}u00e9"`)).toBe("Aé");
    expect(val(`"${B}uD83D${B}uDE00"`)).toBe("😀");
  });

  it("parses number forms: sign, fraction, and exponent", () => {
    expect(val("0")).toBe(0);
    expect(val("-5")).toBe(-5);
    expect(val("1.5")).toBe(1.5);
    expect(val("2E-2")).toBe(0.02);
    expect(val("1.5e3")).toBe(1500);
  });

  it("exposes DEFAULT_STRICT_JSON_LIMITS with the documented hard depth cap", () => {
    expect(DEFAULT_STRICT_JSON_LIMITS.maxDepth).toBe(128);
  });
});

describe("parseStrictJson — prototype-pollution safety", () => {
  it("treats __proto__/constructor as ordinary own keys and never pollutes Object.prototype", () => {
    const parsed = val('{"__proto__":{"polluted":true},"constructor":1}') as object;
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.hasOwn(parsed, "constructor")).toBe(true);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});

describe("parseStrictJson — duplicate keys", () => {
  it("rejects a duplicate key at the top level, naming the key", () => {
    const e = err('{"a":1,"a":2}');
    expect(e.kind).toBe("duplicate-key");
    expect(e.message).toContain('"a"');
  });

  it("rejects a duplicate key nested in an object", () => {
    expect(err('{"o":{"b":1,"b":2}}').kind).toBe("duplicate-key");
  });

  it("rejects duplicate __proto__ keys", () => {
    expect(err('{"__proto__":1,"__proto__":2}').kind).toBe("duplicate-key");
  });

  it("rejects duplicate keys expressed through different escape forms", () => {
    expect(err(`{"a":1,"${B}u0061":2}`).kind).toBe("duplicate-key");
    expect(err(`{"__proto__":1,"${B}u005f${B}u005fproto__":2}`).kind).toBe("duplicate-key");
  });

  it("allows the same key name in sibling and child objects", () => {
    expect(val('{"a":{"a":1},"b":{"a":2}}')).toEqual({ a: { a: 1 }, b: { a: 2 } });
  });
});

describe("parseStrictJson — syntax rejections", () => {
  it("rejects trailing content after a complete value", () => {
    expect(err("{}x").kind).toBe("syntax");
    expect(err("1 2").kind).toBe("syntax");
  });

  it("rejects trailing commas in arrays and objects", () => {
    expect(err("[1,]").kind).toBe("syntax");
    expect(err('{"a":1,}').kind).toBe("syntax");
  });

  it("rejects malformed numbers", () => {
    for (const t of ["01", "1.", "1e", "-", ".5", "+1", "1.2.3"]) {
      expect(err(t).kind).toBe("syntax");
    }
  });

  it("rejects numbers outside the finite JavaScript range", () => {
    expect(err("1e400").kind).toBe("syntax");
    expect(err("-1e400").kind).toBe("syntax");
  });

  it("rejects unterminated and raw-control-bearing strings", () => {
    expect(err('"abc').message).toContain("unterminated string");
    expect(err(`"${String.fromCharCode(1)}"`).message).toContain("control character");
    expect(err(`"${String.fromCharCode(9)}"`).message).toContain("control character");
  });

  it("rejects invalid escape sequences", () => {
    expect(err(String.raw`"\x"`).message).toContain("invalid escape");
    expect(err(String.raw`"\u12"`).message).toContain("\\u escape");
    expect(err(String.raw`"\uZZZZ"`).message).toContain("\\u escape");
  });

  it("rejects unpaired or malformed surrogate escapes", () => {
    expect(err(String.raw`"\uD800"`).kind).toBe("syntax");
    expect(err(String.raw`"\uDC00"`).kind).toBe("syntax");
    expect(err(`"${B}uD800${B}u0041"`).kind).toBe("syntax");
    expect(err(String.raw`"\uD800\uD800"`).kind).toBe("syntax");
  });

  it("rejects empty and whitespace-only input", () => {
    expect(err("").message).toContain("unexpected end of input");
    expect(err("   ").message).toContain("unexpected end of input");
  });

  it("rejects unknown literals and stray tokens", () => {
    for (const t of ["nul", "tru", "undefined", "'x'", "}"]) {
      expect(err(t).kind).toBe("syntax");
    }
  });
});

describe("parseStrictJson — invalid limits (fail closed)", () => {
  it("rejects a maxDepth above the hard cap", () => {
    expect(err("1", { maxDepth: DEFAULT_STRICT_JSON_LIMITS.maxDepth + 1 }).kind).toBe(
      "invalid-limit",
    );
  });

  it("rejects non-positive or non-integer limits", () => {
    expect(err("1", { maxDepth: 0 }).kind).toBe("invalid-limit");
    expect(err("1", { maxNodes: -1 }).kind).toBe("invalid-limit");
    expect(err("1", { maxStringLength: 1.5 }).kind).toBe("invalid-limit");
  });

  it("accepts maxDepth exactly at the hard cap", () => {
    expect(parseStrictJson("1", { maxDepth: DEFAULT_STRICT_JSON_LIMITS.maxDepth }).ok).toBe(true);
  });
});

describe("parseStrictJson — resource limits during parse", () => {
  it("enforces maxDepth on nested containers", () => {
    expect(parseStrictJson("[]", { maxDepth: 1 }).ok).toBe(true);
    const e = err("[1]", { maxDepth: 1 });
    expect(e.kind).toBe("limit");
    expect(e.message).toContain("depth");
  });

  it("enforces maxNodes counting both values and keys", () => {
    expect(parseStrictJson('{"a":1}', { maxNodes: 3 }).ok).toBe(true); // object + key + value
    const e = err('{"a":1}', { maxNodes: 2 });
    expect(e.kind).toBe("limit");
    expect(e.message).toContain("nodes");
  });

  it("enforces maxStringLength on string and number tokens", () => {
    expect(err('"abcdef"', { maxStringLength: 3 }).kind).toBe("limit");
    expect(err("123456", { maxStringLength: 3 }).kind).toBe("limit");
    expect(parseStrictJson('"abc"', { maxStringLength: 3 }).ok).toBe(true);
  });
});
