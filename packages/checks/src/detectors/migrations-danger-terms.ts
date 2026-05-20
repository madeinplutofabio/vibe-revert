// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Data layer for the migration content detector (M C Step 6 file 1).
//
// =============================================================================
// THREE TERM CATEGORIES
// =============================================================================
//
//   1. SQL KEYWORDS (case-insensitive substring or word-bounded regex)
//      — standard SQL DDL/DML that destructively modifies schema or data.
//      Most are plain substrings (multi-word terms like `DROP TABLE` are
//      already specific). TRUNCATE and CASCADE use word-bounded regex
//      because bare substring matches noisy code like `truncate_log` or
//      `cssCascade`.
//
//   2. SQL IDIOM PATTERNS (regex with /i) — SQL idioms that span
//      variable whitespace or contain keyword sequences (e.g.
//      `ALTER TABLE ... DROP` needs regex to match across the variable
//      middle).
//
//   3. FRAMEWORK FUNCTION/METHOD/COMMAND NAMES (case-SENSITIVE
//      substring) — framework-idiomatic migration APIs (Schema-builder
//      methods, ORM helpers) AND framework command names (Laravel
//      Artisan `migrate:fresh` etc.). Case-sensitive because these
//      are language/CLI tokens (Ruby `drop_table` != `Drop_Table`;
//      JS `dropTable` != `droptable`; Laravel `migrate:fresh` is the
//      literal lowercase Artisan command — `MIGRATE:FRESH` is not a
//      valid command reference and matching it would add noise).
//
// =============================================================================
// FILE-EXTENSION SCOPING (data-level, not detector-side)
// =============================================================================
//
// Multiple ecosystems use the same identifier (e.g., `dropTable` is
// both a Laravel Schema-builder method AND a Sequelize/TypeORM
// query-interface method). Without scoping, a single line would emit
// two findings — one per ecosystem — because the D40 dedup tuple
// differs by `id`.
//
// `fileExtensions?: readonly string[]` on each DangerTerm carries
// the scope at the data layer. When defined, the term applies ONLY
// to files whose extension is in the list. When undefined, applies
// to ALL database-category files (used for vendor-agnostic SQL terms).
//
// Locked extension assignments:
//   - SQL keywords + sql.alter-table-drop: no scope (universal SQL)
//   - laravel.* terms (Schema builder + Artisan commands): [".php"]
//   - rails.* terms:     [".rb"]
//   - django.* terms:    [".py"]
//   - sequelize.* terms: [".js", ".ts", ".mjs", ".cjs"]
//
// Extension matching is case-sensitive per the M C convention (D32:
// Linux is the source of truth; case-insensitive matching would
// create false positives on case-sensitive filesystems).
//
// =============================================================================
// MISSING-DOWN DETECTION (consumed by migrations.ts)
// =============================================================================
//
// DOWN_METHOD_PATTERNS match a `down` callable definition or export
// on a line. The missing-down rule in migrations.ts fires ONLY when
// ALL of:
//   - file.status === "added" (brand-new migration — full file content
//     is in addedLines, so absence of down() there reliably means
//     absence in the file)
//   - file.path extension is in MISSING_DOWN_FILE_EXTENSIONS (the
//     POSITIVE scope of ecosystems that actually use a `down()`
//     method convention — Laravel, Rails, Sequelize/TypeORM)
//   - file.path does NOT match any MISSING_DOWN_EXCLUDED_FILE_PATTERNS
//     glob (defense-in-depth exclusion for ecosystems with no `down()`
//     concept, currently Django — even if `.py` later joins
//     MISSING_DOWN_FILE_EXTENSIONS for a non-Django Python ecosystem,
//     the path-specific exclusion still protects Django)
//   - at least one danger term matched
//   - no DOWN_METHOD_PATTERNS pattern matched any added line
//
// The positive-extension gate (MISSING_DOWN_FILE_EXTENSIONS) prevents
// false positives on file types that have no `down()` method
// convention at all: raw `.sql` migrations, `.py` migrations
// (Django/Alembic), `.java` migrations (Flyway), etc. A danger term
// in such a file emits a danger-term finding but NOT a missing-down
// finding.
//
// For status === "modified" files the missing-down rule is NOT
// evaluated (the file may already contain down() in unchanged lines
// not visible in addedLines — emitting missing-down here would be a
// false positive). Documented in migrations.ts file header.
//
// DOWN_METHOD_PATTERNS are LINE-ANCHORED (`^\s*...`) to avoid false-
// cancel on commented-out mentions like `// TODO add function down()`
// or `// down() {` — comments start with `//` which doesn't match
// `\s*` followed by a definition/export-shape keyword.

