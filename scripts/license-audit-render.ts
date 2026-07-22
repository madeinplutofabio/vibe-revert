// scripts/license-audit-render.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// Pure Markdown renderer for the M H5 license audit model (see
// docs/adr/0001-deterministic-license-audit.md). No I/O, no execution on import.
// Output is deterministic and carries no timestamp. Every dynamic value is
// display-escaped (C0 controls, DEL, and non-ASCII rendered as \uXXXX; table cells
// also escape `|`) and wrapped in a variable-length backtick code span that
// preserves bordering spaces and backticks, so a hostile package's metadata can
// never break the document or inject Markdown. The escaping is display-only; the
// committed cache value is never altered. The renderer sorts its inputs defensively
// so its output never depends on caller array order.

import type {
  AuditModel,
  Disposition,
  IdentityMetadata,
  JsonValue,
  Posture,
  ReportRow,
  UnresolvedPeerRoot,
} from "./license-audit-core.js";

const DISPOSITION_ORDER: readonly Disposition[] = [
  "allowed",
  "allowed-with-obligations",
  "review-required",
  "disallowed",
];
const POSTURE_ORDER: readonly Posture[] = [
  "production",
  "optional-production",
  "peer",
  "development",
];
const EMPTY = "—";
const SEE_DETAIL = "(conflict — see detail)";

// -- ordering ----------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareStringArrays(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmp(a[i] as string, b[i] as string);
    if (c !== 0) {
      return c;
    }
  }
  return a.length - b.length;
}

function sortPostures(postures: readonly Posture[]): Posture[] {
  return [...postures].sort((a, b) => POSTURE_ORDER.indexOf(a) - POSTURE_ORDER.indexOf(b));
}

// -- display escaping --------------------------------------------------------

function escapeChar(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/** Escape C0 controls, DEL, and non-ASCII code units; keep printable ASCII. */
function escapeNonPrintable(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code < 0x20 || code === 0x7f || code > 0x7e ? escapeChar(code) : s.charAt(i);
  }
  return out;
}

/** Like escapeNonPrintable, but also escapes `|` so a value is safe inside a GFM
 *  table cell even within a code span. */
function escapeForCell(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out +=
      code < 0x20 || code === 0x7f || code > 0x7e || code === 0x7c ? escapeChar(code) : s.charAt(i);
  }
  return out;
}

/** Wrap already-display-safe text in a code span whose backtick fence is longer
 *  than the longest backtick run, padding when the content is empty or borders a
 *  backtick or space (which CommonMark would otherwise strip). */
function codeSpan(displaySafe: string): string {
  let maxRun = 0;
  let cur = 0;
  for (const ch of displaySafe) {
    if (ch === "`") {
      cur += 1;
      if (cur > maxRun) {
        maxRun = cur;
      }
    } else {
      cur = 0;
    }
  }
  const fence = "`".repeat(maxRun + 1);
  const needsPadding =
    displaySafe.length === 0 ||
    displaySafe.startsWith("`") ||
    displaySafe.endsWith("`") ||
    displaySafe.startsWith(" ") ||
    displaySafe.endsWith(" ");
  const pad = needsPadding ? " " : "";
  return `${fence}${pad}${displaySafe}${pad}${fence}`;
}

/** A code span safe for inline (non-table) use. */
function inlineCode(value: string): string {
  return codeSpan(escapeNonPrintable(value));
}

/** A table cell: em dash when empty, else a pipe-safe code span. */
function cell(value: string): string {
  return value.length === 0 ? EMPTY : codeSpan(escapeForCell(value));
}

function numberCell(value: number): string {
  return cell(String(value));
}

/** A single-line, injection-safe rendering of an arbitrary JSON value. */
function renderJson(value: JsonValue): string {
  return codeSpan(escapeNonPrintable(JSON.stringify(value)));
}

function renderRawLicense(present: boolean, value: JsonValue): string {
  return present ? renderJson(value) : "(license field absent)";
}

function joinInline(values: readonly string[]): string {
  return values.length === 0
    ? EMPTY
    : [...values]
        .sort(cmp)
        .map((v) => inlineCode(v))
        .join(", ");
}

function joinCell(values: readonly string[]): string {
  return values.length === 0
    ? EMPTY
    : [...values]
        .sort(cmp)
        .map((v) => cell(v))
        .join("; ");
}

// -- sections ----------------------------------------------------------------

function needsDetail(row: ReportRow): boolean {
  return (
    row.metadataConflict ||
    row.policyDisposition === "review-required" ||
    row.policyDisposition === "disallowed"
  );
}

