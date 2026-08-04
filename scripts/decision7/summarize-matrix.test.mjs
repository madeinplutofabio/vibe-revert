// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Deterministic tests for summarize-matrix.mjs (operator tooling; NOT product code,
// NOT a Vitest test). Run with: node --test scripts/decision7/summarize-matrix.test.mjs
// Fixtures are built in the OS temp dir from the lib's own manifest/hash helpers with
// fixed past timestamps, so every case is fully deterministic. Report content is read
// from the atomically written --out file (durable regardless of exit timing); exit
// codes come from the child status.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import {
  computeManifestText,
  HARNESS_IMPLEMENTATION_VERSION,
  MATRIX_DEFINITION,
  PROTOCOL_VERSION,
  REQUIRED_REPETITIONS,
  RESULT_SCHEMA_VERSION,
  sha256String,
} from "./decision7-lib.mjs";
import { buildOperatorTemplate } from "./operator-template.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUMMARIZER = join(HERE, "summarize-matrix.mjs");
const CASE_A = MATRIX_DEFINITION.requiredCases[0];

const OPERATOR_KEYS = [
  "batch_prompt_observed",
  "completed_at",
  "name",
  "notes",
  "run_verdict",
  "unexpected_console_behavior",
  "wrapper_completion_confirmed",
];

