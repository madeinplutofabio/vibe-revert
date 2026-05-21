// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { monotonicFactory } from "ulid";

const nextSessionUlid = monotonicFactory();
const nextReportUlid = monotonicFactory();

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

/**
 * Returns a fresh ad-hoc report id of the form `rpt_<ULID>` — e.g.
 * `rpt_01JV8Z0N6E9QABCDEFGHIJKLMN`.
 *
 * The returned string is the FULL id including the `rpt_` prefix.
 * Never prepend `rpt_` to the result, or paths and lookups will
 * double up (`rpt_rpt_...`). Per D26/D27 in the M C plan, ad-hoc
 * reports are stored at `.viberevert/reports/${reportId}/report.json`
 * (dir-level atomic temp+rename per D13); session-bound reports reuse
 * the owning session id and store at
 * `.viberevert/sessions/${sessionId}/report.json` (file-level atomic).
 *
 * Per D27, this factory is INDEPENDENT of `generateSessionId`'s
 * factory — the two ID spaces share neither monotonic sequence nor
 * timestamp coordination. Same rule that already keeps git's
 * `cp_<ULID>` factory independent from core's `sess_<ULID>` factory
 * (D5/D16).
 */
export function generateReportId(): string {
  return `rpt_${nextReportUlid()}`;
}
