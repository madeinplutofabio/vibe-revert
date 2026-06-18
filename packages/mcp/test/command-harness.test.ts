// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for the shared command-harness helpers.
//
// Mocks @viberevert/cli-commands at the BOUNDARY -- runCommandInProcess
// is replaced by vi.fn() so each test injects its own harness result.
// Uses CheckCommand as the canonical command-class reference (the
// helpers never actually execute it because runCommandInProcess is
// mocked).

import { CheckCommand, type RunCommandInProcessResult } from "@viberevert/cli-commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@viberevert/cli-commands", async () => {
  const actual = await vi.importActual<typeof import("@viberevert/cli-commands")>(
    "@viberevert/cli-commands",
  );
  return {
    ...actual,
    runCommandInProcess: vi.fn(),
  };
});

const { runJsonCommandHarness, runRawCommandHarness, truncateUtf8Text } = await import(
  "../src/command-harness.js"
);
const cliCommands = await import("@viberevert/cli-commands");
const mockedRun = vi.mocked(cliCommands.runCommandInProcess);

const ABS_REPO_ROOT = "/abs/repo";

const BASE_RESULT: RunCommandInProcessResult = {
  exitCode: 0,
  stdoutBytes: Buffer.from(""),
  stderrText: "",
  stdoutTruncated: false,
  stdoutBytesOmitted: 0,
  stderrTruncated: false,
  stderrBytesOmitted: 0,
};

const TEST_SCHEMA = z.object({ ok: z.boolean() });

beforeEach(() => {
  mockedRun.mockReset();
});

afterEach(() => {
  mockedRun.mockReset();
});

// ============================================================================
// A. isAbsolute(repoRoot) guard
// ============================================================================

describe("harness: repoRoot absolute guard", () => {
  it("runRawCommandHarness returns INTERNAL_ERROR when repoRoot is not absolute", async () => {
    const result = await runRawCommandHarness({
      command: CheckCommand,
      toolName: "test_tool",
      argv: ["test"],
      repoRoot: "relative/path",
      successExitCodes: [0],
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error" && result.envelope.ok === false) {
      expect(result.envelope.error.code).toBe("INTERNAL_ERROR");
      expect(result.envelope.error.message).toContain("must be an absolute path");
      expect(result.envelope.error.message).toContain("test_tool");
    }
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("runJsonCommandHarness returns INTERNAL_ERROR when repoRoot is not absolute", async () => {
    const result = await runJsonCommandHarness({
      command: CheckCommand,
      toolName: "test_tool",
      argv: ["test"],
      repoRoot: "rel/path",
      successExitCodes: [0],
      parser: TEST_SCHEMA,
      schemaName: "TestSchema",
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error" && result.envelope.ok === false) {
      expect(result.envelope.error.code).toBe("INTERNAL_ERROR");
      expect(result.envelope.error.message).toContain("must be an absolute path");
    }
    expect(mockedRun).not.toHaveBeenCalled();
  });
});

// ============================================================================
// B. Exact runCommandInProcess call
// ============================================================================

describe("harness: forwards command/argv/cwd to runCommandInProcess", () => {
  it("passes through command class, argv (shallow-readonly), and cwd", async () => {
    mockedRun.mockResolvedValueOnce({ ...BASE_RESULT, stdoutBytes: Buffer.from("hi", "utf8") });
    await runRawCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check", "--json", "--since", "x"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0],
    });
    expect(mockedRun).toHaveBeenCalledTimes(1);
    const call = mockedRun.mock.calls[0];
    expect(call?.[0]).toBe(CheckCommand);
    expect(call?.[1]).toEqual(["check", "--json", "--since", "x"]);
    expect(call?.[2]).toEqual({ cwd: ABS_REPO_ROOT });
  });
});

// ============================================================================
// C. runCommandInProcess throws -> wrapped to INTERNAL_ERROR
// ============================================================================

describe("harness: wraps runCommandInProcess throw as INTERNAL_ERROR", () => {
  it("raw helper wraps thrown error", async () => {
    mockedRun.mockRejectedValueOnce(new Error("synthetic boom"));
    const result = await runRawCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0],
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error" && result.envelope.ok === false) {
      expect(result.envelope.error.code).toBe("INTERNAL_ERROR");
      expect(result.envelope.error.message).toContain("synthetic boom");
      expect(result.envelope.error.message).toContain("tool command threw");
    }
  });

  it("json helper wraps thrown error (same path through raw)", async () => {
    mockedRun.mockRejectedValueOnce(new Error("boom 2"));
    const result = await runJsonCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0],
      parser: TEST_SCHEMA,
      schemaName: "TestSchema",
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error" && result.envelope.ok === false) {
      expect(result.envelope.error.message).toContain("boom 2");
    }
  });
});

// ============================================================================
// D. stdoutTruncated:true -> MCP_COMMAND_OUTPUT_TOO_LARGE
// ============================================================================

