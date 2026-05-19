// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Path-classifier rule definitions.
//
// Per D32 in the M C plan: classifiers are TYPESCRIPT DATA TABLES, not
// hard-coded if/switch chains. Each PathRule maps a glob pattern (POSIX,
// case-sensitive, picomatch syntax) to a risk category, a baseline
// finding level, a set of tags that contribute to ChangedFile.risk_tags,
// and optionally a framework filter (rule applies only when that
// framework is detected) plus test-sibling patterns (used by the D36
// test-gap check) plus exclude patterns (suppression — e.g., the
// `laravel.env` rule's exclude of `.env.example` so the secrets-related
// rule does not double-fire alongside D33 detector suppression).
//
// Rule organization (4 tiers):
//   - Laravel — framework: "laravel" (PHP MVC framework)
//   - Next.js / Node — framework: "nextjs" (React-based fullstack)
//   - Rails — framework: "rails" (Ruby on Rails)
//   - Generic — no framework field; evaluated regardless of detected
//     frameworks (covers Dockerfile, CI/CD config, IaC, lockfiles,
//     manifest files, hosting provider config).
//
// Locked design points (per D32):
//   - Patterns are POSIX globs with forward slashes only. The matcher
//     (`./match.ts`) normalizes backslashes to forward slashes
//     explicitly before picomatch sees the path; do NOT add backslash
//     handling to rule patterns themselves.
//   - Matching is case-SENSITIVE (Linux convention). Pattern authors
//     must use exact case (e.g., `Dockerfile` not `dockerfile`).
//   - Each rule's `id` is a stable identifier used by the path-classifier
//     check as `path-classifier.<rule.id>` per D40's per-rule-id
//     dedup-distinctness rule. Renaming a rule's `id` is a breaking
//     change for downstream consumers (report comparisons, dashboards).
//   - `category` MUST be a value present in CHECKS_TOGGLE_MAP from
//     `../registry.ts` (or `"summary"`, which path rules MUST NOT use).
//     The registry-invariant test in `test/registry.test.ts` enforces
//     this at dev time once path-classifier check is registered.
//   - High/critical `defaultLevel` values mean the path-classifier
//     check's emitted findings will require a `recommendation` (per
//     M B's CheckResultSchema refine). The recommendation per category
//     is set inside `./path-classifier-check.ts`'s category → text
//     lookup table.
//
// Pattern construction discipline (locked):
//   - NEVER rely on picomatch's `**/` zero-segment behavior. We have
//     CI evidence that `**/X` requires `**` to consume ≥1 segment on
//     Linux (so `**/X` does NOT match root-level `X`). Patterns that
//     need to match BOTH root AND nested locations MUST use explicit
//     alternation: `{X,**/X}` (root-only `X` + nested `**/X`).
//   - Rules that can be operational inside nested app/package roots use
//     explicit root + nested alternatives. GitHub Actions is intentionally
//     repo-root only (`.github/workflows/**`) because GitHub does not
//     execute nested `.github/workflows` directories.
//   - Framework rules (Laravel, Next.js, Rails) AND generic rules with
//     nested-applicable conventions handle monorepo layouts on day one
//     (`apps/api/app/Http/Controllers/...`,
//     `apps/web/next.config.ts`, `packages/api/package.json`,
//     `services/worker/Dockerfile`, etc.). The verbosity cost of
//     explicit alternation is one-time; the cost of silent miss is
//     ongoing.
//   - For Laravel controller rules, the pattern covers BOTH the
//     subdirectory convention (`app/Http/Controllers/Auth/**`) AND the
//     common flat-file convention (`app/Http/Controllers/*Auth*Controller.php`),
//     each with root + nested variants. `*Auth*Controller.php`
//     correctly catches `AuthController.php`, `OAuthController.php`,
//     `MyAuthController.php`, etc. — overmatching toward "auth-related"
//     is the safer error bias.
//   - For Next.js payment routes, 8 explicit alternatives cover the
//     direct/nested keyword × direct/nested route.ts × root/nested
//     monorepo location cross-product (App Router shapes). Each
//     alternative is a complete glob; none relies on `**/`
//     zero-segment matching.
//   - Test sibling patterns follow the same discipline: where a
//     framework supports flat-file tests (Laravel's
//     `tests/Feature/AuthControllerTest.php` alongside
//     `tests/Feature/Auth/LoginTest.php`), both forms appear in
//     `testSiblingPatterns`. Root + nested variants
//     (`**/tests/Feature/...`, `*.test.ts` + `**/*.test.ts`) are
//     included so D36's test-gap check does NOT false-positive on
//     real monorepo layouts or root-level Next.js test files.
//
// The classifier-induced findings ARE additive: a single path matching
// multiple rules emits one CheckResult per (rule, file) pair. The engine's
// D40 identity-based dedup keeps them distinct because each carries a
// different `id` (the `path-classifier.<rule.id>` namespacing).

