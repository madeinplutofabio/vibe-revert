// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Decision 7 Stage A shared library (operator tooling; NOT product code, NOT a
// Vitest test). Deterministic helpers AND narrowly bounded filesystem utilities
// shared by operator-harness.mjs and (later) summarize-matrix.mjs. NOT "pure": the
// filesystem section stats, reads, renames and writes. Owns none of the process
// lifecycle -- no process.exit, no signal handlers, no child spawning, no prompts,
// no console output, no process.kill, and no experiment classification that depends
// on mutable harness state. Functions return structured results or throw a typed
// Decision7Error.

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export class Decision7Error extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "Decision7Error";
    this.code = code;
    this.details = details ?? null;
  }
}

// ============================================================================
// 1. Constants, vocabularies, schemas, matrix definition
// ============================================================================

export const PROTOCOL_VERSION = 1;
export const RESULT_SCHEMA_VERSION = 1;
export const ATTESTATION_SCHEMA_VERSION = 1;
export const MATRIX_DEFINITION_VERSION = 1;
// Semantic version of the harness protocol (classification/timing/sealing). A file
// hash proves exact bytes; this proves the semantics two evidence sets claim.
export const HARNESS_IMPLEMENTATION_VERSION = 1;
export const REQUIRED_REPETITIONS = 3;

export const TERMINAL_HOSTS = Object.freeze([
  "windows-terminal",
  "conhost",
  "vscode-integrated",
  "other",
]);
export const SHELL_HOSTS = Object.freeze(["powershell", "cmd", "other"]);

// Object.freeze on a Set does NOT make the Set immutable; export a frozen array
// and keep a private Set for membership.
export const EVENT_TYPE_VALUES = Object.freeze(["ready", "heartbeat", "sigint"]);
const EVENT_TYPES = new Set(EVENT_TYPE_VALUES);

export const EXPERIMENT_VALIDITY = Object.freeze({
  VALID: "valid",
  INVALID: "invalid",
  INDETERMINATE: "indeterminate",
});
export const INTERACTIVE_DELIVERY = Object.freeze({
  RECEIVED: "received",
  NOT_RECEIVED: "not_received",
  INDETERMINATE: "indeterminate",
});
export const CANDIDATE_WRAPPER_COMPLETION = Object.freeze({
  CLEAN_EXIT: "clean_exit",
  FORCED_RECOVERY: "forced_recovery",
  ORPHANED: "orphaned",
  INDETERMINATE: "indeterminate",
});
// Operator-observed console vocabulary (distinct + finer; only the operator-confirmed
// value feeds Decision 7 eligibility). Used by the operator template + summarizer.
export const OPERATOR_WRAPPER_COMPLETION_VALUES = Object.freeze([
  "clean_exit",
  "batch_prompt_then_exit",
  "batch_prompt_hang",
  "wrapper_hang_without_prompt",
  "indeterminate",
]);

export const LIVENESS = Object.freeze({
  ALIVE: "alive",
  DEAD: "dead",
  INDETERMINATE: "indeterminate",
});
export const INTEGRITY_STATUS = Object.freeze({ COMPLETE: "complete", INCOMPLETE: "incomplete" });

const UNSAFE_WRAPPER_CHARS = new Set(["%", "!", "&", "|", "<", ">", "^", '"']);

// `sealing` is the terminal internal phase; the external "sealed" property is
// established only by a manifest that exists AND verifies (the summarizer infers
// it). `failed`/`sealed` are not phases; failure recovers via cleaning_up.
export const HARNESS_PHASES = Object.freeze([
  "preflight",
  "confirmed",
  "bundle_allocated",
  "spawned",
  "ready",
  "awaiting_ctrl_c",
  "observing",
  "classified",
  "cleaning_up",
  "sealing",
]);
export const PHASE_TRANSITIONS = Object.freeze({
  preflight: Object.freeze(["confirmed"]),
  confirmed: Object.freeze(["bundle_allocated"]),
  bundle_allocated: Object.freeze(["spawned", "cleaning_up"]),
  spawned: Object.freeze(["ready", "cleaning_up"]),
  ready: Object.freeze(["awaiting_ctrl_c", "cleaning_up"]),
  awaiting_ctrl_c: Object.freeze(["observing", "cleaning_up"]),
  observing: Object.freeze(["classified", "cleaning_up"]),
  classified: Object.freeze(["cleaning_up"]),
  cleaning_up: Object.freeze(["sealing"]),
  sealing: Object.freeze([]),
});

const ATTESTATION_STRING_FIELDS = Object.freeze([
  "gitCommit",
  "nodeVersion",
  "pnpmVersion",
  "pnpmPath",
  "pnpmSha256",
  "platform",
  "arch",
  "sourceSha256",
  "compiledSha256",
  "fixtureSha256",
  "harnessSha256",
  "librarySha256",
  "comSpecPath",
  "comSpecSha256",
  "repoRootDeclaredPath",
  "repoRootRealPath",
  "gitShowToplevel",
  "gitShowToplevelRealPath",
  "gitCommonDir",
  "gitCommonDirRealPath",
  "createdAt",
  "attestationDigest",
]);
const ATTESTATION_FRESHNESS_KEYS = Object.freeze([
  "sourceSha256",
  "compiledSha256",
  "fixtureSha256",
  "harnessSha256",
  "librarySha256",
  "comSpecSha256",
  "pnpmSha256",
]);
const ATTESTATION_IDENTITY_KEYS = Object.freeze([
  "gitCommit",
  "nodeVersion",
  "pnpmVersion",
  "platform",
  "arch",
  "comSpecPath",
  "comSpecSha256",
  "pnpmPath",
  "repoRootRealPath",
  "gitShowToplevelRealPath",
  "gitCommonDirRealPath",
  "matrixDefinitionVersion",
  "harnessImplementationVersion",
]);

