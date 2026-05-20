// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit + integration tests for packages/checks/src/detectors/migrations.ts
// and ./migrations-danger-terms.ts (Step 6 file 4).
//
// Coverage strategy:
//
//   1. SCOPE GATE — database-category files only (via classifyPath).
//      Non-DB files, DB-shaped paths without the matching framework,
//      binary files, and empty addedLines all skip cleanly.
//
//   2. RULE 1: ALL-TERM SMOKE MATRIX — every entry in
//      MIGRATION_DANGER_TERMS has a tuple in DANGER_TERM_SMOKE_CASES
//      proving the term fires on a representative line with a
//      REALISTIC path + framework combination. A meta-coverage test
//      asserts the smoke matrix and the data layer stay in sync —
//      adding a term without smoke coverage fails immediately.
//
//      Path strategy is REALISTIC per ecosystem (no contrived
//      `database/migrations/foo.py + ["laravel"]` hacks):
//        - SQL keywords (universal, no fileExtensions): Laravel
//          migration path (`database/migrations/...php` + ["laravel"])
//        - Laravel Schema-builder methods + Artisan commands:
//          Laravel migration path + ["laravel"]
//        - Rails DSL: `db/migrate/...rb` + ["rails"]
//        - Django: `<app>/migrations/...py` + ["django"]
//        - Sequelize/TypeORM: `migrations/...ts` + ["sequelize"]
//          (the shared term `sequelize.drop-table` etc. fires under
//          either framework because both rules classify the path AND
//          the file extension passes the fileExtensions filter)
//
//   3. SQL.TRUNCATE VS LARAVEL.TRUNCATE LOOKAHEAD LOCK — Step 6's
//      `(?!\s*\()` negative lookahead on sql.truncate's regex. Locked
//      via 3 tests: positive `TRUNCATE TABLE`, negative `->truncate()`
//      (only laravel.truncate fires), negative bare `truncate()`
//      (neither rule fires).
//
//   4. EXTENSION SCOPING — D-style tests proving the term-level
//      `fileExtensions` filter selects the right rule when the same
//      identifier (`dropTable`) exists across ecosystems. Locked by
//      file 1's MANIFEST_NON_DEP_KEYS-style discipline (but in this
//      detector via fileExtensions on each DangerTerm).
//
//   5. RULE 2: MISSING-DOWN POSITIVE — new (status: "added")
//      Laravel/Rails/Sequelize migrations with a destructive
//      operation and no down() method definition → missing-down
//      fires alongside the danger-term finding.
//
//   6. RULE 2: MISSING-DOWN CANCELLATION BY down() SHAPE — each
//      pattern in DOWN_METHOD_PATTERNS cancels missing-down when
//      present in addedLines. Laravel/Rails/JS+TS class method/JS
//      object property/3 export shapes (named function, CommonJS,
//      ES const arrow). Total: 11 cancellation tests.
//
//   7. RULE 2: MISSING-DOWN COMMENT-SAFE — anchored DOWN_METHOD_
//      PATTERNS (`^\s*...`) don't false-cancel on
//      `// TODO add function down()` or `// down() {` comments.
//
//   8. RULE 2: MISSING-DOWN EXTENSION/EXCLUSION/STATUS GATES — the
//      5-condition gate on missing-down: raw .sql (positive-ext
//      gate), Django .py (positive-ext + exclusion glob), modified
//      Laravel + modified Rails (status === "added" required).
//      Locked per file 1's full gate spec.
//
//   9. EDGE CASES — Windows backslash path normalization,
//      multiple-danger-terms-same-line, same-term-multiple-lines.
//
// =============================================================================
// CRITICAL TEST DISCIPLINE — `configChecks: { migrations: true }` +
// EXPLICIT `detectedFrameworks`
// =============================================================================
//
// Every test that calls runChecks MUST set `migrations: true` in
// configChecks (else D28 Layer 1 skips the check and 0 findings is
// returned for the wrong reason). The ctxFor helper below defaults
// to { migrations: true }.
//
// `detectedFrameworks` is EXPLICIT per test (no hidden default like
// ["laravel", "rails"]) because the path-classifier scope gate is
// part of the detector's behavior. Hidden defaults could mask scope
// bugs. The convenience wrappers (laravelCtx, railsCtx, etc.) make
// the framework choice visible at the call site.
//
// =============================================================================
// Test pipeline: isolated `runChecks([migrationsCheck], ctx)` — same
// future-detector-brittleness avoidance as Step 4 (secrets) and
// Step 5 (dependencies).

import { describe, expect, it } from "vitest";

import { migrationsCheck } from "../../src/detectors/migrations.js";
import { MIGRATION_DANGER_TERMS } from "../../src/detectors/migrations-danger-terms.js";
import type { ChangedFileInput, CheckContext, ChecksToggleConfig } from "../../src/index.js";
import { runChecks } from "../../src/index.js";

