// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Unit tests for packages/checks/src/classifiers/path-rules.ts.
//
// Two-layer testing strategy per the locked test design (Step 3, file 4):
//
//   1. PER-RULE POSITIVE COVERAGE: a deterministic table of
//      (ruleId, path, frameworks) tuples asserts that each of the 27
//      PATH_RULES entries classifies at least one representative path
//      AS THAT RULE. Assertions target `rule.id` (not category or
//      tags) because the `path-classifier.<rule.id>` finding id is a
//      STABLE PUBLIC CONTRACT — downstream consumers (reports,
//      dashboards, comparisons) bind to specific rule ids. Catching a
//      rule rename at test time is cheaper than fielding a downstream
//      bug report.
//
//      A meta-invariant test asserts EVERY rule in PATH_RULES is
//      covered by at least one tuple — adding a new rule without
//      coverage fails immediately, so the per-rule coverage table
//      never silently drifts out of sync with the rule set.
//
//      NOTE: per-rule positives use ROOT-level paths (the first
//      alternative of each pattern). They prove "this rule can fire"
//      but DO NOT prove the deliberately-expanded `**/X`, flat-file,
//      `Dockerfile.*`, `src/middleware.*`, and other alternation
//      branches still work. That coverage lives in
//      MONOREPO_EXACT_POSITIVES below.
//
//   2. ALTERNATION-BRANCH COVERAGE (root + nested + monorepo): a
//      separate table of (path, expectedIds, frameworks) tuples locks
//      the deliberately-expanded alternation branches in PATH_RULES.
//      Coverage discipline differs by rule tier:
//
//      - FRAMEWORK rules (laravel.*, next.*, rails.*, django.*,
//        sequelize.*, typeorm.*): EVERY alternative in each rule's
//        picomatch pattern has at least one EXACT-match test
//        exercising it. The Laravel controller rules each have all 4
//        alternatives covered (root subdir, root flat-file, nested
//        subdir, nested flat-file). The Next.js
//        `next.payment-route-dirs` rule has all 8 alternatives covered
//        (the cross product of root/nested location × direct/nested
//        keyword segment × direct/nested route segment).
//        `next.middleware` has all 4 alternatives covered (root/nested
//        × middleware/src-middleware). The migration rules added in
//        Step 6 (django.migrations 2 alts, sequelize.migrations 6
//        alts, typeorm.migrations 8 alts) follow the same FULL
//        coverage rule.
//
//      - GENERIC rules:
//          FULL coverage for: dockerfile (4 alts), gh-actions (1 alt
//          — root-only by design), terraform (2 alts), vercel (4 alts),
//          netlify (2 alts), fly (2 alts).
//          SAMPLED coverage for: compose (root + nested for both the
//          docker-compose and compose variants — 4 of 8 alts), k8s
//          (root for k8s/helm/charts, nested for charts/kubernetes —
//          5 of 8 alts), lockfiles (modern names bun.lock/.lockb,
//          uv.lock, go.sum, Pipfile.lock — root + nested for the
//          most ecosystem-defining of those), manifests (modern
//          names bun/uv/go/Pipfile/pnpm-workspace/pom/Gradle
//          variants — root + nested similarly).
//
//      Sampling rationale: exhaustive enumeration of every
//      24-alternative lockfile / 26-alternative manifest pattern ×
//      root/nested would yield ~50 tests with diminishing regression
//      value. The sampled tests target the names a future edit is
//      most likely to drop accidentally (modern additions like
//      bun/uv/go that don't have decades of muscle memory protecting
//      them) plus enough literal-name × `**/X` pairs to prove the
//      alternation structure itself works.
//
//      DISJOINT-FILENAME DISCIPLINE: each Laravel controller rule's
//      nested subdir/flat-file tests use DIFFERENT file names so each
//      path fires ONLY the intended alternative — e.g.
//      `LoginController.php` lights up the subdir branch only (the
//      flat-file pattern `*Auth*Controller.php` doesn't match
//      `LoginController.php` because the latter doesn't contain
//      "Auth"), and `AuthController.php` lights up the flat-file
//      branch only. This independence means a regression in EITHER
//      branch fails its own specific test, not a joint test that
//      could pass with one branch alive.
//
//      Assertions are EXACT (`toEqual`) so the rule set can't drift
//      to accidentally match additional rules for these paths.
//
//   3. LOAD-BEARING NEGATIVE CASES: four explicit sections lock the
//      deliberately tight rule semantics:
//        - Framework gating: framework-specific rules MUST NOT match
//          when the framework is absent from detectedFrameworks.
//        - Exclude patterns: .env.example, .env.template,
//          .env*.example, *.template variants (root and nested) MUST
//          be excluded from env rules.
//        - generic.gh-actions root-only: nested .github/workflows
//          paths MUST NOT match (GitHub design — nested workflows are
//          not executed, so flagging them would be a false positive).
//        - Case sensitivity: lowercase 'dockerfile', lowercase
//          'app/http/controllers/...', uppercase '.JSON' / '.TOML'
//          extensions MUST NOT match the locked case-sensitive
//          patterns.
//
//      Each negative case targets a SPECIFIC contract — not generic
//      "this should not match" filler. Future relaxation of any of
//      these contracts requires deliberate test removal, not silent
//      bypass.
//
//   4. MULTI-RULE MATCHER BEHAVIOR: locks the precondition that the
//      underlying matcher returns ALL matching rules for a path that
//      legitimately matches multiple rules. The full engine
//      round-trip preservation (D40 identity-based dedup keeps both
//      findings) is exercised in `multi-match.test.ts`; this section
//      locks the matcher-level invariant that file 5 builds upon.
//
// Test pipeline: uses `compilePathRules(PATH_RULES)` plus
// `classifyPathWithCompiledRules` directly rather than the
// `classifyPath` production wrapper. Functionally equivalent (the
// wrapper calls the same primitives over the same PATH_RULES), but
// exercising the primitive matcher API explicitly means a future
// signature change to `classifyPath` cannot silently bypass the real
// rule table.

