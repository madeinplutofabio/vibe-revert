// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigSchema,
  ConfigValidationError,
  loadConfig,
} from "../src/index.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "viberevert-config-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeConfig(yaml: string): Promise<void> {
  await writeFile(join(tmpRoot, ".viberevert.yml"), yaml);
}

describe("ConfigSchema (parse-only, no I/O)", () => {
  it("accepts the minimal valid config (just version)", () => {
    expect(ConfigSchema.parse({ version: 1 })).toEqual({ version: 1 });
  });

  it("rejects wrong version literal", () => {
    expect(() => ConfigSchema.parse({ version: 2 })).toThrow();
  });

  it("rejects missing version", () => {
    expect(() => ConfigSchema.parse({})).toThrow();
  });

  it("accepts a sparse config with only some optional fields", () => {
    const v = {
      version: 1,
      profile: "laravel",
      project: { name: "wallafan" },
    };
    expect(ConfigSchema.parse(v)).toEqual(v);
  });

  it("accepts a comprehensive config", () => {
    const v = {
      version: 1,
      profile: "laravel",
      project: { name: "wallafan", type: "web-app" },
      risk: { block_on: "critical", warn_on: "medium" },
      frameworks: ["laravel", "node"],
      checks: {
        secrets: true,
        dependencies: true,
        migrations: true,
        auth: true,
        payments: true,
        infra: true,
        tests: true,
        scope_expansion: false,
      },
      policies: ["basic/web-app", "basic/secrets"],
      rollback: {
        enabled: true,
        include_untracked: true,
        exclude: ["node_modules/**", "vendor/**"],
      },
      commands: {
        guard: ["rm -rf /"],
        require_confirm: ["php artisan migrate"],
      },
      verify: {
        commands: [
          { command: "pnpm", args: ["typecheck"] },
          { command: "pnpm", args: ["test"] },
        ],
      },
      llm: { enabled: false },
    };
    expect(ConfigSchema.parse(v)).toEqual(v);
  });

  it("accepts open-string profile (not enforced as enum)", () => {
    const v = { version: 1, profile: "my-custom-profile" };
    expect(ConfigSchema.parse(v)).toEqual(v);
  });

  it("accepts open-string project.type (not enforced as enum)", () => {
    const v = {
      version: 1,
      project: { name: "x", type: "experimental-thing" },
    };
    expect(ConfigSchema.parse(v)).toEqual(v);
  });

  it("rejects invalid risk levels from the shared session-format vocabulary", () => {
    expect(() =>
      ConfigSchema.parse({
        version: 1,
        risk: { block_on: "severe" },
      }),
    ).toThrow();
  });

  it("rejects llm.enabled = true (locked false-only for v0.7.0)", () => {
    expect(() => ConfigSchema.parse({ version: 1, llm: { enabled: true } })).toThrow();
  });

  it("accepts llm.enabled = false explicitly", () => {
    const v = { version: 1, llm: { enabled: false } };
    expect(ConfigSchema.parse(v)).toEqual(v);
  });

  it("rejects unknown top-level fields (strict)", () => {
    expect(() => ConfigSchema.parse({ version: 1, unknown_field: "nope" })).toThrow();
  });

  it("rejects unknown nested fields (strict)", () => {
    expect(() =>
      ConfigSchema.parse({
        version: 1,
        project: { name: "x", unknown: 1 },
      }),
    ).toThrow();
  });

  it("rejects blank profile string", () => {
    expect(() => ConfigSchema.parse({ version: 1, profile: "   " })).toThrow();
  });

  it("rejects blank project.name", () => {
    expect(() => ConfigSchema.parse({ version: 1, project: { name: "" } })).toThrow();
  });

  it("rejects blank entries inside string arrays", () => {
    expect(() =>
      ConfigSchema.parse({
        version: 1,
        frameworks: ["laravel", "   "],
      }),
    ).toThrow();
  });
});

// =============================================================================
// verify.commands (M 0.8.0 step 5)
//
// The entry shape is VerifyCommandSchema from @viberevert/session-format, the
// exact object persisted in SessionState.evaluation_snapshot.verify_commands.
// Reuse is justified by the shapes being identical TODAY, not by a rule that
// they must stay identical forever, so these tests pin the decisions a
// config-side reimplementation would most plausibly get wrong. If a
// translation boundary is ever introduced here, they should still pass.
// =============================================================================

