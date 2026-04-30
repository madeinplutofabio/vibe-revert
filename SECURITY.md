# Security policy

## Reporting a vulnerability

If you find a security vulnerability in VibeRevert, please report it
**privately** to **fabio@madeinpluto.com** instead of opening a public issue.

You should expect an initial acknowledgement within a few business days.

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

## Rollback limitations (not a vulnerability)

VibeRevert can roll back local repository changes that it has checkpointed.
It **cannot** undo:

- Production or remote database changes.
- Deployed code or infrastructure changes.
- Third-party API calls (Stripe, GitHub, etc.).
- Sent emails or notifications.
- Commands run outside VibeRevert's wrapper or guarded shell, which VibeRevert cannot reliably intercept.

These limits are documented behavior, not security vulnerabilities.
