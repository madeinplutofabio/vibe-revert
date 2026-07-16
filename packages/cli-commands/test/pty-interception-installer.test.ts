// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4e-i: installBashInterception orchestration. Every dependency is a
// configurable fake; the tests prove the two-phase gate ordering, the fail-closed
// taxonomy + down-mapping, the exact cleanup subset + order per failure, the
// bound-once/read-once/snapshot-isolation hostile-dependency defenses, and the
// re-entrancy-safe disposer -- all without real net/fs/spawn.

import { describe, expect, it } from "vitest";

import type { CommandPolicyDecision, CommandsPolicyConfig } from "../src/command-guard.js";
import {
  createInstalledInterceptionHandle,
  type InterceptionChannelRef,
  type InterceptionInstallFailureReason,
} from "../src/commands/pty-interception.js";
import type { AuditAcceptedCommand } from "../src/commands/pty-interception-audit.js";
import {
  type BashInterceptionInstallFailureCause,
  type InstallBashInterceptionDeps,
  installBashInterception,
  publicReasonFor,
} from "../src/commands/pty-interception-installer.js";
import type { InterceptionService } from "../src/commands/pty-interception-service.js";
import { resolveInterceptionShellSupport } from "../src/commands/pty-interception-shell-support.js";
import type { LoopbackInterceptionTransport } from "../src/commands/pty-interception-transport.js";
import type { ShellKind } from "../src/commands/shell-resolver.js";

/** A writable, index-signature-free view for mutating the deps container in tests. */
type MutableDeps = { -readonly [K in keyof InstallBashInterceptionDeps]: unknown };

interface Rec {
  calls: Map<string, number>;
  cleanup: { closeTransport: number; stopService: number; cleanupMaterialized: number };
  diagnostics: BashInterceptionInstallFailureCause[];
  hookNonce: string | undefined;
  serviceSessionNonce: string | undefined;
  serviceCommandsPolicy: CommandsPolicyConfig | undefined;
  serviceEvaluate: unknown;
  serviceAudit: unknown;
  serviceRecordFailure: unknown;
  serviceTransport: unknown;
  handleFields: unknown;
}

