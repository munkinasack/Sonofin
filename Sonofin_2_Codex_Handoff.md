# Sonofin 2.0 — Codex Handoff

## Project Goal

Build a production-ready Sonos music-service connector for Jellyfin.

The goal is to allow Jellyfin users to add their Jellyfin server as a Sonos music service, while using Cloudflare Workers as the public Sonos-facing control/authentication layer.

The design should favor small, independently testable components that can be assembled gradually.

---

# Core Product Decisions

## 1. Sonos should initiate onboarding

There should NOT be a separate Sonofin account portal that users must visit first.

The intended user flow is:

1. User opens the Sonos app.
2. User selects **Add Music Service**.
3. User selects **Sonofin**.
4. Sonos invokes the SMAPI authentication flow.
5. `getAppLink` returns a Cloudflare-hosted onboarding URL and temporary link code.
6. Sonos opens that onboarding page.
7. User supplies:
   - Jellyfin server URL
   - Jellyfin username/password, OR optionally an existing Jellyfin access token
8. Cloudflare authenticates against the user's Jellyfin server.
9. If username/password was used:
   - exchange credentials for a Jellyfin access token
   - discard the password immediately
10. Cloudflare stores the Jellyfin access token encrypted.
11. Sonos calls `getDeviceAuthToken`.
12. Cloudflare returns a separate Sonofin/Sonos authentication token.
13. Normal Sonos SMAPI use begins.

There should be no ordinary Sonofin username/password account system.

---

# 2. Credential Model

There are TWO separate credential domains.

## Sonos-facing credential

Sonos receives an opaque Sonofin token.

Example concept:

```text
SF_xxxxxxxxxxxxxxxxx
```

Cloudflare should preferably store only a cryptographic hash of this token.

It maps to:

```text
Sonos token
  -> Sonos household
  -> Jellyfin connection
```

Sonos should never receive the stored Jellyfin password.

## Jellyfin-facing credential

Cloudflare stores:

- Jellyfin server URL
- Jellyfin user ID
- encrypted Jellyfin access token
- creation time
- last activity time
- status / health metadata if useful

Cloudflare should NOT retain the user's Jellyfin password.

Username/password should only be used long enough to obtain a Jellyfin access token.

Optionally allow advanced users to paste an existing Jellyfin token directly.

---

# 3. Cloudflare Storage

Use D1 as the canonical database.

The Jellyfin token should be encrypted at the application layer before being stored in D1.

Use a Worker Secret for the application encryption key.

Suggested secret examples:

```text
JELLYFIN_TOKEN_ENCRYPTION_KEY
SONOS_TOKEN_SIGNING_KEY
SESSION_OR_LINK_SIGNING_KEY
```

Do NOT create one Cloudflare Secret per Jellyfin user.

Suggested conceptual D1 tables:

```sql
jellyfin_connections
--------------------
id
server_url
jellyfin_user_id
encrypted_token
token_iv_or_nonce
created_at
last_used_at
last_success_at
last_failure_at
status

sonos_connections
-----------------
id
jellyfin_connection_id
sonos_household_id
auth_token_hash
created_at
last_used_at
revoked_at

link_codes
----------
id
link_code_hash
sonos_household_id
created_at
expires_at
completed_at
jellyfin_connection_id
```

Exact schema may change as implementation needs become clearer.

---

# 4. No General Cloudflare User Management Portal

Do NOT implement a persistent Cloudflare-hosted sign-in/dashboard for users.

If a user wants to change:

- Jellyfin server
- Jellyfin account
- Jellyfin credentials/token

the intended UX is:

```text
Remove Sonofin from Sonos
        ->
Add Sonofin again
        ->
complete onboarding again
```

The system should treat the connection as disposable/re-creatable.

If re-adding can be identified as the same Sonos household, the new connection should replace/revoke the old association where practical.

---

# 5. Sonos Removal Behavior

Do NOT assume Sonos will reliably tell Cloudflare when the user removes the music service.

Current design assumption:

