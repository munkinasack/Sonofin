# Task 8.6 forced-transcode delivery investigation

Status: complete as a progressive-MP3 feasibility investigation. The source
contract is sufficient to reject that path even though the exact historical
Play:1 request remains uncaptured. ADR 0002 selects HLS AAC as a distinct
replacement; Task 8.8 owns its real-device gate. Keep Task 8.5 and Milestone 8
open.

## Confirmed source behavior

Stock Jellyfin 10.11.11 has no supported URL or `PlaybackInfo` option that
turns an audio transcode into a completed, byte-range-capable MP3 while keeping
the current Sonos-to-Jellyfin path:

- [`GetTranscodedFile`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Helpers/FileStreamResponseHelpers.cs#L123-L167)
  sets `Accept-Ranges: none`, returns a HEAD response without a file length,
  and wraps GET responses in `ProgressiveFileStream` even when an output file
  already exists.
- [`ProgressiveFileStream`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/Streaming/ProgressiveFileStream.cs#L29-L68)
  is non-seekable and does not expose a length. ASP.NET Core therefore cannot
  apply its normal
  [file-length](https://github.com/dotnet/aspnetcore/blob/v9.0.11/src/Mvc/Mvc.Core/src/Infrastructure/FileStreamResultExecutor.cs#L26-L55)
  and
  [range processing](https://github.com/dotnet/aspnetcore/blob/v9.0.11/src/Shared/ResultsHelpers/FileResultHelper.cs#L129-L159).
- [`static=true`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Helpers/AudioHelper.cs#L127-L155)
  serves the original media path, not the transcode output. It would return
  the incompatible 24-bit/96-kHz FLAC in the required fallback case.
- [`EstimateContentLength` and `TranscodeSeekInfo=Bytes`](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Model/Dlna/StreamInfo.cs#L1079-L1088)
  affect generated URL state but the Jellyfin 10.11.11
  [audio controller](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/AudioController.cs#L89-L198)
  does not consume them as a completed-file or range-delivery contract.

This proves that resolver query changes alone cannot satisfy the
[Sonos streaming contract](https://docs.sonos.com/docs/streaming-basics), which
requires an accurate `Content-Length`, working HEAD requests, `206` for valid
byte ranges, and `416` for unsatisfiable ranges. It does not by itself prove
which missing response property caused the observed Play:1 encoding error.

The legacy Jellyfin segment route is not a way to manufacture one completed
progressive MP3. Modern HLS is instead a distinct playlist-and-segment delivery
contract. It requires its own MIME, authentication-propagation, URL, and
hardware decision, now recorded in
[`ADR 0002`](../adr/0002-hls-aac-forced-transcodes.md).

## Optional historical live capture

If diagnosing which progressive-response property triggered the old Play:1
error remains useful, capture the real request and Jellyfin response at the existing
Jellyfin HTTPS boundary. The observer must pass the request and response
through without reading either body and persist only the allow-listed facts
below.

Allowed closed classifications:

- method: `GET`, `HEAD`, or `other`;
- Authorization: `present` or `absent`;
- Range shape: absent, open-ended, closed, suffix, multiple, or invalid;
- status: bounded HTTP status code;
- Content-Type: `audio/mpeg`, missing, or other;
- Accept-Ranges: `bytes`, `none`, missing, or other;
- Content-Range: satisfied, unsatisfied, missing, or invalid;
- Location: present or absent;
- Content-Encoding: absent, identity, or other.

Allowed bounded numbers are parsed Range start/end/suffix length,
Content-Length, Content-Range start/end/total, and response-header latency.
Record missing values as missing; do not infer that Sonos sent HEAD or Range.

Never retain a URL, host, path, query, IP address, user agent, referrer, Ray or
request ID, item/source/device/user/household ID, raw header value, token hash,
response body, server body, or raw Jellyfin/FFmpeg log. A successful upstream
response with Authorization classified as present is sufficient evidence that
header authentication worked; the credential must never be compared, hashed,
or stored.

Preferred capture choices, in order:

1. A host-local observer between the TLS terminator or tunnel and Jellyfin,
   configured to emit only the allow-listed classifications above.
2. If host-local observation is unavailable, a temporary standalone
   Cloudflare Worker Route over only the Jellyfin audio route. It must use a
   dedicated disposable telemetry binding, have observability and invocation
   logs disabled, contain no `console` calls, expose no `workers.dev` or
   preview endpoint, and be removed immediately after the narrow test window.

Do not use `wrangler tail`, a Tail Worker, raw HTTP Logpush headers, ordinary
reverse-proxy access logs, or a packet capture whose output includes complete
HTTP headers. Those mechanisms can retain the URL, item ID, or Authorization
credential even if the final summary later omits them.

The real-device run must select the known forced-transcode fixture, record the
initial result and timing, and attempt pause, resume, seek, and skip only while
playback remains available. Separately authorized HEAD, `Range: bytes=0-0`,
and unsatisfiable-range probes may supplement the device evidence but must be
identified as synthetic probes rather than Sonos behavior.

## Accepted replacement direction

ADR 0002 preserves direct Sonos-to-Jellyfin delivery and changes only forced
transcodes to an on-demand HLS track: AAC in 10-second MPEG-TS segments, with
the master playlist and all child requests authenticated by the existing
Sonos `httpHeaders` mechanism. It retains the no-token-in-URI and no-Cloudflare-
audio-proxy rules. A Jellyfin completed-file endpoint, sidecar, fork,
Cloudflare/R2 gateway, or offline MP3 derivative is not part of this decision.

Forwarding the old progressive response through a Worker would not fix its
length or range behavior, and buffering it in Worker memory remains excluded.

## Completion evidence still required

After Task 8.7 passes focused behavior and security tests:

- deploy only with explicit authorization;
- repeat forced-transcode play, pause, resume, seek, and skip on the Play:1;
- verify master, media-playlist, and segment Authorization propagation without
  placing the Jellyfin token in any URI;
- finish the direct MP3, AAC, and FLAC header/range/stability evidence listed
  in [`task-8-5-playback.md`](task-8-5-playback.md);
- run `pnpm check`;
- close Tasks 8.5 and 8.8 and Milestone 8 only when every case passes.