/** A fresh set of all-succeeding fakes, plus a recorder + the underlying resources. */
function makeDeps(overrides: Partial<Record<keyof InstallBashInterceptionDeps, unknown>> = {}) {
  const rec: Rec = {
    calls: new Map(),
    cleanup: { closeTransport: 0, stopService: 0, cleanupMaterialized: 0 },
    diagnostics: [],
    hookNonce: undefined,
    serviceSessionNonce: undefined,
    serviceCommandsPolicy: undefined,
    serviceEvaluate: undefined,
    serviceAudit: undefined,
    serviceRecordFailure: undefined,
    serviceTransport: undefined,
    handleFields: undefined,
  };
  const bump = (key: string): void => {
    rec.calls.set(key, (rec.calls.get(key) ?? 0) + 1);
  };

  const transport = {
    accept: async () => null,
    close: async () => {
      rec.cleanup.closeTransport += 1;
    },
  };
  const channel: InterceptionChannelRef = { endpoint: "127.0.0.1:54321" };
  const loopback = { transport, channel };
  const service = {
    done: Promise.resolve(),
    stop: async () => {
      rec.cleanup.stopService += 1;
    },
  };
  const materialized = {
    rcPath: "/tmp/vr/hook.rc",
    cleanup: async () => {
      rec.cleanup.cleanupMaterialized += 1;
    },
  };

  const commandsPolicy = {} as CommandsPolicyConfig;
  const evaluateCommandPolicy = (
    _argv: readonly string[],
    _policy: CommandsPolicyConfig | undefined,
  ): CommandPolicyDecision => {
    bump("evaluateCommandPolicy");
    return { kind: "allow" } as CommandPolicyDecision;
  };
  const auditAcceptedCommand: AuditAcceptedCommand = async () => ({ ok: true });
  const recordAuditGateFailure = (): void => undefined;

  const base: InstallBashInterceptionDeps = {
    shell: { path: "/usr/bin/bash", kind: "bash" as ShellKind },
    commandsPolicy,
    evaluateCommandPolicy,
    auditAcceptedCommand,
    recordAuditGateFailure,
    generateNonce: () => {
      bump("generateNonce");
      return "noncenonce";
    },
    createTransport: async () => {
      bump("createTransport");
      return loopback as unknown as LoopbackInterceptionTransport;
    },
    generateHook: (params) => {
      bump("generateHook");
      rec.hookNonce = params.nonce;
      return "#!/usr/bin/env bash\ntrue\n";
    },
    createService: async (t, d) => {
      bump("createService");
      rec.serviceTransport = t;
      rec.serviceSessionNonce = d.sessionNonce;
      rec.serviceCommandsPolicy = d.commandsPolicy;
      rec.serviceEvaluate = d.evaluateCommandPolicy;
      rec.serviceAudit = d.auditAcceptedCommand;
      rec.serviceRecordFailure = d.recordAuditGateFailure;
      return service as unknown as InterceptionService;
    },
    materializeHook: async () => {
      bump("materializeHook");
      return materialized;
    },
    createHandle: (fields) => {
      bump("createHandle");
      rec.handleFields = fields;
      return createInstalledInterceptionHandle(fields);
    },
    reportDiagnostic: (d) => {
      rec.diagnostics.push(d.cause);
    },
  };

  const deps = { ...base, ...overrides } as InstallBashInterceptionDeps;
  return {
    deps,
    rec,
    resources: {
      transport,
      channel,
      service,
      materialized,
      commandsPolicy,
      evaluateCommandPolicy,
      auditAcceptedCommand,
      recordAuditGateFailure,
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function track<T>(promise: Promise<T>): { settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

describe("installBashInterception — happy path", () => {
  it("returns a branded handle carrying the guarded bash startup + a disposer", async () => {
    const { deps, rec } = makeDeps();
    const result = await installBashInterception(deps);

    expect(result.kind).toBe("installed");
    if (result.kind !== "installed") {
      return;
    }
    expect(result.handle.shellKind).toBe("bash");
    expect(result.handle.channel).toEqual({ endpoint: "127.0.0.1:54321" });
    expect(result.handle.shellStartup).toEqual({
      shellKind: "bash",
      executable: "/usr/bin/bash",
      args: ["--noprofile", "--rcfile", "/tmp/vr/hook.rc", "-i"],
    });
    expect(typeof result.dispose).toBe("function");
    expect(rec.calls.get("createHandle")).toBe(1);
  });
});

describe("installBashInterception — capability gate is authoritative + first", () => {
  it("refuses a powershell shell, preserving the exact 4c refusal message", async () => {
    const { deps } = makeDeps({
      shell: { path: "/usr/bin/pwsh", kind: "powershell" as ShellKind },
    });
    const result = await installBashInterception(deps);
    const gate = resolveInterceptionShellSupport("powershell" as ShellKind);
    if (gate.kind !== "refused") {
      throw new Error("expected the resolver to refuse powershell");
    }
    expect(result).toEqual({
      kind: "install_failed",
      reason: "unsupported_shell",
      message: gate.message,
    });
  });

  it("a future/unknown string kind fails closed as unsupported_shell", async () => {
    const { deps } = makeDeps({ shell: { path: "/bin/zsh", kind: "zsh" as ShellKind } });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "unsupported_shell" });
  });

  it("reads shell.kind once but never shell.path or any non-shell dependency getter", async () => {
    let kindReads = 0;
    let hits = 0;
    const throwGetter = (): never => {
      hits += 1;
      throw new Error("must not be read for an unsupported shell");
    };
    const deps = {
      shell: {
        get kind(): string {
          kindReads += 1;
          return "powershell";
        },
        get path(): string {
          hits += 1;
          throw new Error("path must not be read");
        },
      },
    } as unknown as InstallBashInterceptionDeps;
    for (const key of [
      "commandsPolicy",
      "evaluateCommandPolicy",
      "generateNonce",
      "createTransport",
      "generateHook",
      "createService",
      "materializeHook",
      "createHandle",
      "reportDiagnostic",
    ] as const) {
      Object.defineProperty(deps, key, { configurable: true, get: throwGetter });
    }

    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "unsupported_shell" });
    expect(kindReads).toBe(1);
    expect(hits).toBe(0);
  });

  it("reads supported shell.kind and shell.path exactly once", async () => {
    let kindReads = 0;
    let pathReads = 0;
    const { deps } = makeDeps({
      shell: {
        get kind(): ShellKind {
          kindReads += 1;
          return "bash" as ShellKind;
        },
        get path(): string {
          pathReads += 1;
          return "/usr/bin/bash";
        },
      },
    });

    const result = await installBashInterception(deps);
    expect(result.kind).toBe("installed");
    expect(kindReads).toBe(1);
    expect(pathReads).toBe(1);
  });
});

