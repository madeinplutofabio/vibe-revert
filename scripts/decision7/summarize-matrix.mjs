// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Decision 7 Stage A matrix summarizer (operator tooling; NOT product code). The
// authority on matrix eligibility across runs. Read-only with respect to the
// evidence root. Deterministic and non-interactive.
//
// Exit codes:
//   0  report generated and every required matrix case is eligible
//   1  report generated, but the required matrix is not yet eligible
//   2  the evidence root cannot be safely enumerated/interpreted, or a requested
//      report cannot be written. A malformed individual attempt is represented in a
//      successful report and yields 1.

import { existsSync, lstatSync, readdirSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { parse } from "yaml";

import {
  assertRealDirectory,
  assertRealRegularFile,
  Decision7Error,
  HARNESS_IMPLEMENTATION_VERSION,
  MATRIX_DEFINITION,
  matrixCaseId,
  OPERATOR_WRAPPER_COMPLETION_VALUES,
  PROTOCOL_VERSION,
  parseCliArgs,
  parseJsonl,
  REQUIRED_REPETITIONS,
  RESULT_SCHEMA_VERSION,
  readFileBounded,
  sha256String,
  verifyManifest,
  writeFileAtomic,
} from "./decision7-lib.mjs";

const EXIT_OK = 0;
const EXIT_NOT_ELIGIBLE = 1;
const EXIT_ERROR = 2;

const SUMMARY_SCHEMA_VERSION = 1;

const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_OPERATOR_YAML_BYTES = 256 * 1024;
const MAX_CONSOLE_BYTES = 1 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_EVENTS = 20_000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID_V4}$`);
const BASE_LEAF_RE = /^repetition-([1-3])$/;
const ATTEMPT_LEAF_RE = new RegExp(`^repetition-([1-3])__attempt-(\\d{8}T\\d{6}Z)-(${UUID_V4})$`);

const EXPECTED_RAW = [
  "cleanup.txt",
  "fixture-events.jsonl",
  "harness-events.jsonl",
  "metadata.json",
  "result.machine.json",
];
const RESERVED_ROOT = "decision7-build-attestation";

const BATCH_PROMPT_VALUES = new Set(["yes", "no", "indeterminate"]);
const RUN_VERDICT_VALUES = new Set(["eligible_candidate", "blocked", "indeterminate"]);
const OPERATOR_COMPLETION_VALUES = new Set(OPERATOR_WRAPPER_COMPLETION_VALUES);
const TOP_LEVEL_KEYS = ["operator", "run"];
const RUN_KEYS = ["matrixCaseId", "repetition", "requiredRepetitions", "runId"];
const OPERATOR_KEYS = [
  "batch_prompt_observed",
  "completed_at",
  "name",
  "notes",
  "run_verdict",
  "unexpected_console_behavior",
  "wrapper_completion_confirmed",
];

const SCHEMA = {
  "evidence-dir": { type: "string", required: true },
  json: { type: "boolean" },
  out: { type: "string" },
};

const USAGE = "usage: summarize-matrix.mjs --evidence-dir <root> [--json] [--out <path>]";

function fail(message, code = EXIT_ERROR) {
  writeSync(2, `decision7 summarize: ${message}\n`);
  process.exit(code);
}

function out(text) {
  writeSync(1, `${text}\n`);
}

function isPlainObj(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIsoUtc(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function compactUtc(iso) {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function isRealFile(path) {
  try {
    assertRealRegularFile(path, "path");
    return true;
  } catch {
    return false;
  }
}

function isRealDir(path) {
  try {
    assertRealDirectory(path, "path");
    return true;
  } catch {
    return false;
  }
}

function isWithin(child, parent) {
  const norm = (p) => p.replace(/[\\/]+$/, "").toLowerCase();
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`);
}

function exactKeys(obj, expected) {
  const keys = Object.keys(obj);
  return keys.length === expected.length && expected.every((k) => Object.hasOwn(obj, k));
}

