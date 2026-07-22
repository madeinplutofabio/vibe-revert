#!/usr/bin/env tsx
// scripts/refresh-license-metadata.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Provenance-recording refresh for the committed license-metadata.json cache (see
// docs/adr/0001-deterministic-license-audit.md). It is the ONLY network-touching
// step; the offline generator (regen-license-audit) consumes the cache it writes. The
// deterministic scheduling mechanics (Budget, work items, reservation eligibility,
// retry-within-a-reservation, entry builders, sort key) live in
// refresh-license-metadata-core.ts; this executable owns the network collection glue,
// the filesystem write, the CLI, progress output, and main.
//
// Work is built as CACHE-identity items (the cache is keyed by [name,version,
// integrity] for registry/tarball-url, and by packageKey for git/directory), so each
// cache entry is produced exactly once even if several lockfile package keys share a
// registry identity. Equivalent registry identities that disagree on a retrieval field
// (sourceKind/tarballUrl) fail before any network access.
//
// For each item:
//   - git / directory  -> FailedUnsupportedMetadata (mechanism unsupported; exit 0);
//   - registry / tarball-url WITHOUT integrity -> FailedRegistryMetadata,
//     integrity:null (mechanism supported, bytes unverifiable; exit 1);
//   - malformed lockfile integrity (incl. sha1-only) -> FailedRegistryMetadata
//     BEFORE any network access;
//   - registry / tarball-url WITH valid integrity -> resolve the tarball location
//     (dist.tarball for a registry identity — its dist.integrity is advisory only —
//     or the committed tarballUrl), download under the SSRF/byte/timeout controls,
//     VERIFY the bytes against the committed lockfile integrity (the sole trust
//     anchor), scan the tarball in memory for the packaged package.json + legal files,
//     require the packaged name/version to match the lockfile identity, and record
//     CollectedRegistryMetadata — else FailedRegistryMetadata.
//
// Global downloads are bounded by two RESPONSE-BODY budgets (metadata, tarball;
// counting Node-delivered body bytes, not wire/header framing), applied in
// DETERMINISTIC WAVES: items are sorted, each wave of <=6 reserves grants in item
// order, runs concurrently, then settles actual usage before the next wave — so a
// budget exhaustion denies the same items for the same inputs regardless of network
// completion order. Only reserved (grant > 0) items are settled, preserving the
// budget's exact-match reservation contract. Retries are bounded and classified,
// spend the remaining reservation, and use a fixed no-jitter delay. Output is
// deterministic (fixed key order, sorted entries, no timestamp) and written atomically;
// it is written even with failures.
//
// Invoked via `pnpm run refresh:license-metadata`. Exit codes: 0 = every registry/
// tarball-url identity collected and every git/directory recorded unsupported; 1 =
// any failed collection or a write failure; no output + 1 = graph collection failed;
// 2 = usage/config.

import { lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  GenerationError,
  LockfilePackageIdentity,
  MetadataCache,
  MetadataEntry,
} from "./license-audit-core.js";
import { collectLockfileGraph } from "./license-collector.js";
import {
  Budget,
  buildCollected,
  buildWorkItems,
  cmp,
  entrySortKey,
  failedRegistry,
  fetchWithinBudget,
  type Reservation,
  type RetryConfig,
  reserveFor,
  unsupportedEntry,
  type WorkItem,
} from "./refresh-license-metadata-core.js";
import {
  DEFAULT_NETWORK_POLICY,
  fetchTarball,
  fetchVersionMetadata,
  type NetworkPolicy,
  type ValidatedPolicy,
  validateNetworkPolicy,
} from "./refresh-registry.js";
import { parseIntegrity, verifyIntegrity } from "./refresh-sri.js";
import { DEFAULT_TARBALL_LIMITS, scanTarball, type TarballLimits } from "./refresh-tarball.js";

