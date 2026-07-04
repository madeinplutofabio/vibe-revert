# Installer contract

This document specifies the surface that adapters, the installer engine, the `viberevert install` / `viberevert uninstall` CLI commands, and future integrations must agree on. It is the source of truth for behavior a consumer can rely on; internal implementation details are referenced by file path, not repeated here.

See also:
- [`docs/integrations.md`](integrations.md) — per-integration ship status.
- [`docs/hook-contract.md`](hook-contract.md) — the M F hook lifecycle for `viberevert hook install` / `viberevert hook uninstall`.

## Status

**Shipped** as of M G1b (v0.7.1-beta.0):

- `cursor` — writes into `<repo>/.cursor/mcp.json`.
- `direct-hook` — writes into `<repo>/.git/hooks/pre-commit`.
- `husky` — writes into `<repo>/.husky/pre-commit`.
- `lefthook` — writes into `<repo>/lefthook.yml` (or `.yaml` / `.lefthook.yml` / `.lefthook.yaml`).
- `claude` — writes into `<repo>/.mcp.json`.
- `github-action` — writes into `<repo>/.github/workflows/viberevert.yml`.

**Deferred**:

- `codex` — schema and MCP surface still moving; deferred to M G1b-followup-3.
- `--global` and any home-directory installer surface — deferred to M G1b-followup-10 pending a runtime-identity mechanism.
- JSON output mode for `install` / `uninstall` — deferred; use the MCP tool surface if structured output is needed.
- `viberevert uninstall --dry-run` — deferred; use the MCP tool surface for record inspection.

## Terminology

The contract uses these terms consistently. Callers and future adapters should adopt the same vocabulary.

| Term | Meaning |
|---|---|
| **adapter** | A read-only module that describes desired integration state via `detect(ctx)` + `plan(ctx)`. Adapters do not mutate the filesystem and do not read the integrations record. |
| **installer engine** | The code in `@viberevert/installers` that consumes an adapter's plan, computes an outcome against on-disk state and the record, and (for `apply` / `uninstall`) performs mutations under a lock with a recovery journal. |
| **recordKey** | Durable identifier for an integration in `.viberevert/integrations.json`. Enumerated: `cursor`, `direct-hook`, `husky`, `lefthook`, `claude`, `github-action`. Stable across install / uninstall / migration. |
| **adapterName** | Display-only human string emitted in CLI output (e.g. `Cursor`, `Direct hook`). Not used for equality comparisons, storage lookups, or dispatch. |
| **record** | A single entry in `.viberevert/integrations.json.records[<recordKey>]` describing what the installer engine wrote on the user's behalf. |
| **receipt** | Return value from `apply` / `uninstall` describing what actually happened (files written, backups created, human summary). |
| **managed region** | The specific bytes inside a user-owned file that VibeRevert wrote and can recover: a sentinel-wrapped block, a JSON key value, or a whole-file write. |
| **pending journal** | A file under `.viberevert/integration-journal/<uuid>.json` recording an in-progress or crashed transaction. Presence causes the engine to refuse further mutation; manual inspection/recovery is required before the journal is removed. |
| **lock** | The directory `.viberevert/integrations.lock/`. Acquired via atomic `mkdir` before any mutation; released after commit. |
| **preview** | Read-only planning path: computes what `apply` would do without writing. |
| **apply** | Mutating install path. Acquires the lock, refuses on pending journal, writes backups + target files, commits the record. |
| **uninstall** | Mutating removal path. Acquires the lock, refuses on pending journal, restores backups or removes managed regions, removes the record. |

## Adapter contract

Adapters live in `packages/adapters/src/adapters/*.ts`. Each adapter exports a single `const` conforming to the `Adapter` interface in [`packages/adapters/src/types.ts`](../packages/adapters/src/types.ts). The interface has exactly two methods.

```ts
interface Adapter {
  readonly name: string;
  detect(ctx: AdapterContext): Promise<DetectResult>;
  plan(ctx: AdapterContext): Promise<AdapterPlan>;
}
```

`detect` returns whether the adapter applies to the current repo + intent. `plan` returns the desired integration state.

**Read-only discipline.** Adapters read filesystem state during `detect` / `plan` where needed, but do not mutate the filesystem, do not read `.viberevert/integrations.json`, and do not read the recovery journal. Deciding whether a record already exists, whether the current bytes match the recorded SHA, or whether the transaction is a noop is the installer engine's job. This discipline is enforced by architectural invariant tests in [`packages/cli/test/architectural-invariants.test.ts`](../packages/cli/test/architectural-invariants.test.ts) (the D101.M adapter-read-only invariants).

There is no `render()` method. Adapters return declarative ops containing the desired content or value. The installer engine owns filesystem classification, managed-region hashing, backups, writes, records, diffs, and uninstall behavior.

### AdapterPlan is a discriminated union

```ts
type AdapterPlan = ApplicablePlan | RefusedPlan;

interface ApplicablePlan {
  readonly status: "applicable";
  readonly adapterName: string;
  readonly humanSummary: string;
  readonly ops: ReadonlyArray<FileEditOp>;
  readonly recordKey: RecordKey;
  readonly meta: JsonObject;
}

interface RefusedPlan {
  readonly status: "refused";
  readonly adapterName: string;
  readonly reasonCode: string;
  readonly message: string;
  readonly manualSnippet?: string;
}
```

There is no `NoopPlan` at the adapter layer. Noop detection requires reading the record, which adapters cannot do; noops belong to the installer engine's `InstallOutcome`.

`recordKey` on `ApplicablePlan` is the durable storage key. `adapterName` is display text. See the Terminology table above.

`meta` is JSON-safe and used for cross-step coordination. The one meta key currently in use is Husky's `migrateFromDirectHook: "true"`, which the CLI observes to orchestrate direct-hook cleanup after a Husky install.

### DetectResult