- Sonos may not provide a reliable `removeAccount`/service-removed notification through SMAPI.
- Therefore cleanup must not depend on explicit removal notification.

Instead, use inactivity cleanup.

---

# 6. Inactivity Cleanup

Track genuine Sonos usage via `last_used_at`.

Examples of requests that should count as activity:

- `getMetadata`
- `search`
- `getMediaMetadata`
- `getMediaURI`

Health checks or background Cloudflare-to-Jellyfin probes should NOT refresh user activity.

Do not write `last_used_at` to D1 on every request if avoidable.

Suggested behavior:

```text
if last_used_at is older than ~15 minutes:
    update it
else:
    skip the database write
```

The exact throttle can be tuned later.

Suggested retention model:

```text
Active use:
    retain connection

Long inactivity:
    retain for a generous grace period

~12 months of no real Sonos activity:
    automatically delete the stored user connection and credentials
```

On automatic deletion remove:

- encrypted Jellyfin token
- Jellyfin server URL
- Jellyfin user ID
- Sonos token hash
- Sonos household mapping
- associated sessions/link state

A small anonymous tombstone may be retained only if there is a legitimate operational need, otherwise fully delete.

Implement cleanup using a scheduled Cloudflare Worker / Cron Trigger.

---

# 7. Playback Decision

Do NOT implement custom signed playback URLs initially.

The user's Sonos hardware is the consumer of the stream URL, and the device is in the user's possession.

Preferred architecture:

```text
Sonos
  -> Cloudflare SMAPI
  -> Cloudflare talks to Jellyfin APIs

For playback:

Sonos
  -> Jellyfin directly
```

Cloudflare should avoid proxying the actual audio stream unless technically necessary.

Reason:

- avoids bandwidth cost
- avoids long-lived Worker streaming paths
- avoids turning Sonofin into a media CDN
- keeps failure domains smaller

Prefer Jellyfin-native stream URLs.

Avoid putting the Jellyfin token in the URL if possible.

If Sonos supports attaching HTTP headers from `getMediaURI`, prefer authenticated headers over query-string API keys.

Do not build signed per-track URLs unless a real compatibility/security reason appears later.

---

# 8. Existing Repository Problems Relevant to Redesign

Important observations from prior review:

1. The current plugin implements Sonos-facing SMAPI itself.
2. `/sonos/smapi` is anonymous and extracts Sonos auth tokens from bearer/SOAP headers.
3. The plugin contains its own OAuth implementation.
4. Authorization codes and refresh tokens are stored in memory.
5. Restarting the server/plugin can therefore lose auth state.
6. The OAuth helper contains an unsafe hard-coded fallback signing secret.
7. The existing login code looks up Jellyfin users but does NOT correctly validate their password before issuing authentication in at least some current flows.
8. The existing architecture is not appropriate for a public multi-user production deployment without major changes.

The redesign should avoid trying to harden that embedded mini-OAuth server if Cloudflare can own the Sonos-facing auth boundary instead.

---

# 9. Recommended Worker Breakdown

Do NOT create a separate Worker for every tiny action.

For example, do NOT create a Worker just to update `last_used_at`.

Start with three logical Workers:

## A. `sonofin-smapi`

Responsibilities:

- public Sonos SMAPI endpoint
- parse SOAP
- route SMAPI methods
- validate Sonos token
- map Sonos connection -> Jellyfin connection
- call Jellyfin APIs
- convert responses to SMAPI XML
- update/throttle `last_used_at`

Likely methods:

- `getAppLink`
- `getDeviceAuthToken`
- `getMetadata`
- `getExtendedMetadata`
- `getMediaMetadata`
- `getMediaURI`
- `search`
- `getLastUpdate`
- `reportAccountAction` where applicable

## B. `sonofin-auth`

Responsibilities:

- onboarding page launched from Sonos
- temporary link code validation
- Jellyfin URL input
- Jellyfin username/password input
- optional direct Jellyfin token input
- authenticate against Jellyfin
- discard password
- encrypt/store Jellyfin token
- mark link code completed