function identityKey(identity) {
  return [
    identity.attestationDigest,
    identity.gitCommit,
    identity.nodeVersion,
    identity.comSpecSha256,
    identity.harnessImplementationVersion,
    identity.terminalHost,
    identity.shellHost,
    identity.hostLabel,
  ].join("|");
}

function validateIdentity(caseId, metadata) {
  const i = metadata.identity;
  if (!isPlainObj(i)) {
    return { ok: false, reason: "identity_shape" };
  }
  if (!HEX64.test(i.attestationDigest)) {
    return { ok: false, reason: "attestation_digest_invalid" };
  }
  if (!HEX40.test(i.gitCommit)) {
    return { ok: false, reason: "git_commit_invalid" };
  }
  if (typeof i.nodeVersion !== "string" || i.nodeVersion.length === 0) {
    return { ok: false, reason: "node_version_invalid" };
  }
  if (!HEX64.test(i.comSpecSha256)) {
    return { ok: false, reason: "comspec_digest_invalid" };
  }
  if (!HEX64.test(i.operatorTemplateSha256) || !HEX64.test(i.consoleTemplateSha256)) {
    return { ok: false, reason: "template_digests_invalid" };
  }
  if (metadata.harnessImplementationVersion !== HARNESS_IMPLEMENTATION_VERSION) {
    return { ok: false, reason: "harness_version_mismatch" };
  }
  if (typeof metadata.terminalHost !== "string" || typeof metadata.shellHost !== "string") {
    return { ok: false, reason: "host_not_string" };
  }
  let derivedCaseId;
  try {
    derivedCaseId = matrixCaseId(metadata.terminalHost, metadata.shellHost);
  } catch {
    return { ok: false, reason: "host_not_in_vocabulary" };
  }
  if (derivedCaseId !== caseId || metadata.matrixCaseId !== caseId) {
    return { ok: false, reason: "host_case_mismatch" };
  }
  if (typeof metadata.hostLabel !== "string" || metadata.hostLabel.trim().length === 0) {
    return { ok: false, reason: "host_label_missing" };
  }
  return {
    ok: true,
    identity: {
      attestationDigest: i.attestationDigest,
      gitCommit: i.gitCommit,
      nodeVersion: i.nodeVersion,
      comSpecSha256: i.comSpecSha256,
      harnessImplementationVersion: metadata.harnessImplementationVersion,
      terminalHost: metadata.terminalHost,
      shellHost: metadata.shellHost,
      hostLabel: metadata.hostLabel,
    },
  };
}

function validateBinding(name, metadata) {
  const attempt = metadata.attempt;
  if (!isPlainObj(attempt) || attempt.leaf !== name) {
    return { ok: false, reason: "attempt_leaf_mismatch" };
  }
  if (
    !isIsoUtc(attempt.attemptCreatedAt) ||
    attempt.attemptTimestamp !== compactUtc(attempt.attemptCreatedAt)
  ) {
    return { ok: false, reason: "attempt_timestamp_mismatch" };
  }
  const base = BASE_LEAF_RE.exec(name);
  const att = ATTEMPT_LEAF_RE.exec(name);
  if (base !== null) {
    if (metadata.repetition !== Number(base[1]) || metadata.newAttempt !== false) {
      return { ok: false, reason: "base_leaf_binding" };
    }
    return { ok: true };
  }
  if (att !== null) {
    if (
      metadata.repetition !== Number(att[1]) ||
      metadata.newAttempt !== true ||
      attempt.attemptTimestamp !== att[2] ||
      metadata.runId !== att[3]
    ) {
      return { ok: false, reason: "attempt_leaf_binding" };
    }
    return { ok: true };
  }
  return { ok: false, reason: "bad_bundle_name" };
}

