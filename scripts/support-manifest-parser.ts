// scripts/support-manifest-parser.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// M H7 Step 2.2: the single parse seam for support.yml. Isolated so the
// executable and the duplicate-key test bind to the SAME parser configuration --
// removing `uniqueKeys: true` here breaks the test rather than silently allowing
// duplicate mapping keys through.

import { parse } from "yaml";

export function parseSupportManifest(source: string): unknown {
  return parse(source, { uniqueKeys: true });
}