const METADATA_SCHEMA_VERSION = 1;
const WAVE_SIZE = 6;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const RETRY: RetryConfig = { maxAttempts: MAX_ATTEMPTS, delayMs: RETRY_DELAY_MS };
const GLOBAL_MAX_TARBALL_BYTES = 2 * 1024 * 1024 * 1024; // total tarball response-body backstop
const GLOBAL_MAX_METADATA_BYTES = 512 * 1024 * 1024; // total metadata response-body backstop

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const OUTPUT_REL = "license-metadata.json";
const OUTPUT_PATH = join(REPO_ROOT, OUTPUT_REL);
const TEMP_PATH = join(REPO_ROOT, `.license-metadata.json.tmp-${process.pid}`);

const CMD = "pnpm run refresh:license-metadata";
const USAGE = `Usage: ${CMD} -- [--registry <https-url>] [--allow-private]\n`;

function errText(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length <= 200 ? s : `${s.slice(0, 200)}… (${s.length} chars)`;
}

// -- collection -------------------------------------------------------------

interface CollectResult {
  readonly entry: MetadataEntry;
  readonly failure: boolean;
  readonly metadataUsed: number;
  readonly tarballUsed: number;
}

async function collectRegistry(
  rep: LockfilePackageIdentity,
  reservation: Reservation,
  validated: ValidatedPolicy,
  tarballLimits: TarballLimits,
): Promise<CollectResult> {
  const integrity = rep.integrity;
  if (integrity === null) {
    return {
      entry: failedRegistry(
        rep,
        null,
        null,
        "lockfile identity has no integrity; tarball bytes cannot be verified",
      ),
      failure: true,
      metadataUsed: 0,
      tarballUsed: 0,
    };
  }
  const parsed = parseIntegrity(integrity);
  if (!parsed.ok) {
    return {
      entry: failedRegistry(rep, integrity, null, `invalid lockfile integrity: ${parsed.reason}`),
      failure: true,
      metadataUsed: 0,
      tarballUsed: 0,
    };
  }
  if (reservation.tarballGrant <= 0) {
    return {
      entry: failedRegistry(
        rep,
        integrity,
        "registry-tarball",
        "global tarball response-body budget exhausted",
      ),
      failure: true,
      metadataUsed: 0,
      tarballUsed: 0,
    };
  }

  let tarballUrl: string;
  let metadataUsed = 0;
  if (rep.sourceKind === "tarball-url") {
    if (rep.tarballUrl === null) {
      return {
        entry: failedRegistry(
          rep,
          integrity,
          "registry-tarball",
          "tarball-url identity is missing its tarball URL",
        ),
        failure: true,
        metadataUsed: 0,
        tarballUsed: 0,
      };
    }
    tarballUrl = rep.tarballUrl;
  } else {
    if (reservation.metadataGrant <= 0) {
      return {
        entry: failedRegistry(
          rep,
          integrity,
          "registry-tarball",
          "global metadata response-body budget exhausted",
        ),
        failure: true,
        metadataUsed: 0,
        tarballUsed: 0,
      };
    }
    const meta = await fetchWithinBudget(
      (cap) => fetchVersionMetadata(rep.name, rep.version, { ...validated, maxMetadataBytes: cap }),
      (r) => !r.ok && r.retryable,
      reservation.metadataGrant,
      RETRY,
    );
    metadataUsed = meta.consumed;
    if (!meta.result.ok) {
      return {
        entry: failedRegistry(
          rep,
          integrity,
          "registry-tarball",
          `version metadata: ${meta.result.reason}`,
        ),
        failure: true,
        metadataUsed,
        tarballUsed: 0,
      };
    }
    tarballUrl = meta.result.tarballUrl; // meta.result.distIntegrity is advisory only
  }

  const tar = await fetchWithinBudget(
    (cap) => fetchTarball(tarballUrl, { ...validated, maxTarballBytes: cap }),
    (r) => !r.ok && r.retryable,
    reservation.tarballGrant,
    RETRY,
  );
  const tarballUsed = tar.consumed;
  if (!tar.result.ok) {
    return {
      entry: failedRegistry(
        rep,
        integrity,
        "registry-tarball",
        `tarball fetch: ${tar.result.reason}`,
      ),
      failure: true,
      metadataUsed,
      tarballUsed,
    };
  }
  const bytes = tar.result.bytes;

  const verified = verifyIntegrity(bytes, integrity);
  if (!verified.ok) {
    return {
      entry: failedRegistry(
        rep,
        integrity,
        "registry-tarball",
        `integrity verification: ${verified.reason}`,
      ),
      failure: true,
      metadataUsed,
      tarballUsed,
    };
  }
  const scan = await scanTarball(bytes, tarballLimits);
  if (!scan.ok) {
    return {
      entry: failedRegistry(rep, integrity, "registry-tarball", `tarball scan: ${scan.reason}`),
      failure: true,
      metadataUsed,
      tarballUsed,
    };
  }
  if (scan.scan.packageJson === null) {
    return {
      entry: failedRegistry(
        rep,
        integrity,
        "registry-tarball",
        "tarball has no packaged package.json",
      ),
      failure: true,
      metadataUsed,
      tarballUsed,
    };
  }
  const built = buildCollected(rep, integrity, scan.scan.packageJson, scan.scan.legalFiles);
  if (!built.ok) {
    return {
      entry: failedRegistry(rep, integrity, "registry-tarball", built.reason),
      failure: true,
      metadataUsed,
      tarballUsed,
    };
  }
  return { entry: built.entry, failure: false, metadataUsed, tarballUsed };
}

