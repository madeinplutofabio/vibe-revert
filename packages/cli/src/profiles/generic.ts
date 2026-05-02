// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { type GenerateOptions, generateGenericProfile } from "./shared.js";

export function generate(opts: GenerateOptions): string {
  return generateGenericProfile({ ...opts, profileName: "generic" });
}
