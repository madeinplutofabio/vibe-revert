// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Repo-local query helper for the integrations store. Wraps
// readIntegrationsFile to answer the single yes/no question:
// "is there a record for this recordKey in this repo's
// .viberevert/integrations.json?"
//
// Policy: only the intentional absence case (no .viberevert/
// or no integrations.json) maps to `false`. Every other read
// failure -- corrupted JSON, wrong schemaVersion, symlinked
// path component, unreadable bytes, unexpected I/O -- bubbles
// to the caller as the typed error thrown by
// readIntegrationsFile. This is deliberate: the consumer
// (cli-commands' hook-install-integrations-guard) needs to
// surface "your integrations store is broken or unsafe" as a
// distinct problem from "no record found", not collapse the
// two into a single boolean. Returning conservative `true` on
// error would also be wrong -- it would make the CLI guard
// report "direct hook already installed" when the real problem
// is "your store is unreadable", which is worse than no answer.
//
// Consumed by:
//   - @viberevert/cli-commands hook-install-integrations-guard
//     (D101.M.5: guard MUST import this helper rather than
//     re-parsing the store).
//
// No extra guards here -- integrations-store owns read safety,
// symlink refusal, and classification. This helper is the
// thinnest possible adapter between that and a boolean.

import type { RecordKey } from "./engine-types.js";
import { readIntegrationsFile } from "./integrations-store.js";

/**
 * Returns true iff `.viberevert/integrations.json` exists, is
 * readable, parses, validates, AND contains a record under the
 * given `recordKey`. Returns false only when the store is
 * intentionally absent (no `.viberevert/` directory or no
 * `integrations.json` file). All other failure modes (corrupted
 * file, schema-version mismatch, symlink/non-file safety
 * refusal, unexpected I/O) propagate the typed error thrown by
 * `readIntegrationsFile`.
 */
export async function hasRepoIntegrationRecord(
  repoRoot: string,
  recordKey: RecordKey,
): Promise<boolean> {
  const integrations = await readIntegrationsFile(repoRoot);
  if (integrations === null) return false;
  return integrations.records[recordKey] !== undefined;
}
