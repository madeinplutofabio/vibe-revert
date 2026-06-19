# VibeRevert MCP server contract

Authoritative reference for implementers of clients, integrations, and
downstream tools that connect to the VibeRevert MCP server. Every shape
in this document is locked by the implementation in
`packages/mcp/src/**` and exercised by tests in `packages/mcp/test/**`
plus the `scripts/smoke-test.ps1` Phase 12f end-to-end probe.

Status: M G1a Step 6 / v0.7.0-beta. Server runs over stdio; HTTP/SSE
transports and human-approval execution are out of scope. See section
1.1 (Non-goals) for the exhaustive negative scope and section 1.3 for
intentionally non-obvious behavior.

## 1. Overview

The VibeRevert MCP server is a Model Context Protocol server exposing
8 tools over stdio (newline-delimited JSON-RPC 2.0). It is
implemented against the low-level `Server` class from
`@modelcontextprotocol/sdk@1.29.0` (NOT the high-level `McpServer`
class). The dispatcher owns input validation, response shaping, and
audit emission end-to-end so denied-tool calls are auditable on equal
terms with successful calls.

The server is config-blind at boot (does not require
`.viberevert.yml`); tools that need config load it on demand.

The server binds to one repo root at boot via `resolveRepoRoot(cwd)`
and never accepts a per-call cwd or target-repo parameter. One server
process is one repo is one audit log.

### 1.1 Non-goals / Explicitly absent

These are intentionally NOT in v0.7.0-beta:

- No HTTP/SSE transport. Stdio only.
- No `rollback` execution tool exposed. `rollback` is a reserved
  name (see section 5); calls to it are denied with the same shape as
  any unknown name. A future `preview_rollback` tool may land in
  M G3 with real HITL semantics.
- No `request_human_approval` execution tool exposed. Reserved
  name; same denial shape as `rollback`.
- No CLI/process writes from the MCP library. `packages/mcp/src/**`
  never calls `process.stdout.write`, `process.stderr.write`, or
  `process.exit`. The SDK owns protocol stdio; the CLI's `MCPCommand`
  wrapper owns human-facing stderr + exit codes.
- No adapters / installers / platform integration in
  `packages/mcp/src/**`. Those engines (`@viberevert/adapters`,
  `@viberevert/installers`) are M G1b scope. The MCP package cannot
  import them by workspace specifier or by local path (D99.M.5).
- No per-call cwd / target_repo / repo / repo_path /
  working_directory parameter. Tools bind to the boot-time repo
  only. Multi-repo MCP is a separate milestone.
- No raw arguments in the audit log. Audit records carry the
  sanitized tool name + outcome, never the call arguments.
- No cancellation tokens. Side-effecting tools (class B) run to
  completion; timing them out would orphan their writes. M G2+ may
  revisit.

### 1.2 Implementation traceability

| Contract area | Source |
| --- | --- |
| Tool order / reserved names / side-effect class | `packages/mcp/src/tools.ts` |
| Tool registry (per-tool definitions + handlers) | `packages/mcp/src/tool-registry.ts` |
| Per-tool implementation | `packages/mcp/src/tools/<tool-name>.ts` |
| `startServer` boot + dispatcher + response shapes | `packages/mcp/src/server.ts` |
| Envelope + constructor-keyed error map | `packages/mcp/src/envelope.ts` |
| Direct-code registry + 4 error classes | `packages/mcp/src/errors.ts` |
| Audit NDJSON writer + 4 record families / 5 serialized shapes | `packages/mcp/src/audit.ts` |
| Timeout primitive + class-A 30s wrap | `packages/mcp/src/timeout.ts`, `packages/mcp/src/server.ts` |
| Raw capture caps (`runCommandInProcess`) | `packages/cli-commands/src/run-command-in-process.ts` |
| CLI `MCPCommand` (loader seam, exit codes) | `packages/cli/src/commands/mcp.ts` |
| Architectural invariants D99.M.1-22 | `packages/cli/test/architectural-invariants.test.ts` |
| Stdio end-to-end tests | `packages/mcp/test/stdio-server.test.ts` |
| Packed-CLI Phase 12f smoke | `scripts/smoke-test.ps1` |

### 1.3 Intentionally non-obvious behavior

These behaviors are correct by design. Do NOT "simplify" them:

- Cat 2 denials are JSON-RPC SUCCESS envelopes with
  `result.isError === true`, NOT top-level JSON-RPC errors. (Cat 4
  integrity throws ARE top-level errors -- different shape.)
- Cat 1 `ok:false` ALSO sets `result.isError === true`. Both Cat 1
  ok:false and Cat 2 emit `isError: true`; the discriminator
  between them is `result.structuredContent` (present on Cat 1,
  absent on Cat 2).
- Success responses OMIT `isError`; they do NOT set `isError: false`.
  The SDK treats the field as optional; explicit `false` is a
  contract violation.
- Stdin EOF does NOT immediately close the server. The in-flight
  handler gate defers `signalGraceful` until `activeHandlers === 0`,
  then a `setImmediate` defer lets the SDK flush the in-flight
  response before transport close.
- Arbitrary unknown tool names are NEVER echoed in either responses
  or audit. Audit uses the `<unknown>` sentinel (R31).
- Side-effecting tools (class B) have NO timeout in G1a (R17). Racing
  them would destroy audit truth without real cancellation tokens.
- The Cat 2 wire message is literally `"MCP error -32602: Tool not
  found"` -- the `-32602` is INSIDE the text because the SDK does
  NOT auto-prepend to `result.content` text (only to thrown
  `McpError` messages). Removing the prefix would corrupt the
  SDK-compatible shape.
