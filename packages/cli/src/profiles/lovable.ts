// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { type GenerateOptions, yamlScalar } from "./shared.js";

export function generate(opts: GenerateOptions): string {
  return `version: 1
profile: lovable
project:
  name: ${yamlScalar(opts.projectName)}
  type: web-app

risk:
  block_on: critical
  warn_on: medium

frameworks:
  - lovable

checks:
  secrets: true
  dependencies: true
  auth: true
  payments: true
  infra: true
  scope_expansion: false

policies:
  - basic/web-app
  - basic/secrets

rollback:
  enabled: true
  include_untracked: true
  exclude:
    - node_modules/**
    - dist/**
    - build/**
    - .lovable/cache/**

commands:
  guard:
    - "rm -rf /"

llm:
  enabled: false
`;
}
