<p align="center">
  <img src="docs/assets/brand/viberevert-mark.png" alt="VibeRevert logo" width="120">
</p>

<h1 align="center">VibeRevert</h1>

<h3 align="center">AI broke your project? Undo the session, not your week.</h3>

<p align="center"><strong>Record · Check · Fix · Restore.</strong></p>

VibeRevert records an AI coding session, flags risky changes with deterministic rules, and can restore your project files to exactly how they were before it started, including work you hadn't committed.

**No AI judges the AI:** risk findings are reproducible, explainable, and based on rules you can inspect.

**Keep using your coding agent.** VibeRevert adds the safety layer around the session — with Claude Code, Cursor, and other coding-agent workflows.

<p align="center">
  <a href="https://www.npmjs.com/package/viberevert">
    <img src="https://img.shields.io/npm/v/viberevert/beta?label=npm%20beta&logo=npm&color=cb3837" alt="npm beta">
  </a>
  <a href="https://github.com/madeinplutofabio/vibe-revert/actions/workflows/ci.yml">
    <img src="https://github.com/madeinplutofabio/vibe-revert/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-brightgreen?logo=node.js&logoColor=white" alt="Node 22+">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0">
  </a>
</p>

## See it work

<p align="center">
  <img src="docs/assets/how-it-works.png" alt="How VibeRevert protects an AI coding session: capture the project's starting file state, record the AI session, flag risky changes across payments, database, and infrastructure, preview the rollback, and restore the project files to their pre-session state — external effects are out of scope" width="900">
</p>

The actual CLI, condensed from a real beta payment run — `check` flags it, and `rollback` previews what it will change before you `--apply`:

```text
$ viberevert check
risk: CRITICAL · payments
  app/api/checkout/route.ts          payments   (critical)
  app/api/webhooks/stripe/route.ts   payments   (critical)

$ viberevert rollback <session>        # preview — nothing changed yet
  package.json                       tracked_restored
  app/page.tsx                       tracked_restored
  app/api/checkout/route.ts          untracked_deleted
  app/api/webhooks/stripe/route.ts   untracked_deleted
  lib/stripe.ts                      untracked_deleted
  .gitignore  README.md  (your uncommitted work)   skipped_unchanged
```

## Proof, not promises

**3 real AI coding sessions. 3 exact project-file restorations.** Payments, database migrations, and deployment infrastructure — all with pre-existing uncommitted work preserved. [Read the beta report →](docs/beta-report.md)

## Quickstart

Works inside a Git repository and requires Node.js 22+. VibeRevert keeps its records on your machine and requires no VibeRevert account or hosted service.

```bash
npm install -g viberevert@beta
```

```bash
viberevert init                # one-time setup in your project
viberevert run <your-agent>    # records the session and saves your files' starting state
viberevert check               # see what changed and what looks risky
viberevert rollback <session>  # preview putting your files back; add --apply to restore
```

Restoring only part of a session works the same way, with a selector:

```bash
viberevert rollback <session> --only 'app/api/**'          # preview just that part
viberevert rollback <session> --only 'app/api/**' --apply  # restore just that part
```

## What it protects you from

You let an AI agent work across your project, and it touched more than you expected — maybe payment code, a database migration, a deploy file — while your own half-finished work was sitting right there uncommitted. VibeRevert captures your project's starting file state first, so a session you don't like doesn't cost you your afternoon.

## What VibeRevert does

Around each AI coding session, VibeRevert:

- **Checkpoints your project first** — working tree, staged changes, and untracked files, including work you haven't committed.
- **Records the session** and the project files that changed while it ran.
- **Flags risky edits** — changes touching auth, payments, databases, secrets, dependencies, or infrastructure ([risk taxonomy](docs/risk-taxonomy.md)).
- **Writes an agent-ready fix prompt** from those findings, to paste into your next iteration.
- **Restores your files** to the checkpoint when you need it.

It **warns** you; it does not silently block your work. An optional pre-commit hook can reject a commit above your configured risk threshold — opt-in, tunable, and bypassable like any local Git hook.

## Rules decide. Agents fix.

VibeRevert does not ask another language model whether your agent's changes look risky. Its checks are deterministic: the same inputs and configuration produce the same findings, with an inspectable reason for every flag.

When something needs attention, VibeRevert can turn those findings into an agent-ready fix prompt. The rules decide what to flag; you decide what happens next.

