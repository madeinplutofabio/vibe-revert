// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// MCP audit log writer: append-only NDJSON file with locked field
// order, schema_version stamping, idempotent close, and tail-then-close
// failure preservation.
//
// Architectural locks:
//
//   D99.J -- locked record shapes, field order, tool_name sanitization,
//   serialized append via per-instance promise chain
//   D99.K -- single FileHandle per server lifetime, opened append-mode
//   D99.L -- no fsync per record (observational, not source of truth)
//   D99.M.6 -- viberevertDir imported from @viberevert/core (carve-out)
//   D99.M.7 -- audit fs surface lock: exactly 1 mkdir + 1 open +
//   appendFile-on-FH + 1 close, no other fs tokens
//   D99.M.14 -- never writes to process.stdout/stderr
//
// Writer integrity guarantees:
//
//   - openAuditLog wraps mkdir+open failures as McpAuditWriteError so
//     direct-error model holds; bad caller input (non-absolute
//     repoRoot) stays as RangeError, not misclassified.
//   - record() updates this.tail SYNCHRONOUSLY before any await so
//     concurrent Promise.all([record(a), record(b), record(c)]) lands
//     in deterministic call order.
//   - record() wraps serialization/timestamp failures as
//     McpAuditWriteError BEFORE extending the chain, so a bad input
//     does NOT poison subsequent records that would have serialized
//     fine.
//   - record() injects schema_version + ts AFTER spread so a runtime
//     caller cannot override the writer-owned fields.
//   - record()'s append chain stores the BRANDED failure (the .catch
//     wraps appendFile rejections as McpAuditWriteError before
//     re-throwing), so close()'s tail-await sees the branded class
//     directly and naturally poisons the chain: subsequent record()
//     calls await a rejected promise that already carries the brand.
//   - record() after close() rejects with McpAuditWriteError.
//   - close() is idempotent (second call returns same promise).
//   - close() runs fh.close() EVEN IF tail rejected (try/finally
//     semantics around tail-await + close call).
//   - close() preserves both failures: cause = tailError (upstream
//     diagnostic), secondaryCause = closeError when both fail.
//
// Tool-call ok/error-code correlation:
//
//   ToolCallRecord is a discriminated union over `ok`:
//     - {ok: true, ...no error_code...}
//     - {ok: false, ...error_code: string...}
//   The contract is enforced at compile time, not by comment.