function countBy<K extends string>(
  order: readonly K[],
  keyOf: (row: ReportRow) => K,
  rows: readonly ReportRow[],
): Map<K, number> {
  const counts = new Map<K, number>();
  for (const k of order) {
    counts.set(k, 0);
  }
  for (const row of rows) {
    const k = keyOf(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function renderInputs(model: AuditModel): string[] {
  return [
    "## Inputs",
    "",
    "| Input | Value |",
    "| --- | --- |",
    `| Generator schema version | ${numberCell(model.generatorSchemaVersion)} |`,
    `| pnpm-lock.yaml SHA-256 | ${cell(model.hashes.lockfileSha256)} |`,
    `| Workspace manifests digest (SHA-256) | ${cell(model.hashes.manifestsSha256)} |`,
    `| license-policy.json SHA-256 | ${cell(model.hashes.policySha256)} |`,
    `| license-metadata.json SHA-256 | ${cell(model.hashes.metadataSha256)} |`,
    `| Reachable snapshot instances | ${numberCell(model.reachableSnapshotInstanceCount)} |`,
    `| Aggregated package rows | ${numberCell(model.aggregatedPackageRowCount)} |`,
    "",
  ];
}

function renderSummary(
  rows: readonly ReportRow[],
  firstParty: readonly string[],
  unresolvedPeers: readonly UnresolvedPeerRoot[],
): string[] {
  const byDisposition = countBy(DISPOSITION_ORDER, (r) => r.policyDisposition, rows);
  const byPosture = countBy(POSTURE_ORDER, (r) => r.primaryPosture, rows);
  const rowsNeedingReview = rows.filter(needsDetail).length;
  const lines: string[] = [
    "## Summary",
    "",
    `- Third-party packages: ${numberCell(rows.length)}`,
    `- First-party workspace packages: ${numberCell(firstParty.length)}`,
    `- Unresolved peer obligations: ${numberCell(unresolvedPeers.length)}`,
    "",
    "### Dispositions",
    "",
    "| Disposition | Count |",
    "| --- | --- |",
  ];
  for (const d of DISPOSITION_ORDER) {
    lines.push(`| ${cell(d)} | ${numberCell(byDisposition.get(d) ?? 0)} |`);
  }
  lines.push("", "### Postures", "", "| Posture | Count |", "| --- | --- |");
  for (const p of POSTURE_ORDER) {
    lines.push(`| ${cell(p)} | ${numberCell(byPosture.get(p) ?? 0)} |`);
  }
  lines.push(
    "",
    "### Requires review",
    "",
    `- Package rows needing review (conflict, review-required, or disallowed): ${numberCell(rowsNeedingReview)}`,
    `- Unresolved peer obligations (consumer-supplied, counted independently): ${numberCell(unresolvedPeers.length)}`,
    "",
  );
  return lines;
}

function renderTable(rows: readonly ReportRow[]): string[] {
  const lines: string[] = [
    "## Third-party packages",
    "",
    "| Name | Version | Posture | Disposition | Normalized SPDX | Obligations | Conflict |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  if (rows.length === 0) {
    lines.push("| None. | | | | | | |");
  }
  for (const row of rows) {
    const normalized =
      row.aggregate === null
        ? SEE_DETAIL
        : row.aggregate.normalizedSpdx !== null
          ? cell(row.aggregate.normalizedSpdx)
          : EMPTY;
    const obligations = row.aggregate === null ? SEE_DETAIL : joinCell(row.aggregate.obligations);
    lines.push(
      `| ${cell(row.name)} | ${cell(row.version)} | ${cell(row.primaryPosture)} | ${cell(row.policyDisposition)} | ${normalized} | ${obligations} | ${cell(row.metadataConflict ? "yes" : "no")} |`,
    );
  }
  lines.push("");
  return lines;
}

function renderVariant(variant: IdentityMetadata): string[] {
  return [
    `  - Identity ${inlineCode(variant.packageKey)} (integrity ${inlineCode(variant.integrity)}):`,
    `    - Raw license: ${renderRawLicense(variant.rawLicensePresent, variant.rawLicense)}`,
    `    - Normalized SPDX: ${variant.normalizedSpdx !== null ? inlineCode(variant.normalizedSpdx) : EMPTY}`,
    `    - Disposition: ${inlineCode(variant.policyDisposition)}`,
    `    - Obligations: ${joinInline(variant.obligations)}`,
    `    - Packaged legal files: ${joinInline(variant.packagedLegalFiles)}`,
  ];
}

function renderDetail(rows: readonly ReportRow[]): string[] {
  const lines: string[] = ["## Details (conflict, review-required, or disallowed)", ""];
  const detailed = rows.filter(needsDetail);
  if (detailed.length === 0) {
    lines.push("None.", "");
    return lines;
  }
  for (const row of detailed) {
    lines.push(`### ${inlineCode(`${row.name}@${row.version}`)}`, "");
    lines.push(`- Disposition: ${inlineCode(row.policyDisposition)}`);
    lines.push(`- Metadata conflict: ${inlineCode(row.metadataConflict ? "yes" : "no")}`);
    if (row.metadataConflict) {
      lines.push(`- Conflict reasons: ${joinInline(row.metadataConflictReasons)}`);
    }
    const reaching = sortPostures(row.reachingPostures);
    lines.push(
      `- Reaching postures: ${reaching.length === 0 ? EMPTY : reaching.map((p) => inlineCode(p)).join(", ")}`,
    );
    lines.push(`- Direct parents: ${joinInline(row.provenance.directParents)}`);
    lines.push(`- Originating importers: ${joinInline(row.provenance.originatingImporters)}`);
    lines.push("- Reached via:");
    const paths = [...row.provenance.shortestPaths].sort(
      (a, b) =>
        POSTURE_ORDER.indexOf(a.posture) - POSTURE_ORDER.indexOf(b.posture) ||
        cmp(a.path.importerPath, b.path.importerPath) ||
        cmp(a.path.rootDependency, b.path.rootDependency) ||
        compareStringArrays(a.path.snapshotKeys, b.path.snapshotKeys),
    );
    for (const pp of paths) {
      const chain = pp.path.snapshotKeys.map((k) => inlineCode(k)).join(" -> ");
      lines.push(
        `  - ${inlineCode(pp.posture)}: importer ${inlineCode(pp.path.importerPath)} declares ${inlineCode(pp.path.rootDependency)} -> ${chain}`,
      );
    }
    lines.push("- Package identities:");
    const variants = [...row.variants].sort((a, b) => cmp(a.packageKey, b.packageKey));
    for (const variant of variants) {
      lines.push(...renderVariant(variant));
    }
    lines.push("");
  }
  return lines;
}

function renderFirstParty(firstParty: readonly string[]): string[] {
  const lines: string[] = ["## First-party workspace packages", ""];
  if (firstParty.length === 0) {
    lines.push("None.", "");
    return lines;
  }
  for (const name of firstParty) {
    lines.push(`- ${inlineCode(name)}`);
  }
  lines.push("");
  return lines;
}

function renderUnresolvedPeers(peers: readonly UnresolvedPeerRoot[]): string[] {
  const lines: string[] = ["## Unresolved peer obligations", ""];
  if (peers.length === 0) {
    lines.push("None.", "");
    return lines;
  }
  lines.push("| Importer | Dependency | Declared spec |", "| --- | --- | --- |");
  for (const peer of peers) {
    lines.push(`| ${cell(peer.importerPath)} | ${cell(peer.name)} | ${cell(peer.declaredSpec)} |`);
  }
  lines.push("");
  return lines;
}

export function renderAuditModel(model: AuditModel): string {
  const rows = [...model.rows].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
  const firstParty = [...model.firstParty].sort(cmp);
  const unresolvedPeers = [...model.unresolvedPeers].sort(
    (a, b) =>
      cmp(a.importerPath, b.importerPath) ||
      cmp(a.name, b.name) ||
      cmp(a.declaredSpec, b.declaredSpec),
  );

  const lines: string[] = [
    "# License Audit",
    "",
    "<!-- GENERATED FILE — do not edit by hand. Regenerate with `pnpm run regen:license-audit`. -->",
    "<!-- Authoritative inputs: committed pnpm-lock.yaml + workspace manifests + license-policy.json + license-metadata.json. -->",
    "",
    ...renderInputs(model),
    ...renderSummary(rows, firstParty, unresolvedPeers),
    ...renderTable(rows),
    ...renderDetail(rows),
    ...renderFirstParty(firstParty),
    ...renderUnresolvedPeers(unresolvedPeers),
    "## Disclaimer",
    "",
    "This audit is generated by a scanner from committed inputs. Detected licenses are factual,",
    "best-effort observations from packaged metadata — not legal advice and not proof of SPDX",
    "registration. Dispositions are this repository's own policy, not a legal determination. A",
    "`review-required` or `disallowed` row, a metadata conflict, or an unresolved peer obligation",
    "means human review is needed; it is not an automated legal judgment.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}
