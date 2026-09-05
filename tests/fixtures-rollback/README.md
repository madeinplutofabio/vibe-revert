# Rollback Receipt Golden Fixtures (M D Step 8)

Byte-stable golden fixtures for `viberevert rollback` receipt rendering.
Each scenario verifies rollback CLI behavior end-to-end. Receipt-producing
scenarios also verify rendered artifacts (`receipt.json`,
`receipt.terminal.txt`, `receipt.markdown.md`) byte-by-byte; refusal
scenarios verify that no receipt is written.

Parallel to `tests/fixtures/` which holds M C `viberevert report` goldens.
Both directories share the same harness machinery in
`tests/fixtures/harness.ts` and the same regen driver in
`scripts/regen-goldens.ts`.

## Directory layout

```text
tests/fixtures-rollback/
├── README.md                                       ← you are here
├── clean-dry-run/
│   ├── setup.json
│   └── expected/
│       ├── receipt.json
│       ├── receipt.terminal.txt
│       └── receipt.markdown.md
├── clean-apply/
│   ├── setup.json
│   └── expected/
│       └── ... (3 receipt artifacts)
├── dirty-refuse-fresh-session/
│   └── setup.json                                  ← no expected/ for refusal scenarios
├── force-apply/
│   ├── setup.json
│   └── expected/
│       └── ... (3 receipt artifacts)
└── partial-failure-extraction-conflict/
    ├── setup.json
    └── expected/
        └── ... (3 receipt artifacts)
```

## setup.json schema

Each `setup.json` is validated at harness-load time by
`validateReceiptFixtureSetup` in `tests/fixtures/harness.ts`. The schema
(shape mirrored from the TypeScript interface, JSDoc-style notes):

```ts
interface ReceiptFixtureSetup {
  /**
   * Initial committed files — written before `viberevert init`,
   * then committed as the baseline. Required.
   */
  files: { path: string; content: string }[];

  /** Must be literal true. The harness always runs `git init`. */
  git_init: true;

  /**
   * OPTIONAL. Untracked files written AFTER the initial commit but
   * BEFORE `viberevert start` — captured into the checkpoint's
   * untracked archive. Use this when the fixture needs the captured
   * tarball to contain specific files (e.g., extraction-conflict
   * scenarios where the captured file path becomes the collision
   * target).
   */
  pre_session_untracked_files?: { path: string; content: string }[];

  /** Session metadata + modifications during the session. */
  session: {
    /** Optional human-readable task description. */
    task?: string;

    /**
     * OPTIONAL. Modifications to ALREADY-COMMITTED files during
     * the session (overwrites). Captured in after-status.
     */
    modifications?: { path: string; content: string }[];

    /**
     * OPTIONAL. New untracked files created DURING the session
     * (NOT in the captured untracked archive — they're session-
     * created additions).
     */
    untracked_files?: { path: string; content: string }[];
  };

  /**
   * OPTIONAL. Files written AFTER `viberevert end` — represents
   * unrelated dirty paths the user accumulated post-session. Used
   * to trigger D61 dirty-tree refusals (or, with --force, to
   * populate forced_unrelated_dirty_paths in the receipt).
   */
  unrelated_dirt_after_end?: { path: string; content: string }[];

  /**
   * OPTIONAL. Filesystem mutations applied between `viberevert end`
   * and `viberevert rollback`. The harness applies the three fields
   * in EXACTLY this order — the order is LOCKED:
   *
   *   1. `delete_paths` — rm -rf each path.
   *   2. `create_dirs`  — recursive mkdir each path. Empty
   *      directories are NOT enumerated by `git ls-files --others`,
   *      so they survive the restore-time delete pass. This is the
   *      mechanism that triggers extraction_conflict in the
   *      `partial-failure-extraction-conflict` fixture (see below).
   *   3. `create_files` — write each regular file.
   *
   * NO `post_end_commits` / `post_end_git` / shell-hook fields exist
   * intentionally. Committing a blocker would advance HEAD and trip
   * D64 HEAD-mismatch BEFORE restore runs.
   */
  post_end_transformations?: {
    /** Paths to rm recursively. */
    delete_paths?: string[];
    /**
     * Paths to recursive-mkdir. A single entry like
     * `subdir/file.txt/blocker` creates BOTH `subdir/file.txt/` AND
     * the empty `blocker/` subdirectory inside it.
     */
    create_dirs?: string[];
    /** Files to create (parent dirs autocreated). */
    create_files?: { path: string; content: string }[];
  };

  /** The rollback CLI invocation under test. */
  rollback_invocation: {
    mode: "dry_run" | "apply";
    force: boolean;

    /**
     * OPTIONAL. M 0.8.0 selectors. Supplying ANY of them puts the
     * invocation into SELECTIVE mode, which changes both the engine
     * under test and the artifact it writes. The harness DERIVES the
     * receipt path from this field rather than taking a second
     * declaration, so a fixture cannot claim one mode and be verified
     * against the other's artifact.
     *
     * Each array must be non-empty when present; omit the field
     * instead. That mirrors the attempt marker's schema, where absence
     * is the only spelling of "family not used", and it stops a fixture
     * from looking selective in the setup file while running as a
     * legacy full rollback.
     *
     * `finding` entries must be FULL `fnd_<64 lowercase hex>` ids, which
     * is what the command accepts and what the marker persists. The
     * validator rejects a prefix here so the fixture's own error is
     * named, rather than surfacing later as an unexpected exit code.
     */
    only?: string[];
    except?: string[];
    finding?: string[];
    risk?: "low" | "medium" | "high" | "critical";
  };

  /**
   * Expected process exit code: 0 (success) or 1 (refusal or
   * apply-with-failures). Exit 2 is NEVER valid per D66.
   */
  expected_rollback_exit_code: 0 | 1;

  /**
   * Whether the rollback should persist a receipt at the D68 path
   * matching `rollback_invocation.mode`. Decouples
   * receipt-existence from exit code per Lock #16: an apply
   * ATTEMPT that fails mid-restore still writes a receipt.
   */
  expected_receipt: boolean;
}
```