- The audit `tool_name` field is sanitized to printable ASCII +
  capped at 64 chars BEFORE being written. Non-ASCII bytes (CR/LF
  injection attempts) become `?`.
- Audit `schema_version` is always FIRST in the serialized JSON,
  before `event`. Locked for file-consumer compatibility.

## 2. Boot + lifecycle

### 2.1 `startServer({cwd}): Promise<void>` (locked contract)

```ts
export async function startServer(opts: { cwd: string }): Promise<void>;
```

Resolves on graceful shutdown (SIGINT, SIGTERM, stdin EOF, or
transport close). Rejects on boot failure (`McpBootError`) or
unhealthy shutdown (audit append failure during a denied-tool
probe, transport error).

Locked behavior:

- `resolveRepoRoot(opts.cwd)` runs at boot. Failure wraps as
  `McpBootError("MCP server boot failed: repo root not resolved",
  {cause})`.
- `openAuditLog({repoRoot})` runs at boot. Failure wraps as
  `McpBootError("MCP server boot failed: audit log open failed",
  {cause})`.
- Exactly ONE audit log file handle is opened at boot, held for the
  server's lifetime, closed during shutdown cleanup (D99.K).
- Server NEVER calls `process.exit`. Returns / rejects only.
- Server NEVER writes to `process.stdout` or `process.stderr`. The
  SDK owns stdio for protocol traffic.

### 2.2 Stdin EOF + in-flight shutdown gate (locked)

The SDK's low-level `Server` + `StdioServerTransport` does NOT reliably
emit `server.onclose` on stdin EOF across all process-wrapper
combinations. The server installs its own `process.stdin` `"end"` +
`"close"` listeners pre-connect and routes them through an in-flight
handler gate:

- `signalGraceful` fires only when BOTH `stdinClosed === true` AND
  `activeHandlers === 0`.
- When EOF arrives mid-handler, the gate defers; when the last
  handler's `finally` decrements `activeHandlers` to 0, the gate
  schedules a `setImmediate` re-check.
- The `setImmediate` defer is required because the SDK serializes +
  writes the JSON-RPC response AFTER the handler Promise resolves;
  synchronous `signalGraceful` would race `server.close()` against
  the SDK's pending write.

Result: in-flight handlers complete their response writes AND the
audit-record serialized tail flushes before transport close.

### 2.3 Shutdown signals

All paths converge on `shutdown.signalGraceful` which is idempotent
(only the FIRST signal matters):

- `server.onclose` (SDK transport close)
- `SIGINT`, `SIGTERM` (process signals)
- `process.stdin` `"end"` / `"close"` (stdin EOF, via the in-flight gate)

Unhealthy shutdown (`shutdown.signalUnhealthy`) is triggered by:

- `server.onerror` (transport error)
- Audit append failure during a denied-tool probe (Cat 2 path) --
  deferred via `setImmediate` so the McpError response reaches the
  client before transport close

## 3. Stdio transport

### 3.1 Framing (locked)

Newline-delimited JSON-RPC 2.0. One JSON-RPC message per line.
Locked: `JSON.stringify(msg) + "\n"`. CRLF tolerated on read.

NOT LSP `Content-Length` framing.

### 3.2 `initialize` handshake (locked protocolVersion)

Client sends:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "<client-name>", "version": "<client-version>" }
  }
}
```

Server responds (locked):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "@viberevert/mcp", "version": "0.0.0" }
  }
}
```

The `protocolVersion` value `"2025-06-18"` is locked by D99.Y.

Client then sends `notifications/initialized` (no `id`, no response
expected):

```json
{ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} }
```

## 4. Tool catalog

Locked 8-element tuple per `TOOL_NAMES_IN_ORDER` in
`packages/mcp/src/tools.ts`. `tools/list` MUST emit tools in this
exact order.

| # | Name | Side-effect class (D99.V) | Side effects | Implementation path |
|---|---|---|---|---|
| 1 | `check_repo` | B | Persists ReportFile under `.viberevert/` | `packages/mcp/src/tools/check-repo.ts` |
| 2 | `explain_diff` | A | Reads existing ReportFile only | `packages/mcp/src/tools/explain-diff.ts` |
| 3 | `classify_risk` | A | Reads existing ReportFile only | `packages/mcp/src/tools/classify-risk.ts` |
| 4 | `list_risky_files` | A | Reads existing ReportFile only | `packages/mcp/src/tools/list-risky-files.ts` |
| 5 | `get_policy` | A | Reads `.viberevert.yml` only | `packages/mcp/src/tools/get-policy.ts` |
| 6 | `start_session` | B | Writes session dir + checkpoint + active-session lock | `packages/mcp/src/tools/start-session.ts` |
| 7 | `create_checkpoint` | B | Writes checkpoint dir + receipt | `packages/mcp/src/tools/create-checkpoint.ts` |
| 8 | `generate_fix_prompt` | B | Writes sibling `fix-prompt.txt` via atomic temp+rename | `packages/mcp/src/tools/generate-fix-prompt.ts` |

Per-tool input/output detail in section 15.

## 5. Reserved names policy

Locked 2-element tuple per `RESERVED_TOOL_NAMES`:

- `rollback`
- `request_human_approval`

Locked behavior:

- MUST NOT appear in `tools/list`.
- MUST be denied by the dispatcher with the same Cat 2 wire shape
  as any other unknown name (see section 7.2). No leak distinguishes
  reserved from arbitrary unknown at the wire level.
- MUST be audited as `tool_call_denied` with `reserved: true` and
  `reason: "reserved_approval_gated_not_exposed"`.