const REPORTS_DIR = mkdtempSync(join(tmpdir(), "d7-reports-"));
after(() => {
  try {
    rmSync(REPORTS_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

let reportSeq = 0;
// Report content is captured from the atomically written --out file.
function run(evidenceDir, extraArgs = []) {
  const outFile = join(REPORTS_DIR, `r-${reportSeq++}.json`);
  const res = spawnSync(
    process.execPath,
    [SUMMARIZER, "--evidence-dir", evidenceDir, "--json", "--out", outFile, ...extraArgs],
    { encoding: "utf8" },
  );
  if ((res.status === 0 || res.status === 1) && !existsSync(outFile)) {
    assert.fail(`summarizer exited ${res.status} without writing ${outFile}: ${res.stderr}`);
  }
  const report = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : null;
  return { code: res.status, stderr: res.stderr, report };
}

// For --out-behaviour + refusal tests: run without the auto --out.
function runRaw(evidenceDir, extraArgs = []) {
  const res = spawnSync(
    process.execPath,
    [SUMMARIZER, "--evidence-dir", evidenceDir, "--json", ...extraArgs],
    { encoding: "utf8" },
  );
  return { code: res.status, stderr: res.stderr };
}

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "d7-sum-"));
}

function withRoot(fn) {
  const root = freshRoot();
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function identityFor(caseId) {
  return {
    attestationDigest: sha256String(`attestation:${caseId}`),
    gitCommit: sha256String(`commit:${caseId}`).slice(0, 40),
    nodeVersion: process.version,
    comSpecSha256: sha256String(`comspec:${caseId}`),
    operatorTemplateSha256: sha256String(`optmpl:${caseId}`),
    consoleTemplateSha256: sha256String(`contmpl:${caseId}`),
    hostLabel: `Label ${caseId}`,
  };
}

function tsFor(repetition) {
  const mm = String(repetition).padStart(2, "0");
  return {
    attemptCreatedAt: `2026-08-01T10:${mm}:00.000Z`,
    harnessTs: `2026-08-01T10:${mm}:00.000Z`,
    completedAt: `2026-08-01T10:${mm}:30.000Z`,
  };
}

function buildYaml(runId, caseId, repetition, op, { raw = {}, extra = {} } = {}) {
  const lines = [
    "run:",
    `  runId: "${runId}"`,
    `  matrixCaseId: "${caseId}"`,
    `  repetition: ${repetition}`,
    `  requiredRepetitions: ${REQUIRED_REPETITIONS}`,
    "operator:",
  ];
  for (const key of OPERATOR_KEYS) {
    if (Object.hasOwn(raw, key)) {
      lines.push(`  ${key}: ${raw[key]}`);
    } else {
      lines.push(`  ${key}: "${op[key]}"`);
    }
  }
  for (const [k, v] of Object.entries(extra)) {
    lines.push(`  ${k}: "${v}"`);
  }
  lines.push("");
  return lines.join("\n");
}

// Build a fully-valid sealed bundle; options mutate exactly one axis for a negative case.
function makeBundle(evidenceDir, caseId, opts) {
  const {
    repetition,
    runId = randomUUID(),
    newAttempt = false,
    identity = identityFor(caseId),
    attemptCreatedAt,
    harnessTs,
    completedAt,
    operatorOverrides = {},
    operatorRaw = {},
    operatorExtra = {},
    consoleText = "Console: AGENT-INTERRUPTED shown; wrapper exited without a batch prompt.\n",
    markOperatorUnedited = false,
    omitRawFiles = [],
    extraRawFiles = [],
    tamperAfterManifest = null,
    omitManifest = false,
    harnessEventOverrides = {},
    harnessEventsContent = null,
  } = opts;

  const t = tsFor(repetition);
  const createdAt = attemptCreatedAt ?? t.attemptCreatedAt;
  const hTs = harnessTs ?? t.harnessTs;
  const cAt = completedAt ?? t.completedAt;
  const attemptTimestamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const [terminalHost, shellHost] = caseId.split("__");
  const leaf = newAttempt
    ? `repetition-${repetition}__attempt-${attemptTimestamp}-${runId}`
    : `repetition-${repetition}`;

  const bundleDir = join(evidenceDir, caseId, leaf);
  const rawDir = join(bundleDir, "raw");
  const operatorDir = join(bundleDir, "operator");

  const metadata = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    harnessImplementationVersion: HARNESS_IMPLEMENTATION_VERSION,
    matrixDefinition: { matrixDefinitionVersion: MATRIX_DEFINITION.matrixDefinitionVersion },
    runId,
    matrixCaseId: caseId,
    repetition,
    requiredRepetitions: REQUIRED_REPETITIONS,
    newAttempt,
    attempt: { leaf, attemptCreatedAt: createdAt, attemptTimestamp },
    terminalHost,
    shellHost,
    hostLabel: identity.hostLabel,
    identity: {
      attestationDigest: identity.attestationDigest,
      gitCommit: identity.gitCommit,
      nodeVersion: identity.nodeVersion,
      comSpecSha256: identity.comSpecSha256,
      operatorTemplateSha256: identity.operatorTemplateSha256,
      consoleTemplateSha256: identity.consoleTemplateSha256,
    },
  };

  const machine = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    harnessImplementationVersion: HARNESS_IMPLEMENTATION_VERSION,
    runId,
    matrixCaseId: caseId,
    repetition,
    internal_failure: false,
    rawEvidenceComplete: true,
    integrity_status: "complete",
    experiment_validity: "valid",
    event_protocol_valid: true,
    interactive_delivery: "received",
    candidate_wrapper_completion: "clean_exit",
    eligibility_constraints: { eligibility_constraints_satisfied: true, diagnostic_overrides: [] },
  };

  const harnessEvent = {
    type: "observation_window_end",
    source: "harness",
    protocolVersion: PROTOCOL_VERSION,
    harnessImplementationVersion: HARNESS_IMPLEMENTATION_VERSION,
    runId,
    token: randomUUID(),
    ts: hTs,
    monotonicMs: 1234.5,
    ...harnessEventOverrides,
  };

  const op = {
    name: "Test Operator",
    completed_at: cAt,
    batch_prompt_observed: "no",
    unexpected_console_behavior: "none",
    wrapper_completion_confirmed: "clean_exit",
    run_verdict: "eligible_candidate",
    notes: "none",
    ...operatorOverrides,
  };
  const yamlText = buildYaml(runId, caseId, repetition, op, {
    raw: operatorRaw,
    extra: operatorExtra,
  });
  if (markOperatorUnedited) {
    metadata.identity.operatorTemplateSha256 = sha256String(yamlText);
  }

  const rawFiles = {
    "metadata.json": `${JSON.stringify(metadata, null, 2)}\n`,
    "result.machine.json": `${JSON.stringify(machine, null, 2)}\n`,
    "harness-events.jsonl": harnessEventsContent ?? `${JSON.stringify(harnessEvent)}\n`,
    "fixture-events.jsonl": `${JSON.stringify({ type: "ready", source: "fixture", runId })}\n`,
    "cleanup.txt": "cleanup: nothing to kill; wrapper exited cleanly.\n",
  };

  mkdirSync(rawDir, { recursive: true });
  mkdirSync(operatorDir, { recursive: true });
  for (const [name, content] of Object.entries(rawFiles)) {
    if (!omitRawFiles.includes(name)) {
      writeFileSync(join(rawDir, name), content);
    }
  }
  writeFileSync(join(operatorDir, "result.operator.yaml"), yamlText);
  writeFileSync(join(operatorDir, "console-observation.txt"), consoleText);

  if (!omitManifest) {
    writeFileSync(join(bundleDir, "manifest.sha256"), computeManifestText(rawDir, "raw"));
  }
  for (const { name, content } of extraRawFiles) {
    writeFileSync(join(rawDir, name), content);
  }
  if (tamperAfterManifest) {
    tamperAfterManifest(rawDir);
  }
  return bundleDir;
}

