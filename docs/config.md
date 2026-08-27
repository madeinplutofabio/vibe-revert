# Configuration

VibeRevert reads `.viberevert.yml` from the repository root. `viberevert init`
scaffolds one; you can also edit it by hand.

## Validation

- The file is validated **strictly**: unknown or misspelled keys are rejected, not ignored.
- `version` is required and must be `1`.
- Risk levels are `low`, `medium`, `high`, or `critical`.
- Loading fails with a clear error if the file is missing, is not valid YAML, or violates the schema.

## Key reference

Keys fall into three groups: a schema/compatibility discriminator, runtime-consumed
controls, and metadata/reserved keys that are parsed and validated but do not
currently alter command behavior. `viberevert init` writes a starter config; a few
profile-written values differ from the default applied when a key is omitted (noted below).

### Schema and compatibility

| Key | Type | Default | Notes |
|---|---|---|---|
| `version` | literal `1` | required | Config format version. Only `1` is accepted; omitting it or using another value makes the file invalid. |

### Risk thresholds

| Key | Type | Default | Notes |
|---|---|---|---|
| `risk.block_on` | `low` / `medium` / `high` / `critical` | `critical` | `check` exits non-zero when any finding is at or above this level. |
| `risk.warn_on` | `low` / `medium` / `high` / `critical` | `medium` | Default display threshold; does not affect the exit code. |

### Frameworks

| Key | Type | Default | Notes |
|---|---|---|---|
| `frameworks` | list of strings | auto-detected | When omitted or empty, VibeRevert detects frameworks from repository file signatures. |

### Checks

Each key toggles one risk detector. When a key is omitted the detector runs (default `true`).

| Key | Type | Default | Notes |
|---|---|---|---|
| `checks.secrets` | boolean | `true` | Secret-material detection. |
| `checks.dependencies` | boolean | `true` | Dependency-change detection. |
| `checks.migrations` | boolean | `true` | Database-migration detection. |
| `checks.auth` | boolean | `true` | Auth-related change detection. |
| `checks.payments` | boolean | `true` | Payment-related change detection. |
| `checks.infra` | boolean | `true` | Infrastructure/config change detection. |
| `checks.tests` | boolean | `true` | Test-coverage-gap detection. |
| `checks.scope_expansion` | boolean | `true` | Scope-expansion detection. Note: the built-in framework profiles write `false` here even though the omission default is `true`. |

### Command guards

Guards apply to the command you pass to `viberevert run` and to each command you
enter in `viberevert shell`; commands those processes then spawn internally are
not matched. Entries are **literal strings** (not globs or regexes), compared
case-sensitively; an entry matches by exact equality or as a whitespace-bounded
prefix of the invocation (`rm -rf /` matches `rm -rf / --no-preserve-root` but not
`rm -rf /x`). `guard` is checked before `require_confirm`.

| Key | Type | Default | Notes |
|---|---|---|---|
| `commands.guard` | list of strings | `[]` | Literal command strings refused before execution. |
| `commands.require_confirm` | list of strings | `[]` | Literal command strings that require interactive confirmation before execution. |

### Rollback

| Key | Type | Default | Notes |
|---|---|---|---|
| `rollback.exclude` | list of strings | `[]` (nothing excluded) | Glob patterns excluded from checkpoint capture and rollback scope. |
| `rollback.enabled` | boolean | — | Reserved: parsed and validated but does not currently alter command behavior. |
| `rollback.include_untracked` | boolean | — | Reserved: parsed and validated but does not currently alter command behavior. |

### Project verification

Verification commands are a separate policy domain from `commands.guard` and
`commands.require_confirm`. Those govern what an *agent* invocation is allowed
to execute; `verify.commands` describes project checks reserved for recovery
verification.

Each entry uses an argv-structured command object rather than a single shell
command string: `command` identifies the executable and `args` contains its
arguments. This keeps tokenization and shell interpretation out of the config:

```yaml
verify:
  commands:
    - command: pnpm
      args:
        - typecheck
    - command: pnpm
      args:
        - test
```

`command` must be non-blank. `args` is required and may be empty (`args: []`),
and an individual argument may be an empty string. Entries are preserved in
the order written, and duplicates are permitted.

| Key | Type | Default | Notes |
|---|---|---|---|
| `verify.commands` | list of command objects | `[]` (no verification commands) | Ordered verification commands. Each entry is an object with a non-blank `command` and a required `args` list of strings. Reserved in this beta: parsed and validated, but not executed yet. |

### Project metadata

Parsed and validated, but not consumed at runtime in this beta.

| Key | Type | Default | Notes |
|---|---|---|---|
| `project.name` | string | — | Descriptive project name. Required if a `project:` block is present. |
| `project.type` | string | — | Descriptive, free-form string (not an enum). |

### Reserved

These keys are parsed and validated but do not currently alter VibeRevert's command behavior.

| Key | Type | Default | Notes |
|---|---|---|---|
| `profile` | string | — | Records the profile name chosen at `init`; free-form (not an enum). |
| `policies` | list of strings | — | Reserved schema field. Parsed and validated, but has no runtime effect in this beta. |
| `llm.enabled` | literal `false` | — | Reserved. The only accepted value is `false`; `true` is invalid. Omitting the field is preferable unless a generated profile includes it. |