// =============================================================================
// Local helpers
// =============================================================================

/** ChangedFileInput with no added lines (just the path; status defaults to "modified"). */
function pathOnly(path: string): ChangedFileInput {
  return {
    path,
    status: "modified",
    addedLines: [],
    removedLines: [],
    isBinary: false,
  };
}

/** ChangedFileInput with added lines (status defaults to "added" — typical for new migration files). */
function withAddedLines(
  path: string,
  addedLines: readonly { line: number; text: string }[],
): ChangedFileInput {
  return {
    path,
    status: "added",
    addedLines,
    removedLines: [],
    isBinary: false,
  };
}

/**
 * ChangedFileInput with added lines AND explicit status override.
 * Used for missing-down status-gate tests (status: "modified" must
 * SKIP missing-down even when destructive terms are present in
 * addedLines).
 */
function withStatus(
  path: string,
  status: ChangedFileInput["status"],
  addedLines: readonly { line: number; text: string }[],
): ChangedFileInput {
  return {
    path,
    status,
    addedLines,
    removedLines: [],
    isBinary: false,
  };
}

/** Binary ChangedFileInput (forces detector's binary skip). */
function binaryFile(path: string): ChangedFileInput {
  return {
    path,
    status: "modified",
    addedLines: [],
    removedLines: [],
    isBinary: true,
  };
}

/**
 * Build a CheckContext with explicit `detectedFrameworks`. Defaults
 * `configChecks` to `{ migrations: true }` so D28 Layer 1 does NOT
 * short-circuit migrationsCheck.
 */
function ctxFor(
  files: readonly ChangedFileInput[],
  detectedFrameworks: readonly string[],
  configChecks: ChecksToggleConfig = { migrations: true },
): CheckContext {
  return { changedFiles: files, detectedFrameworks, configChecks };
}

// Convenience wrappers per ecosystem. Keep the framework gate visible
// at the call site — a hidden multi-framework default would mask the
// scope-gate behavior these tests are validating.
const laravelCtx = (files: readonly ChangedFileInput[]) => ctxFor(files, ["laravel"]);
const railsCtx = (files: readonly ChangedFileInput[]) => ctxFor(files, ["rails"]);
const djangoCtx = (files: readonly ChangedFileInput[]) => ctxFor(files, ["django"]);
const sequelizeCtx = (files: readonly ChangedFileInput[]) => ctxFor(files, ["sequelize"]);
const typeormCtx = (files: readonly ChangedFileInput[]) => ctxFor(files, ["typeorm"]);
const noFrameworkCtx = (files: readonly ChangedFileInput[]) => ctxFor(files, []);

// =============================================================================
// DANGER_TERM_SMOKE_CASES — all-term smoke matrix
//
// One row per entry in MIGRATION_DANGER_TERMS. Each row asserts:
//   expect(result.results.some((r) => r.id === `migration.danger-term.${id}`)).toBe(true)
//
// Lines deliberately use realistic syntax for the ecosystem
// (Schema::dropTable for Laravel, drop_table for Rails, etc.) and
// paths are realistic per the path-classifier scope rules added in
// Step 6 file 3b (django.migrations, sequelize.migrations,
// typeorm.migrations). No contrived `database/migrations/foo.py +
// ["laravel"]` hacks.
//
// Coexisting matches on the same line (e.g., `DROP TABLE users
// CASCADE;` fires BOTH sql.drop-table and sql.cascade) are fine — the
// `some()` assertion only checks that the targeted id appears in the
// result set; other firings coexist.
//
// Term-section counts: 10 SQL keywords + 4 SQL idiom patterns +
// 4 Laravel Schema methods + 3 Laravel Artisan commands + 9 Rails +
// 5 Django + 6 Sequelize/TypeORM = 41 total entries.
// =============================================================================

interface DangerTermSmokeCase {
  readonly id: string;
  readonly path: string;
  readonly frameworks: readonly string[];
  readonly line: string;
}

