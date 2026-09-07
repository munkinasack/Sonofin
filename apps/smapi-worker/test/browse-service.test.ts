import { describe, expect, it, vi } from "vitest";

import {
  JellyfinClientError,
  type JellyfinDataClient,
} from "@sonofin/jellyfin-client";
import {
  encodeSonosContentId,
  SONOS_MAX_COLLECTION_TEXT_CHARACTERS,
  SONOS_MAX_SIGNED_INT,
} from "@sonofin/sonos-smapi";

import {
  SmapiBrowseError,
  SonofinBrowseService,
  type SmapiAuthenticatedRequestContext,
  type SmapiGetMetadataRequest,
} from "../src";

const jellyfin = new Proxy(
  {},
  {
    get() {
      throw new Error("The root menu must not call Jellyfin");
    },
  },
) as JellyfinDataClient;

const context: SmapiAuthenticatedRequestContext = {
  jellyfin,
  sonosMapping: {
    householdId: "Sonos_Household_CaseSensitive",
    id: "a".repeat(64),
    jellyfinConnectionId: "J".repeat(32),
  },
};

function request(
  overrides: Partial<SmapiGetMetadataRequest> = {},
): SmapiGetMetadataRequest {
  return {
    context,
    count: "100",
    id: "root",
    index: "0",
    ...overrides,
  };
}

function withJellyfin(
  methods: Partial<JellyfinDataClient>,
): SmapiAuthenticatedRequestContext {
  return {
    ...context,
    jellyfin: methods as JellyfinDataClient,
  };
}

async function expectBrowseError(
  promise: Promise<unknown>,
  code: SmapiBrowseError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code,
    message: "The SMAPI browse request could not be completed",
    name: "SmapiBrowseError",
  });
}

