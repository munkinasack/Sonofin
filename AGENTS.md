# Repository guidance

## Scope and current state

- These instructions apply to the entire repository.
- Sonofin 2.0 is an ESM TypeScript monorepo for two Cloudflare Workers. The
  checked-in implementation is currently Milestone 6 plus Tasks 7.1–7.8c, with
  Task 7.9 real-system verification in progress; use `README.md`, source, and
  tests as the description of current behavior.
- `Sonofin_2_Codex_Handoff.md` contains the broader design and future-state
  decisions. Do not assume roadmap items in it are already implemented.
- Use Node.js 22 or newer and pnpm 11 (`packageManager` pins pnpm 11.22.0).

## Architecture

- `apps/smapi-worker`: Sonos-facing SOAP 1.1 endpoint at `POST /smapi`.
- `apps/auth-worker`: browser onboarding at `GET` and `POST /onboarding`.
- `packages/linking`: cryptographic link creation and the link state machine;
  persistence is behind the `LinkRepository` interface.
- `packages/database`: D1 repository adapter and forward-only SQL migrations.
- `packages/jellyfin-client`: bounded Jellyfin discovery, authentication, token
  lifecycle, and normalized authenticated music-data access.
- `packages/crypto`: AES-GCM token encryption under a Worker Secret.
- `packages/connections`: encrypted Jellyfin connection storage contracts and
  lifecycle.
- `packages/sonos-auth`: hash-only long-lived Sonos credential issuance,
  validation, and targeted revocation.
- `packages/sonos-smapi`: namespace-aware SOAP parsing and XML serialization.
- `packages/shared`: bounded request-body reading and allow-listed logging.
- Keep Worker routing testable through exported `handleRequest` functions with
  injected dependencies. The default Worker exports assemble production D1 and
  client dependencies.
- Import across workspace packages through `@sonofin/*`; expose package APIs
  from each package's `src/index.ts`.

## Build and verification

- Install dependencies with `pnpm install`.
- Run `pnpm check` before handing off a completed change. It runs, in order:
  ESLint, strict TypeScript checking, unit and cross-Worker tests, the isolated
  real-D1 integration test, and Wrangler dry-run builds for both Workers.
- Useful narrower commands are `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm test:d1`, and `pnpm build`.
- Unit tests live under `apps/**/test/*.test.ts` and
  `packages/**/test/*.test.ts`. The D1/SQLite integration test is
  `packages/database/test/d1-integration.integration.ts` and is intentionally
  run by the separate `test:d1` configuration.
- Apply local migrations with `pnpm db:migrate:local`. Both Workers must use the
  same `DB` binding and `.wrangler/state` persistence directory.

## Code and data conventions

- Follow `.editorconfig`: UTF-8, LF endings, two-space indentation, a final
  newline, and no trailing whitespace.
- Preserve strict TypeScript settings, ESM syntax, and type-only imports where
  appropriate. Do not weaken compiler or lint settings to make a change pass.
- Add behavior tests with production changes. Keep the cross-Worker lifecycle
  test passing when onboarding or linking behavior changes.
- D1 state transitions use guarded updates so concurrent completion and claim
  attempts converge safely. Preserve exact, case-sensitive household and device
  bindings.
- Add new numbered migrations under `packages/database/migrations/`; do not
  rewrite an already-applied migration.

## Security and protocol invariants

- Keep logs explicitly allow-listed. Do not log request bodies, headers,
  household IDs, link codes, device bindings, passwords, access tokens, private
  keys, or server response bodies.
- Keep errors and onboarding pages credential-safe. Escape dynamic XML/HTML and
  never echo passwords, Jellyfin access tokens, server bodies, or URL-embedded
  credentials.
- Keep request and response reads bounded and reject malformed UTF-8. Do not
  replace streaming bounds with an unbounded buffering helper.
- Store only hashes of temporary link codes, device IDs, and Sonos auth tokens.
  Never persist a Sonos private key, Jellyfin password, or plaintext usable
  Jellyfin access token.
- Password authentication must discard the password. Persist the resulting
  Jellyfin token only as AES-GCM ciphertext under the Worker Secret; revoke a
  newly issued token after a definitive encrypted persistence/link-completion
  failure, before removing its recoverable encrypted record. Reconcile uncertain
  commits first. Never revoke a user-supplied token.
- Jellyfin URLs require HTTPS by default, reject redirects and unsafe targets,
  and preserve an optional Jellyfin base path. Plain HTTP is only available via
  the existing explicit local-development opt-in and must not be enabled in a
  deployed Worker.
- Preserve SOAP namespace validation, SOAPAction/body agreement, XML escaping,
  Sonos element order, and the established retry/failure fault mapping.
- Keep Sonos token derivation domain-separated under the dedicated Worker
  Secret, preserve retry-idempotent issuance, and validate exact household
  bindings before resolving a Jellyfin connection. Preserve the staged
  bidirectional fallback-key procedure for signing-key rotations so mixed
  Worker generations can replay either credential.
- Do not reintroduce the retired `SF_M2_FAKE_*` or `SF_M2_NO_REFRESH_*`
  Milestone 2 fixtures as production credentials.