function makeValidCase(evidenceDir, caseId) {
  for (const rep of [1, 2, 3]) {
    makeBundle(evidenceDir, caseId, { repetition: rep });
  }
}

// ---------------------------------------------------------------------------
// Matrix-level behaviour
// ---------------------------------------------------------------------------

test("empty evidence root -> not eligible, all cases no_evidence, exit 1", () => {
  withRoot((root) => {
    const r = run(root);
    assert.equal(r.code, 1);
    assert.equal(r.report.matrixEligible, false);
    for (const caseId of MATRIX_DEFINITION.requiredCases) {
      assert.equal(r.report.cases[caseId].status, "no_evidence");
    }
  });
});

test("full valid matrix -> every case eligible, matrixEligible, exit 0", () => {
  withRoot((root) => {
    for (const caseId of MATRIX_DEFINITION.requiredCases) {
      makeValidCase(root, caseId);
    }
    const r = run(root);
    assert.equal(r.code, 0);
    assert.equal(r.report.matrixEligible, true);
    for (const caseId of MATRIX_DEFINITION.requiredCases) {
      assert.equal(r.report.cases[caseId].status, "eligible");
      assert.deepEqual(r.report.cases[caseId].winning, [
        "repetition-1",
        "repetition-2",
        "repetition-3",
      ]);
    }
  });
});

test("a case with only two reps is ineligible", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1 });
    makeBundle(root, CASE_A, { repetition: 2 });
    const c = run(root).report.cases[CASE_A];
    assert.equal(c.status, "ineligible");
    assert.equal(c.winning, null);
  });
});

// ---------------------------------------------------------------------------
// Sealing / raw-artifact set
// ---------------------------------------------------------------------------

test("an extra raw file blocks sealing (raw_set checked before the manifest)", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, {
      repetition: 1,
      extraRawFiles: [{ name: "stray.txt", content: "x\n" }],
    });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.match(att.sealReason ?? "", /raw_set/);
  });
});

test("a missing required raw file blocks sealing", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1, omitRawFiles: ["cleanup.txt"] });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.match(att.sealReason ?? "", /raw_set/);
  });
});

test("a missing manifest blocks sealing", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1, omitManifest: true });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.sealed, false);
    assert.equal(att.sealReason, "no_manifest");
  });
});

test("tampering a raw file after sealing fails manifest verification", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, {
      repetition: 1,
      tamperAfterManifest: (rawDir) => appendFileSync(join(rawDir, "cleanup.txt"), "tampered\n"),
    });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.equal(att.sealed, false);
    assert.notEqual(att.sealReason, "no_manifest");
  });
});

// ---------------------------------------------------------------------------
// Operator schema / verdict
// ---------------------------------------------------------------------------

test("operator run_verdict=blocked makes the attempt non-counting", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1, operatorOverrides: { run_verdict: "blocked" } });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.ok(att.operatorReasons.some((x) => x.startsWith("run_verdict_vetoes")));
  });
});

test("completed_at earlier than the final harness event is rejected", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, {
      repetition: 1,
      operatorOverrides: { completed_at: "2026-08-01T09:00:00.000Z" },
    });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.ok(att.operatorReasons.includes("completed_at_before_final_harness_event"));
  });
});

test("operator yaml identical to the template digest is rejected", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1, markOperatorUnedited: true });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.ok(att.operatorReasons.includes("operator_yaml_unedited"));
  });
});

test("an extra operator YAML key is rejected", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1, operatorExtra: { bogus_field: "x" } });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.ok(att.operatorReasons.includes("operator_operator_keys"));
  });
});