describe("harness: stdoutTruncated fail-fast (D99.W + R26)", () => {
  it("raw helper returns MCP_COMMAND_OUTPUT_TOO_LARGE with stdoutBytesOmitted", async () => {
    mockedRun.mockResolvedValueOnce({
      ...BASE_RESULT,
      stdoutBytes: Buffer.from("partial"),
      stdoutTruncated: true,
      stdoutBytesOmitted: 12345,
    });
    const result = await runRawCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0],
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error" && result.envelope.ok === false) {
      expect(result.envelope.error.code).toBe("MCP_COMMAND_OUTPUT_TOO_LARGE");
      expect(result.envelope.error.message).toMatch(/8 MiB|narrower/);
      expect(result.envelope.error.details).toEqual({ stdoutBytesOmitted: 12345 });
    }
  });

  it("json helper returns MCP_COMMAND_OUTPUT_TOO_LARGE BEFORE attempting to parse", async () => {
    // Even when truncated bytes happen to be valid JSON, the helper must
    // NOT attempt to parse (R26).
    mockedRun.mockResolvedValueOnce({
      ...BASE_RESULT,
      stdoutBytes: Buffer.from('{"ok":true}', "utf8"),
      stdoutTruncated: true,
      stdoutBytesOmitted: 1024,
    });
    const result = await runJsonCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0],
      parser: TEST_SCHEMA,
      schemaName: "TestSchema",
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error" && result.envelope.ok === false) {
      expect(result.envelope.error.code).toBe("MCP_COMMAND_OUTPUT_TOO_LARGE");
    }
  });
});

// ============================================================================
// E. Exit 1 -> sanitized stderr (or fallback)
// ============================================================================

describe("harness: exit 1 -> INTERNAL_ERROR with sanitized stderr", () => {
  it("uses sanitized stderr when present", async () => {
    mockedRun.mockResolvedValueOnce({
      ...BASE_RESULT,
      exitCode: 1,
      stderrText: "Validation error\nwith newline and  multiple   spaces\n",
    });
    const result = await runRawCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0],
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error" && result.envelope.ok === false) {
      expect(result.envelope.error.code).toBe("INTERNAL_ERROR");
      expect(result.envelope.error.message).toContain("Validation error");
      expect(result.envelope.error.message).not.toMatch(/\n/);
      expect(result.envelope.error.message).not.toMatch(/\s\s/);
    }
  });

  it("uses fallback when stderr is empty", async () => {
    mockedRun.mockResolvedValueOnce({ ...BASE_RESULT, exitCode: 1, stderrText: "" });
    const result = await runRawCommandHarness({
      command: CheckCommand,
      toolName: "my_tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0],
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error" && result.envelope.ok === false) {
      expect(result.envelope.error.message).toBe("my_tool command failed");
    }
  });

  it("caps sanitized stderr at 512 chars", async () => {
    mockedRun.mockResolvedValueOnce({
      ...BASE_RESULT,
      exitCode: 1,
      stderrText: "x".repeat(2000),
    });
    const result = await runRawCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0],
    });
    if (result.kind === "error" && result.envelope.ok === false) {
      expect(result.envelope.error.message.length).toBeLessThanOrEqual(512);
      expect(result.envelope.error.message).toMatch(/truncated/);
    }
  });
});

// ============================================================================
// F. Unexpected exit code
// ============================================================================

describe("harness: unexpected exit code", () => {
  it("returns INTERNAL_ERROR with expected-list when exit code is not in successExitCodes", async () => {
    mockedRun.mockResolvedValueOnce({ ...BASE_RESULT, exitCode: 3 });
    const result = await runRawCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0, 2],
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error" && result.envelope.ok === false) {
      expect(result.envelope.error.code).toBe("INTERNAL_ERROR");
      expect(result.envelope.error.message).toContain("unexpected exit code 3");
      expect(result.envelope.error.message).toContain("expected one of: 0, 2");
    }
  });

  it("respects multi-code successExitCodes (e.g., [0, 2] for check_repo)", async () => {
    // Exit 0 -> success
    mockedRun.mockResolvedValueOnce({ ...BASE_RESULT, exitCode: 0 });
    const r0 = await runRawCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0, 2],
    });
    expect(r0.kind).toBe("success");

    // Exit 2 -> success
    mockedRun.mockResolvedValueOnce({ ...BASE_RESULT, exitCode: 2 });
    const r2 = await runRawCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0, 2],
    });
    expect(r2.kind).toBe("success");
    if (r2.kind === "success") {
      expect(r2.exitCode).toBe(2);
    }
  });
});

// ============================================================================
// G. Raw success
// ============================================================================

describe("harness: raw success returns decoded stdout", () => {
  it("decodes stdoutBytes as UTF-8 and returns stderr metadata", async () => {
    mockedRun.mockResolvedValueOnce({
      ...BASE_RESULT,
      exitCode: 0,
      stdoutBytes: Buffer.from("hello world", "utf8"),
      stderrText: "info",
      stderrTruncated: false,
      stderrBytesOmitted: 0,
    });
    const result = await runRawCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0],
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.stdoutText).toBe("hello world");
      expect(result.exitCode).toBe(0);
      expect(result.stderrText).toBe("info");
      expect(result.stderrTruncated).toBe(false);
      expect(result.stderrBytesOmitted).toBe(0);
    }
  });
});

