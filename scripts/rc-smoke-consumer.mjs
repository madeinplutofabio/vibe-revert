// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// H13 RC-smoke consumer generator.
//
// Derives a local-tarball-closure consumer package.json from the EXACT packed
// tarballs the release workflow produced -- the same bytes that were
// checksummed and attested, never a fresh pack. This keeps the pre-publish
// smoke honest: it installs and runs the candidate bytes.
//
// The derived override closure is the local-resolution guarantee: every
// @viberevert/* dependency resolves to a packed tarball via pnpm.overrides,
// so nothing falls back to the registry regardless of whether the version is
// published. (Registry failure is merely an additional likely failure mode,
// not the guarantee.)
//
// Contract (every failure is a hard, non-zero exit):
//   - consumes <packDir> and expected <version>;
//   - requires exactly 10 *.tgz;
//   - reads each tarball's packaged package/package.json;
//   - fails on duplicate package names or any packaged version != <version>;
//   - requires exactly one unscoped `viberevert` package;
//   - maps every scoped @viberevert/* tarball into pnpm.overrides (file:);
//   - uses `viberevert: file:...` as the sole consumer dependency;
//   - writes <scratchDir>/package.json (packageManager copied from the repo
//     root so the scratch install uses the same pinned pnpm under Corepack).
//
// Usage: node scripts/rc-smoke-consumer.mjs <packDir> <version> <scratchDir>

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function fail(msg) {
  console.error(`rc-smoke-consumer: ${msg}`);
  process.exit(1);
}

const [packDirArg, version, scratchDir] = process.argv.slice(2);
if (!packDirArg || !version || !scratchDir) {
  fail("usage: rc-smoke-consumer.mjs <packDir> <version> <scratchDir>");
}
const packDir = resolve(packDirArg);

const tarballs = readdirSync(packDir)
  .filter((f) => f.endsWith(".tgz"))
  .sort();
if (tarballs.length !== 10) {
  fail(`expected exactly 10 *.tgz in ${packDir}, found ${tarballs.length}: ${tarballs.join(", ")}`);
}

const overrides = {};
const seenNames = new Set();
let cliDep = null;

for (const tgz of tarballs) {
  const abs = join(packDir, tgz);
  let manifest;
  try {
    // Read the archive from stdin (-f -) rather than by path: portable across
    // GNU/bsd tar and immune to path parsing (e.g. a Windows drive-letter colon
    // being read as a remote host:path).
    const raw = execFileSync("tar", ["-xzO", "-f", "-", "package/package.json"], {
      input: readFileSync(abs),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    manifest = JSON.parse(raw);
  } catch (err) {
    fail(`could not read package/package.json from ${tgz}: ${err.message}`);
  }
  const name = manifest.name;
  const pkgVersion = manifest.version;
  if (typeof name !== "string" || name.length === 0) {
    fail(`${tgz}: packaged package.json has no name`);
  }
  if (seenNames.has(name)) {
    fail(`duplicate package name across tarballs: ${name}`);
  }
  seenNames.add(name);
  if (pkgVersion !== version) {
    fail(`${tgz} (${name}): packaged version ${pkgVersion} != expected ${version}`);
  }
  const fileRef = `file:${abs.replace(/\\/g, "/")}`;
  if (name === "viberevert") {
    cliDep = fileRef;
  } else if (name.startsWith("@viberevert/")) {
    overrides[name] = fileRef;
  } else {
    fail(`${tgz}: unexpected package name ${name} (not viberevert or @viberevert/*)`);
  }
}

if (!cliDep) {
  fail("no unscoped `viberevert` CLI tarball found among the 10");
}

// Copy the repo-root pinned pnpm so the scratch install runs the same pnpm
// under Corepack (the scratch dir lives outside the repo tree).
const rootManifest = JSON.parse(readFileSync("package.json", "utf8"));
const packageManager = rootManifest.packageManager;
if (typeof packageManager !== "string" || !packageManager.startsWith("pnpm@")) {
  fail(`repo-root package.json packageManager must be a pnpm pin, got: ${packageManager}`);
}

const consumer = {
  name: "viberevert-rc-smoke",
  version: "0.0.0",
  private: true,
  packageManager,
  dependencies: { viberevert: cliDep },
  pnpm: { overrides },
};

const outPath = join(scratchDir, "package.json");
writeFileSync(outPath, `${JSON.stringify(consumer, null, 2)}\n`);
console.log(
  `rc-smoke-consumer: wrote ${outPath} (viberevert dep + ${Object.keys(overrides).length} overrides: ${Object.keys(overrides).join(", ")})`,
);
