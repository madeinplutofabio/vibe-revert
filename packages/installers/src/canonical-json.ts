// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Canonical JSON serialization per D101.N (deterministic byte output)
// + a pretty-print sibling for user-facing file writes.
//
// canonicalJson(value): string
//   - Object keys sorted recursively in UTF-8 byte order (NOT the
//     ECMAScript default UTF-16 code-unit order from `.sort()` with no
//     comparator, NOT locale-dependent collation). Sort happens at
//     every nesting level. UTF-8 byte ordering keeps canonical form
//     stable across runtimes even if their internal string
//     representations differ — this matters because canonical JSON is
//     hashed for durable integrity, and a hash that depends on the JS
//     engine's string sort would silently diverge across runtimes.
//   - Arrays preserved in source order (NOT sorted; array order is
//     semantically meaningful in JSON). Arrays must be dense with
//     enumerable data elements only — see rejection list below.
//   - No whitespace (compact output, no indentation, no newlines).
//   - Strings emitted with standard JSON escaping via JSON.stringify.
//     When hashed or written, the resulting JSON text is encoded as
//     UTF-8.
//   - Numbers: JSON.stringify's default number formatting. `-0`
//     normalizes to `0`, which is acceptable for v1 config data.
//   - Properties (object keys AND array indexes) read via
//     Object.getOwnPropertyDescriptors so getters are NEVER invoked.
//     Two passes (validation + emit) would otherwise see potentially
//     different values from a getter, which breaks the canonical-hash
//     guarantee.
//   - Rejects (throws) on non-JSON values BEFORE emit:
//       - non-finite numbers (NaN, Infinity, -Infinity) — silent
//         JSON.stringify(NaN) = "null" is data loss
//       - undefined (in objects: skipped by JSON.stringify; in arrays:
//         becomes null; both are silent data loss)
//       - functions, symbols, bigints (unrepresentable in JSON)
//       - non-plain objects (Date, Map, Set, Buffer, RegExp, class
//         instances — any object whose prototype is not Object.prototype
//         or null). These have meaningful runtime semantics that JSON
//         flattens; rejecting forces the caller to pre-convert.
//       - cyclic object/array references (JSON cannot represent cycles;
//         shared non-cyclic references are allowed and serialized by
//         value)
//       - strings/object keys containing unpaired UTF-16 surrogates
//         (not well-formed Unicode; Buffer.from(str, "utf8") substitutes
//         U+FFFD for invalid sequences so two distinct ill-formed
//         strings could collapse to identical UTF-8 bytes, breaking the
//         canonical hash promise)
//       - enumerable symbol keys on objects OR arrays (JSON object
//         keys must be strings and arrays only contain indexed
//         elements; JSON.stringify silently drops symbol keys, which
//         is data loss). Non-enumerable symbol keys are tolerated
//         (private metadata no serializer would expose).
//       - accessor properties / getters / setters on objects OR
//         arrays (canonical JSON requires stable data properties;
//         getters could return different values on the validation vs
//         emit pass, breaking determinism)
//       - non-enumerable properties on objects OR arrays
//         (JSON.stringify silently skips them, which is data loss)
//       - sparse array holes (JSON.stringify serializes holes as null,
//         which is silent data loss; use null explicitly instead)
//       - non-index own properties on arrays — anything other than
//         numeric indexes 0..2^32-2 and the "length" property is
//         silently ignored by JSON.stringify (use a plain object if
//         you need named properties)
//
// Subtle correctness note: the canonical output is NOT produced by
// building a sorted-keys object and calling JSON.stringify. That would
// be wrong because ECMAScript object property enumeration order puts
// integer-indexed string keys ("1", "10", "2") in ASCENDING NUMERIC
// order regardless of insertion order, defeating our lexicographic
// sort. Instead, we emit JSON directly via recursive string assembly
// — keys come out in compareUtf8Bytes order verbatim.
//
// prettyJson(value): string
//   - 2-space pretty (JSON.stringify(value, null, 2)).
//   - Preserves user-side outer-file key order (does NOT canonicalize).
//   - Same input validation as canonicalJson (see rejection list above)
//     so a bug upstream can't silently write corrupt JSON to disk.
//
// sha256OfCanonical(value): string
//   - SHA-256 hex digest of the UTF-8 bytes of canonicalJson(value).
//   - 64 lowercase hex characters.
//   - Used by integrations-store to compute managedValueSha256 for
//     json-key-merge ops (per D101.C per-kind SHA discipline).

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Compare two strings by their UTF-8 byte representation.
 * Stable across runtimes; independent of JS-engine string internals.
 */
