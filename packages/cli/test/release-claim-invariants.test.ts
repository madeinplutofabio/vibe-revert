// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori
//
// H12.1 (H-FP1) — release-claim invariants. A first-class release blocker: guarded
// public copy must not overclaim relative to what VibeRevert records/checks/restores,
// or relative to a VALIDATED support.yml.
//
// Invariant: a claim is judged by the SPECIFIC PREDICATE that makes it dangerous — not
// by whether some negation, limitation heading, platform name, or maturity word appears
// elsewhere nearby. Bounded, rule-specific matchers; no general prose parser.
//   - logical Markdown units (joined paragraphs + lazily-continued list items), never
//     physical lines; a source-line map keeps physical-line diagnostics;
//   - inline Markdown normalized (emphasis/backticks removed, link+image visible text
//     kept & destinations dropped, HTML tags removed); fenced (``` / ~~~) code and
//     HTML-comment spans (multi-line included) masked before unit-building;
//   - clauses split only on sentence boundaries, `;`, em dashes, spaced `--`, and
//     adversatives (but/however/yet/whereas) — never additive and/or;
//   - each danger matcher explicit, EVERY match inspected; verb-initial dangers need a
//     negation in the 3 tokens before the verb; predicative dangers accept an earlier
//     negation only until a new finite predicate verb or relative pronoun resets scope;
//   - platform + PTY-maturity claims are DIRECTIONAL, anchored on the claim's subject
//     (PTY ... on <platform>), never distance-based; macOS caveat is predicate-shaped;
//   - diagnostics report the physical line and a bounded window around the match.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validateSupportManifest } from "../../../scripts/support-manifest-core.js";
import { parseSupportManifest } from "../../../scripts/support-manifest-parser.js";

const REPO_ROOT_URL = new URL("../../../", import.meta.url);
const GUARDED_SURFACES = ["README.md", "packages/cli/README.md"] as const;

// --- support.yml facts (parse → VALIDATE → extract) ---
interface RawManifest {
  features?: {
    core_non_live_pty?: { maturity?: string; platforms?: Record<string, unknown> };
    live_pty_interception?: {
      maturity?: string;
      platforms?: Record<string, { disposition?: string }>;
    };
  };
}
interface ManifestFacts {
  general: ReadonlySet<string>;
  pty: ReadonlyMap<string, string>;
  coreMaturity: string;
  ptyMaturity: string;
}
function loadFacts(): ManifestFacts {
  const parsed = parseSupportManifest(readFileSync(new URL("support.yml", REPO_ROOT_URL), "utf8"));
  const errors = validateSupportManifest(parsed);
  if (errors.length > 0)
    throw new Error(`support.yml failed validation: ${errors.map((e) => e.code).join(", ")}`);
  const feats = (parsed as RawManifest).features ?? {};
  const general = new Set<string>(Object.keys(feats.core_non_live_pty?.platforms ?? {}));
  const pty = new Map<string, string>();
  for (const [p, v] of Object.entries(feats.live_pty_interception?.platforms ?? {}))
    pty.set(p, v.disposition ?? "");
  return {
    general,
    pty,
    coreMaturity: feats.core_non_live_pty?.maturity ?? "",
    ptyMaturity: feats.live_pty_interception?.maturity ?? "",
  };
}
const FACTS = loadFacts();

// --- lexical helpers ---
const PTY_PRESENT = /\bpty\b/i;
const NEG_WORDS = new Set([
  "not",
  "no",
  "never",
  "cannot",
  "cant",
  "can't",
  "doesnt",
  "doesn't",
  "dont",
  "don't",
  "isnt",
  "isn't",
  "arent",
  "aren't",
  "wont",
  "won't",
  "without",
  "nor",
  "neither",
  "none",
]);
const STOP_VERBS = new Set([
  "provides",
  "provide",
  "offers",
  "offer",
  "enables",
  "enable",
  "guarantees",
  "guarantee",
  "claims",
  "claim",
  "becomes",
  "become",
  "makes",
  "make",
  "works",
  "work",
  "supports",
  "support",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
]);
const RELATIVE_WORDS = new Set(["that", "which", "who", "whom", "whose", "where", "when"]);
const CLAUSE_BOUNDARY = /(?:\.\s+|;\s*|\s+—\s+|—|\s+--\s+|\s+(?:but|however|yet|whereas)\s+)/gi;