// Recorded, never derived from whatever bundles happen to exist.
export const MATRIX_DEFINITION = Object.freeze({
  matrixDefinitionVersion: MATRIX_DEFINITION_VERSION,
  requiredCases: Object.freeze([
    "windows-terminal__powershell",
    "windows-terminal__cmd",
    "conhost__cmd",
    "vscode-integrated__powershell",
  ]),
});

export function matrixCaseId(terminalHost, shellHost) {
  if (!TERMINAL_HOSTS.includes(terminalHost)) {
    throw new Decision7Error("matrix", `unsupported terminal host: ${terminalHost}`);
  }
  if (!SHELL_HOSTS.includes(shellHost)) {
    throw new Decision7Error("matrix", `unsupported shell host: ${shellHost}`);
  }
  return `${terminalHost}__${shellHost}`;
}

export function isRequiredCase(id) {
  return MATRIX_DEFINITION.requiredCases.includes(id);
}

// ============================================================================
// 2. Deterministic helpers (validation + serialization; no filesystem)
// ============================================================================

export function sha256String(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function keyHasControlChar(key) {
  for (const ch of key) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

// Strict JSON normalization: rejects what JSON.stringify silently changes or drops
// (non-finite numbers, negative zero, undefined properties, sparse-array holes,
// non-plain objects, __proto__/accessor/non-enumerable/symbol properties, cycles,
// control-character keys, unsupported types). Builds sorted null-prototype objects
// so an own "__proto__" key becomes data. Internal deterministic encoding -- NOT
// RFC 8785.
function normalizeJsonValue(value, path, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Decision7Error("canonical-json", `non-finite number at ${path}`);
    }
    if (Object.is(value, -0)) {
      throw new Decision7Error("canonical-json", `negative zero at ${path}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Decision7Error("canonical-json", `cycle at ${path}`);
    }
    seen.add(value);
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        seen.delete(value);
        throw new Decision7Error("canonical-json", `sparse array entry at ${path}[${index}]`);
      }
      out.push(normalizeJsonValue(value[index], `${path}[${index}]`, seen));
    }
    seen.delete(value);
    return out;
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Decision7Error("canonical-json", `non-plain object at ${path}`);
    }
    if (seen.has(value)) {
      throw new Decision7Error("canonical-json", `cycle at ${path}`);
    }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        seen.delete(value);
        throw new Decision7Error("canonical-json", `symbol key at ${path}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        "get" in descriptor ||
        "set" in descriptor
      ) {
        seen.delete(value);
        throw new Decision7Error(
          "canonical-json",
          `non-data or non-enumerable property at ${path}.${key}`,
        );
      }
    }
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (keyHasControlChar(key)) {
        seen.delete(value);
        throw new Decision7Error("canonical-json", `control character in object key at ${path}`);
      }
      const child = value[key];
      if (child === undefined) {
        seen.delete(value);
        throw new Decision7Error("canonical-json", `undefined value at ${path}.${key}`);
      }
      out[key] = normalizeJsonValue(child, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return out;
  }
  throw new Decision7Error("canonical-json", `unsupported value at ${path}: ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeJsonValue(value, "$", new Set()));
}

export function stableJson(value) {
  return JSON.stringify(normalizeJsonValue(value, "$", new Set()), null, 2);
}

function coerceCliValue(name, spec, value) {
  if (spec.type === "string") {
    return value;
  }
  if (spec.type === "enum") {
    if (!spec.values.includes(value)) {
      throw new Decision7Error("cli-usage", `--${name} must be one of ${spec.values.join("|")}`);
    }
    return value;
  }
  if (spec.type === "integer") {
    if (!/^\d+$/.test(value)) {
      throw new Decision7Error("cli-usage", `--${name} must be a non-negative integer`);
    }
    const n = Number.parseInt(value, 10);
    if (spec.min !== undefined && n < spec.min) {
      throw new Decision7Error("cli-usage", `--${name} must be >= ${spec.min}`);
    }
    if (spec.max !== undefined && n > spec.max) {
      throw new Decision7Error("cli-usage", `--${name} must be <= ${spec.max}`);
    }
    return n;
  }
  throw new Decision7Error("cli-usage", `internal: unknown spec type for --${name}`);
}

// Rejects unknown options, duplicates, values passed to booleans, empty required
// values, and stray positionals.
export function parseCliArgs(argv, schema) {
  const out = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (typeof tok !== "string" || !tok.startsWith("--")) {
      throw new Decision7Error("cli-usage", `unexpected argument: ${tok}`);
    }
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const inlineValue = eq === -1 ? null : tok.slice(eq + 1);
    const spec = schema[name];
    if (spec === undefined) {
      throw new Decision7Error("cli-usage", `unknown option: --${name}`);
    }
    if (seen.has(name)) {
      throw new Decision7Error("cli-usage", `duplicate option: --${name}`);
    }
    seen.add(name);
    if (spec.type === "boolean") {
      if (inlineValue !== null) {
        throw new Decision7Error("cli-usage", `--${name} is a flag and takes no value`);
      }
      out[name] = true;
      continue;
    }
    let value = inlineValue;
    if (value === null) {
      const next = argv[i + 1];
      if (next === undefined || (typeof next === "string" && next.startsWith("--"))) {
        throw new Decision7Error("cli-usage", `missing value for --${name}`);
      }
      value = next;
      i += 1;
    }
    if (value.length === 0) {
      throw new Decision7Error("cli-usage", `--${name} requires a non-empty value`);
    }
    out[name] = coerceCliValue(name, spec, value);
  }
  for (const [name, spec] of Object.entries(schema)) {
    if (name in out) {
      continue;
    }
    if (spec.required) {
      throw new Decision7Error("cli-usage", `--${name} is required`);
    }
    if (spec.type === "boolean") {
      out[name] = false;
    } else if ("default" in spec) {
      out[name] = spec.default;
    }
  }
  return out;
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

// Splits JSONL, distinguishing a transient incomplete FINAL line (no trailing
// newline) from a genuinely malformed line, and enforcing optional bounds. The
// file-level `sourceTruncated` fact (from readFileBounded) is threaded through so
// protocol validation never silently forgets it. `maxEvents` counts non-empty
// records PROCESSED, so malformed lines cannot bypass the record limit.
export function parseJsonl(text, opts) {
  const maxLineBytes = opts?.maxLineBytes;
  const maxEvents = opts?.maxEvents;
  const sourceTruncated = opts?.sourceTruncated === true;
  const events = [];
  let malformed = 0;
  let incompleteFinalLine = false;
  let limitExceeded = false;
  let recordCount = 0;
  if (text.length === 0) {
    return { events, malformed, incompleteFinalLine, limitExceeded, recordCount, sourceTruncated };
  }
  const endsWithNewline = text.endsWith("\n");
  const segments = text.split("\n");
  if (endsWithNewline) {
    segments.pop();
  }
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.length === 0) {
      continue;
    }
    recordCount += 1;
    if (maxEvents !== undefined && recordCount > maxEvents) {
      limitExceeded = true;
      break;
    }
    if (maxLineBytes !== undefined && Buffer.byteLength(seg, "utf8") > maxLineBytes) {
      limitExceeded = true;
      malformed += 1;
      continue;
    }
    try {
      events.push(JSON.parse(seg));
    } catch {
      if (i === segments.length - 1 && !endsWithNewline) {
        incompleteFinalLine = true;
      } else {
        malformed += 1;
      }
    }
  }
  return { events, malformed, incompleteFinalLine, limitExceeded, recordCount, sourceTruncated };
}

function validateOneFixtureEvent(event) {
  const anomalies = [];
  if (!EVENT_TYPES.has(event.type)) {
    anomalies.push(`unknown_type:${String(event.type)}`);
    return anomalies;
  }
  if (!Number.isInteger(event.pid) || event.pid <= 0) {
    anomalies.push("invalid_pid");
  }
  if (!Number.isInteger(event.ppid) || event.ppid <= 0) {
    anomalies.push("invalid_ppid");
  }
  if (!isIsoTimestamp(event.ts)) {
    anomalies.push("invalid_ts");
  }
  if (
    typeof event.monotonicMs !== "number" ||
    !Number.isFinite(event.monotonicMs) ||
    event.monotonicMs < 0
  ) {
    anomalies.push("invalid_monotonic");
  }
  if (event.type === "heartbeat" && (!Number.isInteger(event.seq) || event.seq <= 0)) {
    anomalies.push("invalid_heartbeat_seq");
  }
  if (event.type === "sigint" && event.exit_intent !== 130) {
    anomalies.push("invalid_sigint_exit_intent");
  }
  return anomalies;
}

// Validates every claimed event to a per-event verdict and derives ready/sigint/
// heartbeats/ordering ONLY from fully valid events. Keeps the event-protocol axis
// separate from the process-relationship axis.
export function validateFixtureEvents(parsed, ids, wrapperPid) {
  const eventProtocolAnomalies = [];
  const processRelationshipAnomalies = [];

  if (parsed.malformed > 0) {
    eventProtocolAnomalies.push(`malformed_jsonl_lines:${parsed.malformed}`);
  }
  if (parsed.incompleteFinalLine) {
    eventProtocolAnomalies.push("truncated_final_line");
  }
  if (parsed.limitExceeded) {
    eventProtocolAnomalies.push("event_limit_exceeded");
  }
  if (parsed.sourceTruncated) {
    eventProtocolAnomalies.push("event_file_size_limit_exceeded");
  }

  const claimed = [];
  let foreign = 0;
  for (const e of parsed.events) {
    if (
      e !== null &&
      typeof e === "object" &&
      e.protocolVersion === PROTOCOL_VERSION &&
      e.runId === ids.runId &&
      e.token === ids.token
    ) {
      claimed.push(e);
    } else {
      foreign += 1;
    }
  }
  if (foreign > 0) {
    eventProtocolAnomalies.push(`foreign_or_wrong_version_events:${foreign}`);
  }

  const validated = [];
  let rejectedEventCount = 0;
  for (const [index, event] of claimed.entries()) {
    const anomalies = validateOneFixtureEvent(event);
    if (anomalies.length === 0) {
      validated.push(event);
    } else {
      rejectedEventCount += 1;
      eventProtocolAnomalies.push(...anomalies.map((a) => `event_${index}:${a}`));
    }
  }

  const readies = validated.filter((e) => e.type === "ready");
  const sigints = validated.filter((e) => e.type === "sigint");
  const heartbeats = validated.filter((e) => e.type === "heartbeat");
  if (readies.length > 1) {
    eventProtocolAnomalies.push("multiple_ready");
  }
  if (sigints.length > 1) {
    eventProtocolAnomalies.push("multiple_sigint");
  }
  const iReady = validated.findIndex((e) => e.type === "ready");
  const iHb = validated.findIndex((e) => e.type === "heartbeat");
  const iSig = validated.findIndex((e) => e.type === "sigint");
  if (iHb !== -1 && (iReady === -1 || iHb < iReady)) {
    eventProtocolAnomalies.push("heartbeat_before_ready");
  }
  if (iSig !== -1 && (iReady === -1 || iSig < iReady)) {
    eventProtocolAnomalies.push("sigint_before_ready");
  }
  const seqSeen = new Set();
  for (const e of heartbeats) {
    if (seqSeen.has(e.seq)) {
      eventProtocolAnomalies.push(`duplicate_heartbeat_seq:${e.seq}`);
    } else {
      seqSeen.add(e.seq);
    }
  }
  const pids = new Set(validated.map((e) => e.pid));
  if (pids.size > 1) {
    eventProtocolAnomalies.push("pid_changed_within_token");
  }
  let prev = Number.NEGATIVE_INFINITY;
  for (const e of validated) {
    if (e.monotonicMs < prev) {
      eventProtocolAnomalies.push("non_monotonic_event_order");
      break;
    }
    prev = e.monotonicMs;
  }

  const ready = readies[0] ?? null;
  const sigint = sigints[0] ?? null;
  const fixturePid = ready ? ready.pid : null;
  const fixturePpid = ready ? ready.ppid : null;

  let parentMatchesWrapper = "indeterminate";
  let processRelationshipValid = "indeterminate";
  if (fixturePpid !== null && Number.isInteger(wrapperPid)) {
    parentMatchesWrapper = fixturePpid === wrapperPid;
    processRelationshipValid = parentMatchesWrapper;
    if (parentMatchesWrapper === false) {
      processRelationshipAnomalies.push("fixture_parent_mismatch");
    }
  }

  return {
    parsedEventCount: parsed.events.length,
    claimedEventCount: claimed.length,
    validatedEventCount: validated.length,
    rejectedEventCount,
    eventProtocolValid: eventProtocolAnomalies.length === 0,
    eventProtocolAnomalies,
    processRelationshipValid,
    processRelationshipAnomalies,
    ready,
    sigint,
    heartbeats,
    fixturePid,
    fixturePpid,
    parentMatchesWrapper,
  };
}

// Tri-state survival: never collapse an indeterminate probe into "did not survive".
export function survivalFromLiveness(state) {
  if (state === LIVENESS.ALIVE) {
    return true;
  }
  if (state === LIVENESS.DEAD) {
    return false;
  }
  return null;
}

export function assertStateTransition(from, to) {
  const allowed = PHASE_TRANSITIONS[from];
  if (allowed === undefined) {
    throw new Decision7Error("state", `unknown harness phase: ${from}`);
  }
  if (!allowed.includes(to)) {
    throw new Decision7Error("state", `illegal transition ${from} -> ${to}`);
  }
}

function isSha256Hex(s) {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

function isGitCommitSha(s) {
  return typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
}

function isTimestampPair(v) {
  return (
    isPlainObject(v) &&
    isIsoTimestamp(v.ts) &&
    typeof v.monotonicMs === "number" &&
    Number.isFinite(v.monotonicMs) &&
    v.monotonicMs >= 0
  );
}

export function attestationDigestOf(attestationWithoutDigest) {
  if ("attestationDigest" in attestationWithoutDigest) {
    throw new Decision7Error(
      "attestation",
      "attestationDigest must be absent when computing the digest",
    );
  }
  return sha256String(canonicalJson(attestationWithoutDigest));
}

export function finalizeAttestation(attestationWithoutDigest) {
  return {
    ...attestationWithoutDigest,
    attestationDigest: attestationDigestOf(attestationWithoutDigest),
  };
}

export function verifyAttestationDigest(attestation) {
  const { attestationDigest, ...rest } = attestation;
  return typeof attestationDigest === "string" && attestationDigestOf(rest) === attestationDigest;
}

// Structural only.
export function assertAttestationShape(obj) {
  if (!isPlainObject(obj)) {
    throw new Decision7Error("attestation", "attestation is not a plain object");
  }
  if (obj.schemaVersion !== ATTESTATION_SCHEMA_VERSION) {
    throw new Decision7Error(
      "attestation",
      `unsupported attestation schemaVersion: ${obj.schemaVersion}`,
    );
  }
  if (obj.matrixDefinitionVersion !== MATRIX_DEFINITION_VERSION) {
    throw new Decision7Error(
      "attestation",
      `unsupported matrixDefinitionVersion: ${obj.matrixDefinitionVersion}`,
    );
  }
  if (obj.harnessImplementationVersion !== HARNESS_IMPLEMENTATION_VERSION) {
    throw new Decision7Error(
      "attestation",
      `unsupported harnessImplementationVersion: ${obj.harnessImplementationVersion}`,
    );
  }
  for (const f of ATTESTATION_STRING_FIELDS) {
    if (typeof obj[f] !== "string" || obj[f].length === 0) {
      throw new Decision7Error("attestation", `attestation.${f} must be a non-empty string`);
    }
  }
  if (typeof obj.gitDirtyBeforeBuild !== "boolean" || typeof obj.gitDirtyAfterBuild !== "boolean") {
    throw new Decision7Error("attestation", "attestation dirty flags must be booleans");
  }
  if (!isPlainObject(obj.build)) {
    throw new Decision7Error("attestation", "attestation.build must be a plain object");
  }
  if (!isPlainObject(obj.machine)) {
    throw new Decision7Error("attestation", "attestation.machine must be a plain object");
  }
}

function assertBuildStreamBlock(stream, s, eligible) {
  if (!isPlainObject(s)) {
    throw new Decision7Error("attestation", `build.${stream} must be a plain object`);
  }
  if (typeof s.path !== "string" || s.path.length === 0) {
    throw new Decision7Error("attestation", `build.${stream}.path must be a non-empty string`);
  }
  if (!isSha256Hex(s.sha256)) {
    throw new Decision7Error(
      "attestation",
      `build.${stream}.sha256 must be a 64-char lowercase hex digest`,
    );
  }
  if (!Number.isInteger(s.byteCount) || s.byteCount < 0) {
    throw new Decision7Error(
      "attestation",
      `build.${stream}.byteCount must be a non-negative integer`,
    );
  }
  if (typeof s.truncated !== "boolean") {
    throw new Decision7Error("attestation", `build.${stream}.truncated must be a boolean`);
  }
  if (eligible && s.truncated !== false) {
    throw new Decision7Error(
      "attestation",
      `eligible attestation requires build.${stream}.truncated === false`,
    );
  }
}

// Structural + semantic + (default) eligible-path checks. One unambiguous entry
// point. Does NOT validate the exact build command contract -- see
// assertAttestedBuildCommand, which the caller drives with the eligible contract.
export function assertValidAttestation(attestation, options) {
  const eligible = options?.eligible ?? true;
  assertAttestationShape(attestation);
  if (!verifyAttestationDigest(attestation)) {
    throw new Decision7Error("attestation", "attestation digest does not verify");
  }
  if (!isGitCommitSha(attestation.gitCommit)) {
    throw new Decision7Error("attestation", "gitCommit is not a 40-char hex SHA");
  }
  for (const k of [...ATTESTATION_FRESHNESS_KEYS, "attestationDigest"]) {
    if (!isSha256Hex(attestation[k])) {
      throw new Decision7Error("attestation", `${k} is not a 64-char lowercase hex digest`);
    }
  }
  if (attestation.platform !== "win32") {
    throw new Decision7Error("attestation", `platform must be win32, got ${attestation.platform}`);
  }
  if (!isIsoTimestamp(attestation.createdAt)) {
    throw new Decision7Error("attestation", "createdAt is not a valid ISO timestamp");
  }

  const b = attestation.build;
  if (typeof b.executable !== "string" || b.executable.length === 0) {
    throw new Decision7Error("attestation", "build.executable must be a non-empty string");
  }
  if (
    !Array.isArray(b.args) ||
    b.args.length === 0 ||
    !b.args.every((a) => typeof a === "string" && a.length > 0)
  ) {
    throw new Decision7Error(
      "attestation",
      "build.args must be a non-empty array of non-empty strings",
    );
  }
  if (typeof b.cwd !== "string" || b.cwd.length === 0) {
    throw new Decision7Error("attestation", "build.cwd must be a non-empty string");
  }
  if (b.exitCode !== 0) {
    throw new Decision7Error("attestation", `build.exitCode must be 0, got ${b.exitCode}`);
  }
  if (!isTimestampPair(b.startedAt) || !isTimestampPair(b.completedAt)) {
    throw new Decision7Error(
      "attestation",
      "build.startedAt/completedAt must be valid timestamp pairs",
    );
  }
  if (b.completedAt.monotonicMs < b.startedAt.monotonicMs) {
    throw new Decision7Error("attestation", "build.completedAt precedes startedAt (monotonic)");
  }
  if (Date.parse(b.completedAt.ts) < Date.parse(b.startedAt.ts)) {
    throw new Decision7Error("attestation", "build.completedAt precedes startedAt (wall clock)");
  }
  if (b.stdoutCaptured !== true || b.stderrCaptured !== true) {
    throw new Decision7Error("attestation", "build.stdoutCaptured and stderrCaptured must be true");
  }
  assertBuildStreamBlock("stdout", b.stdout, eligible);
  assertBuildStreamBlock("stderr", b.stderr, eligible);

  const m = attestation.machine;
  for (const f of ["computerName", "osVersion", "osBuild"]) {
    if (typeof m[f] !== "string" || m[f].length === 0) {
      throw new Decision7Error("attestation", `machine.${f} must be a non-empty string`);
    }
  }

  if (
    eligible &&
    (attestation.gitDirtyBeforeBuild !== false || attestation.gitDirtyAfterBuild !== false)
  ) {
    throw new Decision7Error(
      "attestation",
      "eligible attestation requires a clean tree before and after the build",
    );
  }
}

// Exact equality of the eligible build contract (not merely well-formed). The
// caller supplies the contract derived from the attestation's own fields.
export function assertAttestedBuildCommand(attestation, expected) {
  const b = attestation.build;
  if (!isPlainObject(b)) {
    throw new Decision7Error("attestation", "attestation.build is not a plain object");
  }
  if (b.executable !== expected.executable) {
    throw new Decision7Error(
      "attestation",
      `build.executable is not the eligible contract: ${b.executable}`,
    );
  }
  if (
    !Array.isArray(b.args) ||
    b.args.length !== expected.args.length ||
    expected.args.some((a, i) => b.args[i] !== a)
  ) {
    throw new Decision7Error(
      "attestation",
      `build.args are not the eligible build contract: ${JSON.stringify(b.args)}`,
    );
  }
  if (b.cwd !== expected.cwd) {
    throw new Decision7Error("attestation", `build.cwd is not the eligible contract: ${b.cwd}`);
  }
  if (b.exitCode !== 0) {
    throw new Decision7Error("attestation", `build.exitCode must be 0, got ${b.exitCode}`);
  }
}

// Hash equality: nothing changed since the attested build.
export function validateAttestationFreshness(attestation, current) {
  const mismatches = ATTESTATION_FRESHNESS_KEYS.filter((k) => attestation[k] !== current[k]);
  return { fresh: mismatches.length === 0, mismatches };
}

// Environment identity: same commit/runtime/host mediation/checkout/harness
// semantics, not just same bytes. Machine provenance (machine.*) is compared by the
// caller because this generic flat-key helper does not address nested objects.
export function validateAttestationIdentity(attestation, current) {
  const mismatches = ATTESTATION_IDENTITY_KEYS.filter((k) => attestation[k] !== current[k]);
  return { matches: mismatches.length === 0, mismatches };
}

// Any diagnostic override makes a run non-eligible automatically. The operator
// cannot override this in result.operator.yaml; the summarizer enforces it.
export function computeEligibilityConstraints(overrides) {
  const diagnosticOverrides = [];
  if (overrides.allowDirty) {
    diagnosticOverrides.push("allow_dirty");
  }
  if (overrides.allowNoninteractive) {
    diagnosticOverrides.push("allow_noninteractive");
  }
  if (overrides.buildOverride) {
    diagnosticOverrides.push("build_override");
  }
  if (overrides.attestationMismatchOverride) {
    diagnosticOverrides.push("attestation_mismatch_override");
  }
  return {
    eligibility_constraints_satisfied: diagnosticOverrides.length === 0,
    diagnostic_overrides: diagnosticOverrides,
  };
}

// ============================================================================
// 3. Bounded filesystem utilities
// ============================================================================

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Decision7Error("io-read", `cannot read ${path}: ${err?.message ?? err}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Decision7Error("json-parse", `invalid JSON in ${path}`);
  }
}

// Bounded read that never pulls an unbounded file into memory, even if the file is
// actively appended: opens once, fstats that descriptor, and reads at most
// maxBytes+1 bytes from it (no stat/read TOCTOU). Returns { text, byteCount,
// truncated, missing }. `missing` (ENOENT) is transient for a file the fixture may
// not have created yet; any other error is an io-read error, NOT an empty stream.
// Callers must not parse or classify from truncated text.
export function readFileBounded(path, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Decision7Error("io-read", `maxBytes must be a positive integer: ${maxBytes}`);
  }
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { text: "", byteCount: 0, truncated: false, missing: true };
    }
    throw new Decision7Error("io-read", `cannot open ${path}: ${error?.message ?? error}`);
  }
  try {
    const stat = fstatSync(fd);
    const capacity = Math.min(stat.size, maxBytes + 1);
    const buffer = Buffer.alloc(capacity);
    const bytesRead = readSync(fd, buffer, 0, capacity, 0);
    const truncated = bytesRead > maxBytes || stat.size > maxBytes;
    const usableBytes = Math.min(bytesRead, maxBytes);
    return {
      text: buffer.subarray(0, usableBytes).toString("utf8"),
      byteCount: stat.size,
      truncated,
      missing: false,
    };
  } catch (error) {
    throw new Decision7Error("io-read", `cannot read ${path}: ${error?.message ?? error}`);
  } finally {
    closeSync(fd);
  }
}

