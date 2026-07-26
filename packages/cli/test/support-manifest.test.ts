// packages/cli/test/support-manifest.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M H7 Step 2.2: tests for the support.yml validator. The canonical fixture is
// the REAL checked-in support.yml, loaded through the production parser seam and
// cloned per case -- so the positive test also proves the committed manifest
// parses and validates, and every negative case mutates the actual manifest
// rather than a copied approximation. The parser seam has its own duplicate-key
// test, which pure object mutations cannot represent.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validateSupportManifest } from "../../../scripts/support-manifest-core.js";
import { parseSupportManifest } from "../../../scripts/support-manifest-parser.js";

const SUPPORT_MANIFEST_URL = new URL("../../../support.yml", import.meta.url);

// A fresh deep clone of the real manifest on every call, so a mutation in one
// case cannot leak into another.
function validManifest(): Record<string, unknown> {
  const parsed: unknown = parseSupportManifest(readFileSync(SUPPORT_MANIFEST_URL, "utf8"));
  return structuredClone(parsed) as Record<string, unknown>;
}

interface NegativeCase {
  readonly name: string;
  // biome-ignore lint/suspicious/noExplicitAny: negative fixtures mutate arbitrary nested manifest fields
  readonly mutate: (m: any) => void;
  readonly code: string;
}

