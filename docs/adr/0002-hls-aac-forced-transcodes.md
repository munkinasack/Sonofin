# ADR 0002: HLS AAC delivery for forced audio transcodes

- Status: Accepted
- Date: 2026-09-28
- Task: 8.7
- Compatibility baseline: Sonos SMAPI 1.1 and Jellyfin Server 10.11.11
- Supersedes: ADR 0001 only for forced-transcode format, URL, MIME, and query
  rules

## Context

The direct MP3, AAC-LC, and 16-bit FLAC cases in Task 8.5 play successfully on
the real Sonos device. The forced 24-bit/96-kHz FLAC case negotiates to the
progressive MP3 fallback from ADR 0001, starts briefly, and then fails.

The Task 8.6 source review establishes that stock Jellyfin 10.11.11's
progressive transcode handler uses a non-seekable stream, advertises
`Accept-Ranges: none`, and does not provide a supported completed-file mode.
`EstimateContentLength` changes generated URL state but does not turn that
handler into an accurate, range-capable file response. Consequently, no
Sonofin `PlaybackInfo` or resolver-only change can make progressive MP3 meet
Sonos's documented progressive-stream contract.

Sonos separately supports on-demand HLS tracks. Its supported HLS audio codecs
include AAC-LC, its containers include MPEG-TS and MPEG-4, and it recommends
10–15 second segments. HLS track playback uses playlists and independently
served segments rather than one progressive response whose full encoded byte
length must be known before transcoding finishes.

## Decision

Keep conforming direct-play targets unchanged. When Jellyfin must transcode an
audio source, negotiate and return an HLS track with this fixed output:

- AAC audio at no more than 320 kbps, 48 kHz, and two channels;
- MPEG-TS segments;
- 10-second segment length and one minimum segment;
- VBR disabled;
- `application/vnd.apple.mpegurl` as the negotiated SMAPI MIME type;
- Jellyfin's `/audio/{itemId}/master.m3u8` route as the initial URI.

The item remains SMAPI `itemType=track`. It must not be changed to `stream`,
which Sonos reserves for live or radio-style HLS. Track duration remains in
metadata so seek and skip can be offered.

The Sonos device profile uses `Protocol: hls`, `Container: ts`, and
`AudioCodec: aac`. It no longer sends `EstimateContentLength`; that option is
neither needed by this topology nor accepted in the normalized HLS query.
Direct MP3, AAC-in-M4A/MP4, and conforming FLAC profiles retain their existing
priority over the HLS fallback.

### URL and authentication contract

The resolver accepts only the pinned Jellyfin 10.11.11 HLS master route and a
strict allow-list of binding, audio, segment, Boolean, and transcode-reason
query fields. It verifies any returned `ApiKey` against the active connection,
then removes it. It also removes `PlaySessionId` and `Tag`, canonicalizes
Boolean values, enforces HTTPS, exact origin, configured base-path containment,
and stable retry output, and rejects unknown fields.

Sonofin returns its existing internally constructed Jellyfin `Authorization`
header through SMAPI `httpHeaders`. Neither the master URI nor the child
playlist/segment query generated from it contains the Jellyfin token. This
contract therefore depends on Sonos applying the supplied header to the HLS
master playlist, media playlist, and segment requests. Task 8.8 must verify
that behavior on the real player. A failed header-propagation test must stop the
rollout; it does not authorize putting the token in HLS query strings.

### Metadata contract

Sonos determines whether a track is HLS from its media type. The
`getMediaMetadata` service therefore performs the same `PlaybackInfo`
negotiation as `getMediaURI` and returns the selected target's MIME type. A
forced transcode is advertised as `application/vnd.apple.mpegurl`; a direct
target keeps its direct audio MIME. This adds one bounded Jellyfin playback
negotiation to `getMediaMetadata` and allows incompatible targets to fail with
the same fixed, credential-safe stream fault as `getMediaURI`.

### Delivery topology

The Sonos player continues to fetch media directly from Jellyfin. Cloudflare
does not fetch, buffer, rewrite, cache, or proxy HLS playlists or segments.
Jellyfin's audio HLS route creates a complete VOD media-playlist description,
generates requested segments on demand, waits until a segment is complete, and
serves the completed segment through its static-file response helper. Segment
length is therefore a property of each finished file rather than an estimate
of the whole not-yet-finished transcode.

## Rejected alternatives

- **Keep progressive MP3 and activate `EstimateContentLength`:** rejected
  because Jellyfin 10.11.11's progressive handler does not implement the
  required completed-file or byte-range behavior.
- **Install the Jellyfin DLNA plugin:** rejected because Sonofin uses Jellyfin's
  API playback negotiation and HTTP routes, not Jellyfin's DLNA server path.
- **Change the Sonos item to a live `stream`:** rejected because this is
  on-demand music and Sonos defines HLS track semantics for it.
- **Proxy or pre-transcode audio in Sonofin:** rejected because it expands the
  Cloudflare trust, bandwidth, caching, cleanup, and resource-bounding surface.
- **Fork Jellyfin for a range-capable completed MP3:** rejected while the stock
  HLS route can provide the supported on-demand delivery topology.
- **Use fragmented MP4 segments initially:** supported by Sonos, but MPEG-TS
  avoids the additional fMP4 initialization object and gives the first hardware
  compatibility run the smaller request topology.

## Consequences and verification gates

- Progressive-transcode `Content-Length`, HEAD, and byte-range requirements no
  longer gate the forced-transcode case; direct progressive files retain their
  existing range behavior.
- Jellyfin 10.11.11's exact HLS URL shape becomes a pinned compatibility
  boundary. New or changed query fields fail closed pending source review.
- Task 8.8 must verify the returned PlaybackInfo shape, HLS MIME values, master
  and media playlists, AAC-in-MPEG-TS segments, Authorization on every HLS
  request level, absence of token-bearing URLs, first playable audio within
  Sonos's timeout, play/pause/resume/seek/skip, retries, and regression coverage
  for all three direct formats.
- Milestone 8 remains open until Task 8.8 and the remaining Task 8.5 real-system
  matrix both pass.

## Primary references

Sonos:

- [HTTP Live Streaming (HLS)](https://docs.sonos.com/docs/http-live-streaming-hls)
- [Streaming basics](https://docs.sonos.com/docs/streaming-basics)
- [`getMediaURI`](https://docs.sonos.com/docs/getmediauri)

Jellyfin 10.11.11:

- [`TranscodingProfile`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Model/Dlna/TranscodingProfile.cs)
- [`StreamInfo.ToUrl`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Model/Dlna/StreamInfo.cs#L818-L1061)
- [audio HLS controller routes](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L569-L679)
- [VOD playlist and segment delivery](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L1383-L1949)
