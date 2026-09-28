import { describe, expect, it } from "vitest";

import {
  JellyfinApiClient,
  type JellyfinDataConnection,
  type JellyfinMediaSource,
  type JellyfinPlaybackInfo,
} from "../src";
import {
  JellyfinPlaybackTargetError,
  resolveSonosPlaybackTarget,
} from "../src/playback-target";
import aacFixture from "./fixtures/playback/aac-direct-play.json";
import flac24StereoFixture from "./fixtures/playback/flac-24-96-stereo-transcode.json";
import flacFixture from "./fixtures/playback/flac-direct-play.json";
import hlsTranscodeFixture from "./fixtures/playback/hls-aac-transcode.json";
import mp3Fixture from "./fixtures/playback/mp3-direct-play.json";

const CONNECTION: JellyfinDataConnection = {
  serverUrl: "https://media.example.test/jellyfin",
  serverId: "fixture-server-id",
  userId: "fixture-user-id",
  deviceId: "sonofin-task-8-1-fixture",
  accessToken: "task-8-1-fixture-token-not-a-credential",
};
const IDS = [
  "40000000000000000000000000000001",
  "40000000000000000000000000000002",
  "40000000000000000000000000000003",
  "40000000000000000000000000000004",
  "40000000000000000000000000000005",
] as const;

async function parseFixture(payload: unknown, itemId: string): Promise<JellyfinPlaybackInfo> {
  const client = new JellyfinApiClient({
    connection: CONNECTION,
    fetch: (async () => new Response(JSON.stringify(payload))) as typeof fetch,
  });
  return client.getPlaybackInfo(itemId);
}

function oneSource(source: JellyfinMediaSource): JellyfinPlaybackInfo {
  return { mediaSources: [source] };
}

function failNoStream(
  itemId: string,
  playback: JellyfinPlaybackInfo,
  connection: JellyfinDataConnection = CONNECTION,
): void {
  expect(() => resolveSonosPlaybackTarget(itemId, playback, connection)).toThrow(
    JellyfinPlaybackTargetError,
  );
  try {
    resolveSonosPlaybackTarget(itemId, playback, connection);
  } catch (error) {
    expect(error).toMatchObject({ code: "no_compatible_stream" });
    expect(String(error)).not.toContain("https://");
    expect(String(error)).not.toContain(CONNECTION.accessToken);
  }
}

function failureOf(
  itemId: string,
  playback: JellyfinPlaybackInfo,
): string {
  try {
    resolveSonosPlaybackTarget(itemId, playback, CONNECTION);
  } catch (error) {
    if (error instanceof JellyfinPlaybackTargetError) return error.failure;
    throw error;
  }
  throw new Error("Expected a rejected playback target");
}