```ts
type DetectResult = DetectedResult | NotDetectedResult;

interface DetectedResult {
  readonly detected: true;
  readonly signal: JsonObject | null;
}

interface NotDetectedResult {
  readonly detected: false;
  readonly reason: string;
  readonly signal: JsonObject | null;
}
```

`reason` exists only on the not-detected variant. The CLI formats it as `[skipped: <adapterName>: <reason>]`.

## Adapter context

Every `detect` and `plan` call receives an `AdapterContext`:

```ts
interface AdapterContext {
  readonly repoRoot: string;
  readonly now: Date;
  readonly cliVersion: string;
  readonly intent: "explicit" | "all";
  readonly options: {
    readonly forceReinstall: boolean;
    readonly migrateFromHookInstall: boolean;
    readonly forceUninstall: boolean;
  };
}
```

**intent** semantics:

- `"explicit"` — the user named this adapter on the command line (e.g. `viberevert install --cursor`). `detect` reports positive so the plan runs.
- `"all"` — the adapter was selected via `--all`. `detect` reports positive only when the repo shows real on-disk evidence for this integration.

The GitHub Action adapter is **explicit-only**. Its `detect` always returns positive, but `--all` iterates only `cursor` / `direct-hook` / `husky` / `lefthook` / `claude`. Creating a CI workflow is a user intent, not a discovered state.

**options** flow into adapter behavior but are enforced narrowly:

- `forceReinstall` — set by `viberevert install --force-reinstall`. Only overrides installer engine drift refusals and the GitHub Action adapter's `non-vr-workflow-present` refusal. Does not bypass locks, journals, symlink refusals, parent-escape refusals, target-shape refusals, or size limits.
- `migrateFromHookInstall` — set by `viberevert install --husky --migrate-from-hook-install`. Only overrides Husky's `vr-direct-hook-present` refusal. Does not act as a general force.
- `forceUninstall` — set by `viberevert uninstall --force`. Only overrides `IntegrationsContentDriftError` at the uninstall path. Same narrow scope: does not bypass locks, journals, or structural refusals.

The install and uninstall commands use different flag names on purpose. `--force-reinstall` and `--force` are not aliases and are not swappable.

## Installer engine outcomes

The engine in `@viberevert/installers` exposes three entry points: `preview`, `apply`, `uninstall`. Each returns a discriminated outcome. Adapters and CLI dispatch on these.

**Layer separation:** the CLI's per-line output vocabulary (`[skipped]` / `[applied]` / `[noop]` / `[refused]` / `[applicable]`) is derived from these engine outcomes but is a separate contract. Consumers of the engine should switch on `outcome.status`, not on formatted strings.

### PreviewOutcome

```ts
type PreviewOutcome =
  | { status: "applicable"; recordKey: RecordKey; adapterName: string; diff: PreviewDiff; humanSummary: string }
  | { status: "noop"; recordKey: RecordKey; adapterName: string; reason: string }
  | { status: "refused"; adapterName: string; reasonCode: string; message: string; manualSnippet?: string };
```

`preview` is **read-only**. It plans and classifies but does not mutate. It reports what `apply` would do under the current filesystem state. It does not guarantee that a subsequent `apply` will produce the same outcome — filesystem or record drift between `preview` and `apply` is possible.

The `applicable` variant carries a `PreviewDiff` with per-file unified diffs. Adoption transactions (target state already matches desired state) return `applicable` with an empty `diff.perFile` and a locked adoption `humanSummary`.

### InstallOutcome

```ts
type InstallOutcome =
  | { status: "applied"; receipt: InstallReceipt }
  | { status: "noop"; recordKey: RecordKey; adapterName: string; reason: string }
  | { status: "refused"; recordKey?: RecordKey; adapterName: string; reasonCode: string; message: string; manualSnippet?: string };

interface InstallReceipt {
  readonly recordKey: RecordKey;
  readonly adapterName: string;
  readonly opsApplied: number;
  readonly filesWritten: ReadonlyArray<string>;
  readonly backupsCreated: ReadonlyArray<string>;
  readonly integrationsJsonPath: string;
  readonly humanSummary: string;
}
```

The refusal variant's `recordKey` is optional: adapter-plan refusals omit it (there is no plan to key against); engine-classifier refusals on an applicable plan (drift, symlink, target size, etc.) include it.

`opsApplied` counts real file mutations. An **adoption transaction** — where the installer engine finds the current on-disk state already matches the adapter's plan and writes only the record — returns `applied` with `opsApplied: 0`. The receipt's `humanSummary` distinguishes adoption from a fresh apply.

### UninstallOutcome

```ts
type UninstallOutcome =
  | { status: "uninstalled"; receipt: UninstallReceipt }
  | { status: "not-installed"; recordKey: RecordKey; reason: string }
  | { status: "refused"; recordKey: RecordKey; adapterName?: string; reasonCode: string; message: string };

interface UninstallReceipt {
  readonly recordKey: RecordKey;
  readonly adapterName: string;
  readonly filesRemoved: ReadonlyArray<string>;
  readonly filesRestored: ReadonlyArray<string>;
  readonly humanSummary: string;
}
```

Uninstall is recordKey-driven. `not-installed` means no record exists for the requested recordKey. The CLI formats it as `[noop: <adapterName>: <reason>]` because from the caller's perspective nothing needed to be done — a missing record is a no-op, not a refusal.

## FileEditOp

Each adapter's `ApplicablePlan.ops` is a small array of `FileEditOp` values. The union has exactly five variants — one per supported mutation kind. There is no sidecar key written into user configuration files; the managed-region SHA lives only in the installer's record.

```ts
type FileEditOp =
  | { kind: "write-new";              target: PathSpec; content: string; mode?: number }
  | { kind: "sentinel-block-insert";  target: PathSpec; blockId: string; content: string; anchor: SentinelAnchor }
  | { kind: "sentinel-block-replace"; target: PathSpec; blockId: string; content: string }
  | { kind: "backup-and-write";       target: PathSpec; content: string; mode?: number }
  | { kind: "json-key-merge";         target: PathSpec; keyPath: ReadonlyArray<string>; value: JsonValue };
```

