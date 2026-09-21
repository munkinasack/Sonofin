# Task 8.5 real playback verification

Status: in progress. The required forced-transcode case fails on the real
player. Keep Task 8.5 and Milestone 8 open.

## Test setup and results

Tests ran on a Sonos Play:1 with firmware 17.2.7 (build 86.10-80260) and
Jellyfin 10.11.11, from 2026-09-18 through 2026-09-20 local time. The
current SMAPI Worker deployment tested for the forced-transcode case was
version `3576d68d-9285-483d-b459-aa29de7083e3`.

| Source selected in Sonos | Jellyfin media details | Real player result |
| --- | --- | --- |
| Daft Punk, “One More Time (Club Mix)” | MP3, stereo, 320 kbps, 44.1 kHz; file container not independently confirmed | Played and passed pause, resume, seek forward, and skip. The seek slider enabled after the metadata fix. Replay also started normally. |
| Sleigh Bells, “Kids” | FLAC, stereo, 1092 kbps, 44.1 kHz, 16-bit; file container not independently confirmed | Played and passed pause, resume, seek forward, and skip. |
| The Band Perry, “Done” | AAC-LC (`mp4a`), stereo, 262 kbps, 44.1 kHz; file container not independently confirmed | Played and passed pause, resume, seek forward, and skip. Replay started normally. |
| Alison Krauss & Union Station, “Paper Airplane” | FLAC, stereo, 2852 kbps, 96 kHz, 24-bit | Initial attempts made no sound because `getMediaURI` rejected Jellyfin's transcode target. After bounded URL compatibility fixes, it made sound for less than five seconds and then stopped. Sonos reported “Can't Play ‘Paper Airplane’. It's not encoded correctly.” Controls could not be tested. |

The first observed track, Daft Punk's “Touch It/Technologic,” played with
pause, resume, and skip, but its seek slider was disabled. Shared track
metadata had advertised `canSeek: false`; commit `b690553` changed it to
`canSeek: true`. The user then reselected “One More Time (Club Mix)” and
confirmed that the seek slider enabled and playback resumed at the selected
position. An earlier screenshot displayed an error naming “Dust Bowl
Children,” but the user said that title was unrelated to the tested failure;
it is not used as evidence here.

## Bounded compatibility fixes

The live trace originally returned `getMediaURI` HTTP 500 with
`playback_no_compatible_stream` for the 24-bit/96-kHz FLAC. Four changes on
the task branch accepted the actual Jellyfin 10.11.11 progressive MP3 target
while retaining strict URL validation and removing its query credential:

- `bb6664d`: classify an incompatible playback target in allow-listed Worker logs.
- `32b224c`: accept Jellyfin's Boolean casing and omitted `AudioStreamIndex` in pure-audio transcode URLs.
- `e00d8d5`: accept canonical N-form and D-form representations of the same GUID in the transcode path.
- `2e0d074`: accept Jellyfin's `audiochannels=2` spelling for the two-channel MP3 option.

The latest `pnpm check` passed lint, strict TypeScript, 806 unit and
cross-Worker tests, seven real-D1 integration tests, and dry-run builds for
both Workers. The four changes were deployed before the latest player test.
The fresh credential-safe Worker trace then showed successful `getMediaURI`
responses, so the remaining failure occurs after playback negotiation.

## Direct audio and transcode evidence

Cloudflare HTTP analytics for the exact Jellyfin proxy host and audio path
found direct Sonos-like audio GETs. An earlier 30-minute test window included
`.flac` and `.mp3` requests with five 206/206 and seven 200/200
edge/origin statuses. This supports player-to-Jellyfin audio delivery for
the working formats. It does not expose the request `Range` or
`Authorization` headers or tie each event to a named track.

During the latest “Paper Airplane” test window, analytics showed nine GETs
to Jellyfin's `.mp3` audio stream path. All were 200 at edge and origin; no
206 response was observed. The response type was classified as MP3, and
approximately 2.2 MB was sent at the edge across those requests. No
credential-like query keys appeared. The analytics do not show whether any
request contained a `Range` header or whether the response had an accurate
`Content-Length`.

The user-supplied Jellyfin FFmpeg log for this attempt shows a FLAC 96-kHz,
24-bit stereo input converted to MP3 48-kHz stereo at 256 kbps. FFmpeg
reported progress to 2:38 of the 3:36 source, then received a `[q]` stop
command. It logged no encoding error. This shows that transcoding started
and produced MP3 data; it does not establish why Sonos stopped listening.
No raw log, filesystem path, private URL, token, or account identifier is
retained in this document.

## Compatibility investigation split from bounded fixes

The remaining failure is a protocol compatibility risk. Stock Jellyfin
10.11.11's progressive transcode handler explicitly sets
`Accept-Ranges: none` and serves a `ProgressiveFileStream` that cannot seek or
report its length. Its HEAD branch returns the content type without a file
length. [Jellyfin's response helper](https://raw.githubusercontent.com/jellyfin/jellyfin/v10.11.11/Jellyfin.Api/Helpers/FileStreamResponseHelpers.cs)
and [progressive stream implementation](https://raw.githubusercontent.com/jellyfin/jellyfin/v10.11.11/MediaBrowser.Controller/Streaming/ProgressiveFileStream.cs)
establish this source-level behavior. [Sonos streaming requirements](https://docs.sonos.com/docs/streaming-basics)
call for an accurate `Content-Length` and correct 206/416 responses to byte
range requests. This mismatch is a strong hypothesis for the brief playback
and “not encoded correctly” error, but the actual failing response headers
and request `Range` header have not yet been captured. The FFmpeg log alone
does not prove the cause.

The accepted [playback ADR](../adr/0001-sonos-jellyfin-playback.md) makes
Sonos fetch audio directly from Jellyfin and excludes a Sonofin audio proxy
or range endpoint. Jellyfin's [`AudioHelper`](https://raw.githubusercontent.com/jellyfin/jellyfin/v10.11.11/Jellyfin.Api/Helpers/AudioHelper.cs)
routes `static=true` to the original source file; every actual audio transcode
uses the progressive handler, including one with an existing output file.
There is no known 10.11.11 URL option for a range-capable completed MP3
transcode. A delivery-path change therefore needs a separate design and
security review. The follow-up must capture authenticated GET, HEAD,
and Range request/response headers without recording credentials, confirm
MIME, length, 206/416 behavior and stable repeated URIs, then evaluate a
range-capable completed Jellyfin transcode or another explicitly approved
delivery path. Retest play, pause, resume, seek, and skip on the Play:1.

## Remaining Task 8.5 evidence

For all four required formats, capture the selected Jellyfin method, actual
file container and `Content-Type`, accurate `Content-Length`, optional HEAD,
Range/206/416 behavior, redirects, and stable repeated `getMediaURI` results.
Verify that Sonos sends the constructed Authorization header on ordinary
and ranged requests, and that captured URLs and logs contain no token.
Keep credentials and private server details out of checked-in evidence.
