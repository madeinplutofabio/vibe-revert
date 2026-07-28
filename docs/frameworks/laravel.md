# Laravel

`viberevert init` recognizes Laravel projects and scaffolds a Laravel-tailored
`.viberevert.yml`. This guide covers how detection works, what the profile
changes relative to the generic one, and what VibeRevert does and does not
understand about Laravel. For the meaning of each config key, see
[Configuration](../config.md); for the risk categories, see
[Risk taxonomy](../risk-taxonomy.md).

## How VibeRevert detects Laravel

Detection is by file presence only: a repository is treated as Laravel when both
a `composer.json` and an `artisan` file exist at its root. If either is missing,
Laravel is not auto-detected. When more than one framework matches, `init` asks
you to choose (or, when it cannot prompt, exits and asks for `--profile`).

You can force the profile regardless of detection:

```bash
viberevert init --profile laravel
```

## What the Laravel profile writes

The Laravel profile starts from the same base as the generic profile and adds
framework-tailored defaults. Relative to generic — which writes only the
`secrets` and `dependencies` check toggles and ships its command guards commented
out — the Laravel profile:

- **Writes all eight check toggles and sets `checks.scope_expansion: false`.**
  Because an omitted check defaults to on, the practical difference is that
  scope-expansion is turned off; the other checks run under both profiles.
- **Writes `frameworks: [laravel]`**, explicitly recording Laravel as the
  configured framework instead of relying on runtime auto-detection. This gates
  framework-specific detection — for example, the migration check treats
  Laravel's `database/migrations/**` files as migrations only when Laravel is the
  configured framework.
- **Excludes common dependency, log, and cache paths from checkpoint capture and
  rollback scope** via `rollback.exclude`: `vendor/**`, `node_modules/**`,
  `storage/logs/**`, `storage/framework/cache/**`, `bootstrap/cache/**`.
- **Writes active command-guard entries**, which take effect only under
  `viberevert run` and `viberevert shell`:
  - refused outright (`commands.guard`): `php artisan migrate:fresh`, `rm -rf /`
  - confirmation required (`commands.require_confirm`): `php artisan migrate`,
    `php artisan db:wipe`

It also writes `project.type: web-app`, a `policies` list, and
`rollback.enabled` / `rollback.include_untracked`. Of these, `policies`,
`rollback.enabled`, and `rollback.include_untracked` are **reserved** — accepted
and validated, but with no runtime effect in this release (only `rollback.exclude`
is applied). `llm.enabled` is fixed to `false`. See [Configuration](../config.md)
for exactly which keys are active.

## What to review

- **The command guards.** They are matched as literal strings (exact match or a
  whitespace-bounded prefix), only under `run`/`shell`, and only against the
  top-level command you pass — not commands your tools spawn internally. Adjust
  the lists for your workflow.
- **The rollback excludes.** Confirm they match your layout; anything matching
  `rollback.exclude` is neither restored nor removed on rollback.
- **`scope_expansion`.** The profile disables it; re-enable it in
  `.viberevert.yml` if you want scope-expansion findings.

## What VibeRevert does not understand about Laravel

VibeRevert does not parse PHP, Blade, or Artisan, and does not instrument your
application at runtime. Concretely:

- Detection is file presence, not project analysis.
- VibeRevert examines repository changes with deterministic checks; it does not
  understand your database schema or Eloquent models.
- Command guards are literal string matches, not an understanding of what an
  Artisan command will do.
- Rollback is git-level (see [rollback limitations](../rollback-limitations.md));
  it restores repository files and does not reverse database migrations that were
  already executed.