- **write-new** — create the target file fresh. If the target exists, the engine's classifier decides between adoption (bytes match), safe-update (previously VibeRevert-managed), or refusal (drift or user-owned bytes we did not write).
- **sentinel-block-insert** — inject a sentinel-wrapped block into an existing (or absent) text file, anchored per `SentinelAnchor` (`append` or `after-marker`).
- **sentinel-block-replace** — replace the interior of an existing sentinel block matched by `blockId`. Emitted when re-installing over prior VibeRevert-managed content.
- **backup-and-write** — back the current file up under `.viberevert/integration-backups/...` then overwrite. Preserves the original bytes for uninstall's restore path.
- **json-key-merge** — structured-merge a value at `keyPath` into an existing JSON file. The value is canonicalized (see below) for SHA computation.

`mode` on `write-new` / `backup-and-write` requests a POSIX file mode where supported; Windows treats it as a no-op.

## Sentinel-block format

Sentinel blocks let VibeRevert modify user-owned text files without owning the whole file. The format is a marker pair:

```
# viberevert:begin:<blockId>
<content the installer wrote>
# viberevert:end:<blockId>
```

The marker prefix is fixed (`# viberevert:begin:` / `# viberevert:end:`). The `<blockId>` is adapter-namespaced (for example the Husky and Lefthook pre-commit block IDs) so a stray marker-shaped line in user content cannot false-positive.

Helpers live in [`packages/adapters/src/sentinel.ts`](../packages/adapters/src/sentinel.ts): `renderSentinelBlock`, `findSentinelBlock`, `replaceOrAppendSentinelBlock`, `removeSentinelBlock`. Markers sit on their own lines; LF line endings are the engine's default (see line-endings section in the second half of this contract).

## JSON-key-merge

For adapter targets that are JSON documents (Cursor's `.cursor/mcp.json`, Claude Code's `.mcp.json`), the adapter emits a `json-key-merge` op with a `keyPath` and a `value`. The engine reads the existing file, sets the value at `keyPath`, and writes back.

Two rules:

1. **No sidecar key.** The engine does not insert a `_viberevert_managed` marker into the user's JSON. The managed-region SHA lives only in `.viberevert/integrations.json`.
2. **Value canonicalization.** The `value` is canonicalized before hashing (see the next section). Unrelated keys in the user's file are preserved semantically, but the file may be reserialized.

Contract examples: Cursor's applicable plan carries `keyPath: ["mcpServers", "viberevert"]` and `value: { type: "stdio", command: "viberevert", args: ["mcp", "serve"] }`. The engine merges only that path; the user's other `mcpServers.*` entries are preserved semantically.

## Canonical JSON

The canonical form is used to compute `managedValueSha256`. It is defined by these rules:

- UTF-8 encoding, no BOM.
- Object keys recursively sorted lexicographically (byte order, not locale).
- No insignificant whitespace — compact output (`JSON.stringify(value, null, 0)`-equivalent shape with sorted keys).
- Arrays preserved in source order (never sorted).
- Numbers serialized via JavaScript's default number-to-string. Non-finite numbers (`NaN`, `Infinity`, `-Infinity`) are rejected by the schema before canonicalization.
- Strings use standard JSON escaping.

The canonicalizer is used for managed-value hashing. The engine writes the merged JSON file using its JSON serializer; consumers must rely on the recorded `managedValueSha256`, not on incidental whitespace in the surrounding file.

Implementation: [`packages/installers/src/canonical-json.ts`](../packages/installers/src/canonical-json.ts).

Contract examples: the same `mcpServers.viberevert` value written with different source-code key order hashes identically. The managed value's hash is computed from canonical JSON, independent of surrounding file formatting.

## PathSpec

Every op targets a `PathSpec`:

```ts
interface PathSpec {
  readonly scope: "repo";
  readonly pathTemplate: string;
  readonly pathRelative: string;
}
```

- **scope** is `"repo"` in v1. `"home"` and `"absolute"` are deferred to any future milestone that adds `--global` (M G1b-followup-10).
- **pathTemplate** carries an unresolved template like `{repo}/.cursor/mcp.json`. Persisted in the record so future tooling can reason about the originally intended target.
- **pathRelative** is the same path relative to the scope root, in POSIX form. On Windows, `pathRelative` uses forward slashes; the engine's `resolvePath` splits on `/` and rejoins with the platform separator at runtime.

Absolute filesystem paths and paths escaping `repoRoot` are refused at the schema layer. Backslashes in `pathRelative` are refused by a schema `.refine`.

## Per-kind managed-region SHAs

Each record's `ops[]` entry carries exactly one non-null SHA field. The kind determines which:

| op kind | SHA field |
|---|---|
| `sentinel-block-insert` | `managedBlockSha256` |
| `sentinel-block-replace` | `managedBlockSha256` |
| `json-key-merge` | `managedValueSha256` |
| `write-new` | `fullFileSha256AfterWrite` |
| `backup-and-write` | `fullFileSha256AfterWrite` |

The schema enforces this via `superRefine`:

- Exactly one of `managedBlockSha256` / `managedValueSha256` / `fullFileSha256AfterWrite` is non-null.
- Sentinel ops also require a non-null `blockId`.
- `json-key-merge` also requires a non-null `jsonKeyPath`.
- `write-new` / `backup-and-write` require `fullFileSha256AfterWrite`.

**Uninstall discipline.** The uninstall path re-computes the SHA at the recorded granularity:

- **sentinel-block** — locate the block by `blockId`; if `sha256(interior)` matches the recorded `managedBlockSha256`, remove the block. Otherwise refuse with drift.
- **json-key-merge** — locate the value at `jsonKeyPath`; if `sha256(canonicalJson(value))` matches the recorded `managedValueSha256`, delete the key. Otherwise refuse with drift.
- **write-new** — if `sha256(currentFile)` matches the recorded `fullFileSha256AfterWrite`, delete the file. Otherwise refuse with drift.
- **backup-and-write** — if `sha256(currentFile)` matches the recorded `fullFileSha256AfterWrite`, restore from backup. Otherwise refuse with drift.

`viberevert uninstall --force` (which sets `ctx.options.forceUninstall`) overrides the drift refusal only. It does not skip the recovery-journal check, ignore lock contention, or bypass structural safety refusals.

## Backup layout

When the engine needs to preserve pre-mutation bytes for rollback or uninstall, backups live under `.viberevert/integration-backups/` and are addressed by record and op metadata. The current on-disk layout is:

    .viberevert/integration-backups/<recordKey>/<backupGroupId>/<sha256-12>--<basename>

- `<recordKey>` groups backups by the integration that produced them.
- `<backupGroupId>` groups backups produced by a single transaction.
- `<sha256-12>` is a short SHA-256 prefix of the original `pathRelative` — this prevents two different original paths with overlapping basenames from colliding.
- `<basename>` is the trailing path segment of the original file, included for human readability.

Implementation: [`packages/installers/src/path-encode.ts`](../packages/installers/src/path-encode.ts).

The M F direct-hook path (`viberevert hook install --force`) writes its backup to `.git/hooks/pre-commit.viberevert-backup-<UTC>` instead — this predates the installer engine and is preserved for backward compatibility. It is not part of the installer contract.

## Line endings

Generated VibeRevert-managed content uses LF line endings.

## Install/uninstall lock

Before any mutation, the installer engine acquires a per-repo lock: a directory at `.viberevert/integrations.lock/`. Acquisition is a non-recursive atomic `mkdir` — a pre-existing directory causes `IntegrationsLockError`.

The lock is the directory itself. A `pid.json` file may be written inside the lock directory for diagnostic purposes (which command took the lock, which pid, when it started), but callers should not treat `pid.json` as part of the safety contract; the directory is the primitive.

Release is `rmdir` (after removing any diagnostic `pid.json`).

Stale-lock recovery is manual: if the lock directory persists after an installer process died, the operator inspects it and clears it explicitly. There is no `--force-lock` flag in this milestone. See M G1b-followup-14 for a possible future recovery flag.

Implementation: [`packages/installers/src/lock.ts`](../packages/installers/src/lock.ts).

## Recovery journal

Before mutating any user file, the installer engine writes a journal entry describing the in-progress transaction to `.viberevert/integration-journal/<uuid>.json`. The entry records the txn id, `recordKey`, adapter, planned ops, phase, and (as backups are made) the backup paths.

On every subsequent install / uninstall, after acquiring the lock, the engine scans the journal directory. If any entry is present, the engine refuses with `PendingIntegrationRecoveryError`. Manual inspection and recovery are required before the journal entry is removed.

The journal is not an auto-recovery mechanism. Recovery from a mid-transaction crash is left to the operator; the engine's guarantee is only that a pending journal blocks further mutation, so the repository is not clobbered by a partial replay.

Implementation: [`packages/installers/src/journal.ts`](../packages/installers/src/journal.ts).

## recordKey enum

`recordKey` values are enumerated. As of M G1b, the valid set is:

- `cursor`
- `direct-hook`
- `husky`
- `lefthook`
- `claude`
- `github-action`

The enum is defined in the store schema in [`packages/installers/src/integrations-schema.ts`](../packages/installers/src/integrations-schema.ts). Adding a new `recordKey` requires updating the schema and deciding whether the schema version must change; the current schema version is `1`.

`recordKey` typos in a persisted `.viberevert/integrations.json` are refused at parse time by the Zod enum. This prevents an unrecoverable record from being written under a typo'd key.

## `.gitignore` expectations

`.viberevert/integrations.json` should be committed. It is the durable record of which VibeRevert integrations are installed in this repo.

Repos should ignore these transient paths:

    .viberevert/integration-backups/
    .viberevert/integration-journal/
    .viberevert/integrations.lock/

Do not ignore the entire `.viberevert/` directory unless the repo also explicitly re-includes `.viberevert/integrations.json`.

The installer engine does not modify the user's `.gitignore`. Auto-editing `.gitignore` is deferred (M G1b-followup-13).

## `integrations.json` schema

The store lives at `.viberevert/integrations.json`. It is a small, human-readable JSON document. The schema is defined in [`packages/installers/src/integrations-schema.ts`](../packages/installers/src/integrations-schema.ts) and validated on every read and write.

Abridged example — one `cursor` integration recorded after `viberevert install --cursor`. The `backup` field is shown as `null`; in real records where the pre-mutation file existed, it points at a `PathSpec` under `integration-backups/`.

```json
{
  "schemaVersion": 1,
  "createdByVersion": "0.7.1-beta.0",
  "updatedByVersion": "0.7.1-beta.0",
  "records": {
    "cursor": {
      "recordKey": "cursor",
      "adapterName": "Cursor",
      "installedAt": "2026-07-01T12:34:56.000Z",
      "installedByVersion": "0.7.1-beta.0",
      "ops": [
        {
          "kind": "json-key-merge",
          "target": {
            "scope": "repo",
            "pathTemplate": "{repo}/.cursor/mcp.json",
            "pathRelative": ".cursor/mcp.json"
          },
          "backup": null,
          "managedBlockSha256": null,
          "managedValueSha256": "8f2a91c0b3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddee",
          "fullFileSha256AfterWrite": null,
          "blockId": null,
          "jsonKeyPath": ["mcpServers", "viberevert"],
          "mode": null
        }
      ],
      "meta": {}
    }
  },
  "history": [
    {
      "timestamp": "2026-07-01T12:34:56.000Z",
      "action": "install",
      "recordKey": "cursor",
      "cliVersion": "0.7.1-beta.0"
    }
  ]
}
```

