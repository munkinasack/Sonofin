# Contributing to Sonofin

Sonofin is being built in small, dependency-ordered roadmap tasks. Before
starting a change, read `README.md`, `AGENTS.md`, and the relevant entry in
`Sonofin_2_Remaining_Milestones.md`. Open an issue before undertaking a large
change or changing a protocol or security decision.

## Development setup

Use Node.js 22 or newer and the pnpm version pinned by `packageManager` in
`package.json`.

```bash
git clone https://github.com/munkinasack/Sonofin.git
cd Sonofin
pnpm install
pnpm check
```

Create a focused branch from `main`. Keep unrelated changes out of the same
pull request.

## Change requirements

- Preserve strict TypeScript, ESM package boundaries, and exported
  `handleRequest` seams.
- Add focused tests for changed behavior. Keep the cross-Worker lifecycle test
  passing when onboarding or linking changes.
- Add new forward-only numbered D1 migrations. Never rewrite an applied
  migration.
- Keep request and response reads bounded, XML/HTML escaped, and state changes
  concurrency-safe.
- Never log or commit credentials, request bodies or headers, household/device
  bindings, link codes, private Jellyfin URLs, server response bodies, or real
  account identifiers.
- Update the README and roadmap status when a task is genuinely complete.

Run the complete gate before opening a pull request:

```bash
pnpm check
```

The command runs linting, strict type checking, unit and cross-Worker tests, an
isolated real-D1 integration test, and dry-run Worker builds.

## Bug reports and security issues

Use the GitHub issue forms for credential-free bug reports and feature
requests. Follow `SECURITY.md` for vulnerabilities; never disclose a
vulnerability or sensitive operational data in a public issue.

## Licensing

No open-source license has been granted for this repository. Discuss any
substantial external contribution with the maintainer before investing work so
that acceptance and licensing expectations are clear.