import type { RiskLevel } from "@viberevert/session-format";

/**
 * One classifier rule. Per D32, all fields are READONLY at the type level
 * and the table is treated as compile-time data.
 *
 * `pattern`: POSIX glob string with forward slashes. Matched
 * case-SENSITIVELY by picomatch with the locked options
 * `{ dot: true, nocase: false, posixSlashes: true, nonegate: true }` — see
 * `./match.ts`. All paths passed to picomatch are normalized to
 * repo-relative POSIX BEFORE matching by `normalizeClassifierPath` in
 * `./match.ts` (the load-bearing cross-platform guarantee);
 * `posixSlashes: true` is a defense-in-depth secondary guard.
 *
 * `category`: the M C risk-category label this rule contributes to. MUST
 * match a category value present in `CHECKS_TOGGLE_MAP` from
 * `../registry.ts` — otherwise the engine's two-layer toggle filter
 * will silently drop findings under that category. The registry-invariant
 * test enforces this at dev time.
 *
 * `framework`: when set, the rule is evaluated ONLY if `framework` is in
 * `ctx.detectedFrameworks` (resolved by the CLI per D41 + D42). When
 * omitted, the rule is always evaluated (the "Generic" tier).
 *
 * `tags`: contributes to `ChangedFile.risk_tags` when this rule matches.
 * The engine unions tags from all matching rules per file, dedupes, and
 * sorts ASCII-asc.
 *
 * `defaultLevel`: the baseline finding level the path-classifier check
 * emits when this rule matches. `./path-classifier-check.ts` uses this
 * as the `CheckResult.level` for the emitted finding.
 *
 * `testSiblingPatterns`: optional list of glob patterns that, if matched
 * by ANY sibling file in the same diff, satisfy the test-gap check (D36)
 * for files matching this rule. Diff-scoped: pre-existing tests in the
 * repo that weren't changed in the diff do NOT count. Patterns follow
 * the same root + nested alternation discipline as main patterns.
 *
 * `excludePatterns`: optional suppression list. Paths matching ANY of
 * these patterns are NOT classified by this rule. Used to exclude
 * template/example files from secret-related rules (e.g., the
 * `laravel.env` rule excludes `.env.example`, `<globstar>/.env.example`, etc.)
 * so they don't double-fire alongside D33 detector suppression. The
 * match step in `./match.ts` calls picomatch on each excludePattern;
 * if any matches the file path, the rule does NOT classify that path.
 */
export interface PathRule {
  readonly id: string;
  readonly pattern: string;
  readonly category: string;
  readonly framework?: string;
  readonly tags: readonly string[];
  readonly defaultLevel: RiskLevel;
  readonly testSiblingPatterns?: readonly string[];
  readonly excludePatterns?: readonly string[];
}