describe("SonofinBrowseService", () => {
  it("returns the aggregate root menu in stable Sonos order", async () => {
    const result = await new SonofinBrowseService().getMetadata(request());

    expect(result).toEqual({
      index: 0,
      items: [
        {
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: "artists",
          itemType: "container",
          kind: "collection",
          title: "Artists",
        },
        {
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: "albums",
          itemType: "albumList",
          kind: "collection",
          title: "Albums",
        },
        {
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: "playlists",
          itemType: "playlist",
          kind: "collection",
          title: "Playlists",
        },
        {
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: "search",
          itemType: "container",
          kind: "collection",
          title: "Search",
        },
      ],
      total: 4,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(result.items.every((item) => Object.isFrozen(item))).toBe(true);
  });

  it.each([
    ["0", "2", ["Artists", "Albums"]],
    ["2", "100", ["Playlists", "Search"]],
    ["3", "1", ["Search"]],
    ["4", "100", []],
    ["30", "10", []],
    [String(SONOS_MAX_SIGNED_INT), "1", []],
  ] as const)(
    "paginates root from index %s with count %s",
    async (index, count, titles) => {
      const result = await new SonofinBrowseService().getMetadata(
        request({ count, index }),
      );

      expect(result.index).toBe(Number(index));
      expect(result.total).toBe(4);
      expect(result.items.map((item) => item.title)).toEqual(titles);
    },
  );

  it.each([
    ["missing id", { id: undefined }],
    ["empty id", { id: "" }],
    ["non-canonical id", { id: "not-a-content-id" }],
    ["overlong id", { id: "x".repeat(129) }],
    ["missing index", { index: undefined }],
    ["negative index", { index: "-1" }],
    ["non-canonical index", { index: "01" }],
    ["oversized index", { index: "2147483648" }],
    ["missing count", { count: undefined }],
    ["zero count", { count: "0" }],
    ["non-canonical count", { count: "01" }],
    ["oversized count", { count: "101" }],
    ["recursive flattening", { recursive: "true" }],
    ["numeric recursive flattening", { recursive: "1" }],
    ["malformed recursive flag", { recursive: "yes" }],
  ] as const)("rejects %s", async (_name, overrides) => {
    await expectBrowseError(
      new SonofinBrowseService().getMetadata(request(overrides)),
      "invalid_parameters",
    );
  });

  it("rejects the valid but not-yet-supported ID tracks", async () => {
    await expectBrowseError(
      new SonofinBrowseService().getMetadata(request({ id: "tracks" })),
      "item_not_found",
    );
  });

  it("returns stable paginated search categories without calling Jellyfin", async () => {
    const service = new SonofinBrowseService();
    const result = await service.getMetadata(
      request({ count: "2", id: "search", index: "1" }),
    );

    expect(result).toEqual({
      index: 1,
      items: [
        {
          canAddToFavorites: false,
          canEnumerate: false,
          canPlay: false,
          canScroll: false,
          id: "album",
          itemType: "search",
          kind: "collection",
          title: "Albums",
        },
        {
          canAddToFavorites: false,
          canEnumerate: false,
          canPlay: false,
          canScroll: false,
          id: "track",
          itemType: "search",
          kind: "collection",
          title: "Tracks",
        },
      ],
      total: 4,
    });
    await expect(
      service.getMetadata(
        request({ count: "100", id: "search", index: "4" }),
      ),
    ).resolves.toEqual({ index: 4, items: [], total: 4 });
  });

  it.each([undefined, "false", "0"])(
    "accepts non-recursive root browsing with recursive=%s",
    async (recursive) => {
      await expect(
        new SonofinBrowseService().getMetadata(request({ recursive })),
      ).resolves.toMatchObject({ index: 0, total: 4 });
    },
  );

  it("maps a paginated Unicode artist page in Jellyfin order", async () => {
    const getArtists = vi.fn().mockResolvedValue({
      items: [
        { id: "artist-二", kind: "artist", name: "Björk & 二" },
        { id: "artist-1", kind: "artist", name: "Zoë" },
      ],
      startIndex: 7,
      totalRecordCount: 42,
    });
    const result = await new SonofinBrowseService().getMetadata(
      request({
        context: withJellyfin({ getArtists }),
        count: "2",
        id: "artists",
        index: "7",
      }),
    );

    expect(getArtists).toHaveBeenCalledWith({ limit: 2, startIndex: 7 });
    expect(result).toEqual({
      index: 7,
      items: [
        {
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: encodeSonosContentId({ kind: "artist", value: "artist-二" }),
          itemType: "artist",
          kind: "collection",
          title: "Björk & 二",
        },
        {
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: encodeSonosContentId({ kind: "artist", value: "artist-1" }),
          itemType: "artist",
          kind: "collection",
          title: "Zoë",
        },
      ],
      total: 42,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(result.items.every((item) => Object.isFrozen(item))).toBe(true);
  });

  it("accepts a Sonos-length Unicode artist title", async () => {
    const title = "🎵".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS);
    const getArtists = vi.fn().mockResolvedValue({
      items: [{ id: "artist-id", kind: "artist", name: title }],
      startIndex: 0,
      totalRecordCount: 1,
    });

    const result = await new SonofinBrowseService().getMetadata(
      request({ context: withJellyfin({ getArtists }), id: "artists" }),
    );

    expect(result.items[0]?.title).toBe(title);
  });

  it("maps artist-filtered albums and only emits available safe artist metadata", async () => {
    const artistId = "jellyfin-artist";
    const getAlbums = vi.fn().mockResolvedValue({
      items: [
        {
          artists: [{ id: artistId, name: "Sigur Rós" }],
          id: "album-one",
          kind: "album",
          name: "( )",
          overview: "deliberately omitted",
        },
        {
          artists: [],
          id: "album-two",
          kind: "album",
          name: "無題",
        },
        {
          artists: [{ id: "x".repeat(255), name: "Optional artist" }],
          id: "album-three",
          kind: "album",
          name: "Album Three",
        },
      ],
      startIndex: 3,
      totalRecordCount: 9,
    });
    const result = await new SonofinBrowseService().getMetadata(
      request({
        context: withJellyfin({ getAlbums }),
        count: "3",
        id: encodeSonosContentId({ kind: "artist", value: artistId }),
        index: "3",
      }),
    );

    expect(getAlbums).toHaveBeenCalledWith({
      artistId,
      limit: 3,
      startIndex: 3,
    });
    expect(result.index).toBe(3);
    expect(result.total).toBe(9);
    expect(result.items.map((item) => item.title)).toEqual([
      "( )",
      "無題",
      "Album Three",
    ]);
    expect(result.items[0]).toMatchObject({
      artist: "Sigur Rós",
      artistId: encodeSonosContentId({ kind: "artist", value: artistId }),
      itemType: "album",
    });
    expect(result.items[1]).not.toHaveProperty("artist");
    expect(result.items[1]).not.toHaveProperty("artistId");
    expect(result.items[2]).toMatchObject({ artist: "Optional artist" });
    expect(result.items[2]).not.toHaveProperty("artistId");
    expect(result.items[0]).not.toHaveProperty("summary");
  });

  it("omits unusable optional album-artist metadata", async () => {
    const safeArtistName = "🎵".repeat(
      SONOS_MAX_COLLECTION_TEXT_CHARACTERS,
    );
    const getAlbums = vi.fn().mockResolvedValue({
      items: [
        {
          artists: [
            {
              id: "overlong-name",
              name: "x".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS + 1),
            },
            { id: "unsafe-name", name: "unsafe\u0000name" },
            { id: "newline-name", name: "line\u2028break" },
          ],
          id: "album-without-artist",
          kind: "album",
          name: "No usable artist",
          primaryImageTag: "deliberately-omitted-image-tag",
        },
        {
          artists: [{ name: "Artist without an ID" }],
          id: "album-with-artist-name",
          kind: "album",
          name: "Missing optional artist ID",
        },
        {
          artists: [{ id: "safe-artist-id", name: safeArtistName }],
          id: "album-with-safe-artist",
          kind: "album",
          name: "Safe optional artist",
        },
      ],
      startIndex: 0,
      totalRecordCount: 3,
    });

    const result = await new SonofinBrowseService().getMetadata(
      request({
        context: withJellyfin({ getAlbums }),
        count: "3",
        id: encodeSonosContentId({ kind: "artist", value: "artist-id" }),
      }),
    );

    expect(result.items[0]).not.toHaveProperty("artist");
    expect(result.items[0]).not.toHaveProperty("artistId");
    expect(result.items[0]).not.toHaveProperty("primaryImageTag");
    expect(result.items[1]).toMatchObject({ artist: "Artist without an ID" });
    expect(result.items[1]).not.toHaveProperty("artistId");
    expect(result.items[2]).toMatchObject({
      artist: safeArtistName,
      artistId: encodeSonosContentId({
        kind: "artist",
        value: "safe-artist-id",
      }),
    });
  });

  it("maps global albums without adding an artist filter", async () => {
    const getAlbums = vi.fn().mockResolvedValue({
      items: [
        {
          artists: [{ id: "artist-two", name: "Artist Two" }],
          id: "album-two",
          kind: "album",
          name: "Album Two",
        },
        {
          artists: [{ id: "artist-one", name: "Artist One" }],
          id: "album-one",
          kind: "album",
          name: "Album One",
        },
      ],
      startIndex: 4,
      totalRecordCount: 17,
    });
    const result = await new SonofinBrowseService().getMetadata(
      request({
        context: withJellyfin({ getAlbums }),
        count: "2",
        id: "albums",
        index: "4",
      }),
    );

    expect(getAlbums).toHaveBeenCalledWith({ limit: 2, startIndex: 4 });
    expect(result.index).toBe(4);
    expect(result.total).toBe(17);
    expect(result.items.map((item) => item.title)).toEqual([
      "Album Two",
      "Album One",
    ]);
    expect(result.items[0]).toMatchObject({
      artist: "Artist Two",
      artistId: encodeSonosContentId({
        kind: "artist",
        value: "artist-two",
      }),
      canAddToFavorites: false,
      canEnumerate: true,
      canPlay: false,
      canScroll: false,
      id: encodeSonosContentId({ kind: "album", value: "album-two" }),
      itemType: "album",
      kind: "collection",
    });
  });

  it("maps paginated playlists and only emits Sonos-safe child totals", async () => {
    const getPlaylists = vi.fn().mockResolvedValue({
      items: [
        {
          childCount: 12,
          id: "playlist-二",
          kind: "playlist",
          name: "Morning & 二",
          overview: "deliberately omitted",
        },
        {
          id: "playlist-without-count",
          kind: "playlist",
          name: "Unknown size",
        },
        {
          childCount: 0,
          id: "empty-playlist",
          kind: "playlist",
          name: "Empty playlist",
        },
        {
          childCount: SONOS_MAX_SIGNED_INT + 1,
          id: "oversized-count",
          kind: "playlist",
          name: "Oversized count",
        },
      ],
      startIndex: 4,
      totalRecordCount: 17,
    });
    const result = await new SonofinBrowseService().getMetadata(
      request({
        context: withJellyfin({ getPlaylists }),
        count: "4",
        id: "playlists",
        index: "4",
      }),
    );

    expect(getPlaylists).toHaveBeenCalledWith({ limit: 4, startIndex: 4 });
    expect(result).toEqual({
      index: 4,
      items: [
        {
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: encodeSonosContentId({
            kind: "playlist",
            value: "playlist-二",
          }),
          itemType: "playlist",
          kind: "collection",
          title: "Morning & 二",
          total: 12,
        },
        {
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: encodeSonosContentId({
            kind: "playlist",
            value: "playlist-without-count",
          }),
          itemType: "playlist",
          kind: "collection",
          title: "Unknown size",
        },
        {
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: encodeSonosContentId({
            kind: "playlist",
            value: "empty-playlist",
          }),
          itemType: "playlist",
          kind: "collection",
          title: "Empty playlist",
          total: 0,
        },
        {
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: encodeSonosContentId({
            kind: "playlist",
            value: "oversized-count",
          }),
          itemType: "playlist",
          kind: "collection",
          title: "Oversized count",
        },
      ],
      total: 17,
    });
    expect(result.items[0]).not.toHaveProperty("overview");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(result.items.every((item) => Object.isFrozen(item))).toBe(true);
  });

  it("preserves ordered duplicate playlist entries without changing playback identity", async () => {
    const playlistId = "playlist/二";
    const firstTrackId = "catalog-track-one";
    const secondTrackId = "catalog-track-two";
    const getPlaylistTracks = vi.fn().mockResolvedValue({
      items: [
        {
          artists: [{ id: "artist-id", name: "Artist" }],
          container: "flac",
          id: firstTrackId,
          kind: "track",
          name: "First occurrence",
          playlistItemId: secondTrackId,
        },
        {
          artists: [{ id: "artist-id", name: "Artist" }],
          container: "mp3",
          id: firstTrackId,
          kind: "track",
          name: "Duplicate occurrence",
          playlistItemId: "unsafe\u0000playlist-entry",
        },
        {
          artists: [],
          container: "aac",
          id: secondTrackId,
          kind: "track",
          name: "Second catalog track",
          playlistItemId: firstTrackId,
        },
      ],
      startIndex: 5,
      totalRecordCount: 9,
    });
    const result = await new SonofinBrowseService().getMetadata(
      request({
        context: withJellyfin({ getPlaylistTracks }),
        count: "3",
        id: encodeSonosContentId({ kind: "playlist", value: playlistId }),
        index: "5",
      }),
    );

    expect(getPlaylistTracks).toHaveBeenCalledWith(playlistId, {
      limit: 3,
      startIndex: 5,
    });
    expect(result).toMatchObject({ index: 5, total: 9 });
    expect(result.items.map((item) => item.title)).toEqual([
      "First occurrence",
      "Duplicate occurrence",
      "Second catalog track",
    ]);
    expect(result.items.map((item) => item.id)).toEqual([
      encodeSonosContentId({ kind: "track", value: firstTrackId }),
      encodeSonosContentId({ kind: "track", value: firstTrackId }),
      encodeSonosContentId({ kind: "track", value: secondTrackId }),
    ]);
    expect(result.items.map((item) =>
      item.kind === "track" ? item.mimeType : undefined,
    )).toEqual(["audio/flac", "audio/mpeg", "audio/aac"]);
    expect(result.items.every((item) =>
      !("playlistItemId" in item),
    )).toBe(true);
  });

  it("preserves Jellyfin multi-disc track order and exact album identity", async () => {
    const albumId = "album/二";
    const getAlbumTracks = vi.fn().mockResolvedValue({
      items: [
        {
          albumId,
          albumName: "Double Album",
          artists: [{ id: "artist-id", name: "Artist" }],
          container: "flac",
          discNumber: 1,
          durationMs: 61_999,
          id: "disc-one-track-nine",
          kind: "track",
          name: "Disc One Finale",
          trackNumber: 9,
        },
        {
          albumId,
          albumName: "Double Album",
          artists: [{ id: "artist-id", name: "Artist" }],
          container: "mp3",
          discNumber: 2,
          durationMs: 62_001,
          id: "disc-two-track-one",
          kind: "track",
          name: "Disc Two Opener",
          trackNumber: 1,
        },
      ],
      startIndex: 8,
      totalRecordCount: 20,
    });
    const result = await new SonofinBrowseService().getMetadata(
      request({
        context: withJellyfin({ getAlbumTracks }),
        count: "2",
        id: encodeSonosContentId({ kind: "album", value: albumId }),
        index: "8",
      }),
    );

    expect(getAlbumTracks).toHaveBeenCalledWith(albumId, {
      limit: 2,
      startIndex: 8,
    });
    expect(result).toMatchObject({ index: 8, total: 20 });
    expect(result.items.map((item) => item.title)).toEqual([
      "Disc One Finale",
      "Disc Two Opener",
    ]);
    expect(result.items[0]).toMatchObject({
      id: encodeSonosContentId({
        kind: "track",
        value: "disc-one-track-nine",
      }),
      itemType: "track",
      kind: "track",
      mimeType: "audio/flac",
      trackMetadata: {
        album: "Double Album",
        albumId: encodeSonosContentId({ kind: "album", value: albumId }),
        artist: "Artist",
        canAddToFavorites: false,
        canPlay: false,
        canResume: false,
        canSeek: false,
        canSkip: false,
        duration: 61,
        trackNumber: 9,
      },
    });
    expect(result.items[0]).not.toHaveProperty("discNumber");
    expect(result.items[1]).toMatchObject({
      mimeType: "audio/mpeg",
      trackMetadata: { duration: 62, trackNumber: 1 },
    });
  });

  it.each([
    ["artists", "getArtists", { id: "artist-1", kind: "artist", name: "One" }],
    [
      encodeSonosContentId({ kind: "artist", value: "artist-filter" }),
      "getAlbums",
      { artists: [], id: "album-1", kind: "album", name: "One" },
    ],
    [
      "albums",
      "getAlbums",
      { artists: [], id: "album-1", kind: "album", name: "One" },
    ],
    [
      encodeSonosContentId({ kind: "album", value: "album-filter" }),
      "getAlbumTracks",
      {
        artists: [],
        container: "mp3",
        id: "track-1",
        kind: "track",
        name: "One",
      },
    ],
    [
      "playlists",
      "getPlaylists",
      { childCount: 1, id: "playlist-1", kind: "playlist", name: "One" },
    ],
    [
      encodeSonosContentId({ kind: "playlist", value: "playlist-filter" }),
      "getPlaylistTracks",
      {
        artists: [],
        container: "mp3",
        id: "track-1",
        kind: "track",
        name: "One",
        playlistItemId: "entry-1",
      },
    ],
  ] as const)(
    "rejects a %s page outside the requested window",
    async (id, method, item) => {
      const invalidPages = [
        { items: [item], startIndex: 6, totalRecordCount: 20 },
        { items: [item], startIndex: 8, totalRecordCount: 20 },
        { items: [item, item], startIndex: 7, totalRecordCount: 20 },
      ];

      for (const page of invalidPages) {
        const dataMethod = vi.fn().mockResolvedValue(page);
        await expect(
          new SonofinBrowseService().getMetadata(
            request({
              context: withJellyfin({ [method]: dataMethod }),
              count: "1",
              id,
              index: "7",
            }),
          ),
        ).rejects.toMatchObject({
          code: "invalid_server_response",
          name: "JellyfinClientError",
        });
      }
    },
  );

  it.each([
    [
      "artists",
      "getArtists",
      { limit: 100, startIndex: SONOS_MAX_SIGNED_INT },
    ],
    [
      "albums",
      "getAlbums",
      { limit: 100, startIndex: SONOS_MAX_SIGNED_INT },
    ],
    [
      "playlists",
      "getPlaylists",
      { limit: 100, startIndex: SONOS_MAX_SIGNED_INT },
    ],
    [
      encodeSonosContentId({ kind: "artist", value: "empty-artist" }),
      "getAlbums",
      {
        artistId: "empty-artist",
        limit: 100,
        startIndex: SONOS_MAX_SIGNED_INT,
      },
    ],
  ] as const)("preserves empty page totals for %s", async (id, method, options) => {
    const dataMethod = vi.fn().mockResolvedValue({
      items: [],
      startIndex: SONOS_MAX_SIGNED_INT,
      totalRecordCount: 12,
    });
    const result = await new SonofinBrowseService().getMetadata(
      request({
        context: withJellyfin({ [method]: dataMethod }),
        count: "100",
        id,
        index: String(SONOS_MAX_SIGNED_INT),
      }),
    );

    expect(result).toEqual({
      index: SONOS_MAX_SIGNED_INT,
      items: [],
      total: 12,
    });
    expect(dataMethod).toHaveBeenCalledWith(options);
  });

  it.each([
    [0, 0],
    [12, 12],
    [SONOS_MAX_SIGNED_INT, 12],
  ] as const)(
    "preserves an empty album track page at index %s with total %s",
    async (index, totalRecordCount) => {
      const albumId = "empty-album";
      const getAlbumTracks = vi.fn().mockResolvedValue({
        items: [],
        startIndex: index,
        totalRecordCount,
      });
      const result = await new SonofinBrowseService().getMetadata(
        request({
          context: withJellyfin({ getAlbumTracks }),
          id: encodeSonosContentId({ kind: "album", value: albumId }),
          index: String(index),
        }),
      );

      expect(result).toEqual({ index, items: [], total: totalRecordCount });
      expect(getAlbumTracks).toHaveBeenCalledWith(albumId, {
        limit: 100,
        startIndex: index,
      });
    },
  );

  it.each([
    [0, 0],
    [12, 12],
    [SONOS_MAX_SIGNED_INT, 12],
  ] as const)(
    "preserves an empty playlist track page at index %s with total %s",
    async (index, totalRecordCount) => {
      const playlistId = "empty-playlist";
      const getPlaylistTracks = vi.fn().mockResolvedValue({
        items: [],
        startIndex: index,
        totalRecordCount,
      });
      const result = await new SonofinBrowseService().getMetadata(
        request({
          context: withJellyfin({ getPlaylistTracks }),
          id: encodeSonosContentId({ kind: "playlist", value: playlistId }),
          index: String(index),
        }),
      );

      expect(result).toEqual({ index, items: [], total: totalRecordCount });
      expect(getPlaylistTracks).toHaveBeenCalledWith(playlistId, {
        limit: 100,
        startIndex: index,
      });
    },
  );

  it.each([
    ["missing artist ID", { kind: "artist", name: "Named" }],
    ["missing artist name", { id: "artist-id", kind: "artist" }],
    ["blank artist name", { id: "artist-id", kind: "artist", name: " " }],
    [
      "unsafe artist name",
      { id: "artist-id", kind: "artist", name: "unsafe\u0000name" },
    ],
    [
      "artist name with a newline",
      { id: "artist-id", kind: "artist", name: "line\u2029break" },
    ],
    [
      "overlong artist name",
      {
        id: "artist-id",
        kind: "artist",
        name: "🎵".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS + 1),
      },
    ],
  ])("rejects a normalized page with %s", async (_name, item) => {
    const getArtists = vi.fn().mockResolvedValue({
      items: [item],
      startIndex: 0,
      totalRecordCount: 1,
    });

    await expect(
      new SonofinBrowseService().getMetadata(
        request({ context: withJellyfin({ getArtists }), id: "artists" }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_server_response",
      name: "JellyfinClientError",
    });
  });

  it.each([
    ["missing album ID", { artists: [], kind: "album", name: "Named" }],
    ["missing album name", { artists: [], id: "album-id", kind: "album" }],
    [
      "album name with a carriage return",
      { artists: [], id: "album-id", kind: "album", name: "line\rbreak" },
    ],
    [
      "overlong album name",
      {
        artists: [],
        id: "album-id",
        kind: "album",
        name: "x".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS + 1),
      },
    ],
  ])("rejects a normalized page with %s", async (_name, item) => {
    const getAlbums = vi.fn().mockResolvedValue({
      items: [item],
      startIndex: 0,
      totalRecordCount: 1,
    });

    await expect(
      new SonofinBrowseService().getMetadata(
        request({
          context: withJellyfin({ getAlbums }),
          id: encodeSonosContentId({ kind: "artist", value: "artist-id" }),
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_server_response",
      name: "JellyfinClientError",
    });
  });

  it.each([
    ["missing playlist ID", { childCount: 1, kind: "playlist", name: "Named" }],
    [
      "padded playlist ID",
      { childCount: 1, id: " playlist-id", kind: "playlist", name: "Named" },
    ],
    [
      "overlong playlist ID",
      {
        childCount: 1,
        id: "x".repeat(255),
        kind: "playlist",
        name: "Named",
      },
    ],
    ["missing playlist name", { id: "playlist-id", kind: "playlist" }],
    [
      "blank playlist name",
      { id: "playlist-id", kind: "playlist", name: " " },
    ],
    [
      "unsafe playlist name",
      { id: "playlist-id", kind: "playlist", name: "unsafe\u0000name" },
    ],
    [
      "playlist name with a newline",
      { id: "playlist-id", kind: "playlist", name: "line\u2028break" },
    ],
    [
      "overlong playlist name",
      {
        id: "playlist-id",
        kind: "playlist",
        name: "x".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS + 1),
      },
    ],
  ])("rejects a normalized page with %s", async (_name, item) => {
    const getPlaylists = vi.fn().mockResolvedValue({
      items: [item],
      startIndex: 0,
      totalRecordCount: 1,
    });

    await expect(
      new SonofinBrowseService().getMetadata(
        request({ context: withJellyfin({ getPlaylists }), id: "playlists" }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_server_response",
      name: "JellyfinClientError",
    });
  });

  it.each([
    [
      "a deleted item without a catalog ID",
      { artists: [], container: "mp3", kind: "track", name: "Deleted" },
    ],
    [
      "an unsupported item kind",
      {
        artists: [],
        container: "mp3",
        id: "video-id",
        kind: "unknown",
        name: "Video",
      },
    ],
    [
      "a track without a supported container",
      {
        artists: [],
        container: "wav",
        id: "track-id",
        kind: "track",
        name: "Unknown format",
      },
    ],
  ])("rejects a playlist page containing %s", async (_name, item) => {
    const getPlaylistTracks = vi.fn().mockResolvedValue({
      items: [item],
      startIndex: 0,
      totalRecordCount: 1,
    });

    await expect(
      new SonofinBrowseService().getMetadata(
        request({
          context: withJellyfin({ getPlaylistTracks }),
          id: encodeSonosContentId({
            kind: "playlist",
            value: "playlist-id",
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_server_response",
      name: "JellyfinClientError",
    });
  });

  it.each([
    "item_not_found",
    "token_invalid",
    "server_rejected",
    "server_unreachable",
  ] as const)(
    "preserves Jellyfin %s failures from artist-album browsing",
    async (code) => {
      const failure = new JellyfinClientError(code);
      const getAlbums = vi.fn().mockRejectedValue(failure);

      await expect(
        new SonofinBrowseService().getMetadata(
          request({
            context: withJellyfin({ getAlbums }),
            id: encodeSonosContentId({ kind: "artist", value: "artist-id" }),
          }),
        ),
      ).rejects.toBe(failure);
    },
  );

  it.each([
    "item_not_found",
    "token_invalid",
    "server_rejected",
    "server_unreachable",
  ] as const)(
    "preserves Jellyfin %s failures from album-track browsing",
    async (code) => {
      const failure = new JellyfinClientError(code);
      const getAlbumTracks = vi.fn().mockRejectedValue(failure);

      await expect(
        new SonofinBrowseService().getMetadata(
          request({
            context: withJellyfin({ getAlbumTracks }),
            id: encodeSonosContentId({
              kind: "album",
              value: "album-id",
            }),
          }),
        ),
      ).rejects.toBe(failure);
    },
  );

  it.each([
    "item_not_found",
    "token_invalid",
    "server_rejected",
    "server_unreachable",
  ] as const)(
    "preserves Jellyfin %s failures from playlist browsing",
    async (code) => {
      const failure = new JellyfinClientError(code);
      const getPlaylists = vi.fn().mockRejectedValue(failure);

      await expect(
        new SonofinBrowseService().getMetadata(
          request({
            context: withJellyfin({ getPlaylists }),
            id: "playlists",
          }),
        ),
      ).rejects.toBe(failure);
    },
  );

  it.each([
    "item_not_found",
    "token_invalid",
    "server_rejected",
    "server_unreachable",
  ] as const)(
    "preserves Jellyfin %s failures from playlist-track browsing",
    async (code) => {
      const failure = new JellyfinClientError(code);
      const getPlaylistTracks = vi.fn().mockRejectedValue(failure);

      await expect(
        new SonofinBrowseService().getMetadata(
          request({
            context: withJellyfin({ getPlaylistTracks }),
            id: encodeSonosContentId({
              kind: "playlist",
              value: "playlist-id",
            }),
          }),
        ),
      ).rejects.toBe(failure);
    },
  );
});