function checkRawArtifactSet(rawDir) {
  let entries;
  try {
    entries = readdirSync(rawDir).sort();
  } catch {
    return { ok: false, reason: "unreadable_raw_dir" };
  }
  const expected = [...EXPECTED_RAW].sort();
  if (entries.length !== expected.length || !expected.every((f, idx) => entries[idx] === f)) {
    return { ok: false, reason: `set(${entries.join(",")})` };
  }
  for (const f of expected) {
    if (!isRealFile(join(rawDir, f))) {
      return { ok: false, reason: `unsafe_or_missing:${f}` };
    }
  }
  return { ok: true };
}

function harnessBound(rawDir, metadata) {
  const path = join(rawDir, "harness-events.jsonl");
  if (!existsSync(path) || !isRealFile(path)) {
    return { ok: false, reason: "harness_events_missing_or_unsafe" };
  }
  const r = readFileBounded(path, MAX_EVENT_FILE_BYTES);
  if (r.missing || r.truncated) {
    return {
      ok: false,
      reason: r.truncated ? "harness_events_too_large" : "harness_events_missing",
    };
  }
  const parsed = parseJsonl(r.text, { maxLineBytes: MAX_LINE_BYTES, maxEvents: MAX_EVENTS });
  if (
    parsed.malformed > 0 ||
    parsed.incompleteFinalLine ||
    parsed.limitExceeded ||
    parsed.events.length === 0
  ) {
    return { ok: false, reason: "harness_events_stream_invalid" };
  }
  let max = null;
  for (const e of parsed.events) {
    if (
      !isPlainObj(e) ||
      e.source !== "harness" ||
      e.runId !== metadata.runId ||
      e.protocolVersion !== PROTOCOL_VERSION ||
      e.harnessImplementationVersion !== HARNESS_IMPLEMENTATION_VERSION ||
      !isIsoUtc(e.ts)
    ) {
      return { ok: false, reason: "harness_event_untrusted" };
    }
    const t = Date.parse(e.ts);
    if (max === null || t > max) {
      max = t;
    }
  }
  return { ok: true, max };
}

function evaluateMachine(caseId, metadata, machine) {
  const reasons = [];
  const checks = [
    [machine.internal_failure === false, "internal_failure"],
    [machine.rawEvidenceComplete === true, "raw_evidence_incomplete"],
    [machine.integrity_status === "complete", `integrity_status:${machine.integrity_status}`],
    [machine.experiment_validity === "valid", `experiment_validity:${machine.experiment_validity}`],
    [machine.event_protocol_valid === true, "event_protocol_invalid"],
    [
      machine.interactive_delivery === "received",
      `interactive_delivery:${machine.interactive_delivery}`,
    ],
    [
      machine.candidate_wrapper_completion === "clean_exit",
      `candidate_wrapper_completion:${machine.candidate_wrapper_completion}`,
    ],
    [
      machine.eligibility_constraints?.eligibility_constraints_satisfied === true,
      "diagnostic_override_present",
    ],
    [machine.runId === metadata.runId, "machine_run_id_mismatch"],
    [machine.matrixCaseId === caseId, "machine_matrix_case_mismatch"],
    [machine.repetition === metadata.repetition, "machine_repetition_mismatch"],
    [
      machine.harnessImplementationVersion === HARNESS_IMPLEMENTATION_VERSION,
      "machine_harness_version_mismatch",
    ],
  ];
  for (const [ok, reason] of checks) {
    if (!ok) {
      reasons.push(reason);
    }
  }
  return reasons;
}