import { type FileHandle, mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { viberevertDir } from "@viberevert/core";

import { McpAuditWriteError } from "./errors.js";

// ============================================================================
// Record types
// ============================================================================

/**
 * Header common to every audit record. schema_version FIRST in serialized
 * NDJSON so file consumers can branch on format version before parsing
 * further fields. ts is the ISO-8601 UTC timestamp.
 */
type CommonHeader = {
  schema_version: 1;
  event: string;
  ts: string;
};

/**
 * Fields shared by both ok:true and ok:false variants of ToolCallRecord.
 * The ok/error_code correlation is enforced via the discriminated
 * union below.
 */
type ToolCallCommon = CommonHeader & {
  event: "tool_call";
  tool_name: string;
  exit_code: number | null;
  blocked?: true;
  duration_ms: number;
  stderr_truncated?: true;
};

/**
 * Tool invocation, success OR failure.
 *
 * Discriminated union enforces the ok/error_code correlation:
 *   - ok: true  => NO error_code allowed
 *   - ok: false => error_code REQUIRED
 *
 * `blocked` only set when the tool's data envelope carries a blocked
 * boolean (currently only check_repo). `stderr_truncated` only set
 * when D99.W stderr cap was hit (diagnostic, not failure).
 */
export type ToolCallRecord =
  | (ToolCallCommon & {
      ok: true;
      error_code?: never;
    })
  | (ToolCallCommon & {
      ok: false;
      error_code: string;
    });

/**
 * Tool name was not registered. `reserved` discriminates between
 * a reserved-but-hidden name (rollback, request_human_approval) and
 * an arbitrary unknown name. `reason` is set ONLY for reserved
 * names (the dispatcher emits "reserved_approval_gated_not_exposed"
 * to make the audit grep-friendly).
 */
export type ToolCallDeniedRecord = CommonHeader & {
  event: "tool_call_denied";
  tool_name: string;
  ok: false;
  error_code: string;
  reserved: boolean;
  exposed: false;
  reason?: string;
};

/**
 * Server-integrity failure (audit append failed, transport error,
 * dispatcher state corruption). The dispatcher writes this AS-A-LAST-
 * RESORT diagnostic when it can; if the audit append itself fails,
 * the record cannot be written (chicken-and-egg) and the McpError
 * throw + stderr from the CLI wrapper is the only signal.
 */
export type ServerIntegrityFailureRecord = CommonHeader & {
  event: "server_integrity_failure";
  reason: string;
};

export type AuditRecord = ToolCallRecord | ToolCallDeniedRecord | ServerIntegrityFailureRecord;

/**
 * Writer-injected fields the caller must NOT supply.
 */
type AuditInjectedField = "schema_version" | "ts";

/**
 * Distributive Omit so each variant of AuditRecord -- including each
 * sub-variant of the ToolCallRecord union -- is omitted independently.
 * Without `T extends unknown ? ... : never`, Omit would collapse the
 * discriminated union and lose the ok/error_code correlation.
 */
type WithoutAuditInjectedFields<T> = T extends unknown ? Omit<T, AuditInjectedField> : never;

/**
 * Caller-supplied record shape: same union as AuditRecord minus the
 * two writer-injected fields (schema_version, ts). The writer fills
 * them centrally on every record() call.
 *
 * This separation prevents callers from forging the timestamp or
 * schema version. The audit log's integrity depends on those fields
 * being writer-controlled.
 */
export type AuditRecordInput = WithoutAuditInjectedFields<AuditRecord>;

// ============================================================================
// Field-order serializers (NDJSON)
// ============================================================================

/**
 * Sanitize a tool_name string per D99.J before JSON encoding.
 *
 *   - String-coerce defensively (param typed as unknown so a runtime
 *     caller that bypassed TypeScript via a cast still gets safe
 *     handling)
 *   - Replace any non-printable-ASCII char (outside 0x20-0x7E) with "?"
 *   - Cap at 64 characters
 *
 * This prevents control-char injection into audit lines and bounds
 * the tool_name field even when a malicious or buggy client sends
 * a very long name.
 */
function sanitizeToolName(name: unknown): string {
  return String(name)
    .replace(/[^\x20-\x7E]/g, "?")
    .slice(0, 64);
}

/**
 * Serialize duration_ms as a JSON number with NaN/Infinity/negative
 * guard.
 *
 * JSON.stringify(NaN) and JSON.stringify(Infinity) both emit "null"
 * silently, which would corrupt the audit duration field. Guard
 * here so the failure surfaces as a TypeError that record()'s
 * serialize-in-try block wraps as McpAuditWriteError.
 */
function serializeDurationMs(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("audit duration_ms must be a non-negative safe integer");
  }
  return String(value);
}

/**
 * Serialize exit_code as either a JSON number or the literal `null`,
 * with NaN/Infinity/negative guard.
 *
 * Negative exit codes are not a meaningful audit signal (POSIX exit
 * codes are unsigned bytes 0-255; Windows exit codes are
 * conventionally non-negative). A negative value at this layer
 * indicates a bug in the dispatcher / handler that should surface
 * as a wrapped McpAuditWriteError rather than silently land in the
 * audit log.
 */
function serializeExitCode(value: number | null): string {
  if (value === null) return "null";
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("audit exit_code must be a non-negative safe integer or null");
  }
  return String(value);
}

/**
 * Serialize a ToolCallRecord in locked field order.
 *
 * NDJSON safety: each value goes through JSON.stringify individually
 * (escapes control chars + quotes in strings) and is concatenated
 * with literal commas. NEVER JSON.stringify(wholeObject) because
 * object-key insertion order is technically implementation-defined
 * for some property types and locking the wire format explicitly is
 * safer for an audit file format that may be parsed by other tools
 * years from now.
 *
 * Numeric fields use the bespoke serializers above to guard against
 * NaN/Infinity/negative silently rendering as "null".
 *
 * Locked order:
 *   schema_version, event, ts, tool_name, ok, exit_code,
 *   [blocked], [error_code], duration_ms, [stderr_truncated]
 */