test("a non-string operator field is rejected", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1, operatorRaw: { notes: "123" } });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.ok(att.operatorReasons.includes("operator_notes_not_string"));
  });
});

test("a whitespace-only free-text field is rejected as empty", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1, operatorOverrides: { notes: "   " } });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.ok(att.operatorReasons.includes("operator_notes_empty"));
  });
});

test("a same-length invalid enum is rejected from actual content, not accepted on digest difference", () => {
  withRoot((root) => {
    // "clean_exit" (10) -> "clean_exi7" (10, not in the vocabulary); digest differs from template.
    makeBundle(root, CASE_A, {
      repetition: 1,
      operatorOverrides: { wrapper_completion_confirmed: "clean_exi7" },
    });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.ok(att.operatorReasons.includes("wrapper_completion_confirmed_invalid"));
  });
});

test("the real operator template's unquoted scalar fields parse as strings (YAML 1.2 core)", () => {
  const tmpl = buildOperatorTemplate("11111111-1111-4111-8111-111111111111", CASE_A, 1);
  const filled = tmpl
    .replace("name: TO_BE_FILLED", "name: Alice Example")
    .replace("completed_at: TO_BE_FILLED", "completed_at: 2026-08-04T13:45:07.123Z")
    .replace("batch_prompt_observed: TO_BE_FILLED", "batch_prompt_observed: no")
    .replace("unexpected_console_behavior: TO_BE_FILLED", "unexpected_console_behavior: none")
    .replace(
      "wrapper_completion_confirmed: TO_BE_FILLED",
      "wrapper_completion_confirmed: clean_exit",
    )
    .replace("run_verdict: TO_BE_FILLED", "run_verdict: eligible_candidate")
    .replace("notes: TO_BE_FILLED", "notes: none");
  const doc = parse(filled);
  for (const key of OPERATOR_KEYS) {
    assert.equal(typeof doc.operator[key], "string", `operator.${key} should be a string`);
  }
  assert.equal(doc.operator.completed_at, "2026-08-04T13:45:07.123Z");
  assert.equal(doc.operator.batch_prompt_observed, "no");
  assert.equal(doc.operator.wrapper_completion_confirmed, "clean_exit");
  assert.equal(doc.operator.run_verdict, "eligible_candidate");
});

// ---------------------------------------------------------------------------
// Identity / host consistency
// ---------------------------------------------------------------------------

test("host-label drift on rep2 prevents advancement (case ineligible)", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1 });
    makeBundle(root, CASE_A, {
      repetition: 2,
      identity: { ...identityFor(CASE_A), hostLabel: "Drifted Label" },
    });
    makeBundle(root, CASE_A, { repetition: 3 });
    const c = run(root).report.cases[CASE_A];
    assert.equal(c.status, "ineligible");
    assert.equal(c.winning, null);
  });
});

test("an invalid template digest in identity prevents counting", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, {
      repetition: 1,
      identity: { ...identityFor(CASE_A), operatorTemplateSha256: "not-a-hex-digest" },
    });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.ok(att.bindingReasons.some((r) => r.startsWith("identity:")));
  });
});

test("a null attestation digest prevents counting", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, {
      repetition: 1,
      identity: { ...identityFor(CASE_A), attestationDigest: null },
    });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.ok(att.bindingReasons.some((r) => r.startsWith("identity:")));
  });
});

// ---------------------------------------------------------------------------
// Reset-and-reconsider walk
// ---------------------------------------------------------------------------

test("a later eligible rep1 restarts the sequence; the win begins at the second rep1", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, {
      repetition: 1,
      attemptCreatedAt: "2026-08-01T10:01:00.000Z",
      harnessTs: "2026-08-01T10:01:00.000Z",
      completedAt: "2026-08-01T10:01:30.000Z",
    });
    const secondRep1 = makeBundle(root, CASE_A, {
      repetition: 1,
      newAttempt: true,
      attemptCreatedAt: "2026-08-01T10:02:00.000Z",
      harnessTs: "2026-08-01T10:02:00.000Z",
      completedAt: "2026-08-01T10:02:30.000Z",
    });
    makeBundle(root, CASE_A, {
      repetition: 2,
      attemptCreatedAt: "2026-08-01T10:03:00.000Z",
      harnessTs: "2026-08-01T10:03:00.000Z",
      completedAt: "2026-08-01T10:03:30.000Z",
    });
    makeBundle(root, CASE_A, {
      repetition: 3,
      attemptCreatedAt: "2026-08-01T10:04:00.000Z",
      harnessTs: "2026-08-01T10:04:00.000Z",
      completedAt: "2026-08-01T10:04:30.000Z",
    });
    const c = run(root).report.cases[CASE_A];
    assert.equal(c.status, "eligible");
    assert.deepEqual(c.winning, [basename(secondRep1), "repetition-2", "repetition-3"]);
  });
});

