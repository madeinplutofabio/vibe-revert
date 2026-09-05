// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Public input type for the selective rollback receipt renderers.
//
// A SEPARATE input from `ReceiptRenderInput` for the same reason that one has
// its own dispatcher: the payloads are different artifacts. A `ReceiptFile`
// describes a whole-session restore; a `SelectiveRollbackReceipt` describes
// which change groups were selected, what each selected PATH did, and what the
// two integrity passes and the project's own commands found. Neither is a
// superset of the other, and a union input would push a runtime shape check
// into every renderer to recover what the call site already knew.
//
// WHAT IS NOT RENDERED HERE. The command-level outcomes that produce NO
// receipt -- a refused selection, a preview that failed to classify, a
// publication that could not be shown to have happened -- are not modelled in
// this package and must not be. They live in `@viberevert/cli-commands`, and
// reporters does not depend on it. That split is also the existing contract:
// a receipt is rendered to stdout in the requested format, and everything
// without a receipt is plain diagnostic text on stderr.

import type { SelectiveRollbackReceipt } from "@viberevert/session-format";

/**
 * Single argument shape for every selective receipt renderer.
 *
 * `file` is the artifact as persisted, either the session-scoped preview
 * receipt or an invocation's `receipt.json`. Renderers branch on `file.mode`.
 *
 * `productVersion` is REQUIRED for the same reason as on the other two render
 * inputs: reporters must not reach back into the CLI's package.json to
 * discover the running version. The CLI resolves it and passes it in. Only
 * markdown consumes it, for its locked footer; the others accept it so the CLI
 * assembles one input shape regardless of format.
 *
 * The JSON renderer stays schema-verbatim and MUST NOT include
 * `productVersion` in its output: that is rendering metadata, not a schema
 * field, and adding it would silently mutate a persisted-artifact-shaped wire
 * output.
 */
export interface SelectiveReceiptRenderInput {
  readonly file: SelectiveRollbackReceipt;
  readonly productVersion: string;
}
