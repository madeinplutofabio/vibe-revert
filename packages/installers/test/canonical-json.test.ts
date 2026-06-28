// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { describe, expect, it } from "vitest";

import { canonicalJson, prettyJson, sha256OfCanonical } from "../src/canonical-json.js";

describe("canonicalJson -- primitive emission", () => {
  it("encodes null", () => expect(canonicalJson(null)).toBe("null"));
  it("encodes true", () => expect(canonicalJson(true)).toBe("true"));
  it("encodes false", () => expect(canonicalJson(false)).toBe("false"));
  it("encodes integer", () => expect(canonicalJson(42)).toBe("42"));
  it("encodes negative integer", () => expect(canonicalJson(-7)).toBe("-7"));
  it("encodes float", () => expect(canonicalJson(1.5)).toBe("1.5"));
  it("encodes zero", () => expect(canonicalJson(0)).toBe("0"));
  it("normalizes -0 to 0", () => expect(canonicalJson(-0)).toBe("0"));
  it("encodes empty string", () => expect(canonicalJson("")).toBe('""'));
  it("encodes empty object", () => expect(canonicalJson({})).toBe("{}"));
  it("encodes empty array", () => expect(canonicalJson([])).toBe("[]"));
});

describe("canonicalJson -- key sorting (UTF-8 byte order)", () => {
  it("sorts top-level keys lexicographically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("sorts nested object keys recursively", () => {
    expect(canonicalJson({ b: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"b":{"x":2,"y":1}}');
  });
  it("sorts numeric-string keys by UTF-8 bytes, not numeric value", () => {
    // Byte order: "1" < "10" < "2" (shorter prefix sorts first;
    // "1" < "2" by first byte). Default JS property enumeration
    // puts integer-indexed keys in numeric order (1, 2, 10), which
    // would be wrong for canonical -- canonical must hash the same
    // across any JS engine.
    expect(canonicalJson({ "10": 1, "2": 2, "1": 3 })).toBe('{"1":3,"10":1,"2":2}');
  });
  it("sorts non-BMP and Private Use Area chars by UTF-8 bytes, not UTF-16 code units", () => {
    // "😀" (emoji U+1F600) UTF-8 = F0 9F 98 80.
    // "" (Private Use Area U+E000) UTF-8 = EE 80 80.
    // UTF-16 code-unit order: 0xD83D < 0xE000, so emoji would sort
    // first if JS default sort were used.
    // UTF-8 byte order: 0xEE < 0xF0, so Private Use sorts first --
    // and canonicalJson must do the UTF-8 ordering.
    const obj = { "😀": 1, "": 2 };
    const result = canonicalJson(obj);
    const privateUseIdx = result.indexOf("");
    const emojiIdx = result.indexOf("😀");
    expect(privateUseIdx).toBeGreaterThan(-1);
    expect(emojiIdx).toBeGreaterThan(-1);
    expect(privateUseIdx).toBeLessThan(emojiIdx);
  });
});

describe("canonicalJson -- arrays", () => {
  it("preserves array element order (never sorts elements)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
  it("encodes nested arrays", () => {
    expect(canonicalJson([[1, 2], [3]])).toBe("[[1,2],[3]]");
  });
  it("canonicalizes objects inside arrays", () => {
    expect(
      canonicalJson([
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ]),
    ).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });
});

describe("canonicalJson -- string escaping (delegated to JSON.stringify)", () => {
  // Standard control characters get standard JSON escapes; no
  // rejection. (Rejection applies only to unpaired UTF-16 surrogates.)
  it("escapes newline as \\n", () => expect(canonicalJson("a\nb")).toBe('"a\\nb"'));
  it("escapes tab as \\t", () => expect(canonicalJson("a\tb")).toBe('"a\\tb"'));
  it("escapes carriage return as \\r", () => expect(canonicalJson("a\rb")).toBe('"a\\rb"'));
  it("escapes backslash as \\\\", () => expect(canonicalJson("a\\b")).toBe('"a\\\\b"'));
  it('escapes double-quote as \\"', () => expect(canonicalJson('a"b')).toBe('"a\\"b"'));
  it("escapes form feed as \\f", () => expect(canonicalJson("\f")).toBe('"\\f"'));
  it("escapes backspace as \\b", () => expect(canonicalJson("\b")).toBe('"\\b"'));
  it("escapes low control character with \\u escape", () =>
    expect(canonicalJson("")).toBe('"\\u0001"'));
});

describe("canonicalJson -- non-finite number rejections", () => {
  // Keep /non-finite/ regex: meaningful distinction from other
  // rejection causes (NaN vs Infinity vs -Infinity all share this
  // semantic family).
  it("rejects NaN", () => expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/));
  it("rejects Infinity", () =>
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/));
  it("rejects -Infinity", () =>
    expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/));
});

