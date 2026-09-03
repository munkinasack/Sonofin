import { describe, expect, it } from "vitest";

import type { JellyfinTrack } from "@sonofin/jellyfin-client";
import {
  encodeSonosContentId,
  SONOS_MAX_COLLECTION_TEXT_CHARACTERS,
  SONOS_MAX_SIGNED_INT,
} from "@sonofin/sonos-smapi";

import { formatJellyfinTrackAsSonosBrowseTrack } from "../src";

function track(overrides: Partial<JellyfinTrack> = {}): JellyfinTrack {
  return {
    artists: [],
    container: "mp3",
    id: "track-id",
    kind: "track",
    name: "Track title",
    ...overrides,
  };
}

describe("formatJellyfinTrackAsSonosBrowseTrack", () => {
  it("maps normalized metadata, identifiers, duration units, and conservative flags", () => {
    const result = formatJellyfinTrackAsSonosBrowseTrack(
      track({
        albumId: "album-二",
        albumName: "Álbum 二",
        artists: [{ id: "artist-一", name: "Björk 一" }],
        container: "FLAC",
        durationMs: 181_999,
        id: "track-三",
        name: "Jóga 三",
        trackNumber: 7,
      }),
    );

    expect(result).toEqual({
      id: encodeSonosContentId({ kind: "track", value: "track-三" }),
      itemType: "track",
      kind: "track",
      mimeType: "audio/flac",
      title: "Jóga 三",
      trackMetadata: {
        album: "Álbum 二",
        albumId: encodeSonosContentId({
          kind: "album",
          value: "album-二",
        }),
        artist: "Björk 一",
        artistId: encodeSonosContentId({
          kind: "artist",
          value: "artist-一",
        }),
        canAddToFavorites: false,
        canPlay: false,
        canResume: false,
        canSeek: false,
        canSkip: false,
        duration: 181,
        trackNumber: 7,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.trackMetadata)).toBe(true);
  });

  it.each([
    ["aac", "audio/aac"],
    ["asf", "audio/x-ms-wma"],
    ["flac", "audio/flac"],
    ["m4a", "audio/mp4"],
    ["mp3", "audio/mpeg"],
    ["mp4", "audio/mp4"],
    ["ogg", "application/ogg"],
    ["wma", "audio/x-ms-wma"],
  ] as const)("maps Jellyfin container %s to %s", (container, mimeType) => {
    expect(
      formatJellyfinTrackAsSonosBrowseTrack(
        track({ container: container.toUpperCase() }),
      ).mimeType,
    ).toBe(mimeType);
  });

  it("omits metadata that Jellyfin does not provide", () => {
    expect(formatJellyfinTrackAsSonosBrowseTrack(track())).toEqual({
      id: encodeSonosContentId({ kind: "track", value: "track-id" }),
      itemType: "track",
      kind: "track",
      mimeType: "audio/mpeg",
      title: "Track title",
      trackMetadata: {
        canAddToFavorites: false,
        canPlay: false,
        canResume: false,
        canSeek: false,
        canSkip: false,
      },
    });
  });

  it("omits absent and unusable optional metadata without fabricating it", () => {
    const title = "🎵".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS + 100);
    const result = formatJellyfinTrackAsSonosBrowseTrack(
      track({
        albumId: "x".repeat(255),
        albumName: "x".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS + 1),
        artists: [
          { id: "unsafe", name: "line\nbreak" },
          {
            id: "x".repeat(255),
            name: "Artist without a usable identifier",
          },
        ],
        durationMs: (SONOS_MAX_SIGNED_INT + 1) * 1_000,
        name: title,
        trackNumber: SONOS_MAX_SIGNED_INT + 1,
      }),
    );

    expect(result.title).toBe(title);
    expect(result.trackMetadata).toEqual({
      artist: "Artist without a usable identifier",
      canAddToFavorites: false,
      canPlay: false,
      canResume: false,
      canSeek: false,
      canSkip: false,
    });
  });

  it("preserves supported integer boundaries and floors partial seconds", () => {
    const result = formatJellyfinTrackAsSonosBrowseTrack(
      track({
        durationMs: SONOS_MAX_SIGNED_INT * 1_000 + 999,
        trackNumber: SONOS_MAX_SIGNED_INT,
      }),
    );

    expect(result.trackMetadata).toMatchObject({
      duration: SONOS_MAX_SIGNED_INT,
      trackNumber: SONOS_MAX_SIGNED_INT,
    });
    expect(
      formatJellyfinTrackAsSonosBrowseTrack(
        track({ durationMs: 999, trackNumber: -1 }),
      ).trackMetadata,
    ).toMatchObject({ duration: 0 });
    expect(
      formatJellyfinTrackAsSonosBrowseTrack(
        track({ durationMs: 999, trackNumber: -1 }),
      ).trackMetadata,
    ).not.toHaveProperty("trackNumber");
  });

  it.each([
    ["missing track ID", { id: undefined }],
    ["blank title", { name: " " }],
    ["multiline title", { name: "line\u2028break" }],
    ["unsafe title", { name: "unsafe\u0000title" }],
    ["wrong kind", { kind: "album" }],
    ["missing artists", { artists: undefined }],
    ["missing container", { container: undefined }],
    ["unknown container", { container: "wav" }],
    ["ambiguous container", { container: "mp3,flac" }],
    ["unnormalized container", { container: " mp3 " }],
  ])("rejects a normalized track with %s", (_name, overrides) => {
    expect(() =>
      formatJellyfinTrackAsSonosBrowseTrack(
        track(overrides as Partial<JellyfinTrack>),
      ),
    ).toThrowError(expect.objectContaining({
      code: "invalid_server_response",
      name: "JellyfinClientError",
    }));
  });
});
