# Sonofin 2.0 — Remaining Milestone Execution Plan

This document decomposes Milestones 7 through 12 from
`Sonofin_2_Codex_Handoff.md` into bounded Codex tasks. The repository baseline
is the checked-in Milestone 6 implementation described by `README.md`.

The broad milestone goals in the handoff remain authoritative product scope.
The numbered tasks below are authoritative for execution order and task
boundaries. A whole remaining milestone must not be assigned as one Codex task.

The plan contains 34 primary runs: 27 implementation/documentation runs and 7
explicit research, real-system verification, or deployment gates. The two
deployment gates remain externally authorized operations, not implied actions.

## Required Codex preset

Use this preset for every task in this plan:

```text
Model: gpt-5.6-sol
Reasoning effort: ultra
Maximum wall time: 5 hours
```

The estimates below are conservative planning envelopes, not runtime
guarantees. No task is budgeted above 4.5 hours. The unallocated final 30
minutes is a hard reserve for a full verification pass and a small repair. If
new contract work would consume that reserve, finish the current coherent
slice, keep the repository green, and insert a new narrowly scoped task rather
than expanding the current task.

Ultra may use subagents for independent protocol research, test-gap analysis,
or review. Keep one primary writer unless files are cleanly disjoint; shared
write ownership creates merge and verification risk that defeats the time
budget.

## Definition of done for every implementation task

A task is complete only when all of the following are true:

1. Only the stated scope was implemented; later-task behavior was not pulled
   forward casually.
2. Production behavior has focused tests, including credential-safe failure
   paths and relevant concurrency or boundary cases.
3. Public package APIs are exported through their `src/index.ts` files.
4. Documentation and checked-in example configuration changed by the task are
   current and contain no real credentials or account identifiers.
5. `pnpm check` passes in full.
6. The task's checkbox in this document is marked complete only after step 5.

Run `pnpm test:d1` directly while iterating on migrations/repositories, and run
the cross-Worker lifecycle tests while iterating on Worker composition. These
targeted checks supplement rather than replace the final `pnpm check`.

Do not spend the task repairing unrelated pre-existing failures. Record the
exact failure and evidence instead. Do not weaken lint, TypeScript, protocol,
database, or security invariants to make a task fit.

## Reusable task prompt

Create one Codex task per numbered item and use this prompt, replacing `X.Y`
with the exact task ID:

```text
Use gpt-5.6-sol with ultra reasoning. Implement only Task X.Y from
Sonofin_2_Remaining_Milestones.md. Read AGENTS.md, README.md,
Sonofin_2_Codex_Handoff.md, and the task entry before editing. Preserve all
security/protocol invariants and existing user changes. Use subagents for
independent read-only research or review when useful, but keep write ownership
coordinated. Add focused production tests for behavior changed by the task,
run pnpm check, update affected documentation, and mark only Task X.Y complete
when every acceptance criterion and the full check pass. For an ADR or manual
gate, produce the stated evidence and do not invent a code change. Do not begin
the next task. If an undiscovered issue would exceed the task boundary, leave
the repository green and describe the smallest follow-up task required.
```

## External-entry gates

Tasks 7.9, 8.5, 12.5, and 12.6 need systems outside this repository. Do not
start their five-hour clocks until the listed server, hardware, account,
domain, test media, and secrets are ready. Planning these tasks does not
authorize a staging or production deployment. Tasks 12.5 and 12.6 each require
separate explicit authorization when they are run.

## Dependency order

Use the task order within each milestone. The cross-milestone critical path is:

```text
7.1 + 7.2 -> 7.3 ... 7.9 -> 8.1 ... 8.5
                          -> 9.1 -> 9.2 -> 10.1 ... 10.6
                                               -> 11.1 ... 11.6
                                                          -> 12.1 ... 12.6
```

Security research in 11.1 can begin earlier as a separate read-only task, but
11.2 must use its accepted decision and public deployment remains blocked until
all of Milestone 11 is complete.

## Milestone 7 — SMAPI browsing

Milestone exit: an authenticated Sonos account can browse the root, artists,
artist albums, albums, album tracks, playlists, playlist tracks, and search
results through paginated, namespace-correct SMAPI responses. Jellyfin tokens
never enter XML, item IDs, logs, or errors.

### [x] Task 7.1 — Browse protocol and content-ID foundation