const NEGATIVE_CASES: NegativeCase[] = [
  {
    name: "unknown root field",
    mutate: (m) => {
      m.extra = true;
    },
    code: "root",
  },
  {
    name: "wrong schema_version",
    mutate: (m) => {
      m.schema_version = 2;
    },
    code: "schema_version",
  },
  {
    name: "blank runtime version",
    mutate: (m) => {
      m.runtimes.node.tested[0].version = "  ";
    },
    code: "runtimes.node.tested",
  },
  {
    name: "duplicate tested runtime",
    mutate: (m) => {
      m.runtimes.node.tested.push({ version: "24.x", channel: "compatibility" });
    },
    code: "runtimes.node.tested",
  },
  {
    name: "no pinned runtime",
    mutate: (m) => {
      m.runtimes.node.tested[0].channel = "compatibility";
    },
    code: "runtimes.node.tested",
  },
  {
    name: "multiple pinned runtimes",
    mutate: (m) => {
      m.runtimes.node.tested[1].channel = "pinned";
    },
    code: "runtimes.node.tested",
  },
  {
    name: "orphan tested runtime",
    mutate: (m) => {
      m.runtimes.node.tested.push({ version: "20.x", channel: "compatibility" });
    },
    code: "profiles",
  },
  {
    name: "gates on a non-pinned runtime",
    mutate: (m) => {
      m.gates.node = "24.x";
    },
    code: "gates.node",
  },
  {
    name: "misspelled gate check",
    mutate: (m) => {
      m.gates.validates[0] = "lnt";
    },
    code: "gates.validates",
  },
  {
    name: "missing baseline check",
    mutate: (m) => {
      m.baseline_validation.pop();
    },
    code: "baseline_validation",
  },
  {
    name: "blank profile runner",
    mutate: (m) => {
      m.profiles["linux-node22"].runner = "   ";
    },
    code: "profiles.linux-node22",
  },
  {
    name: "unknown profile field",
    mutate: (m) => {
      m.profiles["linux-node22"].release_smokes = true;
    },
    code: "profiles.linux-node22",
  },
  {
    name: "invalid platform",
    mutate: (m) => {
      m.profiles["linux-node22"].platform = "linix";
    },
    code: "profiles.linux-node22",
  },
  {
    name: "source_build on a compatibility profile",
    mutate: (m) => {
      m.profiles["macos-node22"].node_pty_source_build = true;
    },
    code: "profiles.macos-node22",
  },
  {
    name: "release smoke on a compatibility profile",
    mutate: (m) => {
      m.profiles["windows-node24"].release_smoke = true;
    },
    code: "profiles.windows-node24",
  },
  {
    name: "release profile without a responsibility",
    mutate: (m) => {
      m.profiles["linux-node22"].node_pty_source_build = false;
    },
    code: "profiles.linux-node22",
  },
  {
    name: "release profile on a non-pinned runtime",
    mutate: (m) => {
      m.profiles["linux-node24"].validation_tier = "release";
      m.profiles["linux-node24"].node_pty_source_build = true;
    },
    code: "profiles.linux-node24",
  },
  {
    name: "duplicate (platform, node) tuple",
    mutate: (m) => {
      m.profiles["linux-node22b"] = { ...m.profiles["linux-node22"] };
    },
    code: "profiles",
  },
  {
    name: "uncovered logical platform",
    mutate: (m) => {
      delete m.profiles["windows-node22"];
      delete m.profiles["windows-node24"];
    },
    code: "profiles",
  },
  {
    name: "empty reason_codes registry",
    mutate: (m) => {
      m.reason_codes = {};
    },
    code: "reason_codes",
  },
  {
    name: "missing reason_code (capability_gated)",
    mutate: (m) => {
      delete m.features.live_pty_interception.platforms.macos.reason_code;
    },
    code: "features.live_pty_interception.platforms.macos",
  },
  {
    name: "blank reason_code reference",
    mutate: (m) => {
      m.features.live_pty_interception.platforms.macos.reason_code = "   ";
    },
    code: "features.live_pty_interception.platforms.macos",
  },
  {
    name: "forbidden reason_code (exercised)",
    mutate: (m) => {
      m.features.live_pty_interception.platforms.linux.reason_code = "requires_posix_bash";
    },
    code: "features.live_pty_interception.platforms.linux",
  },
  {
    name: "undefined reason_code reference",
    mutate: (m) => {
      m.features.live_pty_interception.platforms.macos.reason_code = "nope";
    },
    code: "features.live_pty_interception.platforms.macos",
  },
  {
    name: "invalid disposition",
    mutate: (m) => {
      m.features.live_pty_interception.platforms.macos.disposition = "sometimes";
    },
    code: "features.live_pty_interception.platforms.macos",
  },
  {
    name: "PTY disposition disagreement",
    mutate: (m) => {
      m.features.live_pty_interception.platforms.macos = { disposition: "exercised" };
    },
    code: "self-consistency",
  },
  {
    name: "incomplete feature-platform coverage",
    mutate: (m) => {
      delete m.features.core_non_live_pty.platforms.windows;
    },
    code: "features.core_non_live_pty",
  },
  {
    name: "unknown feature name",
    mutate: (m) => {
      m.features.bonus = { maturity: "beta", platforms: {} };
    },
    code: "features",
  },
  {
    name: "missing required feature",
    mutate: (m) => {
      delete m.features.core_non_live_pty;
    },
    code: "features",
  },
  {
    name: "core maturity not beta",
    mutate: (m) => {
      m.features.core_non_live_pty.maturity = "experimental";
    },
    code: "features.core_non_live_pty",
  },
  {
    name: "core capabilities missing",
    mutate: (m) => {
      delete m.features.core_non_live_pty.capabilities;
    },
    code: "features.core_non_live_pty",
  },
  {
    name: "duplicate capability",
    mutate: (m) => {
      m.features.core_non_live_pty.capabilities.push("init");
    },
    code: "features.core_non_live_pty",
  },
  {
    name: "live PTY maturity not experimental",
    mutate: (m) => {
      m.features.live_pty_interception.maturity = "beta";
    },
    code: "features.live_pty_interception",
  },
  {
    name: "live PTY must not carry capabilities",
    mutate: (m) => {
      m.features.live_pty_interception.capabilities = ["x"];
    },
    code: "features.live_pty_interception",
  },
];

describe("validateSupportManifest", () => {
  it("accepts the committed support.yml", () => {
    expect(validateSupportManifest(validManifest())).toEqual([]);
  });

  it.each(NEGATIVE_CASES)("rejects: $name", ({ mutate, code }) => {
    const manifest = validManifest();
    mutate(manifest);
    const codes = validateSupportManifest(manifest).map((v) => v.code);
    expect(codes).toContain(code);
  });
});

describe("parseSupportManifest", () => {
  it("rejects duplicate mapping keys (uniqueKeys stays active)", () => {
    const duplicated = [
      "schema_version: 1",
      "profiles:",
      "  linux-node22: {}",
      "  linux-node22: {}",
      "",
    ].join("\n");
    expect(() => parseSupportManifest(duplicated)).toThrow();
  });
});