// Writes through a unique, flushed sibling temporary file and refuses a final
// target already present at entry. NOT a cross-process no-replace transaction:
// callers must own an exclusively allocated bundle directory. The parent directory
// is not flushed, so this is not durable against power loss; it only guarantees the
// final file is never observed half-written.
export function writeFileAtomic(path, contents) {
  if (existsSync(path)) {
    throw new Decision7Error(
      "atomic-write",
      `refusing to overwrite existing evidence file: ${path}`,
    );
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, "wx");
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Preserve the original failure.
    }
    if (error instanceof Decision7Error) {
      throw error;
    }
    throw new Decision7Error(
      "atomic-write",
      `cannot atomically write ${path}: ${error?.message ?? error}`,
    );
  }
}

export function writeEvidenceAtomic(path, value) {
  writeFileAtomic(path, `${stableJson(value)}\n`);
}

// Recursive, lexically sorted, forward-slash relative paths. Throws on symlinks or
// any non-regular-file / non-directory entry (ambiguous in immutable evidence).
export function listFilesRecursive(rootDir) {
  const out = [];
  const walk = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) {
        walk(join(dir, ent.name), relPath);
      } else if (ent.isFile()) {
        out.push(relPath);
      } else {
        throw new Decision7Error(
          "manifest",
          `unsupported directory entry (symlink or special): ${relPath}`,
        );
      }
    }
  };
  walk(rootDir, "");
  return out.sort();
}

