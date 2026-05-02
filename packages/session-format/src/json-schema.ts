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
// (e.g., the noise-budget recommendation requirement on CheckResult); those
// stay enforced only at the zod level.

import { z } from "zod";
import {
  ChangedFileSchema,
  CheckResultSchema,
  EvidenceSchema,
  ManifestSchema,
  SessionReportSchema,
} from "./schemas.js";

const JSON_SCHEMA_OPTIONS = { target: "draft-2020-12" as const };

export const EvidenceJsonSchema = z.toJSONSchema(EvidenceSchema, JSON_SCHEMA_OPTIONS);
export const ChangedFileJsonSchema = z.toJSONSchema(ChangedFileSchema, JSON_SCHEMA_OPTIONS);
export const CheckResultJsonSchema = z.toJSONSchema(CheckResultSchema, JSON_SCHEMA_OPTIONS);
export const ManifestJsonSchema = z.toJSONSchema(ManifestSchema, JSON_SCHEMA_OPTIONS);
export const SessionReportJsonSchema = z.toJSONSchema(SessionReportSchema, JSON_SCHEMA_OPTIONS);
