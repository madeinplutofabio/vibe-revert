// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4e-ii: the hook materialization fs seam. Fake-fs unit suite covers
// composition/order/validation/failure-cleanup/idempotency; the POSIX real-fs
// suite (skipIf win32) proves actual 0700/0600 bits, absolute paths, exclusive/
// no-follow refusal (via a prepared directory), and removal on cleanup.

import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createMaterializeFs,
  type MaterializeFileHandle,
  type MaterializeFs,
  materializeBashHook,
} from "../src/commands/pty-interception-hook-materializer.js";

const ROOT = resolve(tmpdir(), "vr-unit-root");
const RC_PRELUDE = "PS1='viberevert$ '\nPROMPT_COMMAND=\n";
const NUL = String.fromCharCode(0);

interface FakeHandleControl {
  failChmod?: Error;
  failWrite?: Error;
  failClose?: Error;
}
interface FakeFsControl {
  mkdtempResult?: (prefix: string) => string;
  failMkdtemp?: Error;
  failChmodDir?: Error;
  failOpen?: Error;
  failUnlink?: Error;
  failRmdir?: Error;
  handle?: FakeHandleControl;
}

function makeFakeFs(control: FakeFsControl = {}) {
  const rec = {
    mkdtemp: [] as string[],
    chmodDir: [] as Array<{ dir: string; mode: number }>,
    openExclusive: [] as Array<{ file: string; mode: number }>,
    unlink: [] as string[],
    rmdir: [] as string[],
    handleChmod: [] as number[],
    closeCount: 0,
    written: undefined as string | undefined,
    order: [] as string[],
  };
  const fs: MaterializeFs = {
    mkdtemp: async (prefix) => {
      rec.mkdtemp.push(prefix);
      if (control.failMkdtemp) {
        throw control.failMkdtemp;
      }
      return (control.mkdtempResult ?? ((p) => `${p}abc123`))(prefix);
    },
    chmodDir: async (dir, mode) => {
      rec.chmodDir.push({ dir, mode });
      rec.order.push("chmodDir");
      if (control.failChmodDir) {
        throw control.failChmodDir;
      }
    },
    openExclusive: async (file, mode) => {
      rec.openExclusive.push({ file, mode });
      rec.order.push("open");
      if (control.failOpen) {
        throw control.failOpen;
      }
      const handle: MaterializeFileHandle = {
        chmod: async (m) => {
          rec.handleChmod.push(m);
          rec.order.push("handleChmod");
          if (control.handle?.failChmod) {
            throw control.handle.failChmod;
          }
        },
        writeFile: async (data) => {
          rec.written = data;
          rec.order.push("write");
          if (control.handle?.failWrite) {
            throw control.handle.failWrite;
          }
        },
        close: async () => {
          rec.closeCount += 1;
          rec.order.push("close");
          if (control.handle?.failClose) {
            throw control.handle.failClose;
          }
        },
      };
      return handle;
    },
    unlink: async (file) => {
      rec.order.push("unlink");
      rec.unlink.push(file);
      if (control.failUnlink) {
        throw control.failUnlink;
      }
    },
    rmdir: async (dir) => {
      rec.order.push("rmdir");
      rec.rmdir.push(dir);
      if (control.failRmdir) {
        throw control.failRmdir;
      }
    },
  };
  return { fs, rec };
}

describe("materializeBashHook — input validation", () => {
  it.each(["", "   "])("rejects a blank hookScript %j without touching the fs", async (hook) => {
    const { fs, rec } = makeFakeFs();
    await expect(materializeBashHook(hook, { tmpRoot: ROOT, fs })).rejects.toThrow();
    expect(rec.mkdtemp).toEqual([]);
  });

  it("rejects a NUL-containing hookScript", async () => {
    const { fs, rec } = makeFakeFs();
    await expect(materializeBashHook(`trap x${NUL}DEBUG`, { tmpRoot: ROOT, fs })).rejects.toThrow();
    expect(rec.mkdtemp).toEqual([]);
  });

  it.each([
    "relative/root",
    "   ",
    "",
  ])("rejects a non-absolute/blank tmpRoot %j", async (badRoot) => {
    const { fs, rec } = makeFakeFs();
    await expect(materializeBashHook("hook", { tmpRoot: badRoot, fs })).rejects.toThrow();
    expect(rec.mkdtemp).toEqual([]);
  });
});