## Schema cross-checks

Beyond per-field validation, the validator enforces three combination
rules:

1. `expected_receipt: false` ⇒ `expected_rollback_exit_code: 1` —
   refusal scenarios never exit 0.
2. `expected_receipt: true` + `rollback_invocation.mode: "dry_run"` +
   `rollback_invocation.force: true` is REJECTED — `--force` without
   `--apply` is a CLI flag-validation refusal in `rollback.ts` and
   no receipt is ever built.
3. `expected_receipt: true` + `rollback_invocation.mode: "dry_run"`
   requires `expected_rollback_exit_code: 0` per D66 (successful
   dry-run always exits 0).

## Where a receipt lands, per cell

The four operation cells write four different artifacts, and the harness
asserts both that the right one exists and that every other one is
absent. That absence check is what makes the split enforceable: a
selective run that wrote a legacy receipt, or a preview that reserved an
invocation directory, fails here rather than passing on the file it did
produce.

| Cell | Artifact |
|---|---|
| full / dry run | `sessions/<id>/rollback-dry-run-receipt.json` |
| full / apply | `sessions/<id>/rollback-receipt.json` |
| selective / dry run | `sessions/<id>/selective-rollback-dry-run-receipt.json` |
| selective / apply | `sessions/<id>/rollbacks/<rb_ULID>/receipt.json` |

The selective apply receipt sits inside a per-invocation directory whose
`rb_<ULID>` name is not known before the run, so the harness DISCOVERS
it and requires exactly one such directory. More than one would mean the
scenario ran the engine twice, and the goldens would silently describe
whichever the sort put first.

A refusal scenario writes none of the four, and reserves no invocation
directory at all. The last part matters most: an invocation holding a
marker with no receipt is what the history scan treats as a blocker, so
a refusal that left one behind would taint every later apply on that
session.

## The 8 mandatory fixtures

These scenarios are locked by `REQUIRED_RECEIPT_FIXTURE_NAMES`
in `packages/cli/test/golden-receipts.test.ts`. Deletion of any
required name fails the "all required scenarios exist" test loudly;
adding NEW scenarios beyond these is permitted (superset-tolerant).

### 1. `clean-dry-run/`

`{ mode: "dry_run", force: false }` → exit 0, dry-run receipt written.
Baseline success case for dry-run; no unrelated dirt, no post-end
transformations. Receipt has `mode: "dry_run"`,
`pre_rollback_checkpoint_id: null`.

