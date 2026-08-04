// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Decision 7 interactive lifecycle fixture (operator tooling; NOT product code,
// NOT a Vitest test). It runs under the bounded `.cmd` mediation that
// operator-harness.mjs generates, on a real inherited console, and makes a real
// keyboard Ctrl+C observable through a token-bound event file. Because the
// harness inherits stdio, that event FILE -- not stdout -- is the authoritative
// machine-readable channel; the printed markers are corroborating only.
//
// Behavior (per docs/security/windows-cmd-mediation-lifecycle.md, "Fixture"):
//   - arm the SIGINT observation path FIRST;
//   - append a `ready` event and print AGENT-READY (readiness means the handler
//     is already armed, so no Ctrl+C can arrive before it can be recorded);
//   - append a `heartbeat` event at a fixed interval while alive;
//   - on SIGINT (a real Ctrl+C reaching this process): append a `sigint`
//     finalization event { exit_intent: 130 }, print AGENT-INTERRUPTED, stop the
//     heartbeat, and exit 130;
//   - otherwise remain alive (the harness owns termination + cleanup).
//
// Every event carries a fixed protocol envelope so the harness can reject
// malformed, duplicate, wrong-token, or wrong-version records. The event's own
// fields are spread FIRST and the envelope LAST, so the binding/identity fields
// are structurally authoritative -- an event object can never overwrite them:
//   { ...event, protocolVersion: 1, runId, token, pid, ppid, ts, monotonicMs }
// `ts` (wall-clock ISO-8601) and `monotonicMs` (performance.now) are attached to
// every event automatically, giving the harness one consistent timestamp pair to
// validate ordering and reject temporally impossible records. `runId` is the
// readable evidence identity; `token` is the unpredictable capability that binds
// every record and this PID to exactly one run. They are deliberately distinct
// and both required.
//
// Config comes from the environment (a side channel that does not touch the
// argument mediation validated separately): DECISION7_RUN_ID, DECISION7_TOKEN
// and DECISION7_EVENT_FILE are required; DECISION7_HEARTBEAT_MS is optional
// (default 500).
//
// No network, no product-state mutation, no persistence outside the event file
// the harness owns.

import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const PROTOCOL_VERSION = 1;

const runId = process.env.DECISION7_RUN_ID;
const token = process.env.DECISION7_TOKEN;
const eventFile = process.env.DECISION7_EVENT_FILE;

if (
  runId === undefined ||
  runId.length === 0 ||
  token === undefined ||
  token.length === 0 ||
  eventFile === undefined ||
  eventFile.length === 0
) {
  process.stderr.write(
    "decision7 fixture: DECISION7_RUN_ID, DECISION7_TOKEN and DECISION7_EVENT_FILE " +
      "must be set. Launch this fixture via operator-harness.mjs, not directly.\n",
  );
  process.exit(2);
}

const rawHeartbeat = Number.parseInt(process.env.DECISION7_HEARTBEAT_MS ?? "500", 10);
const heartbeatMs = Number.isFinite(rawHeartbeat) && rawHeartbeat > 0 ? rawHeartbeat : 500;

function appendEvent(event) {
  // Event fields first, protected envelope last: the binding/identity fields are
  // structurally authoritative and cannot be overwritten by an event object.
  const envelope = {
    ...event,
    protocolVersion: PROTOCOL_VERSION,
    runId,
    token,
    pid: process.pid,
    ppid: process.ppid,
    ts: new Date().toISOString(),
    monotonicMs: performance.now(),
  };

  // Synchronous append so the finalization record is durable before exit(130).
  appendFileSync(eventFile, `${JSON.stringify(envelope)}\n`, "utf8");
}

let interrupted = false;
let seq = 0;
let heartbeat;

process.on("SIGINT", () => {
  if (interrupted) {
    return;
  }

  interrupted = true;

  if (heartbeat !== undefined) {
    clearInterval(heartbeat);
  }

  appendEvent({ type: "sigint", exit_intent: 130 });
  process.stdout.write("AGENT-INTERRUPTED\n");
  process.exit(130);
});

// `ready` means the SIGINT observation path is fully armed.
appendEvent({ type: "ready" });
process.stdout.write("AGENT-READY\n");

heartbeat = setInterval(() => {
  seq += 1;
  appendEvent({ type: "heartbeat", seq });
}, heartbeatMs);
