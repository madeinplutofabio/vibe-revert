// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { monotonicFactory } from "ulid";

const nextCheckpointUlid = monotonicFactory();

/**
 * Returns a fresh checkpoint id of the form `cp_<ULID>` — e.g.
 * `cp_01JV8Y7W2M7AABCDEFGHIJKLMN`.
 *
 * The returned string is the FULL id including the `cp_` prefix. Never
 * prepend `cp_` to the result, or paths and lookups will double up
 * (`cp_cp_...`). Per D17b in the M B plan, all storage paths use the
 * returned id verbatim: `.viberevert/checkpoints/${checkpointId}/`.
 */
export function generateCheckpointId(): string {
  return `cp_${nextCheckpointUlid()}`;
}
