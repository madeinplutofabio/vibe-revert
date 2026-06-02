// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// JSON Schema exports for VibeRevert persisted artifacts.
//
// These are derived from the canonical zod schemas in ./schemas.ts via Zod 4's
// native z.toJSONSchema(). The output targets JSON Schema draft 2020-12.
//
// Use these when:
//   - publishing the schema to external consumers (MCP tools, cloud ingest)
//   - generating documentation
//   - enabling JSON-validating IDE tooling against persisted artifacts
//
// Use the zod schemas (./schemas.ts) directly when validating values inside
// TypeScript code. toJSONSchema cannot always express custom .refine() rules
// (e.g., the high/critical recommendation requirement on CheckResult; the
// ended_at <-> after_status_path coupling on SessionState; the M C
// noise-budget caps on SessionReport; the M C ReportFile wrapper's
// kind/since_kind consistency, ULID-shape regex on report_id, staged_only
// ↔ kind consistency, and the identity invariant tying report_id to the
// embedded report.session_id; the M D ReceiptFile wrapper's 10 refines
// including 3 ULID-shape regexes (rb_/sess_/cp_), pre_rollback_checkpoint_id
// ULID format when non-null, mode/pre_rollback_checkpoint_id coupling,
// active_session_warning ↔ dry_run, D61b warning/check coupling,
// forced_unrelated_dirty_paths audit refine, skipped_unrelated_dirt
// dry-run-only enforcement, and forced=true apply-only enforcement; the M D
// SessionState additive after_status_z_path → ended one-way coupling refine);
// those stay enforced only at the zod level.
//
// D21 invariant: every persisted-artifact zod schema in ./schemas.ts MUST have
// a corresponding *JsonSchema export here, re-exported from ./index.ts.

import { z } from "zod";
import {
  ActiveSessionLockSchema,
  ChangedFileSchema,
  CheckResultSchema,
  EvidenceSchema,
  ManifestSchema,
  ReceiptFileSchema,
  ReportFileSchema,
  SessionReportSchema,
  SessionStateSchema,
} from "./schemas.js";

const JSON_SCHEMA_OPTIONS = { target: "draft-2020-12" as const };

export const EvidenceJsonSchema = z.toJSONSchema(EvidenceSchema, JSON_SCHEMA_OPTIONS);
export const ChangedFileJsonSchema = z.toJSONSchema(ChangedFileSchema, JSON_SCHEMA_OPTIONS);
export const CheckResultJsonSchema = z.toJSONSchema(CheckResultSchema, JSON_SCHEMA_OPTIONS);
export const ManifestJsonSchema = z.toJSONSchema(ManifestSchema, JSON_SCHEMA_OPTIONS);
export const SessionReportJsonSchema = z.toJSONSchema(SessionReportSchema, JSON_SCHEMA_OPTIONS);
export const SessionStateJsonSchema = z.toJSONSchema(SessionStateSchema, JSON_SCHEMA_OPTIONS);
export const ActiveSessionLockJsonSchema = z.toJSONSchema(
  ActiveSessionLockSchema,
  JSON_SCHEMA_OPTIONS,
);
export const ReportFileJsonSchema = z.toJSONSchema(ReportFileSchema, JSON_SCHEMA_OPTIONS);
export const ReceiptFileJsonSchema = z.toJSONSchema(ReceiptFileSchema, JSON_SCHEMA_OPTIONS);