**Budget:** 3.5–4.5 hours. **Prerequisite:** Milestone 6.

- Add Sonos browse result types and WSDL-ordered `getMetadata` serialization to
  `@sonofin/sonos-smapi` without adding a Worker route.
- Add one stable, reversible content-ID codec for root/category, artist, album,
  playlist, and track IDs. Enforce Sonos's 128-character item-ID limit and
  reject malformed, ambiguous, or wrong-kind IDs.
- Add bounded `index`/`count` parsing rules and response count/total invariants.
- Test collections, tracks, mixed-safe serialization, empty pages, boundaries,
  XML escaping, forbidden XML characters, and exact element order.

**Not in scope:** Jellyfin calls, Worker dependency composition, search SOAP,
artwork URLs, or `getExtendedMetadata`.

### [x] Task 7.2 — Authenticated Jellyfin request context

**Budget:** 3.5–4.5 hours. **Prerequisite:** Milestone 6.

- Replace the SMAPI Worker's boolean authentication reduction with an injected,
  credential-safe context that retains the exact Sonos mapping and
  `jellyfinConnectionId`.
- Add an injected connection resolver/data-client factory seam. In production,
  retrieve and decrypt the stored connection and create `JellyfinApiClient`;
  unit tests must continue to use fakes.
- Configure the SMAPI Worker with the same
  `JELLYFIN_TOKEN_ENCRYPTION_KEY` value used by the auth Worker, while retaining
  a separate `SONOS_TOKEN_SIGNING_KEY`. Update examples and rotation/deployment
  guidance without committing secrets.
- Define and test safe Jellyfin/connection failure-to-SOAP mapping. No error,
  response, or log may contain server bodies, URLs with credentials, or tokens.

**Not in scope:** browse routes or XML beyond existing methods.

### [x] Task 7.3 — Browse service shell and root menu

**Budget:** 2.5–3.5 hours. **Prerequisites:** 7.1 and 7.2.

- Add a focused browse translation/service boundary so the Worker does not
  construct arbitrary Jellyfin calls or large XML object graphs inline.
- Route authenticated `getMetadata` and implement the paginated `root`
  collection with Artists, Albums, Playlists, and Search entries.
- Treat the initial catalog as an aggregate of the authenticated user's music
  libraries; per-library navigation is explicitly deferred.
- Test missing/malformed parameters, unauthorized credentials, empty/out-of-
  range pages, unsupported IDs, safe faults, and allow-listed logs.

**Not in scope:** category contents or a real-server manual test.

### [x] Task 7.4 — Artists and artist albums

**Budget:** 3.5–4.5 hours. **Prerequisite:** 7.3.

- Map paginated `getArtists()` results to artist collections with stable IDs.
- Browse an artist ID through `getAlbums({ artistId, ...page })`.
- Preserve Jellyfin ordering and total counts, and omit unsafe or unavailable
  optional metadata instead of fabricating it.
- Test Unicode, missing names/IDs, empty pages, item-not-found, token-invalid,
  upstream failure, and pagination boundaries with a fake data client.

**Not in scope:** global Albums, album tracks, or artwork delivery.

### [x] Task 7.5 — Albums and album tracks

**Budget:** 4–4.5 hours. **Prerequisite:** 7.4.

- Map global `getAlbums()` pages to album collections and browse an album
  through ordered `getAlbumTracks()` results.
- Add the shared normalized-track-to-SMAPI formatter needed later by playlists,
  search, and `getMediaMetadata`.
- Emit correct duration units, artist/album identifiers, MIME information when
  it can be derived safely, and conservative play/enumeration flags.
- Test multi-disc ordering, absent metadata, very long text, item errors, empty
  albums, XML order, and credential-safe faults.

**Stop rule:** if MIME/container policy or an unanticipated WSDL contract needs
more than the repair reserve, complete global album listing first and insert a
new album-track task before 7.6.

### [x] Task 7.6 — Playlists and playlist tracks

**Budget:** 3–4 hours. **Prerequisite:** 7.5.

- Map paginated playlists and their ordered entries using the shared track
  formatter while retaining Jellyfin playlist-entry identity where required.
- Ensure duplicate tracks and playlist item IDs do not collide with catalog
  track IDs or change playback identity incorrectly.
