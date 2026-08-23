# Architecture decision records

Architecture decision records (ADRs) capture significant decisions and their
rationale — why a choice was made. The contract documents in `docs/` define
current behavior.

Accepted decisions:

- [ADR 0001: Deterministic license audit](0001-deterministic-license-audit.md)
- [ADR 0002: State-based rollback](0002-state-based-rollback.md)
- [ADR 0003: Deterministic risk classification](0003-deterministic-risk-classification.md)
- [ADR 0004: Best-effort, fail-closed PTY interception](0004-best-effort-fail-closed-pty-interception.md)
- [ADR 0005: Resolve-then-launch command resolution](0005-windows-command-resolution-and-launch.md)
- [ADR 0006: Session contribution and content-addressed object store](0006-session-contribution-and-object-store.md)
- [ADR 0007: Session-start evaluation snapshot](0007-session-start-evaluation-snapshot.md)

ADR 0006 and ADR 0007 record accepted decisions for 0.8.0. Their schemas ship in
`@viberevert/session-format`, but the producer paths that persist the session
contribution and evaluation snapshot do not exist yet. Neither ADR therefore
describes behavior you can observe today.
