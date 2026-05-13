// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { monotonicFactory } from "ulid";

const nextSessionUlid = monotonicFactory();

/**
 * Returns a fresh session id of the form `sess_<ULID>` — e.g.
 * `sess_01JV8Z0N6E9QABCDEFGHIJKLMN`.
 *
 * The returned string is the FULL id including the `sess_` prefix.
 * Never prepend `sess_` to the result, or paths and lookups will
 * double up (`sess_sess_...`). Per D6 in the M B plan, all storage
 * paths use the returned id verbatim:
 * `.viberevert/sessions/${sessionId}/`.
 *
 * Per D5/D16, `@viberevert/core` owns session IDs (`sess_<ULID>`)
 * while `@viberevert/git` owns checkpoint IDs (`cp_<ULID>`). The two
 * packages have INDEPENDENT `monotonicFactory()` instances — neither
 * needs to know about the other's ID space.
 */
export function generateSessionId(): string {
  return `sess_${nextSessionUlid()}`;
}