function evaluateOperator(bundleDir, rawDir, metadata) {
  const reasons = [];
  const operatorDir = join(bundleDir, "operator");
  const yamlPath = join(operatorDir, "result.operator.yaml");
  const consolePath = join(operatorDir, "console-observation.txt");

  if (!existsSync(operatorDir) || !isRealDir(operatorDir)) {
    reasons.push("operator_dir_missing_or_unsafe");
    return reasons;
  }
  if (!existsSync(yamlPath) || !isRealFile(yamlPath)) {
    reasons.push("operator_yaml_missing_or_unsafe");
    return reasons;
  }
  const yamlRead = readFileBounded(yamlPath, MAX_OPERATOR_YAML_BYTES);
  if (yamlRead.missing || yamlRead.truncated) {
    reasons.push(yamlRead.truncated ? "operator_yaml_too_large" : "operator_yaml_missing");
    return reasons;
  }
  if (sha256String(yamlRead.text) === metadata.identity?.operatorTemplateSha256) {
    reasons.push("operator_yaml_unedited");
  }

  let doc;
  try {
    doc = parse(yamlRead.text);
  } catch (err) {
    reasons.push(`operator_yaml_parse_error:${err?.message ?? err}`);
    return reasons;
  }
  if (
    !isPlainObj(doc) ||
    !exactKeys(doc, TOP_LEVEL_KEYS) ||
    !isPlainObj(doc.run) ||
    !isPlainObj(doc.operator)
  ) {
    reasons.push("operator_yaml_schema");
    return reasons;
  }
  if (!exactKeys(doc.run, RUN_KEYS)) {
    reasons.push("operator_run_keys");
  }
  if (!exactKeys(doc.operator, OPERATOR_KEYS)) {
    reasons.push("operator_operator_keys");
  }
  if (doc.run.runId !== metadata.runId) {
    reasons.push("operator_run_id_mismatch");
  }
  if (doc.run.matrixCaseId !== metadata.matrixCaseId) {
    reasons.push("operator_matrix_case_mismatch");
  }
  if (doc.run.repetition !== metadata.repetition) {
    reasons.push("operator_repetition_mismatch");
  }
  if (doc.run.requiredRepetitions !== REQUIRED_REPETITIONS) {
    reasons.push("operator_required_repetitions_mismatch");
  }

  const op = doc.operator;
  for (const f of OPERATOR_KEYS) {
    if (typeof op[f] !== "string") {
      reasons.push(`operator_${f}_not_string`);
    } else if (op[f].trim() === "TO_BE_FILLED") {
      reasons.push(`operator_field_unfilled:${f}`);
    } else if (op[f].trim().length === 0) {
      reasons.push(`operator_${f}_empty`);
    }
  }

  const bound = harnessBound(rawDir, metadata);
  if (typeof op.completed_at !== "string" || !isIsoUtc(op.completed_at)) {
    reasons.push("completed_at_not_iso_utc");
  } else if (!bound.ok) {
    reasons.push(`completed_at_unverifiable:${bound.reason}`);
  } else {
    const completed = Date.parse(op.completed_at);
    if (completed < bound.max) {
      reasons.push("completed_at_before_final_harness_event");
    }
    if (completed > Date.now() + CLOCK_SKEW_MS) {
      reasons.push("completed_at_implausibly_future");
    }
  }

  if (!BATCH_PROMPT_VALUES.has(op.batch_prompt_observed)) {
    reasons.push("batch_prompt_observed_invalid");
  } else if (op.batch_prompt_observed !== "no") {
    reasons.push(`batch_prompt_observed:${op.batch_prompt_observed}`);
  }
  if (!OPERATOR_COMPLETION_VALUES.has(op.wrapper_completion_confirmed)) {
    reasons.push("wrapper_completion_confirmed_invalid");
  } else if (op.wrapper_completion_confirmed !== "clean_exit") {
    reasons.push(`wrapper_completion_confirmed:${op.wrapper_completion_confirmed}`);
  }
  if (!RUN_VERDICT_VALUES.has(op.run_verdict)) {
    reasons.push("run_verdict_invalid");
  } else if (op.run_verdict !== "eligible_candidate") {
    reasons.push(`run_verdict_vetoes:${op.run_verdict}`);
  }

  if (!existsSync(consolePath) || !isRealFile(consolePath)) {
    reasons.push("console_missing_or_unsafe");
  } else {
    const consoleRead = readFileBounded(consolePath, MAX_CONSOLE_BYTES);
    if (consoleRead.missing || consoleRead.truncated) {
      reasons.push(consoleRead.truncated ? "console_too_large" : "console_missing");
    } else {
      if (consoleRead.text.trim().length === 0) {
        reasons.push("console_empty");
      }
      if (consoleRead.text.includes("TO BE FILLED")) {
        reasons.push("console_placeholder_remains");
      }
      if (sha256String(consoleRead.text) === metadata.identity?.consoleTemplateSha256) {
        reasons.push("console_unedited");
      }
    }
  }

  return reasons;
}

