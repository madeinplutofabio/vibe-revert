// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Top-level fix-prompt renderer for @viberevert/reporters (M E Step 2).
//
// Single entry point that assembles the seven D85 sections in the
// locked order. No format dispatcher (text-only renderer; the only
// alternate path — `--llm` — is reserved as a hidden clipanion stub
// in the CLI per D84). No per-format overloads. One function returning
// one string.
//
// =============================================================================
// Locked design (per M E plan D81 + D85 + D90.7 + contract D81 / D85.9)
// =============================================================================
//
// 1. **One render call per invocation (D81 + D90.7).** This file's
//    `renderFixPrompt` is the ONE function the CLI's prompt-fix
//    command calls to produce the prompt string. The CLI then writes
//    the resulting string to both sinks (fix-prompt.txt via
//    writeFileAtomic, then stdout via context.stdout.write) per the
//    locked file-before-stdout write order. The architectural-
//    invariants test D90.7 asserts exactly ONE call site to
//    `renderFixPrompt(` in `packages/cli/src/commands/prompt-fix.ts`
//    — catches accidental drift where a future maintainer calls the
//    renderer twice (e.g., once for stdout, once for file) which
//    could diverge if a clock/random read sneaks in.
//
// 2. **Section assembly is the ONLY thing this file does.** All
//    rendering logic — preamble copy, source attribution, task probe,
//    repo context, sort + truncation + per-finding-block + evidence-
//    entry rendering, next-steps variants, footer — lives in
//    fix-prompt-template.ts. This file pulls those building blocks
//    together. Keeping the assembly seam thin makes the renderer's
//    overall structure obvious at a glance and means template changes
//    don't require touching the assembler.
//
// 3. **Section order matches contract D85 verbatim:**
//      1. Preamble (3 fixed paragraphs)
//      2. Source attribution (always rendered)
//      3. Task context (CONDITIONAL — omitted when renderTaskSection
//         returns null; never an empty placeholder section)
//      4. Repo context (always rendered)
//      5. Findings section (always rendered; section header + per-
//         finding blocks + optional omitted-count line)
//      6. Suggested next steps (always rendered; variant by source
//         kind)
//      7. Footer (always rendered; 3-line block)
//
// 4. **Separator + trailing newline (D81 + Rendered output format
//    section of the contract).** Sections are joined by exactly one
//    blank line (`\n\n`). The rendered prompt ends with exactly ONE
//    trailing `\n` after the footer's third line. Never zero (would
//    make terminal output run together with the shell prompt); never
//    two (would create a spurious blank line at end of file). LF
//    line endings only — the template helpers guarantee this via
//    normalizeInline / normalizeBlock; this assembler only adds `\n`
//    characters, never `\r`.
//
// 5. **Pure D29.** No I/O, no async, no clock reads, no random
//    reads, no ulid(), no terminal writes. The architectural-
//    invariants test D90.5 polices this for every fix-prompt-*.ts
//    file in this package. The renderer is deterministic from input
//    alone — same `FixPromptRenderInput` produces byte-identical
//    output every time, which is what the M E golden fixtures
//    depend on.
//
// 6. **No empty-findings refusal here.** If the CLI calls this
//    renderer with a ReportFile whose `report.results: []`, the
//    renderer emits a `## Findings (0)` section with no per-finding
//    blocks — defensively correct, but never observed in production
//    because the CLI refuses on empty findings BEFORE reaching the
//    renderer per contract D86. The renderer renders; the CLI
//    enforces business rules. Keeps the two concerns separate.

import {
  renderFindingsSection,
  renderFooter,
  renderNextSteps,
  renderPreamble,
  renderRepoContext,
  renderSourceAttribution,
  renderTaskSection,
} from "./fix-prompt-template.js";
import type { FixPromptRenderInput } from "./fix-prompt-types.js";

/**
 * Assemble the M E fix-prompt as a single text string from the
 * resolved ReportFile + product version per contract D81 / D85 /
 * D85.9.
 *
 * The result is the EXACT bytes that the CLI writes to both
 * `fix-prompt.txt` (via writeFileAtomic) and stdout (via
 * context.stdout.write). Byte-identity between the two sinks is the
 * D81 invariant; this function's single-string return is what makes
 * that invariant trivially provable at the CLI seam.
 *
 * Pure function. Deterministic. No I/O, no async, no clock, no
 * random. Calls only the template helpers from fix-prompt-template.ts
 * (which are themselves D29-pure).
 *
 * The task-context section is conditionally included only when
 * `renderTaskSection(file)` returns a non-null string (i.e., the
 * loaded ReportFile carries a non-empty `report.task` value). When
 * omitted, no placeholder section, no blank-line-only gap — the
 * separator structure is `Source attribution\n\nRepo context...`
 * with the task section invisibly absent. Per D85.3's locked
 * "omitted entirely (the result is `null` from renderTaskSection,
 * which file 3 skips in the section join)" behavior.
 */
export function renderFixPrompt(input: FixPromptRenderInput): string {
  const { file, productVersion } = input;

  // Section assembly per contract D85. Each push corresponds to one
  // top-level section. The Task section is the only conditional one
  // (omitted entirely when renderTaskSection returns null).
  const sections: string[] = [renderPreamble(), renderSourceAttribution(file)];

  const taskSection = renderTaskSection(file);
  if (taskSection !== null) {
    sections.push(taskSection);
  }

  sections.push(renderRepoContext(file));
  sections.push(renderFindingsSection(file));
  sections.push(renderNextSteps(file));
  sections.push(renderFooter(file, productVersion));

  // Sections separated by exactly one blank line (`\n\n` between
  // each pair). Final `\n` is the locked single trailing newline
  // per the contract's "Rendered output format" section (never
  // zero, never two).
  return `${sections.join("\n\n")}\n`;
}