import { describe, expect, it } from "vitest";

import { classifyPathWithCompiledRules, compilePathRules } from "../../src/classifiers/match.js";
import { PATH_RULES } from "../../src/classifiers/path-rules.js";

// =============================================================================
// Test fixtures: compiled rules + framework constants + helper
// =============================================================================

const COMPILED = compilePathRules(PATH_RULES);

const NO_FRAMEWORKS: readonly string[] = [];
const LARAVEL: readonly string[] = ["laravel"];
const NEXTJS: readonly string[] = ["nextjs"];
const RAILS: readonly string[] = ["rails"];
const DJANGO: readonly string[] = ["django"];
const SEQUELIZE: readonly string[] = ["sequelize"];
const TYPEORM: readonly string[] = ["typeorm"];
const ALL_FRAMEWORKS: readonly string[] = [
  "laravel",
  "nextjs",
  "rails",
  "django",
  "sequelize",
  "typeorm",
];

/**
 * Convenience: returns the SORTED list of rule ids that match the
 * given path under the given detected-frameworks set. Sorted for
 * deterministic cross-run comparison — the classifier itself preserves
 * PATH_RULES declaration order, but sorting here makes `toEqual`
 * assertions order-independent and makes test failures easier to read.
 */
function matchedIds(path: string, frameworks: readonly string[]): readonly string[] {
  return [...classifyPathWithCompiledRules(path, frameworks, COMPILED).map((r) => r.id)].sort();
}

// =============================================================================
// PER-RULE POSITIVE COVERAGE (27 rules — one entry per rule id)
// =============================================================================

interface PerRulePositive {
  readonly ruleId: string;
  readonly path: string;
  readonly frameworks: readonly string[];
}

const PER_RULE_POSITIVES: readonly PerRulePositive[] = [
  // ---- Laravel (7 rules) ----
  {
    ruleId: "laravel.middleware",
    path: "app/Http/Middleware/Authenticate.php",
    frameworks: LARAVEL,
  },
  {
    ruleId: "laravel.auth-controllers",
    path: "app/Http/Controllers/Auth/LoginController.php",
    frameworks: LARAVEL,
  },
  {
    ruleId: "laravel.billing-controllers",
    path: "app/Http/Controllers/Billing/SubscriptionController.php",
    frameworks: LARAVEL,
  },
  {
    ruleId: "laravel.webhook-controllers",
    path: "app/Http/Controllers/Webhooks/StripeController.php",
    frameworks: LARAVEL,
  },
  {
    ruleId: "laravel.migrations",
    path: "database/migrations/2026_01_01_000000_create_users_table.php",
    frameworks: LARAVEL,
  },
  { ruleId: "laravel.config", path: "config/auth.php", frameworks: LARAVEL },
  { ruleId: "laravel.env", path: ".env", frameworks: LARAVEL },

  // ---- Next.js / Node (5 rules) ----
  { ruleId: "next.middleware", path: "middleware.ts", frameworks: NEXTJS },
  {
    ruleId: "next.payment-route-dirs",
    path: "app/api/billing/route.ts",
    frameworks: NEXTJS,
  },
  {
    ruleId: "next.payment-api-files",
    path: "pages/api/stripe-webhook.ts",
    frameworks: NEXTJS,
  },
  { ruleId: "next.config", path: "next.config.ts", frameworks: NEXTJS },
  { ruleId: "next.env", path: ".env.local", frameworks: NEXTJS },

  // ---- Rails (2 rules) ----
  {
    ruleId: "rails.migrations",
    path: "db/migrate/20260101000000_create_users.rb",
    frameworks: RAILS,
  },
  {
    ruleId: "rails.controllers",
    path: "app/controllers/users_controller.rb",
    frameworks: RAILS,
  },

  // ---- Django (1 rule) ----
  // ALT 1 root `migrations/*.py`. Unusual for Django (typical layout is
  // `<app>/migrations/...` nested), but per the convention PER_RULE_POSITIVES
  // exercises the first alternative; nested variants are covered in
  // MONOREPO_EXACT_POSITIVES.
  {
    ruleId: "django.migrations",
    path: "migrations/0001_initial.py",
    frameworks: DJANGO,
  },

  // ---- Sequelize (1 rule) ----
  // ALT 1 root `migrations/*.{js,ts,mjs,cjs}`. Same shared path shape as
  // typeorm.migrations ALT 1, but framework=[sequelize] gates this so
  // only sequelize.migrations fires here.
  {
    ruleId: "sequelize.migrations",
    path: "migrations/2026-01-01-create-users.js",
    frameworks: SEQUELIZE,
  },

  // ---- TypeORM (1 rule) ----
  // ALT 1 root `migrations/*.{js,ts,mjs,cjs}`. Same shared path shape as
  // sequelize.migrations ALT 1, but framework=[typeorm] gates this so
  // only typeorm.migrations fires here.
  {
    ruleId: "typeorm.migrations",
    path: "migrations/1700000000000-CreateUsers.ts",
    frameworks: TYPEORM,
  },

  // ---- Generic / always-on (10 rules) ----
  { ruleId: "generic.dockerfile", path: "Dockerfile", frameworks: NO_FRAMEWORKS },
  { ruleId: "generic.compose", path: "docker-compose.yml", frameworks: NO_FRAMEWORKS },
  {
    ruleId: "generic.gh-actions",
    path: ".github/workflows/ci.yml",
    frameworks: NO_FRAMEWORKS,
  },
  { ruleId: "generic.terraform", path: "main.tf", frameworks: NO_FRAMEWORKS },
  { ruleId: "generic.k8s", path: "k8s/deployment.yaml", frameworks: NO_FRAMEWORKS },
  { ruleId: "generic.lockfiles", path: "package-lock.json", frameworks: NO_FRAMEWORKS },
  { ruleId: "generic.manifests", path: "package.json", frameworks: NO_FRAMEWORKS },
  { ruleId: "generic.vercel", path: "vercel.json", frameworks: NO_FRAMEWORKS },
  { ruleId: "generic.netlify", path: "netlify.toml", frameworks: NO_FRAMEWORKS },
  { ruleId: "generic.fly", path: "fly.toml", frameworks: NO_FRAMEWORKS },
];