`records` is a sparse map — only recorded integrations appear. `createdByVersion` is set on the first write and never mutated thereafter; `updatedByVersion` is refreshed on every write. `history` records install/uninstall events written by the store.

## `--global` deferred

There is no `--global` flag in this milestone. Global (home-directory-scoped) MCP integrations were considered and deferred to M G1b-followup-10.

The blocker is runtime identity: a global `mcpServers.viberevert` entry has no repo binding, so an installer that removes it on `viberevert uninstall` cannot tell whether another repo still relies on it. A reference-count would solve the storage question but not the runtime question — every repo whose developer runs the shared MCP server needs to reach the right VibeRevert configuration. The eventual global mechanism will require an explicit repo-binding at the runtime layer, not just at the install layer.

## GitHub Action template contract

The `github-action` adapter emits a workflow file at `.github/workflows/viberevert.yml` with the following locked properties. The full template lives in [`packages/adapters/src/adapters/github-action-template.ts`](../packages/adapters/src/adapters/github-action-template.ts).

Locked security and behavior bits (from the emitted workflow):

- Workflow-level `permissions:` block with `contents: read` — least-privilege.
- No `pull_request_target` trigger — fork PRs run in the base repo's context with `contents: write` under that trigger; using it is a supply-chain risk that this workflow avoids.
- `actions/checkout` and `actions/setup-node` are pinned to major-version action refs from the template (not `@main` / `@master`, and not immutable commit SHAs — major-version tags).
- Installs the CLI with `npm install -g viberevert@<ctx.cliVersion>` — the exact CLI version is pinned at install time, not `@latest` or `@beta`.
- Uses `viberevert check --since` for both PR and push diff ranges (PR base SHA for `pull_request`; `github.event.before` for `push`; a guard step for the all-zeros initial-push SHA so first-push to a branch does not fail on a missing diff base).

Re-installing over an existing VibeRevert-managed workflow uses `sentinel-block-replace` — the version bump is applied by editing the sentinel-wrapped region, not by rewriting the whole file. A user-authored workflow at the same path is refused with `non-vr-workflow-present`; `--force-reinstall` backs it up and installs.

The `github-action` adapter is **explicit-only**: `viberevert install --all` does not create the workflow. Users opt in with `viberevert install --github-action`.

## CLI output vocabulary

The `viberevert install` and `viberevert uninstall` commands emit one line per selected adapter during adapter iteration. Lines use a fixed bracket vocabulary; the message body is engine-owned.

Install (5 categories):

| Line | Meaning |
|---|---|
| `[skipped: <adapterName>: <reason>]` | `detect` returned `detected: false`. |
| `[refused: <adapterName>: <code>: <message>]` | Adapter returned a `RefusedPlan`, or the engine refused (drift, symlink, target-shape, size, lock, journal, etc.), or a known adapter/installer error was thrown. |
| `[noop: <adapterName>: <reason>]` | Engine returned `InstallOutcome.status = "noop"` — the record already matches the desired state at the current version. |
| `[applied: <adapterName>: <humanSummary>]` | Engine returned `InstallOutcome.status = "applied"`. Includes adoption transactions where `opsApplied` is 0; the `humanSummary` distinguishes them. |
| `[applicable: <adapterName>: <humanSummary>]` | `--dry-run` only: preview classified the transaction as applicable. Followed by an indented per-file diff. |

Uninstall (3 categories):

| Line | Meaning |
|---|---|
| `[uninstalled: <adapterName>: <humanSummary>]` | Engine returned `UninstallOutcome.status = "uninstalled"`. |
| `[noop: <adapterName>: <reason>]` | Engine returned `UninstallOutcome.status = "not-installed"` — nothing to remove. |
| `[refused: <adapterName>: <code>: <message>]` | Engine returned `refused`, or a known installer error was thrown. |

**Exit code.** During adapter iteration, `viberevert install` and `viberevert uninstall` exit 0 when no adapter produced a refused outcome or known-error refusal, and exit 1 otherwise. Validation errors and repo-resolution errors are pre-iteration failures: they print plain stderr and exit 1 without bracket vocabulary.

**Layer separation.** The bracket vocabulary is the CLI-side format. Consumers of `@viberevert/installers` directly dispatch on `outcome.status`, not on formatted strings.

## Error taxonomy

Known errors format as `[refused: <adapterName>: <err.name>: <err.message>]`. Unknown errors are rethrown by the CLI (they are bugs, not part of the refusal surface).

Some refusals are returned as outcome `reasonCode` strings rather than thrown error classes; callers should handle both surfaces.

Engine-side errors — all subclasses of `InstallerError`, exported from `@viberevert/installers`:

- `BackupCollisionError` — a backup with the computed path already exists.
- `IntegrationsCorruptedError` — the store failed schema validation on read.
- `IntegrationsLockError` — the lock directory was already present when acquisition attempted.
- `IntegrationsSchemaVersionError` — the store's `schemaVersion` is not one this build understands.
- `IntegrationTargetNotFileError` — a preflight found a directory (or other non-file) where a regular file was expected.
- `IntegrationTargetParentNotDirectoryError` — a preflight found a non-directory intermediate path component.
- `IntegrationTargetTooLargeError` — a preflight found an existing merge target larger than the configured limit.
- `PendingIntegrationRecoveryError` — the journal scan found a pending entry.
- `SymlinkTargetRefusal` — a preflight found a symlink at or above the target path.
- `TargetOutsideRepoRootError` — a preflight resolved a target path outside `repoRoot`.

The abstract `InstallerError` base is exported so consumers can do a single `instanceof InstallerError` check to route all installer errors through their known-error path.

Adapter-side errors:

- `AdapterError` (abstract base, from `@viberevert/adapters`) — for future adapter subclasses.
- `HookManagerIoError` (from `@viberevert/adapters`) — thrown from hook-manager detection I/O.
- `MalformedPackageJsonError` (from `@viberevert/adapters`) — thrown when a `package.json` used for hook-manager detection cannot be parsed.

Core-side:

- `RepoRootNotFoundError` (from `@viberevert/core`) — thrown during CLI startup. This is a pre-iteration failure and goes to plain stderr, not the bracket vocabulary.

## Migration choreography

Passing `--migrate-from-hook-install` to `viberevert install --husky` orchestrates removal of an existing VibeRevert direct-hook installation after Husky is recorded. The choreography is:

1. The Husky adapter's `plan` sets `meta.migrateFromDirectHook = "true"` when it detects a VibeRevert-managed direct hook on disk and the migrate flag is set.
2. The engine applies the Husky plan.
3. Only if the Husky outcome is `applied` or `noop` (i.e. the Husky record is valid), the CLI invokes `uninstall("direct-hook", ctx)` to remove the migrated direct hook.
4. The direct-hook cleanup outcome is emitted as its own line — either `[applied: Direct hook: removed migrated direct hook]`, `[refused: Direct hook: ...]`, or nothing at all if there was no `direct-hook` record to remove.
5. The direct hook is never removed before the installer has returned a valid Husky `applied` or `noop` outcome. A failed Husky install (`refused`) does not attempt cleanup.

Example — a user with an existing `viberevert hook install` runs `viberevert install --husky --migrate-from-hook-install`. The output includes:

    [applied: Husky: <humanSummary>]
    [applied: Direct hook: removed migrated direct hook]

The second line is contingent on Husky returning `applied` or `noop`. A refused Husky plan or refused Husky apply produces only the first (refused) line, and the direct hook is left in place.

## Per-adapter behavior

The following section captures per-adapter contract surface: what each adapter targets, how it detects, what it refuses, and how uninstall works. The tables are the reference for consumers writing tests or integrations against a specific adapter.

All rows inherit the installer engine safety rules from the sections above: lock acquisition, pending-journal refusal, path confinement, symlink refusal, target-shape and target-size preflight, and recorded-SHA drift checks. `--force-reinstall` and `--force` override only the drift refusal where listed per row. They do not override locks, pending journals, path confinement, symlink refusal, parent-escape refusal, target-shape refusal, target-size refusal, or adapter-layer structural refusals.

### Summary

| Adapter | recordKey | Target | Primary op kind | In `--all` |
|---|---|---|---|---|
| Cursor | `cursor` | `<repo>/.cursor/mcp.json` | `json-key-merge` | yes |
| Direct hook | `direct-hook` | `<repo>/.git/hooks/pre-commit` | `write-new` or `backup-and-write` | yes |
| Husky | `husky` | `<repo>/.husky/pre-commit` | `sentinel-block-insert` | yes |
| Lefthook | `lefthook` | `<repo>/lefthook.yml` (or one of `.yaml` / `.lefthook.yml` / `.lefthook.yaml`) | `sentinel-block-insert` | yes |
| Claude Code | `claude` | `<repo>/.mcp.json` | `json-key-merge` | yes |
| GitHub Action | `github-action` | `<repo>/.github/workflows/viberevert.yml` | `write-new`, `sentinel-block-replace`, or `backup-and-write` | no (explicit-only) |

### Cursor

Current shipped behavior:

| Aspect | Behavior |
|---|---|
| Target path | `<repo>/.cursor/mcp.json` |
| Operation kind | `json-key-merge` at `keyPath: ["mcpServers", "viberevert"]`. |
| Detection trigger | `explicit`: runs the adapter's explicit-intent path. `all`: `detect` reports positive when `.cursor/mcp.json` exists (any kind) or `.cursor/` is a real directory; otherwise `[skipped: Cursor: <reason>]`. |
| Adapter-layer refusals | None. The adapter always produces an `ApplicablePlan` when it reaches `plan`. |
| Engine-layer refusals | Inherited from the engine safety rules. |
| `--force-reinstall` | Overrides: engine drift refusal on the recorded `mcpServers.viberevert` value. Does not override: engine-layer refusals (locks, journals, symlink/parent-escape/structural safety). |
| Uninstall | Follows the recorded `json-key-merge` op and recorded `managedValueSha256` — the value at `keyPath` is removed if the canonical hash matches. `--force` overrides drift only; unrelated `mcpServers.*` keys are preserved. |
| Included in `--all` | Yes. |

### Direct hook

Current shipped behavior:

| Aspect | Behavior |
|---|---|
| Target path | `<repo>/.git/hooks/pre-commit` |
| Operation kind | `write-new` when no existing hook, `backup-and-write` when a non-VibeRevert hook is present. |
| Detection trigger | `explicit`: if Husky or Lefthook is detected via `detectHookManagers`, `detect` returns `detected: false` with a reason pointing at the manager-specific adapter — the CLI formats this as `[skipped: Direct hook: <reason>]`. Otherwise `detect` returns positive with the on-disk `hookState` (`absent`, `vr-managed`, `user-owned`, `non-file`) surfaced in the signal. `all`: same. |
| Adapter-layer refusals | None. `plan` always returns `ApplicablePlan` when the adapter reaches it; the hook-manager gate is at `detect`. |
| Engine-layer refusals | Inherited from the engine safety rules. |
| `--force-reinstall` | Overrides: engine drift refusal on the recorded hook bytes. Does not override: engine-layer refusals. |
| Uninstall | Follows the recorded op and recorded SHA — `write-new` records unlink the hook file; `backup-and-write` records restore from backup (per the Backup layout section). `--force` overrides drift only. |
| Included in `--all` | Yes. |

### Husky

Current shipped behavior:

| Aspect | Behavior |
|---|---|
| Target path | `<repo>/.husky/pre-commit` |
| Operation kind | `sentinel-block-insert` (anchored `append`). |
| Detection trigger | `explicit`: `detect` reports positive iff Husky is detected by [`packages/adapters/src/hook-managers.ts`](../packages/adapters/src/hook-managers.ts); otherwise `[skipped: Husky: <reason>]`. `all`: same. |
| Adapter-layer refusals | If a VibeRevert-managed direct hook is present on disk and `--migrate-from-hook-install` is not set, `plan` returns `RefusedPlan` with `reasonCode: "vr-direct-hook-present"`. With the migrate flag, `plan` becomes applicable and emits `meta.migrateFromDirectHook = "true"`; the CLI observes this after a valid Husky apply and orchestrates direct-hook cleanup (see Migration choreography). |
| Engine-layer refusals | Inherited from the engine safety rules. |
| `--force-reinstall` | Overrides: engine drift refusal on the recorded managed block. Does not override: adapter-layer `vr-direct-hook-present` (that requires `--migrate-from-hook-install`), and does not override engine-layer refusals. |
| Uninstall | Follows the recorded `sentinel-block-insert` op and recorded `managedBlockSha256` — the block is removed from `.husky/pre-commit` by rewriting the file with the sentinel-wrapped region excised; user-owned content outside the sentinel is left untouched. `--force` overrides drift only. |
| Included in `--all` | Yes. |

### Lefthook

Current shipped behavior:

| Aspect | Behavior |
|---|---|
| Target path | One of `lefthook.yml` / `lefthook.yaml` / `.lefthook.yml` / `.lefthook.yaml`, detected in the shipped precedence order. |
| Operation kind | `sentinel-block-insert` under the detected `pre-commit.commands` block. |
| Detection trigger | `explicit`: `detect` reports positive iff Lefthook is detected by [`packages/adapters/src/hook-managers.ts`](../packages/adapters/src/hook-managers.ts); otherwise `[skipped: Lefthook: <reason>]`. `all`: same. |
| Adapter-layer refusals | Refuses unsupported or ambiguous Lefthook YAML shapes with shape-specific `reasonCode` values; see the Locked copy appendix for the enumerated codes. |
| Engine-layer refusals | Inherited from the engine safety rules. |
| `--force-reinstall` | Overrides: engine drift refusal on the recorded managed block. Does not override: adapter-layer shape refusals (those require the operator to fix the config), and does not override engine-layer refusals. |
| Uninstall | Follows the recorded `sentinel-block-insert` op and recorded `managedBlockSha256` — the block is removed from the detected Lefthook config by rewriting the file with the sentinel-wrapped region excised. `--force` overrides drift only. |
| Included in `--all` | Yes. |

### Claude Code

Current shipped behavior:

| Aspect | Behavior |
|---|---|
| Target path | `<repo>/.mcp.json` |
| Operation kind | `json-key-merge` at `keyPath: ["mcpServers", "viberevert"]`. |
| Detection trigger | `explicit`: runs the adapter's explicit-intent path. `all`: `detect` reports positive when `.mcp.json` exists (any kind) or `.claude/` is a real directory (`.mcp.json` wins over `.claude/` when both are present); otherwise `[skipped: Claude Code: <reason>]`. |
| Adapter-layer refusals | None. The adapter always produces an `ApplicablePlan` when it reaches `plan`. |
| Engine-layer refusals | Inherited from the engine safety rules. |
| `--force-reinstall` | Overrides: engine drift refusal on the recorded `mcpServers.viberevert` value. Does not override: engine-layer refusals. |
| Uninstall | Follows the recorded `json-key-merge` op and recorded `managedValueSha256` — the value at `keyPath` is removed if the canonical hash matches. `--force` overrides drift only; unrelated `mcpServers.*` keys are preserved. |
| Included in `--all` | Yes. |

### GitHub Action

Current shipped behavior:

| Aspect | Behavior |
|---|---|
| Target path | `<repo>/.github/workflows/viberevert.yml` |
| Operation kind | `write-new` when the file is absent; `sentinel-block-replace` when the file exists and contains the VibeRevert sentinel; `backup-and-write` when `--force-reinstall` is set against a user-authored workflow. |
| Detection trigger | `detect` reports positive regardless of intent — creating a CI workflow is a user intent, not a discovered state. |
| Adapter-layer refusals | An existing workflow file without the VibeRevert sentinel produces `RefusedPlan` with `reasonCode: "non-vr-workflow-present"` and a `manualSnippet` pointing at `viberevert install --github-action --force-reinstall`. |
| Engine-layer refusals | Inherited from the engine safety rules. |
| `--force-reinstall` | Overrides: adapter-layer `non-vr-workflow-present` refusal (backs up the existing workflow and installs the VibeRevert one) and engine drift refusal on the recorded workflow bytes. Does not override: engine-layer refusals. |
| Uninstall | Removes the VibeRevert-managed workflow content according to the recorded op. Refuses with drift if the current managed region does not match the recorded SHA; `--force` overrides drift only. |
| Included in `--all` | No — explicit-only. Users opt in with `viberevert install --github-action`. |

## Locked copy

The following strings are intentionally stable where tests assert them. `reasonCode` values are stable identifiers — callers may branch on them programmatically. `manualSnippet` and `humanSummary` values are user-facing copy locked by tests today, but consumers should not parse them as identifiers.

Locked by [`packages/adapters/test/adapters/husky.test.ts`](../packages/adapters/test/adapters/husky.test.ts):

- `reasonCode: "vr-direct-hook-present"` (Husky refusal when a VibeRevert direct hook is present without the migrate flag).
- `manualSnippet: "viberevert install --husky --migrate-from-hook-install"`.

Locked by [`packages/adapters/test/adapters/lefthook.test.ts`](../packages/adapters/test/adapters/lefthook.test.ts):