- Per R31, the response text uses the GENERIC message `"MCP error
  -32602: Tool not found"` -- the requested name is NEVER echoed.
- The audit log uses verbatim echo for reserved names (the name
  is in a controlled set; echoing is safe) and the `<unknown>`
  sentinel for arbitrary unknown names (preventing the audit log
  from becoming an arbitrary-name reflection sink). See section 9.

## 6. Envelope

Discriminated union returned by every tool handler. Source:
`packages/mcp/src/envelope.ts`.

```ts
export type ToolEnvelope<TData> =
  | { ok: true; data: TData }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
```

All envelope object schemas are strict (extra keys rejected).
`error.code` is a stable string from one of two sources:

1. Constructor-keyed map (`MCP_ERROR_CODE_MAP`, 19 entries) for
   VibeRevert domain errors (14 from cli-commands + 5 from core).
   Lookup is by exact constructor identity (`err.constructor`);
   subclasses without their own entry fall through to
   `INTERNAL_ERROR`.
2. Direct codes (`MCP_DIRECT_ERROR_CODES`, 4 entries) emitted by
   the dispatcher / handlers when a condition is detected WITHOUT a
   thrown exception (return-flag or safeParse-Result patterns):
   - `MCP_TOOL_TIMEOUT` -- class A timeout (D99.V)
   - `MCP_AUDIT_WRITE_FAILED` -- audit append failed on Cat 1 path
   - `MCP_COMMAND_OUTPUT_TOO_LARGE` -- raw capture truncation
     (D99.W) on a stdout-parsing tool
   - `INVALID_TOOL_INPUT` -- handler-side safeParse rejected input

The two sets are disjoint (asserted by tests). The direct-code
list is `Object.freeze`d at module init.

### 6.1 `error.message` sanitization

The free-form `message` field passes through `sanitizeMessage`:

- Strip ASCII control chars (`0x00`-`0x1F`, `0x7F`) -> space
- Collapse whitespace runs -> single space; trim
- Cap at 512 chars with `"... (truncated)"` suffix

Never reads `err.stack`. Per-issue messages on the `INVALID_TOOL_INPUT`
shape are further scrubbed (R31) to strip raw input values and
unrecognized-key names; see section 7.3.

## 7. Dispatcher response shapes (P11 4-category matrix)

Locked per D99.O. Four categories distinguish what the dispatcher
emits AND how the audit reflects it. Categories 1-3 emit JSON-RPC
success envelopes (no top-level `error`); only Category 4 emits a
JSON-RPC error envelope. Clients MUST branch on the success/error
envelope shape, NOT on `result.isError` alone.

### 7.1 Category 1 -- tool-level success or failure

Tool name was found; handler ran; handler returned a `ToolEnvelope`.
Covers both `ok: true` (success) and `ok: false` (mapped CLI error
OR direct-emitted code). Wire shape template (locked; placeholders
are not literal values):

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "content": [{ "type": "text", "text": "<JSON.stringify(envelope)>" }],
    "structuredContent": "<envelope>",
    "isError": "<true if envelope.ok === false, omitted otherwise>"
  }
}
```

- `structuredContent` IS the `ToolEnvelope` itself.
- `content[0].text` is `JSON.stringify(structuredContent)` byte-for-byte.
- `isError: true` ONLY when `envelope.ok === false`. OMITTED on
  success -- do NOT emit `isError: false`.

### 7.2 Category 2 -- tool name not found (reserved OR unknown)

Locked wire shape (identical for reserved AND truly-unknown names):

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "content": [{ "type": "text", "text": "MCP error -32602: Tool not found" }],
    "isError": true
  }
}
```

- Text is locked verbatim to `"MCP error -32602: Tool not found"`.
- The `-32602` is INSIDE the text (SDK auto-prepend does NOT apply to
  `result.content` text -- only to thrown `McpError` messages).
- NO `structuredContent` (signals "no typed payload").
- Per R31, the tool name is NOT echoed in the text.

### 7.3 Category 3 -- invalid input on a known tool

The Slice 3.6 contract centralizes invalid-input handling INSIDE each
tool handler (`toInvalidToolInputEnvelope`), not in the dispatcher.
The dispatcher sees a Cat 1 `ok: false` envelope with
`error.code: "INVALID_TOOL_INPUT"`. The wire shape is therefore a
Cat 1 ok:false envelope, not a separate Cat-3 text-only return.

Envelope shape (locked):

```ts
{
  ok: false,
  error: {
    code: "INVALID_TOOL_INPUT",
    message: "<tool_name> input failed validation",
    details: {
      issue_count: number,        // ORIGINAL count (not capped)
      truncated: boolean,         // true when issue_count > 25
      issues: Array<{
        code: string,             // Zod's issue.code
        path: readonly string[],  // each segment capped at 128 chars
        message: string           // scrubbed + capped at 256 chars
      }>                          // array capped at 25 entries
    }
  }
}
```

Locked caps:

- `MAX_INVALID_TOOL_INPUT_ISSUES = 25` (issues array length)
- `MAX_INVALID_TOOL_INPUT_ISSUE_MESSAGE_LEN = 256` (per-issue message chars)
- `MAX_INVALID_TOOL_INPUT_ISSUE_PATH_SEGMENT_LEN = 128` (per-path-segment chars)

Per-issue `message` is scrubbed via `scrubZodIssueMessage` (R31):

- `received "..."` / `received '...'` / `received <token>` ->
  `received <value>`
- `Unrecognized key(s): "..."` -> `unrecognized key(s): <key>`
- Control chars stripped to space; whitespace collapsed; trimmed

