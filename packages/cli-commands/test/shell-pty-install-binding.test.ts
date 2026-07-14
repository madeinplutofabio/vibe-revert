// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4e-iv-b: the real `installInterception` binding produced by
// createRunPtyShellDeps. Isolated in its own file so the vi.mock of the two
// installer factory modules does not touch the main shell-pty suite. Verifies
// BEHAVIOR + argument IDENTITY at both factory boundaries (not wrapper identity):
// the seam calls createBashInterceptionInstallerDeps(args) with the exact args
// object, then installBashInterception with the exact deps that factory produced.

import { describe, expect, it, vi } from "vitest";
import { installBashInterception } from "../src/commands/pty-interception-installer.js";
import { createBashInterceptionInstallerDeps } from "../src/commands/pty-interception-installer-bindings.js";
import { createRunPtyShellDeps } from "../src/commands/shell-pty.js";

vi.mock("../src/commands/pty-interception-installer-bindings.js", () => ({
  createBashInterceptionInstallerDeps: vi.fn(() => ({ marker: "deps" })),
}));

vi.mock("../src/commands/pty-interception-installer.js", () => ({
  installBashInterception: vi.fn(async () => ({
    kind: "install_failed",
    reason: "hook_setup_failed",
    message: "x",
  })),
}));

describe("createRunPtyShellDeps installInterception real binding (M G4 4e-iv-b)", () => {
  it("forwards the exact args to createBashInterceptionInstallerDeps, then installBashInterception with the produced deps", async () => {
    const deps = createRunPtyShellDeps(
      { stdin: {}, stdout: {}, stderr: { write() {} } },
      { cwd: "/repo", env: {} },
    );

    const args = {
      shell: { path: "/bin/bash", kind: "bash" as const },
      commandsPolicy: undefined,
    };
    await deps.installInterception(args);

    // Argument identity at the first factory: the seam passes the exact args object.
    expect(vi.mocked(createBashInterceptionInstallerDeps).mock.calls[0]?.[0]).toBe(args);

    // Deps identity at the second factory: installBashInterception receives the exact
    // object the first factory produced (not a structural copy).
    const producedDeps = vi.mocked(createBashInterceptionInstallerDeps).mock.results[0]?.value;
    expect(vi.mocked(installBashInterception).mock.calls[0]?.[0]).toBe(producedDeps);
  });
});