describe("Sonos playback target resolver", () => {
  it.each([
    ["MP3", mp3Fixture, IDS[0], "audio/mpeg", "stream.mp3"],
    ["AAC-in-M4A", aacFixture, IDS[1], "audio/mp4", "stream.m4a"],
    ["FLAC", flacFixture, IDS[2], "audio/flac", "stream.flac"],
  ])("builds a direct %s target from a fixture", async (_name, fixture, itemId, mime, path) => {
    const playback = await parseFixture(fixture, itemId);
    const target = resolveSonosPlaybackTarget(itemId, playback, CONNECTION);

    expect(target).toEqual({
      method: "direct-play",
      url:
        `https://media.example.test/jellyfin/Audio/${itemId}/${path}` +
        `?static=true&mediaSourceId=${playback.mediaSources[0]?.id}`,
      mimeType: mime,
      httpHeaders: [
        {
          header: "Authorization",
          value:
            'MediaBrowser Client="Sonofin", Device="Cloudflare Worker", ' +
            'DeviceId="sonofin-task-8-1-fixture", Version="0.0.0", ' +
            'Token="task-8-1-fixture-token-not-a-credential"',
        },
      ],
    });
    expect(target.url).not.toContain(CONNECTION.accessToken);
  });

  it("strips credentials and session fields from the HLS fixture with stable retries", async () => {
    const playback = await parseFixture(hlsTranscodeFixture, IDS[3]);
    const first = resolveSonosPlaybackTarget(IDS[3], playback, CONNECTION);
    const second = resolveSonosPlaybackTarget(IDS[3], playback, CONNECTION);

    expect(first).toEqual(second);
    expect(first.method).toBe("transcode");
    expect(first.mimeType).toBe("application/vnd.apple.mpegurl");
    expect(first.url).toMatch(
      /^https:\/\/media\.example\.test\/jellyfin\/audio\/40000000000000000000000000000004\/master\.m3u8\?/u,
    );
    expect(first.url).not.toMatch(/ApiKey|PlaySessionId|Tag|token-not-a-credential/iu);
    expect(first.httpHeaders).toHaveLength(1);
    const source = playback.mediaSources[0]!;
    const changedSession = source.transcodingUrl!
      .replace("PlaySessionId=44444444444444444444444444444444", "PlaySessionId=retry-session") +
      "&Tag=changed-etag";
    expect(resolveSonosPlaybackTarget(IDS[3], oneSource({
      ...source,
      transcodingUrl: changedSession,
    }), CONNECTION)).toEqual(first);
  });

  it("resolves 24-bit/96-kHz stereo FLAC to a safe HLS AAC target", async () => {
    const itemId = IDS[4];
    const playback = await parseFixture(flac24StereoFixture, itemId);
    expect(playback.mediaSources[0]?.audioStreams[0]).toMatchObject({
      codec: "flac",
      channels: 2,
      sampleRate: 96_000,
      bitDepth: 24,
    });
    expect(playback.mediaSources[0]?.transcodingUrl).toContain(
      "/audio/40000000-0000-0000-0000-000000000005/master.m3u8",
    );

    const target = resolveSonosPlaybackTarget(itemId, playback, CONNECTION);
    const url = new URL(target.url);
    expect(target.method).toBe("transcode");
    expect(target.mimeType).toBe("application/vnd.apple.mpegurl");
    expect(url.origin).toBe("https://media.example.test");
    expect(url.pathname).toBe(`/jellyfin/audio/${itemId}/master.m3u8`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      DeviceId: CONNECTION.deviceId,
      MediaSourceId: playback.mediaSources[0]?.id,
      AudioCodec: "aac",
      AudioBitrate: "320000",
      AudioSampleRate: "48000",
      SegmentContainer: "ts",
      SegmentLength: "10",
      MinSegments: "1",
      BreakOnNonKeyFrames: "false",
      TranscodingMaxAudioChannels: "2",
      RequireAvc: "false",
      EnableAudioVbrEncoding: "false",
      audiochannels: "2",
      allowAudioStreamCopy: "false",
      allowVideoStreamCopy: "false",
      TranscodeReasons: "AudioSampleRateNotSupported,AudioBitDepthNotSupported",
    });
    expect(target.url).not.toContain(CONNECTION.accessToken);
    expect(target.url).not.toMatch(/ApiKey|PlaySessionId|Tag/iu);
    expect(target.httpHeaders).toEqual([{
      header: "Authorization",
      value:
        'MediaBrowser Client="Sonofin", Device="Cloudflare Worker", ' +
        'DeviceId="sonofin-task-8-1-fixture", Version="0.0.0", ' +
        'Token="task-8-1-fixture-token-not-a-credential"',
    }]);

    const source = playback.mediaSources[0]!;
    expect(resolveSonosPlaybackTarget(itemId, oneSource({
      ...source,
      supportsDirectPlay: true,
    }), CONNECTION)).toEqual(target);
  });

  it("matches only the requested GUID across Jellyfin N and D URL forms", async () => {
    const source = (await parseFixture(flac24StereoFixture, IDS[4])).mediaSources[0]!;
    const raw = source.transcodingUrl!;
    const dForm = "40000000-0000-0000-0000-000000000005";
    const letterNForm = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const letterDForm = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

    const caseTarget = resolveSonosPlaybackTarget(letterNForm, oneSource({
      ...source,
      transcodingUrl: raw.replace(dForm, letterDForm),
    }), CONNECTION);
    expect(new URL(caseTarget.url).pathname).toBe(
      `/jellyfin/audio/${letterNForm}/master.m3u8`,
    );

    for (const [pathId, failure] of [
      ["40000000-0000-0000-0000-000000000006", "playback_transcode_url_route"],
      ["4000000-0000-0000-0000-000000000005", "playback_transcode_url_route"],
      [`${dForm}%2Fextra`, "playback_transcode_url_unsafe_path"],
    ] as const) {
      expect(failureOf(IDS[4], oneSource({
        ...source,
        transcodingUrl: raw.replace(dForm, pathId),
      }))).toBe(failure);
    }

    const customId = "custom-id";
    const custom = raw.replace(dForm, customId);
    expect(resolveSonosPlaybackTarget(customId, oneSource({
      ...source,
      transcodingUrl: custom,
    }), CONNECTION).method).toBe("transcode");
    expect(failureOf(customId, oneSource({
      ...source,
      transcodingUrl: custom.replace(customId, "CUSTOM-ID"),
    }))).toBe("playback_transcode_url_route");
  });

  it("normalizes application-root, base-prefixed, and same-origin absolute transcode paths", async () => {
    const source = (await parseFixture(hlsTranscodeFixture, IDS[3])).mediaSources[0]!;
    const expected = resolveSonosPlaybackTarget(IDS[3], oneSource(source), CONNECTION);
    for (const prefix of [
      "/jellyfin",
      "https://media.example.test/jellyfin",
    ]) {
      const transcodingUrl = `${prefix}${source.transcodingUrl}`;
      expect(resolveSonosPlaybackTarget(IDS[3], oneSource({
        ...source,
        transcodingUrl,
      }), CONNECTION)).toEqual(expected);
    }
  });

  it("canonicalizes Jellyfin HLS Boolean casing and an omitted audio stream index", async () => {
    const source = (await parseFixture(hlsTranscodeFixture, IDS[3])).mediaSources[0]!;
    const original = resolveSonosPlaybackTarget(IDS[3], oneSource(source), CONNECTION);
    const transcodingUrl = source.transcodingUrl!
      .replace("AudioStreamIndex=0&", "")
      .replaceAll("=false", "=False");
    const target = resolveSonosPlaybackTarget(
      IDS[3],
      oneSource({ ...source, transcodingUrl }),
      CONNECTION,
    );
    expect(target.method).toBe("transcode");
    expect(target.url).not.toContain("AudioStreamIndex");
    expect(target.url).toContain("BreakOnNonKeyFrames=false");
    expect(target.url).toContain("RequireAvc=false");
    expect(target.url).not.toMatch(/=(?:True|False)(?:&|$)/u);
    expect(target.url).toBe(original.url.replace("AudioStreamIndex=0&", ""));
  });

  it("accepts only one bounded audio channel option", async () => {
    const source = (await parseFixture(hlsTranscodeFixture, IDS[3])).mediaSources[0]!;
    const raw = source.transcodingUrl!;
    expect(resolveSonosPlaybackTarget(IDS[3], oneSource(source), CONNECTION).method)
      .toBe("transcode");
    expect(failureOf(IDS[3], oneSource({
      ...source,
      transcodingUrl: `${raw}&audiochannels=2`,
    }))).toBe("playback_transcode_query_audio");
    expect(failureOf(IDS[3], oneSource({
      ...source,
      transcodingUrl: raw.replace("aac-audiochannels=2", "audiochannels=3"),
    }))).toBe("playback_transcode_query_audio");
  });

  it("classifies source, profile, URL, and query failures without upstream values", async () => {
    const source = (await parseFixture(hlsTranscodeFixture, IDS[3])).mediaSources[0]!;
    const raw = source.transcodingUrl!;
    const cases = [
      [{ mediaSources: [] }, "playback_no_media_sources"],
      [{ errorCode: "upstream-secret", mediaSources: [source] }, "playback_info_error"],
      [oneSource({ ...source, audioStreams: [] }), "playback_source_metadata"],
      [oneSource({ ...source, transcodingContainer: "mp3" }), "playback_transcode_profile"],
      [oneSource({ ...source, transcodingUrl: "" }), "playback_transcode_url_missing"],
      [oneSource({ ...source, transcodingUrl: `audio/${IDS[3]}/master.m3u8` }), "playback_transcode_url_malformed"],
      [oneSource({ ...source, transcodingUrl: raw.replace("/audio/", "/%2e%2e/audio/") }), "playback_transcode_url_unsafe_path"],
      [oneSource({ ...source, transcodingUrl: `http://media.example.test${raw}` }), "playback_transcode_url_insecure_scheme"],
      [oneSource({ ...source, transcodingUrl: `https://elsewhere.example.test/jellyfin${raw}` }), "playback_transcode_url_origin"],
      [oneSource({ ...source, transcodingUrl: `https://media.example.test${raw}` }), "playback_transcode_url_base_path"],
      [oneSource({ ...source, transcodingUrl: raw.replace("/audio/", "/other/") }), "playback_transcode_url_route"],
      [oneSource({ ...source, transcodingUrl: `${raw}&Tag=${"a".repeat(4_096)}` }), "playback_transcode_url_too_long"],
      [oneSource({ ...source, transcodingUrl: `${raw}&Unknown=private-value` }), "playback_transcode_query_shape"],
      [oneSource({ ...source, transcodingUrl: raw.replace("AudioStreamIndex=0", "AudioStreamIndex=1") }), "playback_transcode_query_binding"],
      [oneSource({ ...source, transcodingUrl: raw.replace("AudioSampleRate=48000", "AudioSampleRate=96000") }), "playback_transcode_query_audio"],
      [oneSource({ ...source, transcodingUrl: raw.replace("BreakOnNonKeyFrames=False", "BreakOnNonKeyFrames=True") }), "playback_transcode_query_options"],
    ] as const;
    for (const [playback, failure] of cases) {
      expect(failureOf(IDS[3], playback)).toBe(failure);
    }
    const error = new JellyfinPlaybackTargetError("playback_transcode_query_shape");
    expect(String(error)).not.toContain("private-value");
    expect(String(error)).not.toContain("upstream-secret");
  });

  it("ranks direct play, File transcodes, then source IDs independently of response order", async () => {
    const direct = (await parseFixture(mp3Fixture, IDS[0])).mediaSources[0]!;
    const transcode = (await parseFixture(hlsTranscodeFixture, IDS[3])).mediaSources[0]!;
    const directB: JellyfinMediaSource = { ...direct, id: "b-source" };
    const directA: JellyfinMediaSource = { ...direct, id: "a-source" };
    const playback = { mediaSources: [transcode, directB, directA] };

    expect(resolveSonosPlaybackTarget(IDS[0], playback, CONNECTION).url).toContain(
      "mediaSourceId=a-source",
    );
    expect(resolveSonosPlaybackTarget(IDS[0], {
      mediaSources: [...playback.mediaSources].reverse(),
    }, CONNECTION).url).toContain("mediaSourceId=a-source");

    const fileTranscode = {
      ...transcode,
      id: "file-source",
      supportsDirectPlay: false,
      transcodingUrl: transcode.transcodingUrl!.replace(transcode.id, "file-source"),
    };
    const remoteTranscode = {
      ...fileTranscode,
      id: "remote-source",
      protocol: "Http",
      transcodingUrl: transcode.transcodingUrl!.replace(transcode.id, "remote-source"),
    };
    expect(resolveSonosPlaybackTarget(IDS[3], {
      mediaSources: [remoteTranscode, fileTranscode],
    }, CONNECTION).url).toContain("MediaSourceId=file-source");
  });

  it("rejects duplicate source IDs even when both sources otherwise play", async () => {
    const mp3 = (await parseFixture(mp3Fixture, IDS[0])).mediaSources[0]!;
    const flac = (await parseFixture(flacFixture, IDS[2])).mediaSources[0]!;
    const conflicting = { ...flac, id: mp3.id };
    failNoStream(IDS[0], { mediaSources: [mp3, conflicting] });
    failNoStream(IDS[0], { mediaSources: [conflicting, mp3] });
  });

  it("never places the connection token in an item, source, device, or base URL", async () => {
    const direct = (await parseFixture(mp3Fixture, IDS[0])).mediaSources[0]!;
    const transcode = (await parseFixture(hlsTranscodeFixture, IDS[3])).mediaSources[0]!;
    const token = CONNECTION.accessToken;
    failNoStream(IDS[0], oneSource({ ...direct, id: token }));
    failNoStream(token, oneSource(direct));
    failNoStream(IDS[0], oneSource(direct), {
      ...CONNECTION,
      serverUrl: `https://media.example.test/${token}`,
    });
    failNoStream(IDS[3], oneSource({
      ...transcode,
      id: token,
      transcodingUrl: transcode.transcodingUrl!.replace(transcode.id, token),
    }));
    failNoStream(IDS[3], oneSource(transcode), {
      ...CONNECTION,
      deviceId: token,
    });
  });

  it("percent-encodes direct item and source IDs using the configured base path", async () => {
    const source = (await parseFixture(mp3Fixture, IDS[0])).mediaSources[0]!;
    const itemId = "track/α ?#% & one";
    const target = resolveSonosPlaybackTarget(
      itemId,
      oneSource({ ...source, id: "source α & one" }),
      CONNECTION,
    );
    expect(target.url).toBe(
      "https://media.example.test/jellyfin/Audio/track%2F%CE%B1%20%3F%23%25%20%26%20one/stream.mp3" +
        "?static=true&mediaSourceId=source%20%CE%B1%20%26%20one",
    );
  });

  it("rejects dot-only item IDs and unsafe configured base paths", async () => {
    const source = (await parseFixture(mp3Fixture, IDS[0])).mediaSources[0]!;
    for (const itemId of [".", ".."] ) {
      expect(() => resolveSonosPlaybackTarget(itemId, oneSource(source), CONNECTION))
        .toThrow();
    }
    for (const serverUrl of [
      "https://media.example.test/jellyfin/../elsewhere",
      "https://media.example.test/jellyfin/%2e%2e/elsewhere",
      "https://media.example.test/jellyfin%2felsewhere",
    ]) {
      expect(() => resolveSonosPlaybackTarget(IDS[0], oneSource(source), {
        ...CONNECTION,
        serverUrl,
      })).toThrow();
    }
  });

  it("skips sources with required headers, invalid audio facts, and ambiguous defaults", async () => {
    const direct = (await parseFixture(flacFixture, IDS[2])).mediaSources[0]!;
    const good = { ...direct, id: "good" };
    const noSampleRate = { ...direct.audioStreams[0]! };
    delete noSampleRate.sampleRate;
    const noBitrateSource = { ...direct };
    delete noBitrateSource.bitrate;
    const noBitrateStream = { ...direct.audioStreams[0]! };
    delete noBitrateStream.bitrate;
    const ambiguous = {
      ...direct,
      audioStreams: [
        direct.audioStreams[0]!,
        { ...direct.audioStreams[0]!, index: 1, isDefault: true },
      ],
    };
    delete ambiguous.defaultAudioStreamIndex;
    const bad = [
      { ...direct, requiredHttpHeaders: { "X-Remote": "" } },
      { ...direct, audioStreams: [{ ...direct.audioStreams[0]!, bitDepth: 24 }] },
      { ...direct, audioStreams: [noSampleRate] },
      { ...direct, bitrate: 8_000_001 },
      { ...noBitrateSource, audioStreams: [noBitrateStream] },
      { ...direct, defaultAudioStreamIndex: 7 },
      ambiguous,
      { ...direct, protocol: "Http" },
    ];
    for (const source of bad) {
      failNoStream(IDS[2], oneSource(source));
      expect(resolveSonosPlaybackTarget(IDS[2], {
        mediaSources: [source, good],
      }, CONNECTION).url).toContain("mediaSourceId=good");
    }
  });

  it("rejects hostile path forms before URL normalization", async () => {
    const source = (await parseFixture(hlsTranscodeFixture, IDS[3])).mediaSources[0]!;
    const raw = source.transcodingUrl!;
    const query = raw.slice(raw.indexOf("?"));
    const hostile = [
      `https://evil.example.test/jellyfin/audio/${IDS[3]}/master.m3u8${query}`,
      `https://media.example.test:444/jellyfin/audio/${IDS[3]}/master.m3u8${query}`,
      `http://media.example.test/jellyfin/audio/${IDS[3]}/master.m3u8${query}`,
      `//media.example.test/jellyfin/audio/${IDS[3]}/master.m3u8${query}`,
      `/jellyfin2/audio/${IDS[3]}/master.m3u8${query}`,
      `/audio/../audio/${IDS[3]}/master.m3u8${query}`,
      `/audio/%2e%2e/audio/${IDS[3]}/master.m3u8${query}`,
      `/audio/%2F${IDS[3]}/master.m3u8${query}`,
      `/audio/%255C${IDS[3]}/master.m3u8${query}`,
      `/audio\\${IDS[3]}/master.m3u8${query}`,
      `/audio/${IDS[3]}/master.m3u8${query}#fragment`,
      `https://user:password@media.example.test/jellyfin/audio/${IDS[3]}/master.m3u8${query}`,
      `https://@media.example.test/jellyfin/audio/${IDS[3]}/master.m3u8${query}`,
      `https://:@media.example.test/jellyfin/audio/${IDS[3]}/master.m3u8${query}`,
    ];
    for (const transcodingUrl of hostile) {
      failNoStream(IDS[3], oneSource({ ...source, transcodingUrl }));
    }
  });

  it("rejects unknown, duplicate, credential-like, malformed, and unsafe query fields", async () => {
    const source = (await parseFixture(hlsTranscodeFixture, IDS[3])).mediaSources[0]!;
    const raw = source.transcodingUrl!;
    const hostile = [
      `${raw}&ApiKey=duplicate`,
      `${raw}&%41piKey=duplicate`,
      `${raw}&api_key=another`,
      `${raw}&Authorization=secret`,
      `${raw}&EstimateContentLength=true`,
      `${raw}&Unknown=1`,
      `${raw}&MediaSourceId=duplicate`,
      `${raw}&Tag=%0d%0aInjected`,
      `${raw}&Tag=%ZZ`,
      raw.replace("AudioBitrate=320000", "AudioBitrate=320001"),
      raw.replace("AudioSampleRate=48000", "AudioSampleRate=96000"),
      raw.replace("TranscodingMaxAudioChannels=2", "TranscodingMaxAudioChannels=6"),
      raw.replace("AudioCodec=aac", "AudioCodec=mp3"),
      raw.replace("AudioStreamIndex=0", "AudioStreamIndex=1"),
      raw.replace("MediaSourceId=90000000000000000000000000000004", "MediaSourceId=wrong"),
      raw.replace("ApiKey=task-8-1-fixture-token-not-a-credential", "ApiKey=wrong"),
      raw.replace("SegmentLength=10", "SegmentLength=9"),
      raw.replace("TranscodeReasons=AudioChannelsNotSupported", "TranscodeReasons=UnknownReason"),
    ];
    for (const transcodingUrl of hostile) {
      failNoStream(IDS[3], oneSource({ ...source, transcodingUrl }));
    }
  });

  it("rejects missing or incompatible negotiated results without leaking values", async () => {
    const source = (await parseFixture(hlsTranscodeFixture, IDS[3])).mediaSources[0]!;
    failNoStream(IDS[3], { mediaSources: [] });
    failNoStream(IDS[3], { errorCode: "NoCompatibleStream", mediaSources: [source] });
    failNoStream(IDS[3], oneSource({ ...source, transcodingContainer: "mp3" }));
    failNoStream(IDS[3], oneSource({ ...source, transcodingSubProtocol: "http" }));
    failNoStream(IDS[3], oneSource({ ...source, supportsTranscoding: false }));
    failNoStream(IDS[3], oneSource({
      ...source,
      requiredHttpHeaders: { Authorization: "secret" },
    }));
    expect(() => resolveSonosPlaybackTarget(IDS[3], oneSource(source), {
      ...CONNECTION,
      serverUrl: "http://media.example.test/jellyfin",
    })).toThrow();
  });
});