describe("installBashInterception — dependency snapshot is fail-closed (channel_setup_failed, no diagnostics)", () => {
  function expectDependencyRefusal(
    result: Awaited<ReturnType<typeof installBashInterception>>,
  ): void {
    expect(result).toEqual({
      kind: "install_failed",
      reason: "channel_setup_failed",
      message: expect.stringContaining("could not establish the private interception channel"),
    });
  }

  it("null shell", async () => {
    const { deps, rec } = makeDeps({ shell: null });
    const result = await installBashInterception(deps);
    expectDependencyRefusal(result);
    expect(rec.calls.get("createTransport")).toBeUndefined();
    expect(rec.diagnostics).toEqual([]);
  });

  it("non-string kind", async () => {
    const { deps } = makeDeps({ shell: { path: "/usr/bin/bash", kind: 123 } });
    expectDependencyRefusal(await installBashInterception(deps));
  });

  it.each(["", "   "])("blank/whitespace executable %j", async (path) => {
    const { deps, rec } = makeDeps({ shell: { path, kind: "bash" as ShellKind } });
    expectDependencyRefusal(await installBashInterception(deps));
    expect(rec.calls.get("createTransport")).toBeUndefined();
  });

  it("throwing path getter on a supported shell", async () => {
    const { deps, rec } = makeDeps();
    Object.defineProperty(deps, "shell", {
      configurable: true,
      value: {
        kind: "bash",
        get path(): string {
          throw new Error("path getter");
        },
      },
    });
    expectDependencyRefusal(await installBashInterception(deps));
    expect(rec.calls.get("createTransport")).toBeUndefined();
  });

  it.each([
    "evaluateCommandPolicy",
    "generateNonce",
    "createTransport",
    "generateHook",
    "createService",
    "materializeHook",
    "createHandle",
    "auditAcceptedCommand",
    "recordAuditGateFailure",
  ] as const)("non-function %s", async (key) => {
    const { deps, rec } = makeDeps({ [key]: "not a function" });
    expectDependencyRefusal(await installBashInterception(deps));
    expect(rec.calls.get("createTransport")).toBeUndefined();
  });

  it.each([
    "commandsPolicy",
    "evaluateCommandPolicy",
    "generateNonce",
    "createTransport",
    "generateHook",
    "createService",
    "materializeHook",
    "createHandle",
    "auditAcceptedCommand",
    "recordAuditGateFailure",
    "reportDiagnostic",
  ] as const)("throwing getter on phase-2 dependency %s (supported bash)", async (key) => {
    const { deps, rec } = makeDeps();
    Object.defineProperty(deps, key, {
      configurable: true,
      get(): never {
        throw new Error(`getter:${key}`);
      },
    });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "channel_setup_failed" });
    expect(rec.calls.get("createTransport")).toBeUndefined();
    expect(rec.diagnostics).toEqual([]);
  });

  it("a non-function reportDiagnostic is treated as no sink and does NOT fail installation", async () => {
    const { deps } = makeDeps({ reportDiagnostic: "not a function" });
    const result = await installBashInterception(deps);
    expect(result.kind).toBe("installed");
  });
});

