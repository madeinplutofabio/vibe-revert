// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// End-to-end stdio protocol test for the MCP server.
//
// Spawns a real Node subprocess that runs startServer over
// StdioServerTransport (D99.D / D99.M.8 -- the only sites with
// `new Server(` and `new StdioServerTransport(`), then drives it
// over JSON-RPC newline-delimited stdio framing. Asserts wire shape
// for the load-bearing protocol contracts:
//
//   - initialize handshake: protocolVersion negotiation, serverInfo
//   - tools/list: 8 tools in TOOL_NAMES_IN_ORDER catalog order; no
//     reserved names exposed
//   - tools/call known-tool Cat 1 structured envelope round trip:
//     get_policy with no .viberevert.yml -> handler returns Cat 1
//     ok:false envelope (CONFIG_NOT_FOUND); wire shape carries
//     result.content[0].text === JSON.stringify(envelope),
//     result.structuredContent === envelope,
//     result.isError === true.
//   - tools/call unknown name: reserved (rollback) AND constructed
//     credential-shaped unknown -> Cat 2 wire shape (text-only,
//     generic "Tool not found", isError:true, NO structuredContent).
//     R31: response MUST NOT contain the client-supplied name.
//   - Response id matching under concurrency (R27): three in-flight
//     requests get correctly-matched responses via id-based
//     dispatcher.
//
// Build dependency: this test requires packages/mcp/dist/index.js
// to exist AND be up-to-date with src. beforeAll ALWAYS runs
// `pnpm run build` (not stat-based) so stale dist never masks src
// changes. Build outputs (dist/, build.tsbuildinfo) are gitignored;
// `git status --short` after the test gate must show NO build-
// artifact drift (only the known Step 4 source/test changes).
//
// Subprocess design + safety nets:
//   - Per-test tmpdir under os.tmpdir() with a `.viberevert/`
//     subdir (so resolveRepoRoot succeeds). No .viberevert.yml so
//     the get_policy test exercises the CONFIG_NOT_FOUND envelope
//     path.
//   - Spawn `node -e "<inline-import-startServer>"` with cwd set
//     to the tmpdir. Inline code imports startServer from the
//     absolute file:// URL of the built dist/index.js.
//   - JSON-RPC over newline-delimited stdio. The TestServer
//     wrapper class:
//       * id-keyed pending map storing resolve+reject+timer triples
//       * fatalError field PERSISTS protocol violations even when
//         no request is in-flight at the moment they occur;
//         subsequent request() / notify() / shutdown() surface it.
//         Without this, non-JSON stdout emitted BETWEEN requests
//         would be silently lost.
//       * failAllPending(err) sets fatalError + rejects every
//         in-flight request when the subprocess exits, errors, or
//         violates the protocol.
//       * validates jsonrpc:"2.0" on every inbound message; any
//         non-JSON stdout OR missing jsonrpc field is a PROTOCOL
//         VIOLATION that triggers failAllPending (D99.M.14 -- src
//         code must NEVER write human text to stdout).
//       * subprocess exit with pending requests rejects them
//         immediately regardless of code; subprocess exit with
//         non-zero code rejects future requests via fatalError.
//       * stdin write failure rejects the request synchronously
//         instead of silently waiting for timeout.
//       * graceful shutdown via stdin.end() (SDK's
//         transport.onclose -> server.onclose -> graceful exit);
//         shutdown() asserts exit code === 0 AND surfaces
//         fatalError if any protocol violation occurred during
//         the session.
//       * pendingRequestCount() exposed for afterEach leak check.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// ============================================================================
// Paths
// ============================================================================

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_PACKAGE_DIR = pathResolve(THIS_DIR, "..");
const DIST_INDEX = join(MCP_PACKAGE_DIR, "dist", "index.js");

// ============================================================================
// Always-build helper
// ============================================================================

/**
 * Always run `pnpm run build` (the package's locked build script,
 * `tsc -p tsconfig.build.json`) before any subprocess test runs.
 * Not stat-based: a stale dist with newer src would otherwise mask
 * real changes and produce false greens. Cost is ~1-2s per test
 * file (one beforeAll invocation).
 *
 * Build outputs (dist/, build.tsbuildinfo) are gitignored per
 * project conventions, so this does not dirty the working tree.
 */