Raw `ZodIssue` objects are NEVER exposed.

### 7.4 Category 4 -- server-integrity throw (JSON-RPC error envelope)

For broken server invariants (audit append failure on the denied-tool
probe path, transport state corruption). Wire shape (SDK auto-emits
on `throw new McpError(...)`):

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "error": { "code": -32603, "message": "<reason>" }
}
```

- Top-level `error` field. Distinguishes Cat 4 from Cat 1-3 (which
  always emit `result` with `isError` for failures).
- The SDK auto-prepends `"MCP error -32603: "` to thrown
  `McpError(InternalError, ...)` messages (R30). The dispatcher's
  audit-throw sites pass JUST the raw reason; the prefix is
  SDK-applied.
- The dispatcher signals unhealthy shutdown via
  `signalUnhealthyAfterResponse` (setImmediate-deferred) so the
  JSON-RPC error envelope reaches the client BEFORE `startServer`
  rejects.

### 7.5 Summary table

| Trigger | Wire shape | Audit event |
|---|---|---|
| Handler returns `ok: true` | Cat 1 (no `isError`) | `tool_call`, `ok: true` |
| Handler returns `ok: false` | Cat 1 with `isError: true` | `tool_call`, `ok: false`, `error_code: <code>` |
| Handler throws unexpected | Cat 1 via `toErrorEnvelope` -> `INTERNAL_ERROR` | `tool_call`, `ok: false`, `error_code: "INTERNAL_ERROR"` |
| Tool name not registered (reserved or unknown) | Cat 2 | `tool_call_denied` |
| Class-A handler exceeds 30s | Cat 1 via `MCP_TOOL_TIMEOUT` | `tool_call`, `ok: false`, `error_code: "MCP_TOOL_TIMEOUT"`, `exit_code: null` |
| Cat 1 audit failure | Cat 1 with `MCP_AUDIT_WRITE_FAILED` + unhealthy shutdown | (Cat 1 audit write itself failed; no record) |
| Cat 2 audit failure | Cat 4 (JSON-RPC error `-32603`) + unhealthy shutdown | (no audit) |

## 8. Audit log

Locked path: `<boot_repo_root>/.viberevert/mcp-audit.log` (D99.J).

Format: append-only NDJSON, one record per line, UTF-8, LF terminators.

One file handle per server lifetime (D99.K). All writes go through a
single per-server Promise chain so concurrent dispatches cannot
interleave records. NO `fsync` per record (D99.L) -- last few records
may be lost on hard crash; receipts are source-of-truth for state.

`schema_version` is locked to `1` and always emitted FIRST in
every record's serialized JSON (writer-controlled, callers cannot
supply it).

### 8.1 Record families and serialized shapes

The audit writer has **4 record families** and **5 locked serialized
shapes**:

1. `tool_call` ok:true
2. `tool_call` ok:false
3. `tool_call_denied` reserved:true (with `reason`)
4. `tool_call_denied` reserved:false (no `reason`; `tool_name` is the
   `<unknown>` sentinel)
5. `server_integrity_failure`

Field order in serialized NDJSON is locked explicitly via per-shape
serializer functions in `packages/mcp/src/audit.ts`; the writer never
relies on implementation-defined object key order.

#### Shape 1 -- `tool_call` ok:true (locked)

Field order:

```
schema_version, event, ts, tool_name, ok, exit_code, [blocked], duration_ms, [stderr_truncated]
```

Locked example:

```json
{"schema_version":1,"event":"tool_call","ts":"2026-06-19T12:34:56.789Z","tool_name":"get_policy","ok":true,"exit_code":0,"duration_ms":142}
```

Optional fields (`blocked`, `stderr_truncated`) are present only when
the value is `true`. `blocked` is currently only emitted by
`check_repo`. `stderr_truncated` is emitted when the raw capture cap
(D99.W) was hit on stderr.

#### Shape 2 -- `tool_call` ok:false (locked)

Field order:

```
schema_version, event, ts, tool_name, ok, exit_code, [blocked], error_code, duration_ms, [stderr_truncated]
```

Locked example:

```json
{"schema_version":1,"event":"tool_call","ts":"2026-06-19T12:34:56.789Z","tool_name":"check_repo","ok":false,"exit_code":1,"error_code":"INTERNAL_ERROR","duration_ms":54}
```

#### Shape 3 -- `tool_call_denied` reserved:true (locked)

Field order:

```
schema_version, event, ts, tool_name, ok, error_code, reserved, exposed, reason
```

Locked example (`rollback`):

```json
{"schema_version":1,"event":"tool_call_denied","ts":"2026-06-19T12:34:56.789Z","tool_name":"rollback","ok":false,"error_code":"TOOL_NOT_FOUND","reserved":true,"exposed":false,"reason":"reserved_approval_gated_not_exposed"}
```

The `reason` value is locked to `"reserved_approval_gated_not_exposed"`.

#### Shape 4 -- `tool_call_denied` reserved:false (locked)

Field order (NO `reason`):

```
schema_version, event, ts, tool_name, ok, error_code, reserved, exposed
```

Locked example (arbitrary unknown name -- R31 sentinel applies):

```json
{"schema_version":1,"event":"tool_call_denied","ts":"2026-06-19T12:34:56.789Z","tool_name":"<unknown>","ok":false,"error_code":"TOOL_NOT_FOUND","reserved":false,"exposed":false}
```

The `<unknown>` literal is the R31 sentinel; arbitrary unknown
names are NEVER echoed.

#### Shape 5 -- `server_integrity_failure` (locked)

Field order:

```
schema_version, event, ts, reason
```

Emitted as a last-resort diagnostic by the dispatcher when a server
invariant breaks AND the audit append itself is still functional.
When the audit failure IS the trigger (chicken-and-egg), no record is
possible; the McpError throw + CLI-wrapper stderr is the only signal.

### 8.2 `tool_name` sanitization (locked)

The `tool_name` field in `tool_call` and `tool_call_denied` records
passes through `sanitizeToolName`:

```ts
String(name).replace(/[^\x20-\x7E]/g, "?").slice(0, 64)
```

- Non-printable ASCII (including newlines, tabs, control chars) ->
  `?`. Prevents NDJSON injection.
- Caps at 64 characters. Bounds the field for malicious / buggy
  clients sending very long names.

Combined with per-field `JSON.stringify`, embedded quotes and
backslashes are escaped safely.

### 8.3 R31 audit sentinel

For `tool_call_denied` records, the dispatcher writes:

- `tool_name: "<sanitized-name>"` when the name is in
  `RESERVED_TOOL_NAMES` (controlled set; verbatim echo safe)
- `tool_name: "<unknown>"` for ALL other denials (arbitrary unknown
  names are NEVER reflected into the audit log)

This prevents the audit log from becoming an arbitrary-name
reflection sink.

### 8.4 Audit failure policy (locked)

| Path | mkdir/open failure | appendFile failure |
|---|---|---|
| Boot | `startServer` rejects with `McpBootError` | n/a |
| Cat 1 (known tool) | n/a | Cat 1 envelope `{ok: false, error: {code: "MCP_AUDIT_WRITE_FAILED"}}`; unhealthy shutdown deferred |
| Cat 2 (reserved / unknown) | n/a | `throw new McpError(ErrorCode.InternalError, "audit append failed during denied-tool-name probe")`; unhealthy shutdown deferred |

The Cat 1 path emits a Cat 1 wire shape so the client still receives
a structured tool result. The Cat 2 path uses the JSON-RPC error
envelope because no tool ran -- there is no in-flight result to
deliver.

Both deferred-unhealthy paths use `signalUnhealthyAfterResponse` /
`setImmediate` so the current response reaches the SDK BEFORE
`startServer` rejects.

### 8.5 NEVER logged

- Raw tool arguments (`input` / `args` / `arguments` fields
  intentionally do NOT exist on any record shape)
- Stack traces (no `stack` / `cause_stack` field)
- Free-form error messages from caught errors (only `error_code` is
  logged; sanitized messages go to the wire envelope only)

## 9. R31 reflection locks

Cross-cutting protection: arbitrary attacker-supplied text MUST NOT
reflect into responses or audit. Verified at three layers:

1. Cat 2 wire text uses the GENERIC `"MCP error -32602: Tool not
   found"` (section 7.2). Tool name is NEVER echoed.
