// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4a (+ 4e-i extension): the interception CONTRACT is types + constants
// + the one branded handle factory. The factory now also validates + copies +
// freezes the spawn material it carries, so the tests below prove the runtime
// guards, the copy isolation, and the frozen shape -- not just the happy path.

import { describe, expect, it } from "vitest";

import {
  createInstalledInterceptionHandle,
  PTY_INTERCEPTION_DECISION_TIMEOUT_MS,
  PTY_INTERCEPTION_PROTOCOL_VERSION,
} from "../src/commands/pty-interception.js";

/** A fresh, fully-mutable valid input each call (so a test can mutate the original). */
type MutableFields = {
  shellKind: "bash";
  nonce: string;
  channel: { endpoint: string };
  shellStartup: { shellKind: "bash"; executable: string; args: string[] };
};

function makeFields(): MutableFields {
  return {
    shellKind: "bash",
    nonce: "nonce-abc",
    channel: { endpoint: "127.0.0.1:54321" },
    shellStartup: {
      shellKind: "bash",
      executable: "/usr/bin/bash",
      args: ["--noprofile", "--rcfile", "/tmp/vr-hook.rc", "-i"],
    },
  };
}

describe("pty-interception contract (M G4 Step 4a)", () => {
  it("pins the protocol version at 1", () => {
    expect(PTY_INTERCEPTION_PROTOCOL_VERSION).toBe(1);
  });

  it("uses a positive fail-closed decision timeout", () => {
    expect(PTY_INTERCEPTION_DECISION_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("stamps a well-formed, branded handle carrying the startup", () => {
    const handle = createInstalledInterceptionHandle(makeFields());

    expect(handle.shellKind).toBe("bash");
    expect(handle.nonce).toBe("nonce-abc");
    expect(handle.channel).toEqual({ endpoint: "127.0.0.1:54321" });
    expect(handle.shellStartup).toEqual({
      shellKind: "bash",
      executable: "/usr/bin/bash",
      args: ["--noprofile", "--rcfile", "/tmp/vr-hook.rc", "-i"],
    });

    // The brand is a real, private symbol property (honest runtime artifact);
    // the test never imports the symbol, only asserts its shape. `as unknown as`
    // is required: InstalledInterception has no symbol index signature (TS2352).
    const symbols = Object.getOwnPropertySymbols(handle);
    expect(symbols).toHaveLength(1);
    expect((handle as unknown as Record<symbol, unknown>)[symbols[0] as symbol]).toBe(true);
  });
});

describe("createInstalledInterceptionHandle — immutability + copy isolation", () => {
  it("freezes the handle, channel, startup payload, and args array", () => {
    const handle = createInstalledInterceptionHandle(makeFields());
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.isFrozen(handle.channel)).toBe(true);
    expect(Object.isFrozen(handle.shellStartup)).toBe(true);
    expect(Object.isFrozen(handle.shellStartup.args)).toBe(true);
  });

  it("mutating the original args array cannot alter the handle", () => {
    const fields = makeFields();
    const handle = createInstalledInterceptionHandle(fields);
    fields.shellStartup.args[2] = "/evil/path";
    fields.shellStartup.args.push("--evil");
    expect(handle.shellStartup.args).toEqual(["--noprofile", "--rcfile", "/tmp/vr-hook.rc", "-i"]);
  });

  it("mutating the original channel cannot alter the handle", () => {
    const fields = makeFields();
    const handle = createInstalledInterceptionHandle(fields);
    fields.channel.endpoint = "evil:1";
    expect(handle.channel.endpoint).toBe("127.0.0.1:54321");
  });

  it("mutating the original startup object cannot alter the handle", () => {
    const fields = makeFields();
    const handle = createInstalledInterceptionHandle(fields);
    fields.shellStartup.executable = "/evil/bash";
    expect(handle.shellStartup.executable).toBe("/usr/bin/bash");
  });
});

describe("createInstalledInterceptionHandle — runtime validation (all throw)", () => {
  it.each<[string, (f: MutableFields) => void]>([
    [
      "empty nonce",
      (f) => {
        f.nonce = "";
      },
    ],
    [
      "whitespace-only nonce",
      (f) => {
        f.nonce = "   ";
      },
    ],
    [
      "empty channel endpoint",
      (f) => {
        f.channel.endpoint = "";
      },
    ],
    [
      "whitespace-only channel endpoint",
      (f) => {
        f.channel.endpoint = "   ";
      },
    ],
    [
      "non-object startup (null)",
      (f) => {
        (f as { shellStartup: unknown }).shellStartup = null;
      },
    ],
    [
      "non-object startup (string)",
      (f) => {
        (f as { shellStartup: unknown }).shellStartup = "bash";
      },
    ],
    [
      "shellKind mismatch",
      (f) => {
        (f.shellStartup as { shellKind: string }).shellKind = "zsh";
      },
    ],
    [
      "empty executable",
      (f) => {
        f.shellStartup.executable = "";
      },
    ],
    [
      "whitespace-only executable",
      (f) => {
        f.shellStartup.executable = "   ";
      },
    ],
    [
      "reordered flags",
      (f) => {
        f.shellStartup.args = ["--rcfile", "--noprofile", "/tmp/vr-hook.rc", "-i"];
      },
    ],
    [
      "missing --noprofile",
      (f) => {
        f.shellStartup.args = ["--rcfile", "/tmp/vr-hook.rc", "-i"];
      },
    ],
    [
      "missing -i",
      (f) => {
        f.shellStartup.args = ["--noprofile", "--rcfile", "/tmp/vr-hook.rc"];
      },
    ],
    [
      "empty rc path",
      (f) => {
        f.shellStartup.args = ["--noprofile", "--rcfile", "", "-i"];
      },
    ],
    [
      "whitespace-only rc path",
      (f) => {
        f.shellStartup.args = ["--noprofile", "--rcfile", "   ", "-i"];
      },
    ],
    [
      "extra args",
      (f) => {
        f.shellStartup.args = ["--noprofile", "--rcfile", "/tmp/vr-hook.rc", "-i", "--evil"];
      },
    ],
  ])("throws on %s", (_label, mutate) => {
    const fields = makeFields();
    mutate(fields);
    expect(() => createInstalledInterceptionHandle(fields)).toThrow();
  });

  it("throws when args is not a real array (array-like object)", () => {
    const fields = makeFields();
    (fields.shellStartup as { args: unknown }).args = {
      0: "--noprofile",
      1: "--rcfile",
      2: "/tmp/vr-hook.rc",
      3: "-i",
      length: 4,
    };
    expect(() => createInstalledInterceptionHandle(fields)).toThrow();
  });

  it.each([
    null,
    undefined,
    "127.0.0.1:54321",
  ])("throws when channel is not a valid object: %p", (channel) => {
    const fields = makeFields();
    (fields as { channel: unknown }).channel = channel;
    expect(() => createInstalledInterceptionHandle(fields)).toThrow();
  });

  it("throws on a sparse args array (positional guard rejects holes)", () => {
    const fields = makeFields();
    const sparse: string[] = [];
    sparse[0] = "--noprofile";
    sparse[1] = "--rcfile";
    sparse[3] = "-i"; // index 2 left as a genuine hole; length becomes 4
    fields.shellStartup.args = sparse;
    expect(() => createInstalledInterceptionHandle(fields)).toThrow();
  });

  it("accepts the exact guarded startup shape without throwing", () => {
    expect(() => createInstalledInterceptionHandle(makeFields())).not.toThrow();
  });
});