This Worker is the only place that should ever need to temporarily handle a user's Jellyfin password.

## C. `sonofin-maintenance`

Responsibilities:

- scheduled Cron Trigger
- remove expired link codes
- remove stale/revoked transient state
- auto-delete long-inactive user connections
- other maintenance tasks that do not belong on the request path

Potential future split:

An internal credential/encryption Worker could be added later if the project grows enough to justify stronger isolation of the master encryption key.

Do NOT add this complexity during the first implementation unless clearly needed.

---

# 10. Repository Structure

Prefer one monorepo initially.

Suggested layout:

```text
sonofin/
├── apps/
│   ├── smapi-worker/
│   ├── auth-worker/
│   └── maintenance-worker/
│
├── packages/
│   ├── jellyfin-client/
│   ├── database/
│   ├── crypto/
│   ├── sonos-smapi/
│   └── shared/
│
├── migrations/
├── tests/
├── docs/
├── package.json
└── README.md
```

Avoid separate repositories for each Worker at this stage.

---

# 11. Architectural Rule: Build by Contracts

Keep modules isolated through stable interfaces.

Example conceptual TypeScript interfaces:

```ts
interface JellyfinConnection {
  id: string;
  serverUrl: string;
  userId: string;
  encryptedToken: string;
}

interface JellyfinClient {
  getArtists(): Promise<Artist[]>;
  getAlbums(): Promise<Album[]>;
  getTracks(albumId: string): Promise<Track[]>;
  search(query: string): Promise<SearchResult[]>;
  getPlayback(trackId: string): Promise<PlaybackInfo>;
}
```

The SMAPI layer should NOT manually construct arbitrary Jellyfin REST calls everywhere.

It should call a dedicated Jellyfin client package.

During early development it should be possible to use:

```text
FakeJellyfinClient
```

before replacing it with:

```text
RealJellyfinClient
```

This keeps Sonos logic independently testable.

---

# 12. Development Strategy

Build the project in small, independently testable milestones.

Do NOT attempt the entire integration in one giant implementation pass.

Each milestone should leave the repository in a working/testable state.

Recommended sequence follows.

---

# Milestone 1 — Minimal Cloudflare SMAPI Worker

Goal:

Prove Sonos can talk successfully to Cloudflare.

Tasks:

- create Worker project
- receive POST SOAP requests
- parse SOAP action/method
- log safely without credentials
- return hard-coded valid SMAPI XML
- support a minimal subset such as:
  - `getLastUpdate`
  - `getAppLink`
- write unit tests for SOAP parser/serializer

No real Jellyfin integration yet.

---

# Milestone 2 — Link Code Flow

Goal:

Prove Sonos browser onboarding lifecycle.

Tasks:

- use the Sonofin 2.0 name consistently across packages, Workers, and docs
- implement secure random temporary link code
- save hashed link code in D1
- include expiration
- implement `getAppLink`
- return onboarding URL
- implement onboarding route
- mark link as complete using fake/test Jellyfin connection
- implement `getDeviceAuthToken`
- test full lifecycle manually

At this stage Jellyfin authentication may still be mocked.

---

# Milestone 3 — Jellyfin Authentication Client

Goal:

Authenticate against a real Jellyfin server.

Tasks:

- validate Jellyfin URL
- identify Jellyfin server
- authenticate via username/password
- receive Jellyfin access token
- discard password immediately
- support direct token input optionally
- validate supplied token
- return normalized connection object

Do NOT store credentials yet beyond what is needed for testing.

---

# Milestone 4 — Secure Credential Storage

Goal:

Persist Jellyfin connections safely.

Tasks:

- D1 schema/migrations
- encryption package
- AES-GCM or equivalent authenticated encryption
- encryption key stored as Worker Secret
- store encrypted Jellyfin token
- retrieve/decrypt token
- store user/server metadata
- integration tests around encryption and persistence

Never log plaintext tokens.

---

# Milestone 5 — Sonos Authentication

Goal:

Issue and validate long-lived Sonos-facing credentials.

Tasks:

- generate high-entropy opaque token
- return to Sonos from `getDeviceAuthToken`
- store hash only
- map token to:
  - Sonos household
  - Jellyfin connection
- support revocation/replacement
- ensure invalid/unknown tokens fail cleanly

---

# Milestone 6 — Jellyfin API Client

Goal:

Create a clean reusable Jellyfin data layer.

Implement methods for:

- server identity/info
- user libraries
- artists
- albums
- album tracks
- playlists
- playlist tracks
- search
- item metadata
- playback information

Keep this package free of Sonos-specific XML formatting.

---

> **Execution note for Milestones 7–12:** The sections below describe broad
> product goals, not single Codex tasks. Do not assign an entire remaining
> milestone to one run. Use
> [`Sonofin_2_Remaining_Milestones.md`](Sonofin_2_Remaining_Milestones.md) as
> the authoritative dependency-ordered split into sub-five-hour tasks for
> `gpt-5.6-sol` with ultra reasoning.

---

# Milestone 7 — SMAPI Browsing

Goal:

Browse Jellyfin music from Sonos.

Implement gradually:

1. root menu
2. Artists
3. Albums
4. artist albums
5. album tracks
6. playlists
7. search

Translate normalized Jellyfin objects into Sonos SMAPI objects.

Replace the fixed `getLastUpdate` catalog value with a globally deterministic
30-second UTC epoch-bucket token and advertise `pollInterval` 30. This
intentionally accepts the additional refresh traffic so external Jellyfin
catalog changes become visible quickly without shared Worker state.

Avoid building everything at once.

---

# Milestone 8 — Playback

Goal:

Successfully play audio on Sonos.

Implement:

- `getMediaMetadata`
- `getMediaURI`
- Jellyfin-native stream resolution
- authentication headers if Sonos supports required format
- direct Sonos -> Jellyfin streaming

Do NOT initially proxy media through Cloudflare.

Do NOT initially implement signed playback URLs.

Test multiple formats:

- MP3
- AAC
- FLAC
- any formats Sonos/Jellyfin may require transcoding for

Document compatibility results.

---

# Milestone 9 — Activity Tracking

Goal:

Support eventual automatic privacy cleanup.

Tasks:

- `last_used_at` field
- update only on genuine authenticated Sonos activity
- throttle writes, e.g. no more than once per 15 minutes per connection
- do not count health checks as activity
- add tests

No separate Worker is needed just for this.

---

# Milestone 10 — Maintenance Worker

Goal:

Automatic cleanup.

Tasks:

- Cron Trigger
- delete expired link codes
- delete stale transient auth state
- identify long-inactive connections
- delete connections after selected retention period (~12 months suggested)
- safely cascade associated Sonos mappings/tokens

Make retention duration configurable.

---

# Milestone 11 — Security Hardening

Important because users can provide arbitrary Jellyfin URLs.

Protect against SSRF.

At minimum investigate and implement:

- HTTPS-only Jellyfin URLs for production
- block localhost
- block private IP destinations unless explicitly supported
- block link-local addresses
- block metadata service IP ranges
- DNS rebinding defenses
- validate redirects
- do not blindly follow cross-origin redirects
- restrict outbound Jellyfin API paths
- request timeouts
- body size limits
- rate limiting
- onboarding abuse protection
- token/password redaction in logs
- CSP/security headers for onboarding form
- CSRF considerations
- link-code expiration
- constant-time token hash comparisons where practical

Do not sacrifice SSRF safety for convenience.

---

# Milestone 12 — Production Deployment / Documentation

Create documentation for:

- Cloudflare Worker deployments
- D1 creation
- D1 migrations
- Worker Secrets
- Worker bindings
- Cron Trigger
- local development
- tests
- Sonos SMAPI configuration
- onboarding URL configuration
- production hostname setup
- expected Jellyfin server requirements
- supported Jellyfin versions
- troubleshooting

---

# Important Coding Principles

