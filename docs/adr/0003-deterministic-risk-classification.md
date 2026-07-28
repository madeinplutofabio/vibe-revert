# ADR 0003: Deterministic risk classification

- Status: Accepted — 2026-07-28 (records a decision shipped in Milestones A and C)
- Milestone: A (config schema) + C (risk classification); recorded in H8.4
- Related: [risk taxonomy](../risk-taxonomy.md), [configuration](../config.md), [positioning](../positioning.md); `packages/checks/`, `packages/core/src/config.ts`

## Context

VibeRevert's value as a guardrail depends on its risk decisions being trustworthy
in automation — a git hook or CI job gates on `check`'s exit code. For automation,
a decision should be inspectable, reproducible under the same relevant inputs and
implementation version, and free from model-prompt manipulation in the
classification path.

Model-based classification would introduce model variability and a
prompt-processing surface into the gate, making its outcomes harder to reproduce
and audit than the selected rule-based path, and would place model behavior in the
path that decides whether to warn or block.

## Decisions

### 1. Risk is decided by deterministic checks and policy thresholds

Classification is performed by rule-based detectors and a fixed set of policy
thresholds, not by a language model. Given the same relevant repository state,
configuration, and VibeRevert version, the checks produce the same findings. Each
finding is produced by inspectable detector code and recorded in a structured
report. The categories and thresholds are documented in
[risk taxonomy](../risk-taxonomy.md).

### 2. The deciding path contains no language model

No language model participates in classifying risk or in the gate that sets the
exit code. This is enforced at the configuration boundary: the schema accepts only
`llm.enabled: false`. A configuration that asks to enable a model classifier fails
schema validation rather than being silently accepted and ignored. See
`packages/core/src/config.ts`.

This decision applies specifically to risk classification, finding generation,
threshold evaluation, and exit gating. It does not define whether model-assisted
features may exist elsewhere in VibeRevert. Introducing model judgment into the
deciding path would require superseding this ADR.

### 3. Fixing, not deciding, is where an agent operates

VibeRevert supports remediation by producing a deterministic `prompt-fix` artifact
that a user or agent can act on; it does not apply the fix itself. Classification
and gating remain rule-based; editing remains outside VibeRevert. This is the
"Rules decide. Agents fix." boundary described in [positioning](../positioning.md).

## Alternatives considered

- **Model-based risk classification.** Sending the diff to a language model and
  asking whether it is risky would make the gate non-deterministic, harder to
  audit, and susceptible to instructions embedded in the content under review.
- **Model-assisted heuristics.** Blending model judgment into the rules would
  still introduce non-determinism and a prompt-processing surface into the
  deciding path.

## Consequences

- Decisions are inspectable, reproducible for the same relevant repository state
  and version, and policy-controlled, and the classification path has no model
  prompt for repository text to manipulate.
- The checks are fallible rules, ranging from structural checks to heuristics.
  Repository content can expose their limitations, but it cannot redirect a
  model-based judge because none is used.
- The set of risks VibeRevert can detect is bounded by the shipped rules; covering
  a new kind of risk means adding a rule, not changing a prompt.
- `llm.enabled` is reserved and validation-only. The only accepted value is
  `false`; configuration cannot enable model-based classification in this release.