/**
 * The classifier rule table. 24 rules across 4 tiers. Every rule whose
 * target can be operational inside a nested app/package root uses
 * explicit root + nested alternatives. Repo-root-only platform
 * conventions, such as GitHub Actions workflows, stay root-scoped.
 *
 * NOTE on JSDoc convention in this block: the literal sequence of two
 * asterisks immediately followed by a slash terminates a block comment
 * early, so prose references to picomatch's recursive `**` operator
 * followed by a path separator use `<globstar>/` as a placeholder.
 * The actual `pattern` strings further down use the real idiom — that
 * is string-literal content, not comment text, so the lexer rule does
 * not apply there. Future contributors: please preserve the
 * `<globstar>/` convention in this prose to avoid breaking the build.
 *
 * Adding a new rule:
 *   1. Pick a stable `id` (`<tier>.<short-name>`); never rename — it's a
 *      breaking change for consumers reading report findings.
 *   2. `category` MUST match a value in CHECKS_TOGGLE_MAP (or the
 *      registry-invariant test will fail once the path-classifier check
 *      is registered).
 *   3. `defaultLevel` of `"high"` or `"critical"` requires that the
 *      category has a recommendation entry in
 *      `./path-classifier-check.ts`'s recommendation lookup table.
 *   4. Add positive + negative coverage in
 *      `test/classifiers/path-rules.test.ts`.
 *   5. If the rule's target CAN be operational inside nested app/package
 *      roots (monorepo support), use the explicit
 *      `{X, <globstar>/X}` alternation form (or the appropriate
 *      multi-alternative shape). Do NOT rely on picomatch's
 *      leading-globstar zero-segment behavior. Rules covering
 *      repo-root-only platform conventions (e.g., GitHub Actions) stay
 *      root-scoped.
 *   6. testSiblingPatterns follow the same alternation discipline:
 *      include flat-file variants where the framework supports them,
 *      include monorepo-nested globstar-prefixed variants for
 *      consistency, AND include root-level non-prefixed variants where
 *      root-level test files are common (Next.js: `middleware.test.ts`).
 *
 * The "rails.controllers" rule uses category "auth" because controllers
 * are the auth boundary in Rails MVC; this is intentional even though
 * the rule's id contains "controllers" (a different naming axis).
 */