1. TypeScript preferred for Cloudflare Worker code.
2. Keep strict TypeScript settings.
3. Favor simple dependencies.
4. Avoid giant framework stacks unless necessary.
5. Keep SOAP parsing/serialization isolated.
6. Keep Jellyfin REST logic isolated.
7. Keep D1 access isolated.
8. Keep encryption isolated.
9. Never log:
   - Jellyfin passwords
   - Jellyfin access tokens
   - raw Sonos auth tokens
10. Hash Sonos tokens before persistence where possible.
11. Make every milestone independently testable.
12. Add unit tests early.
13. Add integration tests around authentication and D1.
14. Preserve the ability to run local mocks.
15. Avoid premature microservices.

---

# Suggested Initial Task for Codex

Start ONLY with Milestone 1.

Do not attempt Jellyfin authentication or D1 credential storage yet.

Create the base monorepo and implement:

```text
apps/smapi-worker
packages/sonos-smapi
packages/shared
```

The SMAPI Worker should:

1. expose a POST SMAPI endpoint
2. accept SOAP XML
3. identify the requested SMAPI method
4. safely reject malformed XML
5. return a valid hard-coded SOAP response
6. support at minimum:
   - `getLastUpdate`
   - `getAppLink`
7. include unit tests for parsing and response generation
8. include README instructions for local development with Wrangler

Before adding additional functionality, make sure the Worker builds and tests pass.

---

# Expected Development Workflow

For each future task:

1. Review existing interfaces.
2. Implement one focused milestone/subtask.
3. Add/update tests.
4. Run lint/typecheck/tests.
5. Document any architectural assumptions.
6. Avoid unrelated refactors.
7. Leave TODO notes for explicitly deferred work.
8. Keep changes small enough to inspect/revert.

Preferred task size example:

GOOD:

> Implement `getAppLink` using a secure temporary link code stored in D1.

TOO LARGE:

> Implement Sonos authentication and Jellyfin integration.

---

# Current High-Level Architecture

```text
                    Sonos App / Speakers
                            |
                            | SMAPI + Sonos token
                            v
                  +----------------------+
                  | Cloudflare SMAPI     |
                  | Worker               |
                  +----------+-----------+
                             |
                    +--------+---------+
                    |                  |
                    v                  v
                  D1            Jellyfin API
                    |                  |
                    |                  |
                    +---------+--------+
                              |
                              v
                       User Jellyfin Server


Onboarding:

Sonos
  |
  | getAppLink
  v
Cloudflare Auth Worker
  |
  | temporary onboarding page
  v
User enters Jellyfin URL + credentials
  |
  | authenticate once
  v
Jellyfin returns access token
  |
  v
Cloudflare encrypts + stores token in D1
  |
  v
Sonos receives separate Sonofin token


Playback:

Sonos
  |
  | getMediaURI
  v
Cloudflare
  |
  | resolve via Jellyfin API
  v
Returns Jellyfin-native stream info
  |
  v
Sonos --------------------> Jellyfin
             audio direct
```

---

# Product Philosophy

The service should feel like a connector, not a cloud account.

User mental model:

```text
Add Sonofin
-> connect my Jellyfin
-> play music
```

To change information:

```text
remove service
-> add service again
```

To abandon it:

```text
stop using it
-> data eventually auto-deletes
```

Avoid creating an unnecessary Sonofin account-management ecosystem.

Keep Cloudflare responsible for:

- Sonos-facing authentication
- routing
- secure credential storage
- SMAPI translation
- lifecycle cleanup

Keep Jellyfin responsible for:

- users
- music libraries
- metadata
- playback/media serving
- permissions

Keep Sonos responsible for:

- user-facing music service integration
- playback device behavior
- storing its Sonofin auth token

---

# End State

The desired production system is:

- easy for a Jellyfin user to add from Sonos
- no separate Sonofin account required
- Cloudflare never retains Jellyfin passwords
- Jellyfin tokens encrypted at rest
- Sonos credentials separate from Jellyfin credentials
- audio streams directly from Jellyfin to Sonos
- inactive user information automatically deleted
- modular Workers and packages
- small, testable implementation steps