describe("installBashInterception — nonce", () => {
  it("a throwing generator -> nonce_setup_failed internally / channel publicly, no transport", async () => {
    const { deps, rec } = makeDeps({
      generateNonce: () => {
        throw new Error("boom");
      },
    });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "channel_setup_failed" });
    expect(rec.calls.get("createTransport")).toBeUndefined();
    expect(rec.diagnostics).toEqual(["nonce_setup_failed"]);
  });

  it.each([
    "",
    "   ",
    "a b",
    "a".repeat(257),
  ])("an invalid returned nonce %j -> channel_setup_failed, no transport", async (nonce) => {
    const { deps, rec } = makeDeps({ generateNonce: () => nonce });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "channel_setup_failed" });
    expect(rec.calls.get("createTransport")).toBeUndefined();
    expect(rec.diagnostics).toEqual(["nonce_setup_failed"]);
  });
});

describe("installBashInterception — acquisition failure maps to the right reason + cleanup subset", () => {
  it("transport throws -> channel_setup_failed, nothing cleaned", async () => {
    const { deps, rec } = makeDeps({
      createTransport: async () => {
        throw new Error("boom");
      },
    });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "channel_setup_failed" });
    expect(rec.cleanup).toEqual({ closeTransport: 0, stopService: 0, cleanupMaterialized: 0 });
  });

  it.each([
    [
      "throws",
      (): never => {
        throw new Error("boom");
      },
    ],
    ["returns non-string", (): string => 42 as unknown as string],
    ["returns blank", (): string => "   "],
  ] as const)("hook %s -> hook_setup_failed, transport closed only", async (_label, generateHook) => {
    const { deps, rec } = makeDeps({ generateHook });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "hook_setup_failed" });
    expect(rec.cleanup).toEqual({ closeTransport: 1, stopService: 0, cleanupMaterialized: 0 });
    expect(rec.diagnostics).toEqual(["hook_setup_failed"]);
  });

  it("service throws -> service_setup_failed, transport closed", async () => {
    const { deps, rec } = makeDeps({
      createService: async () => {
        throw new Error("boom");
      },
    });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "channel_setup_failed" });
    expect(rec.cleanup).toEqual({ closeTransport: 1, stopService: 0, cleanupMaterialized: 0 });
    expect(rec.diagnostics).toEqual(["service_setup_failed"]);
  });

  it("materialize throws -> materialization_failed, service stopped + transport closed", async () => {
    const { deps, rec } = makeDeps({
      materializeHook: async () => {
        throw new Error("boom");
      },
    });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "hook_setup_failed" });
    expect(rec.cleanup).toEqual({ closeTransport: 1, stopService: 1, cleanupMaterialized: 0 });
    expect(rec.diagnostics).toEqual(["materialization_failed"]);
  });

  it.each([
    [
      "throws",
      (): never => {
        throw new Error("boom");
      },
    ],
    ["returns non-object", (): undefined => undefined],
  ] as const)("handle factory %s -> handle_setup_failed, everything cleaned", async (_label, createHandle) => {
    const { deps, rec } = makeDeps({ createHandle });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "hook_setup_failed" });
    expect(rec.cleanup).toEqual({ closeTransport: 1, stopService: 1, cleanupMaterialized: 1 });
    expect(rec.diagnostics).toEqual(["handle_setup_failed"]);
  });
});

describe("installBashInterception — malformed resolved resources", () => {
  it("transport missing close -> channel_setup_failed, no cleanup exception", async () => {
    const { deps, rec } = makeDeps({
      createTransport: async () => ({ transport: {}, channel: { endpoint: "127.0.0.1:1" } }),
    });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "channel_setup_failed" });
    expect(rec.cleanup).toEqual({ closeTransport: 0, stopService: 0, cleanupMaterialized: 0 });
  });

  it("transport has live close but a blank endpoint -> that transport is closed", async () => {
    let closed = 0;
    const { deps } = makeDeps({
      createTransport: async () => ({
        transport: {
          accept: async () => null,
          close: async () => {
            closed += 1;
          },
        },
        channel: { endpoint: "   " },
      }),
    });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "channel_setup_failed" });
    expect(closed).toBe(1);
  });

  it("service missing stop -> service_setup_failed, transport closed", async () => {
    const { deps, rec } = makeDeps({ createService: async () => ({ done: Promise.resolve() }) });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "channel_setup_failed" });
    expect(rec.cleanup).toEqual({ closeTransport: 1, stopService: 0, cleanupMaterialized: 0 });
  });

  it("materialization missing cleanup -> materialization_failed, service stopped + transport closed", async () => {
    const { deps, rec } = makeDeps({ materializeHook: async () => ({ rcPath: "/tmp/x" }) });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "hook_setup_failed" });
    expect(rec.cleanup).toEqual({ closeTransport: 1, stopService: 1, cleanupMaterialized: 0 });
  });

  it("materialization has live cleanup but a blank rcPath -> service + transport + rc all cleaned", async () => {
    let cleaned = 0;
    const { deps, rec } = makeDeps({
      materializeHook: async () => ({
        rcPath: "   ",
        cleanup: async () => {
          cleaned += 1;
        },
      }),
    });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "hook_setup_failed" });
    expect(cleaned).toBe(1);
    expect(rec.cleanup.closeTransport).toBe(1);
    expect(rec.cleanup.stopService).toBe(1);
  });
});