/**
 * Discriminated union for danger-term match strategies.
 *
 * - "substring": plain substring search. `caseInsensitive` flag picks
 *   case-sensitive (framework language tokens, Laravel Artisan
 *   commands) vs case-insensitive (SQL keywords).
 * - "regex": pre-compiled RegExp. Patterns MUST be stateless under
 *   `.test()` — no /g flag (danger-term detection uses one-shot test
 *   per added line per term, not iteration).
 */
export type DangerTermMatch =
  | { readonly kind: "substring"; readonly needle: string; readonly caseInsensitive: boolean }
  | { readonly kind: "regex"; readonly pattern: RegExp };

/**
 * A locked migration danger term. Each entry can produce a high-level
 * `migration.danger-term.<id>` finding when its `match` fires on an
 * added line of a database-category file whose extension is in
 * `fileExtensions` (or unrestricted if `fileExtensions` is omitted).
 *
 * `fileExtensions`: includes the leading dot, e.g. `".php"`, matched
 * case-sensitively against the file's extension. Undefined means
 * the term applies to all database-category files (used for SQL
 * keywords / idioms that are vendor-agnostic).
 */
export interface DangerTerm {
  readonly id: string;
  readonly description: string;
  readonly match: DangerTermMatch;
  readonly fileExtensions?: readonly string[];
}

/**
 * The locked migration danger-term list (D35). Adding a term requires
 * extending the appropriate section, setting the correct
 * `fileExtensions` scope, AND adding positive + negative unit tests
 * in migrations.test.ts.
 */
