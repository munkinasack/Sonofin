import { describe, expect, it, vi } from "vitest";

import {
  JellyfinClientError,
  type JellyfinConnection,
  type JellyfinDataClient,
  type JellyfinItemMetadata,
  type JellyfinPlaybackInfo,
} from "@sonofin/jellyfin-client";
import { encodeSonosContentId } from "@sonofin/sonos-smapi";

import {
  SonofinMediaMetadataService,
  type SmapiAuthenticatedRequestContext,
  type SmapiGetMediaMetadataRequest,
} from "../src";

const sonosMapping = {
  householdId: "Sonos_Household_CaseSensitive",
  id: "a".repeat(64),
  jellyfinConnectionId: "J".repeat(32),
};
const connection = {
  accessToken: "test-token",
  deviceId: "test-device",
  serverId: "test-server",
  serverName: "Test Jellyfin",
  serverUrl: "https://media.example.test/jellyfin",
  serverVersion: "10.11.11",
  userId: "test-user",
  username: "test-user",
} satisfies JellyfinConnection;

function context(
  methods: Partial<JellyfinDataClient>,
): SmapiAuthenticatedRequestContext {
  return {
    connection,
    jellyfin: methods as JellyfinDataClient,
    sonosMapping,
  };
}

function request(
  id: string,
  methods: Partial<JellyfinDataClient> = {},
): SmapiGetMediaMetadataRequest {
  return { context: context(methods), id };
}

function directPlaybackInfo(): JellyfinPlaybackInfo {
  return {
    mediaSources: [{
      id: "source-id",
      protocol: "File",
      container: "flac",
      bitrate: 1_000_000,
      supportsDirectPlay: true,
      supportsDirectStream: false,
      supportsTranscoding: true,
      requiredHttpHeaders: {},
      audioStreams: [{
        index: 0,
        codec: "flac",
        channels: 2,
        sampleRate: 48_000,
        bitDepth: 16,
        isDefault: true,
      }],
    }],
  };
}

function hlsPlaybackInfo(): JellyfinPlaybackInfo {
  return {
    mediaSources: [{
      id: "source-id",
      protocol: "File",
      container: "flac",
      bitrate: 2_852_000,
      supportsDirectPlay: false,
      supportsDirectStream: false,
      supportsTranscoding: true,
      transcodingContainer: "ts",
      transcodingSubProtocol: "hls",
      transcodingUrl:
        "/audio/track-id/master.m3u8?DeviceId=test-device&MediaSourceId=source-id" +
        "&AudioCodec=aac&AudioBitrate=320000&AudioSampleRate=48000" +
        "&SegmentContainer=ts&SegmentLength=10&MinSegments=1" +
        "&BreakOnNonKeyFrames=False&ApiKey=test-token" +
        "&TranscodingMaxAudioChannels=2&RequireAvc=false" +
        "&EnableAudioVbrEncoding=false&audiochannels=2" +
        "&allowAudioStreamCopy=false&allowVideoStreamCopy=false" +
        "&TranscodeReasons=AudioSampleRateNotSupported%2CAudioBitDepthNotSupported",
      requiredHttpHeaders: {},
      audioStreams: [{
        index: 0,
        codec: "flac",
        channels: 2,
        sampleRate: 96_000,
        bitDepth: 24,
        isDefault: true,
      }],
    }],
  };
}

