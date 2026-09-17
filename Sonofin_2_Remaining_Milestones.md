# Sonofin 2.0 — Remaining Milestone Execution Plan

This document decomposes Milestones 7 through 12 from
`Sonofin_2_Codex_Handoff.md` into bounded Codex tasks. The repository baseline
is the checked-in Milestone 6 implementation described by `README.md`.
Milestone 10A adds the later Service Bindings architecture decision before
security hardening and production deployment.

The broad milestone goals in the handoff remain authoritative product scope.
The numbered tasks below are authoritative for execution order and task
boundaries. A whole remaining milestone must not be assigned as one Codex task.

The plan contains the original 36 primary runs plus seven Milestone 10A runs.
Staging and production deployment gates remain externally authorized
operations, not implied actions.

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

Tasks 7.9, 8.5, 10A.1, 10A.7, 12.5, and 12.6 need systems outside this
repository. Do not start their five-hour clocks until the listed server,
hardware, account, domain, test media, and secrets are ready. Planning these
tasks does not authorize a staging or production deployment. Tasks 10A.7,
12.5, and 12.6 each require explicit authorization when they are run.

## Dependency order

Use the task order within each milestone. The cross-milestone critical path is:

```text
7.1 + 7.2 -> 7.3 ... 7.9 -> 8.1 -> 8.3 -> 8.4 -> 8.5
    -> 9.1 -> 9.2 -> 10.1 ... 10.6 -> 10A.1 ... 10A.7
    -> 11.1 ... 11.6 -> 12.1 ... 12.6
```

Security research in 11.1 can begin earlier as a separate read-only task, but
11.2 must use its accepted decision and public deployment remains blocked until
all of Milestone 11 is complete.

## Milestone 7 — SMAPI browsing

Milestone exit: an authenticated Sonos account can browse the root, artists,
artist albums, albums, album tracks, playlists, playlist tracks, and search
results through paginated, namespace-correct SMAPI responses, with catalog
caches invalidated on a 30-second cadence. Jellyfin tokens never enter XML,
item IDs, logs, or errors.

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
  collection with Artists, Albums, and Playlists entries. Keep search out of
  ordinary root browse content; Sonos exposes it through the registered Search
  capability, while desktop and S1 clients request the reserved `search`
  container directly.
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

### [x] Task 7.8 — SMAPI search categories and search route

**Budget:** 3–4.5 hours. **Prerequisites:** 7.1, 7.3, and 7.7.

- Return the same artist/album/track/playlist category IDs from
  `getMetadata("search")` that the SMAPI `search` request accepts.
- Add WSDL-ordered, paginated search response serialization and an authenticated
  Worker route that validates category, term, index, and count.
- Map each normalized result kind to the same IDs and metadata used by browsing.
- Test all categories, no results, mixed Unicode, invalid terms/categories,
  item-ID round trips, safe faults, and parser/serializer element order.

### [x] Task 7.8a — Mandatory `getExtendedMetadata` browse compatibility

**Budget:** 2.5–4 hours. **Prerequisites:** 7.3–7.8. **Discovered by:** 7.9
real-system verification.

- Implement the required Sonos `getExtendedMetadata` core method with an exact,
  WSDL-ordered response serializer and an authenticated Worker route.
- Return the same conservative metadata already used by browse/search for
  supported root, category, artist, album, and track IDs. Also handle playlist
  IDs defensively if the separate Sonos playlist-extended-metadata capability is
  enabled. Resolve Jellyfin entities through `getItemMetadata()` and require the
  returned kind to match the content ID; do not add related text, actions,
  artwork delivery, or playback behavior.
- Preserve bounded input parsing and credential-safe fault mapping. Logs may
  contain only fixed method/content/failure-origin classifications and must not
  contain item IDs, request bodies, URLs, user data, or credentials.
- Test every supported ID kind, malformed/wrong-kind/deleted items, invalid
  credentials, upstream failures, XML order, and redaction. Run `pnpm check`
  before resuming Task 7.9.

**Evidence:** during the Task 7.9 Sonos sandbox run against Jellyfin 10.11.11,
the Jellyfin-backed `getMetadata` requests succeeded, after which Sonos issued
`getExtendedMetadata` and Sonofin returned unsupported-method faults. This is
the mandatory-method case anticipated by the explicitly unassigned backlog.
The tested fix was deployed as SMAPI Worker version
`1280cc12-04e6-4b5c-8ee2-5361ee7ae195`; a repeated real-app trace showed HTTP
200 responses for category and album `getExtendedMetadata` calls without
capturing item IDs, account data, server details, or credentials.

