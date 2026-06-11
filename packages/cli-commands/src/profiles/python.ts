// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { type GenerateOptions, yamlScalar } from "./shared.js";

export function generate(opts: GenerateOptions): string {
  return `version: 1
profile: python
project:
  name: ${yamlScalar(opts.projectName)}

risk:
  block_on: critical
  warn_on: medium

frameworks:
  - python

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
  - basic/secrets

rollback:
  enabled: true
  include_untracked: true
  exclude:
    - __pycache__/**
    - .venv/**
    - venv/**
    - .pytest_cache/**
    - .mypy_cache/**
    - .ruff_cache/**

commands:
  guard:
    - "rm -rf /"
  require_confirm:
    - "alembic downgrade"
    - "django-admin migrate"
    - "manage.py migrate"

llm:
  enabled: false
`;
}
