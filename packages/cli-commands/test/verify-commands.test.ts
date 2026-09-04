// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// verify-commands.ts targeted tests.
//
// These spawn real child processes using `process.execPath`: the guaranteed
// native executable of the interpreter already running the suite. NOT the name
// `node`, which running under Node does not guarantee is on PATH. The resolver
// accepts a fully qualified absolute path through its direct-path branch, so
// `process.execPath` needs no PATH entry at all.
//
// NOT covered, and deliberately: the stdio contract. Vitest's own stdin is
// already not a TTY, so a regression from `["ignore", "inherit", "inherit"]`
// back to `"inherit"` would not change any observable behavior here, and a test
// implying otherwise would be worse than none.

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runVerificationCommands } from "../src/verify-commands.js";

/** Exit with `code`, doing nothing else. */
const exitWith = (code: number) => ({
  command: process.execPath,
  args: ["-e", `process.exit(${code})`],
});

/** Exit 0 after writing `name` in the process cwd, so execution is observable. */
const touchThenPass = (name: string) => ({
  command: process.execPath,
  args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(name)}, "x")`],
});

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "viberevert-verifycmd-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe("runVerificationCommands", () => {
  it("reports an empty configuration as passing without running anything", async () => {
    await withTempDir(async (cwd) => {
      const result = await runVerificationCommands({ commands: [], cwd });

      expect(result.runs).toEqual([]);
      expect(result.allPassed).toBe(true);
    });
  });

  it("runs every command in order when they all pass", async () => {
    await withTempDir(async (cwd) => {
      const commands = [touchThenPass("first"), touchThenPass("second")];

      const result = await runVerificationCommands({ commands, cwd });

      expect(result.allPassed).toBe(true);
      expect(result.runs.map((run) => run.result)).toEqual([
        { outcome: "exited", exitCode: 0 },
        { outcome: "exited", exitCode: 0 },
      ]);
      // Both actually executed, and in the CALLER's cwd rather than the suite's:
      // the marker files landed where they were told to.
      expect(await exists(join(cwd, "first"))).toBe(true);
      expect(await exists(join(cwd, "second"))).toBe(true);
      expect(await readFile(join(cwd, "first"), "utf8")).toBe("x");
    });
  });

  it("records a nonzero exit as a RESULT, preserving the exact status", async () => {
    await withTempDir(async (cwd) => {
      const result = await runVerificationCommands({ commands: [exitWith(3)], cwd });

      // The project's command answering "no" is the answer, not a malfunction,
      // so it returns rather than throwing. The transaction records this as a
      // completed execution carrying a failing result.
      expect(result.allPassed).toBe(false);
      expect(result.runs[0]?.result).toEqual({ outcome: "exited", exitCode: 3 });
    });
  });

  it("stops at the first failure and does not execute later commands", async () => {
    await withTempDir(async (cwd) => {
      const commands = [exitWith(1), touchThenPass("should-not-exist")];

      const result = await runVerificationCommands({ commands, cwd });

      expect(result.allPassed).toBe(false);
      expect(result.runs[1]?.result).toEqual({
        outcome: "not_run",
        reason: "earlier_command_did_not_pass",
      });
      // The decisive assertion: `not_run` means NOT RUN, not merely unreported.
      expect(await exists(join(cwd, "should-not-exist"))).toBe(false);
    });
  });

  it("records skipped commands rather than truncating the list", async () => {
    await withTempDir(async (cwd) => {
      const commands = [exitWith(0), exitWith(2), exitWith(0), exitWith(0)];

      const result = await runVerificationCommands({ commands, cwd });

      // One entry per CONFIGURED command, so a receipt renders the whole list.
      expect(result.runs).toHaveLength(4);
      expect(result.runs.map((run) => run.result.outcome)).toEqual([
        "exited",
        "exited",
        "not_run",
        "not_run",
      ]);
    });
  });

  it("reports an unresolvable command without spawning, and does not continue", async () => {
    await withTempDir(async (cwd) => {
      const commands = [
        { command: "viberevert-definitely-not-on-path-xyzzy", args: [] },
        touchThenPass("after-unresolved"),
      ];

      const result = await runVerificationCommands({ commands, cwd });

      expect(result.allPassed).toBe(false);
      expect(result.runs[0]?.result).toEqual({ outcome: "unresolved" });
      // Unresolvable is a configuration fact, so it is a result rather than a
      // throw, and it stops the run like any other non-passing outcome.
      expect(result.runs[1]?.result.outcome).toBe("not_run");
      expect(await exists(join(cwd, "after-unresolved"))).toBe(false);
    });
  });

  it("echoes each configured command verbatim alongside its result", async () => {
    await withTempDir(async (cwd) => {
      const command = exitWith(0);

      const result = await runVerificationCommands({ commands: [command], cwd });

      // A receipt renders what the user asked for, not a normalized rewrite.
      expect(result.runs[0]?.command).toEqual(command);
    });
  });

  it("REJECTS when a resolved native target cannot be spawned", async () => {
    await withTempDir(async (dir) => {
      // Resolution succeeds, since `process.execPath` exists. The spawn itself
      // then fails on the missing working directory. That is infrastructure
      // failure, not the command answering, so it must not become a result: the
      // transaction records `execution.failed` and still acquires the
      // post-command observation.
      await expect(
        runVerificationCommands({
          commands: [exitWith(0)],
          cwd: join(dir, "no-such-directory"),
        }),
      ).rejects.toThrow();
    });
  });

  it.skipIf(process.platform !== "win32")(
    "refuses a resolved .cmd target without spawning it",
    async () => {
      await withTempDir(async (cwd) => {
        // An absolute path, so it resolves through the direct-path branch with
        // no PATH manipulation. If it were ever executed it would leave a
        // marker, which is what makes "without spawning" checkable.
        const shim = join(cwd, "fake.cmd");
        await writeFile(shim, "@echo off\r\necho ran > executed.txt\r\n", "utf8");

        const result = await runVerificationCommands({
          commands: [{ command: shim, args: [] }],
          cwd,
        });

        expect(result.allPassed).toBe(false);
        expect(result.runs[0]?.result).toEqual({
          outcome: "unsupported_target",
          resolvedTarget: shim,
          kind: "cmd-shim",
        });
        // Decision 7 is open, so a .cmd shim is refused rather than mediated
        // through cmd.exe. Refused means never launched.
        expect(await exists(join(cwd, "executed.txt"))).toBe(false);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "records a signalled command distinctly from an exit status",
    async () => {
      await withTempDir(async (cwd) => {
        const commands = [
          { command: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGTERM')"] },
        ];

        const result = await runVerificationCommands({ commands, cwd });

        // A killed command has no exit code, and reporting one would invent a
        // status the process never returned.
        expect(result.allPassed).toBe(false);
        expect(result.runs[0]?.result).toEqual({ outcome: "signalled", signal: "SIGTERM" });
      });
    },
  );
});
