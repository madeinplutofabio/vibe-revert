// scripts/strict-json.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// A pure, strict JSON parser for the M H5 license audit (see
// docs/adr/0001-deterministic-license-audit.md). Native JSON.parse silently drops
// duplicate keys and imposes no resource bounds; this parser rejects duplicate
// object keys at every depth, accepts only standard JSON syntax (RFC 8259), and
// enforces depth, node, and UTF-16 code-unit limits for strings and number tokens
// DURING parsing so an oversized or hostile document is rejected before an
// unbounded structure is allocated. It returns a classified error (never a
// partially parsed value). Decoded strings must be well-formed Unicode: an
// unpaired UTF-16 surrogate — raw or via a \u escape — is a syntax error, so
// downstream hashing and canonicalization operate only on valid scalar sequences.
//
// Node-counting contract: each parsed VALUE (object, array, string, number, true,
// false, null) counts as one node, AND each object member KEY counts as one node.
// Diagnostics never embed an unbounded source fragment (long keys are truncated).
//
// Container nesting is bounded by a conservative HARD_MAX_DEPTH so recursion cannot
// overflow the JavaScript stack across supported runtimes; a requested depth above
// it, or any non-positive-safe-integer limit, is rejected as an invalid-limit error
// (fail closed) rather than silently reverting to a permissive default.

import type { JsonValue } from "./license-audit-core.js";

export interface StrictJsonLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringLength: number;
}

/** Recursion hard cap; a requested maxDepth above this is an invalid limit. */
const HARD_MAX_DEPTH = 128;

export const DEFAULT_STRICT_JSON_LIMITS: StrictJsonLimits = {
  maxDepth: HARD_MAX_DEPTH,
  maxNodes: 5_000_000,
  maxStringLength: 4_000_000,
};

export type StrictJsonErrorKind = "syntax" | "duplicate-key" | "limit" | "invalid-limit";

export interface StrictJsonError {
  readonly kind: StrictJsonErrorKind;
  readonly message: string;
  readonly position: number;
}

export type StrictJsonResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: StrictJsonError };

class StrictJsonParseError extends Error {
  readonly kind: StrictJsonErrorKind;
  readonly position: number;
  constructor(kind: StrictJsonErrorKind, message: string, position: number) {
    super(message);
    this.name = "StrictJsonParseError";
    this.kind = kind;
    this.position = position;
  }
}

function validateLimit(
  name: string,
  supplied: number | undefined,
  def: number,
  hardMax: number | undefined,
  out: string[],
): number {
  if (supplied === undefined) {
    return def;
  }
  if (!Number.isSafeInteger(supplied) || supplied <= 0) {
    out.push(`${name} must be a positive safe integer`);
    return def;
  }
  if (hardMax !== undefined && supplied > hardMax) {
    out.push(`${name} must not exceed ${hardMax}`);
    return def;
  }
  return supplied;
}