### [x] Task 7.8b — Mandatory `getMediaMetadata` browse compatibility

**Budget:** 2.5–3.5 hours. **Prerequisites:** 7.5 and 7.8a. **Discovered by:**
7.9 real-system verification.

- Move the bounded metadata-only substance of former Task 8.2 ahead of the
  Milestone 7 real-system gate. Add the exact `getMediaMetadata` response
  serializer and an authenticated, `id`-only Worker route backed by
  `getItemMetadata()`.
- Require a track-kind content ID and an exact returned-kind match. Reuse the
  browse track formatter so album, playlist, search, extended-metadata, and
  media-metadata representations remain identical, including conservative
  `canPlay: false` behavior until the playback security design and media URI
  integration are complete.
- Return the WSDL `mediaMetadata` fields directly inside
  `getMediaMetadataResult`; do not add a nested `mediaMetadata` wrapper. Keep
  `getMediaURI`, playback negotiation, URLs, headers, transcoding, streaming,
  and collection metadata out of scope.
- Test metadata completeness, MIME/duration conversion, malformed and
  wrong-kind IDs, not found, invalid credentials, upstream failures, XML order,
  exact wrapping, and redaction. Run `pnpm check` before resuming Task 7.9.

**Evidence:** the exact serializer, authenticated route, shared formatter, safe
fault mapping, and redaction coverage passed the full repository check: 27 test
files with 711 unit/cross-Worker tests, seven isolated D1 tests, and dry-run
builds for both Workers. The tested implementation was deployed as SMAPI Worker
version `e25068eb-8d2a-47f5-a986-70d27041f34f`. The live trace has so far shown
only safe `ItemNotFound` handling for non-track category/playlist IDs; a
positive real-app track-ID call remains part of Task 7.9 and is not claimed as
evidence here. `getMediaMetadata` is playback-stage compatibility, not the
cause or fix for browse enumeration.

### [x] Task 7.8c — Thirty-second catalog refresh token

**Budget:** 1.5–2.5 hours. **Prerequisite:** 7.8b. **Product decision:** accept
the additional SMAPI and Jellyfin browse traffic from deliberately invalidating
Sonos's catalog cache every 30 seconds.

- Replace the fixed `getLastUpdate` catalog version with a deterministic UTC
  epoch bucket: `floor(nowMilliseconds / 30_000)`, serialized as a base-10
  string. Return the same token throughout each 30-second bucket and a new token
  at every bucket boundary. Do not use a locale-formatted date, a two-digit
  year, per-isolate state, randomness, KV, or D1.
- Return `pollInterval: 30`, Sonos's minimum supported interval. Keep the
  existing `favorites` token unchanged; this task refreshes the global catalog
  only.
- Keep `getLastUpdate` itself free of Jellyfin catalog reads. Its request-scoped
  authenticated context and connection-integrity validation remain required,
  while the changing token causes the Sonos app to issue its normal follow-up
  `getMetadata` requests.
- Add a pure helper or injected clock seam and deterministic tests for two calls
  in one bucket, the exact 30-second boundary, UTC minute/day/year transitions,
  valid ordered XML, and the absence of token-specific persistence or Jellyfin
  catalog calls.
- Document the intentional tradeoff: Sonos advises against changing `catalog`
  too frequently because it invalidates client caches, but Sonofin chooses the
  minimum interval so external Jellyfin library changes become visible quickly.
  Run `pnpm check` before resuming Task 7.9.

**Evidence:** the pure epoch-bucket helper, injected millisecond clock, exact
boundary and UTC transition coverage, authenticated no-catalog-read route, and
ordered minimum-interval XML passed the full repository check: 28 test files
with 750 unit/cross-Worker tests, seven isolated D1 tests, and dry-run builds for
both Workers. The implementation adds no migration, cache binding, catalog
persistence, randomness, or isolate-level mutable state.

### [ ] Task 7.9 — Milestone 7 real-system browse verification

**Budget:** 2–4.5 hours. **Prerequisites:** 7.1–7.8c and a ready Jellyfin server,
Sonos test household/service registration, representative music, and test
credentials.

- Run onboarding and browse every Milestone 7 branch from a real Sonos app.
- Verify that repeated `getLastUpdate` calls within one 30-second UTC bucket
  return the same catalog token, the next bucket returns a different token, and
  an active Sonos app subsequently refreshes browsed metadata without creating
  a faster-than-advertised or recursive request loop.