async function runWorkItem(
  w: WorkItem,
  reservation: Reservation,
  validated: ValidatedPolicy,
  tarballLimits: TarballLimits,
): Promise<CollectResult> {
  if (w.kind === "unsupported") {
    return {
      entry: unsupportedEntry(w.id, `${w.id.sourceKind} dependency is not a registry package`),
      failure: false,
      metadataUsed: 0,
      tarballUsed: 0,
    };
  }
  if (w.kind === "conflict") {
    return {
      entry: failedRegistry(w.rep, w.rep.integrity, null, w.reason),
      failure: true,
      metadataUsed: 0,
      tarballUsed: 0,
    };
  }
  return collectRegistry(w.rep, reservation, validated, tarballLimits);
}

function internalError(w: WorkItem, err: unknown): CollectResult {
  const reason = `internal error: ${errText(err)}`;
  const id = w.kind === "unsupported" ? w.id : w.rep;
  if (id.sourceKind === "git" || id.sourceKind === "directory") {
    return { entry: unsupportedEntry(id, reason), failure: true, metadataUsed: 0, tarballUsed: 0 };
  }
  return {
    entry: failedRegistry(id, id.integrity, null, reason),
    failure: true,
    metadataUsed: 0,
    tarballUsed: 0,
  };
}

// -- output -----------------------------------------------------------------

function existingOutputIsWritable(): boolean {
  try {
    const st = lstatSync(OUTPUT_PATH);
    if (!st.isFile()) {
      process.stderr.write(
        `${OUTPUT_REL} exists and is not a regular file; refusing to replace it.\n`,
      );
      return false;
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    process.stderr.write(`cannot stat ${OUTPUT_REL}: ${errText(err)}\n`);
    return false;
  }
}

function writeAtomically(bytes: Buffer): boolean {
  let created = false;
  try {
    writeFileSync(TEMP_PATH, bytes, { flag: "wx" });
    created = true;
    renameSync(TEMP_PATH, OUTPUT_PATH);
    created = false;
    return true;
  } catch (err) {
    process.stderr.write(`failed to write ${OUTPUT_REL}: ${errText(err)}\n`);
    return false;
  } finally {
    if (created) {
      try {
        unlinkSync(TEMP_PATH);
      } catch {
        // best-effort cleanup of our own temp
      }
    }
  }
}

// -- CLI --------------------------------------------------------------------

function parseArgs(
  argv: readonly string[],
): { registry?: string; allowPrivate: boolean; help: boolean } | { error: string } {
  let registry: string | undefined;
  let allowPrivate = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--allow-private") {
      allowPrivate = true;
    } else if (a === "--registry") {
      const v = argv[i + 1];
      if (v === undefined) {
        return { error: "--registry requires a URL" };
      }
      registry = v;
      i += 1;
    } else if (a?.startsWith("--registry=")) {
      registry = a.slice("--registry=".length);
    } else {
      return { error: `unknown argument: ${String(a)}` };
    }
  }
  return registry === undefined ? { allowPrivate, help } : { registry, allowPrivate, help };
}

