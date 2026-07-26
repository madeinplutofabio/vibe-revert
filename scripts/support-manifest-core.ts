// scripts/support-manifest-core.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M H7 Step 2.2: pure structural + self-consistency validation for support.yml.
//
// No I/O, no process side effects -- `validateSupportManifest` takes an
// already-parsed value and returns violations, so it is directly table-testable.
// Parsing (support-manifest-parser.ts) and I/O/exit (check-support-manifest.ts)
// are separate seams.
//
// Untrusted parsed fields are read via `readProp` (a variable-key accessor, as in
// dependency-policy-core.ts) so index-signature access stays clean under
// noPropertyAccessFromIndexSignature.
//
// Scope is the manifest itself: well-formedness, the schema_version-1 vocabulary
// (unknown keys AND unknown feature names rejected), internal coherence, the
// schema-v1 release/runtime semantics, and the schema-v1 per-feature claims.
// Cross-file checks -- the workflow mapping and `runtimes.node.minimum` ==
// package.json engines.node -- are Step 2.3.

const LOGICAL_PLATFORMS = ["linux", "macos", "windows"] as const;
const NODE_CHANNELS = ["pinned", "compatibility"] as const;
const VALIDATION_TIERS = ["release", "compatibility"] as const;
const LIVE_PTY_VALIDATIONS = ["required", "capability_gated", "not_applicable"] as const;
const MATURITIES = ["beta", "experimental"] as const;
const DISPOSITIONS = ["exercised", "capability_gated", "not_applicable"] as const;
const GATE_CHECKS = [
  "lint",
  "typecheck",
  "dependency_policy",
  "license_audit_freshness",
  "support_manifest",
] as const;
const BASELINE_CHECKS = ["frozen_install", "node_pty_binding_load", "build", "test_suite"] as const;
const FEATURE_NAMES = ["core_non_live_pty", "live_pty_interception"] as const;

const LIVE_PTY_TO_DISPOSITION: Readonly<Record<string, string>> = {
  required: "exercised",
  capability_gated: "capability_gated",
  not_applicable: "not_applicable",
};
const CORE_FEATURE = "core_non_live_pty";
const LIVE_PTY_FEATURE = "live_pty_interception";

const ROOT_KEYS = [
  "schema_version",
  "runtimes",
  "gates",
  "baseline_validation",
  "profiles",
  "reason_codes",
  "features",
] as const;
const RUNTIMES_KEYS = ["node"] as const;
const RUNTIMES_NODE_KEYS = ["minimum", "tested"] as const;
const TESTED_ENTRY_KEYS = ["version", "channel"] as const;
const GATES_KEYS = ["runner", "node", "validates"] as const;
const PROFILE_KEYS = [
  "platform",
  "runner",
  "node",
  "validation_tier",
  "node_pty_source_build",
  "live_pty_validation",
  "release_smoke",
] as const;
const REASON_CODE_KEYS = ["meaning"] as const;
const FEATURE_KEYS = ["maturity", "capabilities", "platforms"] as const;
const FEATURE_PLATFORM_KEYS = ["disposition", "reason_code"] as const;

export interface Violation {
  readonly code: string;
  readonly message: string;
}

type Err = (code: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProp(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
  err: Err,
): void {
  const allowedSet = new Set<string>(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      err(at, `unknown field ${JSON.stringify(key)}`);
    }
  }
}

// Non-empty, unique, known-only, AND exact coverage of the vocabulary.
function checkControlledList(
  value: unknown,
  vocabulary: readonly string[],
  at: string,
  err: Err,
): void {
  if (!isStringArray(value) || value.length === 0) {
    err(at, "must be a non-empty array of strings");
    return;
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (!vocabulary.includes(item)) {
      err(at, `unknown value ${JSON.stringify(item)} (allowed: ${vocabulary.join(", ")})`);
    } else if (seen.has(item)) {
      err(at, `duplicate value ${JSON.stringify(item)}`);
    }
    seen.add(item);
  }
  for (const required of vocabulary) {
    if (!seen.has(required)) {
      err(at, `missing required value ${JSON.stringify(required)}`);
    }
  }
}