- Verify paging with a collection larger than one page and search all four
  categories. For a Sandbox integration, run the app search check from a
  Windows/Mac desktop or S1 app using Classic Search because Sonos does not
  expose Universal Search to Sandbox mobile/Web apps; Preview may instead use
  the configured Universal Search presentation map. A direct SOAP search is a
  useful diagnostic but does not replace this real-app gate. Capture only
  credential-free evidence.
- Before the search check, configure and send the Sonos Search capability with
  one Personal catalog context, no `all` or duplicate-library context, and these
  exact mappings: `artists` to `artist`, `albums` to `album`, `tracks` to
  `track`, and `playlists` to `playlist`. Re-send after every change and allow
  up to 10 minutes for the Sandbox configuration to propagate.
- Fix only bounded defects that fit the reserved repair window; create a new
  defect task for larger protocol or product changes.
- Update the README with the verified browse flow and mark Milestone 7 complete
  only if the real-system checks and `pnpm check` both pass.

**Evidence so far:** onboarding, the root branches, artist albums, and paging
past 100 artists passed against Jellyfin 10.11.11. Changing the read-only root
Playlists category from Sonos's special editable `playlist` type to the generic
`container` type was deployed as SMAPI Worker version
`48255e2d-8cc1-4cc1-b70c-7fc304b6c9ea`; the user then confirmed that the
playlist listing appears and its track titles are visible. Those tracks are
greyed out as expected while the shared pre-playback policy remains
`canPlay: false`; enabling them belongs with the safe `getMediaURI` work in
Task 8.4. The catalog was additionally restricted to Jellyfin's Audio playlist
media type to avoid advertising video playlists whose entries cannot satisfy
the strict track contract. That repair passed the full repository check and was
deployed as SMAPI Worker version `cc257452-f62c-4952-9321-b54aef6c4601`; the
first repeated category/playlist trace returned HTTP 200 without the earlier
generic playlist errors. A fresh iPhone browse from the root through global
Albums showed the album's track rows, while traced album `getMetadata` and
`getExtendedMetadata` calls returned HTTP 200. The track remained disabled as
expected under `canPlay: false`; clicking it generated no `getMediaMetadata`
call, and a supported desktop client exposed no add-to-queue action. Positive
real-app validation of that route therefore remains unexercised and is not
claimed.

The Sonos portal accepted and sent exactly one Personal SMAPI catalog with
`artists` to `artist`, `albums` to `album`, `tracks` to `track`, and `playlists`
to `playlist`, with no `all` or duplicate-library catalog. A supported Classic
Search client showed correct artist, album, track, and playlist results, and the
allow-listed trace showed app-issued search calls for all four categories
returning HTTP 200. The earlier mobile Sandbox limitation remains expected:
Sandbox mobile/Web apps do not expose Universal Search. A bounded source repair
removes the redundant ordinary root `Search` row while retaining the reserved
Classic Search container and four-category `search` method; the user confirmed
the post-repair root presentation no longer shows the separate `Search` row.

Idle and active-browse trials across the supported desktop client and iPhone
app issued no `getLastUpdate` request. The portal also rejected a 30-second
bootstrap polling interval as below its allowed minimum; no interval change was
published and the Sandbox bootstrap interval remains 60 seconds. The token
cadence, subsequent metadata refresh, and no-faster-than-advertised/no-recursive-
loop checks therefore remain unexercised. Both remaining native checks now
depend on completing the safe playback path in Tasks 8.1, 8.3, and 8.4: a
queueable track is required for the real-app `getMediaMetadata` call, and
playback is the remaining documented native `getLastUpdate` trigger after the
browse-only clients emitted none. The current full repository check passed with
28 test files and 750 unit/cross-Worker tests, seven isolated D1 tests, and
dry-run builds for both Workers. Task 7.9 remains open.

## Milestone 8 — Playback

Milestone exit: Sonos obtains track metadata and a safe Jellyfin-native media
URI, sends required allow-listed HTTP headers, and streams directly from
Jellyfin. MP3, AAC, FLAC, and at least one negotiated-transcode case have
credential-free compatibility evidence. Cloudflare does not proxy audio and no
Jellyfin token appears in a URI.

### [x] Task 8.1 — Playback contract and security decision

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