function assertManifestPrefix(pathPrefix) {
  if (
    typeof pathPrefix !== "string" ||
    pathPrefix.length === 0 ||
    pathPrefix.includes("\\") ||
    pathPrefix.startsWith("/") ||
    /^[a-zA-Z]:/.test(pathPrefix) ||
    pathPrefix.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Decision7Error("manifest", `invalid manifest path prefix: ${String(pathPrefix)}`);
  }
}

// `<sha256>  <pathPrefix>/<rel>` lines over rootDir/**. MUST receive the raw/
// directory, never the bundle root, so the manifest (which lives outside raw/)
// never includes itself. An empty directory yields an empty manifest ("").
export function computeManifestText(rootDir, pathPrefix) {
  assertManifestPrefix(pathPrefix);
  const lines = listFilesRecursive(rootDir).map(
    (rel) => `${sha256File(join(rootDir, rel))}  ${pathPrefix}/${rel}`,
  );
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

// Strict re-verification of a manifest against rootDir/**: exact expected file set,
// one entry per file, lowercase SHA-256, forward-slash relative paths, no empty
// line, no empty/absolute/traversal/backslash paths, no self-entry (rootDir must be
// raw/), and byte-for-byte digest agreement. `source` is { text } or { path }.
// Returns the verified manifest digest.
export function verifyManifest(rootDir, pathPrefix, source) {
  assertManifestPrefix(pathPrefix);
  let text;
  if (typeof source?.path === "string") {
    try {
      text = readFileSync(source.path, "utf8");
    } catch (err) {
      throw new Decision7Error(
        "manifest",
        `cannot read manifest ${source.path}: ${err?.message ?? err}`,
      );
    }
  } else if (typeof source?.text === "string") {
    text = source.text;
  } else {
    throw new Decision7Error("manifest", "verifyManifest requires { text } or { path }");
  }
  const expected = new Map();
  for (const rel of listFilesRecursive(rootDir)) {
    expected.set(`${pathPrefix}/${rel}`, sha256File(join(rootDir, rel)));
  }
  if (expected.size === 0) {
    if (text !== "") {
      throw new Decision7Error(
        "manifest",
        "expected an empty manifest for a directory with no files",
      );
    }
    return sha256String(text);
  }
  if (!text.endsWith("\n")) {
    throw new Decision7Error("manifest", "manifest must end with a newline");
  }
  const lines = text.slice(0, -1).split("\n");
  const seen = new Set();
  for (const line of lines) {
    if (line.length === 0) {
      throw new Decision7Error("manifest", "empty manifest line");
    }
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (m === null) {
      throw new Decision7Error("manifest", `malformed manifest line: ${JSON.stringify(line)}`);
    }
    const digest = m[1];
    const path = m[2];
    if (path.includes("\\")) {
      throw new Decision7Error("manifest", `backslash in manifest path: ${path}`);
    }
    if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
      throw new Decision7Error("manifest", `absolute manifest path: ${path}`);
    }
    if (path.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
      throw new Decision7Error("manifest", `invalid manifest path components: ${path}`);
    }
    if (seen.has(path)) {
      throw new Decision7Error("manifest", `duplicate manifest path: ${path}`);
    }
    seen.add(path);
    if (!expected.has(path)) {
      throw new Decision7Error("manifest", `unexpected manifest path: ${path}`);
    }
    if (expected.get(path) !== digest) {
      throw new Decision7Error("manifest", `digest mismatch: ${path}`);
    }
  }
  if (seen.size !== expected.size) {
    throw new Decision7Error(
      "manifest",
      `manifest missing files: expected ${expected.size}, listed ${seen.size}`,
    );
  }
  return sha256String(text);
}

