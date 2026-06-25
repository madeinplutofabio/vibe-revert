// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Base class for all errors thrown by `@viberevert/adapters`.
 *
 * Per D101.A, adapters are read-only and most adapter REFUSALS are
 * expressed as `RefusedPlan` values (see `./types.ts`) rather than thrown
 * errors. `AdapterError` (and its future subclasses) is reserved for
 * genuinely exceptional conditions that adapters cannot encode as part of
 * a `Plan` -- I/O failures during detection, malformed config bytes, etc.
 *
 * Step 1 (M G1b) defines only the base class. Subclasses ship in Steps
 * 3-5 alongside the per-adapter implementations (husky / lefthook /
 * cursor / claude / github-action).
 */
export class AdapterError extends Error {}