describe("canonicalJson -- undefined rejections", () => {
  it("rejects top-level undefined", () => expect(() => canonicalJson(undefined)).toThrow());
  it("rejects undefined value in object", () =>
    expect(() => canonicalJson({ a: undefined })).toThrow());
  it("rejects undefined element in array", () =>
    expect(() => canonicalJson([undefined])).toThrow());
});

describe("canonicalJson -- non-JSON type rejections", () => {
  it("rejects function value", () => expect(() => canonicalJson({ a: () => 1 })).toThrow());
  it("rejects symbol value", () => expect(() => canonicalJson({ a: Symbol("x") })).toThrow());
  it("rejects bigint value", () => expect(() => canonicalJson({ a: 1n })).toThrow());
});

describe("canonicalJson -- cyclic reference rejections", () => {
  it("rejects cyclic object reference", () => {
    const obj: { self?: unknown } = {};
    obj.self = obj;
    expect(() => canonicalJson(obj)).toThrow();
  });
  it("rejects cyclic array reference", () => {
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => canonicalJson(arr)).toThrow();
  });
});

describe("canonicalJson -- accessor/descriptor rejections", () => {
  it("rejects getter property on object", () => {
    const obj = {};
    Object.defineProperty(obj, "a", {
      get: () => 1,
      enumerable: true,
      configurable: true,
    });
    expect(() => canonicalJson(obj)).toThrow();
  });
  it("rejects non-enumerable property on object", () => {
    const obj = {};
    Object.defineProperty(obj, "a", {
      value: 1,
      enumerable: false,
      configurable: true,
    });
    expect(() => canonicalJson(obj)).toThrow();
  });
  it("rejects accessor element on array", () => {
    const arr = [1];
    Object.defineProperty(arr, "0", {
      get: () => 99,
      enumerable: true,
      configurable: true,
    });
    expect(() => canonicalJson(arr)).toThrow();
  });
});

describe("canonicalJson -- array structural rejections", () => {
  it("rejects sparse array hole", () => {
    const arr: number[] = [];
    arr[0] = 1;
    arr[2] = 3; // hole at index 1
    expect(() => canonicalJson(arr)).toThrow();
  });
  it("rejects non-index named property on array", () => {
    const arr = [1, 2] as number[] & { foo?: string };
    arr.foo = "x";
    expect(() => canonicalJson(arr)).toThrow();
  });
});

describe("canonicalJson -- unpaired UTF-16 surrogate rejections", () => {
  // Keep /unpaired/ regex: meaningful distinction from generic
  // string rejection (surrogates are well-formed at the JS string
  // level but unencodable as UTF-8; the error message is the
  // contract for users debugging Unicode issues).
  it("rejects unpaired high surrogate in string value", () =>
    expect(() => canonicalJson("\ud83d")).toThrow(/unpaired/));
  it("rejects unpaired low surrogate in string value", () =>
    expect(() => canonicalJson("\ude00")).toThrow(/unpaired/));
  it("rejects unpaired high surrogate in object key", () =>
    expect(() => canonicalJson({ "\ud83d": 1 })).toThrow(/unpaired/));
  it("rejects unpaired low surrogate in object key", () =>
    expect(() => canonicalJson({ "\ude00": 1 })).toThrow(/unpaired/));
});

describe("canonicalJson -- enumerable symbol key rejections", () => {
  it("rejects enumerable symbol key on object", () => {
    const sym = Symbol("test");
    expect(() => canonicalJson({ [sym]: 1 })).toThrow();
  });
  it("rejects enumerable symbol key on array", () => {
    const arr: unknown[] = [];
    const sym = Symbol("test");
    Object.defineProperty(arr, sym, { value: 1, enumerable: true });
    expect(() => canonicalJson(arr)).toThrow();
  });
});