- Test empty playlists, duplicate entries, paging, malformed IDs, deleted
  playlists/items, and safe upstream error mapping.

**Not in scope:** playlist editing, favorites, or caching.

### [x] Task 7.7 — Category-filtered Jellyfin search contract

**Budget:** 2.5–4 hours. **Prerequisite:** 7.6.

- Extend `JellyfinSearchOptions` with an explicit Sonofin music category
  (`artist`, `album`, `track`, or `playlist`) and send the corresponding fixed
  Jellyfin item-type filter.
- Preserve bounded terms, paging, normalized output, and accurate totals at the
  API boundary; do not fetch a mixed page and filter it after pagination.
- Add wire-contract and validation tests to `@sonofin/jellyfin-client`.

**Not in scope:** SOAP search serialization or Worker routing.

### [ ] Task 7.8 — SMAPI search categories and search route

**Budget:** 3–4.5 hours. **Prerequisites:** 7.1, 7.3, and 7.7.

- Return the same artist/album/track/playlist category IDs from
  `getMetadata("search")` that the SMAPI `search` request accepts.
- Add WSDL-ordered, paginated search response serialization and an authenticated
  Worker route that validates category, term, index, and count.
- Map each normalized result kind to the same IDs and metadata used by browsing.
- Test all categories, no results, mixed Unicode, invalid terms/categories,
  item-ID round trips, safe faults, and parser/serializer element order.

### [ ] Task 7.9 — Milestone 7 real-system browse verification

**Budget:** 2–4.5 hours. **Prerequisites:** 7.1–7.8 and a ready Jellyfin server,
Sonos test household/service registration, representative music, and test
credentials.

- Run onboarding and browse every Milestone 7 branch from a real Sonos app.
- Verify paging with a collection larger than one page and search all four
  categories. Capture only credential-free evidence.
- Fix only bounded defects that fit the reserved repair window; create a new
  defect task for larger protocol or product changes.
- Update the README with the verified browse flow and mark Milestone 7 complete
  only if the real-system checks and `pnpm check` both pass.

## Milestone 8 — Playback

Milestone exit: Sonos obtains track metadata and a safe Jellyfin-native media
URI, sends required allow-listed HTTP headers, and streams directly from
Jellyfin. MP3, AAC, FLAC, and at least one negotiated-transcode case have
credential-free compatibility evidence. Cloudflare does not proxy audio and no
Jellyfin token appears in a URI.

### [ ] Task 8.1 — Playback contract and security decision

**Budget:** 2.5–4 hours. **Prerequisite:** Milestone 7 code complete.

- Use current primary Sonos and Jellyfin documentation/source to record an ADR
  for `getMediaURI`, Sonos `httpHeaders`, direct-play URL construction,
  `DeviceProfile` negotiation, source selection, and transcoding.
- Treat Jellyfin `TranscodingUrl` and `RequiredHttpHeaders` as untrusted and
  potentially credential-bearing. Define same-origin/base-path URL rules,
  header allow-lists, MIME rules, and rejection behavior.
- Preserve the decisions that audio is Sonos-to-Jellyfin, tokens do not enter
  query strings, and no proxy or custom signed URL is added.
- Check in sanitized MP3, AAC, FLAC, and transcode playback-info fixtures for
  later tasks. Do not add a production playback route in this task.

### [ ] Task 8.2 — `getMediaMetadata`

**Budget:** 2.5–3.5 hours. **Prerequisites:** 7.5 and 8.1.

- Add exact `getMediaMetadata` response serialization and an authenticated
  Worker route backed by `getItemMetadata()`.
- Require a track-kind content ID and reuse the browse track formatter so the
  same item has consistent metadata everywhere.
- Test metadata completeness, MIME/duration conversion, wrong-kind/malformed
  IDs, not found, invalid token, upstream failure, XML order, and redaction.

### [ ] Task 8.3 — Jellyfin playback-target resolver

**Budget:** 3.5–4.5 hours. **Prerequisite:** 8.1.

- Implement a Sonos-specific playback negotiation input/device profile at the
  Jellyfin client boundary and normalize the selected result into one safe
  playback-target type.
- Choose direct play/direct stream/transcode deterministically according to the
  ADR. Construct or validate the media path, enforce HTTPS/same origin/base
  path, allow-list required headers, reject CR/LF and hop-by-hop headers, and
  never accept or emit a query credential.
