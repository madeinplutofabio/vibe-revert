// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { generate as generateGeneric } from "./generic.js";
import { generate as generateLaravel } from "./laravel.js";
import { generate as generateLovable } from "./lovable.js";
import { generate as generateNextjs } from "./nextjs.js";
import { generate as generatePython } from "./python.js";
import { generate as generateRails } from "./rails.js";
import type { Generator } from "./shared.js";

export type {
  GenerateOptions,
  Generator,
  GenericProfileOptions,
} from "./shared.js";
export { generateGenericProfile } from "./shared.js";

/**
 * The names of the built-in profiles shipped by this package, in alphabetical
 * order. Single source of truth: BuiltinProfile is derived from this tuple,
 * so the runtime list and the compile-time type cannot drift.
 */
export const BUILTIN_PROFILES = [
  "generic",
  "laravel",
  "lovable",
  "nextjs",
  "python",
  "rails",
] as const;

/** Names of the built-in profiles. Derived from BUILTIN_PROFILES. */
export type BuiltinProfile = (typeof BUILTIN_PROFILES)[number];

const GENERATORS = {
  generic: generateGeneric,
  laravel: generateLaravel,
  lovable: generateLovable,
  nextjs: generateNextjs,
  python: generatePython,
  rails: generateRails,
} satisfies Record<BuiltinProfile, Generator>;

/**
 * Returns the generator for a built-in profile, or undefined if `name` is not
 * a built-in. Uses Object.hasOwn so prototype-key names like "toString" do
 * not accidentally resolve to inherited methods.
 */
export function getProfileGenerator(name: string): Generator | undefined {
  if (Object.hasOwn(GENERATORS, name)) {
    return GENERATORS[name as BuiltinProfile];
  }
  return undefined;
}