function words(s: string): string[] {
  return s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[^\w']/g, "").toLowerCase());
}
function verbNegated(before: string): boolean {
  return words(before)
    .slice(-3)
    .some((w) => NEG_WORDS.has(w));
}
function predicativeNegated(before: string): boolean {
  const ws = words(before);
  for (let i = ws.length - 1; i >= 0; i--) {
    const w = ws[i];
    if (w === undefined || w === "") continue;
    if (NEG_WORDS.has(w)) return true;
    if (STOP_VERBS.has(w) || RELATIVE_WORDS.has(w)) return false;
  }
  return false;
}
function postposedDisclaimed(after: string): boolean {
  return (
    /^\s*(?:,?\s*(?:which|that)\s+)?(?:is|are|isn't|aren't)\s+not\s+(?:supported|available|possible|implemented|offered|provided)\b/i.test(
      after,
    ) || /^\s*(?:is|are)\s+(?:unsupported|unavailable)\b/i.test(after)
  );
}

interface Danger {
  ruleId: string;
  pattern: RegExp;
  kind: "verb" | "predicative";
  clauseGuard?: RegExp;
}
const DANGERS: readonly Danger[] = [
  {
    ruleId: "CLAIM-PTY-SANDBOX",
    pattern: /\b(?:secure|security)\s+sandbox\b/i,
    kind: "predicative",
  },
  {
    ruleId: "CLAIM-PTY-SANDBOX",
    pattern: /\bsandbox(?:ing|es|ed)?\s+(?:every|all|any)\b/i,
    kind: "verb",
  },
  {
    ruleId: "CLAIM-PTY-SANDBOX",
    pattern: /\bcomplete\s+(?:security|(?:command\s+)?interception)\b/i,
    kind: "predicative",
  },
  {
    ruleId: "CLAIM-PTY-SANDBOX",
    pattern: /\b(?:fully|completely)\s+secure\b/i,
    kind: "predicative",
  },
  {
    ruleId: "CLAIM-PTY-SANDBOX",
    pattern: /\bsandbox(?:ing|es|ed)?\b/i,
    kind: "predicative",
    clauseGuard: PTY_PRESENT,
  },
  {
    ruleId: "CLAIM-PTY-SANDBOX",
    pattern: /\bsecure\b/i,
    kind: "predicative",
    clauseGuard: PTY_PRESENT,
  },
  {
    ruleId: "CLAIM-PTY-SANDBOX",
    pattern: /\bcomplete\b/i,
    kind: "predicative",
    clauseGuard: PTY_PRESENT,
  },
  {
    ruleId: "CLAIM-RECOVERY-GUARANTEE",
    pattern: /\bundo(?:es|ing)?\s+everything\b/i,
    kind: "verb",
  },
  {
    ruleId: "CLAIM-RECOVERY-GUARANTEE",
    pattern: /\brestor(?:e|es|ed|ing)\s+everything\b/i,
    kind: "verb",
  },
  {
    ruleId: "CLAIM-RECOVERY-GUARANTEE",
    pattern: /\bguarantee(?:s|d|ing)?\s+(?:full\s+|complete\s+|total\s+)?recover\w+\b/i,
    kind: "verb",
  },
  {
    ruleId: "CLAIM-RECOVERY-GUARANTEE",
    pattern: /\bguaranteed\s+recovery\b/i,
    kind: "predicative",
  },
  {
    ruleId: "CLAIM-RECOVERY-GUARANTEE",
    pattern: /\brecovery\s+is\s+guaranteed\b/i,
    kind: "predicative",
  },
  {
    ruleId: "CLAIM-RECOVERY-GUARANTEE",
    pattern: /\bnever\s+los(?:e|es|ing)\s+(?:your\s+|any\s+)?work\b/i,
    kind: "predicative",
  },
  {
    ruleId: "CLAIM-RECOVERY-GUARANTEE",
    pattern: /\breverse(?:s|d)?\s+any\s+(?:ai\s+)?(?:mistake|change|error)s?\b/i,
    kind: "verb",
  },
  {
    ruleId: "CLAIM-RISK-PREVENTION",
    pattern:
      /\b(?:block|blocks|blocked|prevent|prevents|prevented|stop|stops|stopped)\b\s+(?:\w+\s+){0,3}?\b(?:all|every|any)\b\s+(?:\w+\s+){0,2}?\b(?:risky|dangerous|risk|mistake|change|edit)/i,
    kind: "verb",
  },
  {
    ruleId: "CLAIM-EXTERNAL-EFFECTS",
    pattern:
      /\b(?:reverse|reverses|reversed|reversing|undo|undoes|undoing|rolls?\s?back|rolled\s?back|restore|restores|restored|restoring)\b\s+(?:\w+\s+){0,6}?\b(?:deployment|deploy|database|db\b|api\s+call|api-call|email|payment|remote\s+system|production|external\s+(?:side\s+)?effects?|external\s+state)/i,
    kind: "verb",
  },
];

const CAVEAT =
  /(?:\b(?:when|if|once|where)\b[^.;]{0,40}\b(?:prerequisit\w+|present|allocat\w+|provisioned|met|available)\b)|(?:\bcapabilit\w*[-\s]gated\b)|(?:\brequires?\b[^.;]{0,30}\bprerequisit\w+)|(?:\bavailability\b[^.;]{0,30}\bdepends\b)|(?:\bdepends\s+on\b[^.;]{0,30}\ballocation\b)|(?:\bonly\b[^.;]{0,25}\bprovisioned\b)/i;
const PTY_FEATURE_PATTERNS: readonly RegExp[] = [
  /\bpty\b[^.;]{0,30}?\b(?:works?|available|supported|enabled?|runs?)\b/i,
  /\bpty\b[^.;]{0,25}?\bis\b[^.;]{0,25}?\b(?:bridge|mode|feature|session|terminal|shell)\b/i,
  /\b(?:use|using|enabl\w+|run|running|opt[-\s]?in)\b[^.;]{0,20}?\bpty\b/i,
];
const PLATFORMS: readonly { platform: string; names: readonly string[] }[] = [
  { platform: "windows", names: ["windows"] },
  { platform: "macos", names: ["macos", "mac os", "os x", "mac"] },
  { platform: "linux", names: ["linux", "ubuntu", "debian", "fedora", "arch linux"] },
  { platform: "freebsd", names: ["freebsd"] },
  { platform: "openbsd", names: ["openbsd"] },
  { platform: "netbsd", names: ["netbsd"] },
  { platform: "android", names: ["android"] },
  { platform: "ios", names: ["ios"] },
  { platform: "solaris", names: ["solaris"] },
];
function nameAlt(names: readonly string[]): string {
  return names.map((n) => n.replace(/ /g, "\\s+")).join("|");
}

interface ClaimViolation {
  file: string;
  line: number;
  clause: string;
  ruleId: string;
}
interface Segment {
  line: number;
  text: string;
}
interface Unit {
  segments: Segment[];
  headings: string[];
}

// Mask HTML comment spans (multi-line included) with spaces, preserving newlines so
// source-line numbers are stable and visible text before `<!--` / after `-->` survives.
function maskComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

function normalizeInline(s: string): string {
  let t = s.replace(/^(?:\s*>)+\s?/, "");
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\*([^*]+)\*/g, "$1");
  return t.replace(/\s+/g, " ").trim();
}