- Test the sanitized format fixtures, multiple/no compatible sources, malicious
  URLs/headers, unexpected protocols, and stable retry behavior.

**Not in scope:** SOAP or Worker route changes.

### [ ] Task 8.4 — `getMediaURI` integration

**Budget:** 3–4 hours. **Prerequisites:** 8.2 and 8.3.

- Add exact `getMediaURI` serialization, including an ordered list of permitted
  `httpHeader` entries, and route authenticated track IDs through the resolver.
- Map all invalid-item, invalid-token, no-compatible-stream, timeout, and
  upstream failures to credential-safe Sonos faults.
- Verify that the Worker returns metadata only and never fetches or proxies the
  audio response body. Test repeated requests and URL/header escaping.

### [ ] Task 8.5 — Real format and playback compatibility matrix

**Budget:** 2–4.5 hours. **Prerequisites:** 8.1–8.4 and ready Sonos/Jellyfin
hardware plus known MP3, AAC, FLAC, and forced-transcode fixtures.

- Play, pause, seek, skip, and resume each required format from Sonos while
  confirming the stream goes directly to Jellyfin.
- Confirm headers work on actual Sonos firmware, byte ranges remain usable,
  repeated `getMediaURI` results are stable enough for one playback session,
  and no token appears in captured URLs or logs.
- Record Jellyfin version, Sonos firmware/device, container/codec, selected
  method, and result without recording credentials or private server details.
- Fix only bounded defects; split larger compatibility failures. Mark Milestone
  8 complete only when required playback cases succeed and `pnpm check` passes.

## Milestone 9 — Activity tracking

Milestone exit: connection-level activity is updated at most once per throttle
window for authenticated user-activity methods, never for health polling, and
is ready to drive retention cleanup.

### [ ] Task 9.1 — Activity schema and guarded repository update

**Budget:** 3–4.5 hours. **Prerequisite:** Milestone 8 code complete.

- Add a forward-only migration that gives `jellyfin_connections` a
  non-null `last_used_at`, initialized from `created_at` for existing records.
- Extend connection/database contracts with one guarded monotonic touch that
  writes only when the stored value is older than the configured threshold.
- Default the threshold to 900 seconds, validate clock/config bounds, and make
  concurrent/out-of-order attempts converge safely.
- Add unit and isolated real-D1 tests for exact threshold edges, no-op writes,
  concurrency, invalid clocks, and record mapping.

### [ ] Task 9.2 — Genuine SMAPI activity integration

**Budget:** 2.5–4 hours. **Prerequisite:** 9.1.

- Classify `getMetadata`, `search`, `getMediaMetadata`, and `getMediaURI` as
  genuine activity after exact Sonos authentication succeeds.
- Explicitly exclude `getLastUpdate`, onboarding/link methods, health checks,
  background Jellyfin probes, malformed requests, and unauthorized requests.
- Ensure a throttled activity write does not leak data or turn a valid media
  response into an unsafe partial response. Document and test the chosen
  failure behavior.
- Add cross-route tests proving the classification and no-more-than-once-per-
  window behavior. Mark Milestone 9 complete after `pnpm check` passes.

## Milestone 10 — Maintenance Worker

Milestone exit: a bounded, idempotent scheduled Worker removes expired
transient state and locally deletes the complete graph for connections beyond
the configured inactivity period without breaking active issued credentials.

### [ ] Task 10.1 — Retention data-graph decision

**Budget:** 2.5–3.5 hours. **Prerequisite:** 9.1.

- Record an ADR covering expired pending, completed-unclaimed, claimed/issued,
  revoked, and inactive record graphs; deletion order; batch bounds; retry and
  concurrency behavior; and anonymous tombstones (default: none).
- Resolve the current conflict where `sonos_connections.id` references an
  expiring `onboarding_links.id` with `ON DELETE RESTRICT`, even though issued
  credentials must outlive the temporary link.
- Keep automatic cleanup local. Do not call Jellyfin token-revocation APIs: the
  current schema cannot distinguish password-created from user-supplied tokens,
  and user-supplied tokens must never be revoked.
- Define the default retention period as 365 days, with validated configuration
  and `last_used_at` as the retention anchor.

### [ ] Task 10.2 — Decouple issued credentials from transient links

