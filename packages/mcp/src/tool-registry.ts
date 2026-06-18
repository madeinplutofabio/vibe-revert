// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Per-tool registration aggregator.
//
// Architectural locks:
//
//   D99.E -- each tool's registration combines its (name, definition,
//   handler, sideEffectClass) via defineToolRegistration. The TName
//   generic in ToolRegistration enforces (i) registration.name ===
//   definition.name and (ii) sideEffectClass === locked map entry.
//
//   Order discipline -- TOOL_REGISTRATIONS_IN_ORDER MUST list
//   registrations in TOOL_NAMES_IN_ORDER order (D99.A). The
//   "M G1a Step 3.3 D99.M @viberevert/mcp per-tool + registry"
//   invariant AST-asserts this is a prefix-or-subsequence of
//   the catalog (resolved through the local var->tool map so
//   reordering bugs are caught). The final "exactly equals all 8"
//   assertion lands in Slice 3.7 when the catalog is complete.
//
//   SDK-free -- this file imports only the tools contract +
//   per-tool definitions/handlers. No @modelcontextprotocol/sdk
//   import.
//
//   Step 4's dispatcher imports TOOL_REGISTRATIONS_IN_ORDER and
//   builds a Map<ToolName, ToolRegistration> for O(1) lookup at
//   tools/call dispatch time.

import * as checkRepo from "./tools/check-repo.js";
import * as classifyRisk from "./tools/classify-risk.js";
import * as createCheckpoint from "./tools/create-checkpoint.js";
import * as explainDiff from "./tools/explain-diff.js";
import * as generateFixPrompt from "./tools/generate-fix-prompt.js";
import * as getPolicy from "./tools/get-policy.js";
import * as listRiskyFiles from "./tools/list-risky-files.js";
import * as startSession from "./tools/start-session.js";
import { defineToolRegistration, TOOL_SIDE_EFFECT_CLASS_BY_NAME } from "./tools.js";

// Per-tool registrations. Each literal `name: "<tool>"` gives
// defineToolRegistration the narrow TName so its TName-bound
// constraints fire:
//   - definition.name MUST equal the literal name (NoInfer<TName>)
//   - sideEffectClass MUST equal TOOL_SIDE_EFFECT_CLASS_BY_NAME[name]

const checkRepoRegistration = defineToolRegistration({
  name: "check_repo",
  definition: checkRepo.definition,
  handler: checkRepo.handler,
  sideEffectClass: TOOL_SIDE_EFFECT_CLASS_BY_NAME.check_repo,
});

const explainDiffRegistration = defineToolRegistration({
  name: "explain_diff",
  definition: explainDiff.definition,
  handler: explainDiff.handler,
  sideEffectClass: TOOL_SIDE_EFFECT_CLASS_BY_NAME.explain_diff,
});

const classifyRiskRegistration = defineToolRegistration({
  name: "classify_risk",
  definition: classifyRisk.definition,
  handler: classifyRisk.handler,
  sideEffectClass: TOOL_SIDE_EFFECT_CLASS_BY_NAME.classify_risk,
});

const listRiskyFilesRegistration = defineToolRegistration({
  name: "list_risky_files",
  definition: listRiskyFiles.definition,
  handler: listRiskyFiles.handler,
  sideEffectClass: TOOL_SIDE_EFFECT_CLASS_BY_NAME.list_risky_files,
});

const getPolicyRegistration = defineToolRegistration({
  name: "get_policy",
  definition: getPolicy.definition,
  handler: getPolicy.handler,
  sideEffectClass: TOOL_SIDE_EFFECT_CLASS_BY_NAME.get_policy,
});

const startSessionRegistration = defineToolRegistration({
  name: "start_session",
  definition: startSession.definition,
  handler: startSession.handler,
  sideEffectClass: TOOL_SIDE_EFFECT_CLASS_BY_NAME.start_session,
});

const createCheckpointRegistration = defineToolRegistration({
  name: "create_checkpoint",
  definition: createCheckpoint.definition,
  handler: createCheckpoint.handler,
  sideEffectClass: TOOL_SIDE_EFFECT_CLASS_BY_NAME.create_checkpoint,
});

const generateFixPromptRegistration = defineToolRegistration({
  name: "generate_fix_prompt",
  definition: generateFixPrompt.definition,
  handler: generateFixPrompt.handler,
  sideEffectClass: TOOL_SIDE_EFFECT_CLASS_BY_NAME.generate_fix_prompt,
});

/**
 * The ordered list of tool registrations. Order MUST match
 * TOOL_NAMES_IN_ORDER (D99.A). Slice 3.7 completes the catalog:
 * all 8 tools registered.
 */
export const TOOL_REGISTRATIONS_IN_ORDER = [
  checkRepoRegistration,
  explainDiffRegistration,
  classifyRiskRegistration,
  listRiskyFilesRegistration,
  getPolicyRegistration,
  startSessionRegistration,
  createCheckpointRegistration,
  generateFixPromptRegistration,
] as const;