test("a non-counting orderable attempt between rep1 and rep2 resets the sequence", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, {
      repetition: 1,
      attemptCreatedAt: "2026-08-01T10:01:00.000Z",
      harnessTs: "2026-08-01T10:01:00.000Z",
      completedAt: "2026-08-01T10:01:30.000Z",
    });
    makeBundle(root, CASE_A, {
      repetition: 2,
      newAttempt: true,
      attemptCreatedAt: "2026-08-01T10:02:00.000Z",
      harnessTs: "2026-08-01T10:02:00.000Z",
      completedAt: "2026-08-01T10:02:30.000Z",
      operatorOverrides: { run_verdict: "blocked" },
    });
    makeBundle(root, CASE_A, {
      repetition: 2,
      attemptCreatedAt: "2026-08-01T10:03:00.000Z",
      harnessTs: "2026-08-01T10:03:00.000Z",
      completedAt: "2026-08-01T10:03:30.000Z",
    });
    makeBundle(root, CASE_A, {
      repetition: 3,
      attemptCreatedAt: "2026-08-01T10:04:00.000Z",
      harnessTs: "2026-08-01T10:04:00.000Z",
      completedAt: "2026-08-01T10:04:30.000Z",
    });
    const c = run(root).report.cases[CASE_A];
    assert.equal(c.status, "ineligible");
    assert.equal(c.winning, null);
  });
});

test("an orderable non-counting attempt after a completed sequence does not revoke it", () => {
  withRoot((root) => {
    makeValidCase(root, CASE_A);
    makeBundle(root, CASE_A, {
      repetition: 1,
      newAttempt: true,
      attemptCreatedAt: "2026-08-01T10:09:00.000Z",
      harnessTs: "2026-08-01T10:09:00.000Z",
      completedAt: "2026-08-01T10:09:30.000Z",
      operatorOverrides: { run_verdict: "blocked" },
    });
    const c = run(root).report.cases[CASE_A];
    assert.equal(c.status, "eligible");
    assert.deepEqual(c.winning, ["repetition-1", "repetition-2", "repetition-3"]);
  });
});

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

test("attempts are evaluated in chronological order, not readdir/name order", () => {
  withRoot((root) => {
    // Same identity, all counting, but timestamps REVERSED vs the repetition-N name order.
    makeBundle(root, CASE_A, {
      repetition: 1,
      attemptCreatedAt: "2026-08-01T10:03:00.000Z",
      harnessTs: "2026-08-01T10:03:00.000Z",
      completedAt: "2026-08-01T10:03:30.000Z",
    });
    makeBundle(root, CASE_A, {
      repetition: 2,
      attemptCreatedAt: "2026-08-01T10:02:00.000Z",
      harnessTs: "2026-08-01T10:02:00.000Z",
      completedAt: "2026-08-01T10:02:30.000Z",
    });
    makeBundle(root, CASE_A, {
      repetition: 3,
      attemptCreatedAt: "2026-08-01T10:01:00.000Z",
      harnessTs: "2026-08-01T10:01:00.000Z",
      completedAt: "2026-08-01T10:01:30.000Z",
    });
    const c = run(root).report.cases[CASE_A];
    assert.deepEqual(
      c.attempts.map((a) => a.attemptCreatedAt),
      ["2026-08-01T10:01:00.000Z", "2026-08-01T10:02:00.000Z", "2026-08-01T10:03:00.000Z"],
    );
    assert.deepEqual(
      c.attempts.map((a) => a.name),
      ["repetition-3", "repetition-2", "repetition-1"],
    );
    // A name-order walk would see 1->2->3 and certify; chronological order does not.
    assert.equal(c.status, "ineligible");
    assert.equal(c.winning, null);
  });
});