**Budget:** 3.5–4.5 hours. **Prerequisite:** 10.1.

- Add a forward-only migration that permits expired link secrets/state to be
  deleted after issuance without invalidating the durable Sonos-to-Jellyfin
  mapping or retry-idempotent issuance.
- Preserve the claimed-link insertion invariant, exact household/connection
  binding, targeted revocation, and mixed-generation signing-key replay.
- Add repository and real-D1 migration tests for pre-migration records, issued
  credentials after link deletion, unissued claimed links, revocation, and
  foreign-key enforcement.

### [ ] Task 10.3 — Expired transient-state cleanup

**Budget:** 3–4 hours. **Prerequisite:** 10.2.

- Add bounded cleanup queries/service behavior for expired pending links,
  expired completed-but-unclaimed links and their orphan encrypted connection,
  and expired claimed link state whose durable mapping is already issued.
- Use guarded, FK-safe operations so reruns and concurrent issuance/cleanup
  converge without deleting a newly active or newly issued connection.
- Test exact expiration edges, batch continuation, mixed states, partial retry,
  and real-D1 behavior.

### [ ] Task 10.4 — Inactive candidate selection

**Budget:** 2.5–3.5 hours. **Prerequisites:** 9.1 and 10.1.

- Add a bounded, indexed query for connection IDs whose `last_used_at` is at or
  before the configured retention cutoff.
- Validate retention and batch-size configuration, use deterministic ordering,
  and return only the minimum identifiers needed for deletion.
- Test never-used migrated records, exact cutoff edges, recently active
  records, multiple Sonos mappings, revoked mappings, and pagination/batching.

### [ ] Task 10.5 — Atomic inactive-graph deletion

**Budget:** 3.5–4.5 hours. **Prerequisites:** 10.2 and 10.4.

- Delete, in a guarded FK-safe unit, all Sonos token hashes/mappings, associated
  link/session state, and the encrypted Jellyfin connection metadata/token for
  one still-inactive connection.
- Recheck the inactivity predicate at mutation time so a concurrent activity
  touch wins over cleanup. Make missing/already-deleted graphs successful no-ops.
- Add unit and real-D1 tests for concurrency, multiple mappings, partial graphs,
  retries, exact household isolation, and full credential removal.

### [ ] Task 10.6 — Maintenance Worker and Cron assembly

**Budget:** 3–4.5 hours. **Prerequisites:** 10.3 and 10.5.

- Add `apps/maintenance-worker` with an injected, testable `scheduled()`
  handler, shared D1 binding, validated retention/batch variables, and a checked-
  in UTC Cron Trigger.
- Run transient cleanup and bounded inactive cleanup idempotently, with
  allow-listed aggregate logs only. Never log IDs, URLs, usernames, tokens, or
  deleted record bodies.
- Add root scripts, package/build wiring, Worker tests, real-D1 lifecycle
  coverage, local scheduled-handler instructions, and deployment notes.
- Mark Milestone 10 complete only after all three Workers pass `pnpm check`.

## Milestone 11 — Security hardening

Milestone exit: arbitrary Jellyfin hostnames are subject to a documented and
connect-time-defensible public-address policy, public routes have compatible
abuse controls, browser onboarding has a resolved CSRF model, production cannot
enable local HTTP accidentally, and adversarial regression tests pass.

### [ ] Task 11.1 — DNS rebinding feasibility and SSRF ADR

**Budget:** 2.5–4 hours. **Prerequisite:** Milestone 10 code complete.

- Verify current Cloudflare Workers `fetch`, DNS, egress, Gateway/VPC, and local
  test-runtime guarantees from primary documentation and a minimal safe
  prototype. Do not assume a DNS preflight pins the later connection.
- Enumerate IPv4/IPv6 private, loopback, link-local, metadata, documentation,
  multicast, unspecified, and mixed-answer cases, including DNS changes between
  requests.
- Select a connect-time-defensible design for public Jellyfin servers. If that
  design changes supported deployments, requires a paid product, or needs an
  operator choice, stop with the ADR and request that decision before 11.2.
- Keep the existing HTTPS/default and no-redirect policy as non-negotiable.

### [ ] Task 11.2 — Implement the accepted outbound-address policy