function buildUnits(text: string): Unit[] {
  const lines = maskComments(text).split(/\r?\n/);
  const units: Unit[] = [];
  const stack: { level: number; text: string }[] = [];
  let inFence = false;
  let fenceChar = "";
  let open: { segs: Segment[]; isList: boolean } | null = null;
  const close = (): void => {
    if (open) {
      units.push({ segments: open.segs, headings: stack.map((s) => s.text) });
      open = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const fence = /^\s*(```+|~~~+)/.exec(raw);
    if (fence) {
      const tok = fence[1];
      if (tok !== undefined) {
        const ch = tok[0] ?? "";
        if (!inFence) {
          close();
          inFence = true;
          fenceChar = ch;
        } else if (ch === fenceChar) inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const line = raw.replace(/^(?:\s*>)+\s?/, "");
    if (line.trim() === "") {
      close();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const marks = heading[1];
      const body = heading[2];
      if (marks !== undefined && body !== undefined) {
        close();
        const level = marks.length;
        while (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top !== undefined && top.level >= level) stack.pop();
          else break;
        }
        const htext = normalizeInline(body);
        stack.push({ level, text: htext });
        units.push({
          segments: [{ line: i + 1, text: htext }],
          headings: stack.map((s) => s.text),
        });
      }
      continue;
    }
    if (/^\s*\|/.test(line)) {
      close();
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue;
      for (const cell of line
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)) {
        units.push({
          segments: [{ line: i + 1, text: normalizeInline(cell) }],
          headings: stack.map((s) => s.text),
        });
      }
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const body = bullet[1];
      if (body !== undefined) {
        close();
        open = { segs: [{ line: i + 1, text: normalizeInline(body) }], isList: true };
      }
      continue;
    }
    // paragraph line OR lazy continuation of an open list item / paragraph
    if (open) open.segs.push({ line: i + 1, text: normalizeInline(line) });
    else open = { segs: [{ line: i + 1, text: normalizeInline(line) }], isList: false };
  }
  close();
  return units;
}

function joinUnit(unit: Unit): { text: string; lineAt: number[] } {
  let text = "";
  const lineAt: number[] = [];
  unit.segments.forEach((s, idx) => {
    if (idx > 0) {
      text += " ";
      lineAt.push(s.line);
    }
    for (const ch of s.text) {
      text += ch;
      lineAt.push(s.line);
    }
  });
  return { text, lineAt };
}
function lineOf(lineAt: number[], off: number): number {
  return lineAt[Math.max(0, Math.min(off, lineAt.length - 1))] ?? 1;
}
function clausesOf(text: string): { text: string; start: number }[] {
  const res: { text: string; start: number }[] = [];
  const re = new RegExp(CLAUSE_BOUNDARY.source, "gi");
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const w0 = m[0] ?? "";
    if (w0.length === 0) {
      re.lastIndex++;
      continue;
    }
    res.push({ text: text.slice(last, m.index), start: last });
    last = m.index + w0.length;
  }
  res.push({ text: text.slice(last), start: last });
  return res;
}
function ptyFeatureClaim(clause: string): RegExpExecArray | null {
  if (!PTY_PRESENT.test(clause)) return null;
  for (const p of PTY_FEATURE_PATTERNS) {
    const m = p.exec(clause);
    if (!m) continue;
    if (/\b(?:no|not|never|without)\b/i.test(m[0] ?? "")) continue;
    if (verbNegated(clause.slice(0, m.index))) continue;
    return m;
  }
  return null;
}

function analyzeClaims(text: string, file: string): ClaimViolation[] {
  const out: ClaimViolation[] = [];
  const seen = new Set<string>();
  const report = (line: number, ct: string, idx: number, ruleId: string): void => {
    const key = `${line}:${ruleId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, line, clause: ct.slice(Math.max(0, idx - 60), idx + 100).trim(), ruleId });
  };
  for (const unit of buildUnits(text)) {
    const { text: uText, lineAt } = joinUnit(unit);
    const labeled =
      /\bexperimental\b/i.test(uText) || unit.headings.some((h) => /\bexperimental\b/i.test(h));
    let featureLine = -1;
    let featureClause = "";
    let featureIdx = 0;
    for (const clause of clausesOf(uText)) {
      const ct = clause.text;
      for (const d of DANGERS) {
        if (d.clauseGuard && !d.clauseGuard.test(ct)) continue;
        const g = new RegExp(
          d.pattern.source,
          d.pattern.flags.includes("g") ? d.pattern.flags : `${d.pattern.flags}g`,
        );
        for (let m = g.exec(ct); m !== null; m = g.exec(ct)) {
          const w0 = m[0] ?? "";
          if (w0.length === 0) {
            g.lastIndex++;
            continue;
          }
          if (postposedDisclaimed(ct.slice(m.index + w0.length))) continue;
          const before = ct.slice(0, m.index);
          if (d.kind === "verb" ? verbNegated(before) : predicativeNegated(before)) continue;
          report(lineOf(lineAt, clause.start + m.index), ct, m.index, d.ruleId);
          break;
        }
      }
      scanPlatform(ct, clause.start, lineAt, report);
      if (featureLine < 0) {
        const fm = ptyFeatureClaim(ct);
        if (fm) {
          featureLine = lineOf(lineAt, clause.start + fm.index);
          featureClause = ct;
          featureIdx = fm.index;
        }
      }
    }
    if (featureLine >= 0 && !labeled)
      report(featureLine, featureClause, featureIdx, "CLAIM-EXPERIMENTAL-LABEL");
  }
  return out;
}

function scanPlatform(
  ct: string,
  absStart: number,
  lineAt: number[],
  report: (line: number, ct: string, idx: number, ruleId: string) => void,
): void {
  const um = /\b(?:every|all|any)\s+(supported\s+)?(?:platform|operating\s+system)s?\b/i.exec(ct);
  if (um && um[1] === undefined && !verbNegated(ct.slice(0, um.index)))
    report(lineOf(lineAt, absStart + um.index), ct, um.index, "CLAIM-PLATFORM-SUPPORT");
  const hasPty = PTY_PRESENT.test(ct);
  for (const pf of PLATFORMS) {
    const alt = nameAlt(pf.names);
    const on = `\\bon\\s+(?:${alt})\\b`;
    if (!FACTS.general.has(pf.platform)) {
      const genA = new RegExp(`\\b(?:runs?|works?|installs?)\\b\\s+${on}`, "i").exec(ct);
      const genA2 = new RegExp(`\\b(?:is|are)\\s+available\\s+${on}`, "i").exec(ct);
      const genC = new RegExp(`\\bsupports?\\b\\s+(?:${alt})\\b`, "i").exec(ct);
      const genB = new RegExp(
        `\\b(?:${alt})\\b\\s+(?:is|are)\\s+(?:supported|available)\\b`,
        "i",
      ).exec(ct);
      let hit: RegExpExecArray | null = null;
      if (genA && !verbNegated(ct.slice(0, genA.index))) hit = genA;
      else if (genA2 && !verbNegated(ct.slice(0, genA2.index))) hit = genA2;
      else if (genC && !verbNegated(ct.slice(0, genC.index))) hit = genC;
      else if (genB) hit = genB;
      if (hit)
        report(lineOf(lineAt, absStart + hit.index), ct, hit.index, "CLAIM-PLATFORM-SUPPORT");
    }
    if (hasPty && FACTS.pty.has(pf.platform)) {
      const disp = FACTS.pty.get(pf.platform);
      const s1 = new RegExp(
        `\\bpty\\b\\s+(?:works?|runs?|is\\s+(?:available|supported|enabled))\\s+${on}`,
        "i",
      ).exec(ct);
      const s2 = new RegExp(
        `\\bpty\\b\\s+(?:is|are)\\s+(?:[a-z][a-z-]*\\s+){1,3}?(?:and|or)\\s+(?:works?|runs?|available|supported|enabled|is\\s+(?:available|supported|enabled))\\s+${on}`,
        "i",
      ).exec(ct);
      const s3 = new RegExp(
        `\\b(?:${alt})\\b\\s+(?:supports?|provides?)\\s+[^.;]{0,20}?\\bpty\\b`,
        "i",
      ).exec(ct);
      const hit = s1 ?? s2 ?? s3;
      if (hit) {
        if (disp === "not_applicable")
          report(lineOf(lineAt, absStart + hit.index), ct, hit.index, "CLAIM-PLATFORM-SUPPORT");
        else if (disp === "capability_gated" && !CAVEAT.test(ct))
          report(lineOf(lineAt, absStart + hit.index), ct, hit.index, "CLAIM-PLATFORM-SUPPORT");
      }
    }
  }
}

function analyzeSurface(rel: string): ClaimViolation[] {
  return analyzeClaims(readFileSync(new URL(rel, REPO_ROOT_URL), "utf8"), rel);
}
function ids(md: string): string[] {
  return analyzeClaims(md, "<synthetic>").map((v) => v.ruleId);
}
function expectViolation(md: string, ruleId: string): void {
  expect(ids(md), `expected ${ruleId} in: ${md.trim()}`).toContain(ruleId);
}
function expectClean(md: string): void {
  expect(analyzeClaims(md, "<synthetic>"), `expected no violations in: ${md.trim()}`).toEqual([]);
}

describe("release-claim invariants (H-FP1)", () => {
  it("the real guarded public surfaces make no forbidden claims", () => {
    for (const surface of GUARDED_SURFACES) {
      const v = analyzeSurface(surface);
      expect(v, `${surface}: ${JSON.stringify(v)}`).toEqual([]);
    }
  });

  it("honest caveats and non-claims PASS", () => {
    expectClean("PTY mode is not a sandbox.\n");
    expectClean(
      "It is a prompt-level safety net, never security enforcement or complete command interception.\n",
    );
    expectClean("PTY sandboxing is not supported.\n");
    expectClean(
      "PTY is experimental and available on macOS when the documented prerequisites are present.\n",
    );
    expectClean("FreeBSD is not supported.\n");
    expectClean("See the FreeBSD compatibility issue.\n");
    expectClean("no PTY\n");
    expectClean("See the PTY contract.\n");
    expectClean("Do not use PTY.\n");
    expectClean("Do not enable PTY on this host.\n");
    expectClean("VibeRevert does not reverse deployments, database writes, or API calls.\n");
    expectClean("VibeRevert does not undo external effects.\n");
    expectClean("Recovery is not guaranteed.\n");
    expectClean("Plain shell works on every supported platform.\n");
    expectClean("PTY is experimental, and core commands work on Windows.\n");
    expectClean("PTY is experimental and core commands work on Windows.\n");
    expectClean("See the FreeBSD issue and VibeRevert runs on Linux.\n");
  });

  it("affirmative overclaims FAIL", () => {
    expectViolation(
      "VibeRevert is not a cloud service that guarantees recovery of everything.\n",
      "CLAIM-RECOVERY-GUARANTEE",
    );
    expectViolation(
      "VibeRevert does not require internet, and guarantees recovery of everything.\n",
      "CLAIM-RECOVERY-GUARANTEE",
    );
    expectViolation(
      "VibeRevert does not guarantee recovery and guarantees full recovery.\n",
      "CLAIM-RECOVERY-GUARANTEE",
    );
    expectViolation("VibeRevert is restoring everything.\n", "CLAIM-RECOVERY-GUARANTEE");
    expectViolation("Recovery is guaranteed.\n", "CLAIM-RECOVERY-GUARANTEE");
    expectViolation(
      "PTY is experimental, not a sandbox and provides complete security.\n",
      "CLAIM-PTY-SANDBOX",
    );
    expectViolation("PTY is complete.\n", "CLAIM-PTY-SANDBOX");
    expectViolation("PTY provides complete coverage.\n", "CLAIM-PTY-SANDBOX");
    expectViolation("The --pty mode is a secure sandbox.\n", "CLAIM-PTY-SANDBOX");
    expectViolation("VibeRevert prevents all risky changes.\n", "CLAIM-RISK-PREVENTION");
    expectViolation(
      "VibeRevert reverses deployments and database writes.\n",
      "CLAIM-EXTERNAL-EFFECTS",
    );
    expectViolation("VibeRevert undoes external effects.\n", "CLAIM-EXTERNAL-EFFECTS");
    expectViolation("VibeRevert reverses external side effects.\n", "CLAIM-EXTERNAL-EFFECTS");
    expectViolation("VibeRevert will never lose your work.\n", "CLAIM-RECOVERY-GUARANTEE");
    expectViolation(
      "# Limitations\n\nVibeRevert guarantees recovery of everything.\n",
      "CLAIM-RECOVERY-GUARANTEE",
    );
  });

  it("platform + PTY-maturity claims stay consistent with support.yml", () => {
    expectViolation("PTY works on Windows.\n", "CLAIM-PLATFORM-SUPPORT");
    expectViolation("PTY works on macOS.\n", "CLAIM-PLATFORM-SUPPORT");
    expectViolation(
      "PTY is experimental and works on macOS and may improve speed.\n",
      "CLAIM-PLATFORM-SUPPORT",
    );
    expectViolation("VibeRevert runs on FreeBSD.\n", "CLAIM-PLATFORM-SUPPORT");
    expectViolation("VibeRevert is available on FreeBSD.\n", "CLAIM-PLATFORM-SUPPORT");
    expectViolation("Plain shell works on every platform.\n", "CLAIM-PLATFORM-SUPPORT");
    expectViolation("Use PTY on Linux.\n", "CLAIM-EXPERIMENTAL-LABEL");
  });

  it("heading-stack inheritance flows into subsections but pops at a same-level sibling", () => {
    const md = [
      "### shell --pty (experimental)",
      "",
      "#### Requirements",
      "",
      "PTY is available on Linux.",
      "",
      "### Other feature",
      "",
      "PTY is available on Linux.",
      "",
    ].join("\n");
    const exp = analyzeClaims(md, "<synthetic>").filter(
      (v) => v.ruleId === "CLAIM-EXPERIMENTAL-LABEL",
    );
    expect(exp).toHaveLength(1);
    expect(exp[0]?.line).toBe(9);
  });

  it("Markdown formatting cannot hide a claim; destinations and comments cannot invent or leak one", () => {
    expectViolation(
      "VibeRevert **guarantees** recovery of everything.\n",
      "CLAIM-RECOVERY-GUARANTEE",
    );
    expectViolation(
      "[VibeRevert guarantees recovery of everything](https://example.com/x).\n",
      "CLAIM-RECOVERY-GUARANTEE",
    );
    expectViolation(
      "| Feature | Claim |\n| --- | --- |\n| shell | VibeRevert reverses production deployments |\n",
      "CLAIM-EXTERNAL-EFFECTS",
    );
    expectViolation(
      "<!-- internal note\n--> VibeRevert guarantees recovery of everything.\n",
      "CLAIM-RECOVERY-GUARANTEE",
    );
    expectClean("See the [Windows guide](https://example.com/runs-on-freebsd).\n");
    expectClean("<!--\nVibeRevert guarantees recovery of everything.\n-->\n");
  });

  it("wrapped/lazily-continued claims are joined and reported at the physical line of the match", () => {
    expectViolation(
      "- VibeRevert guarantees full\nrecovery of everything.\n",
      "CLAIM-RECOVERY-GUARANTEE",
    );
    const v = analyzeClaims(
      "intro\n\nVibeRevert guarantees full\nrecovery of everything.\n",
      "README.md",
    );
    expect(v).toContainEqual({
      file: "README.md",
      line: 3,
      clause: "VibeRevert guarantees full recovery of everything.",
      ruleId: "CLAIM-RECOVERY-GUARANTEE",
    });
  });

  it("diagnostics report a bounded window that contains the offending phrase", () => {
    const filler = "x".repeat(200);
    const v = analyzeClaims(
      `${filler} VibeRevert guarantees recovery of everything.\n`,
      "README.md",
    );
    const rec = v.find((x) => x.ruleId === "CLAIM-RECOVERY-GUARANTEE");
    expect(rec?.clause).toContain("guarantees recovery");
  });

  it("catches a claim appended to the real README, structure-independently (mutation proof)", () => {
    const real = readFileSync(new URL("README.md", REPO_ROOT_URL), "utf8");
    const mutated = `${real.trimEnd()}\n\n## Seeded release-claim violation\n\nVibeRevert guarantees recovery of everything and reverses any AI mistake.\n`;
    expect(analyzeClaims(mutated, "README.md").map((v) => v.ruleId)).toContain(
      "CLAIM-RECOVERY-GUARANTEE",
    );
    expect(analyzeClaims(real, "README.md")).toEqual([]);
  });

  it("support.yml remains the single validated source for platform + maturity facts", () => {
    expect([...FACTS.general].sort()).toEqual(["linux", "macos", "windows"]);
    expect(FACTS.pty.get("linux")).toBe("exercised");
    expect(FACTS.pty.get("macos")).toBe("capability_gated");
    expect(FACTS.pty.get("windows")).toBe("not_applicable");
    expect(FACTS.coreMaturity).toBe("beta");
    expect(FACTS.ptyMaturity).toBe("experimental");
  });
});
