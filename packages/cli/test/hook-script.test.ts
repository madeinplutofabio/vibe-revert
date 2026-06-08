// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BACKUP_FILE_PREFIX,
  BACKUP_FILE_REGEX,
  formatBackupTimestamp,
  HOOK_SCRIPT_TEMPLATE,
  MANAGED_BY_MARKER,
} from "../src/hook-script.js";

describe("hook-script constants and helpers (M F D98.G/H/U)", () => {
  describe("MANAGED_BY_MARKER", () => {
    it("is the locked literal", () => {
      expect(MANAGED_BY_MARKER).toBe(
        "# managed-by: viberevert (https://github.com/madeinplutofabio/vibe-revert)",
      );
    });

    it("does NOT embed a version number (D98.G version-free invariant)", () => {
      // Forward-compat: hook uninstall in v0.7.5 must recognize hooks installed
      // by v0.7.0. If a maintainer accidentally bakes the version into the
      // marker, this assertion catches it.
      expect(MANAGED_BY_MARKER).not.toMatch(/v?\d+\.\d+\.\d+/);
    });
  });

  describe("BACKUP_FILE_PREFIX", () => {
    it("is the locked basename literal", () => {
      expect(BACKUP_FILE_PREFIX).toBe("pre-commit.viberevert-backup-");
    });

    it("contains no path separator (D98.H basename-only invariant)", () => {
      // Install joins with hooksDir; uninstall scans readdir basenames.
      // A path component here would break uninstall's filter match.
      expect(BACKUP_FILE_PREFIX).not.toMatch(/[/\\]/);
    });
  });

  describe("BACKUP_FILE_REGEX", () => {
    it("matches the canonical timestamp format", () => {
      expect(BACKUP_FILE_REGEX.test("pre-commit.viberevert-backup-20260606T120000Z")).toBe(true);
    });

    it("rejects suffix-injection names (D98.H strict-pattern lock)", () => {
      // The whole point of the strict regex: prevent a malicious or
      // accidentally-named file from being picked as "latest" backup.
      expect(BACKUP_FILE_REGEX.test("pre-commit.viberevert-backup-z-danger")).toBe(false);
    });

    it("rejects partial timestamps", () => {
      expect(BACKUP_FILE_REGEX.test("pre-commit.viberevert-backup-2026")).toBe(false);
      expect(BACKUP_FILE_REGEX.test("pre-commit.viberevert-backup-20260606")).toBe(false);
      expect(BACKUP_FILE_REGEX.test("pre-commit.viberevert-backup-20260606T120000")).toBe(false);
    });

    it("rejects names with trailing extra characters", () => {
      expect(BACKUP_FILE_REGEX.test("pre-commit.viberevert-backup-20260606T120000Z.bak")).toBe(
        false,
      );
      expect(BACKUP_FILE_REGEX.test("pre-commit.viberevert-backup-20260606T120000Zextra")).toBe(
        false,
      );
    });

    it("rejects names with wrong separator characters", () => {
      // Lower-case "t" instead of "T".
      expect(BACKUP_FILE_REGEX.test("pre-commit.viberevert-backup-20260606t120000Z")).toBe(false);
    });

    it("rejects names with prefix injection (must match from start)", () => {
      expect(BACKUP_FILE_REGEX.test("prefix-pre-commit.viberevert-backup-20260606T120000Z")).toBe(
        false,
      );
    });
  });

  describe("formatBackupTimestamp", () => {
    it("produces YYYYMMDDTHHMMSSZ for a known UTC date", () => {
      const fixed = new Date("2026-06-08T15:49:25.000Z");
      expect(formatBackupTimestamp(fixed)).toBe("20260608T154925Z");
    });

    it("zero-pads month, day, hour, minute, second", () => {
      const fixed = new Date("2026-01-02T03:04:05.000Z");
      expect(formatBackupTimestamp(fixed)).toBe("20260102T030405Z");
    });

    it("is deterministic for identical inputs", () => {
      const a = new Date("2026-06-08T15:49:25.000Z");
      const b = new Date("2026-06-08T15:49:25.000Z");
      expect(formatBackupTimestamp(a)).toBe(formatBackupTimestamp(b));
    });

    it("uses UTC, not local time", () => {
      // Same instant regardless of process TZ.
      const fixed = new Date(Date.UTC(2026, 5, 8, 15, 49, 25));
      expect(formatBackupTimestamp(fixed)).toBe("20260608T154925Z");
    });

    it("output always matches BACKUP_FILE_REGEX when joined with BACKUP_FILE_PREFIX", () => {
      const dates = [
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-06-08T15:49:25.000Z"),
        new Date("2099-12-31T23:59:59.000Z"),
      ];
      for (const d of dates) {
        const basename = `${BACKUP_FILE_PREFIX}${formatBackupTimestamp(d)}`;
        expect(BACKUP_FILE_REGEX.test(basename)).toBe(true);
      }
    });
  });

  describe("HOOK_SCRIPT_TEMPLATE byte-level invariants", () => {
    it("is ASCII-only (every byte < 128)", () => {
      const bytes = Buffer.from(HOOK_SCRIPT_TEMPLATE, "utf8");
      for (const byte of bytes) {
        expect(byte).toBeLessThan(128);
      }
    });

    it("contains NO CR character anywhere (LF-only by construction per D98.M.14)", () => {
      expect(HOOK_SCRIPT_TEMPLATE.indexOf("\r")).toBe(-1);
    });

    it("ends with exactly one trailing LF", () => {
      expect(HOOK_SCRIPT_TEMPLATE.endsWith("\n")).toBe(true);
      expect(HOOK_SCRIPT_TEMPLATE.endsWith("\n\n")).toBe(false);
    });

    it("does NOT contain `set -e` anywhere (D98.U regression guard)", () => {
      // set -e would short-circuit before EC=$? captures the exit code,
      // breaking the conditional tip-print branch. This assertion catches a
      // future maintainer who "hardens" the script with set -e.
      expect(HOOK_SCRIPT_TEMPLATE).not.toContain("set -e");
    });
  });

  describe("HOOK_SCRIPT_TEMPLATE structural invariants", () => {
    // Tests probe structure by splitting the public HOOK_SCRIPT_TEMPLATE.
    // HOOK_SCRIPT_LINES is module-private; only the joined template is exported.
    const lines = HOOK_SCRIPT_TEMPLATE.split("\n");

    it("line 1 is the POSIX sh shebang", () => {
      expect(lines[0]).toBe("#!/bin/sh");
    });

    it("line 2 is exactly MANAGED_BY_MARKER (D98.A11 marker placement)", () => {
      expect(lines[1]).toBe(MANAGED_BY_MARKER);
    });

    it("contains the locked check invocation", () => {
      expect(HOOK_SCRIPT_TEMPLATE).toContain("viberevert check --staged");
    });

    it("documents `git commit --no-verify` in the comment block (D98.L)", () => {
      expect(HOOK_SCRIPT_TEMPLATE).toContain("git commit --no-verify");
    });

    it("documents `viberevert hook uninstall` in the comment block", () => {
      expect(HOOK_SCRIPT_TEMPLATE).toContain("viberevert hook uninstall");
    });

    it("contains the prompt-fix suggestion in the tip text", () => {
      expect(HOOK_SCRIPT_TEMPLATE).toContain("viberevert prompt-fix");
    });

    it('uses quoted "$EC" for sh-flavor portability (D98.U)', () => {
      expect(HOOK_SCRIPT_TEMPLATE).toContain('[ "$EC" -eq 2 ]');
      expect(HOOK_SCRIPT_TEMPLATE).toContain('exit "$EC"');
    });

    it("captures the exit code via EC=$? before the conditional", () => {
      // Without this capture, the if-branch can never fire (the previous
      // command's exit status would be lost). Belt-and-suspenders against
      // the no-set-e + EC-capture combination drifting.
      const checkLineIdx = lines.indexOf("viberevert check --staged");
      expect(checkLineIdx).toBeGreaterThanOrEqual(0);
      expect(lines[checkLineIdx + 1]).toBe("EC=$?");
    });

    it("renders the tip line EXACTLY (the backslash-backtick escape is the easiest regression site)", () => {
      // This is the literal shell-source line, byte for byte. If a future
      // maintainer "simplifies" the TS source escapes and changes what gets
      // emitted, this assertion fires immediately. The expected shell source:
      //   <2-space-indent>echo "Tip: run \`viberevert prompt-fix\` to generate a fix-prompt for your coding agent." >&2
      // where each \` is the POSIX-sh escape for a literal backtick inside a
      // double-quoted string (sh would otherwise treat backticks as command
      // substitution).
      const expectedTipLine =
        '  echo "Tip: run \\`viberevert prompt-fix\\` to generate a fix-prompt for your coding agent." >&2';
      expect(lines).toContain(expectedTipLine);
    });

    it("renders the locked exit-2 branch as a contiguous block", () => {
      // The if/echo/echo/exit/fi sequence -- asserted as a contiguous substring
      // of the full template so a future reorder breaks loudly.
      const expectedBranch = [
        'if [ "$EC" -eq 2 ]; then',
        '  echo "" >&2',
        '  echo "Tip: run \\`viberevert prompt-fix\\` to generate a fix-prompt for your coding agent." >&2',
        "  exit 1",
        "fi",
      ].join("\n");
      expect(HOOK_SCRIPT_TEMPLATE).toContain(expectedBranch);
    });

    it('ends with `exit "$EC"` (passthrough for non-2 exit codes)', () => {
      // Last non-empty line.
      const nonEmpty = lines.filter((line) => line.length > 0);
      expect(nonEmpty[nonEmpty.length - 1]).toBe('exit "$EC"');
    });
  });
});