function evaluateBundle(caseId, name, bundleDir, rawDir, metadata) {
  const bindingReasons = [];
  if (metadata.matrixCaseId !== caseId) {
    bindingReasons.push("matrix_case_mismatch");
  }
  if (metadata.schemaVersion !== RESULT_SCHEMA_VERSION) {
    bindingReasons.push("metadata_schema_version");
  }
  if (metadata.requiredRepetitions !== REQUIRED_REPETITIONS) {
    bindingReasons.push("required_repetitions");
  }
  if (
    metadata.matrixDefinition?.matrixDefinitionVersion !== MATRIX_DEFINITION.matrixDefinitionVersion
  ) {
    bindingReasons.push("matrix_definition_version");
  }
  const repetition =
    Number.isInteger(metadata.repetition) &&
    metadata.repetition >= 1 &&
    metadata.repetition <= REQUIRED_REPETITIONS
      ? metadata.repetition
      : null;
  if (repetition === null) {
    bindingReasons.push("repetition_range");
  }
  const binding = validateBinding(name, metadata);
  if (!binding.ok) {
    bindingReasons.push(`binding:${binding.reason}`);
  }
  const identityV = validateIdentity(caseId, metadata);
  if (!identityV.ok) {
    bindingReasons.push(`identity:${identityV.reason}`);
  }
  const identity = identityV.ok ? identityV.identity : null;

  let machine = null;
  const resultPath = join(rawDir, "result.machine.json");
  if (!existsSync(resultPath) || !isRealFile(resultPath)) {
    bindingReasons.push("result_missing_or_unsafe");
  } else {
    try {
      const r = readFileBounded(resultPath, MAX_RESULT_BYTES);
      if (r.missing || r.truncated) {
        bindingReasons.push(`result_${r.truncated ? "too_large" : "missing"}`);
      } else {
        const m = JSON.parse(r.text);
        if (!isPlainObj(m)) {
          bindingReasons.push("result_shape");
        } else if (m.schemaVersion !== RESULT_SCHEMA_VERSION) {
          bindingReasons.push("result_schema_version");
        } else {
          machine = m;
        }
      }
    } catch {
      bindingReasons.push("result_unreadable");
    }
  }
  const machineReasons = machine !== null ? evaluateMachine(caseId, metadata, machine) : [];

  const rawSet = checkRawArtifactSet(rawDir);
  let sealed = false;
  let sealReason = null;
  if (!rawSet.ok) {
    sealReason = `raw_set:${rawSet.reason}`;
  } else {
    const manifestPath = join(bundleDir, "manifest.sha256");
    if (!existsSync(manifestPath)) {
      sealReason = "no_manifest";
    } else if (!isRealFile(manifestPath)) {
      sealReason = "manifest_unsafe";
    } else {
      try {
        verifyManifest(rawDir, "raw", { path: manifestPath });
        sealed = true;
      } catch (err) {
        sealReason = err?.message ?? String(err);
      }
    }
  }

  const operatorReasons = evaluateOperator(bundleDir, rawDir, metadata);
  const counts =
    bindingReasons.length === 0 &&
    sealed &&
    machineReasons.length === 0 &&
    operatorReasons.length === 0;

  return {
    name,
    repetition,
    attemptCreatedAt: metadata.attempt.attemptCreatedAt,
    runId: metadata.runId,
    identity,
    sealed,
    sealReason,
    bindingReasons,
    machineReasons,
    operatorReasons,
    counts,
  };
}

