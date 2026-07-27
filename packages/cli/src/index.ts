#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Thin executable entry. Cli construction + registration live in build-cli.ts so
// the docs-coverage invariants can import the exact registered surface without a
// subprocess. Startup is unchanged: this module runs the CLI on load.

import { main } from "./build-cli.js";

await main();