**Budget:** 3.5–4.5 hours. **Prerequisite:** an accepted 11.1 ADR and any needed
Cloudflare capability/account decision.

- Implement the selected hostname/address enforcement at every Jellyfin
  request boundary, not only during onboarding, and preserve the server base
  path and fixed API paths.
- Fail closed on forbidden, mixed, malformed, unresolved, changed, or
  unverifiable destinations according to the ADR. Do not substitute a
  time-of-check/time-of-use DNS workaround that the ADR rejected.
- Add injectable resolver/egress seams and deterministic tests for IPv4, IPv6,
  mapped IPv4, Unicode hostnames, rebinding simulations, and safe errors.

### [ ] Task 11.3 — Shared rate-limit contract and SMAPI protection

**Budget:** 3–4 hours. **Prerequisite:** Milestone 8 code complete.

- Define an injected rate-limit contract and checked-in Cloudflare binding
  configuration with separate policies for link issuance/claiming and normal
  authenticated SMAPI activity.
- Derive limiter keys without logging or exposing raw household IDs, link
  values, tokens, or device IDs. Preserve legitimate Sonos polling/retry
  behavior and return protocol-compatible safe failures.
- Test allow/deny/error behavior, route classification, retries, and local fake
  bindings. Document Cloudflare locality/eventual-consistency limits.

### [ ] Task 11.4 — Onboarding abuse controls

**Budget:** 2.5–4 hours. **Prerequisite:** 11.3.

- Apply a separate rate policy to onboarding GET/POST and expensive outbound
  Jellyfin authentication attempts without revealing whether a link, user, or
  server exists.
- Keep controls compatible with the Sonos-launched browser and manual local
  development. Define safe fail-open/fail-closed behavior for binding errors.
- Test repeated invalid/expired links, repeated bad credentials, valid retries,
  429 pages/headers, and log redaction.

### [ ] Task 11.5 — CSRF and onboarding browser-security closeout

**Budget:** 2.5–3.5 hours. **Prerequisite:** 11.4.

- Write the explicit CSRF/capability-link threat model: there is no ambient
  Sonofin login cookie, but `linkCode` is a bearer capability in a URL/form.
- Audit existing CSP, frame, referrer, permissions, content-type, cache, and
  form-action headers against the real Sonos browser flow; implement only the
  mitigations the threat model requires.
- Test cross-site form attempts, missing/hostile Origin and Referer values,
  replay, back-button/resubmission, and completion pages without weakening curl
  or Sonos compatibility silently.

### [ ] Task 11.6 — Final adversarial security regression pass

**Budget:** 3.5–4.5 hours. **Prerequisites:** 11.2–11.5.

- Audit every public route and outbound path for bounded reads, timeouts,
  redirect rejection, fixed paths, XML/HTML/header injection, query credentials,
  and allow-listed logging. Include playback-derived URLs and headers.
- Add table-driven/fuzz-style regression cases for hostile Unicode, IP and URL
  spellings, oversized values, malformed UTF-8/XML/forms/JSON, and secret
  canaries. Use constant-time comparison where plaintext secret comparison
  remains in process and is meaningful.
- Add a tested production configuration guard that refuses the local-only
  insecure HTTP opt-in in deployed environments.
- Run the full dependency/build/test audit, document residual accepted risks,
  and mark Milestone 11 complete only after `pnpm check` passes.

## Milestone 12 — Production deployment and documentation

Milestone exit: a new operator can provision and verify the system from the
documentation, a prepared staging environment passes the complete lifecycle,
and a separately authorized production rollout succeeds with rollback and
credential-safe evidence.

### [ ] Task 12.1 — Production configuration and release gates

**Budget:** 3–4 hours. **Prerequisite:** Milestone 11 complete.

- Inventory every secret, variable, D1 binding, rate-limit/egress binding,
  route/domain, Cron Trigger, compatibility date, and deployment dependency for
  all three Workers. Make checked-in examples consistent and placeholder-only.
- Add one documented release-check command that covers lint, strict types, unit
  and cross-Worker tests, real-D1 migrations/cleanup, and dry-run builds.
- Verify fresh local migration and local scheduled-handler workflows without
  touching production.

### [ ] Task 12.2 — Cloudflare operations runbook

**Budget:** 3–4 hours. **Prerequisite:** 12.1.

