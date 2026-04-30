# Contributing to VibeRevert

Thanks for your interest in VibeRevert.

## Scope of this repository

This repository contains the **Apache-2.0 local CLI**: the `viberevert`
binary and its `@viberevert/*` workspace libraries.

It does **not** contain (and will not accept contributions for) cloud,
team, dashboard, GitHub App, Slack/Jira/Linear integrations, hosted audit
trails, SSO/SAML, or any networked/server-side functionality. Those live
in separate, proprietary repositories.

If you're unsure whether a feature belongs here, open a discussion before
writing code.

## Developer Certificate of Origin (DCO)

All commits must be signed off, certifying the
[Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "your message"
```

This adds a `Signed-off-by:` trailer with your name and email. By signing
off, you certify that you wrote the change or otherwise have the right to
submit it under the project's license.

## How to contribute

1. Open an issue describing the bug or feature.
2. Fork the repo and create a branch.
3. Make your change. Add or update tests.
4. Run `pnpm install && pnpm lint && pnpm typecheck && pnpm build && pnpm test` locally.
5. Open a pull request. Include the issue number in the description.

## Code style

- Formatter and linter: `biome` (run `pnpm format` and `pnpm lint`).
- TypeScript strict mode, ESM only.
- No comments unless the *why* is non-obvious.
- No emojis in source files unless explicitly requested.

## License

By contributing, you agree that your contributions will be licensed under
the [Apache License 2.0](LICENSE).