async function buildMcpPackage(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("pnpm", ["run", "build"], {
      cwd: MCP_PACKAGE_DIR,
      stdio: "inherit",
      // pnpm is a .cmd on Windows; spawn without shell:true fails
      // to find it. Unix shells work either way.
      shell: process.platform === "win32",
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`'pnpm run build' exited with code ${code}`));
    });
  });
}

// ============================================================================
// Subprocess spawn
// ============================================================================

/**
 * Spawn a Node subprocess running startServer({cwd}) where cwd is
 * the tmpdir we've prepared with a `.viberevert/` directory. The
 * inline code uses dynamic import() against the absolute file://
 * URL of dist/index.js -- no package-resolution dance required.
 *
 * stdio: ["pipe", "pipe", "pipe"] gives controllable stdin (for
 * sending JSON-RPC requests) and stdout (for reading responses).
 * stderr is captured by the TestServer wrapper for diagnostics
 * when a test fails or the subprocess crashes.
 */
function spawnServer(cwd: string): ChildProcess {
  const distHref = pathToFileURL(DIST_INDEX).href;
  const entryCode =
    `import(${JSON.stringify(distHref)})` +
    `.then(({ startServer }) => startServer({ cwd: process.cwd() }))` +
    `.catch((e) => { process.stderr.write(String(e?.stack ?? e)); process.exit(1); });`;

  return spawn(process.execPath, ["-e", entryCode], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// ============================================================================
// JSON-RPC test client
// ============================================================================

type JsonRpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

type PendingEntry = {
  readonly resolve: (msg: JsonRpcResponse) => void;
  readonly reject: (err: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/**
 * Wraps a spawned subprocess with id-based JSON-RPC request/response
 * matching, per-request timeout, protocol-violation detection
 * (persisted across requests), and graceful shutdown semantics.
 *
 * Why id-based matching (R27): JSON-RPC responses are NOT guaranteed
 * to arrive in request order under concurrency. The SDK dispatches
 * async, so a fast unknown-tool denial can return before a slow
 * known-tool handler completes. Matching by id keeps tests
 * deterministic regardless of arrival order.
 *
 * Why fatalError is persisted: a protocol violation (non-JSON
 * stdout, missing jsonrpc field) emitted BETWEEN requests has no
 * pending entry to reject. Without persistence, the violation
 * would be silently lost and a later request might appear to
 * succeed despite the server being in a broken state. With
 * persistence, any subsequent request() / notify() / shutdown()
 * surfaces the fatal error.
 */
class TestServer {
  private buf = "";
  private readonly pending = new Map<number, PendingEntry>();
  private nextId = 1;
  private stderrOutput = "";
  private exited = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private fatalError: unknown = null;

  constructor(public readonly subprocess: ChildProcess) {
    subprocess.stdout?.setEncoding("utf8");
    subprocess.stdout?.on("data", (chunk: string) => this.onData(chunk));
    subprocess.stderr?.on("data", (chunk: Buffer) => {
      this.stderrOutput += chunk.toString("utf8");
    });
    subprocess.on("error", (err) => {
      this.failAllPending(err);
    });
    subprocess.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;

      // Pending requests at exit time = unexpected termination
      // regardless of exit code. A clean exit with in-flight
      // requests means the server vanished mid-conversation.
      if (this.pending.size > 0) {
        this.failAllPending(
          new Error(
            `Subprocess exited with pending requests: code=${code} ` +
              `signal=${signal ?? "null"}. ` +
              `Subprocess stderr: ${this.stderrOutput || "(empty)"}`,
          ),
        );
        return;
      }

      // No pending requests but non-zero exit = boot failure /
      // crash. Persist fatalError so future requests fail fast.
      if (code !== 0) {
        this.failAllPending(
          new Error(
            `Subprocess exited before response: code=${code} ` +
              `signal=${signal ?? "null"}. ` +
              `Subprocess stderr: ${this.stderrOutput || "(empty)"}`,
          ),
        );
      }
    });
  }

  private failAllPending(err: unknown): void {
    // Persist the first error so violations emitted between
    // requests are surfaced on the next request() / notify() /
    // shutdown() call. First write wins -- later errors don't
    // overwrite the original diagnostic.
    if (this.fatalError === null) {
      this.fatalError = err;
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;

      // Parse failure = protocol violation. D99.M.14 forbids src
      // code from writing to process.stdout; any non-JSON line is
      // a contract breach. failAllPending persists this even when
      // no request is pending.
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this.failAllPending(
          new Error(
            `Subprocess emitted non-JSON stdout line (protocol violation): ${trimmed.slice(0, 200)}`,
          ),
        );
        continue;
      }

      // Validate JSON-RPC envelope shape. Anything missing
      // jsonrpc:"2.0" is malformed -- fail pending rather than
      // silently accept.
      if (typeof msg !== "object" || msg === null) {
        this.failAllPending(
          new Error(
            `Subprocess emitted non-object JSON-RPC message: ${JSON.stringify(msg).slice(0, 200)}`,
          ),
        );
        continue;
      }
      const m = msg as {
        jsonrpc?: unknown;
        id?: unknown;
        result?: unknown;
        error?: unknown;
      };
      if (m.jsonrpc !== "2.0") {
        this.failAllPending(
          new Error(
            `Subprocess emitted JSON-RPC message without jsonrpc:"2.0": ${JSON.stringify(m).slice(0, 200)}`,
          ),
        );
        continue;
      }

      // Notifications carry no id; tests don't await them.
      if (typeof m.id !== "number") continue;

      const entry = this.pending.get(m.id);
      if (entry !== undefined) {
        this.pending.delete(m.id);
        clearTimeout(entry.timer);
        entry.resolve(m as JsonRpcResponse);
      }
    }
  }

  /**
   * Send a JSON-RPC request and await its matching response.
   * Rejects on persisted fatalError, timeout, stdin failure,
   * subprocess exit, or protocol violation -- never silently
   * hangs.
   */
  async request(method: string, params?: unknown, timeoutMs = 5_000): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const req = { jsonrpc: "2.0" as const, id, method, params };
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      // Surface any persisted protocol violation immediately.
      if (this.fatalError !== null) {
        reject(this.fatalError);
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `JSON-RPC request id=${id} method=${method} timed out after ${timeoutMs}ms. ` +
              `Subprocess stderr: ${this.stderrOutput || "(empty)"}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      const line = `${JSON.stringify(req)}\n`;
      const stdin = this.subprocess.stdin;
      if (stdin === null || stdin.destroyed) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new Error(
            `Subprocess stdin is not writable (exited=${this.exited} ` +
              `code=${this.exitCode} signal=${this.exitSignal ?? "null"}). ` +
              `Subprocess stderr: ${this.stderrOutput || "(empty)"}`,
          ),
        );
        return;
      }
      stdin.write(line, (err) => {
        if (err !== undefined && err !== null) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected).
   * Throws if stdin is unavailable OR if a fatalError has been
   * persisted -- notifications are part of protocol correctness,
   * not best-effort.
   */
  notify(method: string, params?: unknown): void {
    if (this.fatalError !== null) {
      throw this.fatalError;
    }
    const req = { jsonrpc: "2.0" as const, method, params };
    const stdin = this.subprocess.stdin;
    if (stdin === null || stdin.destroyed) {
      throw new Error(`Subprocess stdin is not writable; cannot send notification ${method}`);
    }
    stdin.write(`${JSON.stringify(req)}\n`);
  }

  /**
   * Number of in-flight requests. Used by afterEach to detect
   * fire-and-forget leaks.
   */
  pendingRequestCount(): number {
    return this.pending.size;
  }

  /**
   * Graceful shutdown: close stdin (SDK's transport.onclose ->
   * server.onclose -> graceful exit), assert exit code === 0,
   * surface persisted fatalError (if any), SIGKILL fallback after
   * timeout.
   *
   * Rejects if:
   *   - a fatalError was persisted during the session (protocol
   *     violation, even if it occurred between requests)
   *   - subprocess exits with non-zero code OR signal
   *   - subprocess does not exit within timeoutMs (SIGKILLed)
   *   - subprocess already exited with non-zero code before this
   *     was called
   */
  async shutdown(timeoutMs = 5_000): Promise<void> {
    if (this.exited) {
      // Already exited. Surface fatalError first (it's the most
      // informative diagnostic when a protocol violation
      // triggered the exit). Then check exit code.
      if (this.fatalError !== null) {
        throw this.fatalError;
      }
      if (this.exitCode !== 0) {
        throw new Error(
          `Subprocess already exited before shutdown: code=${this.exitCode} ` +
            `signal=${this.exitSignal ?? "null"}. ` +
            `Subprocess stderr: ${this.stderrOutput || "(empty)"}`,
        );
      }
      return;
    }
    this.subprocess.stdin?.end();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.subprocess.kill("SIGKILL");
        reject(
          new Error(
            `Subprocess did not exit within ${timeoutMs}ms after stdin close. ` +
              `Subprocess stderr: ${this.stderrOutput || "(empty)"}`,
          ),
        );
      }, timeoutMs);
      this.subprocess.on("exit", (code, signal) => {
        clearTimeout(timer);
        // Surface fatalError first so protocol violations that
        // happened during this session (including between
        // requests) are not lost on a clean exit.
        if (this.fatalError !== null) {
          reject(this.fatalError);
        } else if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `Subprocess exited with code=${code} signal=${signal ?? "null"} ` +
                `during shutdown. Subprocess stderr: ${this.stderrOutput || "(empty)"}`,
            ),
          );
        }
      });
    });
  }
}

// ============================================================================
// MCP initialize handshake helper
// ============================================================================

/**
 * Drive the MCP initialize handshake. Client sends initialize
 * request with its supported protocolVersion (D99.Y: "2025-06-18");
 * server responds with negotiated version, capabilities, and
 * serverInfo. Client then sends notifications/initialized per MCP
 * spec.
 *
 * Returns the server's initialize response so tests can assert on
 * protocolVersion and serverInfo content.
 */
async function initialize(server: TestServer): Promise<JsonRpcResponse> {
  const response = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stdio-server-test", version: "0.0.0" },
  });
  server.notify("notifications/initialized");
  return response;
}

// ============================================================================
// Test fixtures
// ============================================================================

let tmpRoot: string;
let server: TestServer;

beforeAll(async () => {
  await buildMcpPackage();
}, 60_000);

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "vibrev-mcp-stdio-"));
  // resolveRepoRoot walks up looking for a repo-root marker: a
  // `.git` file/directory OR a `.viberevert.yml` regular file
  // (see packages/core/src/paths.ts hasRepoMarker). Create an
  // empty `.git/` directory so boot succeeds. We intentionally
  // do NOT create `.viberevert.yml` so the get_policy test
  // exercises the CONFIG_NOT_FOUND envelope path. The audit
  // writer's `.viberevert/` data directory is created on demand
  // by openAuditLog's mkdir({recursive:true}).
  await mkdir(join(tmpRoot, ".git"), { recursive: true });
  server = new TestServer(spawnServer(tmpRoot));
});

afterEach(async () => {
  try {
    await server?.shutdown();
    // Leak detection: every test should leave pending=0 after
    // shutdown. A non-zero count indicates a fire-and-forget
    // request that never resolved.
    if (server !== undefined) {
      expect(server.pendingRequestCount()).toBe(0);
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// A. Initialize handshake
// ============================================================================

describe("stdio-server: A. initialize handshake", () => {
  it("server responds with protocolVersion '2025-06-18' + serverInfo + tools capability", async () => {
    const response = await initialize(server);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.error).toBeUndefined();
    const result = response.result as {
      protocolVersion: string;
      capabilities: { tools?: object };
      serverInfo: { name: string; version: string };
    };
    // Hard D99.Y assertion: if SDK 1.29.0 negotiates a different
    // version, this fails and forces a deliberate plan revision.
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.serverInfo.name).toBe("@viberevert/mcp");
    expect(result.capabilities.tools).toBeDefined();
  });
});

// ============================================================================
// B. tools/list
// ============================================================================

describe("stdio-server: B. tools/list", () => {
  it("returns 8 tools in TOOL_NAMES_IN_ORDER catalog order; no reserved names", async () => {
    await initialize(server);
    const response = await server.request("tools/list");

    expect(response.jsonrpc).toBe("2.0");
    expect(response.error).toBeUndefined();
    const result = response.result as {
      tools: ReadonlyArray<{ name: string; description: string; inputSchema: object }>;
    };
    expect(result.tools).toHaveLength(8);

    const names = result.tools.map((t) => t.name);
    expect(names).toEqual([
      "check_repo",
      "explain_diff",
      "classify_risk",
      "list_risky_files",
      "get_policy",
      "start_session",
      "create_checkpoint",
      "generate_fix_prompt",
    ]);
    // Reserved names MUST NOT appear (D99.B).
    expect(names).not.toContain("rollback");
    expect(names).not.toContain("request_human_approval");
  });
});

// ============================================================================
// C. tools/call known-tool Cat 1 structured envelope round trip
// ============================================================================

describe("stdio-server: C. tools/call Cat 1 structured envelope round trip", () => {
  it("get_policy with no config -> Cat 1 wire shape (content + structuredContent + isError:true)", async () => {
    await initialize(server);
    const response = await server.request("tools/call", {
      name: "get_policy",
      arguments: {},
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.error).toBeUndefined();
    const result = response.result as {
      content: ReadonlyArray<{ type: string; text: string }>;
      structuredContent: { ok: boolean; error?: { code: string; message: string } };
      isError?: true;
    };

    // Cat 1 wire shape contract per D99.O:
    //   - result.content[0].text === JSON.stringify(envelope)
    //   - result.structuredContent === envelope
    //   - result.isError === true when envelope.ok === false
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent.ok).toBe(false);
    expect(typeof result.structuredContent.error?.code).toBe("string");
    expect(result.isError).toBe(true);
  });
});

// ============================================================================
// D. tools/call unknown name (Cat 2 wire shape, R31 end-to-end)
// ============================================================================

describe("stdio-server: D. tools/call unknown name (Cat 2)", () => {
  it("reserved name 'rollback' -> JSON-RPC success with isError:true + text-only + NO structuredContent", async () => {
    await initialize(server);
    const response = await server.request("tools/call", { name: "rollback" });

    // CRITICAL: JSON-RPC SUCCESS envelope, not a JSON-RPC error.
    // The low-level Server own-dispatcher does NOT throw for
    // unknown names -- it returns Cat 2 manually. If this fires,
    // it means the dispatcher accidentally let McpError propagate.
    expect(response.jsonrpc).toBe("2.0");
    expect(response.error).toBeUndefined();

    const result = response.result as {
      content: ReadonlyArray<{ type: string; text: string }>;
      structuredContent?: unknown;
      isError?: true;
    };
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe("MCP error -32602: Tool not found");
    expect(result.structuredContent).toBeUndefined();
  });

  it("R31: credential-shaped unknown name -> generic Cat 2; no echo anywhere in response", async () => {
    await initialize(server);
    // Constructed credential-shaped fixture per
    // [[feedback_constructed_secret_fixtures]] -- template-literal
    // interpolation defeats source-byte scanner detection. This
    // test extends the R31 no-echo guarantee through the real
    // SDK + stdio path (server.test.ts covers the in-process
    // dispatcher path).
    const rawUnknown = `sk${"_live_"}UNKNOWN_TOOL_FIXTURE`;
    const response = await server.request("tools/call", { name: rawUnknown });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.error).toBeUndefined();
    const result = response.result as {
      content: ReadonlyArray<{ type: string; text: string }>;
      structuredContent?: unknown;
      isError?: true;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("MCP error -32602: Tool not found");
    expect(result.structuredContent).toBeUndefined();

    // R31 end-to-end: the credential-shaped name MUST NOT appear
    // anywhere in the JSON-RPC response (neither content text nor
    // anywhere else in the envelope structure).
    expect(result.content[0]?.text).not.toContain(rawUnknown);
    expect(JSON.stringify(response)).not.toContain(rawUnknown);
  });
});

// ============================================================================
// E. Response id matching under concurrency (R27)
// ============================================================================

describe("stdio-server: E. Response id matching (R27)", () => {
  it("three concurrent tools/list requests each get the response matching their id", async () => {
    await initialize(server);

    // Send three in-flight requests; the TestServer wrapper
    // resolves each Promise via the id-keyed dispatcher. If
    // responses arrived out of order (which they can per R27),
    // this test would still pass because matching is id-based.
    const [r1, r2, r3] = await Promise.all([
      server.request("tools/list"),
      server.request("tools/list"),
      server.request("tools/list"),
    ]);

    // Each response carries a unique id from the wrapper's
    // nextId counter. Distinct ids prove the dispatcher resolved
    // each Promise with its OWN response, not a shared one.
    expect(r1.jsonrpc).toBe("2.0");
    expect(r2.jsonrpc).toBe("2.0");
    expect(r3.jsonrpc).toBe("2.0");
    expect(typeof r1.id).toBe("number");
    expect(typeof r2.id).toBe("number");
    expect(typeof r3.id).toBe("number");
    expect(new Set([r1.id, r2.id, r3.id]).size).toBe(3);

    // All three should be successful tools/list responses.
    for (const r of [r1, r2, r3]) {
      expect(r.error).toBeUndefined();
      const result = r.result as { tools: ReadonlyArray<{ name: string }> };
      expect(result.tools).toHaveLength(8);
    }
  });
});