**Evidence:** the accepted playback ADR pins the Sonos SMAPI behavior and the
Jellyfin 10.11.11 source contract, defines an explicit Sonos `DeviceProfile`,
disables the broken distinct direct-stream path, and fixes deterministic source
selection, direct and transcode URL normalization, base-path containment, an
empty `RequiredHttpHeaders` pass-through allow-list, one internally constructed
authorization header, query-credential removal, MIME mapping, retry stability,
and credential-safe failure/logging rules. Four full sanitized PlaybackInfo
fixtures cover MP3, AAC-in-M4A, conforming FLAC, and high-resolution FLAC
negotiated to progressive MP3. A fixture test parses all four through the
existing Jellyfin client and verifies that they contain no server URL,
filesystem path, or returned header. No production playback route or
`canPlay` change is included.

### [x] Task 8.2 — `getMediaMetadata` (moved to Task 7.8b)

**Status:** implemented and verified by Task 7.8b; no separate implementation
remains. Real-app validation stays in Task 7.9.

- Task 7.8b owns the exact serializer, authenticated route, content-ID checks,
  shared formatting, fault mapping, and redaction tests.
- Task 8.4 owns any post-ADR change that makes those track representations
  playable once a safe media URI can also be returned.

### [x] Task 8.3 — Jellyfin playback-target resolver

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

**Evidence:** `getPlaybackInfo()` now sends the accepted Sonos device profile
and explicit negotiation settings. The exported resolver chooses a bounded,
deterministic direct-play or progressive-MP3 target, validates the selected
source and stream locally, enforces HTTPS and exact origin/base-path rules,
rejects unsafe paths, query fields, headers, and credential-bearing IDs, and
removes verified Jellyfin query credentials and request-specific fields. Four
sanitized playback fixtures plus adversarial source, URL, header, and retry
tests pass. The full repository check passed with 771 unit/cross-Worker tests,
seven isolated D1 tests, and both Worker dry-run builds. No SOAP or Worker
playback route or `canPlay` change was made.

### [x] Task 8.4 — `getMediaURI` integration

**Budget:** 3–4 hours. **Prerequisites:** 7.8b and 8.3.

- Add exact `getMediaURI` serialization, including an ordered list of permitted
  `httpHeader` entries, and route authenticated track IDs through the resolver.
- Only after that safe route is available, update the shared track metadata
  policy consistently so playable tracks no longer advertise `canPlay: false`.
- Map all invalid-item, invalid-token, no-compatible-stream, timeout, and
  upstream failures to credential-safe Sonos faults.
- Verify that the Worker returns metadata only and never fetches or proxies the
  audio response body. Test repeated requests and URL/header escaping.

**Evidence:** The SMAPI Worker authenticates and validates a WSDL-ordered
`getMediaURI` request, checks that the canonical ID still resolves to the same
Jellyfin track, negotiates PlaybackInfo, and serializes the resolver's HTTPS
target with one constructed Authorization header. The shared track formatter
advertises `canPlay: true` across browse, search, and metadata. Fixed SOAP
faults cover invalid parameters and items, expired Jellyfin credentials,
incompatible streams, and upstream failures. Tests cover stable repeat
responses, XML escaping, redaction, and the absence of a Worker audio fetch.
`pnpm check` passed with 794 unit/cross-Worker tests, seven isolated D1 tests,
and both Worker dry-run builds. Task 8.5 still needs real Sonos playback and
format verification.

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

## Milestone 10A — Service Bindings and method Workers

Milestone exit: `sonofin-smapi` remains the sole public SOAP endpoint and routes
each supported primary SMAPI method to its own private Worker through a
Cloudflare Service Binding. The method Workers are `sonofin-get-app-link`,
`sonofin-get-device-auth-token`, `sonofin-get-metadata`,
`sonofin-get-extended-metadata`, `sonofin-get-media-metadata`,
`sonofin-search`, `sonofin-get-last-update`, and, after Task 8.4,
`sonofin-get-media-uri`. A method added later gets a dedicated Worker when it
becomes supported. `sonofin-auth` onboarding and `sonofin-maintenance` retain
their distinct entry points. Keep the existing `@sonofin/*` packages as shared
code; a package is not automatically another Worker.