// Within a required-case namespace there is no ignorable debris: every entry is
// either an unorderable anomaly that blocks the case (unstatable / symlink /
// non-directory / no metadata / unsafe raw or metadata / unreadable or non-orderable
// metadata), or an orderable evaluated attempt whose counts may be true or false.
function classifyEntry(caseId, name, bundleDir) {
  let ls;
  try {
    ls = lstatSync(bundleDir);
  } catch (e) {
    return { kind: "unorderable", name, reason: `unstatable:${e?.message ?? e}` };
  }
  if (ls.isSymbolicLink()) {
    return { kind: "unorderable", name, reason: "symlink" };
  }
  if (!ls.isDirectory()) {
    return { kind: "unorderable", name, reason: "non_directory" };
  }
  const rawDir = join(bundleDir, "raw");
  const metaPath = join(rawDir, "metadata.json");
  if (!existsSync(rawDir) || !existsSync(metaPath)) {
    return { kind: "unorderable", name, reason: "no_metadata" };
  }
  if (!isRealDir(rawDir) || !isRealFile(metaPath)) {
    return { kind: "unorderable", name, reason: "raw_or_metadata_unsafe" };
  }
  let metadata;
  try {
    const r = readFileBounded(metaPath, MAX_METADATA_BYTES);
    if (r.missing || r.truncated) {
      return {
        kind: "unorderable",
        name,
        reason: `metadata_${r.truncated ? "too_large" : "missing"}`,
      };
    }
    metadata = JSON.parse(r.text);
  } catch {
    return { kind: "unorderable", name, reason: "metadata_unreadable" };
  }
  if (
    !isPlainObj(metadata) ||
    typeof metadata.runId !== "string" ||
    !UUID_RE.test(metadata.runId) ||
    !isPlainObj(metadata.attempt) ||
    !isIsoUtc(metadata.attempt.attemptCreatedAt)
  ) {
    return { kind: "unorderable", name, reason: "metadata_not_orderable" };
  }
  return { kind: "evaluated", bundle: evaluateBundle(caseId, name, bundleDir, rawDir, metadata) };
}

// Reset-and-reconsider walk. An eligible rep1 always (re)starts under its own
// identity; any non-eligible attempt, wrong-rep, or identity mismatch resets; the
// first completed uninterrupted 1->2->3 under one identity wins and later noise does
// not erase it.
function consecutivenessWalk(sorted) {
  let expected = 1;
  let anchorKey = null;
  let sequence = [];
  let winning = null;
  for (const b of sorted) {
    if (winning !== null) {
      continue;
    }
    if (!b.counts) {
      expected = 1;
      anchorKey = null;
      sequence = [];
      continue;
    }
    const key = identityKey(b.identity);
    if (b.repetition === 1) {
      anchorKey = key;
      sequence = [b.name];
      expected = 2;
    } else if (b.repetition === 2 && expected === 2 && key === anchorKey) {
      sequence.push(b.name);
      expected = 3;
    } else if (b.repetition === 3 && expected === 3 && key === anchorKey) {
      sequence.push(b.name);
      winning = sequence.slice();
    } else {
      expected = 1;
      anchorKey = null;
      sequence = [];
    }
  }
  return { eligible: winning !== null, winning };
}

