// scripts/support-manifest-parser.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M H7 Step 2.2/2.3: the YAML parse seams for the support-manifest check.
// Isolated so the executable and the duplicate-key tests bind to the SAME parser
// configuration -- removing `uniqueKeys: true` here breaks the tests rather than
// silently allowing duplicate mapping keys through either input.

import { parse } from "yaml";

function parseYaml(source: string): unknown {
  return parse(source, { uniqueKeys: true });
}

export function parseSupportManifest(source: string): unknown {
  return parseYaml(source);
}

export function parseWorkflow(source: string): unknown {
  return parseYaml(source);
}