function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Format a JSONPath-ish child path for error messages. Safe identifier
 * keys ([A-Za-z_$][\w$]*) use dot notation (`$.foo`); anything else
 * (".", "[", "", non-ASCII, etc.) uses bracket+quoted notation
 * (`$["weird.key"]`) so the path is unambiguous.
 */
function formatObjectPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Return true if `value` contains any UTF-16 surrogate code unit that
 * is not part of a valid surrogate pair (high U+D800-U+DBFF followed
 * by low U+DC00-U+DFFF). Lone surrogates are ill-formed UTF-16 and
 * cannot be losslessly encoded as UTF-8 — Buffer.from would substitute
 * U+FFFD, collapsing distinct ill-formed strings to identical bytes.
 */
function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Return true if `key` is a valid ECMAScript array index string:
 * decimal digits with no leading zero (except "0" itself), value in
 * 0..2^32-2, and roundtrip-exact (`String(Number(key)) === key`).
 * Spec: an array index is a string P such that ToString(ToUint32(P))
 * equals P and ToUint32(P) is not 2^32-1.
 */
function isArrayIndexKey(key: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const n = Number(key);
  return Number.isSafeInteger(n) && n >= 0 && n < 2 ** 32 - 1 && String(n) === key;
}

function assertJsonSerializable(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (value === null) return;
  switch (typeof value) {
    case "boolean":
      return;
    case "string":
      if (hasUnpairedSurrogate(value)) {
        throw new Error(
          `canonical-json: string at ${path} contains an unpaired UTF-16 surrogate. Canonical JSON requires well-formed Unicode strings.`,
        );
      }
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(
          `canonical-json: non-finite number at ${path}: ${value}. JSON has no representation for NaN, Infinity, or -Infinity.`,
        );
      }
      return;
    case "object": {
      if (seen.has(value)) {
        throw new Error(
          `canonical-json: cyclic reference at ${path}. JSON cannot represent cycles.`,
        );
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const descriptors = Object.getOwnPropertyDescriptors(value);
          // Reject enumerable symbol keys on arrays.
          for (const symbolKey of Object.getOwnPropertySymbols(value)) {
            const sd = Object.getOwnPropertyDescriptor(value, symbolKey);
            if (sd?.enumerable) {
              throw new Error(
                `canonical-json: enumerable symbol key at ${path}. JSON array keys must be numeric indexes.`,
              );
            }
          }
          // Reject non-index string keys (other than "length").
          for (const k of Object.keys(descriptors)) {
            if (k === "length") continue;
            if (!isArrayIndexKey(k)) {
              throw new Error(
                `canonical-json: non-index array property at ${formatObjectPath(path, k)}. Canonical JSON arrays may only contain numeric indexes.`,
              );
            }
          }
          // For each index 0..length-1: descriptor must exist, be an
          // enumerable data property, with non-undefined value.
          for (let i = 0; i < value.length; i++) {
            const descriptor = descriptors[String(i)];
            const childPath = `${path}[${i}]`;
            if (!descriptor) {
              throw new Error(
                `canonical-json: sparse array hole at ${childPath}. JSON.stringify would serialize it as null; use null explicitly.`,
              );
            }
            if (!("value" in descriptor)) {
              throw new Error(
                `canonical-json: accessor array element at ${childPath}. Canonical JSON requires data elements, not getters or setters.`,
              );
            }
            if (!descriptor.enumerable) {
              throw new Error(
                `canonical-json: non-enumerable array element at ${childPath}. Canonical JSON requires enumerable data elements only.`,
              );
            }
            if (descriptor.value === undefined) {
              throw new Error(
                `canonical-json: undefined value at ${childPath}. JSON has no representation for undefined; use null.`,
              );
            }
            assertJsonSerializable(descriptor.value, childPath, seen);
          }
          return;
        }
        if (!isPlainObject(value)) {
          const ctor = (value as object).constructor?.name ?? "unknown";
          throw new Error(
            `canonical-json: non-plain object at ${path} (constructor: ${ctor}). JSON cannot serialize Date, Map, Set, Buffer, RegExp, or class instances — pre-convert to plain JSON values.`,
          );
        }
        // Reject enumerable symbol keys on objects; non-enumerable
        // symbol keys are tolerated (private metadata that JSON would
        // never serialize anyway).
        for (const symbolKey of Object.getOwnPropertySymbols(value)) {
          const sd = Object.getOwnPropertyDescriptor(value, symbolKey);
          if (sd?.enumerable) {
            throw new Error(
              `canonical-json: enumerable symbol key at ${path}. JSON object keys must be strings.`,
            );
          }
        }
        // Iterate via descriptors to AVOID invoking getters. Two passes
        // (this validation + emitCanonical) would otherwise see
        // potentially different values from a getter, breaking the
        // canonical-hash guarantee.
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (const k of Object.keys(descriptors)) {
          const descriptor = descriptors[k];
          if (!descriptor) continue;
          const childPath = formatObjectPath(path, k);
          if (!("value" in descriptor)) {
            throw new Error(
              `canonical-json: accessor property at ${childPath}. Canonical JSON requires plain data properties, not getters or setters.`,
            );
          }
          if (!descriptor.enumerable) {
            throw new Error(
              `canonical-json: non-enumerable property at ${childPath}. Canonical JSON requires enumerable data properties only.`,
            );
          }
          if (hasUnpairedSurrogate(k)) {
            throw new Error(
              `canonical-json: object key at ${childPath} contains an unpaired UTF-16 surrogate. Canonical JSON requires well-formed Unicode strings.`,
            );
          }
          const v = descriptor.value;
          if (v === undefined) {
            throw new Error(
              `canonical-json: undefined value at ${childPath}. JSON has no representation for undefined; remove the key or use null.`,
            );
          }
          assertJsonSerializable(v, childPath, seen);
        }
        return;
      } finally {
        seen.delete(value);
      }
    }
    case "undefined":
      throw new Error(
        `canonical-json: undefined value at ${path}. JSON has no representation for undefined.`,
      );
    case "function":
    case "symbol":
    case "bigint":
      throw new Error(`canonical-json: ${typeof value} at ${path}. Not representable in JSON.`);
  }
}

