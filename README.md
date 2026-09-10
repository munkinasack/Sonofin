# Sonofin 2.0

[![CI](https://github.com/munkinasack/Sonofin/actions/workflows/ci.yml/badge.svg)](https://github.com/munkinasack/Sonofin/actions/workflows/ci.yml)

> [!WARNING]
> Sonofin is pre-release software and has not completed its security-hardening
> or deployment milestones. Do not expose the current Workers as an untrusted
> public, multi-tenant service.

Sonofin is a Cloudflare Workers implementation of a Sonos Music API service
for Jellyfin. The repository currently implements **Milestone 6 plus Tasks
7.1–7.8b**: browser onboarding ends with a separate, durable Sonos-facing
credential, the Jellyfin package provides the reusable authenticated music-data
layer, and the SMAPI Worker resolves each authenticated Sonos mapping into a
request-scoped Jellyfin data client. The Worker implements authenticated
`getMetadata` routes for the fixed root menu, paginated artists, global or
artist-filtered albums, and album or playlist tracks. It also implements the
matching four-category search contract and the mandatory metadata methods.

Task 7.9 real-system verification is in progress; Milestones 8–12 remain future
work. Onboarding, root browsing, artist albums, playlist contents, and paging
past 100 artists have passed in a real Sonos/Jellyfin session. Playlist tracks
are visible but intentionally disabled while `canPlay` remains false before
Milestone 8. Album-track display and app-issued search remain under
verification. The remaining product goals are in
[`Sonofin_2_Codex_Handoff.md`](Sonofin_2_Codex_Handoff.md), and the authoritative
dependency-ordered execution packets are in
[`Sonofin_2_Remaining_Milestones.md`](Sonofin_2_Remaining_Milestones.md). Each
packet is scoped for one task of at most five hours using `gpt-5.6-sol` with
ultra reasoning; do not implement a whole remaining milestone in one run.

## What Task 7.8b adds

- `getMediaMetadata` now has an exact WSDL-ordered serializer and an
  authenticated, `id`-only Worker route backed by Jellyfin
  `getItemMetadata()`.
- The route accepts only canonical track IDs, requires Jellyfin to return that
  same item kind, and reuses the shared track formatter so browse, search,
  extended-metadata, and media-metadata representations cannot drift.
- The `mediaMetadata` fields are emitted directly inside
  `getMediaMetadataResult`, as required by the WSDL. There is no extra
  `mediaMetadata` wrapper.
- This is metadata-only compatibility. Tracks deliberately retain
  `canPlay: false`; `getMediaURI`, playback negotiation, URLs, headers,
  transcoding, and streaming remain Milestone 8 work.

## What Task 7.8a adds

- `getExtendedMetadata` now has an exact WSDL-ordered serializer and an
  authenticated, `id`-only Worker route.
- Static root/category IDs reuse their canonical browse representations.
  Jellyfin artist, album, playlist, and track IDs are resolved through
  `getItemMetadata()` and must match the encoded kind before their shared
  browse formatter is used.
- Responses contain exactly one `mediaCollection` or `mediaMetadata`; related
  text, actions, artwork delivery, and playback behavior remain out of scope.
- Invalid parameters, deleted or wrong-kind items, credential failures, and
  upstream failures retain fixed SOAP faults and allow-listed diagnostics.

## What Task 7.8 adds

- Browsing the literal `search` container returns Artists (`artist`), Albums
  (`album`), Tracks (`track`), and Playlists (`playlist`) in stable paginated
  order. Each collection uses SMAPI's `search` item type, and those exact
  singular IDs are the only categories accepted by the `search` method.
- The authenticated Worker routes WSDL-ordered `id`, `term`, `index`, and
  `count` parameters through an injected search service. Categories, Unicode
  terms, and Sonos page bounds are validated before contacting Jellyfin;
  missing, plural, unknown, extra, or out-of-order inputs receive one fixed,
  credential-safe client fault.
- Search results reuse the browse collection and track formatters, preserving
  Jellyfin order and totals while producing the same canonical artist, album,
  playlist, and track IDs and metadata as `getMetadata`. A response outside the
  requested category or page fails closed.
- `@sonofin/sonos-smapi` serializes `searchResponse`/`searchResult` using the
  WSDL media-list order and the same item, paging, text, and XML-safety checks
  as browse responses. Search logs may include only closed category/kind and
  failure-origin classifications; they never include terms, raw or encoded
  item IDs, credentials, URLs, or upstream error text.

## What Task 7.7 adds

- `@sonofin/jellyfin-client` exports the `JellyfinSearchCategory` union and
  requires every search to choose `artist`, `album`, `track`, or `playlist`.
- Each category maps through a fixed allow-list to exactly one Jellyfin item
  type: `MusicArtist`, `MusicAlbum`, `Audio`, or `Playlist`. Artist searches use
  Jellyfin's artist-only collection endpoint; the other categories send one
  exact item-type filter to the general collection endpoint. Filtering
  therefore happens before pagination instead of filtering a mixed page
  locally and corrupting its total.
- Searches retain the existing bounded, trimmed term; optional library scope;
  validated page bounds; normalized result model; server-returned start index;
  and Jellyfin-reported total. A missing or unknown category is rejected before
  any network call, and a response outside the requested category fails closed
  as an invalid server response.
- Task 7.8 adds SOAP serialization, category presentation, and authenticated
  Worker routing on top of this client contract.

## What Task 7.6 adds

- Browsing `playlists` calls the request-scoped Jellyfin client's aggregate
  `getPlaylists()` operation, restricts the catalog to Jellyfin's Audio playlist
  media type, and maps the page to canonical, non-playable, enumerable playlist
  collections. A safe Jellyfin child count is exposed as the collection total
  when available; absent or out-of-range optional counts are omitted.
- Browsing an encoded playlist ID calls `getPlaylistTracks()` with the exact
  decoded Jellyfin playlist ID and requested page. Entries remain in Jellyfin's
  playlist order, empty and out-of-range pages preserve their totals, and
  duplicate occurrences are not sorted, filtered, or deduplicated.
- Playlist entries reuse the Task 7.5 track formatter. Their SMAPI IDs always
  encode the underlying Jellyfin catalog track ID, never `PlaylistItemId`.
  Jellyfin's separate playlist-entry identity remains in the normalized client
  model for occurrence-specific operations, while browse, current metadata,
  and future playback consistently identify the catalog item.
- Missing playlists or items and other typed Jellyfin failures retain the fixed,
  credential-safe SOAP mappings. Playlist editing, favorites, caching,
  recursive flattening, playback, and artwork delivery remain out of scope.

## What Task 7.5 adds

- Browsing `albums` calls the request-scoped Jellyfin client's aggregate
  `getAlbums()` operation without an artist filter and maps the page through the
  same canonical album collection formatter used below artists.
- Browsing an encoded album ID calls `getAlbumTracks()` with the exact decoded
  Jellyfin album ID. The Worker preserves Jellyfin's disc/track ordering,
  requested page index, and total rather than re-sorting tracks locally.
- One exported normalized-track formatter now gives album, playlist, search,
  extended-metadata, and media-metadata routes a consistent SMAPI
  representation.
  It emits canonical track, artist, and album IDs when usable; converts
  Jellyfin milliseconds to whole Sonos seconds; retains a safe track number;
  and omits unavailable or unsafe optional metadata.
- MIME types are derived only from a fixed, documented container allow-list:
  MP3, FLAC, AAC, M4A/MP4, Ogg, and WMA/ASF. Because SMAPI requires a MIME type,
  a missing, ambiguous, or unknown Jellyfin container is rejected as an invalid
  upstream item rather than guessed or silently removed from a page.
- Album collections remain enumerable but non-playable because recursive
  flattening is not implemented. Track playback, skipping, seeking, favorites,
  and resume are explicitly disabled until Milestone 8 supplies playback.
  Authenticated artwork delivery remains unassigned.

## What Task 7.4 adds

- Browsing `artists` calls the request-scoped Jellyfin client's paginated
  `getArtists()` operation and maps the page to non-playable, enumerable Sonos
  artist collections with canonical encoded IDs.
- Browsing an encoded artist ID calls `getAlbums()` with that exact decoded
  artist ID and the requested page. Albums retain Jellyfin order and total
  counts and use canonical encoded album IDs.
- Jellyfin pages must begin at the requested index and cannot contain more than
  the requested count; a mismatched upstream page is rejected safely.
- Required missing, blank, XML-unsafe, multiline, or overlong collection names
  and required IDs are rejected as an invalid upstream response. Optional
  album-artist metadata is emitted only when Sonos-safe; unavailable, multiline,
  or overlong optional values and unrelated overview or image data are omitted.
- Global Albums and album-track browsing are added by Task 7.5; authenticated
  artwork delivery remains unassigned.

## What Task 7.3 adds

- The SMAPI Worker now routes authenticated `getMetadata` requests through an
  injected browse service. The route retains responsibility for authentication,
  safe fault mapping, and XML serialization; the service owns validated content
  IDs, paging, and conversion to typed browse results.
- Browsing the literal `root` ID returns Artists (`artists`, `container`),
  Albums (`albums`, `albumList`), Playlists (`playlists`, `container`), and
  Search (`search`, `container`) in that stable order. The read-only Playlists
  category is a generic container rather than Sonos's special editable-user-
  playlists root; individual Jellyfin playlist rows retain the `playlist`
  item type. The response reports a stable total of four and supports partial
  and empty out-of-range pages.
- The root represents one aggregate catalog across all music libraries visible
  to the authenticated Jellyfin user. It exposes no per-library nodes and makes
  no Jellyfin data request; Task 7.4 adds artist and artist-album contents.
- `id`, `index`, and `count` are required and follow the Task 7.1 canonical ID
  and pagination bounds. Parameters must follow WSDL order. The optional
  `recursive` flag accepts only the non-recursive XML Schema forms `false` and
  `0`; recursive flattening is not advertised by the non-playable root and is
  deferred with category contents.
- Malformed parameters map to a fixed `soap:Client` fault, while canonical but
  not-yet-implemented IDs map to `Client.ItemNotFound`. Authentication,
  Jellyfin, and unknown-service failures retain their Task 7.2 fixed mappings.
  Success and failure logs allow-list only fixed method, category/kind,
  failure-origin, outcome, and reason classifications; raw parameters, unknown
  or encoded item IDs, credentials, URLs, and thrown text are never logged.

## What Task 7.2 adds

- Authenticated SMAPI requests now retain the exact, case-sensitive Sonos
  mapping (`id`, `householdId`, and `jellyfinConnectionId`) in a request-scoped
  context instead of reducing authentication to a boolean. The context exposes
  a `JellyfinDataClient`, not the parsed Sonos credential or decrypted Jellyfin
  connection/token.
- Connection resolution and data-client creation are injected seams. Production
  retrieves the mapped D1 record, decrypts it with `AesGcmTokenCipher`, and
  constructs `JellyfinApiClient`; unit tests continue to use local fakes.
- The auth and SMAPI Workers use the same environment-specific
  `JELLYFIN_TOKEN_ENCRYPTION_KEY`. `SONOS_TOKEN_SIGNING_KEY` remains a distinct
  SMAPI-only HMAC key with its existing staged fallback-key procedure.
- Connection-integrity, client-construction, and typed Jellyfin failures map to
  fixed credential-safe SOAP faults. Invalid Sonos credentials still return
  `Client.LoginUnauthorized`; an invalid Jellyfin token returns
  `Client.AuthTokenExpired`; missing items return `Client.ItemNotFound`; an
  unreachable Jellyfin server returns `Server.ServiceUnavailable`; and
  unclassified, storage, decryption, configuration, or invalid-response failures
  return `Server.ServiceUnknownError`. Faults and allow-listed logs never include
  thrown messages, server bodies, credential-bearing URLs, or tokens.
- Task 7.2 itself did not add a browse route or make a Jellyfin network request.
  `getLastUpdate` still constructs the authenticated context to verify the
  complete mapping/decryption/client boundary, then returns its existing
  hard-coded response. Task 7.3 reuses that context for the root browse route.

## What Task 7.1 adds

- `@sonofin/sonos-smapi` exports typed collection and track browse results and
  serializes ordered, namespace-correct `getMetadata` responses. A single
  discriminated item list preserves mixed collection/track order, and the
  response count is derived from the number of serialized items.
- A deterministic content-ID codec keeps Sonos's literal root and category IDs
  while encoding Jellyfin artist, album, playlist, and track IDs into distinct,
  versioned, canonical base64url namespaces. Decoding preserves exact opaque
  IDs without Unicode normalization and can require an expected kind.
- Content IDs are limited to 128 characters. Malformed, non-canonical,
  overlong, and wrong-kind IDs fail closed without being included in errors.
- Pagination accepts only canonical decimal `index` and `count` values, bounds
  them to the SMAPI signed-integer and 100-item page limits, and enforces page
  count/total consistency while allowing empty out-of-range pages.
- Task 7.1 was a protocol-only foundation. Task 7.2 added the authenticated
  request context, and Task 7.3 now uses both layers for the root menu.

## What Milestone 6 adds

- `@sonofin/jellyfin-client` exports a mockable `JellyfinDataClient` contract
  and a concrete `JellyfinApiClient` bound to a decrypted
  `JellyfinConnection`.
- The client provides authenticated server information, user libraries,
  artists, albums (including library and album-artist filters), ordered album
  tracks, playlists, ordered playlist tracks, music search, item metadata, and
  playback information.
- Jellyfin wire objects are validated and normalized into Sonofin library,
  artist, album, track, playlist, search, metadata, media-source, and audio
  stream types. No Jellyfin PascalCase response objects or Sonos XML formatting
  cross the package boundary.
- Collection calls are explicitly paginated, with a bounded default page and a
  fixed maximum page size. User/item IDs and search terms are encoded with
  fixed endpoint paths, and Jellyfin tokens remain in the authorization header.
- The data client reuses the authentication client's hardened transport:
  HTTPS by default, preserved Jellyfin base paths, manual redirect rejection,
  request deadlines that cover body reads, bounded streaming JSON reads,
  malformed UTF-8 rejection, and credential-safe typed errors.
- `401` and `403` responses consistently invalidate the Jellyfin token;
  item-scoped `404` responses have a distinct `item_not_found` error, while
  other server failures remain safely generalized.

Milestone 6 deliberately did not add SMAPI browsing. Tasks 7.1–7.8b now supply
the browse protocol layer, authenticated context, root route, artist and album
collections, album tracks, playlists, playlist tracks, and the
category-filtered Jellyfin and Sonos search contracts, plus the required
extended- and media-metadata methods. Direct
Sonos-to-Jellyfin playback integration and activity tracking remain later tasks
in Milestones 8–9. Caching and stream proxying remain explicitly deferred.

## What Milestone 5 proves

- `sonofin-smapi` accepts namespace-aware SOAP 1.1 at `POST /smapi`.
- `getAppLink` creates a 10-minute pending link before returning its browser URL.
- Each link has independent 192-bit random `linkCode` and `linkDeviceId` values.
- D1 stores only lowercase SHA-256 hashes of those temporary values.
- `sonofin-auth` serves `GET /onboarding` and accepts a bounded form at
  `POST /onboarding`.
- The onboarding form accepts a Jellyfin server URL and exactly one
  authentication method: username/password or an existing access token.
- Before making any outbound request, the auth Worker verifies that the link is
  valid, pending, and unexpired.
- `@sonofin/jellyfin-client` identifies the server through
  `GET /System/Info/Public`, authenticates username/password through
  `POST /Users/AuthenticateByName`, and validates a supplied token through
  `GET /Users/Me`.
- Jellyfin URLs may include a base path such as `https://example.com/jellyfin`.
  The client requires HTTPS by default; rejects embedded credentials, queries,
  fragments, local hostnames, and literal private or link-local IP targets;
  bounds request time and response size; rejects all redirects; and performs no
  logging.
- `@sonofin/crypto` encrypts Jellyfin access tokens with AES-256-GCM, a fresh
  96-bit nonce, and authenticated data bound to the connection and its critical
  server/user metadata. The key is a single 32-byte, base64url-encoded Worker
  Secret named `JELLYFIN_TOKEN_ENCRYPTION_KEY`.
- `@sonofin/connections` creates independent 192-bit connection IDs, persists
  only authenticated ciphertext plus normalized Jellyfin server, user, and
  device metadata, and can retrieve and decrypt a connection after service
  recreation. D1 never receives a plaintext Jellyfin access token.
- The auth Worker discards the submitted password and stores the resulting
  Jellyfin access token encrypted before completing the onboarding link. A
  password-created token is retained after successful persistence because it is
  the durable Jellyfin credential. On a definitive failure it is revoked before
  an unassociated encrypted record is removed; uncertain link commits are
  reconciled first, and a record is retained if revocation fails. A directly
  supplied token is never revoked.
- `@sonofin/sonos-auth` derives a 256-bit opaque `SF_...` credential with
  HMAC-SHA-256 under the `SONOS_TOKEN_SIGNING_KEY` Worker Secret. Domain
  separation produces an independent `SF_NO_REFRESH_...` private-key value;
  this milestone uses Sonos's supported non-expiring authentication mode and
  does not implement token refresh.
- Deterministic secret-key derivation makes repeated and concurrent
  `getDeviceAuthToken` polls converge on the same credentials without storing
  either plaintext value. D1 stores only the auth token's lowercase SHA-256
  hash, its exact household binding, its Jellyfin connection ID, creation time,
  and optional revocation time. A D1 trigger rejects an association unless its
  ID, household, and Jellyfin connection exactly match the claimed onboarding
  link.
- `getDeviceAuthToken` returns `Client.NOT_LINKED_RETRY`/Sonos error 5 while the
  link is pending, durable Sonos credentials after completion, and
  `Client.NOT_LINKED_FAILURE`/Sonos error 6 for a terminal mismatch, expiry, or
  superseded issuance.
- Link completion and claiming use guarded D1 updates. Household IDs are opaque,
  exact, case-sensitive bindings, and a matching `linkDeviceId` is required.
- The namespace-aware SOAP parser extracts Sonos `credentials/loginToken`
  headers without logging them. At Milestone 5, `getLastUpdate` was the first
  post-authentication method to resolve a valid non-revoked token to its exact
  household and encrypted Jellyfin connection, decrypt that connection, and
  construct a data client; missing, malformed, unknown, revoked, or
  household-mismatched credentials fail with `Client.LoginUnauthorized`.
- Multiple Sonos service accounts may coexist in one household. Revocation is
  targeted to one token and exact household; replacement is a new issuance plus
  targeted revocation, so unrelated household accounts are not invalidated. If
  Sonos includes a valid prior `loginToken` while completing a replacement
  link, the SMAPI Worker issues the new credential first and then revokes only
  that authenticated prior credential.
- Request logs are allow-listed and never receive SOAP bodies, headers, link
  codes, device bindings, passwords, or tokens.

The Milestone 2 `SF_M2_FAKE_...` and `SF_M2_NO_REFRESH_...` fixtures are no
longer returned. Sonos credentials remain valid until targeted revocation or a
later retention milestone removes their association; temporary link expiry does
not invalidate an issued credential.

The URL checks in this milestone are syntactic defense in depth, not the final
public multi-tenant security boundary. They do not resolve arbitrary hostnames
or defend against DNS rebinding. DNS/address-resolution enforcement, rate
limits, and onboarding abuse controls remain explicitly scoped to Milestone 11.

## Repository layout

```text
apps/
  auth-worker/        public, temporary browser-onboarding route
  smapi-worker/       public Sonos SOAP endpoint
packages/
  connections/        encrypted Jellyfin connection lifecycle and contracts
  crypto/             AES-GCM token encryption using a Worker Secret
  database/           D1 repository and forward-only SQL migrations
  jellyfin-client/    bounded Jellyfin authentication and normalized data client
  linking/            cryptographic link lifecycle and state machine
  shared/             bounded request reader and credential-safe logging
  sonos-auth/         hash-only Sonos credential issuance and validation
  sonos-smapi/        SOAP parsing, browse IDs/paging, and XML serializers
```

## Prerequisites

- Node.js 22 or newer
- pnpm 11
- A Cloudflare account for deployment; local development does not access
  production D1

## Clone, install, and verify

```bash
git clone https://github.com/munkinasack/Sonofin.git
cd Sonofin
pnpm install
pnpm check
```

`pnpm check` runs ESLint, strict TypeScript checks, unit and cross-Worker
lifecycle tests, an isolated real-D1 migration/CAS test, and Wrangler dry-run
builds for both Workers. The D1 test uses only an ephemeral local runtime; it
does not access production storage.

## Configure D1

Both Workers must bind the same D1 database as `DB`. Their checked-in Wrangler
files use Cloudflare's all-zero local fixture ID so local development works
before a production database is provisioned.

For deployment, create the database once:

```bash
pnpm exec wrangler d1 create sonofin
```

Copy the returned `database_id` into both
`apps/smapi-worker/wrangler.jsonc` and `apps/auth-worker/wrangler.jsonc`. Apply
the migration locally with:

```bash
pnpm db:migrate:local
```

Every local command uses the same `.wrangler/state` persistence directory.
Migration `0001` deliberately clears completion/claim state from legacy
Milestone 3 links because their marker did not reference a stored credential;
their hashed link bindings and expiry are preserved, so an unexpired browser
flow can submit Jellyfin credentials again. Migration `0002` adds the
hash-only Sonos-to-Jellyfin associations without rewriting existing links.

## Run the two Workers locally

Start each command in its own terminal:

```bash
pnpm dev:auth
```

```bash
pnpm dev:smapi
```

The default endpoints are:

```text
http://127.0.0.1:8787/smapi
http://127.0.0.1:8788/onboarding
```

The link lifetime and onboarding base URL are non-secret Wrangler variables.
Both Workers require the same Jellyfin encryption secret: onboarding encrypts
connections and SMAPI decrypts them. The SMAPI Worker additionally requires a
different Sonos token-derivation secret. Copy both local examples before
starting the Workers:

```bash
cp apps/auth-worker/.dev.vars.example apps/auth-worker/.dev.vars
cp apps/smapi-worker/.dev.vars.example apps/smapi-worker/.dev.vars
```

The checked-in `JELLYFIN_TOKEN_ENCRYPTION_KEY` and `SONOS_TOKEN_SIGNING_KEY`
values are intentionally public, local-only fixtures. The AES fixture is the
same in both examples, while the HMAC fixture is visibly different. For a real
environment, generate one 32-byte unpadded-base64url AES value and configure
that exact value on both Workers; generate a separate value for Sonos signing.

The Jellyfin encryption layer currently has no key identifier, fallback
keyring, or re-encryption path. Losing or changing its key makes existing
connections unreadable. Never rotate it on only one Worker: a partial rollout
would make one Worker unable to read records written by the other. A future
rotation must first add dual-key decryption and re-encryption, or explicitly
require every connection to be relinked; a bare rolling secret change is not
supported.

During a Sonos signing-key rotation, set
`SONOS_TOKEN_FALLBACK_SIGNING_KEYS` to a comma-separated replay keyring with no
spaces or empty entries. Before promoting a new key, configure every Worker
generation with both the current and next keys in this fallback list and wait
for that deployment to finish. Then replace `SONOS_TOKEN_SIGNING_KEY` with the
staged key while leaving both keys in the fallback list. Old and new Worker
generations can consequently replay either credential during rollout. Keep the
old key configured until every onboarding link whose credential may have been
issued under it has expired; retries can then reproduce the originally issued
credential while all new issuances use the current key. After that replay
window closes, remove the old and duplicate entries from
`SONOS_TOKEN_FALLBACK_SIGNING_KEYS` and redeploy.
Existing Sonos requests are validated against stored token hashes and do not
require the derivation key. The copied `.dev.vars` files are ignored by Git.

Both examples also set `ALLOW_INSECURE_JELLYFIN_HTTP=true`. That is only a local
development opt-in and must match when SMAPI reopens an HTTP connection created
through onboarding. Remove it when it is not needed and never set it on a
deployed Worker. The opt-in relaxes only the URL scheme; localhost/local
hostnames and literal private or link-local addresses remain blocked.

## Exercise the lifecycle manually

First request a link for an opaque test household:

```bash
curl --request POST 'http://127.0.0.1:8787/smapi' \
  --header 'Content-Type: text/xml; charset=utf-8' \
  --header 'SOAPAction: "http://www.sonos.com/Services/1.1#getAppLink"' \
  --data-binary '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><getAppLink xmlns="http://www.sonos.com/Services/1.1"><householdId>Sonos_Test_Household</householdId></getAppLink></soap:Body></soap:Envelope>'
```

Copy `linkCode`, `linkDeviceId`, and `regUrl` from the response. Before opening
`regUrl`, a `getDeviceAuthToken` request with those exact three values returns a
500 SOAP retry fault:

```bash
curl --request POST 'http://127.0.0.1:8787/smapi' \
  --header 'Content-Type: text/xml; charset=utf-8' \
  --header 'SOAPAction: "http://www.sonos.com/Services/1.1#getDeviceAuthToken"' \
  --data-binary '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><getDeviceAuthToken xmlns="http://www.sonos.com/Services/1.1"><householdId>Sonos_Test_Household</householdId><linkCode>PASTE_LINK_CODE</linkCode><linkDeviceId>PASTE_LINK_DEVICE_ID</linkDeviceId></getDeviceAuthToken></soap:Body></soap:Envelope>'
```

Open `regUrl` in a browser. Enter the Jellyfin server URL, then either a username
and password or an existing access token, and select **Connect Jellyfin**. Use
only one authentication method. The server URL must use HTTPS unless the
local-only opt-in above is enabled. Enter the exact Jellyfin base URL, including
any reverse-proxy subpath, because the client does not follow redirects.

The same username/password form can be submitted with curl:

```bash
curl --request POST 'http://127.0.0.1:8788/onboarding' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'linkCode=PASTE_LINK_CODE' \
  --data-urlencode 'serverUrl=https://jellyfin.example.com' \
  --data-urlencode 'username=PASTE_JELLYFIN_USERNAME' \
  --data-urlencode 'password=PASTE_JELLYFIN_PASSWORD'
```

Or submit an existing Jellyfin access token instead:

```bash
curl --request POST 'http://127.0.0.1:8788/onboarding' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'linkCode=PASTE_LINK_CODE' \
  --data-urlencode 'serverUrl=https://jellyfin.example.com' \
  --data-urlencode 'accessToken=PASTE_JELLYFIN_ACCESS_TOKEN'
```

The auth Worker validates the account, encrypts the usable Jellyfin token, stores
the encrypted connection in D1, associates it with the temporary link, and then
redirects to the completed page. It never persists the submitted password. A
directly supplied access token is never revoked. Repeating the device-token
request then returns HTTP 200 with a durable `SF_...` token and non-refresh
private-key value. Repeating that exact request before link expiry returns the
same values. Changing the household, code, or device binding produces a terminal
failure fault. After issuance, authenticated SOAP requests carry the returned
token and exact household in the `credentials/loginToken` header; unknown or
revoked tokens receive `Client.LoginUnauthorized`.

The automated lifecycle test performs this same sequence across both Worker
handlers. The D1 migration can also be inspected locally without exposing raw
codes:

```bash
pnpm exec wrangler d1 execute sonofin \
  --local \
  --persist-to .wrangler/state \
  --config apps/smapi-worker/wrangler.jsonc \
  --command 'SELECT link_code_hash, link_device_id_hash, household_id, jellyfin_connection_id, created_at, expires_at, completed_at, claimed_at FROM onboarding_links; SELECT id, server_url, server_id, user_id, token_algorithm, length(encrypted_token) AS encrypted_token_length, length(token_nonce) AS token_nonce_length, created_at FROM jellyfin_connections; SELECT id, jellyfin_connection_id, household_id, length(auth_token_hash) AS auth_token_hash_length, created_at, revoked_at FROM sonos_connections;'
```

## Deploy

Generate and securely retain two different environment-specific keys by running
this command twice. Use one value as the shared Jellyfin AES key on both
Workers, and the other as the SMAPI-only Sonos HMAC key:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

Apply migrations remotely, store each generated value in its owning Worker, and
then deploy both Workers:

```bash
pnpm exec wrangler d1 migrations apply sonofin \
  --remote \
  --config apps/smapi-worker/wrangler.jsonc
pnpm exec wrangler secret put JELLYFIN_TOKEN_ENCRYPTION_KEY \
  --config apps/auth-worker/wrangler.jsonc
pnpm exec wrangler secret put JELLYFIN_TOKEN_ENCRYPTION_KEY \
  --config apps/smapi-worker/wrangler.jsonc
pnpm exec wrangler secret put SONOS_TOKEN_SIGNING_KEY \
  --config apps/smapi-worker/wrangler.jsonc
pnpm --filter @sonofin/auth-worker deploy
pnpm --filter @sonofin/smapi-worker deploy
```

Set `ONBOARDING_URL` in the SMAPI Wrangler configuration to the deployed HTTPS
`sonofin-auth` URL before deployment. Do not use the local fixture database ID
in production. Enter the exact same freshly generated AES value at both
`JELLYFIN_TOKEN_ENCRYPTION_KEY` prompts, then enter a distinct freshly generated
HMAC value for `SONOS_TOKEN_SIGNING_KEY`. All values must be 32-byte unpadded
base64url. Do not reuse either local fixture, reuse one key across the AES and
HMAC domains, put the values in Wrangler `vars`, or commit them. Do not rotate
the AES key until a supported re-encryption or relinking procedure is in place.
If rotating the Sonos key, temporarily store the staged keyring in the
`SONOS_TOKEN_FALLBACK_SIGNING_KEYS` secret as described above. Keep
`ALLOW_INSECURE_JELLYFIN_HTTP` unset in production and connect only to HTTPS
Jellyfin servers.

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow and pull
request expectations. Follow [`SECURITY.md`](SECURITY.md) to request a private
reporting channel, never putting vulnerability details in a public issue.

## License

No open-source license has been granted for this repository. The root package
is marked `UNLICENSED`; source availability does not grant permission to copy,
modify, or redistribute the project.

## Contract references

- [Jellyfin API documentation](https://api.jellyfin.org/)
- [Official Jellyfin TypeScript SDK](https://github.com/jellyfin/jellyfin-sdk-typescript)
- [Sonos browser authentication](https://docs.sonos.com/docs/add-browser-authentication)
- [Sonos `getDeviceAuthToken`](https://docs.sonos.com/docs/getdeviceauthtoken)
- [Sonos authentication tokens](https://docs.sonos.com/docs/use-authentication-tokens)
- [Sonos SMAPI error handling](https://docs.sonos.com/docs/error-handling)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare local data](https://developers.cloudflare.com/workers/local-development/local-data/)