// Reject ordinary symbolic links and record stable declared/real paths for a
// critical executable/file. NOTE: lstatSync does NOT detect every Windows
// reparse-point form; this is not a full reparse-point exclusion.
export function assertRealRegularFile(path, label) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Decision7Error("real-path", `${label} path is empty`);
  }
  let ls;
  try {
    ls = lstatSync(path);
  } catch (err) {
    throw new Decision7Error(
      "real-path",
      `${label} lstat failed (${path}): ${err?.message ?? err}`,
    );
  }
  if (ls.isSymbolicLink()) {
    throw new Decision7Error("real-path", `${label} is a symbolic link (rejected): ${path}`);
  }
  if (!ls.isFile()) {
    throw new Decision7Error("real-path", `${label} is not a regular file: ${path}`);
  }
  let realPath;
  try {
    realPath = realpathSync.native(path);
  } catch (err) {
    throw new Decision7Error(
      "real-path",
      `${label} realpath failed (${path}): ${err?.message ?? err}`,
    );
  }
  if (realpathSync.native(realPath) !== realPath) {
    throw new Decision7Error("real-path", `${label} real path is not stable: ${path}`);
  }
  return { declaredPath: path, realPath };
}

// Directory counterpart of assertRealRegularFile. Same reparse-point caveat.
export function assertRealDirectory(path, label) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Decision7Error("real-path", `${label} path is empty`);
  }
  let ls;
  try {
    ls = lstatSync(path);
  } catch (err) {
    throw new Decision7Error(
      "real-path",
      `${label} lstat failed (${path}): ${err?.message ?? err}`,
    );
  }
  if (ls.isSymbolicLink()) {
    throw new Decision7Error("real-path", `${label} is a symbolic link (rejected): ${path}`);
  }
  if (!ls.isDirectory()) {
    throw new Decision7Error("real-path", `${label} is not a directory: ${path}`);
  }
  let realPath;
  try {
    realPath = realpathSync.native(path);
  } catch (err) {
    throw new Decision7Error(
      "real-path",
      `${label} realpath failed (${path}): ${err?.message ?? err}`,
    );
  }
  if (realpathSync.native(realPath) !== realPath) {
    throw new Decision7Error("real-path", `${label} real path is not stable: ${path}`);
  }
  return { declaredPath: path, realPath };
}