describe("materializeBashHook — happy path (fake fs)", () => {
  it("writes RC_PRELUDE + hook byte-exact and returns an absolute rcPath", async () => {
    const hook = "trap 'x' DEBUG || exit 125"; // no trailing newline
    const { fs, rec } = makeFakeFs();
    const result = await materializeBashHook(hook, { tmpRoot: ROOT, fs });

    expect(isAbsolute(result.rcPath)).toBe(true);
    expect(basename(result.rcPath)).toBe("hook.rc");
    expect(dirname(result.rcPath)).toBe(resolve(`${join(ROOT, "viberevert-pty-")}abc123`));
    expect(rec.written).toBe(RC_PRELUDE + hook); // nothing trimmed, nothing appended
  });

  it("forces dir 0700 + file 0600 and orders chmodDir -> open -> chmod -> write -> close", async () => {
    const { fs, rec } = makeFakeFs();
    await materializeBashHook("hook", { tmpRoot: ROOT, fs });
    expect(rec.chmodDir[0]?.mode).toBe(0o700);
    expect(rec.openExclusive[0]?.mode).toBe(0o600);
    expect(rec.handleChmod).toEqual([0o600]);
    expect(rec.order).toEqual(["chmodDir", "open", "handleChmod", "write", "close"]);
  });
});

describe("materializeBashHook — mkdtemp return validation (injected seam)", () => {
  it.each([
    ["relative", () => "relative/dir"],
    ["the root itself", () => ROOT],
    ["a sibling", () => join(ROOT, "..", "sibling", "viberevert-pty-x")],
    ["the parent", () => join(ROOT, "..")],
    ["outside root", () => join(tmpdir(), "elsewhere", "viberevert-pty-x")],
    ["a wrong-prefix child", () => join(ROOT, "wrong-prefix-abc")],
    ["the bare prefix", () => join(ROOT, "viberevert-pty-")],
  ])("rejects when mkdtemp returns %s, touching no further fs op", async (_label, mkdtempResult) => {
    const { fs, rec } = makeFakeFs({ mkdtempResult });
    await expect(materializeBashHook("hook", { tmpRoot: ROOT, fs })).rejects.toThrow();
    expect(rec.chmodDir).toEqual([]);
    expect(rec.openExclusive).toEqual([]);
    expect(rec.unlink).toEqual([]);
    expect(rec.rmdir).toEqual([]);
  });
});

describe("materializeBashHook — failure-stage cleanup + order + original-error preservation", () => {
  it("mkdtemp fails -> no later fs operation, original error", async () => {
    const boom = new Error("mkdtemp boom");
    const { fs, rec } = makeFakeFs({ failMkdtemp: boom });
    await expect(materializeBashHook("hook", { tmpRoot: ROOT, fs })).rejects.toBe(boom);
    expect(rec.chmodDir).toEqual([]);
    expect(rec.openExclusive).toEqual([]);
    expect(rec.unlink).toEqual([]);
    expect(rec.rmdir).toEqual([]);
  });

  it("chmodDir fails -> rmdir only (dir created, file not owned), original error", async () => {
    const boom = new Error("chmod dir boom");
    const { fs, rec } = makeFakeFs({ failChmodDir: boom });
    await expect(materializeBashHook("hook", { tmpRoot: ROOT, fs })).rejects.toBe(boom);
    expect(rec.order).toEqual(["chmodDir", "rmdir"]);
  });

  it("openExclusive fails -> rmdir only, NO unlink (file not owned), original error", async () => {
    const boom = new Error("EEXIST");
    const { fs, rec } = makeFakeFs({ failOpen: boom });
    await expect(materializeBashHook("hook", { tmpRoot: ROOT, fs })).rejects.toBe(boom);
    expect(rec.order).toEqual(["chmodDir", "open", "rmdir"]);
  });

  it("handle.chmod fails -> close + unlink + rmdir (file owned), original error", async () => {
    const boom = new Error("file chmod boom");
    const { fs, rec } = makeFakeFs({ handle: { failChmod: boom } });
    await expect(materializeBashHook("hook", { tmpRoot: ROOT, fs })).rejects.toBe(boom);
    expect(rec.order).toEqual(["chmodDir", "open", "handleChmod", "close", "unlink", "rmdir"]);
  });

  it("handle.writeFile fails -> close + unlink + rmdir, original error", async () => {
    const boom = new Error("write boom");
    const { fs, rec } = makeFakeFs({ handle: { failWrite: boom } });
    await expect(materializeBashHook("hook", { tmpRoot: ROOT, fs })).rejects.toBe(boom);
    expect(rec.order).toEqual([
      "chmodDir",
      "open",
      "handleChmod",
      "write",
      "close",
      "unlink",
      "rmdir",
    ]);
  });

  it("handle.close fails -> a best-effort second close, then unlink + rmdir, original error", async () => {
    const boom = new Error("close boom");
    const { fs, rec } = makeFakeFs({ handle: { failClose: boom } });
    await expect(materializeBashHook("hook", { tmpRoot: ROOT, fs })).rejects.toBe(boom);
    expect(rec.order).toEqual([
      "chmodDir",
      "open",
      "handleChmod",
      "write",
      "close",
      "close",
      "unlink",
      "rmdir",
    ]);
    expect(rec.closeCount).toBe(2);
  });

  it("a cleanup failure during rollback does not replace the primary error", async () => {
    const boom = new Error("primary write boom");
    const { fs } = makeFakeFs({
      handle: { failWrite: boom },
      failUnlink: new Error("unlink also fails"),
      failRmdir: new Error("rmdir also fails"),
    });
    await expect(materializeBashHook("hook", { tmpRoot: ROOT, fs })).rejects.toBe(boom);
  });
});