function printErrors(errors: readonly GenerationError[]): void {
  process.stderr.write(`lockfile graph collection failed with ${errors.length} error(s):\n`);
  for (const e of errors) {
    process.stderr.write(
      `  [${e.code}]${e.package !== undefined ? ` ${e.package}:` : ""} ${e.message}\n`,
    );
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    process.stderr.write(`${args.error}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stderr.write(USAGE);
    return 0;
  }

  const graphResult = collectLockfileGraph(REPO_ROOT);
  if (!graphResult.ok) {
    printErrors(graphResult.errors);
    return 1;
  }

  const policy: NetworkPolicy = {
    ...DEFAULT_NETWORK_POLICY,
    ...(args.registry === undefined ? {} : { registryUrl: args.registry }),
    allowPrivateAddresses: args.allowPrivate,
  };
  const pv = validateNetworkPolicy(policy);
  if (!pv.ok) {
    process.stderr.write(`invalid network policy: ${pv.reason}\n`);
    return 2;
  }
  const validated = pv.validated;
  const tarballLimits: TarballLimits = DEFAULT_TARBALL_LIMITS;
  const metadataBudget = new Budget(GLOBAL_MAX_METADATA_BYTES);
  const tarballBudget = new Budget(GLOBAL_MAX_TARBALL_BYTES);

  const items = buildWorkItems(graphResult.graph);
  const results: CollectResult[] = [];
  for (let i = 0; i < items.length; i += WAVE_SIZE) {
    const wave = items.slice(i, i + WAVE_SIZE);
    const grants = wave.map((w) => reserveFor(w, metadataBudget, tarballBudget, validated));
    const waveResults = await Promise.all(
      wave.map((w, j) =>
        runWorkItem(
          w,
          grants[j] ?? { metadataGrant: 0, tarballGrant: 0 },
          validated,
          tarballLimits,
        ).catch((e: unknown) => internalError(w, e)),
      ),
    );
    waveResults.forEach((r, j) => {
      const g = grants[j] ?? { metadataGrant: 0, tarballGrant: 0 };
      if (g.metadataGrant > 0) {
        metadataBudget.settle(g.metadataGrant, r.metadataUsed);
      }
      if (g.tarballGrant > 0) {
        tarballBudget.settle(g.tarballGrant, r.tarballUsed);
      }
    });
    results.push(...waveResults);
    process.stderr.write(
      `  processed ${Math.min(i + wave.length, items.length)}/${items.length} identities\n`,
    );
  }

  const entries = results.map((r) => r.entry).sort((a, b) => cmp(entrySortKey(a), entrySortKey(b)));
  const cache: MetadataCache = { schemaVersion: METADATA_SCHEMA_VERSION, entries };
  const bytes = Buffer.from(`${JSON.stringify(cache, null, 2)}\n`, "utf8");

  if (!existingOutputIsWritable()) {
    return 1;
  }
  if (!writeAtomically(bytes)) {
    return 1;
  }

  let collected = 0;
  let unsupported = 0;
  let failed = 0;
  for (const r of results) {
    if (r.failure) {
      failed += 1;
    } else if (r.entry.collectionStatus === "collected") {
      collected += 1;
    } else {
      unsupported += 1;
    }
  }
  process.stderr.write(
    `Wrote ${OUTPUT_REL}: ${collected} collected, ${unsupported} unsupported, ${failed} failed.\n`,
  );
  for (const r of results) {
    if (r.failure) {
      const label =
        "packageKey" in r.entry ? r.entry.packageKey : `${r.entry.name}@${r.entry.version}`;
      process.stderr.write(`  ✗ ${label}: ${r.entry.collectionReason}\n`);
    }
  }
  return failed > 0 ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`refresh failed unexpectedly: ${errText(err)}\n`);
  process.exitCode = 1;
}
