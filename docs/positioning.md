# Positioning

VibeRevert draws a deliberate line between deciding what is risky and doing the
fixing. This page explains that boundary and the principles behind it; for the
mechanics, follow the links to the reference docs rather than re-reading them
here.

## Rules decide. Agents fix.

"Rules decide. Agents fix." is the design principle behind VibeRevert — a
statement about where *this* tool draws its boundary, not a claim about how all
agent systems work. VibeRevert decides what is risky with deterministic checks
and policy thresholds; it does not use a language model to judge risk. The actual
repair work stays with your agent, informed by a deterministic fix prompt.

## What VibeRevert decides

VibeRevert's [checks](risk-taxonomy.md) flag categories of change — secrets,
database migrations, auth, payments, and so on — and your
[configuration](config.md) thresholds (`risk.block_on`, `risk.warn_on`) decide
what is shown and what causes a non-zero exit.

Those decisions are **inspectable** (the config and the report say exactly what
was evaluated and why), **reproducible** (given the same relevant repository
state, configuration, and VibeRevert version, the deterministic checks produce
the same findings), and **policy-controlled** (you tune the toggles and
thresholds). They are not claimed to be always correct — the checks are fallible
rules, ranging from structural checks to heuristics — but their behavior is
transparent and under your control. Deciding risk is never delegated to a
language model; VibeRevert only accepts `llm.enabled: false`.

## What agents still do

VibeRevert does not fix your code. When a check finds something, `prompt-fix`
turns the persisted report into a deterministic remediation prompt for an agent
(see the [prompt-fix contract](prompt-fix-contract.md)); it produces that prompt,
it does not apply changes. Your agent — or you — makes the edits, and you re-run
`check` to confirm.

The loop is: an agent changes the code, VibeRevert checks the diff, and if the
result is risky, `prompt-fix` hands the agent structured context to address it.

## Why the boundary matters

Because the deciding is deterministic, a flagged change is **auditable** — you
can see precisely why it was flagged — and **stable** — the verdict does not vary
because of model sampling or model judgment. That is what makes the guardrail
dependable in automation such as git hooks and CI. The risk-classification path
has no language-model prompt for repository text to manipulate. Repository
content can still expose limitations in the deterministic checks, but it cannot
redirect a model-based judge because none is used. The fix prompt VibeRevert
hands to your agent is separately rendered so that repository-controlled fields
cannot become VibeRevert prompt-section headers; the receiving agent still
applies its own security and instruction-handling behavior (see the
[prompt-fix contract](prompt-fix-contract.md)).

## What VibeRevert is not

- **Not an autofixer.** It does not edit your code; `prompt-fix` emits a prompt,
  not changes.
- **Not an AI risk classifier.** Risk is decided by deterministic rules, not
  model judgment.
- **Not a universal undo.** [Rollback](rollback-limitations.md) restores captured
  repository state (Case 1); it cannot reverse external effects such as
  deployments, database changes, or published packages (Case 2). It is a recovery
  path for your files, not the answer to every bad outcome.
- **Not a sandbox.** `run` and `shell` guard the top-level command you pass, not
  everything a child process does, and PTY interception is experimental and
  best-effort (see [Architecture](architecture.md)).

## Product principles

- **Deterministic where it decides.** Risk classification and gating are rules,
  not model calls.
- **Inspectable, reproducible, policy-controlled.** You can read, re-run, and
  tune every decision.
- **Local-first.** VibeRevert's control plane and state run on your machine.
- **Honest about scope.** What it restores and what it cannot, and which features
  are experimental, are stated plainly.
- **Agents do the fixing.** VibeRevert provides the guardrail and the context; the
  repair stays with the agent.