describe("PATH_RULES — per-rule positive coverage (27 rules)", () => {
  it.each(PER_RULE_POSITIVES)("'$ruleId' matches '$path' under frameworks=$frameworks", ({
    ruleId,
    path,
    frameworks,
  }) => {
    expect(matchedIds(path, frameworks)).toContain(ruleId);
  });

  it("every PATH_RULES entry has at least one PER_RULE_POSITIVES coverage tuple", () => {
    // Meta-invariant: adding a new rule to PATH_RULES without also
    // adding a positive-coverage tuple to PER_RULE_POSITIVES fails
    // this test immediately. Keeps the per-rule coverage table from
    // silently drifting out of sync with the live rule set when
    // future steps grow PATH_RULES.
    const coveredIds = new Set(PER_RULE_POSITIVES.map((p) => p.ruleId));
    for (const rule of PATH_RULES) {
      expect(
        coveredIds.has(rule.id),
        `PATH_RULES entry '${rule.id}' has no positive coverage in PER_RULE_POSITIVES`,
      ).toBe(true);
    }
  });
});

// =============================================================================
// ALTERNATION-BRANCH COVERAGE (root + nested + monorepo, exact-match)
//
// See file header section 2 for the discipline + coverage breakdown
// (FULL for framework rules, SAMPLED for generic compose/k8s/
// lockfiles/manifests). Comments on each entry call out WHICH
// alternative of WHICH pattern the path exercises.
// =============================================================================

interface ExactMatchCase {
  readonly path: string;
  readonly frameworks: readonly string[];
  readonly expectedIds: readonly string[];
}