export const PATH_RULES: readonly PathRule[] = [
  // ==================== Laravel (7 rules) ====================
  {
    // Root + nested.
    id: "laravel.middleware",
    pattern: "{app/Http/Middleware/**,**/app/Http/Middleware/**}",
    category: "auth",
    framework: "laravel",
    tags: ["auth", "middleware"],
    defaultLevel: "high",
    testSiblingPatterns: [
      "tests/Feature/**",
      "tests/Unit/**",
      "**/tests/Feature/**",
      "**/tests/Unit/**",
    ],
  },
  {
    // Covers BOTH subdir (`app/Http/Controllers/Auth/LoginController.php`)
    // AND flat-file (`app/Http/Controllers/AuthController.php`,
    // `app/Http/Controllers/OAuthController.php`, etc.) conventions,
    // each with root + nested monorepo variants. 4 alternatives total.
    id: "laravel.auth-controllers",
    pattern:
      "{app/Http/Controllers/Auth/**,app/Http/Controllers/*Auth*Controller.php,**/app/Http/Controllers/Auth/**,**/app/Http/Controllers/*Auth*Controller.php}",
    category: "auth",
    framework: "laravel",
    tags: ["auth"],
    defaultLevel: "high",
    testSiblingPatterns: [
      "tests/Feature/Auth/**",
      "tests/Feature/*Auth*Test.php",
      "**/tests/Feature/Auth/**",
      "**/tests/Feature/*Auth*Test.php",
    ],
  },
  {
    // Covers BOTH subdir AND flat-file (`BillingController.php`,
    // `StripeBillingController.php`, etc.), each with root + nested
    // monorepo variants.
    id: "laravel.billing-controllers",
    pattern:
      "{app/Http/Controllers/Billing/**,app/Http/Controllers/*Billing*Controller.php,**/app/Http/Controllers/Billing/**,**/app/Http/Controllers/*Billing*Controller.php}",
    category: "payments",
    framework: "laravel",
    tags: ["payments", "billing"],
    defaultLevel: "high",
    testSiblingPatterns: [
      "tests/Feature/Billing/**",
      "tests/Feature/*Billing*Test.php",
      "**/tests/Feature/Billing/**",
      "**/tests/Feature/*Billing*Test.php",
    ],
  },
  {
    // Covers BOTH subdir (`Webhooks/`, `WebhookHandlers/`, etc.) AND
    // flat-file (`WebhookController.php`, `StripeWebhookController.php`,
    // etc.), each with root + nested monorepo variants.
    id: "laravel.webhook-controllers",
    pattern:
      "{app/Http/Controllers/Webhook*/**,app/Http/Controllers/*Webhook*Controller.php,**/app/Http/Controllers/Webhook*/**,**/app/Http/Controllers/*Webhook*Controller.php}",
    category: "payments",
    framework: "laravel",
    tags: ["payments", "webhook"],
    defaultLevel: "critical",
    testSiblingPatterns: [
      "tests/Feature/Webhook*/**",
      "tests/Feature/*Webhook*Test.php",
      "**/tests/Feature/Webhook*/**",
      "**/tests/Feature/*Webhook*Test.php",
    ],
  },
  {
    // Root + nested.
    id: "laravel.migrations",
    pattern: "{database/migrations/**,**/database/migrations/**}",
    category: "database",
    framework: "laravel",
    tags: ["database", "migration"],
    defaultLevel: "high",
  },
  {
    // Root + nested.
    id: "laravel.config",
    pattern: "{config/**,**/config/**}",
    category: "infra",
    framework: "laravel",
    tags: ["config"],
    defaultLevel: "medium",
  },
  {
    // Root + nested for monorepos with multiple Laravel apps
    // (`apps/api/.env.local`, etc.).
    id: "laravel.env",
    pattern: "{.env*,**/.env*}",
    category: "secrets",
    framework: "laravel",
    tags: ["env"],
    defaultLevel: "high",
    excludePatterns: [
      ".env.example",
      "**/.env.example",
      ".env*.example",
      "**/.env*.example",
      ".env.template",
      "**/.env.template",
      "*.template",
      "**/*.template",
    ],
  },

  // ==================== Next.js / Node (5 rules) ====================
  {
    // Next.js supports middleware at root OR under `src/` (when the
    // src-directory convention is used). Each with root + nested
    // monorepo variants. 4 alternatives.
    id: "next.middleware",
    pattern:
      "{middleware.{ts,js},src/middleware.{ts,js},**/middleware.{ts,js},**/src/middleware.{ts,js}}",
    category: "auth",
    framework: "nextjs",
    tags: ["auth", "middleware"],
    defaultLevel: "high",
    testSiblingPatterns: [
      "*.test.{ts,tsx,js}",
      "*.spec.{ts,tsx,js}",
      "**/*.test.{ts,tsx,js}",
      "**/*.spec.{ts,tsx,js}",
    ],
  },
  {
    // Next.js App Router payment-route directory shape. 8 explicit
    // alternatives cover the cross-product of:
    //   - keyword direct (`app/api/billing/...`) vs nested
    //     (`app/api/v1/billing/...`)
    //   - route direct (`.../route.ts`) vs route nested
    //     (`.../[id]/route.ts`)
    //   - monorepo root vs nested location (`apps/web/app/api/...`)
    // Each alternative is a complete glob; none relies on `**/`
    // zero-segment matching.
    id: "next.payment-route-dirs",
    pattern:
      "{app/api/{billing,checkout,subscription*,payment*,webhook*,stripe*}/route.{ts,js},app/api/{billing,checkout,subscription*,payment*,webhook*,stripe*}/**/route.{ts,js},app/api/**/{billing,checkout,subscription*,payment*,webhook*,stripe*}/route.{ts,js},app/api/**/{billing,checkout,subscription*,payment*,webhook*,stripe*}/**/route.{ts,js},**/app/api/{billing,checkout,subscription*,payment*,webhook*,stripe*}/route.{ts,js},**/app/api/{billing,checkout,subscription*,payment*,webhook*,stripe*}/**/route.{ts,js},**/app/api/**/{billing,checkout,subscription*,payment*,webhook*,stripe*}/route.{ts,js},**/app/api/**/{billing,checkout,subscription*,payment*,webhook*,stripe*}/**/route.{ts,js}}",
    category: "payments",
    framework: "nextjs",
    tags: ["payments", "api"],
    defaultLevel: "critical",
    testSiblingPatterns: [
      "*.test.{ts,tsx,js}",
      "*.spec.{ts,tsx,js}",
      "**/*.test.{ts,tsx,js}",
      "**/*.spec.{ts,tsx,js}",
    ],
  },
  {
    // Next.js Pages Router (single-file routes) AND App Router file
    // shapes whose filename contains a payment-related substring.
    // 4 alternatives: direct vs nested file, root vs nested monorepo.
    id: "next.payment-api-files",
    pattern:
      "{{app,pages}/api/*{billing,checkout,subscription,payment,webhook,stripe}*.{ts,js},{app,pages}/api/**/*{billing,checkout,subscription,payment,webhook,stripe}*.{ts,js},**/{app,pages}/api/*{billing,checkout,subscription,payment,webhook,stripe}*.{ts,js},**/{app,pages}/api/**/*{billing,checkout,subscription,payment,webhook,stripe}*.{ts,js}}",
    category: "payments",
    framework: "nextjs",
    tags: ["payments", "api"],
    defaultLevel: "critical",
    testSiblingPatterns: [
      "*.test.{ts,tsx,js}",
      "*.spec.{ts,tsx,js}",
      "**/*.test.{ts,tsx,js}",
      "**/*.spec.{ts,tsx,js}",
    ],
  },
  {
    // Root + nested for monorepos (`apps/web/next.config.ts`, etc.).
    id: "next.config",
    pattern: "{next.config.{ts,js,mjs,cjs},**/next.config.{ts,js,mjs,cjs}}",
    category: "infra",
    framework: "nextjs",
    tags: ["config"],
    defaultLevel: "high",
  },
  {
    // Root + nested for monorepos with multiple Next.js apps
    // (`apps/web/.env.local`, etc.).
    id: "next.env",
    pattern: "{.env*,**/.env*}",
    category: "secrets",
    framework: "nextjs",
    tags: ["env"],
    defaultLevel: "high",
    excludePatterns: [
      ".env.example",
      "**/.env.example",
      ".env*.example",
      "**/.env*.example",
      ".env.template",
      "**/.env.template",
      "*.template",
      "**/*.template",
    ],
  },

  // ==================== Rails (2 rules) ====================
  {
    // Root + nested.
    id: "rails.migrations",
    pattern: "{db/migrate/**,**/db/migrate/**}",
    category: "database",
    framework: "rails",
    tags: ["database", "migration"],
    defaultLevel: "high",
    testSiblingPatterns: ["spec/**", "test/**", "**/spec/**", "**/test/**"],
  },
  {
    // Root + nested.
    id: "rails.controllers",
    pattern: "{app/controllers/**,**/app/controllers/**}",
    category: "auth",
    framework: "rails",
    tags: ["controllers"],
    defaultLevel: "medium",
    testSiblingPatterns: [
      "spec/controllers/**",
      "test/controllers/**",
      "**/spec/controllers/**",
      "**/test/controllers/**",
    ],
  },

  // ==================== Generic / always-on (10 rules) ====================
  {
    // Root + nested, AND wildcard suffix for `Dockerfile.prod`,
    // `Dockerfile.dev`, etc.
    id: "generic.dockerfile",
    pattern: "{Dockerfile,Dockerfile.*,**/Dockerfile,**/Dockerfile.*}",
    category: "infra",
    tags: ["docker"],
    defaultLevel: "high",
  },
  {
    // Root + nested for monorepos with per-service compose files
    // (`apps/api/docker-compose.yml`, etc.). Wildcard segment catches
    // variants like `docker-compose.prod.yml`, `compose.dev.yaml`.
    id: "generic.compose",
    pattern:
      "{docker-compose*.yml,docker-compose*.yaml,compose*.yml,compose*.yaml,**/docker-compose*.yml,**/docker-compose*.yaml,**/compose*.yml,**/compose*.yaml}",
    category: "infra",
    tags: ["docker"],
    defaultLevel: "high",
  },
  {
    // Intentionally repo-root only — GitHub does not execute workflows
    // from nested `.github/workflows` directories. Monorepo apps share
    // the root-level workflow configuration by GitHub's design.
    id: "generic.gh-actions",
    pattern: ".github/workflows/**",
    category: "deployment",
    tags: ["ci"],
    defaultLevel: "high",
  },
  {
    // Universal — Terraform files anywhere in the repo, not just under
    // a `terraform/` / `infra/` / `iac/` convention directory.
    id: "generic.terraform",
    pattern: "{*.tf,**/*.tf}",
    category: "infra",
    tags: ["terraform"],
    defaultLevel: "high",
  },
  {
    // All common k8s/Helm directory conventions, root + nested.
    id: "generic.k8s",
    pattern:
      "{k8s/**,kubernetes/**,helm/**,charts/**,**/k8s/**,**/kubernetes/**,**/helm/**,**/charts/**}",
    category: "infra",
    tags: ["k8s"],
    defaultLevel: "high",
  },
  {
    // Root + nested for workspace monorepos (`packages/api/pnpm-lock.yaml`,
    // etc.). 12 lockfile names × 2 locations = 24 alternatives covering
    // Node (npm/pnpm/yarn/Bun), PHP (Composer), Ruby (Bundler), Python
    // (Poetry/uv/Pipenv), Rust (Cargo), and Go (modules) ecosystems.
    // Following the `generic.dockerfile` precedent — the explicit form
    // removes any picomatch `**/`-zero-segment dependency.
    id: "generic.lockfiles",
    pattern:
      "{package-lock.json,pnpm-lock.yaml,yarn.lock,composer.lock,Gemfile.lock,poetry.lock,Cargo.lock,bun.lock,bun.lockb,uv.lock,Pipfile.lock,go.sum,**/package-lock.json,**/pnpm-lock.yaml,**/yarn.lock,**/composer.lock,**/Gemfile.lock,**/poetry.lock,**/Cargo.lock,**/bun.lock,**/bun.lockb,**/uv.lock,**/Pipfile.lock,**/go.sum}",
    category: "dependencies",
    tags: ["lockfile"],
    defaultLevel: "medium",
  },
  {
    // Root + nested for workspace monorepos (`packages/api/package.json`,
    // etc.). 13 manifest / workspace-declaration names × 2 locations =
    // 26 alternatives covering Node (package.json, pnpm-workspace.yaml,
    // bunfig.toml), PHP (Composer), Ruby (Bundler), Python (Poetry,
    // pip, Pipenv), Rust (Cargo), Go (modules), and Java/Kotlin
    // (Maven, Gradle) ecosystems.
    id: "generic.manifests",
    pattern:
      "{package.json,composer.json,Gemfile,pyproject.toml,requirements.txt,Cargo.toml,go.mod,Pipfile,pnpm-workspace.yaml,bunfig.toml,pom.xml,build.gradle,build.gradle.kts,**/package.json,**/composer.json,**/Gemfile,**/pyproject.toml,**/requirements.txt,**/Cargo.toml,**/go.mod,**/Pipfile,**/pnpm-workspace.yaml,**/bunfig.toml,**/pom.xml,**/build.gradle,**/build.gradle.kts}",
    category: "dependencies",
    tags: ["manifest"],
    defaultLevel: "medium",
  },
  {
    // Root + nested.
    id: "generic.vercel",
    pattern: "{vercel.json,.vercel/**,**/vercel.json,**/.vercel/**}",
    category: "deployment",
    tags: ["vercel"],
    defaultLevel: "high",
  },
  {
    // Root + nested.
    id: "generic.netlify",
    pattern: "{netlify.toml,**/netlify.toml}",
    category: "deployment",
    tags: ["netlify"],
    defaultLevel: "high",
  },
  {
    // Root + nested.
    id: "generic.fly",
    pattern: "{fly.toml,**/fly.toml}",
    category: "deployment",
    tags: ["fly"],
    defaultLevel: "high",
  },
];
