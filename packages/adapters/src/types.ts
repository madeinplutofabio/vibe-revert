// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter contract types for @viberevert/adapters.
 *
 * Adapters describe DESIRED integration state via the two-method
 * `Adapter` interface (`detect` + `plan`); the installer engine in
 * @viberevert/installers compares that desired state against the
 * integrations record + on-disk bytes and produces an `InstallOutcome`
 * (applied | noop | refused). Per D101.A:
 *
 *   - Adapters are READ-ONLY (may read filesystem state during detect /
 *     plan; MUST NEVER mutate; MUST NEVER read or parse
 *     `.viberevert/integrations.json`).
 *   - Adapters have NO `render()` method -- dry-run preview lives in
 *     `@viberevert/installers` where file IO is permitted.
 *   - `NoopPlan` is NOT an adapter concept; it lives in installers'
 *     `InstallOutcome` because deciding "already installed" requires
 *     reading the integrations record (which adapters cannot do).
 *
 * `recordKey` is constrained to the v1 enum locked in D101.O (matches
 * `RecordKeySchema` in `@viberevert/installers/src/integrations-schema.ts`).
 * Codex is intentionally absent in v1 per Q2 DEFER; it is added to both
 * unions atomically if/when Step 0 verify-item 4 flips to SHIP.
 */

import type { SentinelAnchor } from "./sentinel.js";

/**
 * Canonical JSON value tree. Used for all serializable payloads that
 * flow through the adapter / installer / integrations-record path.
 * Mirrors the inputs accepted by the canonical-JSON helper that lives
 * in @viberevert/installers; adapters MUST emit only JsonValue-shaped
 * data so the installer can canonicalize, hash, and persist without
 * type narrowing tricks downstream.
 *
 * Numbers MUST be finite JSON numbers. Adapters MUST NOT emit `NaN`,
 * `Infinity`, or `-Infinity`; the installer schema rejects non-finite
 * numbers before canonicalization. (`JSON.stringify(NaN)` silently
 * produces `"null"` inside objects/arrays, which would invalidate
 * canonical-hash equality and let drift slip past the integrations-
 * record SHA check.)
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Runtime context passed to every `Adapter.detect()` and `Adapter.plan()`
 * call. Adapters use it to discover the host repo and to honor
 * flag-driven semantics from the CLI.
 *
 * NO `homeDir` field in v1. The "project-local only" discipline
 * (D101.E + D101.F) is enforced by the TYPE, not just by convention.
 * Global support (M G1b-followup-10) is a deliberate contract-extension
 * milestone; adding `homeDir` to `AdapterContext` is part of that
 * milestone's locked signature change.
 */
export interface AdapterContext {
  readonly repoRoot: string;
  readonly now: Date;
  readonly cliVersion: string;
  /**
   * Caller intent (D101.J). `"explicit"` means the user named this
   * adapter on the command line (e.g. `viberevert install --cursor`);
   * `"all"` means the adapter was selected via `--all` and must only
   * report `detected: true` when on-disk signal exists.
   */
  readonly intent: "explicit" | "all";
  /**
   * Typed boolean flags carried in from CLI options. NO stringly-typed
   * `meta` substitutes (D101.A discipline; see plan Step 1).
   */
  readonly options: {
    readonly forceReinstall: boolean;
    readonly migrateFromHookInstall: boolean;
    readonly forceUninstall: boolean;
  };
}

/**
 * Outcome of `Adapter.detect(ctx)` -- a discriminated union on `detected`
 * so consumers narrow via `if (det.detected)` / `if (!det.detected)`.
 *
 * `reason` exists ONLY on the not-detected variant (the value has no
 * meaning when detection succeeded; the type prevents downstream code
 * from treating it as if it did). `signal` is JSON-safe structured
 * diagnostic data, optional on both variants, used for logging and tests
 * (e.g. `{ path: "<repo>/.husky/pre-commit", version: "9" }`).
 *
 * NO `reasonCode` field: the `[skipped]` UX category is softer than
 * `[refused]`, and the only known consumer is human-readable skip
 * messaging. `RefusedPlan` carries `reasonCode` because refusal is a
 * stronger, user-actionable state.
 */
export type DetectResult = DetectedResult | NotDetectedResult;

export interface DetectedResult {
  readonly detected: true;
  readonly signal: JsonObject | null;
}

export interface NotDetectedResult {
  readonly detected: false;
  /**
   * Human-readable text used by the CLI's
   * `[skipped: <adapter>: <reason>]` output category.
   */
  readonly reason: string;
  readonly signal: JsonObject | null;
}

/**
 * Path specification for a target or backup file. Per D101.D, the schema
 * NEVER persists absolute filesystem paths -- `pathTemplate` carries an
 * unresolved template (e.g. `{repo}/.cursor/mcp.json`), `pathRelative`
 * is the same path relative to the scope root in POSIX style, and the
 * installer's `resolvePath()` produces the absolute path at runtime.
 *
 * `scope` is `"repo"` in v1; `"home"` and `"absolute"` are deferred to
 * schema v2 (M G1b-followup-10's global support).
 */
export interface PathSpec {
  readonly scope: "repo";
  readonly pathTemplate: string;
  /**
   * POSIX-style path with `/` separators, even on Windows (D101.D).
   * Adapters MUST emit forward slashes; the installer's `resolvePath()`
   * joins with the platform separator at runtime.
   */
  readonly pathRelative: string;
}

