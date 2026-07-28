# Risk taxonomy

VibeRevert's checks classify each change with a **risk level**, a **category**,
and a **confidence**. This page defines that vocabulary and how the levels drive
`viberevert check`'s output and exit code. These values appear in the check
report; see [Session format](session-format.md) for the report's storage and
versioning.

## Risk levels

Every finding has one risk level. The levels are ordered
`low < medium < high < critical`:

| Level | What it means |
|---|---|
| `low` | Lowest level in the ordering; below the default display threshold. |
| `medium` | Default value of `risk.warn_on`. |
| `high` | Above the default display threshold and below the default block threshold. |
| `critical` | Highest level in the ordering; default value of `risk.block_on`. |

"Severity" refers to this ordering of levels; it is not a separate value. A
"threshold" is a risk level used as a cutoff (below), not a distinct type.

## Thresholds and exit behavior

Two configured thresholds and one flag decide what `check` shows and whether it
fails:

- **`risk.block_on`** (default `critical`) — the **exit gate**. `check` exits `2`
  if any finding is at or above this level, and `0` otherwise.
- **`risk.warn_on`** (default `medium`) — the **default display threshold**: when
  you don't pass `--threshold` (and aren't using `--json`), findings below this
  level are hidden from the rendered output.
- **`--threshold <level>`** — a per-run **display filter** only. It overrides the
  default display threshold and never changes the exit code.

The persisted report always contains the **full, unfiltered** set of findings;
only the rendered view is filtered. Configure these keys in
[Configuration](config.md).

## Check categories

Every finding also has a `category` identifying the kind of risk. The categories
controlled by the public `checks.*` toggles are listed in the mapping below; a
single toggle may enable more than one category.

## Configuration-to-category mapping

Each `checks.*` toggle in `.viberevert.yml` enables one or more emitted
categories. This mapping is the code authority for which emitted category strings
each `checks.*` toggle controls:

| Config key | Emitted categories |
|---|---|
| `checks.secrets` | `secrets` |
| `checks.dependencies` | `dependencies` |
| `checks.migrations` | `database` |
| `checks.auth` | `auth` |
| `checks.payments` | `payments` |
| `checks.infra` | `infra`, `deployment` |
| `checks.tests` | `test-gap` |
| `checks.scope_expansion` | `scope-expansion` |

The toggle key and the emitted category are not always the same word:
`checks.migrations` controls `database` findings, `checks.tests` controls
`test-gap`, and `checks.infra` controls both `infra` and `deployment`.

## Confidence

Every finding carries a `confidence` — how sure the check is that the finding is
real. Confidence is independent of risk level: a finding can be `critical` risk at
`medium` confidence.

| Confidence | Meaning |
|---|---|
| `low` | Lower confidence in the finding. |
| `medium` | Moderate confidence in the finding. |
| `high` | Higher confidence in the finding. |

## Reserved categories

Two groups of category names are **not** produced by any configurable check:

- `summary` — produced only by the engine when it condenses many findings into a
  single summary entry. It is not a check and is not user-toggleable.
- `permissions`, `admin`, `user-data`, `network`, `unknown-large-change` —
  reserved names not emitted by any check in this release.

## Stability

- **Risk levels** (`low`/`medium`/`high`/`critical`) and **confidence**
  (`low`/`medium`/`high`) are schema-defined public values governed by the
  report-format compatibility policy.
- The **`checks.*` config keys** are the stable public control surface
  (see [Configuration](config.md)).
- The **emitted category strings** appear in the report as descriptive values,
  governed by the configuration-to-category mapping above rather than frozen by
  the report schema. Treat that mapping as the authority for which categories a
  toggle controls.
- The report format's own versioning and stability are covered in
  [Session format](session-format.md).
