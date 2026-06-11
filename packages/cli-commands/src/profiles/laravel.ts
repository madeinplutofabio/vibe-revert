// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { type GenerateOptions, yamlScalar } from "./shared.js";

export function generate(opts: GenerateOptions): string {
  return `version: 1
profile: laravel
project:
  name: ${yamlScalar(opts.projectName)}
  type: web-app

risk:
  block_on: critical
  warn_on: medium

frameworks:
  - laravel

checks:
  secrets: true
  dependencies: true
  migrations: true
  auth: true
  payments: true
  infra: true
  tests: true
  scope_expansion: false

policies:
  - basic/web-app
  - basic/secrets
  - basic/payments
  - basic/database

rollback:
  enabled: true
  include_untracked: true
  exclude:
    - vendor/**
    - node_modules/**
    - storage/logs/**
    - storage/framework/cache/**
    - bootstrap/cache/**

commands:
  guard:
    - "php artisan migrate:fresh"
    - "rm -rf /"
  require_confirm:
    - "php artisan migrate"
    - "php artisan db:wipe"

llm:
  enabled: false
`;
}
