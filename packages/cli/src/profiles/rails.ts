// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { type GenerateOptions, yamlScalar } from "./shared.js";

export function generate(opts: GenerateOptions): string {
  return `version: 1
profile: rails
project:
  name: ${yamlScalar(opts.projectName)}
  type: web-app

risk:
  block_on: critical
  warn_on: medium

frameworks:
  - rails

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
    - tmp/**
    - log/**
    - node_modules/**
    - storage/**

commands:
  guard:
    - "rails db:drop"
    - "rm -rf /"
  require_confirm:
    - "rails db:migrate"
    - "rails db:reset"

llm:
  enabled: false
`;
}