## Roll back all of it, or only the part that went wrong

`viberevert rollback` restores your **local project files** — tracked, staged, and untracked, including uncommitted work — to how they were when the session started. It previews by default; `--apply` writes the change, and every apply first saves an emergency checkpoint you can recover from.

Since 0.8.0 you can also restore **part** of a session. Say the agent's payments change was wrong but its test additions were fine: put back only the payments work and keep everything else.

```text
$ viberevert rollback <session> --only 'app/api/**'    # preview — nothing changed yet
[RESTORED]  app/api/checkout/route.ts
[RESTORED]  app/api/webhooks/stripe/route.ts
Eligibility: eligible

$ viberevert rollback <session> --only 'app/api/**' --apply
```

Four ways to choose, and any one of them switches rollback into selective mode:

| Selector | Picks |
|---|---|
| `--only <glob>` | changes matching a path pattern |
| `--except <glob>` | everything but those, subtracted last |
| `--risk <level>` | changes a finding rated at or above that level touches |
| `--finding <id>` | the changes one specific finding applies to |

Positive selectors combine by intersection, so `--only 'payments/**' --risk critical` means critical changes inside `payments/`, not payments plus every unrelated critical file. Path selectors follow a renamed file, so a file moved out of `payments/` still matches. **Nothing is restored unless everything you selected can be**: if any selected path drifted since the session ended, the whole operation refuses rather than half-applying, and `--force` does not override that. If a selective apply is interrupted, the next one fails closed and points you at the emergency checkpoint rather than layering a second partial restore on top.

Two current limitations worth knowing before you rely on it:

- **Sessions ended before 0.8.0 cannot be selectively rolled back.** They have no record of what they contributed and it cannot be reconstructed. Whole-session rollback still works on them, unchanged. See [MIGRATIONS.md](MIGRATIONS.md).
- **`--finding` needs the full finding id**, as printed by `viberevert check --since <session> --json`. Short prefixes are not accepted yet.

It does **not** reverse effects outside your project files. Deployments, database writes, third-party API calls, payments, and sent emails need their own recovery. Rollback is state-based rather than atomic, and it's a safety net around AI sessions, not a replacement for tests or review. Read [what rollback can and can't restore](docs/rollback-limitations.md) before you rely on it.

## One recovery layer across your coding agents

Keep using the coding tools you prefer. VibeRevert can wrap command-line agent sessions (`viberevert run <your-agent>`) and integrates with tools such as Claude Code and Cursor through its installers.

Built-in checkpoints live inside the agent's workflow. **VibeRevert stays with the project.**

It captures your project's starting state — including uncommitted work — then records the session, flags risky changes, previews the rollback, and keeps that recovery path outside the agent itself.

Use Claude Code today, Cursor tomorrow, or wrap another terminal agent: **the safety layer stays with your project.**

## Wire it into your tools

VibeRevert installs non-destructively and can be removed cleanly. It integrates with Claude Code and Cursor (MCP server and hooks); every install previews its changes and keeps a recovery journal. See [getting started](docs/getting-started.md).

An **experimental** terminal bridge (`--pty`) can intercept commands inside an interactive agent shell; it's best-effort and documented as such in the [PTY contract](docs/pty-contract.md).

## Platforms

Linux, macOS, and Windows, on Node.js 22+. CI runs the suite across all three on Node 22 and 24; see [compatibility](docs/compatibility.md) for exactly what each platform is tested to do.

## Learn more

- [Getting started](docs/getting-started.md) · [Commands](docs/commands.md) · [Configuration](docs/config.md)
- [What rollback can and can't restore](docs/rollback-limitations.md) · [Risk taxonomy](docs/risk-taxonomy.md)
- [Security policy](SECURITY.md) · [Threat model](THREAT_MODEL.md) · [Contributing](CONTRIBUTING.md)

## Support VibeRevert

VibeRevert is Apache-2.0 open source. Sponsoring funds continued cross-platform testing, security work, rollback and recovery testing, and helping pay for independent review. **Sponsorship does not influence risk findings or release decisions.** → **[Sponsor VibeRevert](https://github.com/sponsors/madeinplutofabio?metadata_campaign=viberevert)** · [what your support funds](docs/funding.md)

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) and the [license audit](LICENSE-AUDIT.md).
