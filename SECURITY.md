# Security policy

## Reporting a vulnerability

If you find a security vulnerability in VibeRevert, please report it
**privately** to **fabio@madeinpluto.com** instead of opening a public issue.

We aim to acknowledge a report within 5 business days. This is an acknowledgment
target, not a remediation deadline.

Please avoid public disclosure while we investigate and coordinate a reasonable
remediation or disclosure timeline. If we cannot agree on a timeline, please give
us reasonable advance notice before publication.

## Supported versions

VibeRevert is currently a beta. Security fixes are developed against the latest
published beta. Earlier beta versions may not receive separate fixes; users
should expect to upgrade to the latest beta.

## Scope

In scope:

- The `viberevert` CLI and `@viberevert/*` packages published from this repository.
- Vulnerabilities that allow code execution, data exfiltration, or
  bypassing of guarded-command protections.

Out of scope:

- Third-party AI coding tools (Claude Code, Cursor, Codex, etc.) that
  VibeRevert wraps or integrates with — please report those to their
  respective vendors.
- Issues that depend on a malicious local user with write access to the
  repository or `.viberevert/` directory.

For the full security posture, trust boundaries, and what VibeRevert does and
does not defend against, see [THREAT_MODEL.md](THREAT_MODEL.md).

## Rollback limitations (not a vulnerability)

VibeRevert can roll back local repository changes that it has checkpointed.
It **cannot** undo:

- Production or remote database changes.
- Deployed code or infrastructure changes.
- Third-party API calls (Stripe, GitHub, etc.).
- Sent emails or notifications.
- Commands run outside VibeRevert's wrapper or guarded shell, which VibeRevert cannot reliably intercept.

These limits are documented behavior, not security vulnerabilities.