const DANGER_TERM_SMOKE_CASES: readonly DangerTermSmokeCase[] = [
  // ---- SQL keywords (10 terms, universal — Laravel migration path) ----
  {
    id: "sql.drop-table",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "DROP TABLE users;",
  },
  {
    id: "sql.drop-column",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "ALTER TABLE users DROP COLUMN email;",
  },
  {
    id: "sql.drop-database",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "DROP DATABASE myapp;",
  },
  {
    id: "sql.drop-index",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "DROP INDEX idx_users_email;",
  },
  {
    id: "sql.drop-constraint",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "ALTER TABLE users DROP CONSTRAINT fk_user;",
  },
  {
    id: "sql.truncate",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "TRUNCATE TABLE users;",
  },
  {
    id: "sql.delete-from",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "DELETE FROM users WHERE id = 1;",
  },
  {
    id: "sql.rename-table",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "RENAME TABLE users TO accounts;",
  },
  {
    id: "sql.rename-column",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "ALTER TABLE users RENAME COLUMN x TO y;",
  },
  {
    id: "sql.cascade",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "DROP TABLE users CASCADE;",
  },

  // ---- SQL idiom patterns (4 terms) ----
  {
    id: "sql.alter-table-drop",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "ALTER TABLE users DROP COLUMN x;",
  },
  {
    id: "laravel.unsigned-change",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "$table->unsignedBigInteger('user_id')->change();",
  },
  {
    id: "rails.execute-drop",
    path: "db/migrate/20260101000000_drop.rb",
    frameworks: ["rails"],
    line: '    execute "DROP TABLE old_users"',
  },
  {
    id: "django.runsql-drop",
    path: "accounts/migrations/0001_drop.py",
    frameworks: ["django"],
    line: '    migrations.RunSQL("DROP TABLE old")',
  },

  // ---- Laravel Schema builder methods (4 terms, .php) ----
  {
    id: "laravel.drop-table",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "        Schema::dropTable('users');",
  },
  {
    id: "laravel.drop-column",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "        $table->dropColumn('email');",
  },
  {
    id: "laravel.drop-foreign",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "        $table->dropForeign(['user_id']);",
  },
  {
    id: "laravel.truncate",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "        $model->truncate();",
  },

  // ---- Laravel Artisan commands (3 terms, .php, case-sensitive) ----
  {
    id: "laravel.migrate-fresh",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "        Artisan::call('migrate:fresh');",
  },
  {
    id: "laravel.db-reset",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "        Artisan::call('db:reset');",
  },
  {
    id: "laravel.db-drop",
    path: "database/migrations/2026_01_01_drop.php",
    frameworks: ["laravel"],
    line: "        Artisan::call('db:drop');",
  },

  // ---- Rails (9 terms, .rb) ----
  {
    id: "rails.drop-table",
    path: "db/migrate/20260101000000_drop.rb",
    frameworks: ["rails"],
    line: "    drop_table :users",
  },
  {
    id: "rails.remove-column",
    path: "db/migrate/20260101000000_drop.rb",
    frameworks: ["rails"],
    line: "    remove_column :users, :email",
  },
  {
    id: "rails.remove-index",
    path: "db/migrate/20260101000000_drop.rb",
    frameworks: ["rails"],
    line: "    remove_index :users, :email",
  },
  {
    id: "rails.remove-foreign-key",
    path: "db/migrate/20260101000000_drop.rb",
    frameworks: ["rails"],
    line: "    remove_foreign_key :users, :accounts",
  },
  {
    id: "rails.remove-reference",
    path: "db/migrate/20260101000000_drop.rb",
    frameworks: ["rails"],
    line: "    remove_reference :users, :account",
  },
  {
    id: "rails.rename-table",
    path: "db/migrate/20260101000000_drop.rb",
    frameworks: ["rails"],
    line: "    rename_table :users, :accounts",
  },
  {
    id: "rails.rename-column",
    path: "db/migrate/20260101000000_drop.rb",
    frameworks: ["rails"],
    line: "    rename_column :users, :email, :primary_email",
  },
  {
    id: "rails.change-column",
    path: "db/migrate/20260101000000_drop.rb",
    frameworks: ["rails"],
    line: "    change_column :users, :email, :text",
  },
  {
    id: "rails.change-table",
    path: "db/migrate/20260101000000_drop.rb",
    frameworks: ["rails"],
    line: "    change_table :users do |t|",
  },

  // ---- Django (5 terms, .py) ----
  {
    id: "django.delete-model",
    path: "accounts/migrations/0001_drop.py",
    frameworks: ["django"],
    line: "        migrations.DeleteModel(name='User'),",
  },
  {
    id: "django.remove-field",
    path: "accounts/migrations/0001_drop.py",
    frameworks: ["django"],
    line: "        migrations.RemoveField(model_name='user', name='email'),",
  },
  {
    id: "django.alter-field",
    path: "accounts/migrations/0001_drop.py",
    frameworks: ["django"],
    line: "        migrations.AlterField(model_name='user', name='email', field=models.TextField()),",
  },
  {
    id: "django.rename-field",
    path: "accounts/migrations/0001_drop.py",
    frameworks: ["django"],
    line: "        migrations.RenameField(model_name='user', old_name='email', new_name='primary_email'),",
  },
  {
    id: "django.rename-model",
    path: "accounts/migrations/0001_drop.py",
    frameworks: ["django"],
    line: "        migrations.RenameModel(old_name='User', new_name='Account'),",
  },

  // ---- Sequelize/TypeORM (6 terms, .ts under [sequelize]) ----
  {
    id: "sequelize.drop-table",
    path: "migrations/2026-01-01-drop.ts",
    frameworks: ["sequelize"],
    line: "        await queryInterface.dropTable('users');",
  },
  {
    id: "sequelize.remove-column",
    path: "migrations/2026-01-01-drop.ts",
    frameworks: ["sequelize"],
    line: "        await queryInterface.removeColumn('users', 'email');",
  },
  {
    id: "sequelize.remove-foreign-key",
    path: "migrations/2026-01-01-drop.ts",
    frameworks: ["sequelize"],
    line: "        await queryInterface.removeForeignKey('users', 'fk_user');",
  },
  {
    id: "sequelize.remove-index",
    path: "migrations/2026-01-01-drop.ts",
    frameworks: ["sequelize"],
    line: "        await queryInterface.removeIndex('users', 'idx_email');",
  },
  {
    id: "sequelize.rename-column",
    path: "migrations/2026-01-01-drop.ts",
    frameworks: ["sequelize"],
    line: "        await queryInterface.renameColumn('users', 'email', 'primary_email');",
  },
  {
    id: "sequelize.rename-table",
    path: "migrations/2026-01-01-drop.ts",
    frameworks: ["sequelize"],
    line: "        await queryInterface.renameTable('users', 'accounts');",
  },
];