- Document D1 creation/migrations, deployment order, secrets and bindings,
  Cron propagation/UTC behavior, custom hostnames, observability, and safe smoke
  tests for a new environment.
- Document forward-only rollback strategy, D1 backup/recovery, signing-key
  staging, Jellyfin encryption-key loss/rotation limitations, and incident-safe
  log collection without printing credentials.
- Dry-run every local command and statically verify every production command and
  file path; never insert a real account ID, database ID, domain, or secret.

### [ ] Task 12.3 — Sonos service registration and presentation assets

**Budget:** 3–4.5 hours. **Prerequisite:** 12.1.

- Document the Sonos SMAPI endpoint, authentication mode, onboarding URL,
  service/capability settings, production hostname/TLS requirements, and exact
  registration values that can be known from the repository.
- Add or update presentation-map/search-category assets and validate them
  against current Sonos primary documentation/schema where applicable. Use
  explicit placeholders for partner-assigned IDs or unavailable values.
- If real registration proves an unassigned method such as
  `getExtendedMetadata` is mandatory, create a separate bounded implementation
  task; do not hide it inside this documentation task.

### [ ] Task 12.4 — Requirements, compatibility, and troubleshooting

**Budget:** 3–4.5 hours. **Prerequisites:** 8.5, 10.6, 11.6, and 12.2–12.3.

- Publish evidence-based Jellyfin version/server requirements and the verified
  Sonos/MP3/AAC/FLAC/transcoding matrix. Do not guess unsupported versions.
- Document onboarding, auth, browsing, playback, D1/Cron, rate-limit, SSRF, and
  secret-rotation troubleshooting with credential-safe diagnostics.
- Have a clean-context reviewer follow the docs through a fresh local setup and
  correct every reproducible omission. Run `pnpm check` and mark repository
  documentation complete.

### [ ] Task 12.5 — Authorized staging deployment and smoke test

**Budget:** 2.5–4.5 hours. **Prerequisites:** 12.1–12.4 plus explicit staging
authorization, a Cloudflare account/project, staging domains, D1, secrets,
Sonos test registration, Jellyfin server, hardware, and media fixtures.

- Provision or update staging in the documented order, apply migrations, deploy
  all Workers, wait for Cron propagation, and run onboarding, auth, every browse
  branch, search, playback formats, activity throttling, and a safe accelerated
  cleanup fixture.
- Capture only non-secret outcomes and repair only bounded defects. Update the
  runbook from actual evidence and rerun release checks.

### [ ] Task 12.6 — Separately authorized production rollout

**Budget:** 2.5–4.5 hours. **Prerequisite:** successful 12.5 plus a separate
explicit production authorization and all production identifiers/secrets.

- Execute the verified runbook, with pre-deployment backup, migration/deployment
  order, staged secrets, rollback checkpoints, and post-deploy smoke checks.
- Do not paste secrets, raw identifiers, user data, or server responses into
  task output. Stop at any mismatch that would expand scope or risk data.
- Confirm Cron, onboarding, authenticated browse/search/playback, monitoring,
  and rollback readiness. Mark Milestone 12 and the Sonofin 2.0 roadmap complete
  only after the production checks succeed.

## Explicitly unassigned backlog

The original roadmap does not assign the following features to Milestones
7–12. They must not be pulled into a five-hour task unless a real Sonos
registration or compatibility gate proves one mandatory; in that case, add a
new bounded task before the affected gate:

- `getExtendedMetadata` and `getExtendedMetadataText`
- `reportAccountAction` and playback reporting
- favorites and playlist mutation
- authenticated artwork delivery
- caching or scroll-index optimization
- a separate internal encryption/credential Worker
- custom signed playback URLs or Cloudflare audio proxying
- a future-version Jellyfin plugin that acts as a paired LAN agent: it may
  discover locally reachable Sonos households/players, send signed short-lived
  reachability heartbeats and a local Jellyfin playback endpoint to Sonofin,
  and allow `getMediaURI` to prefer a verified local route with safe public-route
  fallback. This is outside Sonofin 2.0 and requires a separate security and
  compatibility design covering plugin pairing, exact household/player
  matching, stale-state expiry, asymmetric network reachability, TLS, and
  track-scoped short-lived playback credentials; it must never disclose the
  reusable Jellyfin access token to an unverified or plain-HTTP LAN endpoint.