describe("ConfigSchema: verify.commands", () => {
  it("omitting verify entirely stays valid (backward compatibility)", () => {
    // Existing configs with no `verify` block remain valid.
    expect(ConfigSchema.parse({ version: 1 }).verify).toBeUndefined();
  });

  it("accepts an empty verify block", () => {
    const v = { version: 1, verify: {} };
    expect(ConfigSchema.parse(v)).toEqual(v);
  });

  it("accepts an explicit empty command list", () => {
    // Meaningful rather than erroneous: it states "no verification".
    const v = { version: 1, verify: { commands: [] } };
    expect(ConfigSchema.parse(v)).toEqual(v);
  });

  it("accepts a well-formed command", () => {
    const v = { version: 1, verify: { commands: [{ command: "pnpm", args: ["test"] }] } };
    expect(ConfigSchema.parse(v)).toEqual(v);
  });

  it("accepts args: [] (required, but may be empty)", () => {
    const v = { version: 1, verify: { commands: [{ command: "make", args: [] }] } };
    expect(ConfigSchema.parse(v)).toEqual(v);
  });

  it("accepts an empty string as an individual argv element", () => {
    // args entries are plain strings, NOT nonBlankString. An empty argv
    // element is legitimate, and a nonBlankString reimplementation would make
    // this otherwise valid command unrepresentable.
    const v = { version: 1, verify: { commands: [{ command: "sh", args: ["-c", ""] }] } };
    expect(ConfigSchema.parse(v)).toEqual(v);
  });

  it("rejects a command entry with no args key", () => {
    // args is required precisely so absence cannot silently resolve to [].
    expect(() =>
      ConfigSchema.parse({ version: 1, verify: { commands: [{ command: "pnpm" }] } }),
    ).toThrow();
  });

  it("rejects a blank command", () => {
    expect(() =>
      ConfigSchema.parse({ version: 1, verify: { commands: [{ command: "   ", args: [] }] } }),
    ).toThrow();
  });

  it("rejects a non-string argv element", () => {
    // A real YAML trap rather than a hypothetical: `args: [--jobs, 4]` parses
    // 4 as a number, so this must fail loudly at load rather than reach a
    // spawn call as a non-string.
    expect(() =>
      ConfigSchema.parse({ version: 1, verify: { commands: [{ command: "make", args: [4] }] } }),
    ).toThrow();
  });

  it("rejects speculative fields on a command entry (strict)", () => {
    // name / cwd / timeout are deliberately NOT part of the shape yet. This
    // fails until one is added on purpose, in session-format, with a test.
    expect(() =>
      ConfigSchema.parse({
        version: 1,
        verify: { commands: [{ command: "pnpm", args: ["test"], timeout: 30 }] },
      }),
    ).toThrow();
  });

  it("rejects unknown fields inside verify (strict)", () => {
    expect(() =>
      ConfigSchema.parse({ version: 1, verify: { commands: [], parallel: true } }),
    ).toThrow();
  });

  it("preserves order and permits duplicates (a sequence, not a set)", () => {
    // Order and duplicates are meaningful here. Sorting would change the
    // configured sequence, and deduping would remove an intentional repeat.
    const commands = [
      { command: "pnpm", args: ["typecheck"] },
      { command: "pnpm", args: ["test"] },
      { command: "pnpm", args: ["typecheck"] },
    ];
    expect(ConfigSchema.parse({ version: 1, verify: { commands } }).verify?.commands).toEqual(
      commands,
    );
  });
});

describe("loadConfig (with real I/O)", () => {
  it("loads a minimal valid config", async () => {
    await writeConfig("version: 1\n");
    expect(await loadConfig(tmpRoot)).toEqual({ version: 1 });
  });

  it("loads a comprehensive config and returns typed shape", async () => {
    await writeConfig(`
version: 1
profile: laravel
project:
  name: wallafan
  type: web-app
risk:
  block_on: critical
  warn_on: medium
frameworks:
  - laravel
  - node
checks:
  secrets: true
  payments: true
policies:
  - basic/web-app
rollback:
  enabled: true
  exclude:
    - node_modules/**
commands:
  guard:
    - "rm -rf /"
llm:
  enabled: false
`);
    const config = await loadConfig(tmpRoot);
    expect(config.profile).toBe("laravel");
    expect(config.project?.name).toBe("wallafan");
    expect(config.risk?.block_on).toBe("critical");
    expect(config.frameworks).toEqual(["laravel", "node"]);
    expect(config.commands?.guard).toEqual(["rm -rf /"]);
    expect(config.llm?.enabled).toBe(false);
  });

  it("loads the verify block shown in docs/config.md", async () => {
    // The YAML below mirrors the "Project verification" example from
    // docs/config.md, with the required `version` key added because the doc
    // prints a fragment. This pins the intended documented form as valid
    // config; the schema/docs parity test separately guards the documented
    // key surface.
    await writeConfig(`
version: 1
verify:
  commands:
    - command: pnpm
      args:
        - typecheck
    - command: pnpm
      args:
        - test
`);
    const config = await loadConfig(tmpRoot);
    expect(config.verify?.commands).toEqual([
      { command: "pnpm", args: ["typecheck"] },
      { command: "pnpm", args: ["test"] },
    ]);
  });

  it("throws ConfigNotFoundError when .viberevert.yml is missing", async () => {
    await expect(loadConfig(tmpRoot)).rejects.toBeInstanceOf(ConfigNotFoundError);
  });

  it("throws ConfigParseError on malformed YAML", async () => {
    await writeConfig("version: [1, 2\n");
    await expect(loadConfig(tmpRoot)).rejects.toBeInstanceOf(ConfigParseError);
  });

  it("throws ConfigValidationError on schema violation", async () => {
    await writeConfig("version: 99\n");
    await expect(loadConfig(tmpRoot)).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it("ConfigValidationError exposes structured zod issues", async () => {
    await writeConfig("version: 1\nllm:\n  enabled: true\n");
    let err: unknown;
    try {
      await loadConfig(tmpRoot);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(ConfigValidationError);
    const validationErr = err as ConfigValidationError;
    expect(validationErr.issues.length).toBeGreaterThan(0);
    expect(validationErr.issues[0]?.path).toContain("llm");
  });

  it("ConfigParseError attaches the underlying parse error as cause", async () => {
    await writeConfig("version: [1, 2\n");
    let err: unknown;
    try {
      await loadConfig(tmpRoot);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(ConfigParseError);
    expect((err as Error).cause).toBeDefined();
  });

  it("error class names are stable", () => {
    expect(new ConfigNotFoundError("/x").name).toBe("ConfigNotFoundError");
    expect(new ConfigParseError("/x", new Error("y")).name).toBe("ConfigParseError");

    const parsed = ConfigSchema.safeParse({ version: 99 });
    if (parsed.success) {
      throw new Error("expected schema parse to fail");
    }
    expect(new ConfigValidationError("/x", parsed.error).name).toBe("ConfigValidationError");
  });
});