function evaluateCase(caseId, evidenceDir) {
  const caseDir = join(evidenceDir, caseId);
  if (!existsSync(caseDir)) {
    return {
      caseId,
      status: "no_evidence",
      eligible: false,
      attempts: [],
      anomalies: [],
      winning: null,
    };
  }
  const ls = lstatSync(caseDir);
  if (ls.isSymbolicLink()) {
    throw new Decision7Error("summarize", `case directory is a symbolic link (unsafe): ${caseDir}`);
  }
  if (!ls.isDirectory()) {
    throw new Decision7Error("summarize", `case path is not a directory: ${caseDir}`);
  }

  const unorderable = [];
  const evaluated = [];
  for (const name of readdirSync(caseDir)) {
    const c = classifyEntry(caseId, name, join(caseDir, name));
    if (c.kind === "unorderable") {
      unorderable.push(`${c.name}:${c.reason}`);
    } else {
      evaluated.push(c.bundle);
    }
  }

  const sorted = [...evaluated].sort((a, b) => {
    const ta = Date.parse(a.attemptCreatedAt);
    const tb = Date.parse(b.attemptCreatedAt);
    if (ta !== tb) {
      return ta - tb;
    }
    return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
  });

  const anomalies = unorderable.map((u) => `unorderable:${u}`);
  const digests = new Set(
    sorted.filter((b) => b.identity !== null).map((b) => b.identity.attestationDigest),
  );
  if (digests.size > 1) {
    anomalies.push(`mixed_attestation_digests:${[...digests].join(",")}`);
  }
  const runIds = sorted.map((b) => b.runId);
  const dup = runIds.filter((id, idx) => runIds.indexOf(id) !== idx);
  if (dup.length > 0) {
    anomalies.push(`duplicate_run_ids:${[...new Set(dup)].join(",")}`);
  }

  const caseBlocked = unorderable.length > 0 || digests.size > 1 || dup.length > 0;
  let eligible = false;
  let winning = null;
  if (!caseBlocked) {
    ({ eligible, winning } = consecutivenessWalk(sorted));
  }

  return {
    caseId,
    status: caseBlocked ? "blocked" : eligible ? "eligible" : "ineligible",
    eligible,
    attempts: sorted.map((b) => ({
      name: b.name,
      repetition: b.repetition,
      attemptCreatedAt: b.attemptCreatedAt,
      runId: b.runId,
      attestationDigest: b.identity?.attestationDigest ?? null,
      hostLabel: b.identity?.hostLabel ?? null,
      sealed: b.sealed,
      sealReason: b.sealReason,
      bindingReasons: b.bindingReasons,
      machineReasons: b.machineReasons,
      operatorReasons: b.operatorReasons,
      counts: b.counts,
    })),
    anomalies,
    winning,
  };
}

function buildReport(evidenceDir) {
  if (lstatSync(evidenceDir).isSymbolicLink()) {
    throw new Decision7Error(
      "summarize",
      `evidence root is a symbolic link (unsafe): ${evidenceDir}`,
    );
  }
  if (!lstatSync(evidenceDir).isDirectory()) {
    throw new Decision7Error("summarize", `evidence root is not a directory: ${evidenceDir}`);
  }

  const required = MATRIX_DEFINITION.requiredCases;
  const requiredSet = new Set(required);
  const cases = {};
  for (const caseId of required) {
    cases[caseId] = evaluateCase(caseId, evidenceDir);
  }

  const extraCases = [];
  const rootAnomalies = [];
  for (const name of readdirSync(evidenceDir)) {
    if (requiredSet.has(name)) {
      continue;
    }
    let entryLs;
    try {
      entryLs = lstatSync(join(evidenceDir, name));
    } catch {
      rootAnomalies.push(`${name}:unstatable`);
      continue;
    }
    if (entryLs.isSymbolicLink()) {
      rootAnomalies.push(`${name}:symlink`);
    } else if (name === RESERVED_ROOT) {
      if (!entryLs.isDirectory()) {
        rootAnomalies.push(`${name}:non_directory`);
      }
    } else if (entryLs.isDirectory()) {
      extraCases.push(name);
    } else {
      rootAnomalies.push(`${name}:non_directory`);
    }
  }

  const matrixEligible =
    rootAnomalies.length === 0 && required.every((caseId) => cases[caseId].eligible);

  return {
    summarySchemaVersion: SUMMARY_SCHEMA_VERSION,
    matrixDefinitionVersion: MATRIX_DEFINITION.matrixDefinitionVersion,
    generatedAt: new Date().toISOString(),
    evidenceDir,
    requiredCases: [...required],
    cases,
    extraCases,
    rootAnomalies,
    matrixEligible,
  };
}