### 2. `clean-apply/`

`{ mode: "apply", force: false }` → exit 0, apply receipt written.
Baseline success case for apply. Receipt has `mode: "apply"`,
non-null `pre_rollback_checkpoint_id` (the emergency CP),
`forced: false`, empty `forced_unrelated_dirty_paths`, empty
`failures`.

### 3. `dirty-refuse-fresh-session/`

`{ mode: "apply", force: false }` + `unrelated_dirt_after_end` →
exit 1, **no receipt**. Proves D61's pre-mutation dirty-tree refusal
fires before D65 / restoreCheckpoint / receipt persistence. The only
fixture with `expected_receipt: false`. **No `expected/` directory.**

### 4. `force-apply/`

`{ mode: "apply", force: true }` + `unrelated_dirt_after_end` →
exit 0, apply receipt written with `forced: true` AND
`forced_unrelated_dirty_paths` populated per D69's audit refine.
Proves D75's `--force` policy bypasses D61 specifically (not other
refusals).

### 5. `partial-failure-extraction-conflict/`

`{ mode: "apply", force: false }` + `pre_session_untracked_files`
captured into the tarball + `post_end_transformations` that delete
the captured path and use `create_dirs` to create an empty
subdirectory inside a directory at the same path. Triggers
`RestoreExtractionConflictError` during restore. Receipt persists per
Lock #16 (apply ATTEMPT writes receipt regardless of restore success)
with `failures` containing an entry whose
`error_code === "extraction_conflict"`, empty `results`, exit 1.

**Why an empty subdirectory and NOT a regular-file blocker** —
critical maintainer note, do NOT "simplify" the fixture back to a
regular file:

- A regular file at the captured path gets enumerated by
  `git ls-files --others` and DELETED by `deleteUncapturedUntracked`
  BEFORE `clearExtractionPathConflicts` runs. The destination becomes
  empty and rmdir-able. Restore succeeds. The fixture stops testing
  `extraction_conflict`.
- An EMPTY subdirectory inside a directory at the captured path
  SURVIVES the delete pass (git does not enumerate empty directories
  via `ls-files --others`). The captured-path directory remains
  non-empty when `clearExtractionPathConflicts` runs, `rmdir` fails
  with ENOTEMPTY, and a structured conflict surfaces.

This is the mechanism locked by the git restore test named
"surfaces non-empty directory at a final manifest path as a structured conflict"
in `packages/git/test/restore.test.ts` — the fixture mirrors it 1:1
through the harness.

**Why `force: false`** — the empty-subdir blocker is invisible to
`git ls-files --others`, so D61 dirty-tree check sees zero unrelated
paths and never fires. The fixture isolates the intended contract:
clean preconditions → restore reaches extraction → structured
`extraction_conflict` failure → apply receipt persists per Lock #16.
D75 `--force` coverage lives in the `force-apply` fixture.

### 6. `selective-dry-run/`

`{ mode: "dry_run", force: false, only: ["src/**"] }` → exit 0,
selective preview receipt written. The selective half of the dry-run
cell. The session modifies BOTH `src/app.ts` and `docs/guide.md`; the
selector matches only the first, so the receipt's single result and
single resolved change group are the proof that selection actually
narrowed the operation rather than the run happening to touch one file.

Receipt has `mode: "dry_run"`, `eligibility: "eligible"`, and no
`pre_rollback_checkpoint_id` field at all — a preview publishes no
marker and reserves no invocation, which is also why the artifact lives
beside the session rather than under `rollbacks/`.

### 7. `selective-apply/`

`{ mode: "apply", force: false, only: ["src/**"] }` → exit 0, an
invocation's `receipt.json` written. The same two-file session as
above, applied. Proves the whole transplant path end to end: the
emergency checkpoint is created, the attempt marker is published, only
the selected path is restored, and `first_verification` reports the
UNSELECTED domain was checked and found clean. That last number is what
distinguishes a selective restore from a whole-tree one.

Receipt has `outcome: "succeeded"`, a non-null
`pre_rollback_checkpoint_id`, `project_verification: not_configured`
(the fixture configures no `verify.commands`), and
`post_command_integrity: not_run` with reason `commands_not_configured`.

