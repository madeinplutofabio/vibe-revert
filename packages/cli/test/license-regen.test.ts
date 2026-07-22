// packages/cli/test/license-regen.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Tests for the extracted regen mechanics (scripts/regen-license-audit-core.ts) against
// os.tmpdir() fixtures, with an injected stub generator so the file mechanics are
// isolated from the collect/build/render pipeline. Covers: write creates the output and
// leaves no temp; write replaces an existing regular file; trailing-newline termination
// (added when absent, existing preserved, never collapsed); non-regular and symlinked
// targets refused; generation failure never writes; --check exact-match, drift (no
// write), missing, and symlinked-output refusal; direct writeAtomically mechanics
// (creation, temp==output and cross-directory rejection, exclusive-create refusal of a
// pre-existing temp, temp cleanup on rename failure); readExistingOutput byte fidelity;
// and POSIX mode (fresh report 0o644 not 0o600, existing mode preserved), skipped on
// Windows.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type GenerateFn,
  readExistingOutput,
  runRegen,
  writeAtomically,
} from "../../../scripts/regen-license-audit-core.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
  created.length = 0;
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "license-regen-"));
  created.push(dir);
  return dir;
}

function paths(dir: string): { outputPath: string; tempPath: string } {
  return {
    outputPath: join(dir, "LICENSE-AUDIT.md"),
    tempPath: join(dir, ".LICENSE-AUDIT.md.tmp"),
  };
}

function gen(markdown: string, summary = "1 row"): GenerateFn {
  return () => ({ ok: true, markdown, summary });
}

const genFail: GenerateFn = () => ({ ok: false, errors: [{ code: "TEST_FAIL", message: "boom" }] });

