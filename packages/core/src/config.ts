// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Schema and loader for `.viberevert.yml`.
//
// Naming convention (matches @viberevert/session-format):
//   - ConfigSchema is the runtime zod value (use for .parse(), .safeParse()).
//   - Config is the inferred TypeScript type.
//
// The schema is intentionally permissive on profile/type strings (see field
// notes) and intentionally strict on object shape (z.strictObject everywhere).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RiskLevelSchema } from "@viberevert/session-format";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// =============================================================================
// Local non-blank string atom
//
// Defined locally rather than imported from @viberevert/session-format because
// nonBlankString is a generic atom, not a session-format concept. Each package
// owns its own. Behavior must stay consistent: rejects empty and
// whitespace-only strings.
// =============================================================================

const nonBlankString = z.string().refine((s) => s.trim().length > 0, {
  message: "must not be empty or whitespace-only",
});

// =============================================================================
// ConfigSchema (strict)
//
// Almost every field is .optional(). The config file is allowed to be sparse;
// consumers apply defaults at use time, not at parse time. Hard-coded defaults
// in the schema would obscure what the user actually wrote.
//
// Two intentional permissive choices:
//   - `profile` is a non-blank string, not an enum. Built-in profiles today
//     are fixed but third-party profiles via plugins are plausible.
//   - `project.type` is a non-blank string, not an enum. Users will invent
//     types we did not predict; this field is descriptive, not security-
//     sensitive.
//
// One intentional hard restriction:
//   - `llm.enabled` accepts only the literal `false`. The "Rules decide.
//     Agents fix." principle is enforced at the schema level for v0.7.0-beta.
//     A config with `llm: { enabled: true }` fails validation with a clear
//     message rather than being silently accepted-and-ignored.
// =============================================================================

export const ConfigSchema = z.strictObject({
  version: z.literal(1),
  profile: nonBlankString.optional(),
  project: z
    .strictObject({
      name: nonBlankString,
      type: nonBlankString.optional(),
    })
    .optional(),
  risk: z
    .strictObject({
      block_on: RiskLevelSchema.optional(),
      warn_on: RiskLevelSchema.optional(),
    })
    .optional(),
  frameworks: z.array(nonBlankString).optional(),
  checks: z
    .strictObject({
      secrets: z.boolean().optional(),
      dependencies: z.boolean().optional(),
      migrations: z.boolean().optional(),
      auth: z.boolean().optional(),
      payments: z.boolean().optional(),
      infra: z.boolean().optional(),
      tests: z.boolean().optional(),
      scope_expansion: z.boolean().optional(),
    })
    .optional(),
  policies: z.array(nonBlankString).optional(),
  rollback: z
    .strictObject({
      enabled: z.boolean().optional(),
      include_untracked: z.boolean().optional(),
      exclude: z.array(nonBlankString).optional(),
    })
    .optional(),
  commands: z
    .strictObject({
      guard: z.array(nonBlankString).optional(),
      require_confirm: z.array(nonBlankString).optional(),
    })
    .optional(),
  llm: z
    .strictObject({
      enabled: z.literal(false).optional(),
    })
    .optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

// =============================================================================
// Errors
//
// Three subclasses so the CLI can render distinct messages without inspecting
// `.message` text:
//   - ConfigNotFoundError → "no .viberevert.yml — run `viberevert init`"
//   - ConfigParseError    → "YAML syntax error" + parser detail in .cause
//   - ConfigValidationError → "config schema violation" + zod issue list
// =============================================================================

export class ConfigNotFoundError extends Error {
  constructor(configPath: string) {
    super(`No .viberevert.yml found at ${configPath}`);
    this.name = "ConfigNotFoundError";
  }
}

export class ConfigParseError extends Error {
  constructor(configPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to parse YAML in ${configPath}: ${detail}`, { cause });
    this.name = "ConfigParseError";
  }
}

export class ConfigValidationError extends Error {
  /** The underlying zod issues, exposed for callers that want structured access. */
  readonly issues: z.ZodError["issues"];

  constructor(configPath: string, zodError: z.ZodError) {
    const summary = zodError.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    super(`Config validation failed in ${configPath}: ${summary}`, {
      cause: zodError,
    });
    this.name = "ConfigValidationError";
    this.issues = zodError.issues;
  }
}

// =============================================================================
// loadConfig
// =============================================================================

/**
 * Reads `<repoRoot>/.viberevert.yml`, parses YAML, validates with ConfigSchema,
 * returns the typed Config.
 *
 * Throws:
 *   - ConfigNotFoundError if the file does not exist.
 *   - ConfigParseError if the YAML is syntactically invalid.
 *   - ConfigValidationError if the YAML parses but violates the schema.
 *
 * Other I/O errors (permissions, etc.) propagate as-is from `fs.readFile`.
 */
export async function loadConfig(repoRoot: string): Promise<Config> {
  const configPath = join(repoRoot, ".viberevert.yml");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause as { code?: string }).code === "ENOENT"
    ) {
      throw new ConfigNotFoundError(configPath);
    }
    throw cause;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    throw new ConfigParseError(configPath, cause);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigValidationError(configPath, result.error);
  }
  return result.data;
}