// =============================================================================
// SECTION 1: scope gate — database-category files only
// =============================================================================

describe("migrationsCheck — scope gate (database-category files only)", () => {
  it("non-DB file (no path-classifier match) → 0 findings", () => {
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("src/utils/helper.ts", [
          { line: 1, text: "// DROP TABLE users; -- comment in random file" },
        ]),
      ]),
    );
    expect(result.results).toEqual([]);
  });

  it("DB-shaped path but no matching framework detected → 0 findings (framework gate)", () => {
    const result = runChecks(
      [migrationsCheck],
      noFrameworkCtx([
        withAddedLines("database/migrations/2026_01_01_drop.php", [
          { line: 1, text: "Schema::dropTable('users');" },
        ]),
      ]),
    );
    expect(result.results).toEqual([]);
  });

  it("binary DB file → 0 findings (early skip)", () => {
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([binaryFile("database/migrations/2026_01_01_drop.php")]),
    );
    expect(result.results).toEqual([]);
  });

  it("empty addedLines on a DB file → 0 findings (early skip)", () => {
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([pathOnly("database/migrations/2026_01_01_drop.php")]),
    );
    expect(result.results).toEqual([]);
  });
});

// =============================================================================
// SECTION 2: Rule 1 — all-term smoke matrix (data-layer coverage)
// =============================================================================

describe("migrationsCheck — Rule 1: all-term smoke matrix", () => {
  it("smoke matrix covers every term id in MIGRATION_DANGER_TERMS", () => {
    // Meta-coverage: every term in MIGRATION_DANGER_TERMS has a row
    // in DANGER_TERM_SMOKE_CASES. Adding a term without coverage —
    // OR renaming a term id without updating the matrix — fails
    // immediately. Drift guard.
    const smokeIds = new Set(DANGER_TERM_SMOKE_CASES.map((c) => c.id));
    const dataIds = new Set(MIGRATION_DANGER_TERMS.map((t) => t.id));
    expect([...smokeIds].sort()).toEqual([...dataIds].sort());
  });

  it.each(DANGER_TERM_SMOKE_CASES)("$id fires on representative line under $frameworks", ({
    id,
    path,
    frameworks,
    line,
  }) => {
    const file = withAddedLines(path, [{ line: 1, text: line }]);
    const result = runChecks([migrationsCheck], ctxFor([file], frameworks));
    expect(
      result.results.some((r) => r.id === `migration.danger-term.${id}`),
      `Expected term '${id}' to fire on '${line}' (path '${path}', frameworks ${JSON.stringify(frameworks)})`,
    ).toBe(true);
  });
});

// =============================================================================
// SECTION 3: sql.truncate vs laravel.truncate lookahead lock (B locked)
// =============================================================================

