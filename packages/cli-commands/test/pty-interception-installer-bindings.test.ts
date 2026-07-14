// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4e-iii: the real-bindings factory. The production suite pins direct-
// binding identity, frozen/copied shell (args discarded), policy/sink identity,
// and the real-crypto nonce. The helper suite (injected fakes) pins the
// deterministic nonce, capture-once semantics (all six bindings + the config
// args), delegation, and the createService readiness-wrapper behavior.

import { describe, expect, it } from "vitest";

import type { CommandsPolicyConfig } from "../src/command-guard.js";
import { evaluateCommandPolicy } from "../src/command-guard.js";
import { createInstalledInterceptionHandle } from "../src/commands/pty-interception.js";
import { generateBashInterceptionHook } from "../src/commands/pty-interception-hook.js";
import { materializeBashHook } from "../src/commands/pty-interception-hook-materializer.js";
import {
  type BashInterceptionInstallerBindings,
  type CreateBashInterceptionInstallerDepsArgs,
  createBashInterceptionInstallerDeps,
  createBashInterceptionInstallerDepsWithBindings,
} from "../src/commands/pty-interception-installer-bindings.js";
import type {
  InterceptionService,
  InterceptionServiceDeps,
  InterceptionServiceTransport,
} from "../src/commands/pty-interception-service.js";
import { createLoopbackInterceptionTransport } from "../src/commands/pty-interception-transport.js";
import type { ShellKind } from "../src/commands/shell-resolver.js";

type MutableBindings = {
  -readonly [K in keyof BashInterceptionInstallerBindings]: BashInterceptionInstallerBindings[K];
};

function makeArgs(
  overrides: Partial<CreateBashInterceptionInstallerDepsArgs> = {},
): CreateBashInterceptionInstallerDepsArgs {
  return {
    shell: { path: "/usr/bin/bash", kind: "bash" as ShellKind },
    commandsPolicy: undefined,
    ...overrides,
  };
}

/** A fake binding table (sentinel functions so identity + delegation are checkable). */
function makeBindings(overrides: Partial<BashInterceptionInstallerBindings> = {}) {
  const rec = { randomBytesSizes: [] as number[] };
  const bindings = {
    randomBytes: ((size: number) => {
      rec.randomBytesSizes.push(size);
      return Buffer.alloc(size, 7);
    }) as BashInterceptionInstallerBindings["randomBytes"],
    createTransport: (async () => ({})) as BashInterceptionInstallerBindings["createTransport"],
    generateHook: (() => "hook") as BashInterceptionInstallerBindings["generateHook"],
    createService: (() => ({})) as unknown as BashInterceptionInstallerBindings["createService"],
    materializeHook: (async () => ({
      rcPath: "/x",
      cleanup: async () => {},
    })) as BashInterceptionInstallerBindings["materializeHook"],
    createHandle: (() => ({})) as unknown as BashInterceptionInstallerBindings["createHandle"],
    ...overrides,
  } as BashInterceptionInstallerBindings;
  return { bindings, rec };
}