const MONOREPO_EXACT_POSITIVES: readonly ExactMatchCase[] = [
  // ---------------------------------------------------------------------------
  // Laravel — full 4-alt coverage for each of the 3 controller rules
  // (alt 1 root subdir is in PER_RULE_POSITIVES) + nested coverage for
  // middleware/migrations/config (2-alt patterns).
  // ---------------------------------------------------------------------------

  // laravel.auth-controllers — ALT 2 root flat-file
  // (`app/Http/Controllers/*Auth*Controller.php`).
  {
    path: "app/Http/Controllers/AuthController.php",
    frameworks: LARAVEL,
    expectedIds: ["laravel.auth-controllers"],
  },
  // laravel.auth-controllers — ALT 3 nested subdir
  // (`**/app/Http/Controllers/Auth/**`). 'LoginController.php' does NOT
  // contain "Auth", so the flat-file branch `*Auth*Controller.php` does
  // not also fire — this path locks the SUBDIR branch only.
  {
    path: "apps/api/app/Http/Controllers/Auth/LoginController.php",
    frameworks: LARAVEL,
    expectedIds: ["laravel.auth-controllers"],
  },
  // laravel.auth-controllers — ALT 4 nested flat-file
  // (`**/app/Http/Controllers/*Auth*Controller.php`).
  {
    path: "apps/api/app/Http/Controllers/AuthController.php",
    frameworks: LARAVEL,
    expectedIds: ["laravel.auth-controllers"],
  },

  // laravel.billing-controllers — ALT 2 root flat-file
  // (`app/Http/Controllers/*Billing*Controller.php`).
  {
    path: "app/Http/Controllers/BillingController.php",
    frameworks: LARAVEL,
    expectedIds: ["laravel.billing-controllers"],
  },
  // laravel.billing-controllers — ALT 3 nested subdir
  // (`**/app/Http/Controllers/Billing/**`). 'SubscriptionController.php'
  // does NOT contain "Billing", so the flat-file branch does not fire.
  {
    path: "apps/api/app/Http/Controllers/Billing/SubscriptionController.php",
    frameworks: LARAVEL,
    expectedIds: ["laravel.billing-controllers"],
  },
  // laravel.billing-controllers — ALT 4 nested flat-file
  // (`**/app/Http/Controllers/*Billing*Controller.php`).
  {
    path: "apps/api/app/Http/Controllers/BillingController.php",
    frameworks: LARAVEL,
    expectedIds: ["laravel.billing-controllers"],
  },

  // laravel.webhook-controllers — ALT 2 root flat-file
  // (`app/Http/Controllers/*Webhook*Controller.php`).
  // 'StripeWebhookController.php': `*` matches "Stripe", `*` matches "".
  {
    path: "app/Http/Controllers/StripeWebhookController.php",
    frameworks: LARAVEL,
    expectedIds: ["laravel.webhook-controllers"],
  },
  // laravel.webhook-controllers — ALT 3 nested subdir
  // (`**/app/Http/Controllers/Webhook*/**`). 'StripeController.php'
  // does NOT contain "Webhook", so the flat-file branch does not fire.
  {
    path: "apps/api/app/Http/Controllers/Webhooks/StripeController.php",
    frameworks: LARAVEL,
    expectedIds: ["laravel.webhook-controllers"],
  },
  // laravel.webhook-controllers — ALT 4 nested flat-file
  // (`**/app/Http/Controllers/*Webhook*Controller.php`).
  {
    path: "apps/api/app/Http/Controllers/StripeWebhookController.php",
    frameworks: LARAVEL,
    expectedIds: ["laravel.webhook-controllers"],
  },

  // laravel.middleware — ALT 2 nested (`**/app/Http/Middleware/**`).
  {
    path: "apps/api/app/Http/Middleware/Authenticate.php",
    frameworks: LARAVEL,
    expectedIds: ["laravel.middleware"],
  },
  // laravel.migrations — ALT 2 nested (`**/database/migrations/**`).
  {
    path: "apps/api/database/migrations/2026_01_01_000000_create_users_table.php",
    frameworks: LARAVEL,
    expectedIds: ["laravel.migrations"],
  },
  // laravel.config — ALT 2 nested (`**/config/**`).
  {
    path: "apps/api/config/auth.php",
    frameworks: LARAVEL,
    expectedIds: ["laravel.config"],
  },

  // ---------------------------------------------------------------------------
  // Next.js — full alt coverage for middleware (4 alts), payment-route-dirs
  // (8 alts), payment-api-files (4 alts), config (2 alts). Alt 1 of each is
  // in PER_RULE_POSITIVES; remaining alts below.
  // ---------------------------------------------------------------------------

  // next.middleware — ALT 2 root src/middleware.{ts,js}.
  {
    path: "src/middleware.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.middleware"],
  },
  // next.middleware — ALT 3 nested non-src `**/middleware.{ts,js}`.
  {
    path: "apps/web/middleware.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.middleware"],
  },
  // next.middleware — ALT 4 nested src `**/src/middleware.{ts,js}`.
  // (Alt 3 may ALSO match here since `**` matches the `apps/web/src`
  // prefix as a multi-segment globstar, but both alts belong to the
  // same rule so the matcher still returns a single rule fire.)
  {
    path: "apps/web/src/middleware.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.middleware"],
  },

  // next.payment-route-dirs — ALT 2 (root, direct keyword, nested route).
  {
    path: "app/api/billing/[id]/route.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.payment-route-dirs"],
  },
  // next.payment-route-dirs — ALT 3 (root, intermediate keyword, direct route).
  {
    path: "app/api/v1/billing/route.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.payment-route-dirs"],
  },
  // next.payment-route-dirs — ALT 4 (root, intermediate keyword, nested route).
  {
    path: "app/api/v1/billing/[id]/route.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.payment-route-dirs"],
  },
  // next.payment-route-dirs — ALT 5 (monorepo, direct keyword, direct route).
  {
    path: "apps/web/app/api/billing/route.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.payment-route-dirs"],
  },
  // next.payment-route-dirs — ALT 6 (monorepo, direct keyword, nested route).
  {
    path: "apps/web/app/api/billing/[id]/route.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.payment-route-dirs"],
  },
  // next.payment-route-dirs — ALT 7 (monorepo, intermediate keyword, direct route).
  {
    path: "apps/web/app/api/v1/billing/route.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.payment-route-dirs"],
  },
  // next.payment-route-dirs — ALT 8 (monorepo, intermediate keyword, nested route).
  // The `[id]` segment is literal in the path; picomatch's `**` matches
  // it as ordinary characters.
  {
    path: "apps/web/app/api/v1/billing/[id]/route.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.payment-route-dirs"],
  },

  // next.payment-api-files — ALT 2 (root, file nested under api/).
  {
    path: "app/api/v1/stripe-webhook.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.payment-api-files"],
  },
  // next.payment-api-files — ALT 3 (monorepo, file direct under api/).
  {
    path: "apps/web/pages/api/stripe-webhook.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.payment-api-files"],
  },
  // next.payment-api-files — ALT 4 (monorepo, file nested under api/).
  {
    path: "apps/web/pages/api/v1/stripe-webhook.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.payment-api-files"],
  },

  // next.config — ALT 2 nested (`**/next.config.{ts,js,mjs,cjs}`).
  {
    path: "apps/web/next.config.ts",
    frameworks: NEXTJS,
    expectedIds: ["next.config"],
  },

  // ---------------------------------------------------------------------------
  // Rails — alt 2 nested for both rules.
  // ---------------------------------------------------------------------------

  // rails.migrations — ALT 2 nested (`**/db/migrate/**`).
  {
    path: "apps/rails/db/migrate/20260101000000_create_users.rb",
    frameworks: RAILS,
    expectedIds: ["rails.migrations"],
  },
  // rails.controllers — ALT 2 nested (`**/app/controllers/**`).
  {
    path: "apps/rails/app/controllers/users_controller.rb",
    frameworks: RAILS,
    expectedIds: ["rails.controllers"],
  },

  // ---------------------------------------------------------------------------
  // Django — full 2-alt coverage. ALT 1 is in PER_RULE_POSITIVES.
  // ---------------------------------------------------------------------------

  // django.migrations — ALT 2 nested (`**/migrations/*.py`). Typical
  // Django per-app layout: `<app>/migrations/<sequence>_<name>.py`.
  {
    path: "accounts/migrations/0001_initial.py",
    frameworks: DJANGO,
    expectedIds: ["django.migrations"],
  },

  // ---------------------------------------------------------------------------
  // Sequelize — full 6-alt coverage. ALT 1 is in PER_RULE_POSITIVES.
  // Tests use frameworks=[sequelize] only to isolate from typeorm.
  // ---------------------------------------------------------------------------

  // sequelize.migrations — ALT 2 root `src/migrations/*.{js,ts,mjs,cjs}`
  // (TypeScript Sequelize project convention).
  {
    path: "src/migrations/2026-01-01-create-users.ts",
    frameworks: SEQUELIZE,
    expectedIds: ["sequelize.migrations"],
  },
  // sequelize.migrations — ALT 3 root `db/migrations/*.{js,ts,mjs,cjs}`
  // (alt directory convention).
  {
    path: "db/migrations/2026-01-01-create-users.js",
    frameworks: SEQUELIZE,
    expectedIds: ["sequelize.migrations"],
  },
  // sequelize.migrations — ALT 4 nested `**/migrations/*.{js,ts,mjs,cjs}`.
  {
    path: "apps/api/migrations/2026-01-01-create-users.ts",
    frameworks: SEQUELIZE,
    expectedIds: ["sequelize.migrations"],
  },
  // sequelize.migrations — ALT 5 nested `**/src/migrations/*.{js,ts,mjs,cjs}`.
  {
    path: "apps/api/src/migrations/2026-01-01-create-users.ts",
    frameworks: SEQUELIZE,
    expectedIds: ["sequelize.migrations"],
  },
  // sequelize.migrations — ALT 6 nested `**/db/migrations/*.{js,ts,mjs,cjs}`.
  {
    path: "apps/api/db/migrations/2026-01-01-create-users.js",
    frameworks: SEQUELIZE,
    expectedIds: ["sequelize.migrations"],
  },

  // ---------------------------------------------------------------------------
  // TypeORM — full 8-alt coverage. ALT 1 is in PER_RULE_POSITIVES.
  // Tests use frameworks=[typeorm] only to isolate from sequelize.
  // ---------------------------------------------------------------------------

  // typeorm.migrations — ALT 2 root `src/migrations/*.{js,ts,mjs,cjs}`
  // (shared with Sequelize convention).
  {
    path: "src/migrations/1700000000000-CreateUsers.ts",
    frameworks: TYPEORM,
    expectedIds: ["typeorm.migrations"],
  },
  // typeorm.migrations — ALT 3 root `src/migration/*.{js,ts,mjs,cjs}`
  // (TypeORM-UNIQUE singular `migration` directory; NOT shared with
  // Sequelize).
  {
    path: "src/migration/1700000000000-CreateUsers.ts",
    frameworks: TYPEORM,
    expectedIds: ["typeorm.migrations"],
  },
  // typeorm.migrations — ALT 4 root `db/migrations/*.{js,ts,mjs,cjs}`.
  {
    path: "db/migrations/1700000000000-CreateUsers.ts",
    frameworks: TYPEORM,
    expectedIds: ["typeorm.migrations"],
  },
  // typeorm.migrations — ALT 5 nested `**/migrations/*.{js,ts,mjs,cjs}`.
  {
    path: "apps/api/migrations/1700000000000-CreateUsers.ts",
    frameworks: TYPEORM,
    expectedIds: ["typeorm.migrations"],
  },
  // typeorm.migrations — ALT 6 nested `**/src/migrations/*.{js,ts,mjs,cjs}`.
  {
    path: "apps/api/src/migrations/1700000000000-CreateUsers.ts",
    frameworks: TYPEORM,
    expectedIds: ["typeorm.migrations"],
  },
  // typeorm.migrations — ALT 7 nested `**/src/migration/*.{js,ts,mjs,cjs}`
  // (TypeORM-UNIQUE singular nested variant).
  {
    path: "apps/api/src/migration/1700000000000-CreateUsers.ts",
    frameworks: TYPEORM,
    expectedIds: ["typeorm.migrations"],
  },
  // typeorm.migrations — ALT 8 nested `**/db/migrations/*.{js,ts,mjs,cjs}`.
  {
    path: "apps/api/db/migrations/1700000000000-CreateUsers.ts",
    frameworks: TYPEORM,
    expectedIds: ["typeorm.migrations"],
  },

  // ---------------------------------------------------------------------------
  // Generic infra / IaC — FULL coverage for dockerfile (4 alts),
  // terraform (2 alts); SAMPLED for compose (4 of 8 alts), k8s (5 of 8 alts).
  // ---------------------------------------------------------------------------

  // generic.dockerfile — ALT 2 root `Dockerfile.*`.
  {
    path: "Dockerfile.prod",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.dockerfile"],
  },
  // generic.dockerfile — ALT 3 nested `**/Dockerfile`.
  {
    path: "services/worker/Dockerfile",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.dockerfile"],
  },
  // generic.dockerfile — ALT 4 nested `**/Dockerfile.*`.
  {
    path: "services/worker/Dockerfile.prod",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.dockerfile"],
  },

  // generic.compose — ALT 3 root `compose*.yml`.
  {
    path: "compose.dev.yml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.compose"],
  },
  // generic.compose — ALT 6 nested `**/docker-compose*.yaml`.
  {
    path: "services/api/docker-compose.prod.yaml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.compose"],
  },
  // generic.compose — ALT 8 nested `**/compose*.yaml`.
  {
    path: "services/api/compose.yaml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.compose"],
  },

  // generic.terraform — ALT 2 nested `**/*.tf`.
  {
    path: "modules/network/main.tf",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.terraform"],
  },

  // generic.k8s — ALT 3 root `helm/**`.
  {
    path: "helm/app/values.yaml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.k8s"],
  },
  // generic.k8s — ALT 4 root `charts/**`.
  {
    path: "charts/app/Chart.yaml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.k8s"],
  },
  // generic.k8s — ALT 6 nested `**/kubernetes/**`.
  {
    path: "services/api/kubernetes/deployment.yaml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.k8s"],
  },
  // generic.k8s — ALT 8 nested `**/charts/**`.
  {
    path: "apps/web/charts/app/Chart.yaml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.k8s"],
  },

  // ---------------------------------------------------------------------------
  // Generic deployment-platform — FULL coverage for vercel (4 alts),
  // netlify (2 alts), fly (2 alts).
  // ---------------------------------------------------------------------------

  // generic.vercel — ALT 2 root `.vercel/**`.
  {
    path: ".vercel/project.json",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.vercel"],
  },
  // generic.vercel — ALT 3 nested `**/vercel.json`.
  {
    path: "apps/web/vercel.json",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.vercel"],
  },
  // generic.vercel — ALT 4 nested `**/.vercel/**`.
  {
    path: "apps/web/.vercel/project.json",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.vercel"],
  },
  // generic.netlify — ALT 2 nested `**/netlify.toml`.
  {
    path: "apps/web/netlify.toml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.netlify"],
  },
  // generic.fly — ALT 2 nested `**/fly.toml`.
  {
    path: "apps/api/fly.toml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.fly"],
  },

  // ---------------------------------------------------------------------------
  // Generic lockfile + manifest — SAMPLED coverage. Targets modern
  // ecosystem names (bun/uv/go/Pipfile/pnpm-workspace/pom/Gradle) at
  // both root AND nested. The npm-classic names (package-lock.json,
  // package.json) are covered by PER_RULE_POSITIVES; we don't enumerate
  // all 12 lockfile × 2 location + 13 manifest × 2 location pairs.
  // ---------------------------------------------------------------------------

  // Root coverage of the modern-ecosystem literal alternatives.
  { path: "bun.lock", frameworks: NO_FRAMEWORKS, expectedIds: ["generic.lockfiles"] },
  { path: "bun.lockb", frameworks: NO_FRAMEWORKS, expectedIds: ["generic.lockfiles"] },
  { path: "uv.lock", frameworks: NO_FRAMEWORKS, expectedIds: ["generic.lockfiles"] },
  { path: "go.sum", frameworks: NO_FRAMEWORKS, expectedIds: ["generic.lockfiles"] },
  {
    path: "Pipfile.lock",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.lockfiles"],
  },
  { path: "go.mod", frameworks: NO_FRAMEWORKS, expectedIds: ["generic.manifests"] },
  { path: "Pipfile", frameworks: NO_FRAMEWORKS, expectedIds: ["generic.manifests"] },
  {
    path: "pnpm-workspace.yaml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.manifests"],
  },
  {
    path: "bunfig.toml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.manifests"],
  },
  { path: "pom.xml", frameworks: NO_FRAMEWORKS, expectedIds: ["generic.manifests"] },
  {
    path: "build.gradle",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.manifests"],
  },
  {
    path: "build.gradle.kts",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.manifests"],
  },

  // Nested coverage of the same modern-ecosystem names — exercises the
  // `**/<name>` alternatives that monorepo support depends on.
  {
    path: "packages/api/bun.lock",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.lockfiles"],
  },
  {
    path: "packages/api/uv.lock",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.lockfiles"],
  },
  {
    path: "packages/api/go.sum",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.lockfiles"],
  },
  {
    path: "packages/api/go.mod",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.manifests"],
  },
  {
    path: "packages/api/Pipfile",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.manifests"],
  },
  {
    path: "packages/api/pnpm-workspace.yaml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.manifests"],
  },
  {
    path: "packages/api/bunfig.toml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.manifests"],
  },
  {
    path: "packages/api/pom.xml",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.manifests"],
  },
  {
    path: "packages/api/build.gradle.kts",
    frameworks: NO_FRAMEWORKS,
    expectedIds: ["generic.manifests"],
  },
];