// ---------------------------------------------------------------------------
// Case-level blockers
// ---------------------------------------------------------------------------

test("a metadata-less repetition dir is unorderable and blocks the case", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1 });
    mkdirSync(join(root, CASE_A, "repetition-2"), { recursive: true });
    const c = run(root).report.cases[CASE_A];
    assert.equal(c.status, "blocked");
    assert.ok(c.anomalies.some((a) => a.includes("no_metadata")));
  });
});

test("mixed attestation digests across reps block the case", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1 });
    makeBundle(root, CASE_A, { repetition: 2 });
    makeBundle(root, CASE_A, {
      repetition: 3,
      identity: { ...identityFor(CASE_A), attestationDigest: sha256String("different-identity") },
    });
    const c = run(root).report.cases[CASE_A];
    assert.equal(c.status, "blocked");
    assert.ok(c.anomalies.some((a) => a.startsWith("mixed_attestation_digests")));
  });
});

test("duplicate runId within a case blocks it", () => {
  withRoot((root) => {
    const shared = randomUUID();
    makeBundle(root, CASE_A, { repetition: 1, runId: shared });
    makeBundle(root, CASE_A, { repetition: 2, runId: shared });
    const c = run(root).report.cases[CASE_A];
    assert.equal(c.status, "blocked");
    assert.ok(c.anomalies.some((a) => a.startsWith("duplicate_run_ids")));
  });
});

// ---------------------------------------------------------------------------
// Harness-event trust
// ---------------------------------------------------------------------------

test("malformed harness JSONL makes completed_at unverifiable", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1, harnessEventsContent: "this is not json\n" });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.ok(att.operatorReasons.some((r) => r.startsWith("completed_at_unverifiable")));
  });
});

test("a harness event bound to another runId is rejected", () => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1, harnessEventOverrides: { runId: randomUUID() } });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.ok(att.operatorReasons.includes("completed_at_unverifiable:harness_event_untrusted"));
  });
});

test("a noncanonical harness timestamp is rejected", () => {
  withRoot((root) => {
    // valid instant but no milliseconds -> not canonical YYYY-MM-DDTHH:MM:SS.mmmZ
    makeBundle(root, CASE_A, {
      repetition: 1,
      harnessEventOverrides: { ts: "2026-08-01T10:01:00Z" },
    });
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.ok(att.operatorReasons.includes("completed_at_unverifiable:harness_event_untrusted"));
  });
});

// ---------------------------------------------------------------------------
// Root-level entries
// ---------------------------------------------------------------------------

test("a stray file at the evidence root is a root anomaly (matrix ineligible)", () => {
  withRoot((root) => {
    for (const caseId of MATRIX_DEFINITION.requiredCases) {
      makeValidCase(root, caseId);
    }
    writeFileSync(join(root, "stray.txt"), "x\n");
    const r = run(root);
    assert.equal(r.code, 1);
    assert.equal(r.report.matrixEligible, false);
    assert.ok(r.report.rootAnomalies.some((a) => a.startsWith("stray.txt")));
  });
});

test("a regular decision7-build-attestation dir is ignored, not an anomaly", () => {
  withRoot((root) => {
    for (const caseId of MATRIX_DEFINITION.requiredCases) {
      makeValidCase(root, caseId);
    }
    mkdirSync(join(root, "decision7-build-attestation"));
    const r = run(root);
    assert.equal(r.code, 0);
    assert.equal(r.report.matrixEligible, true);
    assert.deepEqual(r.report.rootAnomalies, []);
    assert.ok(!r.report.extraCases.includes("decision7-build-attestation"));
  });
});

