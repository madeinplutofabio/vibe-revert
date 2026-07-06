// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure v1 tokenizer for `viberevert shell` (M G3, D103.D).
 *
 * Turns a typed command line into an argv array for guard evaluation
 * (`evaluateCommandPolicy`) and spawning. It is deliberately NOT a shell:
 * there is no expansion of any kind -- no globs (`* ? []`), no variables
 * (`$VAR` / `%VAR%`), no operators (`| > < && || ; & $()`). Those are all
 * ordinary token characters. Shell semantics require the user to invoke a
 * real shell explicitly, e.g. `sh -c "..."` / `cmd /c "..."` -- the guard
 * then sees that literal command. shell.ts therefore introduces no
 * shell-injection surface.
 *
 * === v1 rules (LOCKED; documented verbatim in docs/shell-contract.md) ===
 *
 * 1. Whitespace (runs of space/tab) separates tokens; leading/trailing
 *    whitespace is ignored.
 * 2. Single quotes `'...'` group their contents literally (including
 *    spaces and backslashes); there are NO escapes inside single quotes.
 * 3. Double quotes `"..."` group literally too, but recognize exactly two
 *    escapes: `\"` -> a literal `"`, and `\\` -> a literal `\`. Every other
 *    backslash inside double quotes is literal (so `"a\nb"` is the five
 *    characters a \ n b, not a newline).
 * 4. A backslash OUTSIDE quotes is LITERAL, not an escape. This is the key
 *    v1 decision: Windows paths (`C:\proj\x`) must survive untouched. To
 *    embed a space in a token, quote it -- `\ ` does not escape.
 * 5. Adjacent quoted/unquoted runs concatenate within one token
 *    (`a'b c'd` -> `ab cd`), and quoted EMPTY strings are preserved as
 *    empty arguments (`node -e ""` -> `["node","-e",""]`).
 * 6. An empty or whitespace-only line yields `{ kind: "empty" }`.
 * 7. An unterminated quote yields `{ kind: "error", message }` -- the
 *    tokenizer never throws.
 *
 * The normalized form the guard matches is `argv.join(" ")` (see
 * `command-guard.ts`), so `rm  -rf  "/"` tokenizes to `["rm","-rf","/"]`
 * and normalizes to `rm -rf /`.
 *
 * This module is a pure leaf: no fs, no child_process, no imports from
 * other packages. NOT exported from the package barrel (internal to
 * ShellCommand; see the D99.M.19 not-exported list).
 */

/** Result of tokenizing one typed shell line. */
export type TokenizeResult =
  | { readonly kind: "ok"; readonly argv: string[] }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Tokenize a single command line into argv per the v1 rules above. Never
 * throws: malformed input (an unterminated quote) is returned as a
 * structured `error` result the REPL surfaces and re-prompts on.
 *
 * `current` is null when no token has started, or the (possibly empty)
 * accumulated token text once one has. That null-vs-"" distinction is
 * what preserves quoted empty arguments: `""` starts a token and closes
 * it while it is still "", producing one empty-string argv entry.
 */
export function tokenizeShellLine(line: string): TokenizeResult {
  const argv: string[] = [];
  let current: string | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);

    if (ch === " " || ch === "\t") {
      if (current !== null) {
        argv.push(current);
        current = null;
      }
      continue;
    }

    if (ch === "'") {
      // Single-quoted run: literal until the next single quote; no escapes.
      if (current === null) current = "";
      i++;
      for (; i < line.length && line.charAt(i) !== "'"; i++) {
        current += line.charAt(i);
      }
      if (i >= line.length) {
        return { kind: "error", message: "unterminated single quote in command line" };
      }
      // line.charAt(i) === "'" -- the outer loop's i++ consumes it.
      continue;
    }

    if (ch === '"') {
      // Double-quoted run: literal, recognizing only `\"` and `\\` escapes.
      if (current === null) current = "";
      i++;
      for (; i < line.length && line.charAt(i) !== '"'; i++) {
        const c = line.charAt(i);
        const next = line.charAt(i + 1);
        if (c === "\\" && (next === '"' || next === "\\")) {
          current += next;
          i++;
        } else {
          current += c;
        }
      }
      if (i >= line.length) {
        return { kind: "error", message: "unterminated double quote in command line" };
      }
      continue;
    }

    // Any other character (including a bare backslash) is literal.
    if (current === null) current = "";
    current += ch;
  }

  if (current !== null) argv.push(current);
  if (argv.length === 0) return { kind: "empty" };
  return { kind: "ok", argv };
}