describe("migrationsCheck — sql.truncate negative-lookahead lock", () => {
  it("A: 'TRUNCATE TABLE users;' (no parens) → sql.truncate fires", () => {
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("database/migrations/2026_01_01_drop.php", [
          { line: 5, text: "TRUNCATE TABLE users;" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sql.truncate")).toBe(true);
  });

  it("B (MANDATORY): '$model->truncate();' → ONLY laravel.truncate fires, NOT sql.truncate", () => {
    // The flagship lookahead-lock regression test. Pre-lookahead-fix,
    // `\bTRUNCATE\b/i` would match `truncate` even when immediately
    // followed by `(`, producing BOTH laravel.truncate AND sql.truncate
    // on the same line. Post-fix (negative lookahead `(?!\s*\()`),
    // sql.truncate is suppressed when the next non-space char is `(`.
    //
    // The exact-one-finding-for-sql.truncate=false assertion is the
    // regression lock. If someone removes the lookahead, this fails.
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("database/migrations/2026_01_01_drop.php", [
          { line: 5, text: "        $model->truncate();" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.laravel.truncate")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sql.truncate")).toBe(false);
  });

  it("bare 'truncate();' (no '->' prefix, no TABLE follow) → NEITHER rule fires", () => {
    // laravel.truncate requires the `->truncate` literal prefix
    // (substring includes "->"). sql.truncate's lookahead skips the
    // `(` form. So a bare `truncate()` matches NEITHER rule.
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("database/migrations/2026_01_01_drop.php", [
          { line: 5, text: "truncate();" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.laravel.truncate")).toBe(
      false,
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sql.truncate")).toBe(false);
  });
});

// =============================================================================
// SECTION 4: extension scoping (C, D locked)
// =============================================================================

describe("migrationsCheck — fileExtensions scoping (cross-ecosystem identifier disambiguation)", () => {
  it("C: Laravel .php with 'dropTable' → ONLY laravel.drop-table, NOT sequelize.drop-table", () => {
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("database/migrations/2026_01_01_drop.php", [
          { line: 5, text: "        Schema::dropTable('users');" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.laravel.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      false,
    );
  });

  it("D: Sequelize .ts with 'dropTable' under [sequelize] → ONLY sequelize.drop-table, NOT laravel.drop-table", () => {
    const result = runChecks(
      [migrationsCheck],
      sequelizeCtx([
        withAddedLines("migrations/2026-01-01-drop.ts", [
          { line: 5, text: "        await queryInterface.dropTable('users');" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.laravel.drop-table")).toBe(
      false,
    );
  });

  it("TypeORM .ts with 'dropTable' under [typeorm] → ONLY sequelize.drop-table (shared term), NOT laravel.drop-table", () => {
    // The danger term is labeled "Sequelize/TypeORM dropTable" and
    // applies to both ecosystems' JS/TS files. Under [typeorm], the
    // typeorm.migrations rule classifies the path, then the
    // sequelize.drop-table term fires because its fileExtensions
    // (.js/.ts/.mjs/.cjs) include .ts. laravel.drop-table is
    // restricted to .php.
    const result = runChecks(
      [migrationsCheck],
      typeormCtx([
        withAddedLines("migrations/2026-01-01-drop.ts", [
          { line: 5, text: "        await queryInterface.dropTable('users');" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.laravel.drop-table")).toBe(
      false,
    );
  });

  it("Laravel Artisan command 'MIGRATE:FRESH' (uppercase) → does NOT match laravel.migrate-fresh (case-sensitive)", () => {
    // Locks the case-sensitivity rule for Laravel Artisan commands.
    // The term needle is "migrate:fresh" (lowercase) with
    // caseInsensitive: false. Uppercase variants are not valid
    // Artisan commands and would just produce noise.
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("database/migrations/2026_01_01_drop.php", [
          { line: 5, text: "        Artisan::call('MIGRATE:FRESH');" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.laravel.migrate-fresh")).toBe(
      false,
    );
  });
});

// =============================================================================
// SECTION 5: Rule 2 — missing-down positive (no down() = fire)
// =============================================================================

describe("migrationsCheck — Rule 2: missing-down positive (new + destructive + no down() = fire)", () => {
  it("new Laravel migration with DROP TABLE + no down() → missing-down fires", () => {
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("database/migrations/2026_01_01_drop.php", [
          { line: 5, text: "    public function up(): void" },
          { line: 6, text: "    {" },
          { line: 7, text: "        Schema::dropTable('users');" },
          { line: 8, text: "    }" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.laravel.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(true);
  });

  it("new Rails migration with drop_table + no def down → missing-down fires (RAILS COVERAGE)", () => {
    // Locked Rails coverage per the user's explicit instruction —
    // .rb is in MISSING_DOWN_FILE_EXTENSIONS and DOWN_METHOD_PATTERNS
    // has Ruby-specific branches, so Rails MUST have positive
    // missing-down coverage symmetric with Laravel.
    const result = runChecks(
      [migrationsCheck],
      railsCtx([
        withAddedLines("db/migrate/20260101000000_drop.rb", [
          { line: 1, text: "class DropUsers < ActiveRecord::Migration[7.1]" },
          { line: 2, text: "  def change" },
          { line: 3, text: "    drop_table :users" },
          { line: 4, text: "  end" },
          { line: 5, text: "end" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.rails.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(true);
  });

  it("new Sequelize .ts migration with dropTable + no down() → missing-down fires", () => {
    const result = runChecks(
      [migrationsCheck],
      sequelizeCtx([
        withAddedLines("migrations/2026-01-01-drop.ts", [
          { line: 1, text: "export const up = async (queryInterface) => {" },
          { line: 2, text: "  await queryInterface.dropTable('users');" },
          { line: 3, text: "};" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(true);
  });
});

// =============================================================================
// SECTION 6: Rule 2 — missing-down cancellation by down() shape
// =============================================================================

describe("migrationsCheck — Rule 2: missing-down cancellation (down() definitions/exports cancel)", () => {
  it("K: Laravel 'public function down(): void {' cancels missing-down", () => {
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("database/migrations/2026_01_01_drop.php", [
          { line: 5, text: "    public function up(): void { Schema::dropTable('users'); }" },
          { line: 7, text: "    public function down(): void" },
          { line: 8, text: "    {" },
          { line: 9, text: "        Schema::create('users', fn($t) => $t->id());" },
          { line: 10, text: "    }" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.laravel.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("L: Rails 'def down' cancels missing-down (RAILS COVERAGE)", () => {
    // Locked Rails coverage. `def down` is the standard Rails
    // reverse-migration method definition. Matched by
    // DOWN_METHOD_PATTERNS Ruby branch `^\s*def\s+(?:self\.)?down\b`.
    const result = runChecks(
      [migrationsCheck],
      railsCtx([
        withAddedLines("db/migrate/20260101000000_drop.rb", [
          { line: 1, text: "class DropUsers < ActiveRecord::Migration[7.1]" },
          { line: 2, text: "  def up" },
          { line: 3, text: "    drop_table :users" },
          { line: 4, text: "  end" },
          { line: 6, text: "  def down" },
          { line: 7, text: "    create_table :users do |t|" },
          { line: 8, text: "      t.string :email" },
          { line: 9, text: "    end" },
          { line: 10, text: "  end" },
          { line: 11, text: "end" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.rails.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("Rails 'def self.down' cancels missing-down (RAILS COVERAGE — class-method form)", () => {
    const result = runChecks(
      [migrationsCheck],
      railsCtx([
        withAddedLines("db/migrate/20260101000000_drop.rb", [
          { line: 1, text: "class DropUsers < ActiveRecord::Migration[5.0]" },
          { line: 2, text: "  def self.up" },
          { line: 3, text: "    drop_table :users" },
          { line: 4, text: "  end" },
          { line: 6, text: "  def self.down" },
          { line: 7, text: "    create_table :users" },
          { line: 8, text: "  end" },
          { line: 9, text: "end" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.rails.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("Sequelize/TS class method 'async down(qi): Promise<void> {' cancels missing-down", () => {
    const result = runChecks(
      [migrationsCheck],
      sequelizeCtx([
        withAddedLines("migrations/2026-01-01-drop.ts", [
          { line: 1, text: "export class DropUsers1700000000000 {" },
          { line: 2, text: "  public async up(queryInterface: QueryInterface): Promise<void> {" },
          { line: 3, text: "    await queryInterface.dropTable('users');" },
          { line: 4, text: "  }" },
          { line: 6, text: "  public async down(queryInterface: QueryInterface): Promise<void> {" },
          { line: 7, text: "    await queryInterface.createTable('users', {});" },
          { line: 8, text: "  }" },
          { line: 9, text: "}" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("Sequelize object property 'down: async function (qi) {' cancels missing-down", () => {
    const result = runChecks(
      [migrationsCheck],
      sequelizeCtx([
        withAddedLines("migrations/2026-01-01-drop.js", [
          { line: 1, text: "module.exports = {" },
          { line: 2, text: "  up: async function (queryInterface) {" },
          { line: 3, text: "    await queryInterface.dropTable('users');" },
          { line: 4, text: "  }," },
          { line: 5, text: "  down: async function (queryInterface) {" },
          { line: 6, text: "    await queryInterface.createTable('users', {});" },
          { line: 7, text: "  }," },
          { line: 8, text: "};" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("Sequelize object property 'down: async (qi) => {' cancels missing-down", () => {
    const result = runChecks(
      [migrationsCheck],
      sequelizeCtx([
        withAddedLines("migrations/2026-01-01-drop.js", [
          { line: 1, text: "module.exports = {" },
          { line: 2, text: "  up: async (queryInterface) => {" },
          { line: 3, text: "    await queryInterface.dropTable('users');" },
          { line: 4, text: "  }," },
          { line: 5, text: "  down: async (queryInterface) => {" },
          { line: 6, text: "    await queryInterface.createTable('users', {});" },
          { line: 7, text: "  }," },
          { line: 8, text: "};" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("H: 'module.exports.down = async (qi) => ...' cancels missing-down (CommonJS export pattern)", () => {
    const result = runChecks(
      [migrationsCheck],
      sequelizeCtx([
        withAddedLines("migrations/2026-01-01-drop.js", [
          { line: 1, text: "module.exports.up = async (queryInterface) => {" },
          { line: 2, text: "  await queryInterface.dropTable('users');" },
          { line: 3, text: "};" },
          { line: 5, text: "module.exports.down = async (queryInterface) => {" },
          { line: 6, text: "  await queryInterface.createTable('users', {});" },
          { line: 7, text: "};" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("'exports.down = function () {' cancels missing-down (CommonJS individual export variant)", () => {
    const result = runChecks(
      [migrationsCheck],
      sequelizeCtx([
        withAddedLines("migrations/2026-01-01-drop.js", [
          { line: 1, text: "exports.up = function (queryInterface) {" },
          { line: 2, text: "  return queryInterface.dropTable('users');" },
          { line: 3, text: "};" },
          { line: 5, text: "exports.down = function (queryInterface) {" },
          { line: 6, text: "  return queryInterface.createTable('users', {});" },
          { line: 7, text: "};" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("I: 'export const down = async (qi) => ...' cancels missing-down (ES module const arrow)", () => {
    const result = runChecks(
      [migrationsCheck],
      sequelizeCtx([
        withAddedLines("migrations/2026-01-01-drop.ts", [
          { line: 1, text: "export const up = async (queryInterface) => {" },
          { line: 2, text: "  await queryInterface.dropTable('users');" },
          { line: 3, text: "};" },
          { line: 5, text: "export const down = async (queryInterface) => {" },
          { line: 6, text: "  await queryInterface.createTable('users', {});" },
          { line: 7, text: "};" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("J: 'export async function down(qi) {' cancels missing-down (ES module named function export)", () => {
    const result = runChecks(
      [migrationsCheck],
      sequelizeCtx([
        withAddedLines("migrations/2026-01-01-drop.ts", [
          { line: 1, text: "export async function up(queryInterface) {" },
          { line: 2, text: "  await queryInterface.dropTable('users');" },
          { line: 3, text: "}" },
          { line: 5, text: "export async function down(queryInterface) {" },
          { line: 6, text: "  await queryInterface.createTable('users', {});" },
          { line: 7, text: "}" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("'export function down(qi) {' cancels missing-down (sync ES module named function export)", () => {
    const result = runChecks(
      [migrationsCheck],
      sequelizeCtx([
        withAddedLines("migrations/2026-01-01-drop.js", [
          { line: 1, text: "export function up(queryInterface) {" },
          { line: 2, text: "  return queryInterface.dropTable('users');" },
          { line: 3, text: "}" },
          { line: 5, text: "export function down(queryInterface) {" },
          { line: 6, text: "  return queryInterface.createTable('users', {});" },
          { line: 7, text: "}" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });
});

// =============================================================================
// SECTION 7: Rule 2 — missing-down comment-safe (G locked)
// =============================================================================

describe("migrationsCheck — Rule 2: missing-down comment-safe (anchored-pattern lock)", () => {
  it("G: '// TODO add function down()' comment does NOT cancel missing-down", () => {
    // The flagship anchored-pattern regression test. Pre-anchor,
    // unanchored `\bfunction\s+down\s*\(` would match the comment
    // text and falsely cancel missing-down. Post-anchor (`^\s*...`),
    // lines starting with `//` don't match the definition shape.
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("database/migrations/2026_01_01_drop.php", [
          { line: 5, text: "    // TODO add function down()" },
          { line: 7, text: "    public function up(): void { Schema::dropTable('users'); }" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.laravel.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(true);
  });

  it("'// down() {' comment does NOT cancel missing-down", () => {
    const result = runChecks(
      [migrationsCheck],
      sequelizeCtx([
        withAddedLines("migrations/2026-01-01-drop.ts", [
          { line: 1, text: "// down() { ... } -- not implemented yet" },
          { line: 2, text: "export const up = async (qi) => {" },
          { line: 3, text: "  await qi.dropTable('users');" },
          { line: 4, text: "};" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sequelize.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(true);
  });

  it("'    # def down' comment (Ruby-style) does NOT cancel missing-down (RAILS COVERAGE)", () => {
    // Rails-equivalent of G. `# def down` Ruby comment must not
    // false-cancel.
    const result = runChecks(
      [migrationsCheck],
      railsCtx([
        withAddedLines("db/migrate/20260101000000_drop.rb", [
          { line: 1, text: "class DropUsers < ActiveRecord::Migration[7.1]" },
          { line: 2, text: "  # def down — TODO" },
          { line: 3, text: "  def up" },
          { line: 4, text: "    drop_table :users" },
          { line: 5, text: "  end" },
          { line: 6, text: "end" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.rails.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(true);
  });
});

// =============================================================================
// SECTION 8: Rule 2 — missing-down extension / exclusion / status gates
// =============================================================================

describe("migrationsCheck — Rule 2: missing-down extension/exclusion/status gates", () => {
  it("E: raw .sql with 'DROP TABLE users;' → danger-term fires, NO missing-down (positive-ext gate)", () => {
    // .sql is NOT in MISSING_DOWN_FILE_EXTENSIONS (raw SQL has no
    // down() method concept). The danger-term fires; missing-down is
    // skipped because the positive extension gate fails.
    //
    // Path satisfies the laravel.migrations rule (pattern
    // `database/migrations/**` matches any extension) when
    // framework=[laravel] is present.
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("database/migrations/2026_01_01_drop.sql", [
          { line: 1, text: "DROP TABLE users;" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sql.drop-table")).toBe(true);
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("F: Django .py with 'migrations.RunSQL(\"DROP TABLE users\")' → danger-term fires, NO missing-down", () => {
    // .py is NOT in MISSING_DOWN_FILE_EXTENSIONS AND the path
    // `**/migrations/*.py` is in MISSING_DOWN_EXCLUDED_FILE_PATTERNS
    // (defense-in-depth Django exclusion). Both gates protect.
    const result = runChecks(
      [migrationsCheck],
      djangoCtx([
        withAddedLines("accounts/migrations/0001_drop.py", [
          { line: 5, text: '        migrations.RunSQL("DROP TABLE users"),' },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.django.runsql-drop")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("M: MODIFIED Laravel migration with DROP + no down() → danger-term fires, NO missing-down (status gate)", () => {
    // status: "modified" fails the status === "added" gate. The
    // file may already contain down() in unchanged lines not visible
    // in addedLines; emitting missing-down here would be a false
    // positive. Documented in migrations.ts file header.
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withStatus("database/migrations/2026_01_01_drop.php", "modified", [
          { line: 7, text: "        Schema::dropTable('users');" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.laravel.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });

  it("MODIFIED Rails migration with drop_table + no def down → danger-term fires, NO missing-down (RAILS COVERAGE — status gate)", () => {
    // Locked Rails coverage per the user's explicit instruction.
    // Symmetric with the Laravel modified case above.
    const result = runChecks(
      [migrationsCheck],
      railsCtx([
        withStatus("db/migrate/20260101000000_drop.rb", "modified", [
          { line: 3, text: "    drop_table :users" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.rails.drop-table")).toBe(
      true,
    );
    expect(result.results.some((r) => r.id === "migration.missing-down")).toBe(false);
  });
});

// =============================================================================
// SECTION 9: edge cases
// =============================================================================

describe("migrationsCheck — edge cases", () => {
  it("Windows backslash path (database\\\\migrations\\\\drop.php) → evidence.file normalized to POSIX", () => {
    // Locks the normalizePathSeparators discipline end-to-end. A
    // backslash-shaped path normalizes through to evidence.file
    // (else CheckResultSchema's safeStoredRelativePath would reject
    // the finding via D28 layer-2 validation).
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("database\\migrations\\2026_01_01_drop.php", [
          { line: 5, text: "        Schema::dropTable('users');" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.laravel.drop-table")).toBe(
      true,
    );
    const finding = result.results.find((r) => r.id === "migration.danger-term.laravel.drop-table");
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.evidence[0]?.file).toBe("database/migrations/2026_01_01_drop.php");
    expect(finding.evidence[0]?.file).not.toContain("\\");
  });

  it("multiple distinct danger terms on the SAME line → multiple findings (one per term)", () => {
    // `DROP TABLE users CASCADE;` fires BOTH sql.drop-table (substring
    // "DROP TABLE") AND sql.cascade (word-bounded regex). Each emits
    // its own finding.
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("database/migrations/2026_01_01_drop.php", [
          { line: 5, text: "DROP TABLE users CASCADE;" },
        ]),
      ]),
    );
    expect(result.results.some((r) => r.id === "migration.danger-term.sql.drop-table")).toBe(true);
    expect(result.results.some((r) => r.id === "migration.danger-term.sql.cascade")).toBe(true);
  });

  it("same danger term on MULTIPLE lines → multiple findings (one per line)", () => {
    // sql.drop-table on lines 5 and 8 emits 2 separate findings
    // (different evidence[0].line keeps D40 dedup tuples distinct).
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("database/migrations/2026_01_01_drop.php", [
          { line: 5, text: "DROP TABLE users;" },
          { line: 8, text: "DROP TABLE accounts;" },
        ]),
      ]),
    );
    const dropTableFindings = result.results.filter(
      (r) => r.id === "migration.danger-term.sql.drop-table",
    );
    expect(dropTableFindings).toHaveLength(2);
    const lines = dropTableFindings.map((r) => r.evidence[0]?.line).sort();
    expect(lines).toEqual([5, 8]);
  });

  it("non-DB file with DROP TABLE in code → 0 findings (scope gate filters first; doesn't even scan)", () => {
    // Defense-in-depth: the scope gate is the FIRST check inside the
    // per-file loop. A random source file with destructive-looking
    // content never reaches the danger-term scan.
    const result = runChecks(
      [migrationsCheck],
      laravelCtx([
        withAddedLines("src/dashboard/QueryBuilder.tsx", [
          { line: 42, text: "const sql = 'DROP TABLE ' + tableName + ';';" },
        ]),
      ]),
    );
    expect(result.results).toEqual([]);
  });
});