export function validateSupportManifest(manifest: unknown): Violation[] {
  const violations: Violation[] = [];
  const err: Err = (code, message) => {
    violations.push({ code, message });
  };

  if (!isRecord(manifest)) {
    err("root", "support.yml did not parse to a mapping");
    return violations;
  }
  rejectUnknownKeys(manifest, ROOT_KEYS, "root", err);

  const schemaVersion = readProp(manifest, "schema_version");
  if (schemaVersion !== 1) {
    err("schema_version", `expected 1, got ${JSON.stringify(schemaVersion)}`);
  }

  // runtimes.node -> tested versions (unique, non-blank) + the pinned runtime.
  const testedVersions = new Set<string>();
  const pinnedVersions: string[] = [];
  const runtimes = readProp(manifest, "runtimes");
  if (!isRecord(runtimes)) {
    err("runtimes", "missing or malformed");
  } else {
    rejectUnknownKeys(runtimes, RUNTIMES_KEYS, "runtimes", err);
    const node = readProp(runtimes, "node");
    if (!isRecord(node)) {
      err("runtimes.node", "missing or malformed");
    } else {
      rejectUnknownKeys(node, RUNTIMES_NODE_KEYS, "runtimes.node", err);
      if (!isNonBlankString(readProp(node, "minimum"))) {
        err("runtimes.node.minimum", 'must be a non-blank string (e.g. ">=22")');
      }
      const tested = readProp(node, "tested");
      if (!Array.isArray(tested) || tested.length === 0) {
        err("runtimes.node.tested", "must be a non-empty array");
      } else {
        for (let i = 0; i < tested.length; i++) {
          const entry: unknown = tested[i];
          if (!isRecord(entry)) {
            err("runtimes.node.tested", `tested[${i}] must be a mapping`);
            continue;
          }
          rejectUnknownKeys(entry, TESTED_ENTRY_KEYS, `runtimes.node.tested[${i}]`, err);
          const version = readProp(entry, "version");
          const channel = readProp(entry, "channel");
          if (isNonBlankString(version)) {
            if (testedVersions.has(version)) {
              err("runtimes.node.tested", `duplicate tested version ${JSON.stringify(version)}`);
            }
            testedVersions.add(version);
            if (channel === "pinned") {
              pinnedVersions.push(version);
            }
          } else {
            err("runtimes.node.tested", `tested[${i}].version must be a non-blank string`);
          }
          if (!oneOf(NODE_CHANNELS, channel)) {
            err(
              "runtimes.node.tested",
              `tested[${i}].channel must be one of ${NODE_CHANNELS.join(", ")}`,
            );
          }
        }
      }
    }
  }

  // Exactly one pinned release-qualification runtime.
  let pinnedVersion: string | undefined;
  if (pinnedVersions.length !== 1) {
    err(
      "runtimes.node.tested",
      `exactly one tested runtime must have channel: pinned (found ${pinnedVersions.length})`,
    );
  } else {
    pinnedVersion = pinnedVersions[0];
  }

  // A malformed tested set must NOT make every version "known".
  const knownVersion = (value: unknown): value is string =>
    typeof value === "string" && testedVersions.has(value);

  // gates -- run once, on the pinned runtime.
  const gates = readProp(manifest, "gates");
  if (!isRecord(gates)) {
    err("gates", "missing or malformed");
  } else {
    rejectUnknownKeys(gates, GATES_KEYS, "gates", err);
    if (!isNonBlankString(readProp(gates, "runner"))) {
      err("gates.runner", "must be a non-blank string");
    }
    const gatesNode = readProp(gates, "node");
    if (!knownVersion(gatesNode)) {
      err("gates.node", `must be a tested runtime version (got ${JSON.stringify(gatesNode)})`);
    } else if (pinnedVersion !== undefined && gatesNode !== pinnedVersion) {
      err("gates.node", `must be the pinned runtime ${JSON.stringify(pinnedVersion)}`);
    }
    checkControlledList(readProp(gates, "validates"), GATE_CHECKS, "gates.validates", err);
  }

  checkControlledList(
    readProp(manifest, "baseline_validation"),
    BASELINE_CHECKS,
    "baseline_validation",
    err,
  );

  // profiles.
  const platformSet = new Set<string>();
  const profileRuntimes = new Set<string>();
  const tuples = new Set<string>();
  const livePtyByPlatform = new Map<string, { profile: string; livePty: string }[]>();
  const profiles = readProp(manifest, "profiles");
  if (!isRecord(profiles) || Object.keys(profiles).length === 0) {
    err("profiles", "missing or empty");
  } else {
    for (const [name, value] of Object.entries(profiles)) {
      const at = `profiles.${name}`;
      if (!isNonBlankString(name)) {
        err("profiles", `profile name ${JSON.stringify(name)} must be non-blank`);
      }
      if (!isRecord(value)) {
        err(at, "must be a mapping");
        continue;
      }
      rejectUnknownKeys(value, PROFILE_KEYS, at, err);

      const platformRaw = readProp(value, "platform");
      const platform = oneOf(LOGICAL_PLATFORMS, platformRaw) ? platformRaw : undefined;
      if (platform === undefined) {
        err(at, `\`platform\` must be one of ${LOGICAL_PLATFORMS.join(", ")}`);
      } else {
        platformSet.add(platform);
      }
      if (!isNonBlankString(readProp(value, "runner"))) {
        err(at, "`runner` must be a non-blank string");
      }
      const nodeRaw = readProp(value, "node");
      const nodeVersion = knownVersion(nodeRaw) ? nodeRaw : undefined;
      if (nodeVersion === undefined) {
        err(at, `\`node\` must be a tested runtime version (got ${JSON.stringify(nodeRaw)})`);
      } else {
        profileRuntimes.add(nodeVersion);
      }
      const tierRaw = readProp(value, "validation_tier");
      const tier = oneOf(VALIDATION_TIERS, tierRaw) ? tierRaw : undefined;
      if (tier === undefined) {
        err(at, `\`validation_tier\` must be one of ${VALIDATION_TIERS.join(", ")}`);
      }
      const sourceBuildRaw = readProp(value, "node_pty_source_build");
      const sourceBuild = typeof sourceBuildRaw === "boolean" ? sourceBuildRaw : undefined;
      if (sourceBuild === undefined) {
        err(at, "`node_pty_source_build` must be a boolean");
      }
      const livePtyRaw = readProp(value, "live_pty_validation");
      const livePty = oneOf(LIVE_PTY_VALIDATIONS, livePtyRaw) ? livePtyRaw : undefined;
      if (livePty === undefined) {
        err(at, `\`live_pty_validation\` must be one of ${LIVE_PTY_VALIDATIONS.join(", ")}`);
      }
      const releaseSmokeRaw = readProp(value, "release_smoke");
      const releaseSmoke = typeof releaseSmokeRaw === "boolean" ? releaseSmokeRaw : undefined;
      if (releaseSmoke === undefined) {
        err(at, "`release_smoke` must be a boolean");
      }

      // Schema-v1 release/runtime semantics (only when constituent fields valid).
      if (sourceBuild === true && tier === "compatibility") {
        err(at, "`node_pty_source_build: true` requires validation_tier: release");
      }
      if (releaseSmoke === true && tier === "compatibility") {
        err(at, "`release_smoke: true` requires validation_tier: release");
      }
      if (tier === "release") {
        if (
          pinnedVersion !== undefined &&
          nodeVersion !== undefined &&
          nodeVersion !== pinnedVersion
        ) {
          err(at, `release profile must use the pinned runtime ${JSON.stringify(pinnedVersion)}`);
        }
        if (sourceBuild === false && releaseSmoke === false) {
          err(
            at,
            "release profile must carry a release responsibility (node_pty_source_build or release_smoke)",
          );
        }
      }

      if (platform !== undefined && nodeVersion !== undefined) {
        const tuple = `${platform} ${nodeVersion}`;
        if (tuples.has(tuple)) {
          err("profiles", `duplicate (platform, node) tuple: (${platform}, ${nodeVersion})`);
        }
        tuples.add(tuple);
      }
      if (platform !== undefined && livePty !== undefined) {
        const list = livePtyByPlatform.get(platform) ?? [];
        list.push({ profile: name, livePty });
        livePtyByPlatform.set(platform, list);
      }
    }

    // Bidirectional coverage: no orphan tested runtime, no uncovered platform.
    for (const version of testedVersions) {
      if (!profileRuntimes.has(version)) {
        err("profiles", `tested runtime ${JSON.stringify(version)} has no validation profile`);
      }
    }
    for (const platform of LOGICAL_PLATFORMS) {
      if (!platformSet.has(platform)) {
        err("profiles", `logical platform ${JSON.stringify(platform)} has no validation profile`);
      }
    }
  }

  // reason_codes registry (non-empty; non-blank keys and meanings). Only valid
  // keys are registered, so a blank key cannot satisfy a later reference.
  const reasonCodes = new Set<string>();
  const reasonCodesRaw = readProp(manifest, "reason_codes");
  if (!isRecord(reasonCodesRaw) || Object.keys(reasonCodesRaw).length === 0) {
    err("reason_codes", "missing or empty");
  } else {
    for (const [code, def] of Object.entries(reasonCodesRaw)) {
      const validKey = isNonBlankString(code);
      if (!validKey) {
        err("reason_codes", `reason-code key ${JSON.stringify(code)} must be non-blank`);
      }
      if (!isRecord(def)) {
        err("reason_codes", `${code} must be a mapping`);
        continue;
      }
      rejectUnknownKeys(def, REASON_CODE_KEYS, `reason_codes.${code}`, err);
      if (!isNonBlankString(readProp(def, "meaning"))) {
        err("reason_codes", `${code} must have a non-blank \`meaning\``);
      }
      if (validKey) {
        reasonCodes.add(code);
      }
    }
  }

  // features -- exact schema-v1 feature vocabulary, then per-feature validation.
  const features = readProp(manifest, "features");
  if (!isRecord(features) || Object.keys(features).length === 0) {
    err("features", "missing or empty");
  } else {
    const declaredFeatures = new Set(Object.keys(features));
    for (const required of FEATURE_NAMES) {
      if (!declaredFeatures.has(required)) {
        err("features", `missing required feature ${JSON.stringify(required)}`);
      }
    }
    for (const declared of declaredFeatures) {
      if (!(FEATURE_NAMES as readonly string[]).includes(declared)) {
        err("features", `unknown feature ${JSON.stringify(declared)}`);
      }
    }

    for (const [fname, f] of Object.entries(features)) {
      const at = `features.${fname}`;
      if (!isRecord(f)) {
        err(at, "must be a mapping");
        continue;
      }
      rejectUnknownKeys(f, FEATURE_KEYS, at, err);
      if (!oneOf(MATURITIES, readProp(f, "maturity"))) {
        err(at, `\`maturity\` must be one of ${MATURITIES.join(", ")}`);
      }
      if ("capabilities" in f) {
        const capabilities = readProp(f, "capabilities");
        if (!isStringArray(capabilities) || capabilities.length === 0) {
          err(at, "`capabilities`, when present, must be a non-empty array of strings");
        } else {
          const seen = new Set<string>();
          for (const capability of capabilities) {
            if (!isNonBlankString(capability)) {
              err(at, "`capabilities` entries must be non-blank strings");
            } else if (seen.has(capability)) {
              err(at, `duplicate capability ${JSON.stringify(capability)}`);
            }
            seen.add(capability);
          }
        }
      }
      const platforms = readProp(f, "platforms");
      if (!isRecord(platforms)) {
        err(at, "`platforms` missing or malformed");
        continue;
      }
      for (const [plat, entry] of Object.entries(platforms)) {
        const patAt = `${at}.platforms.${plat}`;
        if (!isRecord(entry)) {
          err(patAt, "must be a mapping");
          continue;
        }
        rejectUnknownKeys(entry, FEATURE_PLATFORM_KEYS, patAt, err);
        const disposition = readProp(entry, "disposition");
        if (!oneOf(DISPOSITIONS, disposition)) {
          err(patAt, `\`disposition\` must be one of ${DISPOSITIONS.join(", ")}`);
          continue;
        }
        const hasReason = "reason_code" in entry;
        const reasonCode = readProp(entry, "reason_code");
        if (disposition === "exercised") {
          if (hasReason) {
            err(patAt, "`reason_code` must be absent for disposition `exercised`");
          }
        } else if (!hasReason) {
          err(patAt, `\`reason_code\` is required for disposition \`${disposition}\``);
        } else if (!isNonBlankString(reasonCode)) {
          err(
            patAt,
            `\`reason_code\` must be a non-blank string for disposition \`${disposition}\``,
          );
        } else if (!reasonCodes.has(reasonCode)) {
          err(
            patAt,
            `\`reason_code\` ${JSON.stringify(reasonCode)} is not defined in reason_codes`,
          );
        }
      }
      // Exact feature-platform coverage against the profile-declared platform set.
      if (platformSet.size > 0) {
        const declaredPlatforms = new Set(Object.keys(platforms));
        for (const plat of platformSet) {
          if (!declaredPlatforms.has(plat)) {
            err(
              at,
              `missing disposition for platform ${JSON.stringify(plat)} (declared by profiles)`,
            );
          }
        }
        for (const plat of declaredPlatforms) {
          if (!platformSet.has(plat)) {
            err(at, `platform ${JSON.stringify(plat)} is not declared by any profile`);
          }
        }
      }
    }

    // Schema-v1 per-feature claims: exact names must carry their locked contents.
    const coreFeature = readProp(features, CORE_FEATURE);
    if (isRecord(coreFeature)) {
      if (readProp(coreFeature, "maturity") !== "beta") {
        err(`features.${CORE_FEATURE}`, "`maturity` must be `beta` in schema version 1");
      }
      if (!("capabilities" in coreFeature)) {
        err(`features.${CORE_FEATURE}`, "`capabilities` is required in schema version 1");
      }
    }
    const livePtyFeature = readProp(features, LIVE_PTY_FEATURE);
    if (isRecord(livePtyFeature)) {
      if (readProp(livePtyFeature, "maturity") !== "experimental") {
        err(
          `features.${LIVE_PTY_FEATURE}`,
          "`maturity` must be `experimental` in schema version 1",
        );
      }
      if ("capabilities" in livePtyFeature) {
        err(`features.${LIVE_PTY_FEATURE}`, "`capabilities` must be absent in schema version 1");
      }
    }

    // Self-consistency: profile live_pty_validation <-> live_pty_interception disposition.
    const livePtyPlatforms = isRecord(livePtyFeature)
      ? readProp(livePtyFeature, "platforms")
      : undefined;
    if (!isRecord(livePtyPlatforms)) {
      err("features", `missing \`${LIVE_PTY_FEATURE}\` required for live-PTY self-consistency`);
    } else {
      for (const [platform, list] of livePtyByPlatform) {
        const featureEntry = readProp(livePtyPlatforms, platform);
        const disposition = isRecord(featureEntry)
          ? readProp(featureEntry, "disposition")
          : undefined;
        for (const { profile, livePty } of list) {
          const expected = LIVE_PTY_TO_DISPOSITION[livePty];
          if (expected !== undefined && disposition !== expected) {
            err(
              "self-consistency",
              `profile ${profile} live_pty_validation=${livePty} implies ${LIVE_PTY_FEATURE}.${platform}.disposition=${expected}, but manifest declares ${JSON.stringify(disposition)}`,
            );
          }
        }
      }
    }
  }

  return violations;
}