The objective is lower CPU time **per Worker invocation**, especially for the
public SMAPI Worker. Splitting code does not itself reduce end-to-end CPU use:
Cloudflare bills the total CPU across a caller and its Service Binding targets
on Workers Standard. See the
[Service Bindings API](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
and [pricing](https://developers.cloudflare.com/workers/platform/pricing/)
documentation. Measure gateway CPU, each method Worker's CPU, the sum per
Sonos operation, response latency, error rate, and invocation count against
the pre-split baseline. Preserve the SOAP contract and existing credential,
SSRF, bounded-read, and logging invariants. Do not call a method Worker through
a public URL. The target Worker should return a safe 404 from `fetch` and be
deployed without a public route or workers.dev exposure; use an awaited RPC
entrypoint for typed method calls. Keep one gateway-to-method hop per request
and stay within Cloudflare's invocation and subrequest limits.

### [ ] Task 10A.1 — CPU baseline and Service Binding ADR

**Budget:** 3–4 hours. **Prerequisites:** Tasks 8.4–8.5 and Milestone 10
complete; a representative staging Sonos/Jellyfin workload and access to its
Cloudflare Worker metrics or traces. **Gate:** measurement and design only.

- Record reproducible request mixes, sample sizes, p50/p95/p99 CPU and latency,
  error rates, and invocation counts for all supported methods and onboarding.
  Capture only aggregate, credential-safe data. Profile CPU hot paths locally.
- Write an ADR for the exact gateway/RPC boundary, versioned request/result and
  fault contracts, authentication placement, secret/D1 ownership, least-privilege
  bindings, and rollout/rollback order. Keep SOAP parsing, SOAPAction agreement,
  serialization, and public logging at the gateway. Credential-bearing method
  Workers validate their own credentials before accessing Jellyfin or D1; do
  not trust an unverified household ID or caller-supplied authorization context.
- Define a repeatable comparison using the same workload and deployment tier.
  Success requires lower p50 and p95 CPU for `sonofin-smapi`, no material
  regression in summed CPU or p95 Sonos response latency, and no increase in
  protocol errors. Record the numeric regression tolerance before coding.

### [ ] Task 10A.2 — Private Worker contract and local test harness

**Budget:** 3–4.5 hours. **Prerequisite:** accepted 10A.1 ADR.

- Add the shared typed RPC contracts and thin gateway adapter behind injectable
  dependencies. Preserve existing `handleRequest` unit-test seams and SOAP
  fault/log classifications. Bound and validate all values crossing RPC.
- Add a reusable Worker package/build pattern, placeholder-only binding examples,
  and a multi-Worker local development/test path with the same D1 persistence.
  Test target availability, timeout/rejection, response size, and safe gateway
  fault behavior. Check that method Workers have no public route.
- Document target-first deployment and mixed-version compatibility; deploy an
  additive method interface before switching the gateway to call it.

### [ ] Task 10A.3 — Link and credential method Workers

**Budget:** 3–4.5 hours. **Prerequisite:** 10A.2.

- Move `getAppLink` and `getDeviceAuthToken` execution to their **two distinct**
  method Workers via Service Bindings. Give each only the D1 binding and secrets
  it needs. Keep link issuance, claim, Sonos credential issuance, retry
  idempotence, exact household binding, and SOAP fault behavior unchanged.
- Test successful calls, replay, expired/unknown links, concurrent claims,
  binding failures, secret redaction, and the full cross-Worker onboarding flow.

### [ ] Task 10A.4 — Browse metadata method Workers

**Budget:** 3–4.5 hours. **Prerequisite:** 10A.3.

- Move `getMetadata` and `getExtendedMetadata` execution to **separate**
  method Workers. Authenticate independently inside each Worker; reuse the
  existing repository and Jellyfin client contracts without duplicating their
  security logic.
- Preserve canonical IDs, pagination, ordering, Sonos element order, safe
  faults, bounded Jellyfin responses, and exact household/device bindings.
  Exercise root, artists, albums, playlists, and invalid/expired credentials.

### [ ] Task 10A.5 — Playback metadata and URI method Workers

**Budget:** 3–4.5 hours. **Prerequisite:** 10A.4 and Task 8.4.

- Move `getMediaMetadata` and `getMediaURI` execution to **separate** method
  Workers through their own bindings. Preserve Task 8's playback authorization,
  native/transcode decisions, URL/header safety, and real-format behavior.
- Add focused contract and real-D1 tests for track IDs, stale credentials,
  rejected targets, binding errors, and redaction. Do not introduce media
  proxying or a second public playback endpoint.

### [ ] Task 10A.6 — Search and refresh method Workers

**Budget:** 3–4.5 hours. **Prerequisite:** 10A.5.

- Move `search` and `getLastUpdate` execution to **separate** method Workers.
  Keep category filtering, pagination, fixed fault mapping, and the deterministic
  30-second refresh token and poll interval unchanged.
- Verify every supported method is now routed over exactly one awaited Service
  Binding call; unsupported methods still receive the existing safe SOAP fault.
  Run `pnpm check` across all Worker builds and integration tests.

### [ ] Task 10A.7 — Staging comparison and topology closeout

**Budget:** 3–4.5 hours. **Prerequisite:** 10A.6, staging access, and explicit
authorization for the staging deployment. **Gate:** no production deployment.

- Deploy method Workers first and the gateway second. Run the same real Sonos
  workload and failure probes as 10A.1. Capture aggregate per-Worker and
  end-to-end CPU, p50/p95/p99 latency, invocation/subrequest counts, errors,
  and cost-relevant total CPU. Compare to the ADR's predeclared tolerances.
- If the gateway CPU goal or end-to-end gates fail, profile the regression and
  repair within scope or roll back the gateway while leaving compatible target
  Workers. Do not mark this milestone complete solely because CPU moved from
  one Worker to another.
- Update deployment/operations documentation, release checks, and the Worker
  inventory used by Milestones 11–12; run `pnpm check` and close the milestone
  only after the measured and protocol gates pass.

## Milestone 11 — Security hardening

Milestone exit: arbitrary Jellyfin hostnames are subject to a documented and
connect-time-defensible public-address policy, public routes have compatible
abuse controls, browser onboarding has a resolved CSRF model, production cannot
enable local HTTP accidentally, and adversarial regression tests pass.

### [ ] Task 11.1 — DNS rebinding feasibility and SSRF ADR

**Budget:** 2.5–4 hours. **Prerequisite:** Milestone 10A complete.

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

- Audit every public route, Service Binding/RPC boundary, and outbound path for
  bounded reads, timeouts, redirect rejection, fixed paths, XML/HTML/header
  injection, query credentials, and allow-listed logging. Include
  playback-derived URLs and headers.
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

- Inventory every secret, variable, D1 binding, Service Binding,
  rate-limit/egress binding, route/domain, Cron Trigger, compatibility date,
  and deployment dependency for the gateway, all method Workers, onboarding,
  and maintenance. Make checked-in examples consistent and placeholder-only.
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
  `getExtendedMetadataText` is mandatory, create a separate bounded
  implementation task; do not hide it inside this documentation task.

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

- `getExtendedMetadataText`
- `reportAccountAction` and playback reporting
- favorites and playlist mutation
- authenticated artwork delivery (subject to the mandatory future-task
  requirements below)
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

### Mandatory requirements for a future authenticated-artwork task

When authenticated artwork delivery is promoted into a numbered task, that
task must use Cloudflare's Cache API as an authorization-gated, on-demand edge
cache rather than preloading a Jellyfin library or fetching every image on
every Sonos request:

- Add bounded HTTPS `GET` artwork routing and emit Sonos `albumArtURI` values
  with `requiresAuthentication="true"` where supported. Authenticate the exact
  Sonos household/device-link credentials and resolve their Jellyfin connection
  before consulting the shared cache; a cache hit must never bypass household
  binding or connection authorization.
- Build one canonical internal cache key from a non-secret connection scope,
  Jellyfin item/image identity, Jellyfin image tag or equivalent version, and
  the allow-listed size/format variant. Do not place Sonos or Jellyfin
  credentials, raw authorization headers, private server URLs, or user data in
  the public artwork URI, cache key, errors, or logs. Keep emitted URIs within
  Sonos limits and prevent collisions between different Jellyfin servers or
  connections.
- On a cache hit, return the cached complete image with a validated content
  type and safe response headers. On a miss, make one bounded authenticated
  Jellyfin image request using the existing redirect and target protections;
  accept only a successful, allow-listed image response within the configured
  byte limit, store a clone with `ctx.waitUntil`, and return the other response
  to Sonos. Cache only complete `200` responses; do not cache authentication
  failures, redirects, partial responses, malformed images, upstream failures,
  or missing artwork.
- Use versioned image keys so an artwork/tag change is an automatic cache miss
  without a broad purge. Define and test an explicit positive edge TTL and
  client-cache policy. Keep the response returned to Sonos private so automatic
  Workers/CDN caching cannot serve it before Worker authorization; only the
  post-authentication Cache API path may reuse the shared cached bytes.
- Cover cold miss/store, warm hit without a Jellyfin call, version and variant
  misses, connection isolation, authorization-before-hit ordering, concurrent
  misses, TTL/header behavior, oversize and wrong-content rejection, safe
  failure handling, and credential/identifier redaction. Document that Cache
  API entries are opportunistic and data-center-local, so eviction or a request
  reaching another Cloudflare location safely falls back to the same miss path.