describe("PATH_RULES — alternation-branch coverage (exact match)", () => {
  it.each(
    MONOREPO_EXACT_POSITIVES,
  )("'$path' (frameworks=$frameworks) matches EXACTLY $expectedIds", ({
    path,
    frameworks,
    expectedIds,
  }) => {
    expect(matchedIds(path, frameworks)).toEqual([...expectedIds].sort());
  });
});

// =============================================================================
// FRAMEWORK GATING (negative)
//
// Framework-specific rules MUST NOT match when their framework is
// absent from detectedFrameworks. Engine guarantee: a Laravel-only
// rule will not false-positive on a Next.js repo, etc.
// =============================================================================

describe("PATH_RULES — framework gating (negative)", () => {
  it("Laravel rules do NOT match when 'laravel' is absent from detected frameworks", () => {
    expect(matchedIds("app/Http/Middleware/Authenticate.php", NEXTJS)).toEqual([]);
    expect(matchedIds("app/Http/Controllers/Auth/LoginController.php", NEXTJS)).toEqual([]);
    expect(matchedIds("app/Http/Controllers/Billing/SubscriptionController.php", NEXTJS)).toEqual(
      [],
    );
    expect(
      matchedIds("database/migrations/2026_01_01_000000_create_users_table.php", NEXTJS),
    ).toEqual([]);
    expect(matchedIds("config/auth.php", NEXTJS)).toEqual([]);
    // '.env' under [rails] only — both laravel.env AND next.env are
    // gated out, and there is no generic env rule. Result: empty.
    expect(matchedIds(".env", RAILS)).toEqual([]);
  });

  it("Next.js rules do NOT match when 'nextjs' is absent from detected frameworks", () => {
    expect(matchedIds("middleware.ts", LARAVEL)).toEqual([]);
    expect(matchedIds("src/middleware.ts", LARAVEL)).toEqual([]);
    expect(matchedIds("app/api/billing/route.ts", LARAVEL)).toEqual([]);
    expect(matchedIds("pages/api/stripe-webhook.ts", LARAVEL)).toEqual([]);
    expect(matchedIds("next.config.ts", LARAVEL)).toEqual([]);
    expect(matchedIds("apps/web/next.config.ts", LARAVEL)).toEqual([]);
    // NOTE: '.env*' paths are intentionally NOT in this list — laravel.env
    // ALSO matches '.env*' when [laravel] is present, so the result would
    // not be empty. The Next.js-specific gating signal is on
    // middleware/api-route/next.config shapes, which are unique to nextjs.
  });

  it("Rails rules do NOT match when 'rails' is absent from detected frameworks", () => {
    expect(matchedIds("db/migrate/20260101000000_create_users.rb", LARAVEL)).toEqual([]);
    expect(matchedIds("db/migrate/20260101000000_create_users.rb", NEXTJS)).toEqual([]);
    expect(matchedIds("app/controllers/users_controller.rb", LARAVEL)).toEqual([]);
    expect(matchedIds("app/controllers/users_controller.rb", NEXTJS)).toEqual([]);
  });

  it("Django rules do NOT match when 'django' is absent from detected frameworks", () => {
    expect(matchedIds("migrations/0001_initial.py", LARAVEL)).toEqual([]);
    expect(matchedIds("migrations/0001_initial.py", NEXTJS)).toEqual([]);
    expect(matchedIds("accounts/migrations/0001_initial.py", LARAVEL)).toEqual([]);
    expect(matchedIds("accounts/migrations/0001_initial.py", RAILS)).toEqual([]);
  });

  it("Sequelize rules do NOT match when 'sequelize' is absent from detected frameworks", () => {
    expect(matchedIds("migrations/2026-01-01-create-users.js", LARAVEL)).toEqual([]);
    expect(matchedIds("migrations/2026-01-01-create-users.js", NEXTJS)).toEqual([]);
    expect(matchedIds("src/migrations/2026-01-01-create-users.ts", LARAVEL)).toEqual([]);
    expect(matchedIds("apps/api/db/migrations/2026-01-01-create-users.js", RAILS)).toEqual([]);
  });

  it("TypeORM rules do NOT match when 'typeorm' is absent from detected frameworks", () => {
    expect(matchedIds("migrations/1700000000000-CreateUsers.ts", LARAVEL)).toEqual([]);
    expect(matchedIds("migrations/1700000000000-CreateUsers.ts", NEXTJS)).toEqual([]);
    // TypeORM-UNIQUE `src/migration/` singular path under [sequelize] —
    // sequelize.migrations does NOT include the singular convention, so
    // even with sequelize detected, typeorm-singular paths produce empty.
    expect(matchedIds("src/migration/1700000000000-CreateUsers.ts", SEQUELIZE)).toEqual([]);
    expect(matchedIds("src/migration/1700000000000-CreateUsers.ts", LARAVEL)).toEqual([]);
  });

  it("Generic rules ALWAYS match regardless of detectedFrameworks (positive control)", () => {
    // Sanity check: the framework-gating tests above are isolating
    // framework-rule behavior, NOT accidentally rejecting generic
    // rules. If this control fails, the negative tests above lose
    // their meaning.
    expect(matchedIds("Dockerfile", NO_FRAMEWORKS)).toContain("generic.dockerfile");
    expect(matchedIds("Dockerfile", LARAVEL)).toContain("generic.dockerfile");
    expect(matchedIds("Dockerfile", NEXTJS)).toContain("generic.dockerfile");
    expect(matchedIds("Dockerfile", RAILS)).toContain("generic.dockerfile");
    expect(matchedIds("Dockerfile", DJANGO)).toContain("generic.dockerfile");
    expect(matchedIds("Dockerfile", SEQUELIZE)).toContain("generic.dockerfile");
    expect(matchedIds("Dockerfile", TYPEORM)).toContain("generic.dockerfile");
    expect(matchedIds("Dockerfile", ALL_FRAMEWORKS)).toContain("generic.dockerfile");
  });
});