describe("installBashInterception — service readiness boundary (B)", () => {
  it("does not materialize or stamp, and stays pending, until the service promise resolves", async () => {
    let resolveService!: (s: InterceptionService) => void;
    const gate = new Promise<InterceptionService>((resolve) => {
      resolveService = resolve;
    });
    const { deps, rec, resources } = makeDeps({
      createService: async () => {
        rec.calls.set("createService", (rec.calls.get("createService") ?? 0) + 1);
        return gate;
      },
    });

    const installPromise = installBashInterception(deps);
    const tracked = track(installPromise);
    await tick();
    expect(rec.calls.get("createService")).toBe(1);
    expect(rec.calls.get("materializeHook")).toBeUndefined();
    expect(rec.calls.get("createHandle")).toBeUndefined();
    expect(tracked.settled).toBe(false);

    resolveService(resources.service as unknown as InterceptionService);
    const result = await installPromise;
    expect(result.kind).toBe("installed");
    expect(rec.calls.get("materializeHook")).toBe(1);
  });

  it("a rejected readiness promise closes the transport and reports service_setup_failed", async () => {
    const { deps, rec } = makeDeps({
      createService: async () => {
        throw new Error("not ready");
      },
    });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "channel_setup_failed" });
    expect(rec.cleanup.closeTransport).toBe(1);
    expect(rec.diagnostics).toEqual(["service_setup_failed"]);
  });
});

describe("installBashInterception — taxonomy", () => {
  it.each<[BashInterceptionInstallFailureCause, InterceptionInstallFailureReason]>([
    ["unsupported_shell", "unsupported_shell"],
    ["dependency_setup_failed", "channel_setup_failed"],
    ["nonce_setup_failed", "channel_setup_failed"],
    ["channel_setup_failed", "channel_setup_failed"],
    ["service_setup_failed", "channel_setup_failed"],
    ["hook_setup_failed", "hook_setup_failed"],
    ["materialization_failed", "hook_setup_failed"],
    ["handle_setup_failed", "hook_setup_failed"],
  ])("publicReasonFor(%s) === %s", (cause, reason) => {
    expect(publicReasonFor(cause)).toBe(reason);
  });
});