test("a symlinked decision7-build-attestation entry is a root anomaly", (t) => {
  withRoot((root) => {
    for (const caseId of MATRIX_DEFINITION.requiredCases) {
      makeValidCase(root, caseId);
    }

    const target = mkdtempSync(join(tmpdir(), "d7-attestation-target-"));
    try {
      const link = join(root, "decision7-build-attestation");
      try {
        symlinkSync(target, link, "junction");
      } catch (error) {
        t.skip(`reserved-root junction creation unavailable: ${error?.message ?? error}`);
        return;
      }

      const result = run(root);
      assert.equal(result.code, 1);
      assert.equal(result.report.matrixEligible, false);
      assert.ok(result.report.rootAnomalies.includes("decision7-build-attestation:symlink"));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Filesystem safety (symlinks; explicit platform skips)
// ---------------------------------------------------------------------------

test("a symlinked raw artifact cannot count", (t) => {
  withRoot((root) => {
    const bundleDir = makeBundle(root, CASE_A, { repetition: 1 });
    const target = join(root, "elsewhere-cleanup.txt");
    writeFileSync(target, "real cleanup contents\n");
    const rawCleanup = join(bundleDir, "raw", "cleanup.txt");
    rmSync(rawCleanup);
    try {
      symlinkSync(target, rawCleanup, "file");
    } catch (e) {
      t.skip(`file symlink creation unavailable: ${e?.message ?? e}`);
      return;
    }
    const att = run(root).report.cases[CASE_A].attempts[0];
    assert.equal(att.counts, false);
    assert.match(att.sealReason ?? "", /raw_set/);
  });
});

test("a symlink entry inside a required case blocks it", (t) => {
  withRoot((root) => {
    makeBundle(root, CASE_A, { repetition: 1 });
    const target = join(root, "sym-target.txt");
    writeFileSync(target, "x\n");
    const linkPath = join(root, CASE_A, "linked-entry");
    try {
      symlinkSync(target, linkPath, "file");
    } catch (e) {
      t.skip(`file symlink creation unavailable: ${e?.message ?? e}`);
      return;
    }
    const c = run(root).report.cases[CASE_A];
    assert.equal(c.status, "blocked");
    assert.ok(c.anomalies.some((a) => a.includes("symlink")));
  });
});

// ---------------------------------------------------------------------------
// --out safety
// ---------------------------------------------------------------------------

test("--out writes the report to an external path", () => {
  const root = freshRoot();
  const outDir = mkdtempSync(join(tmpdir(), "d7-out-"));
  try {
    for (const caseId of MATRIX_DEFINITION.requiredCases) {
      makeValidCase(root, caseId);
    }
    const outPath = join(outDir, "report.json");
    const res = runRaw(root, ["--out", outPath]);
    assert.equal(res.code, 0);
    assert.ok(existsSync(outPath));
    assert.equal(JSON.parse(readFileSync(outPath, "utf8")).matrixEligible, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("--out inside the evidence root is refused (exit 2)", () => {
  withRoot((root) => {
    makeValidCase(root, CASE_A);
    const res = runRaw(root, ["--out", join(root, "report.json")]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /inside the evidence root/);
  });
});

test("--out refuses to overwrite an existing target (exit 2)", () => {
  const root = freshRoot();
  const outDir = mkdtempSync(join(tmpdir(), "d7-out-"));
  try {
    makeValidCase(root, CASE_A);
    const outPath = join(outDir, "existing.json");
    writeFileSync(outPath, "{}\n");
    const res = runRaw(root, ["--out", outPath]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /refusing to overwrite/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("--out via a junction into the evidence root is refused", (t) => {
  const root = freshRoot();
  const outParent = mkdtempSync(join(tmpdir(), "d7-jun-"));
  try {
    makeValidCase(root, CASE_A);
    const junction = join(outParent, "into-root");
    try {
      symlinkSync(root, junction, "junction");
    } catch (e) {
      t.skip(`junction creation unavailable: ${e?.message ?? e}`);
      return;
    }
    const res = runRaw(root, ["--out", join(junction, "report.json")]);
    assert.equal(res.code, 2);
    assert.equal(existsSync(join(root, "report.json")), false);
    assert.equal(existsSync(join(junction, "report.json")), false);
    assert.match(
      res.stderr,
      /inside the evidence root|report output parent|symbolic link|junction|unsafe/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outParent, { recursive: true, force: true });
  }
});

test("--out onto an existing dangling symlink is refused (exit 2)", (t) => {
  const root = freshRoot();
  const outDir = mkdtempSync(join(tmpdir(), "d7-out-"));
  try {
    makeValidCase(root, CASE_A);
    const outPath = join(outDir, "dangling.json");
    try {
      symlinkSync(join(outDir, "nonexistent-target-xyz"), outPath, "file");
    } catch (e) {
      t.skip(`file symlink creation unavailable: ${e?.message ?? e}`);
      return;
    }
    const res = runRaw(root, ["--out", outPath]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /refusing to overwrite/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