// =============================================================================
// EXCLUDE PATTERNS (negative)
//
// `.env*`-style include patterns on env rules MUST be suppressed by
// exclude patterns covering .env.example, .env.template, .env*.example,
// *.template (root AND nested variants). Locks the D32 nested-exclude
// requirement.
// =============================================================================

describe("PATH_RULES — env rule exclude patterns (negative)", () => {
  it("'.env.example' is EXCLUDED from laravel.env (root, [laravel])", () => {
    expect(matchedIds(".env.example", LARAVEL)).toEqual([]);
  });

  it("'.env.example' is EXCLUDED from next.env (root, [nextjs])", () => {
    expect(matchedIds(".env.example", NEXTJS)).toEqual([]);
  });

  it("'apps/web/.env.example' is EXCLUDED (nested, [nextjs])", () => {
    // Locks the nested-prefixed exclude variant `**/.env.example`.
    expect(matchedIds("apps/web/.env.example", NEXTJS)).toEqual([]);
  });

  it("'apps/api/.env.example' is EXCLUDED (nested, [laravel])", () => {
    // Locks `**/.env.example` for the laravel.env rule (the rule has
    // the same exclude set as next.env, but this test confirms the
    // nested branch fires independently under [laravel]).
    expect(matchedIds("apps/api/.env.example", LARAVEL)).toEqual([]);
  });

  it("'.env.local.example' is EXCLUDED via the '.env*.example' pattern", () => {
    // Locks the wildcard-middle exclude variant `.env*.example`.
    expect(matchedIds(".env.local.example", NEXTJS)).toEqual([]);
  });

  it("'apps/web/.env.local.example' is EXCLUDED (nested wildcard-middle variant)", () => {
    // Locks `**/.env*.example` — the most permissive exclude branch.
    expect(matchedIds("apps/web/.env.local.example", NEXTJS)).toEqual([]);
  });

  it("'.env.template' is EXCLUDED from env rules", () => {
    expect(matchedIds(".env.template", LARAVEL)).toEqual([]);
    expect(matchedIds(".env.template", NEXTJS)).toEqual([]);
  });

  it("'apps/web/.env.template' is EXCLUDED (nested template variant)", () => {
    expect(matchedIds("apps/web/.env.template", NEXTJS)).toEqual([]);
  });

  it("'.env.local.template' is EXCLUDED via the broad '*.template' pattern", () => {
    // The path matches the env include pattern `.env*` but the broad
    // `*.template` exclude fires first → rule skipped. Locks the
    // root broad-suffix exclude branch.
    expect(matchedIds(".env.local.template", NEXTJS)).toEqual([]);
  });

  it("'apps/web/.env.local.template' is EXCLUDED via the nested '**/*.template' pattern", () => {
    // Locks the nested broad-suffix exclude branch `**/*.template`.
    expect(matchedIds("apps/web/.env.local.template", NEXTJS)).toEqual([]);
  });

  it("'.env.production' is NOT excluded — real env file SHOULD match (positive control)", () => {
    // Positive control: proves the exclude set is selective, not
    // over-broad. '.env.production' is a real env file the rule
    // SHOULD flag. If this control fails, the env-exclude tests above
    // lose their meaning (the rule might be matching nothing for
    // unrelated reasons).
    expect(matchedIds(".env.production", LARAVEL)).toContain("laravel.env");
    expect(matchedIds(".env.production", NEXTJS)).toContain("next.env");
  });

  it("'apps/web/.env.local' is NOT excluded — nested real env file SHOULD match (positive control)", () => {
    expect(matchedIds("apps/web/.env.local", NEXTJS)).toContain("next.env");
  });
});