function renderHuman(report) {
  const lines = [];
  lines.push("Decision 7 Stage A — matrix summary");
  lines.push(`  evidence root : ${report.evidenceDir}`);
  lines.push(`  generated     : ${report.generatedAt}`);
  lines.push(`  matrixDefVer  : ${report.matrixDefinitionVersion}`);
  lines.push("");
  for (const caseId of report.requiredCases) {
    const c = report.cases[caseId];
    lines.push(
      `CASE ${caseId} : ${c.status.toUpperCase()}${c.winning ? ` (winning: ${c.winning.join(", ")})` : ""}`,
    );
    for (const a of c.attempts) {
      const reasons = a.counts
        ? ""
        : `  reasons: seal=${a.sealed ? "ok" : a.sealReason} binding=[${a.bindingReasons.join(",")}] machine=[${a.machineReasons.join(",")}] operator=[${a.operatorReasons.join(",")}]`;
      lines.push(
        `  ${a.name}  rep${a.repetition}  ${a.attemptCreatedAt}  ${String(a.attestationDigest).slice(0, 12)}  counts=${a.counts ? "yes" : "no"}${reasons}`,
      );
    }
    if (c.anomalies.length > 0) {
      lines.push(`  ANOMALIES (case blocked): ${c.anomalies.join(", ")}`);
    }
    lines.push("");
  }
  if (report.extraCases.length > 0) {
    lines.push(`extra (non-required) case dirs: ${report.extraCases.join(", ")}`);
  }
  if (report.rootAnomalies.length > 0) {
    lines.push(`ROOT ANOMALIES (matrix ineligible): ${report.rootAnomalies.join(", ")}`);
  }
  lines.push(
    report.matrixEligible
      ? "MATRIX: ELIGIBLE — all required cases have three consecutive eligible runs under one identity."
      : `MATRIX: NOT YET ELIGIBLE — blocked: ${report.requiredCases.filter((c) => !report.cases[c].eligible).join(", ") || "(root anomalies)"}`,
  );
  return lines.join("\n");
}

// Refuse to write the report anywhere that could mutate evidence: canonicalize the
// evidence root and the output parent (defeating a junction/symlink parent that points
// into the root), refuse any pre-existing target of any kind (an lstat probe also
// catches a dangling symlink that existsSync would miss), and write atomically.
function writeReport(evidenceDir, outArg, json) {
  const evidenceRootReal = assertRealDirectory(evidenceDir, "evidence root").realPath;
  const outAbs = resolve(outArg);
  let outExists;
  try {
    lstatSync(outAbs);
    outExists = true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      outExists = false;
    } else {
      throw error;
    }
  }
  if (outExists) {
    fail(`refusing to overwrite an existing report path: ${outAbs}`);
    return;
  }
  const outParentReal = assertRealDirectory(dirname(outAbs), "report output parent").realPath;
  const canonicalOut = join(outParentReal, basename(outAbs));
  if (isWithin(canonicalOut, evidenceRootReal)) {
    fail(`refusing to write the report inside the evidence root: ${canonicalOut}`);
    return;
  }
  writeFileAtomic(canonicalOut, `${json}\n`);
}

function main() {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2), SCHEMA);
  } catch (err) {
    fail(`${err.message}\n\n${USAGE}`);
    return;
  }
  const evidenceDir = resolve(args["evidence-dir"]);
  let report;
  try {
    if (!existsSync(evidenceDir)) {
      throw new Decision7Error("summarize", `evidence root does not exist: ${evidenceDir}`);
    }
    report = buildReport(evidenceDir);
  } catch (err) {
    fail(err?.message ?? String(err));
    return;
  }

  const json = JSON.stringify(report, null, 2);
  if (typeof args.out === "string") {
    try {
      writeReport(evidenceDir, args.out, json);
    } catch (err) {
      fail(`cannot write report to ${resolve(args.out)}: ${err?.message ?? err}`);
      return;
    }
  }
  out(args.json ? json : renderHuman(report));
  process.exit(report.matrixEligible ? EXIT_OK : EXIT_NOT_ELIGIBLE);
}

main();