function serializeToolCallRecord(r: ToolCallRecord): string {
  const parts: string[] = [
    `"schema_version":${JSON.stringify(r.schema_version)}`,
    `"event":${JSON.stringify(r.event)}`,
    `"ts":${JSON.stringify(r.ts)}`,
    `"tool_name":${JSON.stringify(r.tool_name)}`,
    `"ok":${JSON.stringify(r.ok)}`,
    `"exit_code":${serializeExitCode(r.exit_code)}`,
  ];
  if (r.blocked === true) {
    parts.push(`"blocked":${JSON.stringify(r.blocked)}`);
  }
  if (r.ok === false) {
    // Discriminated union: in the false branch, error_code is string.
    parts.push(`"error_code":${JSON.stringify(r.error_code)}`);
  }
  parts.push(`"duration_ms":${serializeDurationMs(r.duration_ms)}`);
  if (r.stderr_truncated === true) {
    parts.push(`"stderr_truncated":${JSON.stringify(r.stderr_truncated)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Serialize a ToolCallDeniedRecord in locked field order.
 *
 * Locked order:
 *   schema_version, event, ts, tool_name, ok, error_code,
 *   reserved, exposed, [reason]
 */
function serializeToolCallDeniedRecord(r: ToolCallDeniedRecord): string {
  const parts: string[] = [
    `"schema_version":${JSON.stringify(r.schema_version)}`,
    `"event":${JSON.stringify(r.event)}`,
    `"ts":${JSON.stringify(r.ts)}`,
    `"tool_name":${JSON.stringify(r.tool_name)}`,
    `"ok":${JSON.stringify(r.ok)}`,
    `"error_code":${JSON.stringify(r.error_code)}`,
    `"reserved":${JSON.stringify(r.reserved)}`,
    `"exposed":${JSON.stringify(r.exposed)}`,
  ];
  if (r.reason !== undefined) {
    parts.push(`"reason":${JSON.stringify(r.reason)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Serialize a ServerIntegrityFailureRecord in locked field order.
 *
 * Locked order:
 *   schema_version, event, ts, reason
 */
function serializeServerIntegrityFailureRecord(r: ServerIntegrityFailureRecord): string {
  const parts: string[] = [
    `"schema_version":${JSON.stringify(r.schema_version)}`,
    `"event":${JSON.stringify(r.event)}`,
    `"ts":${JSON.stringify(r.ts)}`,
    `"reason":${JSON.stringify(r.reason)}`,
  ];
  return `{${parts.join(",")}}`;
}

/**
 * Dispatch to the correct per-shape serializer based on event tag.
 *
 * Exhaustive over AuditRecord's 3 variants. The `_exhaustive: never`
 * assignment in the default branch is the standard discriminated-
 * union exhaustiveness check: if a 4th variant is ever added to
 * AuditRecord without a matching case here, TypeScript fails the
 * compile at the `never` assignment.
 */
function serializeRecord(r: AuditRecord): string {
  switch (r.event) {
    case "tool_call":
      return serializeToolCallRecord(r);
    case "tool_call_denied":
      return serializeToolCallDeniedRecord(r);
    case "server_integrity_failure":
      return serializeServerIntegrityFailureRecord(r);
    default: {
      const _exhaustive: never = r;
      throw new Error(`unreachable audit record event: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Append-only NDJSON audit log writer. record() and close() are the
 * only methods. Construct via openAuditLog().
 */
export interface AuditWriter {
  /**
   * Append one audit record. The writer injects schema_version (1)
   * and ts (ISO-8601 UTC) on every call -- callers cannot supply
   * those fields.
   *
   * Rejects with McpAuditWriteError if:
   *   - close() has already been called
   *   - record serialization/timestamp generation fails
   *   - the underlying appendFile fails
   *
   * Concurrent record() calls land in deterministic call order
   * (the writer extends the tail promise SYNCHRONOUSLY before its
   * first await).
   */
  record(entry: AuditRecordInput): Promise<void>;

  /**
   * Idempotent close: awaits any in-flight record() calls, then
   * closes the FileHandle. Subsequent record() calls reject. Second
   * close() returns the same Promise as the first.
   *
   * Always closes the FileHandle even if the tail rejected -- the
   * file handle is OS state that must be released regardless of
   * audit failure status. If BOTH tail and close fail, throws
   * McpAuditWriteError with cause=tailError and
   * secondaryCause=closeError.
   */
  close(): Promise<void>;
}

/**
 * Open the audit log at <repoRoot>/.viberevert/mcp-audit.log in
 * append mode.
 *
 * repoRoot MUST be absolute. Audit writes are security/integrity
 * artifacts; they must NEVER depend on ambient process.cwd() or
 * relative-path interpretation. Same defensive shape as
 * runCommandInProcess.
 *
 * mkdir/open failures wrap as McpAuditWriteError so the direct-
 * error model holds (no leaking ENOENT/EACCES/EPERM as raw Node
 * errors). The RangeError for a non-absolute repoRoot stays raw --
 * it's a programmer error, not an audit write failure.
 */
export async function openAuditLog(opts: {
  repoRoot: string;
  now?: () => Date;
}): Promise<AuditWriter> {
  // Programmer-error class: stays outside the try block. Caller
  // gave us a non-absolute path -- that's a contract violation,
  // not an audit infrastructure failure.
  if (!isAbsolute(opts.repoRoot)) {
    throw new RangeError(
      `openAuditLog: repoRoot must be an absolute path; got ${JSON.stringify(opts.repoRoot)}`,
    );
  }

  const now = opts.now ?? (() => new Date());
  const dir = viberevertDir(opts.repoRoot);

  try {
    await mkdir(dir, { recursive: true });
    const fh = await open(join(dir, "mcp-audit.log"), "a");
    return new AuditWriterImpl(fh, now);
  } catch (err) {
    throw new McpAuditWriteError("audit log open failed", { cause: err });
  }
}

// ============================================================================
// Implementation
// ============================================================================

class AuditWriterImpl implements AuditWriter {
  private tail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly fh: FileHandle,
    private readonly now: () => Date,
  ) {}

  async record(entry: AuditRecordInput): Promise<void> {
    if (this.closePromise !== null) {
      throw new McpAuditWriteError("audit: record() after close()");
    }
    // Serialization happens BEFORE chain extension so a bad input
    // (e.g. now() returning an invalid Date, duration_ms = NaN)
    // surfaces as a wrapped McpAuditWriteError WITHOUT poisoning
    // the append chain. Subsequent record() calls with valid inputs
    // can still succeed.
    //
    // Trusted fields AFTER spread: a runtime caller cannot override
    // schema_version or ts despite TypeScript's Omit on the input
    // type. The audit log's integrity depends on the writer owning
    // these fields.
    let line: string;
    try {
      const finalized = {
        ...entry,
        schema_version: 1 as const,
        ts: this.now().toISOString(),
      } as AuditRecord;
      if ("tool_name" in finalized) {
        finalized.tool_name = sanitizeToolName(finalized.tool_name);
      }
      line = `${serializeRecord(finalized)}\n`;
    } catch (err) {
      throw new McpAuditWriteError("audit record serialization failed", { cause: err });
    }

    // Extend the chain SYNCHRONOUSLY before the first await so
    // concurrent record() calls land in deterministic call order.
    // The .catch wraps raw appendFile rejections as McpAuditWriteError
    // BEFORE storing in this.tail, so close()'s tail-await sees the
    // branded class directly. Natural chain-poison behavior is
    // preserved: subsequent record() calls await a rejected tail
    // that already carries the brand.
    const write = this.tail
      .then(() => this.fh.appendFile(line, "utf8"))
      .catch((err: unknown) => {
        if (err instanceof McpAuditWriteError) {
          throw err;
        }
        throw new McpAuditWriteError("audit appendFile failed", { cause: err });
      });
    this.tail = write;
    await write;
  }

  close(): Promise<void> {
    if (this.closePromise !== null) {
      // Idempotent: second close returns the first close's promise.
      return this.closePromise;
    }
    this.closePromise = (async () => {
      let tailError: unknown;
      try {
        await this.tail;
      } catch (err) {
        tailError = err;
      }
      let closeError: unknown;
      try {
        // MUST run close() even when tail rejected, to avoid
        // leaking the FileHandle. The OS handle is independent
        // state from the application-level audit chain.
        await this.fh.close();
      } catch (err) {
        closeError = err;
      }
      if (tailError !== undefined && closeError !== undefined) {
        // Preserve both: tail is upstream (more diagnostic);
        // close is auxiliary. secondaryCause keeps the close
        // failure addressable for downstream observers.
        throw new McpAuditWriteError("audit append failed AND FileHandle close also failed", {
          cause: tailError,
          secondaryCause: closeError,
        });
      }
      if (tailError !== undefined) {
        // Tail is already branded (record() wraps in its .catch
        // before storing in this.tail), so re-throw as-is to
        // preserve object identity. The instanceof guard handles
        // a defensive future case where tail somehow holds a
        // non-branded rejection.
        throw tailError instanceof McpAuditWriteError
          ? tailError
          : new McpAuditWriteError("audit append failed", { cause: tailError });
      }
      if (closeError !== undefined) {
        throw new McpAuditWriteError("audit FileHandle close failed", {
          cause: closeError,
        });
      }
    })();
    return this.closePromise;
  }
}
