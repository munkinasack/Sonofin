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
import flacFixture from "./fixtures/playback/flac-direct-play.json";
import mp3Fixture from "./fixtures/playback/mp3-direct-play.json";
import transcodeFixture from "./fixtures/playback/mp3-transcode.json";

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

  it("strips credentials and session fields from the MP3 fixture with stable retries", async () => {
    const playback = await parseFixture(transcodeFixture, IDS[3]);
    const first = resolveSonosPlaybackTarget(IDS[3], playback, CONNECTION);
    const second = resolveSonosPlaybackTarget(IDS[3], playback, CONNECTION);

    expect(first).toEqual(second);
    expect(first.method).toBe("transcode");
    expect(first.mimeType).toBe("audio/mpeg");
    expect(first.url).toMatch(
      /^https:\/\/media\.example\.test\/jellyfin\/audio\/40000000000000000000000000000004\/stream\.mp3\?/u,
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

  it("normalizes application-root, base-prefixed, and same-origin absolute transcode paths", async () => {
    const source = (await parseFixture(transcodeFixture, IDS[3])).mediaSources[0]!;
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

  it("ranks direct play, File transcodes, then source IDs independently of response order", async () => {
    const direct = (await parseFixture(mp3Fixture, IDS[0])).mediaSources[0]!;
    const transcode = (await parseFixture(transcodeFixture, IDS[3])).mediaSources[0]!;
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
    const transcode = (await parseFixture(transcodeFixture, IDS[3])).mediaSources[0]!;
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
    const source = (await parseFixture(transcodeFixture, IDS[3])).mediaSources[0]!;
    const raw = source.transcodingUrl!;
    const query = raw.slice(raw.indexOf("?"));
    const hostile = [
      `https://evil.example.test/jellyfin/audio/${IDS[3]}/stream.mp3${query}`,
      `https://media.example.test:444/jellyfin/audio/${IDS[3]}/stream.mp3${query}`,
      `http://media.example.test/jellyfin/audio/${IDS[3]}/stream.mp3${query}`,
      `//media.example.test/jellyfin/audio/${IDS[3]}/stream.mp3${query}`,
      `/jellyfin2/audio/${IDS[3]}/stream.mp3${query}`,
      `/audio/../audio/${IDS[3]}/stream.mp3${query}`,
      `/audio/%2e%2e/audio/${IDS[3]}/stream.mp3${query}`,
      `/audio/%2F${IDS[3]}/stream.mp3${query}`,
      `/audio/%255C${IDS[3]}/stream.mp3${query}`,
      `/audio\\${IDS[3]}/stream.mp3${query}`,
      `/audio/${IDS[3]}/stream.mp3${query}#fragment`,
      `https://user:password@media.example.test/jellyfin/audio/${IDS[3]}/stream.mp3${query}`,
      `https://@media.example.test/jellyfin/audio/${IDS[3]}/stream.mp3${query}`,
      `https://:@media.example.test/jellyfin/audio/${IDS[3]}/stream.mp3${query}`,
    ];
    for (const transcodingUrl of hostile) {
      failNoStream(IDS[3], oneSource({ ...source, transcodingUrl }));
    }
  });

  it("rejects unknown, duplicate, credential-like, malformed, and unsafe query fields", async () => {
    const source = (await parseFixture(transcodeFixture, IDS[3])).mediaSources[0]!;
    const raw = source.transcodingUrl!;
    const hostile = [
      `${raw}&ApiKey=duplicate`,
      `${raw}&%41piKey=duplicate`,
      `${raw}&api_key=another`,
      `${raw}&Authorization=secret`,
      `${raw}&Unknown=1`,
      `${raw}&MediaSourceId=duplicate`,
      `${raw}&Tag=%0d%0aInjected`,
      `${raw}&Tag=%ZZ`,
      raw.replace("AudioBitrate=320000", "AudioBitrate=320001"),
      raw.replace("AudioSampleRate=48000", "AudioSampleRate=96000"),
      raw.replace("TranscodingMaxAudioChannels=2", "TranscodingMaxAudioChannels=6"),
      raw.replace("AudioCodec=mp3", "AudioCodec=aac"),
      raw.replace("AudioStreamIndex=0", "AudioStreamIndex=1"),
      raw.replace("MediaSourceId=90000000000000000000000000000004", "MediaSourceId=wrong"),
      raw.replace("ApiKey=task-8-1-fixture-token-not-a-credential", "ApiKey=wrong"),
      raw.replace("EstimateContentLength=true", "EstimateContentLength=false"),
      raw.replace("TranscodeReasons=AudioChannelsNotSupported", "TranscodeReasons=UnknownReason"),
    ];
    for (const transcodingUrl of hostile) {
      failNoStream(IDS[3], oneSource({ ...source, transcodingUrl }));
    }
  });

  it("rejects missing or incompatible negotiated results without leaking values", async () => {
    const source = (await parseFixture(transcodeFixture, IDS[3])).mediaSources[0]!;
    failNoStream(IDS[3], { mediaSources: [] });
    failNoStream(IDS[3], { errorCode: "NoCompatibleStream", mediaSources: [source] });
    failNoStream(IDS[3], oneSource({ ...source, transcodingContainer: "aac" }));
    failNoStream(IDS[3], oneSource({ ...source, transcodingSubProtocol: "hls" }));
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