function snippet(s: string): string {
  return s.length <= 32
    ? JSON.stringify(s)
    : `${JSON.stringify(s.slice(0, 32))}… (${s.length} chars)`;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

export function parseStrictJson(
  text: string,
  limits?: Partial<StrictJsonLimits>,
): StrictJsonResult {
  const invalid: string[] = [];
  const maxDepth = validateLimit(
    "maxDepth",
    limits?.maxDepth,
    DEFAULT_STRICT_JSON_LIMITS.maxDepth,
    HARD_MAX_DEPTH,
    invalid,
  );
  const maxNodes = validateLimit(
    "maxNodes",
    limits?.maxNodes,
    DEFAULT_STRICT_JSON_LIMITS.maxNodes,
    undefined,
    invalid,
  );
  const maxStringLength = validateLimit(
    "maxStringLength",
    limits?.maxStringLength,
    DEFAULT_STRICT_JSON_LIMITS.maxStringLength,
    undefined,
    invalid,
  );
  if (invalid.length > 0) {
    return {
      ok: false,
      error: {
        kind: "invalid-limit",
        message: `invalid strict-json limits: ${invalid.join("; ")}`,
        position: 0,
      },
    };
  }

  let pos = 0;
  let nodes = 0;

  function fail(kind: StrictJsonErrorKind, message: string): never {
    throw new StrictJsonParseError(kind, message, pos);
  }

  function countNode(): void {
    nodes += 1;
    if (nodes > maxNodes) {
      fail("limit", `JSON exceeds ${maxNodes} nodes`);
    }
  }

  function skipWhitespace(): void {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        pos += 1;
      } else {
        break;
      }
    }
  }

  function parseString(): string {
    pos += 1; // opening quote
    let out = "";
    while (true) {
      const runStart = pos;
      while (pos < text.length) {
        const c = text.charCodeAt(pos);
        if (c === 0x22 || c === 0x5c || c < 0x20) {
          break;
        }
        pos += 1;
      }
      if (pos > runStart) {
        out += text.slice(runStart, pos);
        if (out.length > maxStringLength) {
          fail("limit", `JSON string exceeds ${maxStringLength} UTF-16 code units`);
        }
      }
      if (pos >= text.length) {
        fail("syntax", "unterminated string");
      }
      const c = text.charCodeAt(pos);
      if (c === 0x22) {
        pos += 1; // closing quote
        // Reject unpaired UTF-16 surrogates so the decoded string is a valid Unicode
        // scalar sequence (consistent hashing/canonicalization downstream).
        for (let i = 0; i < out.length; i += 1) {
          const u = out.charCodeAt(i);
          if (u >= 0xd800 && u <= 0xdbff) {
            const low = i + 1 < out.length ? out.charCodeAt(i + 1) : 0;
            if (low < 0xdc00 || low > 0xdfff) {
              fail("syntax", "unpaired surrogate in string");
            }
            i += 1; // consume the paired low surrogate
          } else if (u >= 0xdc00 && u <= 0xdfff) {
            fail("syntax", "unpaired surrogate in string");
          }
        }
        return out;
      }
      if (c < 0x20) {
        fail("syntax", "raw control character in string");
      }
      // c === 0x5c (backslash escape)
      pos += 1;
      if (pos >= text.length) {
        fail("syntax", "unterminated escape");
      }
      const e = text.charAt(pos);
      pos += 1;
      switch (e) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = text.slice(pos, pos + 4);
          if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
            fail("syntax", "invalid \\u escape");
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          pos += 4;
          break;
        }
        default:
          fail("syntax", "invalid escape sequence");
      }
      if (out.length > maxStringLength) {
        fail("limit", `JSON string exceeds ${maxStringLength} UTF-16 code units`);
      }
    }
  }

  function consumeDigits(start: number): void {
    while (isDigit(text.charAt(pos))) {
      pos += 1;
      if (pos - start > maxStringLength) {
        fail("limit", `JSON number exceeds ${maxStringLength} UTF-16 code units`);
      }
    }
  }

  function parseNumber(): number {
    const start = pos;
    if (text.charAt(pos) === "-") {
      pos += 1;
    }
    if (text.charAt(pos) === "0") {
      pos += 1;
    } else if (isDigit(text.charAt(pos))) {
      consumeDigits(start);
    } else {
      fail("syntax", "invalid number");
    }
    if (text.charAt(pos) === ".") {
      pos += 1;
      if (!isDigit(text.charAt(pos))) {
        fail("syntax", "invalid number fraction");
      }
      consumeDigits(start);
    }
    const exp = text.charAt(pos);
    if (exp === "e" || exp === "E") {
      pos += 1;
      const sign = text.charAt(pos);
      if (sign === "+" || sign === "-") {
        pos += 1;
      }
      if (!isDigit(text.charAt(pos))) {
        fail("syntax", "invalid number exponent");
      }
      consumeDigits(start);
    }
    if (pos - start > maxStringLength) {
      fail("limit", `JSON number exceeds ${maxStringLength} UTF-16 code units`);
    }
    const value = Number(text.slice(start, pos));
    if (!Number.isFinite(value)) {
      fail("syntax", "non-finite number");
    }
    return value;
  }

  function parseArray(depth: number): JsonValue {
    countNode();
    pos += 1; // consume [
    const arr: JsonValue[] = [];
    skipWhitespace();
    if (text.charAt(pos) === "]") {
      pos += 1;
      return arr;
    }
    while (true) {
      arr.push(parseValue(depth + 1));
      skipWhitespace();
      const ch = text.charAt(pos);
      if (ch === ",") {
        pos += 1;
        continue;
      }
      if (ch === "]") {
        pos += 1;
        return arr;
      }
      fail("syntax", "expected ',' or ']' in array");
    }
  }

  function parseObject(depth: number): JsonValue {
    countNode();
    pos += 1; // consume {
    // Object.create(null) so a "__proto__" member is an ordinary own property
    // rather than polluting the prototype.
    const obj: Record<string, JsonValue> = Object.create(null);
    const keys = new Set<string>();
    skipWhitespace();
    if (text.charAt(pos) === "}") {
      pos += 1;
      return obj;
    }
    while (true) {
      skipWhitespace();
      if (text.charAt(pos) !== '"') {
        fail("syntax", "expected string key in object");
      }
      countNode(); // each key is a node
      const key = parseString();
      if (keys.has(key)) {
        fail("duplicate-key", `duplicate object key ${snippet(key)}`);
      }
      keys.add(key);
      skipWhitespace();
      if (text.charAt(pos) !== ":") {
        fail("syntax", "expected ':' after object key");
      }
      pos += 1;
      obj[key] = parseValue(depth + 1);
      skipWhitespace();
      const ch = text.charAt(pos);
      if (ch === ",") {
        pos += 1;
        continue;
      }
      if (ch === "}") {
        pos += 1;
        return obj;
      }
      fail("syntax", "expected ',' or '}' in object");
    }
  }

  function parseValue(depth: number): JsonValue {
    if (depth > maxDepth) {
      fail("limit", `JSON exceeds depth ${maxDepth}`);
    }
    skipWhitespace();
    if (pos >= text.length) {
      fail("syntax", "unexpected end of input");
    }
    const c = text.charAt(pos);
    if (c === "{") {
      return parseObject(depth);
    }
    if (c === "[") {
      return parseArray(depth);
    }
    if (c === '"') {
      countNode();
      return parseString();
    }
    if (c === "-" || isDigit(c)) {
      countNode();
      return parseNumber();
    }
    if (text.startsWith("true", pos)) {
      pos += 4;
      countNode();
      return true;
    }
    if (text.startsWith("false", pos)) {
      pos += 5;
      countNode();
      return false;
    }
    if (text.startsWith("null", pos)) {
      pos += 4;
      countNode();
      return null;
    }
    fail("syntax", "unexpected token");
  }

  try {
    const value = parseValue(1);
    skipWhitespace();
    if (pos !== text.length) {
      fail("syntax", "trailing content after JSON value");
    }
    return { ok: true, value };
  } catch (e) {
    if (e instanceof StrictJsonParseError) {
      return { ok: false, error: { kind: e.kind, message: e.message, position: e.position } };
    }
    throw e;
  }
}