export const MIGRATION_DANGER_TERMS: readonly DangerTerm[] = [
  // -------------------------------------------------------------------
  // 1. SQL keywords (mostly case-insensitive substring; TRUNCATE +
  //    CASCADE use word-bounded regex to avoid noise on identifiers
  //    like `truncate_log`, `cascadeBtn`, `cssCascade`)
  //    No fileExtensions — vendor-agnostic SQL, applies to any
  //    database-category file (PHP, Ruby, Python, JS, TS, raw .sql).
  // -------------------------------------------------------------------
  {
    id: "sql.drop-table",
    description: "SQL DROP TABLE",
    match: { kind: "substring", needle: "DROP TABLE", caseInsensitive: true },
  },
  {
    id: "sql.drop-column",
    description: "SQL DROP COLUMN",
    match: { kind: "substring", needle: "DROP COLUMN", caseInsensitive: true },
  },
  {
    id: "sql.drop-database",
    description: "SQL DROP DATABASE",
    match: { kind: "substring", needle: "DROP DATABASE", caseInsensitive: true },
  },
  {
    id: "sql.drop-index",
    description: "SQL DROP INDEX",
    match: { kind: "substring", needle: "DROP INDEX", caseInsensitive: true },
  },
  {
    id: "sql.drop-constraint",
    description: "SQL DROP CONSTRAINT",
    match: { kind: "substring", needle: "DROP CONSTRAINT", caseInsensitive: true },
  },
  // sql.truncate uses a negative lookahead `(?!\s*\()` to skip
  // method/function-call shapes like `->truncate()` or `truncate()`.
  // Those are caught separately by `laravel.truncate` (Laravel
  // Schema-builder method) when in scope. The lookahead also skips
  // Postgres's `TRUNCATE(value, length)` numerical function — that's
  // non-destructive and not what this term is meant to catch.
  {
    id: "sql.truncate",
    description: "SQL TRUNCATE",
    match: { kind: "regex", pattern: /\bTRUNCATE\b(?!\s*\()/i },
  },
  {
    id: "sql.delete-from",
    description: "SQL DELETE FROM",
    match: { kind: "substring", needle: "DELETE FROM", caseInsensitive: true },
  },
  {
    id: "sql.rename-table",
    description: "SQL RENAME TABLE",
    match: { kind: "substring", needle: "RENAME TABLE", caseInsensitive: true },
  },
  {
    id: "sql.rename-column",
    description: "SQL RENAME COLUMN",
    match: { kind: "substring", needle: "RENAME COLUMN", caseInsensitive: true },
  },
  {
    id: "sql.cascade",
    description: "SQL CASCADE",
    match: { kind: "regex", pattern: /\bCASCADE\b/i },
  },

  // -------------------------------------------------------------------
  // 2. SQL idiom patterns (regex)
  //    sql.alter-table-drop is universal (no fileExtensions);
  //    framework-flavored idioms are scoped to their language.
  // -------------------------------------------------------------------
  {
    id: "sql.alter-table-drop",
    description: "SQL ALTER TABLE ... DROP",
    match: { kind: "regex", pattern: /ALTER\s+TABLE\b[\s\S]*?\bDROP\b/i },
  },
  {
    id: "laravel.unsigned-change",
    description: "Laravel unsignedBigInteger ... change()",
    match: { kind: "regex", pattern: /unsignedBigInteger\b[\s\S]*?\bchange\s*\(/i },
    fileExtensions: [".php"],
  },
  {
    id: "rails.execute-drop",
    description: 'Rails execute "DROP ..."',
    match: { kind: "regex", pattern: /execute\s+["']\s*DROP/i },
    fileExtensions: [".rb"],
  },
  {
    id: "django.runsql-drop",
    description: 'Django RunSQL("DROP ...")',
    match: { kind: "regex", pattern: /RunSQL\s*\(\s*["']\s*DROP/i },
    fileExtensions: [".py"],
  },

  // -------------------------------------------------------------------
  // 3. Framework function/method/command names (case-SENSITIVE
  //    substring), each scoped to its language's file extensions.
  // -------------------------------------------------------------------

  // Laravel (PHP) — Schema builder methods
  {
    id: "laravel.drop-table",
    description: "Laravel dropTable()",
    match: { kind: "substring", needle: "dropTable", caseInsensitive: false },
    fileExtensions: [".php"],
  },
  {
    id: "laravel.drop-column",
    description: "Laravel dropColumn()",
    match: { kind: "substring", needle: "dropColumn", caseInsensitive: false },
    fileExtensions: [".php"],
  },
  {
    id: "laravel.drop-foreign",
    description: "Laravel dropForeign()",
    match: { kind: "substring", needle: "dropForeign", caseInsensitive: false },
    fileExtensions: [".php"],
  },
  {
    id: "laravel.truncate",
    description: "Laravel ->truncate()",
    match: { kind: "substring", needle: "->truncate", caseInsensitive: false },
    fileExtensions: [".php"],
  },

  // Laravel (PHP) — Artisan command names (typically appear in
  // programmatic Artisan::call('migrate:fresh') invocations from
  // within migrations, or as references in destructive deployment
  // workflows. Case-SENSITIVE because Artisan command names are
  // literal lowercase tokens. Scoped to .php because the migration
  // detector only operates on database-category files which are .php
  // for Laravel.)
  {
    id: "laravel.migrate-fresh",
    description: "Laravel Artisan migrate:fresh",
    match: { kind: "substring", needle: "migrate:fresh", caseInsensitive: false },
    fileExtensions: [".php"],
  },
  {
    id: "laravel.db-reset",
    description: "Laravel Artisan db:reset",
    match: { kind: "substring", needle: "db:reset", caseInsensitive: false },
    fileExtensions: [".php"],
  },
  {
    id: "laravel.db-drop",
    description: "Laravel Artisan db:drop",
    match: { kind: "substring", needle: "db:drop", caseInsensitive: false },
    fileExtensions: [".php"],
  },

  // Rails (Ruby/ActiveRecord) — migration DSL
  {
    id: "rails.drop-table",
    description: "Rails drop_table",
    match: { kind: "substring", needle: "drop_table", caseInsensitive: false },
    fileExtensions: [".rb"],
  },
  {
    id: "rails.remove-column",
    description: "Rails remove_column",
    match: { kind: "substring", needle: "remove_column", caseInsensitive: false },
    fileExtensions: [".rb"],
  },
  {
    id: "rails.remove-index",
    description: "Rails remove_index",
    match: { kind: "substring", needle: "remove_index", caseInsensitive: false },
    fileExtensions: [".rb"],
  },
  {
    id: "rails.remove-foreign-key",
    description: "Rails remove_foreign_key",
    match: { kind: "substring", needle: "remove_foreign_key", caseInsensitive: false },
    fileExtensions: [".rb"],
  },
  {
    id: "rails.remove-reference",
    description: "Rails remove_reference",
    match: { kind: "substring", needle: "remove_reference", caseInsensitive: false },
    fileExtensions: [".rb"],
  },
  {
    id: "rails.rename-table",
    description: "Rails rename_table",
    match: { kind: "substring", needle: "rename_table", caseInsensitive: false },
    fileExtensions: [".rb"],
  },
  {
    id: "rails.rename-column",
    description: "Rails rename_column",
    match: { kind: "substring", needle: "rename_column", caseInsensitive: false },
    fileExtensions: [".rb"],
  },
  {
    id: "rails.change-column",
    description: "Rails change_column",
    match: { kind: "substring", needle: "change_column", caseInsensitive: false },
    fileExtensions: [".rb"],
  },
  {
    id: "rails.change-table",
    description: "Rails change_table",
    match: { kind: "substring", needle: "change_table", caseInsensitive: false },
    fileExtensions: [".rb"],
  },

  // Django (Python) — migrations module
  {
    id: "django.delete-model",
    description: "Django migrations.DeleteModel",
    match: { kind: "substring", needle: "migrations.DeleteModel", caseInsensitive: false },
    fileExtensions: [".py"],
  },
  {
    id: "django.remove-field",
    description: "Django migrations.RemoveField",
    match: { kind: "substring", needle: "migrations.RemoveField", caseInsensitive: false },
    fileExtensions: [".py"],
  },
  {
    id: "django.alter-field",
    description: "Django migrations.AlterField",
    match: { kind: "substring", needle: "migrations.AlterField", caseInsensitive: false },
    fileExtensions: [".py"],
  },
  {
    id: "django.rename-field",
    description: "Django migrations.RenameField",
    match: { kind: "substring", needle: "migrations.RenameField", caseInsensitive: false },
    fileExtensions: [".py"],
  },
  {
    id: "django.rename-model",
    description: "Django migrations.RenameModel",
    match: { kind: "substring", needle: "migrations.RenameModel", caseInsensitive: false },
    fileExtensions: [".py"],
  },

  // Sequelize / TypeORM (JS/TS) — query-interface methods
  {
    id: "sequelize.drop-table",
    description: "Sequelize/TypeORM dropTable",
    match: { kind: "substring", needle: "dropTable", caseInsensitive: false },
    fileExtensions: [".js", ".ts", ".mjs", ".cjs"],
  },
  {
    id: "sequelize.remove-column",
    description: "Sequelize/TypeORM removeColumn",
    match: { kind: "substring", needle: "removeColumn", caseInsensitive: false },
    fileExtensions: [".js", ".ts", ".mjs", ".cjs"],
  },
  {
    id: "sequelize.remove-foreign-key",
    description: "Sequelize/TypeORM removeForeignKey",
    match: { kind: "substring", needle: "removeForeignKey", caseInsensitive: false },
    fileExtensions: [".js", ".ts", ".mjs", ".cjs"],
  },
  {
    id: "sequelize.remove-index",
    description: "Sequelize/TypeORM removeIndex",
    match: { kind: "substring", needle: "removeIndex", caseInsensitive: false },
    fileExtensions: [".js", ".ts", ".mjs", ".cjs"],
  },
  {
    id: "sequelize.rename-column",
    description: "Sequelize/TypeORM renameColumn",
    match: { kind: "substring", needle: "renameColumn", caseInsensitive: false },
    fileExtensions: [".js", ".ts", ".mjs", ".cjs"],
  },
  {
    id: "sequelize.rename-table",
    description: "Sequelize/TypeORM renameTable",
    match: { kind: "substring", needle: "renameTable", caseInsensitive: false },
    fileExtensions: [".js", ".ts", ".mjs", ".cjs"],
  },
];

// =============================================================================
// MISSING_DOWN_FILE_EXTENSIONS
// =============================================================================
//
// POSITIVE scope for the missing-down rule. The rule fires ONLY for
// files whose extension is in this list. This prevents false-positive
// missing-down findings on file types that have no `down()` method
// convention at all:
//
//   - Raw `.sql` migrations (e.g., sqitch, dbmate) — destructive
//     statements like `DROP TABLE users;` are legitimate; there is
//     no method-level rollback concept in plain SQL.
//   - `.py` migrations (Django/Alembic) — Django uses explicit
//     `RunPython` / `RunSQL` pairs bundled into a single migration,
//     not a separate down() method. Alembic uses upgrade/downgrade,
//     not down(). DOWN_METHOD_PATTERNS would never match either,
//     producing a false missing-down without this gate.
//   - `.java` migrations (Flyway) — Flyway uses paired V/U files
//     (V001__add_users.sql + U001__add_users.sql), not down() method.
//   - Any other ecosystem not in the list — silently skipped.
//
// Locked entries for v0.7.0-beta (ecosystems that DO use down()):
//   - `.php`  — Laravel
//   - `.rb`   — Rails ActiveRecord
//   - `.js`, `.ts`, `.mjs`, `.cjs` — Sequelize/TypeORM
//
// Adding a new entry here requires updating migrations.test.ts with
// a positive test confirming missing-down fires for the new ecosystem.
export const MISSING_DOWN_FILE_EXTENSIONS: readonly string[] = [
  ".php",
  ".rb",
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
];

// =============================================================================
// MISSING_DOWN_EXCLUDED_FILE_PATTERNS
// =============================================================================
//
// Glob patterns identifying file paths where the missing-down rule
// MUST NOT fire even when other conditions are met. Defense-in-depth
// exclusion: if `.py` ever joins MISSING_DOWN_FILE_EXTENSIONS for a
// non-Django Python ecosystem, this list still protects Django
// migrations from false missing-down.
//
// The missing-down rule in migrations.ts checks this list via
// picomatch (same locked options as path-classifier) and skips the
// rule for matching paths.
//
// Locked entries:
//   - `**/migrations/*.py` — Django migrations bundle forward and
//     reverse operations as explicit `migrations.RunPython` /
//     `migrations.RunSQL` pairs; there is no `down()` concept.
//     Without this exclusion (or the .py absence from
//     MISSING_DOWN_FILE_EXTENSIONS), a Django migration containing
//     `migrations.RunSQL("DROP TABLE users")` (matches the
//     `django.runsql-drop` danger term) would falsely emit
//     missing-down.
//
// Adding a new pattern here requires updating migrations.test.ts
// with a negative test confirming the exclusion fires correctly.
export const MISSING_DOWN_EXCLUDED_FILE_PATTERNS: readonly string[] = ["**/migrations/*.py"];

/**
 * Patterns matching a `down` callable definition OR export on a line,
 * anchored to line start (`^\s*`) so comments and string-literal
 * mentions never satisfy the pattern. Used by the missing-down rule
 * in migrations.ts; presence of ANY match in addedLines cancels the
 * missing-down finding for that file.
 *
 * Comment-form mentions like `// TODO add function down()` or
 * `// down() {` start with `//` (not whitespace + definition/export
 * keyword) and therefore do NOT match.
 *
 * Django is intentionally NOT covered here — its migrations don't
 * use down(); see MISSING_DOWN_FILE_EXTENSIONS (positive gate) and
 * MISSING_DOWN_EXCLUDED_FILE_PATTERNS (defense-in-depth) above for
 * the data-driven exclusion.
 *
 * Locked shapes covered:
 *   - Laravel/PHP class method:    `[public|protected|private] function down(...)`
 *   - Rails/Ruby method:           `def down` / `def self.down`
 *   - JS/TS class method:          `[visibility] [async] down(...) [: Type] {`
 *   - JS/TS object property:       `down: [async] function(...) | (...) => ...`
 *   - JS/TS named function export: `export [async] function down(...)`
 *   - CommonJS exports:            `[module.]exports.down = [async] function|arrow`
 *   - ES module const export:      `export const down = [async] function|arrow`
 *
 * Adding a new shape requires updating migrations.test.ts with both
 * a positive (down() detected → no missing-down) and negative
 * (comment containing the shape → still triggers missing-down) test.
 */
export const DOWN_METHOD_PATTERNS: readonly RegExp[] = [
  // Laravel (PHP): `[public|protected|private] function down(...)`
  /^\s*(?:(?:public|protected|private)\s+)?function\s+down\s*\(/,
  // Rails (Ruby): `def down` or `def self.down`
  /^\s*def\s+(?:self\.)?down\b/,
  // Sequelize/TypeORM class method (JS/TS), with optional visibility,
  // optional async, optional TS return type annotation before `{`:
  // e.g. `public async down(qi: QueryInterface): Promise<void> {`
  /^\s*(?:(?:public|protected|private)\s+)?(?:async\s+)?down\s*\([^)]*\)\s*(?::[^{]+)?\s*\{/,
  // Sequelize/TypeORM object-property shape:
  // `down: async function (qi) { ... }`
  // `down: async (qi) => { ... }`
  // `down: function (qi) { ... }`
  /^\s*down\s*:\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/,
  // JS/TS named function export:
  // `export async function down(qi) { ... }` / `export function down(qi) {`
  /^\s*export\s+(?:async\s+)?function\s+down\s*\(/,
  // CommonJS exports:
  // `exports.down = function(qi) { ... }`
  // `module.exports.down = async (qi) => ...`
  /^\s*(?:module\.)?exports\.down\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/,
  // ES module const export:
  // `export const down = async (qi) => ...`
  // `export const down = function(qi) { ... }`
  /^\s*export\s+const\s+down\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/,
];
