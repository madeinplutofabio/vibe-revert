// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Integration tests for InstallCommand's recovery-refusal paths:
// stale integrations.lock directory + pending integration-journal
// entry. These tests use REAL fixtures (no mocking of the installer
// engine) so they prove the CLI faithfully formats the engine's own
// IntegrationsLockError / PendingIntegrationRecoveryError as bracket-
// vocabulary [refused] lines and preserves the known-error discipline
// (empty stderr; no stack trace surface).
//
// Scope-locked per 6E: stale-lock + stale-journal ONLY. Other engine
// refusals (symlink, target-shape, drift, size) live in installer
// tests; the CLI's contract for those is identical (any InstallerError
// -> [refused: <name>: <err.name>: <err.message>]).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstallCommand } from "../src/commands/install.js";
import { runCommandInProcess } from "../src/run-command-in-process.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "viberevert-install-recovery-"));
  await mkdir(join(repoRoot, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

async function runInstall(...args: readonly string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const result = await runCommandInProcess(InstallCommand, ["install", ...args], {
    cwd: repoRoot,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdoutBytes.toString("utf8"),
    stderr: result.stderrText,
  };
}

describe("InstallCommand -- recovery refusal integration tests", () => {
  it("stale integrations.lock directory -> [refused: Cursor: IntegrationsLockError:] exit 1 + empty stderr", async () => {
    // Fixture: create the lock directory as if a prior installer
    // process crashed mid-transaction without releasing. The engine's
    // acquireLock() does an atomic mkdir on this exact path; the
    // pre-existing directory causes EEXIST, which the engine converts
    // to IntegrationsLockError. No pid.json is required inside the
    // lock dir -- the engine handles a missing/unreadable pid.json
    // gracefully as part of its diagnostics.
    await mkdir(join(repoRoot, ".viberevert", "integrations.lock"), { recursive: true });

    const { exitCode, stdout, stderr } = await runInstall("--cursor");

    expect(exitCode).toBe(1);
    // Bracket vocabulary + adapter name + error name (message body
    // is engine-owned; not asserted here to avoid duplicating
    // installer test locks).
    expect(stdout).toContain("[refused: Cursor: IntegrationsLockError:");
    // Known-error path: message flows through the CLI's known-error
    // formatter; no stack trace escapes to stderr.
    expect(stderr).toBe("");
  });

  it("pending journal entry -> [refused: Cursor: PendingIntegrationRecoveryError:] exit 1 + empty stderr", async () => {
    // Fixture: create a valid pending journal file as if a prior
    // installer process wrote the journal, mutated user files, then
    // crashed before commit. Engine's scanForPendingJournals reads
    // any UUID-named .json in .viberevert/integration-journal/ and
    // parses it against JournalEntrySchema; a valid pending entry
    // triggers PendingIntegrationRecoveryError to force manual
    // recovery before further mutation.
    //
    // No stale lock is present, so acquireLock succeeds; the pending
    // journal check runs immediately after and refuses.
    const journalDir = join(repoRoot, ".viberevert", "integration-journal");
    await mkdir(journalDir, { recursive: true });

    // UUID matching journal.ts JOURNAL_FILENAME_REGEX (v1..v5 shape:
    // 8-4-4-4-12 hex with variant/version nibbles). This is a
    // synthetic-but-schema-valid v4 UUID.
    const txnId = "12345678-1234-4123-8123-123456789012";
    const journalEntry = {
      txnId,
      recordKey: "cursor",
      adapterName: "Cursor",
      startedAt: "2026-07-02T18:00:00.000Z",
      command: "install",
      cliVersion: "0.7.0-beta.0",
      // Any phase is fine; "writing-files" is the phase a crashed
      // installer most commonly leaves behind (the safety net's
      // primary use case).
      phase: "writing-files",
      // Minimum-viable plannedOps -- PlannedJournalOpSchema for
      // write-new requires only kind + target; other kinds also
      // need blockId / jsonKeyPath (write-new is the terser fixture).
      plannedOps: [
        {
          kind: "write-new",
          target: {
            scope: "repo",
            pathTemplate: "{repo}/.cursor/mcp.json",
            pathRelative: ".cursor/mcp.json",
          },
        },
      ],
      recordedOps: [],
      backupPaths: [],
    };
    await writeFile(join(journalDir, `${txnId}.json`), JSON.stringify(journalEntry));

    const { exitCode, stdout, stderr } = await runInstall("--cursor");

    expect(exitCode).toBe(1);
    expect(stdout).toContain("[refused: Cursor: PendingIntegrationRecoveryError:");
    expect(stderr).toBe("");
  });
});