/**
 * Adapter-emitted operation describing a single edit the installer should
 * perform. Discriminated by `kind`. The `content` field is a JavaScript
 * STRING in every variant that carries one -- the installer encodes to
 * UTF-8 bytes at write time. Adapters never carry byte buffers.
 *
 *   - `write-new`: create a new file (or overwrite if `--force-reinstall`).
 *     `content` is the full file text. `mode` (optional) is honored on
 *     POSIX via chmod; no-op on Windows per D101.K's mode discipline.
 *   - `sentinel-block-insert`: inject a sentinel block into an existing
 *     text file, anchored per `anchor`. `content` is the block's interior
 *     text (without the BEGIN/END markers -- the installer renders them).
 *   - `sentinel-block-replace`: replace the content of an existing
 *     sentinel block matched by `blockId`. `content` is the new block
 *     interior text.
 *   - `backup-and-write`: back up the current file to
 *     `.viberevert/integration-backups/...` (D101.E), then overwrite
 *     with `content` (full file text).
 *   - `json-key-merge`: structured-merge `value` into the existing JSON
 *     file at `keyPath`. NO sidecar key is written into the user's JSON
 *     (the managed-value SHA lives in our integrations record per D101.C).
 */
export type FileEditOp =
  | {
      readonly kind: "write-new";
      readonly target: PathSpec;
      readonly content: string;
      readonly mode?: number;
    }
  | {
      readonly kind: "sentinel-block-insert";
      readonly target: PathSpec;
      readonly blockId: string;
      readonly content: string;
      readonly anchor: SentinelAnchor;
    }
  | {
      readonly kind: "sentinel-block-replace";
      readonly target: PathSpec;
      readonly blockId: string;
      readonly content: string;
    }
  | {
      readonly kind: "backup-and-write";
      readonly target: PathSpec;
      readonly content: string;
      readonly mode?: number;
    }
  | {
      readonly kind: "json-key-merge";
      readonly target: PathSpec;
      readonly keyPath: ReadonlyArray<string>;
      readonly value: JsonValue;
    };

/**
 * v1 record-key vocabulary per D101.O. The same enum is mirrored as a
 * Zod schema (`RecordKeySchema`) in
 * `@viberevert/installers/src/integrations-schema.ts`; both move together
 * when the locked set changes.
 *
 * `RecordKey` is the DURABLE STORAGE KEY used to look up an integration
 * in `.viberevert/integrations.json`. Distinct from `adapterName`
 * (human/logging text) on `ApplicablePlan` -- see those JSDocs for the
 * separation discipline.
 */
export type RecordKey =
  | "cursor"
  | "claude"
  | "github-action"
  | "direct-hook"
  | "husky"
  | "lefthook";

/**
 * Adapter return type: a desired-state description.
 *
 * Discriminated by `status`:
 *   - `"applicable"`: the adapter wants to perform the listed `ops`.
 *     The installer compares desired SHAs against integrations record +
 *     on-disk bytes per D101.B to decide whether to apply, noop, or
 *     refuse (drift).
 *   - `"refused"`: the adapter declines to plan (e.g. config-shape
 *     mismatch). `manualSnippet` (optional) carries text the CLI can
 *     surface for manual installation.
 *
 * NO `NoopPlan` variant: noop detection requires reading the integrations
 * store, which adapters cannot do (D101.A). The installer's
 * `InstallOutcome` carries the noop status.
 */
export type AdapterPlan = ApplicablePlan | RefusedPlan;

export interface ApplicablePlan {
  readonly status: "applicable";
  /**
   * Human-readable adapter identifier for CLI output and logs (e.g.
   * `"cursor"`, `"github-action"`). DO NOT use for equality comparisons
   * or storage lookups -- `recordKey` is the durable storage key. In v1
   * these strings happen to match `RecordKey` values per adapter, but
   * downstream code MUST NOT depend on that coincidence.
   */
  readonly adapterName: string;
  readonly humanSummary: string;
  readonly ops: ReadonlyArray<FileEditOp>;
  /**
   * Durable storage key written into `.viberevert/integrations.json` and
   * used for all lookups (including the M F coexistence guard's
   * `hasRepoIntegrationRecord(repoRoot, recordKey)` query). Stable
   * across installer / uninstaller / migration calls for the same
   * integration.
   */
  readonly recordKey: RecordKey;
  /**
   * Serializable adapter-specific metadata stored on the integrations
   * record. JSON-safe (canonical-JSON friendly) so the installer can
   * persist via `canonicalJson()` and reload via Zod validation without
   * downstream type narrowing. Used for cross-step coordination (e.g.
   * husky's `migratedFromDirectHook: true` marker).
   */
  readonly meta: JsonObject;
}

export interface RefusedPlan {
  readonly status: "refused";
  readonly adapterName: string;
  readonly reasonCode: string;
  readonly message: string;
  /**
   * Display-only text for CLI output (e.g. a shell snippet or YAML
   * fragment the user can paste manually). Installers MUST NOT execute,
   * parse, or otherwise act on this string -- its sole purpose is to
   * appear verbatim in the `[refused: <adapter>: ...]` CLI category.
   */
  readonly manualSnippet?: string;
}

/**
 * The adapter interface. Exactly two methods, both async:
 *
 *   - `detect(ctx)`: returns whether this adapter applies to the current
 *     repo + ctx.intent combination. MAY read filesystem; MUST NOT
 *     mutate; MUST NOT read `.viberevert/integrations.json`.
 *   - `plan(ctx)`: returns either an `ApplicablePlan` describing the
 *     desired edits or a `RefusedPlan` describing why the adapter
 *     cannot proceed. Same read-only constraints as `detect`.
 */
export interface Adapter {
  /**
   * Human-readable adapter identifier for CLI output and logs. DO NOT use
   * for equality comparisons or storage lookups; `ApplicablePlan.recordKey`
   * is the durable storage key emitted by `plan()`.
   */
  readonly name: string;
  detect(ctx: AdapterContext): Promise<DetectResult>;
  plan(ctx: AdapterContext): Promise<AdapterPlan>;
}