// Validate an evidence directory whose leaf may not exist yet: resolve the nearest
// existing ancestor's real path, append the unresolved suffix, then reject unsafe
// destinations (== repo root, inside scripts/decision7 or packages/, or containing
// the temp wrapper directory). Returns the resolved absolute target.
export function assertSafeEvidenceDir(evidenceDir, opts) {
  if (typeof evidenceDir !== "string" || evidenceDir.length === 0) {
    throw new Decision7Error("evidence-dir", "evidence directory is empty");
  }
  let cursor = resolve(evidenceDir);
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Decision7Error("evidence-dir", `no existing ancestor for ${evidenceDir}`);
    }
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  const ancestorReal = realpathSync.native(cursor);
  const resolvedTarget = suffix.length > 0 ? join(ancestorReal, ...suffix) : ancestorReal;

  const norm = (p) => p.replace(/[\\/]+$/, "").toLowerCase();
  const within = (child, parent) => {
    const c = norm(child);
    const p = norm(parent);
    return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`);
  };
  const repoRoot = opts.repoRootRealPath;
  if (norm(resolvedTarget) === norm(repoRoot)) {
    throw new Decision7Error(
      "evidence-dir",
      `evidence directory must not be the repository root: ${resolvedTarget}`,
    );
  }
  if (within(resolvedTarget, join(repoRoot, "scripts", "decision7"))) {
    throw new Decision7Error(
      "evidence-dir",
      `evidence directory must not be inside scripts/decision7: ${resolvedTarget}`,
    );
  }
  if (within(resolvedTarget, join(repoRoot, "packages"))) {
    throw new Decision7Error(
      "evidence-dir",
      `evidence directory must not be inside packages/: ${resolvedTarget}`,
    );
  }
  if (typeof opts.tempDirRealPath === "string" && within(opts.tempDirRealPath, resolvedTarget)) {
    throw new Decision7Error(
      "evidence-dir",
      `evidence directory must not contain the temporary wrapper directory: ${resolvedTarget}`,
    );
  }
  return resolvedTarget;
}

function hasUnsafeWrapperChar(path) {
  for (const ch of path) {
    if (UNSAFE_WRAPPER_CHARS.has(ch)) {
      return true;
    }
    const code = ch.codePointAt(0);
    if (code === 0 || code === 13 || code === 10) {
      return true;
    }
  }
  return false;
}

// Reject unsafe interpolated paths rather than inventing a batch-escaping
// algorithm: absolute, no rejected metacharacters/control chars, no trailing
// space/period in a component, and an existing regular file.
export function assertUsableInterpolatedPath(path, label) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Decision7Error("unsafe-path", `${label} path is empty`);
  }
  if (!/^[a-zA-Z]:\\/.test(path) && !path.startsWith("\\\\")) {
    throw new Decision7Error("unsafe-path", `${label} path is not absolute: ${path}`);
  }
  if (hasUnsafeWrapperChar(path)) {
    throw new Decision7Error("unsafe-path", `${label} path contains a rejected character: ${path}`);
  }
  for (const comp of path.split(/[\\/]/)) {
    if (comp.length === 0 || comp === "." || comp === "..") {
      continue;
    }
    if (comp.endsWith(" ") || comp.endsWith(".")) {
      throw new Decision7Error(
        "unsafe-path",
        `${label} path component has a trailing space or period: ${comp}`,
      );
    }
  }
  if (!existsSync(path)) {
    throw new Decision7Error("unsafe-path", `${label} path does not exist: ${path}`);
  }
  if (!statSync(path).isFile()) {
    throw new Decision7Error("unsafe-path", `${label} path is not a regular file: ${path}`);
  }
}

// Exactly two CRLF-terminated lines, no %*, both paths validated + quoted.
export function buildWrapperBytes(nodePath, fixturePath) {
  assertUsableInterpolatedPath(nodePath, "node");
  assertUsableInterpolatedPath(fixturePath, "fixture");
  return `@echo off\r\n"${nodePath}" "${fixturePath}"\r\n`;
}

// Exact byte comparison of the reread wrapper against the expected text; returns
// the digest so the harness need not reread again.
export function verifyWrapperBytes(wrapperPath, expectedText) {
  const actual = readFileSync(wrapperPath);
  const expected = Buffer.from(expectedText, "utf8");
  if (!actual.equals(expected)) {
    throw new Decision7Error(
      "wrapper-mismatch",
      `generated wrapper bytes do not match expected bytes: ${wrapperPath}`,
    );
  }
  return sha256String(expectedText);
}
