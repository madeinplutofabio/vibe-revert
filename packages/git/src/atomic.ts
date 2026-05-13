// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

/**
 * Atomically write `data` to `targetPath`.
 */
export async function writeFileAtomic(
  targetPath: string,
  data: Buffer | string,
): Promise<void> {
  const suffix = randomBytes(8).toString("hex");
  const tempPath = `${targetPath}.tmp.${suffix}`;
  await writeFile(tempPath, data, { flag: "wx" });
  await rename(tempPath, targetPath);
}
