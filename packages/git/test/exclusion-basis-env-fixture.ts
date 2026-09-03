// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Fixture script for exclusion-basis-environment.test.ts. NOT a test suite.
//
// The runner freezes the environment git subprocesses receive at module
// initialization, so a test cannot influence that snapshot from inside a
// process that has already imported it. This script exists to be SPAWNED with
// the environment already set, and it runs in this order:
//
//   1. import the modules, which freezes the spawned environment;
//   2. MUTATE live `process.env` for every variable default resolution reads;
//   3. capture one fingerprint;
//   4. print the frozen environment and the fingerprint as JSON.
//
// Nothing the capture produces may reflect step 2. That is the whole point of
// routing environment reads through `getGitEnvironmentVariable`: the fingerprint
// and the git subprocesses must agree on one frozen environment. If a live read
// ever creeps back into the module, this fixture's output changes and the suite
// fails.
//
// All five variables are reported so each suite case can assert its PRECONDITION
// (the spawn environment really was frozen as intended) before asserting the
// resulting fingerprint. Without that, a Windows fallback case could pass while
// its premise was never established.
//
// Usage: node --import tsx exclusion-basis-env-fixture.ts <repoRoot>

import { captureExclusionBasis } from "../src/exclusion-basis.js";
import { getGitEnvironmentVariable } from "../src/git-cli.js";

/**
 * Named constants rather than literal keys: Biome's `useLiteralKeys` would
 * rewrite `process.env["X"]` to `process.env.X`, which tsc rejects under
 * `noPropertyAccessFromIndexSignature`.
 */
const XDG_CONFIG_HOME = "XDG_CONFIG_HOME";
const HOME = "HOME";
const HOMEDRIVE = "HOMEDRIVE";
const HOMEPATH = "HOMEPATH";
const USERPROFILE = "USERPROFILE";

const repoRoot = process.argv[2];
if (repoRoot === undefined) {
  throw new Error("usage: exclusion-basis-env-fixture.ts <repoRoot>");
}

const MUTATED = "MUTATED_AFTER_IMPORT";
const RESOLUTION_VARIABLES = [XDG_CONFIG_HOME, HOME, HOMEDRIVE, HOMEPATH, USERPROFILE];
for (const name of RESOLUTION_VARIABLES) {
  process.env[name] = MUTATED;
}

// Reported so the suite can prove the mutation ACTUALLY RAN. Without it, the
// freeze assertions would still pass if these lines were ever deleted, which
// would quietly turn the environment-authority test into a tautology.
const liveEnvironmentMutated = RESOLUTION_VARIABLES.every((name) => process.env[name] === MUTATED);

const basis = await captureExclusionBasis(repoRoot);

process.stdout.write(
  JSON.stringify({
    liveEnvironmentMutated,
    frozenEnvironment: {
      xdgConfigHome: getGitEnvironmentVariable(XDG_CONFIG_HOME) ?? null,
      home: getGitEnvironmentVariable(HOME) ?? null,
      homeDrive: getGitEnvironmentVariable(HOMEDRIVE) ?? null,
      homePath: getGitEnvironmentVariable(HOMEPATH) ?? null,
      userProfile: getGitEnvironmentVariable(USERPROFILE) ?? null,
    },
    basis,
  }),
);