describe("installBashInterception — snapshot / one-read / isolation", () => {
  it("the same generated nonce feeds the hook and the service sessionNonce", async () => {
    const { deps, rec } = makeDeps();
    await installBashInterception(deps);
    expect(rec.hookNonce).toBe("noncenonce");
    expect(rec.serviceSessionNonce).toBe("noncenonce");
    expect(rec.hookNonce).toBe(rec.serviceSessionNonce);
  });

  it("the created transport + the exact policy/evaluator/audit objects reach the service by identity", async () => {
    const { deps, rec, resources } = makeDeps();
    await installBashInterception(deps);
    expect(rec.serviceTransport).toBe(resources.transport);
    expect(rec.serviceCommandsPolicy).toBe(resources.commandsPolicy);
    expect(rec.serviceEvaluate).toBe(resources.evaluateCommandPolicy);
    // The installer is a pure threading layer for these session-owned callbacks;
    // it must not substitute or wrap them.
    expect(rec.serviceAudit).toBe(resources.auditAcceptedCommand);
    expect(rec.serviceRecordFailure).toBe(resources.recordAuditGateFailure);
  });

  it("reads the channel endpoint and the rc path exactly once each", async () => {
    let endpointReads = 0;
    let rcPathReads = 0;
    const { deps } = makeDeps({
      createTransport: async () => ({
        transport: { accept: async () => null, close: async () => {} },
        channel: {
          get endpoint(): string {
            endpointReads += 1;
            return "127.0.0.1:54321";
          },
        },
      }),
      materializeHook: async () => ({
        get rcPath(): string {
          rcPathReads += 1;
          return "/tmp/vr/hook.rc";
        },
        cleanup: async () => {},
      }),
    });
    const result = await installBashInterception(deps);
    expect(result.kind).toBe("installed");
    expect(endpointReads).toBe(1);
    expect(rcPathReads).toBe(1);
  });

  it("snapshots the validated endpoint before later mutation of the channel", async () => {
    const channel = { endpoint: "127.0.0.1:54321" };
    let hookEndpoint: string | undefined;
    const { deps } = makeDeps({
      createTransport: async () => ({
        transport: { accept: async () => null, close: async () => {} },
        channel,
      }),
      generateHook: (params: { nonce: string; endpoint: string }) => {
        hookEndpoint = params.endpoint;
        channel.endpoint = "evil:1";
        return "# hook\n";
      },
    });

    const result = await installBashInterception(deps);
    expect(result.kind).toBe("installed");
    expect(hookEndpoint).toBe("127.0.0.1:54321");
    if (result.kind === "installed") {
      expect(result.handle.channel.endpoint).toBe("127.0.0.1:54321");
    }
  });

  it("uses cleanup methods captured at acquisition despite later replacement of all three", async () => {
    const { deps, rec, resources } = makeDeps();
    const result = await installBashInterception(deps);
    expect(result.kind).toBe("installed");
    if (result.kind !== "installed") {
      return;
    }
    resources.service.stop = async () => {
      throw new Error("replacement stop must not run");
    };
    resources.transport.close = async () => {
      throw new Error("replacement close must not run");
    };
    resources.materialized.cleanup = async () => {
      throw new Error("replacement cleanup must not run");
    };

    await result.dispose();
    expect(rec.cleanup).toEqual({ closeTransport: 1, stopService: 1, cleanupMaterialized: 1 });
  });

  it("captures shell path, policy, evaluator, and callbacks BEFORE acquisition (mid-flight mutation ignored)", async () => {
    let resolveTransport!: (t: LoopbackInterceptionTransport) => void;
    const gate = new Promise<LoopbackInterceptionTransport>((resolve) => {
      resolveTransport = resolve;
    });
    const { deps, rec, resources } = makeDeps({ createTransport: async () => gate });
    const originalCreateService = deps.createService;
    const originalCreateHandle = deps.createHandle;

    const installPromise = installBashInterception(deps);
    const tracked = track(installPromise);
    await tick();
    expect(tracked.settled).toBe(false);

    // Mutate the container while createTransport is pending.
    const mutated = deps as unknown as MutableDeps;
    mutated.shell = { path: "/evil/bash", kind: "bash" };
    mutated.commandsPolicy = {} as CommandsPolicyConfig;
    mutated.evaluateCommandPolicy = () => ({ kind: "allow" }) as CommandPolicyDecision;
    let mutatedHookCalled = false;
    mutated.generateHook = () => {
      mutatedHookCalled = true;
      return "mutated";
    };
    let mutatedServiceCalled = false;
    mutated.createService = async (t: unknown, d: unknown) => {
      mutatedServiceCalled = true;
      return (originalCreateService as InstallBashInterceptionDeps["createService"])(
        t as never,
        d as never,
      );
    };
    let mutatedHandleCalled = false;
    mutated.createHandle = (f: unknown) => {
      mutatedHandleCalled = true;
      return (originalCreateHandle as InstallBashInterceptionDeps["createHandle"])(f as never);
    };

    resolveTransport({
      transport: resources.transport,
      channel: resources.channel,
    } as unknown as LoopbackInterceptionTransport);
    const result = await installPromise;

    expect(result.kind).toBe("installed");
    if (result.kind === "installed") {
      expect(result.handle.shellStartup.executable).toBe("/usr/bin/bash");
    }
    expect(mutatedHookCalled).toBe(false);
    expect(mutatedServiceCalled).toBe(false);
    expect(mutatedHandleCalled).toBe(false);
    expect(rec.serviceCommandsPolicy).toBe(resources.commandsPolicy);
    expect(rec.serviceEvaluate).toBe(resources.evaluateCommandPolicy);
  });
});