describe("createBashInterceptionInstallerDeps — production wiring", () => {
  it("wires the real primitives by identity (direct bindings)", () => {
    const deps = createBashInterceptionInstallerDeps(makeArgs());
    expect(deps.createTransport).toBe(createLoopbackInterceptionTransport);
    expect(deps.generateHook).toBe(generateBashInterceptionHook);
    expect(deps.materializeHook).toBe(materializeBashHook);
    expect(deps.createHandle).toBe(createInstalledInterceptionHandle);
    expect(deps.evaluateCommandPolicy).toBe(evaluateCommandPolicy);
  });

  it("freezes the deps object and the copied shell", () => {
    const deps = createBashInterceptionInstallerDeps(makeArgs());
    expect(Object.isFrozen(deps)).toBe(true);
    expect(Object.isFrozen(deps.shell)).toBe(true);
  });

  it("copies the shell to path+kind only, discarding a resolver args field", () => {
    const shellWithArgs = { path: "/usr/bin/bash", kind: "bash", args: ["-i"] };
    const deps = createBashInterceptionInstallerDeps({
      shell: shellWithArgs as CreateBashInterceptionInstallerDepsArgs["shell"],
      commandsPolicy: undefined,
    });
    expect("args" in deps.shell).toBe(false);
    expect(deps.shell).toEqual({ path: "/usr/bin/bash", kind: "bash" });
  });

  it("mutating the caller's shell object does not change the returned shell", () => {
    const callerShell = { path: "/usr/bin/bash", kind: "bash" as ShellKind };
    const deps = createBashInterceptionInstallerDeps(makeArgs({ shell: callerShell }));
    (callerShell as { path: string }).path = "/evil/bash";
    expect(deps.shell.path).toBe("/usr/bin/bash");
  });

  it("passes commandsPolicy through by identity, neither cloned nor frozen", () => {
    const policy = { guard: [] } as unknown as CommandsPolicyConfig;
    const deps = createBashInterceptionInstallerDeps(makeArgs({ commandsPolicy: policy }));
    expect(deps.commandsPolicy).toBe(policy);
    expect(Object.isFrozen(policy)).toBe(false);
  });

  it("omits reportDiagnostic when absent, and preserves it by identity when supplied", () => {
    const withoutSink = createBashInterceptionInstallerDeps(makeArgs());
    expect("reportDiagnostic" in withoutSink).toBe(false);

    const sink = () => {};
    const withSink = createBashInterceptionInstallerDeps(makeArgs({ reportDiagnostic: sink }));
    expect(withSink.reportDiagnostic).toBe(sink);
  });

  it("generateNonce uses real crypto: 32 base64url chars, unique across a batch", () => {
    const deps = createBashInterceptionInstallerDeps(makeArgs());
    const nonce = deps.generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const batch = new Set(Array.from({ length: 32 }, () => deps.generateNonce()));
    expect(batch.size).toBe(32); // smoke check for uniqueness, not a security proof
  });
});