describe("materializeBashHook — cleanup is once-only + best-effort", () => {
  it("memoizes: concurrent + repeat cleanup() run exactly one unlink + one rmdir, in order", async () => {
    const { fs, rec } = makeFakeFs();
    const result = await materializeBashHook("hook", { tmpRoot: ROOT, fs });
    await Promise.all([result.cleanup(), result.cleanup(), result.cleanup()]);
    await result.cleanup();
    expect(rec.unlink).toHaveLength(1);
    expect(rec.rmdir).toHaveLength(1);
    expect(rec.order.slice(-2)).toEqual(["unlink", "rmdir"]);
  });

  it("never rejects if unlink rejects; rmdir still runs", async () => {
    const { fs, rec } = makeFakeFs({ failUnlink: new Error("unlink boom") });
    const result = await materializeBashHook("hook", { tmpRoot: ROOT, fs });
    await expect(result.cleanup()).resolves.toBeUndefined();
    expect(rec.rmdir).toHaveLength(1);
  });

  it("never rejects if rmdir rejects", async () => {
    const { fs, rec } = makeFakeFs({ failRmdir: new Error("rmdir boom") });
    const result = await materializeBashHook("hook", { tmpRoot: ROOT, fs });
    await expect(result.cleanup()).resolves.toBeUndefined();
    expect(rec.unlink).toHaveLength(1);
    expect(rec.rmdir).toHaveLength(1);
    expect(rec.order.slice(-2)).toEqual(["unlink", "rmdir"]);
  });
});

describe.skipIf(process.platform === "win32")("materializeBashHook — POSIX real filesystem", () => {
  it("creates a 0700 dir + 0600 rc file with byte-exact content; cleanup removes file then dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "vr-mat-it-"));
    try {
      const hook = "trap 'x' DEBUG || exit 125";
      const result = await materializeBashHook(hook, { tmpRoot: root });
      expect(isAbsolute(result.rcPath)).toBe(true);
      const dir = dirname(result.rcPath);
      expect(dirname(dir)).toBe(root);
      expect(basename(result.rcPath)).toBe("hook.rc");

      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(result.rcPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(result.rcPath, "utf8")).toBe(RC_PRELUDE + hook);

      await result.cleanup();
      await expect(stat(result.rcPath)).rejects.toThrow();
      await expect(stat(dir)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["a pre-existing file", false],
    ["a pre-existing symlink", true],
  ])("refuses on %s and leaves it untouched (exclusive/no-follow)", async (_label, asSymlink) => {
    const root = await mkdtemp(join(tmpdir(), "vr-mat-it-"));
    const preparedDir = join(root, "viberevert-pty-fixture");
    await mkdir(preparedDir, { mode: 0o700 });
    const preExisting = join(preparedDir, "hook.rc");
    const target = join(root, "target.txt");
    await writeFile(target, "TARGET", { encoding: "utf8" });
    if (asSymlink) {
      await symlink(target, preExisting);
    } else {
      await writeFile(preExisting, "PRE-EXISTING", { encoding: "utf8" });
    }
    try {
      const fs: MaterializeFs = { ...createMaterializeFs(), mkdtemp: async () => preparedDir };
      await expect(materializeBashHook("hook", { tmpRoot: root, fs })).rejects.toThrow();

      if (asSymlink) {
        expect((await lstat(preExisting)).isSymbolicLink()).toBe(true);
        expect(await readFile(target, "utf8")).toBe("TARGET");
      } else {
        expect((await lstat(preExisting)).isFile()).toBe(true);
        expect(await readFile(preExisting, "utf8")).toBe("PRE-EXISTING");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