describe("SonofinMediaMetadataService", () => {
  it("loads a track and returns the browse-consistent playable metadata", async () => {
    const item = {
      albumId: "album-id",
      albumName: "An Album",
      artists: [{ id: "artist-id", name: "An Artist" }],
      container: "flac",
      durationMs: 125_500,
      id: "track-id",
      kind: "track" as const,
      name: "A Track",
      trackNumber: 7,
    };
    const getItemMetadata = vi.fn().mockResolvedValue(item);
    const getPlaybackInfo = vi.fn().mockResolvedValue(directPlaybackInfo());
    const id = encodeSonosContentId({ kind: "track", value: item.id });

    const result = await new SonofinMediaMetadataService().getMediaMetadata(
      request(id, { getItemMetadata, getPlaybackInfo }),
    );

    expect(getItemMetadata).toHaveBeenCalledWith(item.id);
    expect(getPlaybackInfo).toHaveBeenCalledWith(item.id);
    expect(result).toEqual({
      id,
      itemType: "track",
      kind: "track",
      mimeType: "audio/flac",
      title: "A Track",
      trackMetadata: {
        album: "An Album",
        albumId: encodeSonosContentId({ kind: "album", value: "album-id" }),
        artist: "An Artist",
        artistId: encodeSonosContentId({ kind: "artist", value: "artist-id" }),
        canAddToFavorites: false,
        canPlay: true,
        canResume: false,
        canSeek: true,
        canSkip: false,
        duration: 125,
        trackNumber: 7,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.trackMetadata)).toBe(true);
  });

  it("advertises the negotiated HLS media type for a forced transcode", async () => {
    const item = {
      artists: [],
      container: "ape",
      durationMs: 216_000,
      id: "track-id",
      kind: "track" as const,
      name: "High-resolution track",
    };
    const getItemMetadata = vi.fn().mockResolvedValue(item);
    const getPlaybackInfo = vi.fn().mockResolvedValue(hlsPlaybackInfo());

    const result = await new SonofinMediaMetadataService().getMediaMetadata(
      request(
        encodeSonosContentId({ kind: "track", value: item.id }),
        { getItemMetadata, getPlaybackInfo },
      ),
    );

    expect(result.mimeType).toBe("application/vnd.apple.mpegurl");
    expect(result.itemType).toBe("track");
    expect(result.trackMetadata.duration).toBe(216);
    expect(getPlaybackInfo).toHaveBeenCalledWith(item.id);
  });

  it.each([
    ["malformed", "invalid_parameters"],
    ["root", "item_not_found"],
    ["albums", "item_not_found"],
    [
      encodeSonosContentId({ kind: "album", value: "album-id" }),
      "item_not_found",
    ],
  ] as const)("rejects non-track ID %s safely", async (id, code) => {
    const getItemMetadata = vi.fn();

    await expect(
      new SonofinMediaMetadataService().getMediaMetadata(
        request(id, { getItemMetadata }),
      ),
    ).rejects.toMatchObject({ code, name: "SmapiBrowseError" });
    expect(getItemMetadata).not.toHaveBeenCalled();
  });

  it.each([
    { id: "same-id", kind: "artist", name: "Wrong Kind" },
    {
      id: "same-id",
      jellyfinType: "Video",
      kind: "unknown",
      name: "Wrong Type",
    },
    {
      artists: [],
      container: "mp3",
      id: "different-id",
      kind: "track",
      name: "Wrong ID",
    },
  ] as const)("rejects a track ID resolving to mismatched $kind metadata", async (item) => {
    const getItemMetadata = vi
      .fn<() => Promise<JellyfinItemMetadata>>()
      .mockResolvedValue(item as JellyfinItemMetadata);
    const getPlaybackInfo = vi.fn();

    await expect(
      new SonofinMediaMetadataService().getMediaMetadata(
        request(
          encodeSonosContentId({ kind: "track", value: "same-id" }),
          { getItemMetadata, getPlaybackInfo },
        ),
      ),
    ).rejects.toMatchObject({
      code: "item_not_found",
      name: "SmapiBrowseError",
    });
    expect(getPlaybackInfo).not.toHaveBeenCalled();
  });

  it("preserves credential-safe Jellyfin failures for Worker fault mapping", async () => {
    const failure = new JellyfinClientError("item_not_found", {
      upstreamStatus: 404,
    });

    await expect(
      new SonofinMediaMetadataService().getMediaMetadata(
        request(
          encodeSonosContentId({ kind: "track", value: "deleted" }),
          { getItemMetadata: vi.fn().mockRejectedValue(failure) },
        ),
      ),
    ).rejects.toBe(failure);
  });
});