describe("createBashInterceptionInstallerDepsWithBindings — injected seam", () => {
  it("builds the nonce from exactly one randomBytes(24) via base64url", () => {
    const { bindings, rec } = makeBindings();
    const deps = createBashInterceptionInstallerDepsWithBindings(makeArgs(), bindings);
    const nonce = deps.generateNonce();
    expect(rec.randomBytesSizes).toEqual([24]);
    expect(nonce).toBe(Buffer.alloc(24, 7).toString("base64url"));
  });

  it("delegates the direct bindings to the injected table by identity", () => {
    const { bindings } = makeBindings();
    const deps = createBashInterceptionInstallerDepsWithBindings(makeArgs(), bindings);
    expect(deps.createTransport).toBe(bindings.createTransport);
    expect(deps.generateHook).toBe(bindings.generateHook);
    expect(deps.materializeHook).toBe(bindings.materializeHook);
    expect(deps.createHandle).toBe(bindings.createHandle);
  });

  it("captures ALL six bindings once: mutating the table afterward re-targets nothing", async () => {
    let originalRandomBytesCalls = 0;
    let originalServiceCalls = 0;
    const originalCreateTransport =
      (async () => ({})) as BashInterceptionInstallerBindings["createTransport"];
    const originalGenerateHook = (() =>
      "orig-hook") as BashInterceptionInstallerBindings["generateHook"];
    const originalMaterializeHook = (async () => ({
      rcPath: "/orig",
      cleanup: async () => {},
    })) as BashInterceptionInstallerBindings["materializeHook"];
    const originalCreateHandle =
      (() => ({})) as unknown as BashInterceptionInstallerBindings["createHandle"];
    const originalService = { done: Promise.resolve(), stop: async () => {} };

    const bindings: BashInterceptionInstallerBindings = {
      randomBytes: ((size: number) => {
        originalRandomBytesCalls += 1;
        return Buffer.alloc(size, 1);
      }) as BashInterceptionInstallerBindings["randomBytes"],
      createTransport: originalCreateTransport,
      generateHook: originalGenerateHook,
      createService: (() => {
        originalServiceCalls += 1;
        return originalService;
      }) as BashInterceptionInstallerBindings["createService"],
      materializeHook: originalMaterializeHook,
      createHandle: originalCreateHandle,
    };

    const deps = createBashInterceptionInstallerDepsWithBindings(makeArgs(), bindings);

    // Mutate every property AFTER construction with distinct replacements + counters.
    let replacementRandomBytesCalls = 0;
    let replacementServiceCalls = 0;
    const mutable = bindings as MutableBindings;
    mutable.randomBytes = ((size: number) => {
      replacementRandomBytesCalls += 1;
      return Buffer.alloc(size, 2);
    }) as BashInterceptionInstallerBindings["randomBytes"];
    mutable.createTransport =
      (async () => ({})) as BashInterceptionInstallerBindings["createTransport"];
    mutable.generateHook = (() => "replaced") as BashInterceptionInstallerBindings["generateHook"];
    mutable.createService = (() => {
      replacementServiceCalls += 1;
      return { done: Promise.resolve(), stop: async () => {} };
    }) as BashInterceptionInstallerBindings["createService"];
    mutable.materializeHook = (async () => ({
      rcPath: "/replaced",
      cleanup: async () => {},
    })) as BashInterceptionInstallerBindings["materializeHook"];
    mutable.createHandle =
      (() => ({})) as unknown as BashInterceptionInstallerBindings["createHandle"];

    // Direct bindings still the ORIGINAL references.
    expect(deps.createTransport).toBe(originalCreateTransport);
    expect(deps.generateHook).toBe(originalGenerateHook);
    expect(deps.materializeHook).toBe(originalMaterializeHook);
    expect(deps.createHandle).toBe(originalCreateHandle);

    // generateNonce still calls the ORIGINAL randomBytes.
    deps.generateNonce();
    expect(originalRandomBytesCalls).toBe(1);
    expect(replacementRandomBytesCalls).toBe(0);

    // createService still invokes the ORIGINAL service factory.
    const service = await deps.createService(
      {} as InterceptionServiceTransport,
      {} as InterceptionServiceDeps,
    );
    expect(service).toBe(originalService as unknown as InterceptionService);
    expect(originalServiceCalls).toBe(1);
    expect(replacementServiceCalls).toBe(0);
  });

  it("reads args.shell once and snapshots its path and kind", () => {
    let reads = 0;
    const shell = { path: "/usr/bin/bash", kind: "bash" as ShellKind };
    const args = {
      get shell() {
        reads += 1;
        return shell;
      },
      commandsPolicy: undefined,
    } as CreateBashInterceptionInstallerDepsArgs;

    const { bindings } = makeBindings();
    const deps = createBashInterceptionInstallerDepsWithBindings(args, bindings);
    expect(reads).toBe(1);
    expect(deps.shell).toEqual({ path: "/usr/bin/bash", kind: "bash" });
  });

  it("reads reportDiagnostic once and preserves the captured sink", () => {
    let reads = 0;
    const sink = () => {};
    const args = makeArgs();
    Object.defineProperty(args, "reportDiagnostic", {
      configurable: true,
      get() {
        reads += 1;
        return sink;
      },
    });

    const { bindings } = makeBindings();
    const deps = createBashInterceptionInstallerDepsWithBindings(args, bindings);
    expect(reads).toBe(1);
    expect(deps.reportDiagnostic).toBe(sink);
  });

  it("createService: wraps a sync return in a fulfilled promise with the same object + pass-through", async () => {
    const sentinelService = { done: Promise.resolve(), stop: async () => {} };
    let seenTransport: unknown;
    let seenDeps: unknown;
    const { bindings } = makeBindings({
      createService: ((transport: unknown, serviceDeps: unknown) => {
        seenTransport = transport;
        seenDeps = serviceDeps;
        return sentinelService;
      }) as BashInterceptionInstallerBindings["createService"],
    });
    const deps = createBashInterceptionInstallerDepsWithBindings(makeArgs(), bindings);

    const transport = {} as InterceptionServiceTransport;
    const serviceDeps = {} as InterceptionServiceDeps;
    const result = await deps.createService(transport, serviceDeps);
    expect(result).toBe(sentinelService as unknown as InterceptionService);
    expect(seenTransport).toBe(transport);
    expect(seenDeps).toBe(serviceDeps);
  });

  it("createService: converts a synchronous throw into a rejected promise", async () => {
    const boom = new Error("not ready");
    const { bindings } = makeBindings({
      createService: (() => {
        throw boom;
      }) as BashInterceptionInstallerBindings["createService"],
    });
    const deps = createBashInterceptionInstallerDepsWithBindings(makeArgs(), bindings);
    await expect(
      deps.createService({} as InterceptionServiceTransport, {} as InterceptionServiceDeps),
    ).rejects.toBe(boom);
  });
});
