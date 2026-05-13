// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Stream `absolutePath` through SHA-256 and return the lowercase hex digest
 * (64 characters, [0-9a-f]+).
 */
export async function sha256File(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