// =============================================================================
// generic.gh-actions ROOT-ONLY (negative)
//
// GitHub does NOT execute workflows from nested `.github/workflows`
// directories; the rule is deliberately scoped to repo-root only
// (`.github/workflows/**`, no globstar prefix). Nested
// `.github/workflows` paths MUST NOT match — flagging them would
// generate false positives on dead workflow files.
// =============================================================================

describe("PATH_RULES — generic.gh-actions root-only (negative)", () => {
  it("'.github/workflows/ci.yml' at repo root MATCHES (positive control)", () => {
    expect(matchedIds(".github/workflows/ci.yml", NO_FRAMEWORKS)).toEqual(["generic.gh-actions"]);
  });

  it("'apps/web/.github/workflows/ci.yml' (nested) does NOT match — GitHub does not execute nested workflows", () => {
    expect(matchedIds("apps/web/.github/workflows/ci.yml", NO_FRAMEWORKS)).toEqual([]);
  });

  it("'services/api/.github/workflows/deploy.yml' (nested) does NOT match", () => {
    expect(matchedIds("services/api/.github/workflows/deploy.yml", NO_FRAMEWORKS)).toEqual([]);
  });
});

// =============================================================================
// CASE SENSITIVITY (negative)
//
// Locked matcher option `nocase: false` (Linux convention). Paths
// whose case differs from the rule pattern MUST NOT match. Locks the
// platform-independent classifier contract — case differences on a
// case-insensitive filesystem (macOS default, Windows) MUST NOT
// silently leak through.
// =============================================================================

