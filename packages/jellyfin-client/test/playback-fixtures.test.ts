import { describe, expect, it } from "vitest";

import { JellyfinApiClient, type JellyfinDataConnection } from "../src";
import aacDirectPlay from "./fixtures/playback/aac-direct-play.json";
import flacDirectPlay from "./fixtures/playback/flac-direct-play.json";
import mp3DirectPlay from "./fixtures/playback/mp3-direct-play.json";
import mp3Transcode from "./fixtures/playback/mp3-transcode.json";

const CONNECTION: JellyfinDataConnection = {
  serverUrl: "https://media.example.test/jellyfin",
  serverId: "fixture-server-id",
  userId: "fixture-user-id",
  deviceId: "sonofin-task-8-1-fixture",
  accessToken: "task-8-1-fixture-token-not-a-credential",
};

const FIXTURES = [
  {
    name: "MP3 direct play",
    itemId: "40000000000000000000000000000001",
    payload: mp3DirectPlay,
    expected: {
      container: "mp3",
      codec: "mp3",
      sampleRate: 44_100,
      bitDepth: undefined,
      supportsDirectPlay: true,
      supportsTranscoding: true,
    },
  },
  {
    name: "AAC-in-M4A direct play",
    itemId: "40000000000000000000000000000002",
    payload: aacDirectPlay,
    expected: {
      container: "m4a",
      codec: "aac",
      sampleRate: 48_000,
      bitDepth: 16,
      supportsDirectPlay: true,
      supportsTranscoding: true,
    },
  },
  {
    name: "FLAC direct play",
    itemId: "40000000000000000000000000000003",
    payload: flacDirectPlay,
    expected: {
      container: "flac",
      codec: "flac",
      sampleRate: 48_000,
      bitDepth: 16,
      supportsDirectPlay: true,
      supportsTranscoding: true,
    },
  },
  {
    name: "high-resolution FLAC to MP3",
    itemId: "40000000000000000000000000000004",
    payload: mp3Transcode,
    expected: {
      container: "flac",
      codec: "flac",
      sampleRate: 96_000,
      bitDepth: 24,
      supportsDirectPlay: false,
      supportsTranscoding: true,
    },
  },
] as const;

function fixtureFetch(payload: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

describe("Task 8.1 PlaybackInfo fixtures", () => {
  it.each(FIXTURES)("normalizes $name", async ({ itemId, payload, expected }) => {
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: fixtureFetch(payload),
    });

    const playback = await client.getPlaybackInfo(itemId);
    const source = playback.mediaSources[0];
    const stream = source?.audioStreams[0];

    expect(playback.errorCode).toBeUndefined();
    expect(playback.playSessionId).toBe(payload.PlaySessionId);
    expect(playback.mediaSources).toHaveLength(1);
    expect(source).toMatchObject({
      container: expected.container,
      protocol: "File",
      requiredHttpHeaders: {},
      supportsDirectPlay: expected.supportsDirectPlay,
      supportsTranscoding: expected.supportsTranscoding,
    });
    expect(source?.audioStreams).toHaveLength(1);
    expect(stream).toMatchObject({
      codec: expected.codec,
      sampleRate: expected.sampleRate,
      channels: expected.supportsDirectPlay ? 2 : 6,
      isDefault: true,
    });
    expect(stream?.bitDepth).toBe(expected.bitDepth);
  });

  it("contains only synthetic locations, headers, and credentials", () => {
    for (const fixture of FIXTURES) {
      const serialized = JSON.stringify(fixture.payload);
      const source = fixture.payload.MediaSources[0];

      expect(serialized).not.toMatch(/https?:\/\//u);
      expect(serialized).not.toMatch(/(?:\/home\/|\/Users\/|[A-Z]:\\\\)/u);
      expect(serialized).not.toContain('"Path"');
      expect(source?.RequiredHttpHeaders).toEqual({});
    }

    expect(mp3Transcode.MediaSources[0]?.TranscodingUrl).toContain(
      "ApiKey=task-8-1-fixture-token-not-a-credential",
    );
  });

  it("rejects control characters in a transcode URL before normalization", async () => {
    const payload = structuredClone(mp3Transcode);
    const source = payload.MediaSources[0];
    if (source === undefined) {
      throw new Error("Missing fixture source");
    }
    source.TranscodingUrl = `\r\n${source.TranscodingUrl}\r\n`;
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: fixtureFetch(payload),
    });

    await expect(client.getPlaybackInfo(FIXTURES[3].itemId)).rejects.toMatchObject({
      code: "invalid_server_response",
    });
  });
});