function emitCanonical(value: unknown): string {
  // Pre-validated by assertJsonSerializable, so all branches return
  // safely (cycles, non-finite numbers, non-plain objects, unpaired
  // surrogates, accessors, enumerable symbol keys, non-enumerable
  // properties, sparse holes, non-index array properties all rejected
  // before this function runs).
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        // Use descriptors here too so emit never invokes getters even
        // if the object shape changes between validation and emit.
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const parts: string[] = [];
        for (let i = 0; i < value.length; i++) {
          const descriptor = descriptors[String(i)];
          if (!descriptor?.enumerable || !("value" in descriptor)) {
            // Unreachable: assertJsonSerializable rejected sparse
            // holes, accessor elements, and non-enumerable elements.
            throw new Error(
              `canonical-json: emit-time array descriptor invariant violated at index ${i}`,
            );
          }
          parts.push(emitCanonical(descriptor.value));
        }
        return `[${parts.join(",")}]`;
      }
      // Use descriptors here too so emit never invokes getters even if
      // the object shape changes between validation and emit.
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors).sort(compareUtf8Bytes);
      const parts: string[] = [];
      for (const k of keys) {
        const descriptor = descriptors[k];
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          // Unreachable: assertJsonSerializable rejected accessors and
          // non-enumerable properties and ensured every surviving key
          // has an enumerable data descriptor.
          throw new Error(
            `canonical-json: emit-time descriptor invariant violated at key ${JSON.stringify(k)}`,
          );
        }
        parts.push(`${JSON.stringify(k)}:${emitCanonical(descriptor.value)}`);
      }
      return `{${parts.join(",")}}`;
    }
  }
  // Unreachable: assertJsonSerializable rejected all other types.
  throw new Error(`canonical-json: emit-time invariant violated for type ${typeof value}`);
}

/**
 * Canonical JSON encoding of `value`. Deterministic across runs and
 * across runtimes. Throws on non-JSON values (see top comment for
 * the complete rejection list including cycles, unpaired surrogates,
 * accessors, non-enumerable properties, sparse arrays, and non-index
 * array properties). Never invokes getters.
 */
export function canonicalJson(value: unknown): string {
  assertJsonSerializable(value, "$");
  return emitCanonical(value);
}

/**
 * Pretty JSON encoding of `value` (2-space indent). Preserves caller's
 * object key order; does NOT canonicalize. Same rejection rules as
 * canonicalJson (see top comment). Never invokes getters.
 */
export function prettyJson(value: unknown): string {
  assertJsonSerializable(value, "$");
  return JSON.stringify(value, null, 2);
}

/**
 * SHA-256 hex digest of the UTF-8 bytes of canonicalJson(value).
 * Returns 64 lowercase hex characters.
 */
export function sha256OfCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