describe("PATH_RULES — case sensitivity (negative)", () => {
  it("lowercase 'dockerfile' does NOT match generic.dockerfile (rule is exact-case 'Dockerfile')", () => {
    expect(matchedIds("dockerfile", NO_FRAMEWORKS)).toEqual([]);
  });

  it("uppercase 'DOCKERFILE' does NOT match generic.dockerfile", () => {
    expect(matchedIds("DOCKERFILE", NO_FRAMEWORKS)).toEqual([]);
  });

  it("lowercase 'app/http/controllers/...' does NOT match laravel.auth-controllers", () => {
    // Rule pattern uses exact-case `app/Http/Controllers/`.
    expect(matchedIds("app/http/controllers/Auth/LoginController.php", LARAVEL)).toEqual([]);
  });

  it("uppercase '.JSON' extension does NOT match generic.manifests (rule is exact-case '.json')", () => {
    expect(matchedIds("package.JSON", NO_FRAMEWORKS)).toEqual([]);
  });

  it("uppercase '.TOML' extension does NOT match generic.manifests (rule is exact-case '.toml')", () => {
    expect(matchedIds("Cargo.TOML", NO_FRAMEWORKS)).toEqual([]);
  });
});

// =============================================================================
// UNRELATED PATHS (negative)
//
// Random source files / docs MUST NOT match any rule under any
// framework combination. Catches a future regression where an
// over-broad pattern accidentally flags arbitrary code.
// =============================================================================

describe("PATH_RULES — unrelated paths match nothing (negative)", () => {
  it("'src/utils/helper.ts' matches no rule under any framework set", () => {
    expect(matchedIds("src/utils/helper.ts", NO_FRAMEWORKS)).toEqual([]);
    expect(matchedIds("src/utils/helper.ts", LARAVEL)).toEqual([]);
    expect(matchedIds("src/utils/helper.ts", NEXTJS)).toEqual([]);
    expect(matchedIds("src/utils/helper.ts", RAILS)).toEqual([]);
    expect(matchedIds("src/utils/helper.ts", ALL_FRAMEWORKS)).toEqual([]);
  });

  it("'README.md' matches no rule under any framework set", () => {
    expect(matchedIds("README.md", NO_FRAMEWORKS)).toEqual([]);
    expect(matchedIds("README.md", ALL_FRAMEWORKS)).toEqual([]);
  });

  it("'docs/architecture.md' matches no rule", () => {
    expect(matchedIds("docs/architecture.md", ALL_FRAMEWORKS)).toEqual([]);
  });

  it("a random app-source file matches no rule", () => {
    expect(matchedIds("apps/web/components/UserAvatar.tsx", ALL_FRAMEWORKS)).toEqual([]);
  });
});

// =============================================================================
// MULTI-RULE MATCHER BEHAVIOR
//
// A path that legitimately matches multiple rules MUST return ALL of
// them from the matcher. The full engine round-trip preservation (D40
// identity-based dedup keeps both findings distinct) is exercised in
// `multi-match.test.ts`; this section locks the matcher-level
// precondition that file 5 builds upon.
// =============================================================================

describe("PATH_RULES — multi-rule matcher behavior", () => {
  it("'.env' with frameworks=[laravel, nextjs] matches BOTH laravel.env AND next.env", () => {
    expect(matchedIds(".env", ["laravel", "nextjs"])).toEqual(["laravel.env", "next.env"]);
  });

  it("'apps/web/.env.local' with frameworks=[laravel, nextjs] matches BOTH env rules (nested variant)", () => {
    expect(matchedIds("apps/web/.env.local", ["laravel", "nextjs"])).toEqual([
      "laravel.env",
      "next.env",
    ]);
  });

  it("'.env.example' with frameworks=[laravel, nextjs] matches NEITHER env rule (both excludes fire)", () => {
    // Locks that BOTH rules' exclude patterns suppress the match
    // independently when the path matches multiple rules' includes.
    expect(matchedIds(".env.example", ["laravel", "nextjs"])).toEqual([]);
  });

  it("'migrations/foo.ts' with frameworks=[sequelize, typeorm] matches BOTH sequelize.migrations AND typeorm.migrations", () => {
    // Sequelize and TypeORM share the `migrations/*.{js,ts,mjs,cjs}`
    // pattern on ALT 1. When both frameworks are detected, both rules
    // fire on the same path — the matcher MUST return both ids.
    // Step 6's migrationsCheck only needs ONE database-category match
    // to trigger, so the overlap doesn't double-fire danger-term
    // findings; this test locks the matcher-level precondition.
    expect(matchedIds("migrations/foo.ts", ["sequelize", "typeorm"])).toEqual([
      "sequelize.migrations",
      "typeorm.migrations",
    ]);
  });
});
