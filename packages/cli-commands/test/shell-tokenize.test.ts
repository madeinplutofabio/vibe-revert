// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the pure v1 shell tokenizer (M G3 Step 1, D103.D).
//
// The tokenizing rules are a LOCKED v1 contract (docs/shell-contract.md):
// whitespace split; single/double quote grouping; `\"` and `\\` escapes
// ONLY inside double quotes; backslash literal outside quotes (Windows
// paths); NO expansion of any kind (globs/vars/operators are ordinary
// characters); quoted empty strings preserved; unterminated quote -> a
// structured error, never a throw.

import { describe, expect, it } from "vitest";

import { tokenizeShellLine } from "../src/commands/shell-tokenize.js";

/** Assert a line tokenizes to exactly `argv`. */
function expectArgv(line: string, argv: string[]): void {
  expect(tokenizeShellLine(line)).toEqual({ kind: "ok", argv });
}

describe("tokenizeShellLine -- whitespace and basics", () => {
  it("splits on single spaces", () => {
    expectArgv("rm -rf /", ["rm", "-rf", "/"]);
  });

  it("collapses runs of spaces and tabs", () => {
    expectArgv("rm  -rf\t\t/", ["rm", "-rf", "/"]);
  });

  it("trims leading and trailing whitespace", () => {
    expectArgv("   node build.js   ", ["node", "build.js"]);
  });

  it("a single token passes through", () => {
    expectArgv("claude", ["claude"]);
  });
});

describe("tokenizeShellLine -- quoting", () => {
  it("single quotes group spaces literally", () => {
    expectArgv("echo 'a b'", ["echo", "a b"]);
  });

  it("double quotes group spaces literally", () => {
    expectArgv('echo "a b"', ["echo", "a b"]);
  });

  it("adjacent quoted and unquoted runs concatenate into one token", () => {
    expectArgv("a'b c'd", ["ab cd"]);
  });

  it("no escapes inside single quotes (backslash is literal)", () => {
    expectArgv("echo 'a\\b'", ["echo", "a\\b"]);
  });

  it('double quotes recognize \\" as a literal quote', () => {
    expectArgv('echo "a\\"b"', ["echo", 'a"b']);
  });

  it("double quotes recognize \\\\ as a literal backslash", () => {
    expectArgv('echo "a\\\\b"', ["echo", "a\\b"]);
  });

  it("other backslashes inside double quotes are literal (\\n is backslash-n, not newline)", () => {
    expectArgv('echo "a\\nb"', ["echo", "a\\nb"]);
  });
});

describe("tokenizeShellLine -- backslash outside quotes is literal (Windows paths)", () => {
  it("preserves a Windows path untouched", () => {
    expectArgv("node C:\\proj\\build.js", ["node", "C:\\proj\\build.js"]);
  });

  it("backslash-space does NOT escape -- the space still splits the token", () => {
    expectArgv("a\\ b", ["a\\", "b"]);
  });
});

describe("tokenizeShellLine -- quoted empty arguments (preserved)", () => {
  it('node -e "" yields an empty third argument', () => {
    expectArgv('node -e ""', ["node", "-e", ""]);
  });

  it("'' yields a single empty-string argument", () => {
    expectArgv("''", [""]);
  });

  it('a "" first token is a single empty-string argument (the command refuses argv[0]==="" itself)', () => {
    expectArgv('""', [""]);
  });
});

describe("tokenizeShellLine -- empty and error results", () => {
  it("an empty line is empty", () => {
    expect(tokenizeShellLine("")).toEqual({ kind: "empty" });
  });

  it("a whitespace-only line is empty", () => {
    expect(tokenizeShellLine("   \t  ")).toEqual({ kind: "empty" });
  });

  it("an unterminated single quote is a structured error", () => {
    expect(tokenizeShellLine("echo 'abc").kind).toBe("error");
  });

  it("an unterminated double quote is a structured error", () => {
    expect(tokenizeShellLine('echo "abc').kind).toBe("error");
  });

  it("never throws on malformed input (trailing backslash inside an open quote)", () => {
    expect(() => tokenizeShellLine('"\\')).not.toThrow();
    expect(tokenizeShellLine('"\\').kind).toBe("error");
  });
});

describe("tokenizeShellLine -- no expansion (shell operators are literal)", () => {
  it("redirection operators are ordinary tokens", () => {
    expectArgv("echo hi > out", ["echo", "hi", ">", "out"]);
  });

  it("shell semantics require an explicit sh -c (the quoted command is one token)", () => {
    expectArgv('sh -c "echo hi > out"', ["sh", "-c", "echo hi > out"]);
  });

  it("pipes, and-or, and glob characters are literal tokens", () => {
    expectArgv("cat a | grep b && echo *", ["cat", "a", "|", "grep", "b", "&&", "echo", "*"]);
  });

  it("dollar and percent are literal (no variable expansion)", () => {
    expectArgv("echo $HOME %PATH%", ["echo", "$HOME", "%PATH%"]);
  });
});

describe("tokenizeShellLine -- normalized-form parity with the guard matcher", () => {
  it("collapsed whitespace + quotes normalize to the guard entry `rm -rf /`", () => {
    const result = tokenizeShellLine('rm  -rf   "/"');
    expect(result).toEqual({ kind: "ok", argv: ["rm", "-rf", "/"] });
    if (result.kind === "ok") {
      expect(result.argv.join(" ")).toBe("rm -rf /");
    }
  });
});