- `reasonCode` values for the shape refusals: `lefthook-config-only-in-local`, `lefthook-config-ambiguous`, `lefthook-config-shape`, `lefthook-viberevert-command-already-present`.

Locked by [`packages/adapters/test/adapters/github-action.test.ts`](../packages/adapters/test/adapters/github-action.test.ts):

- `reasonCode: "non-vr-workflow-present"` (GitHub Action refusal when a user-authored workflow exists at the target path).
- `manualSnippet: "viberevert install --github-action --force-reinstall"`.

Locked by [`packages/cli-commands/test/hook-install-integrations-guard.test.ts`](../packages/cli-commands/test/hook-install-integrations-guard.test.ts):

- The `IntegrationsRecordsHookConflictError` message text for the coexistence guard between `viberevert hook install` and `viberevert install --direct`. See also [`docs/hook-contract.md`](hook-contract.md).

Adapter `name` display strings (referenced from tests in `packages/adapters/test/adapters/*.test.ts`): `Cursor`, `Direct hook`, `Husky`, `Lefthook`, `Claude Code`, `GitHub Action`. Adapter `humanSummary` strings are surface copy — where tests assert them, they are locked for stability, but consumers should not treat them as message identifiers.

## Architectural invariants

The read-only discipline for adapters, the lock/journal ownership by `@viberevert/installers`, and the CLI-side integration-guard between `viberevert hook install` (M F) and `viberevert install --direct` (M G1b) are enforced by architectural invariant tests in [`packages/cli/test/architectural-invariants.test.ts`](../packages/cli/test/architectural-invariants.test.ts). The invariants are named individually (D101.M family) inside the test file; the file is the source of truth for what they assert. Consumers do not need to memorize the individual identifiers to work with the contract.

## Known follow-ups

These are known future items — not urgent, tracked here so they are not lost.

- **M G1b-followup-1** — Migrate release workflow to `changesets/action` for v0.7.2-beta+.
- **M G1b-followup-2** — `--all-known` flag (install every recordable adapter, whether detected or not).
- **M G1b-followup-3** — Codex adapter — re-check 90-day config stability and ship if stable.
- **M G1b-followup-4** — YAML-aware Lefthook merge (structured merge instead of sentinel-block).
- **M G1b-followup-5** — `viberevert doctor` integration with `.viberevert/integrations.json`.
- **M G1b-followup-6** — Reusable GitHub Action repository (`viberevert/action@v1`) as an alternative to the pinned-CLI workflow template.
- **M G1b-followup-7** — First public publish of `@viberevert/policies-basic` in a dedicated milestone.
- **M G1b-followup-8** — MCP `install_integration` / `uninstall_integration` tools.
- **M G1b-followup-9** — GitHub Action adapter re-evaluation if `--since` support is ever removed or renamed.
- **M G1b-followup-10** — Global (home-directory) integrations with explicit runtime repo binding.
- **M G1b-followup-11** — `--all-with-ci` flag (include `github-action` in `--all`).
- **M G1b-followup-12** — Canonical JSON number-precision normalization (if precision differences ever cause SHA drift).
- **M G1b-followup-13** — Auto-edit `.gitignore` (only if user demand emerges and a threat model justifies it).
- **M G1b-followup-14** — `--force-lock` flag for stale-lock recovery.
- **M G1b-followup-15** — Evaluate full auto-recovery from a pending journal.
- **M G1b-followup-16** — Cursor `type: "stdio"` parity check with Claude Code — Cursor's emitted value does not currently carry the `type` discriminator that Claude Code's docs recommend for stdio servers.
- **M G1b-followup-17** — Unify `HookManagerIoError` and `MalformedPackageJsonError` under the `AdapterError` base for a single-`instanceof` classifier.
- **M G1b-followup-18** — Extract shared `ADAPTER_MATRIX` from `install.ts` and `uninstall.ts` once both commands stabilize.
- **M G1b-followup-19** — Reconcile VibeRevert's per-milestone beta patch-line versioning (`0.7.1-beta.0`, `0.7.2-beta.0`, …) with Changesets prerelease semantics, or document a permanent manual-bump release policy. **Resolved in M RH:** beta-phase manual-bump policy documented in `docs/release-process.md` ("Version policy (beta phase)"); Changesets adoption deferred to the first stable or next semantically aligned release line (see followup-1).
- **M G1b-followup-20** — Add the new-publish-target pre-tag gate to the release process doc: package exists on npm or has an approved bootstrap plan; maintainer can publish; Trusted Publisher configured for `release.yml`; package present in the publish arrays/order; pnpm-packed manifest free of `workspace:*` leakage; workflow_dispatch dry-run passes. **Resolved in M RH:** adopted as a numbered pre-tag step in `docs/release-process.md`'s tag-driven publish flow; the arrays/order item is enforced by the release-targets drift invariants.
- **M G1b-followup-21** — Decide whether published package surfaces should exclude `dist/*.tsbuildinfo`.
- **M G1b-followup-22** — Decide npm dist-tag hygiene for beta packages, including the `bootstrap` tag on first-release packages and the `latest: 0.0.0` placeholder relics.

## Maintenance note

Adding a new adapter touches multiple surfaces. The current checklist:

- Add the `recordKey` to the enum in `packages/installers/src/integrations-schema.ts`.
- Add the adapter to the sub-barrel and root barrel of `@viberevert/adapters`.
- Add a matrix entry in the CLI's `ADAPTER_MATRIX` (`install.ts` and `uninstall.ts`) if the adapter is user-facing.
- Add a row to the per-adapter conflict matrix in this document.
- Update the shipped/deferred status at the top of this document.
- Update the ship-status row in [`docs/integrations.md`](integrations.md).
- Update `packages/installers/README.md` / `packages/adapters/README.md` if the adapter is publishable.
- Add unit tests for `preview` / `apply` / `uninstall` behavior on the new `recordKey`.
