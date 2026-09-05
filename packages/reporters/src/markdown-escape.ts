// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// CommonMark escaping helpers, with one owner.
//
// These four functions were written twice, in `markdown.ts` and in
// `receipt-markdown.ts`, each carrying a comment instructing the reader to
// mirror any change into the other. That instruction is the defect: two copies
// of an ESCAPING rule is the shape where a fix lands in one renderer and the
// other keeps emitting the unsafe output, and nothing fails.
//
// M 0.8.0 step 12 needed a third renderer, so the rule moved here. The receipt
// renderers now import it. `markdown.ts`, which serves the report surface, is
// deliberately left alone in this change: its goldens are a separate suite and
// consolidating it is a mechanical follow-up, not part of this rung.
//
// PACKAGE-INTERNAL. Not re-exported from `src/index.ts`: these are rendering
// mechanics, not a public escaping service, and a consumer needing them is a
// consumer that should be asking a renderer for output instead.

/**
 * Escape a string for safe inline placement inside a markdown paragraph,
 * bullet, heading, blockquote, or emphasis context.
 *
 *   - Newlines become a space, which prevents a paragraph split and stops the
 *     remainder from being re-parsed as a block construct.
 *   - Backslash FIRST, because every later replacement adds backslashes that
 *     must not then be doubled.
 *   - Backtick, asterisk, underscore and brackets are backslash-prefixed, so
 *     no inline code span, emphasis run or link can form.
 *   - Angle brackets become HTML entities, which keeps raw HTML out per the
 *     no-HTML lock and stops an escaped `>` landing at start-of-line from
 *     opening a blockquote.
 *
 * KNOWN LIMIT: leading block-level characters (`#`, `-`, `+`, `1.`) are not
 * escaped. That is safe wherever the value is placed mid-line, which is every
 * call site that follows a `**Label:**`. A caller placing escaped content at
 * start-of-line owns that risk and must say so.
 *
 * DO NOT compose with `inlineCode`. Code-span content does not honor backslash
 * escapes per CommonMark section 6.1, so the escapes would render as literal
 * text. Use whichever helper matches the destination, on RAW input.
 */
export function inlineMarkdown(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Wrap `text` in an inline code span with a dynamic-length backtick fence per
 * CommonMark section 6.1, so embedded backticks cannot break out.
 *
 * The fence is one character longer than the longest backtick run in the
 * newline-normalized input. When the content begins or ends with a backtick or
 * a space, it is padded with one leading and trailing space: the renderer
 * strips a single space from each side only when both sides have one and the
 * content is not entirely whitespace, so the padding preserves a literal
 * boundary backtick and keeps the fence from being miscounted.
 *
 * Newlines collapse to spaces, matching `inlineMarkdown`, because a code span
 * is a single-line construct and would otherwise close at the break.
 *
 * Pass RAW input.
 */
export function inlineCode(text: string): string {
  const normalized = text.replace(/\r?\n/g, " ");
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(normalized.matchAll(/`+/g), (m) => m[0].length),
  );
  const fence = "`".repeat(longestBacktickRun + 1);
  const needsPadding =
    normalized.startsWith("`") ||
    normalized.endsWith("`") ||
    normalized.startsWith(" ") ||
    normalized.endsWith(" ");
  const content = needsPadding ? ` ${normalized} ` : normalized;
  return `${fence}${content}${fence}`;
}

/**
 * Emit a schema-controlled enum value verbatim when it matches the safe
 * alphanumeric-and-underscore shape, and fall back to `inlineMarkdown`
 * otherwise.
 *
 * The gate exists to preserve grep-ability. `inlineMarkdown` would escape every
 * underscore, turning `TRACKED_RESTORED` into `TRACKED\_RESTORED` in the
 * rendered source, which contradicts the layout lock that says a token stays a
 * single searchable word. Every enum value in today's schemas matches the safe
 * shape, so the gate emits them unchanged.
 *
 * The fallback is defense in depth: a future schema value containing a
 * markdown-active character routes through escaping automatically, with no
 * renderer edit.
 */
export function schemaToken(text: string): string {
  return /^[A-Za-z0-9_]+$/.test(text) ? text : inlineMarkdown(text);
}

/**
 * A schema enum as a bracketed, uppercased token: `[VALUE]`.
 *
 * Uppercasing runs BEFORE the safe-shape gate, which is sound because
 * uppercasing alphanumeric-and-underscore input cannot introduce an unsafe
 * character. Bold wrapping is applied by the caller, so this composes with any
 * emphasis context.
 */
export function bracketToken(token: string): string {
  return `[${schemaToken(token.toUpperCase())}]`;
}
