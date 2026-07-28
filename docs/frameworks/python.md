# Python

`viberevert init` can detect a Python-oriented repository and scaffold a
Python-tailored `.viberevert.yml`. This guide covers how detection works, what
the profile changes relative to the generic one, and what VibeRevert does and
does not understand about Python. For the meaning of each config key, see
[Configuration](../config.md); for the risk categories, see
[Risk taxonomy](../risk-taxonomy.md).

## How VibeRevert detects Python

Detection is by file presence only: a repository is treated as Python when a
`pyproject.toml`, `manage.py`, or `requirements.txt` file exists at its root. If
none is present, Python is not auto-detected. When more than one framework
matches, `init` asks you to choose (or, when it cannot prompt, exits and asks for
`--profile`).

You can force the profile regardless of detection:

```bash
viberevert init --profile python
```

## What the Python profile writes

Relative to the generic profile — which writes only the `secrets` and
`dependencies` check toggles and ships its command guards commented out — the
Python profile:

- **Writes all eight check toggles and sets `checks.scope_expansion: false`.**
  Because an omitted check defaults to on, the practical difference is that
  scope-expansion is turned off; the other checks run under both profiles.
- **Writes `frameworks: [python]`**, so runtime framework resolution uses Python
  instead of repository auto-detection.
- **Excludes common virtualenv and tool-cache paths from checkpoint capture and
  rollback scope** via `rollback.exclude`: `__pycache__/**`, `.venv/**`,
  `venv/**`, `.pytest_cache/**`, `.mypy_cache/**`, `.ruff_cache/**`.
- **Writes active command-guard entries**, which take effect only under
  `viberevert run` and `viberevert shell`:
  - refused outright (`commands.guard`): `rm -rf /`
  - confirmation required (`commands.require_confirm`): `alembic downgrade`,
    `django-admin migrate`, `manage.py migrate`

It also writes a `policies` list and `rollback.enabled` /
`rollback.include_untracked`. Of these, `policies`, `rollback.enabled`, and
`rollback.include_untracked` are **reserved** — accepted and validated, but with
no runtime effect in this release (only `rollback.exclude` is applied).
`llm.enabled` is fixed to `false`. See [Configuration](../config.md) for exactly
which keys are active.

## What to review

- **The command guards.** They are matched as literal strings (exact match or a
  whitespace-bounded prefix), only under `run`/`shell`, and only against the
  top-level command you pass — not commands your tools spawn internally. The
  generated entries cover `alembic downgrade`, `django-admin migrate`, and
  `manage.py migrate`; adjust them for your migration tooling and workflow.
- **The rollback excludes.** Confirm they match your layout; anything matching
  `rollback.exclude` is neither restored nor removed on rollback.
- **`scope_expansion`.** The profile disables it; re-enable it in
  `.viberevert.yml` if you want scope-expansion findings.

## What VibeRevert does not understand about Python

VibeRevert does not parse Python, and does not instrument your application at
runtime. Concretely:

- Detection is file presence, not project analysis, and does not distinguish
  which Python framework (if any) you use.
- VibeRevert examines repository changes with deterministic checks; it does not
  semantically understand your models, migration history, database state, or ORM
  behavior.
- Command guards are literal string matches, not an understanding of what a
  migration command will do.
- Rollback is git-level (see [rollback limitations](../rollback-limitations.md));
  it restores repository files and does not reverse database migrations that were
  already executed.