describe("canonicalJson -- non-plain object rejections", () => {
  it("rejects Date instance", () => expect(() => canonicalJson({ a: new Date() })).toThrow());
  it("rejects Map instance", () => expect(() => canonicalJson({ a: new Map() })).toThrow());
  it("rejects Set instance", () => expect(() => canonicalJson({ a: new Set() })).toThrow());
  it("rejects RegExp", () => expect(() => canonicalJson({ a: /x/ })).toThrow());
  it("rejects class instance", () => {
    class Foo {}
    expect(() => canonicalJson({ a: new Foo() })).toThrow();
  });
});

describe("canonicalJson -- non-enumerable symbol keys are tolerated", () => {
  it("on object", () => {
    const sym = Symbol("private");
    const obj = { a: 1 };
    Object.defineProperty(obj, sym, { value: 2, enumerable: false });
    expect(canonicalJson(obj)).toBe('{"a":1}');
  });
  it("on array", () => {
    const sym = Symbol("private");
    const arr = [1, 2];
    Object.defineProperty(arr, sym, { value: 3, enumerable: false });
    expect(canonicalJson(arr)).toBe("[1,2]");
  });
});

describe("prettyJson", () => {
  it("preserves caller's insertion order (does NOT canonicalize keys)", () => {
    expect(prettyJson({ b: 1, a: 2 })).toBe('{\n  "b": 1,\n  "a": 2\n}');
  });
  it("preserves multi-key insertion order", () => {
    expect(prettyJson({ z: 1, m: 2, a: 3 })).toBe('{\n  "z": 1,\n  "m": 2,\n  "a": 3\n}');
  });
  it("uses 2-space indentation for objects", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it("preserves nested-object insertion order", () => {
    expect(prettyJson({ a: { y: 1, x: 2 }, b: 3 })).toBe(
      '{\n  "a": {\n    "y": 1,\n    "x": 2\n  },\n  "b": 3\n}',
    );
  });
  it("renders array with newline-per-element at 4-space indent inside object", () => {
    expect(prettyJson({ a: [1, 2] })).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
  });
  it("produces output distinct from canonicalJson (different roles)", () => {
    // prettyJson is for human-readable file writes; canonicalJson is
    // for deterministic hashing. They are NOT interchangeable -- a
    // future maintainer must not assume prettyJson can be used as
    // hash input.
    expect(prettyJson({ b: 1, a: 2 })).not.toBe(canonicalJson({ b: 1, a: 2 }));
  });
  it("rejects NaN (same set as canonicalJson)", () => {
    expect(() => prettyJson(Number.NaN)).toThrow(/non-finite/);
  });
  it("rejects non-plain object (same set as canonicalJson)", () => {
    expect(() => prettyJson({ a: new Date() })).toThrow();
  });
  it("rejects undefined (same set as canonicalJson)", () => {
    expect(() => prettyJson({ a: undefined })).toThrow();
  });
  it("rejects unpaired surrogate (same set as canonicalJson)", () => {
    expect(() => prettyJson("\ud83d")).toThrow(/unpaired/);
  });
});

describe("sha256OfCanonical", () => {
  it("returns 64 lowercase hex characters", () => {
    expect(sha256OfCanonical(null)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is stable across key orderings (same canonical input -> same hash)", () => {
    const a = sha256OfCanonical({ a: 1, b: 2 });
    const b = sha256OfCanonical({ b: 2, a: 1 });
    expect(a).toBe(b);
  });
  it("is stable for nested key orderings", () => {
    const a = sha256OfCanonical({ outer: { a: 1, b: 2 } });
    const b = sha256OfCanonical({ outer: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });
  it("distinguishes distinct values", () => {
    expect(sha256OfCanonical({ a: 1 })).not.toBe(sha256OfCanonical({ a: 2 }));
  });
  it("distinguishes distinct keys", () => {
    expect(sha256OfCanonical({ a: 1 })).not.toBe(sha256OfCanonical({ b: 1 }));
  });
  it("distinguishes array order (arrays are not sorted)", () => {
    expect(sha256OfCanonical([1, 2])).not.toBe(sha256OfCanonical([2, 1]));
  });
  it("propagates rejections from canonicalJson", () => {
    expect(() => sha256OfCanonical(Number.NaN)).toThrow(/non-finite/);
  });
});