// ============================================================================
// H. JSON success
// ============================================================================

describe("harness: JSON success returns parsed value", () => {
  it("JSON-parses + schema-validates stdout, returns parsed", async () => {
    mockedRun.mockResolvedValueOnce({
      ...BASE_RESULT,
      stdoutBytes: Buffer.from('{"ok":true}', "utf8"),
    });
    const result = await runJsonCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0],
      parser: TEST_SCHEMA,
      schemaName: "TestSchema",
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.parsed).toEqual({ ok: true });
      expect(result.stdoutText).toBe('{"ok":true}');
    }
  });
});

// ============================================================================
// I. JSON parse failure
// ============================================================================

describe("harness: invalid JSON -> INTERNAL_ERROR", () => {
  it("returns INTERNAL_ERROR with 'not valid JSON' message", async () => {
    mockedRun.mockResolvedValueOnce({
      ...BASE_RESULT,
      stdoutBytes: Buffer.from("not json", "utf8"),
    });
    const result = await runJsonCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0],
      parser: TEST_SCHEMA,
      schemaName: "TestSchema",
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error" && result.envelope.ok === false) {
      expect(result.envelope.error.code).toBe("INTERNAL_ERROR");
      expect(result.envelope.error.message).toMatch(/not valid JSON/);
    }
  });
});

// ============================================================================
// J. Schema-invalid JSON
// ============================================================================

describe("harness: schema-invalid JSON -> INTERNAL_ERROR", () => {
  it("returns INTERNAL_ERROR with schemaName in message", async () => {
    mockedRun.mockResolvedValueOnce({
      ...BASE_RESULT,
      stdoutBytes: Buffer.from('{"wrong":"shape"}', "utf8"),
    });
    const result = await runJsonCommandHarness({
      command: CheckCommand,
      toolName: "tool",
      argv: ["check"],
      repoRoot: ABS_REPO_ROOT,
      successExitCodes: [0],
      parser: TEST_SCHEMA,
      schemaName: "TestSchema",
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error" && result.envelope.ok === false) {
      expect(result.envelope.error.code).toBe("INTERNAL_ERROR");
      expect(result.envelope.error.message).toContain("TestSchema");
      expect(result.envelope.error.details).toBeUndefined();
    }
  });
});

// ============================================================================
// K. truncateUtf8Text
// ============================================================================

describe("truncateUtf8Text", () => {
  it("returns unchanged when text fits within cap", () => {
    const r = truncateUtf8Text("hello", 100);
    expect(r.text).toBe("hello");
    expect(r.truncated).toBe(false);
    expect(r.bytesOmitted).toBe(0);
  });

  it("truncates to cap when text is too long (ASCII path)", () => {
    const r = truncateUtf8Text("x".repeat(100), 10);
    expect(r.text).toBe("x".repeat(10));
    expect(r.truncated).toBe(true);
    expect(r.bytesOmitted).toBe(90);
  });

  it("backs off to UTF-8 char boundary (no severed multi-byte sequence)", () => {
    // U+1F600 (grinning face) is 4 bytes in UTF-8: F0 9F 98 80.
    // A cap that falls inside the sequence should back off to the
    // start of that character.
    const emoji = "\u{1F600}".repeat(5); // 20 bytes
    const r = truncateUtf8Text(emoji, 6); // cap inside the second emoji (bytes 4-7)
    // After backoff, we land at end of the first emoji (4 bytes).
    expect(r.text).toBe("\u{1F600}");
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(10);
    expect(r.bytesOmitted).toBe(20 - Buffer.byteLength(r.text, "utf8"));
  });

  it("handles cap exactly at a char boundary (no backoff needed)", () => {
    const text = "abcdef"; // 6 ASCII bytes
    const r = truncateUtf8Text(text, 3);
    expect(r.text).toBe("abc");
    expect(r.truncated).toBe(true);
    expect(r.bytesOmitted).toBe(3);
  });

  it("handles 2-byte UTF-8 sequences (U+00E9, 2-byte UTF-8)", () => {
    // U+00E9 is 2 bytes: C3 A9
    const text = "a\u00E9b\u00E9c"; // a + U+00E9 + b + U+00E9 + c = 7 bytes
    const r = truncateUtf8Text(text, 2); // cap inside the first multi-byte
    // After backoff, we land at end of "a" (1 byte).
    expect(r.text).toBe("a");
    expect(r.truncated).toBe(true);
  });

  it("does not throw on empty string", () => {
    const r = truncateUtf8Text("", 100);
    expect(r.text).toBe("");
    expect(r.truncated).toBe(false);
  });

  it("does not throw on cap=0", () => {
    const r = truncateUtf8Text("abc", 0);
    expect(r.text).toBe("");
    expect(r.truncated).toBe(true);
    expect(r.bytesOmitted).toBe(3);
  });
});