### 8. `selective-empty-apply-refuse/`

`{ mode: "apply", force: false, only: ["nothing/matches/**"] }` →
exit 1, **no receipt**, **no invocation directory**. **No `expected/`
directory.**

The one place the two modes deliberately diverge. A dry run RECORDS an
empty resolution as `eligibility: "empty_selection"`; an apply refuses
it, because there is nothing to authorize and the attempt marker's
schema cannot express a selection resolving to no change group. Required
rather than optional because a regression that started reserving an
invocation here would leave a marker with no receipt, and that is
exactly what the history scan treats as a blocker for every later apply
on the session.

**Not covered by a fixture, deliberately** — `--risk` and `--finding`
resolve against a session report, which means the fixture would have to
run `viberevert check --since` and pin finding ids into `setup.json`,
coupling these goldens to the checks engine's output. Their resolution
algebra is covered by `selection-resolver.test.ts` and their CLI
validation by `rollback-selective-command.test.ts`.

## How to regen / verify

### Regenerate goldens after a behavior change

```sh
pnpm --filter viberevert... build
pnpm regen-goldens
git diff tests/fixtures-rollback
```

The regen driver (`scripts/regen-goldens.ts`) iterates both
`tests/fixtures/` and `tests/fixtures-rollback/`. Output is prefixed
by fixture kind (`report:<name>` / `receipt:<name>`).

### Verify goldens (locked baseline)

```sh
pnpm --filter viberevert test
```

The test file `packages/cli/test/golden-receipts.test.ts` runs every
fixture in verify mode. On byte mismatch the test fails with a diff
showing expected vs actual.

The test file auto-builds the CLI if `packages/cli/dist/index.js` is
missing (clean CI scenario), coordinated by
`tests/fixtures/cli-build.ts`'s mkdir-based exclusive lock so
parallel vitest workers don't race on the build.

## Adding a new fixture

1. Create `tests/fixtures-rollback/<name>/setup.json` with a
   schema-valid body.
2. Run `pnpm --filter viberevert... build && pnpm regen-goldens` to
   seed `expected/*` files (only for `expected_receipt: true`
   scenarios — refusal fixtures have no `expected/` directory).
   Do not hand-edit `expected/*` unless intentionally testing the
   verifier itself; golden artifacts should normally be produced by
   `pnpm regen-goldens`.
3. Manually review the generated `expected/*` files to confirm they
   look right.
4. Run `pnpm --filter viberevert test` to verify the byte-stable
   comparison passes.
5. Commit `setup.json` + the seeded `expected/*` files together
   (atomic commit so the goldens always match the fixture intent).

If the new fixture is meant to be MANDATORY (deletion fails CI),
add its name to `REQUIRED_RECEIPT_FIXTURE_NAMES` in
`packages/cli/test/golden-receipts.test.ts`. Otherwise it's
superset-tolerant — present but not required.

## Determinism

The harness sets four env vars that make CLI output byte-stable
across runs:

| Env var | Value | Purpose |
|---|---|---|
| `VIBEREVERT_TEST_FIXED_NOW` | `2026-01-01T00:00:00Z` | All timestamps |
| `VIBEREVERT_TEST_FIXED_ULID_SEED` | `golden` | All ULIDs (session, checkpoint, rollback, emergency CP) |
| `VIBEREVERT_TEST_FIXED_SHA` | `0000000000000000000000000000000000000000` | Synthetic SHA where needed (40 zero characters) |
| `VIBEREVERT_TEST_FIXED_VERSION` | `0.7.0-beta` | Product version in markdown footer |

Plus git commit author / date env vars for commits the harness
makes itself. Together these guarantee byte-identical output across
machines and CI runs.

## Relationship to `tests/fixtures/`

`tests/fixtures/` holds M C scenarios that exercise
`viberevert check` + `viberevert report`. Different schema
(`FixtureSetup` vs `ReceiptFixtureSetup`), different harness
function (`runFixture` vs `runReceiptFixture`), different artifact
filenames (`report.{json,terminal.txt,markdown.md}` vs
`receipt.{...}`). Same regen driver, same determinism env vars,
same byte-stable verification discipline. The two dirs coexist and
both are regenerated by a single `pnpm regen-goldens` invocation.