describe("runRegen — write mode", () => {
  it("creates the output with the rendered bytes and leaves no temp", () => {
    const dir = tmpDir();
    const { outputPath, tempPath } = paths(dir);
    expect(runRegen({ outputPath, tempPath, check: false, generate: gen("hello") }).kind).toBe(
      "wrote",
    );
    expect(readFileSync(outputPath, "utf8")).toBe("hello\n");
    expect(existsSync(tempPath)).toBe(false);
  });

  it("replaces an existing regular file", () => {
    const dir = tmpDir();
    const { outputPath, tempPath } = paths(dir);
    writeFileSync(outputPath, "old contents\n");
    expect(runRegen({ outputPath, tempPath, check: false, generate: gen("new") }).kind).toBe(
      "wrote",
    );
    expect(readFileSync(outputPath, "utf8")).toBe("new\n");
  });

  it("adds a trailing newline when absent and preserves existing trailing newlines", () => {
    const dir = tmpDir();
    const { outputPath, tempPath } = paths(dir);
    runRegen({ outputPath, tempPath, check: false, generate: gen("missing") });
    expect(readFileSync(outputPath, "utf8")).toBe("missing\n");
    runRegen({ outputPath, tempPath, check: false, generate: gen("already\n\n") });
    expect(readFileSync(outputPath, "utf8")).toBe("already\n\n");
  });

  it("refuses a non-regular target (directory) without writing", () => {
    const dir = tmpDir();
    const { outputPath, tempPath } = paths(dir);
    mkdirSync(outputPath);
    const outcome = runRegen({ outputPath, tempPath, check: false, generate: gen("x") });
    expect(outcome.kind).toBe("write-refused");
    if (outcome.kind === "write-refused") {
      expect(outcome.reason).toBe("not-regular");
    }
    expect(existsSync(tempPath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked target and leaves it untouched",
    () => {
      const dir = tmpDir();
      const { outputPath, tempPath } = paths(dir);
      const victim = join(dir, "victim.md");
      writeFileSync(victim, "victim\n");
      symlinkSync(victim, outputPath);
      expect(runRegen({ outputPath, tempPath, check: false, generate: gen("x") }).kind).toBe(
        "write-refused",
      );
      expect(readFileSync(victim, "utf8")).toBe("victim\n");
    },
  );

  it("reports a generation failure without writing", () => {
    const dir = tmpDir();
    const { outputPath, tempPath } = paths(dir);
    expect(runRegen({ outputPath, tempPath, check: false, generate: genFail }).kind).toBe(
      "generation-failed",
    );
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(tempPath)).toBe(false);
  });
});

describe("runRegen — check mode", () => {
  it("succeeds when the committed bytes match exactly", () => {
    const dir = tmpDir();
    const { outputPath, tempPath } = paths(dir);
    writeFileSync(outputPath, "report\n");
    expect(runRegen({ outputPath, tempPath, check: true, generate: gen("report") }).kind).toBe(
      "up-to-date",
    );
  });

  it("reports drift when the committed bytes differ, without writing", () => {
    const dir = tmpDir();
    const { outputPath, tempPath } = paths(dir);
    writeFileSync(outputPath, "stale\n");
    const outcome = runRegen({ outputPath, tempPath, check: true, generate: gen("fresh") });
    expect(outcome.kind).toBe("drift");
    if (outcome.kind === "drift") {
      expect(outcome.committedBytes).toBe("stale\n".length);
      expect(outcome.regeneratedBytes).toBe("fresh\n".length);
    }
    expect(readFileSync(outputPath, "utf8")).toBe("stale\n");
    expect(existsSync(tempPath)).toBe(false);
  });

  it("reports a missing output", () => {
    const dir = tmpDir();
    const { outputPath, tempPath } = paths(dir);
    const outcome = runRegen({ outputPath, tempPath, check: true, generate: gen("x") });
    expect(outcome.kind).toBe("check-read-failed");
    if (outcome.kind === "check-read-failed") {
      expect(outcome.reason).toBe("missing");
    }
  });

  it.skipIf(process.platform === "win32")("refuses to read a symlinked output", () => {
    const dir = tmpDir();
    const { outputPath, tempPath } = paths(dir);
    const victim = join(dir, "victim.md");
    writeFileSync(victim, "x\n");
    symlinkSync(victim, outputPath);
    const outcome = runRegen({ outputPath, tempPath, check: true, generate: gen("x") });
    expect(outcome.kind).toBe("check-read-failed");
    if (outcome.kind === "check-read-failed") {
      expect(outcome.reason).toBe("not-regular");
    }
  });
});

describe("writeAtomically — direct mechanics", () => {
  it("creates the file and leaves no temp", () => {
    const dir = tmpDir();
    const { outputPath, tempPath } = paths(dir);
    expect(writeAtomically(outputPath, tempPath, Buffer.from("data")).ok).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toBe("data");
    expect(existsSync(tempPath)).toBe(false);
  });

  it("rejects a temp path equal to the output path", () => {
    const dir = tmpDir();
    const p = join(dir, "LICENSE-AUDIT.md");
    const r = writeAtomically(p, p, Buffer.from("x"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("must differ");
    }
  });

  it("rejects a temp path in a different directory", () => {
    const dir = tmpDir();
    const r = writeAtomically(
      join(dir, "LICENSE-AUDIT.md"),
      join(dir, "sub", ".tmp"),
      Buffer.from("x"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("output directory");
    }
  });

  it("refuses to clobber a pre-existing temp file", () => {
    const dir = tmpDir();
    const { outputPath, tempPath } = paths(dir);
    writeFileSync(tempPath, "stray temp");
    const r = writeAtomically(outputPath, tempPath, Buffer.from("new report"));
    expect(r.ok).toBe(false);
    expect(readFileSync(tempPath, "utf8")).toBe("stray temp");
    expect(existsSync(outputPath)).toBe(false);
  });

  it("cleans up its temp when the rename fails", () => {
    const dir = tmpDir();
    const outputPath = join(dir, "target");
    mkdirSync(outputPath);
    const tempPath = join(dir, ".tmp");
    expect(writeAtomically(outputPath, tempPath, Buffer.from("data")).ok).toBe(false);
    expect(existsSync(tempPath)).toBe(false);
  });
});

describe("readExistingOutput — direct mechanics", () => {
  it("returns the exact bytes of a regular file", () => {
    const dir = tmpDir();
    const { outputPath } = paths(dir);
    writeFileSync(outputPath, "abc\n");
    const r = readExistingOutput(outputPath);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes.toString("utf8")).toBe("abc\n");
    }
  });
});

describe("POSIX permission modes", () => {
  it.skipIf(process.platform === "win32")("gives a fresh report mode 0o644, not 0o600", () => {
    const dir = tmpDir();
    const { outputPath, tempPath } = paths(dir);
    runRegen({ outputPath, tempPath, check: false, generate: gen("x") });
    expect(statSync(outputPath).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === "win32")(
    "preserves an existing report's mode across regeneration",
    () => {
      const dir = tmpDir();
      const { outputPath, tempPath } = paths(dir);
      writeFileSync(outputPath, "old\n");
      chmodSync(outputPath, 0o640);
      runRegen({ outputPath, tempPath, check: false, generate: gen("new") });
      expect(statSync(outputPath).mode & 0o777).toBe(0o640);
      expect(readFileSync(outputPath, "utf8")).toBe("new\n");
    },
  );
});