describe("installBashInterception — disposer", () => {
  it("tears down in service -> transport -> rc order and continues after rejection", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      createService: async () => ({
        done: Promise.resolve(),
        stop: async () => {
          order.push("service");
          throw new Error("stop rejects");
        },
      }),
      createTransport: async () => ({
        transport: {
          accept: async () => null,
          close: async () => {
            order.push("transport");
          },
        },
        channel: { endpoint: "127.0.0.1:5" },
      }),
      materializeHook: async () => ({
        rcPath: "/tmp/x",
        cleanup: async () => {
          order.push("rc");
        },
      }),
      createHandle: () => {
        throw new Error("force rollback");
      },
    });
    const result = await installBashInterception(deps);
    expect(result.kind).toBe("install_failed");
    expect(order).toEqual(["service", "transport", "rc"]);
  });

  it("successful-install dispose never rejects and continues after cleanup failures", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      createService: async () => ({
        done: Promise.resolve(),
        stop: async () => {
          order.push("service");
          throw new Error("stop rejects");
        },
      }),
      createTransport: async () => ({
        transport: {
          accept: async () => null,
          close: async () => {
            order.push("transport");
            throw new Error("close rejects");
          },
        },
        channel: { endpoint: "127.0.0.1:5" },
      }),
      materializeHook: async () => ({
        rcPath: "/tmp/x",
        cleanup: async () => {
          order.push("rc");
        },
      }),
    });
    const result = await installBashInterception(deps);
    expect(result.kind).toBe("installed");
    if (result.kind === "installed") {
      await expect(result.dispose()).resolves.toBeUndefined();
    }
    expect(order).toEqual(["service", "transport", "rc"]);
  });

  it("a cleanup that synchronously calls `void dispose()` still runs each cleanup exactly once", async () => {
    let stopCalls = 0;
    let closeCalls = 0;
    let disposeRef: (() => Promise<void>) | undefined;
    const { deps } = makeDeps({
      createService: async () => ({
        done: Promise.resolve(),
        stop: async () => {
          stopCalls += 1;
          if (disposeRef !== undefined) {
            void disposeRef();
          }
        },
      }),
      createTransport: async () => ({
        transport: {
          accept: async () => null,
          close: async () => {
            closeCalls += 1;
          },
        },
        channel: { endpoint: "127.0.0.1:5" },
      }),
    });
    const result = await installBashInterception(deps);
    expect(result.kind).toBe("installed");
    if (result.kind !== "installed") {
      return;
    }
    disposeRef = result.dispose;
    await result.dispose();
    expect(stopCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });

  it("dispose() is idempotent across concurrent + repeat calls and never rejects", async () => {
    const { deps, rec } = makeDeps();
    const result = await installBashInterception(deps);
    expect(result.kind).toBe("installed");
    if (result.kind !== "installed") {
      return;
    }
    await Promise.all([result.dispose(), result.dispose()]);
    await result.dispose();
    expect(rec.cleanup).toEqual({ closeTransport: 1, stopService: 1, cleanupMaterialized: 1 });
  });
});

describe("installBashInterception — diagnostics never leak or break", () => {
  it("a throwing reportDiagnostic does not change the result or break cleanup", async () => {
    const { deps, rec } = makeDeps({
      reportDiagnostic: () => {
        throw new Error("sink throws");
      },
      materializeHook: async () => {
        throw new Error("boom");
      },
    });
    const result = await installBashInterception(deps);
    expect(result).toMatchObject({ kind: "install_failed", reason: "hook_setup_failed" });
    expect(rec.cleanup).toEqual({ closeTransport: 1, stopService: 1, cleanupMaterialized: 0 });
  });
});