2. Audit `tool_name` field uses the `<unknown>` sentinel for
   arbitrary unknown names (section 8.3). Phase 12f smoke
   byte-asserts the literal `made_up_tool` substring is absent from
   the audit log file.
3. Cat 3 `INVALID_TOOL_INPUT` issues scrub raw input values and
   unrecognized key names via `scrubZodIssueMessage` (section 7.3).
   Snapshot tests include a `SECRET_SENTINEL_DO_NOT_LOG` regression
   value.

## 10. Output caps (D99.U)

Per-tool MCP-response caps. Each cap applies only to the MCP wire
response. On-disk artifacts (persisted ReportFile, sibling
`fix-prompt.txt`) are NEVER affected by these caps; truncation is
response-layer only.

| Tool | Field | Cap | Truncation discriminator |
|---|---|---|---|
| `check_repo` | full `report` JSON byte size | 1 MiB (`1_048_576`) | Shape switch: `data.report` -> `data.report_summary` with `truncated: true`, `bytes_omitted: <n>`, `findings_omitted: <n>` |
| `explain_diff` | `markdown` byte size | 256 KiB (`256 * 1024`) | `data.truncated: true`, `data.bytes_omitted: <n>` |
| `list_risky_files` | `files` array length | 500 entries | `data.truncated: true`, `data.omitted_count: <n>` |
| `generate_fix_prompt` | `prompt_text` byte size | 256 KiB (`256 * 1024`) | `data.truncated: true`, `data.bytes_omitted: <n>` |

UTF-8 character boundary is preserved on byte-cap truncation
(text-bearing fields are not cut mid-codepoint).

The `check_repo` 1 MiB cap is a shape switch, not a partial
ReportFile: the response drops `data.report` entirely and emits
`data.report_summary: {report_id?, finding_count, severity_counts,
findings_omitted}`. Consumers MUST branch on `data.truncated`.

The persisted on-disk ReportFile under `.viberevert/reports/<rpt>/`
remains the FULL untruncated artifact in all cases.

## 11. Timeout policy (D99.V)

Tools are partitioned by side-effect class:

- Class A (no side effects): wrapped in `withTimeout(30_000ms,
  toolName)`. Timeout emits `error.code: "MCP_TOOL_TIMEOUT"` +
  audit `error_code: "MCP_TOOL_TIMEOUT"`, `exit_code: null`.
  Abandoning the underlying handler is safe because class A has no
  side effects to orphan.
- Class B (side-effecting): NO timeout in v0.7.0-beta (R17).
  Runs to completion. Without cancellation tokens, racing a write
  tool would produce `MCP_TOOL_TIMEOUT` while the underlying handler
  mutates state in the background -- destroying audit truth.

Per-tool classification (locked in `TOOL_SIDE_EFFECT_CLASS_BY_NAME`):

- Class A: `explain_diff`, `classify_risk`, `list_risky_files`,
  `get_policy`
- Class B: `check_repo`, `start_session`, `create_checkpoint`,
  `generate_fix_prompt`

`check_repo` is class B because `CheckCommand` persists a ReportFile
under `.viberevert/`. May move to class A only when a confirmed
no-persist mode is added in a future milestone.

`CLASS_A_TIMEOUT_MS = 30_000` (locked constant in
`packages/mcp/src/server.ts`).

## 12. Raw capture limits (D99.W)

The `command-harness` backend (used by `check_repo`, `explain_diff`,
`classify_risk`, `list_risky_files`) calls `runCommandInProcess` to
host a CLI Command in-process. Captured stdout/stderr is bounded
BEFORE the response-layer D99.U cap can apply.

Locked defaults (`packages/cli-commands/src/run-command-in-process.ts`):

- stdout: 8 MiB (`8 * 1024 * 1024`, `DEFAULT_STDOUT_CAP`)
- stderr: 512 KiB (`512 * 1024`, `DEFAULT_STDERR_CAP`)

Backpressure: writes past the cap are drained-and-discarded (the
Command's `context.stdout.write` never blocks); the harness returns
`stdoutTruncated: true` + `stdoutBytesOmitted: <n>` flags.

Handler policy when `stdoutTruncated: true`:

- Stdout-parsing tools (`check_repo`, `explain_diff`, `classify_risk`,
  `list_risky_files`) MUST return `{ok: false, error: {code:
  "MCP_COMMAND_OUTPUT_TOO_LARGE"}}` -- they CANNOT fabricate a
  partial result from truncated bytes.
- `stderr_truncated: true` is reflected on the audit record
  (`stderr_truncated: true` field) but does NOT fail the call.
  Stderr is diagnostic, not structured.

## 13. Library discipline (D99.M.14, D99.M.18)

`packages/mcp/src/**` is forbidden from:

- `process.exit` (any form)
- `process.stdout.write` / `process.stderr.write`
- Importing `clipanion` directly
- Importing `child_process` / `node:child_process`
- Importing `node:http` / `https` / `net` / `dgram`
- Importing any known LLM SDK
- Importing `@viberevert/adapters` or `@viberevert/installers`
  (workspace OR local-path forms; see D99.M.5)
- Importing `@viberevert/checks`, `@viberevert/reporters`,
  `@viberevert/git` (use cli-commands harness instead)
- Deep imports from `@viberevert/cli-commands` (barrel only)
- Importing the `viberevert` CLI binary package

The SDK owns protocol stdio. The CLI's `MCPCommand` wrapper owns
human-facing stderr + exit codes. The library returns / rejects /
throws; it never writes to processes.

The Step 4 stdin-EOF shutdown patch installs handlers on
`process.stdin` (a permitted operation) and removes them in cleanup
paths so listeners do not leak across repeated `startServer`
invocations in the same process.

## 14. Cold-start discipline (D99.N, D99.M.12)

`MCPCommand` lives in `packages/cli/src/commands/mcp.ts` (the CLI
binary package), NOT in `@viberevert/cli-commands` and NOT in
`@viberevert/mcp`. This is the runtime form of the D99.N injectable
loader seam: the MCP package is dynamically imported only when the
user actually runs `viberevert mcp serve`, keeping the SDK + audit
writer + Zod schemas + tool registry off the cold path of non-mcp
invocations (`viberevert --version`, `doctor`, `init`, etc.).

Architecturally enforced (D99.M.12 sub-check 3): ZERO static
`@viberevert/mcp` `ImportDeclaration` nodes across
`packages/cli/src/index.ts` AND `packages/cli/src/commands/mcp.ts`.
Allowed: `typeof import("@viberevert/mcp")` (type position) and
`import("@viberevert/mcp")` (dynamic-import CallExpression -- the
loader seam).

## 15. Per-tool worked examples

Section 15 examples are abbreviated response examples. Unless a
field is the subject of the example, `content[0].text` is omitted
for readability. The full wire-shape contract remains Section 7:
every Cat 1 response includes
`content[0].text === JSON.stringify(structuredContent)`.

Inner `data` objects are representative unless the subsection labels
a field as locked. The locked contracts live in Sections 7, 8, 10,
11, and 12; Section 15 illustrates how they manifest per tool.

One compact example per tool.

### 15.1 `check_repo`

Input (representative):

```json
{ "since": "HEAD~3", "threshold": "high" }
```

Success response (Cat 1 ok:true; small report fits under the 1 MiB
cap; `content[0].text` abbreviated):

```json
{
  "result": {
    "structuredContent": {
      "ok": true,
      "data": {
        "report": { "schema_version": "1.0", "report_id": "rpt_<ULID>", "report": { "results": [] } },
        "exit_code": 0,
        "blocked": false
      }
    }
  }
}
```

Truncated response (report > 1 MiB; shape switch). Locked fields:
`truncated`, `bytes_omitted`, `report_summary` (replacing `report`):

```json
{
  "result": {
    "structuredContent": {
      "ok": true,
      "data": {
        "report_summary": {
          "report_id": "rpt_<ULID>",
          "finding_count": 1832,
          "severity_counts": { "critical": 12, "high": 308, "medium": 904, "low": 608 },
          "findings_omitted": 1832
        },
        "exit_code": 2,
        "blocked": true,
        "truncated": true,
        "bytes_omitted": 524288
      }
    }
  }
}
```

### 15.2 `explain_diff`

Input (representative):

```json
{ "report": "rpt_<ULID>" }
```

Success response (Cat 1 ok:true; markdown fits under the 256 KiB cap):

```json
{
  "result": {
    "structuredContent": {
      "ok": true,
      "data": {
        "markdown": "## Findings\n\n- ...",
        "report_id": "rpt_<ULID>",
        "report_metadata": { "written_at": "<ISO-8601>", "since_kind": "checkpoint_name" }
      }
    }
  }
}
```

### 15.3 `classify_risk`

Input (representative):

```json
{ "report": "rpt_<ULID>" }
```

Success response:

```json
{
  "result": {
    "structuredContent": {
      "ok": true,
      "data": { "critical": 2, "high": 5, "medium": 11, "low": 3 }
    }
  }
}
```

### 15.4 `list_risky_files`

Input (representative):

```json
{ "report": "rpt_<ULID>" }
```

Success response (sorted by `[max_severity DESC, finding_count DESC,
path ASC]`):

```json
{
  "result": {
    "structuredContent": {
      "ok": true,
      "data": {
        "files": [
          { "path": "src/config.py", "max_severity": "critical", "finding_count": 1 },
          { "path": "src/auth.py", "max_severity": "high", "finding_count": 3 }
        ]
      }
    }
  }
}
```

Capped response (>500 files; locked fields: `truncated`,
`omitted_count`):

```json
{
  "result": {
    "structuredContent": {
      "ok": true,
      "data": {
        "files": ["...500 entries..."],
        "truncated": true,
        "omitted_count": 47
      }
    }
  }
}
```

### 15.5 `get_policy`

Input: `{}` (zero-arg).

Success response (config present; inner `data` shape is
representative):

```json
{
  "result": {
    "structuredContent": {
      "ok": true,
      "data": {
        "risk": { "block_on": "critical", "warn_on": "medium" },
        "frameworks": [],
        "checks_enabled": {
          "secrets": true, "dependencies": true, "migrations": true,
          "auth": true, "payments": true, "infra": true,
          "tests": true, "scope_expansion": true
        },
        "rollback_exclude": []
      }
    }
  }
}
```

Failure response (no `.viberevert.yml` at boot repo root; locked
`error.code`):

```json
{
  "result": {
    "structuredContent": {
      "ok": false,
      "error": {
        "code": "CONFIG_NOT_FOUND",
        "message": "<sanitized message from ConfigNotFoundError>"
      }
    },
    "isError": true
  }
}
```

### 15.6 `start_session`

Input (representative):

```json
{ "task": "fix auth bug" }
```

Success response (locked field names: `session_id`, `checkpoint_id`,
`started_at`):

```json
{
  "result": {
    "structuredContent": {
      "ok": true,
      "data": {
        "session_id": "sess_<ULID>",
        "checkpoint_id": "cp_<ULID>",
        "started_at": "<ISO-8601 UTC>"
      }
    }
  }
}
```

### 15.7 `create_checkpoint`

Input (representative):

```json
{ "name": "before-refactor" }
```

Success response (locked field names: `checkpoint_id`, `created_at`):

```json
{
  "result": {
    "structuredContent": {
      "ok": true,
      "data": {
        "checkpoint_id": "cp_<ULID>",
        "created_at": "<ISO-8601 UTC>"
      }
    }
  }
}
```

### 15.8 `generate_fix_prompt`

Input (representative):

```json
{ "report": "rpt_<ULID>" }
```

Success response (prompt fits under 256 KiB cap; locked field names:
`prompt_text`, `fix_prompt_path`, `source_report_id`):

```json
{
  "result": {
    "structuredContent": {
      "ok": true,
      "data": {
        "prompt_text": "## Failing checks\n\n...",
        "fix_prompt_path": "<absolute path to .viberevert/reports/<rpt>/fix-prompt.txt>",
        "source_report_id": "rpt_<ULID>"
      }
    }
  }
}
```

Truncated response (prompt > 256 KiB; locked fields: `truncated`,
`bytes_omitted`):

```json
{
  "result": {
    "structuredContent": {
      "ok": true,
      "data": {
        "prompt_text": "<256 KiB prefix>",
        "fix_prompt_path": "<absolute path>",
        "source_report_id": "rpt_<ULID>",
        "truncated": true,
        "bytes_omitted": 51200
      }
    }
  }
}
```

Note: the on-disk `fix-prompt.txt` is ALWAYS the FULL untruncated
text (D81 byte-identity); the cap applies only to the
`prompt_text` field in the MCP response (section 10).

## 16. Architectural invariants summary

22 invariants in `packages/cli/test/architectural-invariants.test.ts`
under the `D99.M.*` namespace. Single-line summary per invariant:

| ID | Lock |
|---|---|
| D99.M.1 | `packages/mcp/src/**` does NOT import any known LLM SDK |
| D99.M.2 | `packages/mcp/src/**` does NOT import `child_process` |
| D99.M.3 | `TOOL_NAMES_IN_ORDER` intersects `RESERVED_TOOL_NAMES` = empty |
| D99.M.4 | `TOOL_NAMES_IN_ORDER` exactly equals the locked D99.A 8-tuple |
| D99.M.5 | `packages/mcp/src/**` does NOT import adapters/installers/platform-integration code (workspace OR local-path) |
| D99.M.6 | `packages/mcp/src/**` `@viberevert/core` imports equal exactly the allowed carve-out set |
| D99.M.7 | `packages/mcp/src/audit.ts` fs surface = exactly one each of mkdir / open / appendFile / close |
| D99.M.8 | Exactly one `new Server(`, one `new StdioServerTransport(`, zero `new McpServer(` across `packages/mcp/src/**` |
| D99.M.9 | Every `packages/mcp/src/tools/*.ts` exports exactly `definition` + `handler` |
| D99.M.10 | `packages/mcp/src/**` does NOT import `node:http` / `https` / `net` / `dgram` |
| D99.M.11 | `packages/mcp/package.json` dep map exactly equals locked set |
| D99.M.12 | `MCPCommand` import + register shape locks in `packages/cli/src/index.ts`; cold-start lock across index.ts + commands/mcp.ts |
| D99.M.13 | `packages/mcp/src/**` is ASCII-only at byte level |
| D99.M.14 | `packages/mcp/src/**` does NOT call `process.std{out,err}.write` or `process.exit` |
| D99.M.15 | `packages/cli-commands/src/**` does NOT import `@viberevert/mcp` |
| D99.M.16 | `packages/mcp/src/**` does NOT import the `viberevert` CLI binary |
| D99.M.17 | No tool's `inputSchema` declares a cwd-like field |
| D99.M.18 | `packages/mcp/src/**` does NOT import `clipanion` directly |
| D99.M.19 | `@viberevert/cli-commands` barrel surface lock (required + forbidden exports) |
| D99.M.20 | `packages/cli-commands/src/**` does NOT call `process.std{out,err}.write` / `process.exit` / `console.*` |
| D99.M.21 | `packages/cli-commands/src/operations/*` MUST NOT call `process.cwd` / process streams / `console.*` / `this.context.*` |
| D99.M.22 | Each of the 3 refactored Commands imports its corresponding operation |

## 17. Smoke test coverage (D99.R)

`scripts/smoke-test.ps1` Phase 12f probes the packed binary
end-to-end. Locked sequence:

1. Spawn `pnpm exec viberevert mcp serve` via `System.Diagnostics.Process`
   with pre-buffered stdin + explicit `StandardInput.Close()` to send
   FIN. 30s timeout with `taskkill /T /F` process-tree kill on
   timeout. Concurrent stdout/stderr drain to in-memory buffers.
2. Write 7 input frames (6 requests + 1 `notifications/initialized`
   notification, LF-terminated):
   - `id: 1` `initialize`
   - `notifications/initialized` (no id)
   - `id: 2` `tools/list`
   - `id: 3` `tools/call get_policy`
   - `id: 4` `tools/call rollback`
   - `id: 5` `tools/call request_human_approval`
   - `id: 6` `tools/call made_up_tool`
3. Assert exit code 0 + empty stderr (D99.M.14 byte-channel
   discipline).
4. Parse 6 responses STRICTLY (fail on non-JSON, missing id, duplicate
   id, unexpected id). Match by JSON-RPC `id` per R27 (async dispatch
   may reorder; line-position matching is unsafe).
5. Assert no top-level `error` on any of the 6 responses (Cat 1/2/3
   are JSON-RPC success envelopes).
6. Per-id assertions:
   - id 1: `protocolVersion === "2025-06-18"`
   - id 2: 8 tools in `TOOL_NAMES_IN_ORDER`; reserved names absent
   - id 3: Cat 1 success; `structuredContent.ok === true`;
     `data.risk.block_on` present
   - id 4, 5, 6: Cat 2 shape locked verbatim (`MCP error -32602:
     Tool not found`); `structuredContent` absent; raw name NOT in
     id 6 response JSON (R31 reflection lock)
7. Read `.viberevert/mcp-audit.log`. Assert exactly 4 NDJSON records.
   Select each record by SHAPE (not array index) via predicate
   matching -- audit-write order may differ from request order
   under async dispatch:
   - `event === "tool_call" AND tool_name === "get_policy"`
   - `event === "tool_call_denied" AND tool_name === "rollback"`
   - `event === "tool_call_denied" AND tool_name === "request_human_approval"`
   - `event === "tool_call_denied" AND tool_name === "<unknown>" AND reserved === false`
8. Assert each record's field order via key-array `-join ','`
   comparison against the locked shape (`schema_version` first).
9. Cross-record audit invariants:
   - NO `"input"` / `"args"` / `"arguments"` token in the file
     (D99.J never-log-args)
   - NO `made_up_tool` substring in the file (R31 sentinel
     substitution verified at byte level)

## 18. Contract change protocol

Any change to a locked MCP contract shape MUST update, in the same
commit:

1. Implementation in `packages/mcp/src/**`
2. Fast tests in `packages/mcp/test/**`
3. Architectural invariants in
   `packages/cli/test/architectural-invariants.test.ts` when the
   boundary changes
4. `scripts/smoke-test.ps1` when packed-CLI behavior changes
5. This document (`docs/mcp-contract.md`)

A contract change is not complete if only the implementation changes.

---

## Drafting rules (for editors of this file)

- ASCII-only at byte level. No smart quotes, em-dashes, or non-ASCII
  whitespace. Consistent with `packages/mcp/src/**` byte-level
  discipline (D99.M.13).
- Mark every example explicitly as "locked" or
  "representative"/"illustrative". Locked examples must come from
  the current implementation; verify against source before editing.
- Examples MUST NOT contain realistic credentials, tokens, API keys,
  or scanner-shaped secret fixtures. Use placeholders (`<ULID>`,
  `<absolute path>`, `<ISO-8601>`) for variable values.
- Formatting gate: ASCII-only plus the repository's biome formatting
  for the test files cross-referenced from this doc. This file
  itself is markdown; biome does not format `.md`.
- When `packages/mcp/src/**` source changes a locked shape, update
  this doc in the same commit per Section 18.
