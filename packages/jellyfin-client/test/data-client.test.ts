import { describe, expect, it } from "vitest";

import {
  JellyfinApiClient,
  JellyfinClientError,
  type JellyfinClientErrorCode,
  type JellyfinDataConnection,
  type JellyfinSearchOptions,
} from "../src";

const CONNECTION: JellyfinDataConnection = {
  serverUrl: "https://media.example.com/jellyfin",
  serverId: "server-id",
  userId: "user-id",
  deviceId: "device-id",
  accessToken: "access-token",
};

const AUTHORIZATION =
  'MediaBrowser Client="Sonofin", Device="Cloudflare Worker", ' +
  'DeviceId="device-id", Version="0.0.0", Token="access-token"';

const SONOS_PLAYBACK_BODY = {
  UserId: "user-id",
  MaxStreamingBitrate: 8_000_000,
  MaxAudioChannels: 2,
  EnableDirectPlay: true,
  EnableDirectStream: false,
  EnableTranscoding: true,
  AllowVideoStreamCopy: false,
  AllowAudioStreamCopy: false,
  DeviceProfile: {
    Name: "Sonofin Sonos",
    MaxStreamingBitrate: 8_000_000,
    MaxStaticBitrate: 8_000_000,
    MaxStaticMusicBitrate: 8_000_000,
    MusicStreamingTranscodingBitrate: 320_000,
    DirectPlayProfiles: [
      { Container: "mp3", AudioCodec: "mp3", Type: "Audio" },
      { Container: "aac", AudioCodec: "aac", Type: "Audio" },
      { Container: "m4a,mp4", AudioCodec: "aac", Type: "Audio" },
      { Container: "flac", AudioCodec: "flac", Type: "Audio" },
    ],
    TranscodingProfiles: [
      {
        Container: "mp3",
        AudioCodec: "mp3",
        Type: "Audio",
        Protocol: "http",
        Context: "Streaming",
        MaxAudioChannels: "2",
        EstimateContentLength: true,
        EnableAudioVbrEncoding: false,
      },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      {
        Type: "Audio",
        Codec: "mp3",
        Container: "mp3",
        Conditions: [
          {
            Condition: "LessThanEqual",
            Property: "AudioChannels",
            Value: "2",
            IsRequired: true,
          },
          {
            Condition: "LessThanEqual",
            Property: "AudioSampleRate",
            Value: "48000",
            IsRequired: true,
          },
        ],
        ApplyConditions: [],
      },
      {
        Type: "Audio",
        Codec: "aac",
        Container: "aac,m4a,mp4",
        Conditions: [
          {
            Condition: "LessThanEqual",
            Property: "AudioChannels",
            Value: "2",
            IsRequired: true,
          },
          {
            Condition: "LessThanEqual",
            Property: "AudioSampleRate",
            Value: "48000",
            IsRequired: true,
          },
        ],
        ApplyConditions: [],
      },
      {
        Type: "Audio",
        Codec: "flac",
        Container: "flac",
        Conditions: [
          {
            Condition: "LessThanEqual",
            Property: "AudioChannels",
            Value: "2",
            IsRequired: true,
          },
          {
            Condition: "LessThanEqual",
            Property: "AudioSampleRate",
            Value: "48000",
            IsRequired: true,
          },
          {
            Condition: "LessThanEqual",
            Property: "AudioBitDepth",
            Value: "16",
            IsRequired: true,
          },
        ],
        ApplyConditions: [],
      },
    ],
    SubtitleProfiles: [],
  },
} as const;

const COMMON_PAGE_QUERY = {
  userId: "user-id",
  startIndex: "5",
  limit: "25",
  fields: "SortName,ParentId,PrimaryImageAspectRatio",
  enableImages: "true",
  imageTypeLimit: "1",
  enableImageTypes: "Primary",
  enableTotalRecordCount: "true",
};

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

type FetchScript =
  | Response
  | Error
  | ((
      url: string,
      init: RequestInit | undefined,
    ) => Response | Promise<Response>);

function scriptedFetch(...scripts: FetchScript[]): {
  calls: FetchCall[];
  fetch: typeof globalThis.fetch;
} {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const script = scripts[index];
    index += 1;
    if (script === undefined) {
      throw new Error("Unexpected fetch call");
    }
    if (script instanceof Error) {
      throw script;
    }
    return typeof script === "function" ? script(url, init) : script;
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders,
  });
}

function page(...items: unknown[]): Record<string, unknown> {
  return {
    Items: items,
    StartIndex: 5,
    TotalRecordCount: 40,
  };
}

async function expectErrorCode(
  promise: Promise<unknown>,
  code: JellyfinClientErrorCode,
): Promise<JellyfinClientError> {
  const caught = await promise.catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(JellyfinClientError);
  expect(caught).toMatchObject({ code, name: "JellyfinClientError" });
  return caught as JellyfinClientError;
}

function headersOf(call: FetchCall | undefined): Headers {
  expect(call).toBeDefined();
  return new Headers(call?.init?.headers);
}

function expectGetRequest(
  call: FetchCall | undefined,
  pathname: string,
  query: Readonly<Record<string, string>>,
): void {
  expect(call).toBeDefined();
  const url = new URL(call?.url ?? "https://invalid.example");
  expect(url.origin).toBe("https://media.example.com");
  expect(url.pathname).toBe(`/jellyfin${pathname}`);
  expect([...url.searchParams.keys()].sort()).toEqual(
    Object.keys(query).sort(),
  );
  for (const [key, value] of Object.entries(query)) {
    expect(url.searchParams.get(key), key).toBe(value);
  }
  expect(url.toString()).not.toContain(CONNECTION.accessToken);

  expect(call?.init).toMatchObject({
    method: "GET",
    redirect: "manual",
  });
  expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
  expect(call?.init?.body).toBeUndefined();
  const headers = headersOf(call);
  expect(headers.get("accept")).toBe("application/json");
  expect(headers.get("authorization")).toBe(AUTHORIZATION);
  expect(headers.has("content-type")).toBe(false);
}

function expectPostRequest(
  call: FetchCall | undefined,
  pathname: string,
  body: unknown,
): void {
  expect(call).toBeDefined();
  const url = new URL(call?.url ?? "https://invalid.example");
  expect(url.origin).toBe("https://media.example.com");
  expect(url.pathname).toBe(`/jellyfin${pathname}`);
  expect([...url.searchParams.keys()]).toEqual([]);
  expect(url.toString()).not.toContain(CONNECTION.accessToken);

  expect(call?.init).toMatchObject({
    method: "POST",
    redirect: "manual",
    body: JSON.stringify(body),
  });
  expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
  const headers = headersOf(call);
  expect(headers.get("accept")).toBe("application/json");
  expect(headers.get("authorization")).toBe(AUTHORIZATION);
  expect(headers.get("content-type")).toBe("application/json");
}

describe("JellyfinApiClient official request contracts", () => {
  it("gets authenticated server information and verifies its connection identity", async () => {
    const transport = scriptedFetch(
      jsonResponse({
        Id: "server-id",
        ProductName: "Jellyfin Server",
        ServerName: "Living Room",
        Version: "10.11.0",
        OperatingSystem: "Linux",
        LocalAddress: "http://192.0.2.1:8096",
        StartupWizardCompleted: true,
      }),
    );
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    await expect(client.getServerInfo()).resolves.toEqual({
      serverUrl: "https://media.example.com/jellyfin",
      serverId: "server-id",
      serverName: "Living Room",
      serverVersion: "10.11.0",
      productName: "Jellyfin Server",
      operatingSystem: "Linux",
      localAddress: "http://192.0.2.1:8096",
      startupWizardCompleted: true,
    });
    expectGetRequest(transport.calls[0], "/System/Info", {});
  });

  it("gets current user views with no unsupported paging query", async () => {
    const connection = {
      ...CONNECTION,
      userId: "user/id β",
    };
    const transport = scriptedFetch(
      jsonResponse({
        Items: [
          {
            Id: "library-id",
            Name: "Music",
            Type: "CollectionFolder",
            CollectionType: "music",
            SortName: "Music",
            ImageTags: { Primary: "library-image" },
          },
          {
            Id: "movies-id",
            Name: "Movies",
            Type: "CollectionFolder",
            CollectionType: "movies",
          },
        ],
        StartIndex: 0,
        TotalRecordCount: 2,
      }),
    );
    const client = new JellyfinApiClient({
      connection,
      fetch: transport.fetch,
    });

    await expect(client.getUserLibraries()).resolves.toEqual({
      items: [
        {
          id: "library-id",
          name: "Music",
          kind: "library",
          collectionType: "music",
          sortName: "Music",
          primaryImageTag: "library-image",
        },
      ],
      startIndex: 0,
      totalRecordCount: 1,
    });

    expectGetRequest(transport.calls[0], "/UserViews", {
      userId: "user/id β",
      includeExternalContent: "false",
      includeHidden: "false",
    });
  });

  it("gets an artist page scoped to a library", async () => {
    const transport = scriptedFetch(
      jsonResponse(
        page({
          Id: "artist-id",
          Name: "Björk",
          Type: "MusicArtist",
          SortName: "Bjork",
          ParentId: "library-id",
          MediaType: "Unknown",
          IsFolder: true,
          Overview: "Artist overview",
          ProductionYear: 1993,
          RunTimeTicks: 12_340_000,
          PrimaryImageAspectRatio: 1.5,
          ImageTags: { Primary: "artist-image" },
        }),
      ),
    );
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    await expect(
      client.getArtists({
        libraryId: "library/id",
        startIndex: 5,
        limit: 25,
      }),
    ).resolves.toEqual({
      items: [
        {
          id: "artist-id",
          name: "Björk",
          kind: "artist",
          sortName: "Bjork",
          parentId: "library-id",
          mediaType: "Unknown",
          isFolder: true,
          overview: "Artist overview",
          productionYear: 1993,
          durationMs: 1_234,
          primaryImageTag: "artist-image",
          primaryImageAspectRatio: 1.5,
        },
      ],
      startIndex: 5,
      totalRecordCount: 40,
    });
    expectGetRequest(transport.calls[0], "/Artists/AlbumArtists", {
      ...COMMON_PAGE_QUERY,
      parentId: "library/id",
      sortBy: "SortName",
      sortOrder: "Ascending",
    });
  });

  it("gets albums with library and album-artist filters", async () => {
    const transport = scriptedFetch(
      jsonResponse(
        page({
          Id: "album-id",
          Name: "Homogenic",
          Type: "MusicAlbum",
          AlbumPrimaryImageTag: "album-image",
          ArtistItems: [
            { Id: "artist-id", Name: "Björk" },
            { Name: "Guest" },
          ],
        }),
      ),
    );
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    await expect(
      client.getAlbums({
        libraryId: "library/id",
        artistId: "artist/id",
        startIndex: 5,
        limit: 25,
      }),
    ).resolves.toEqual({
      items: [
        {
          id: "album-id",
          name: "Homogenic",
          kind: "album",
          albumPrimaryImageTag: "album-image",
          artists: [
            { id: "artist-id", name: "Björk" },
            { name: "Guest" },
          ],
        },
      ],
      startIndex: 5,
      totalRecordCount: 40,
    });
    expectGetRequest(transport.calls[0], "/Items", {
      ...COMMON_PAGE_QUERY,
      parentId: "library/id",
      albumArtistIds: "artist/id",
      includeItemTypes: "MusicAlbum",
      recursive: "true",
      sortBy: "AlbumArtist,SortName",
      sortOrder: "Ascending",
    });
  });

  it.each([
    [
      "album type",
      { Id: "album-id", Name: "Album", Type: "Audio" },
      "album_type",
    ],
    [
      "album id",
      { Name: "Album", Type: "MusicAlbum" },
      "album_id",
    ],
    [
      "optional album metadata",
      {
        Id: "album-id",
        Name: "Album",
        Type: "MusicAlbum",
        PrimaryImageAspectRatio: "wide",
      },
      "album_optional_metadata",
    ],
    [
      "album artists",
      {
        AlbumArtists: [{ Id: "artist-id" }],
        Id: "album-id",
        Name: "Album",
        Type: "MusicAlbum",
      },
      "album_artists",
    ],
  ] as const)("classifies malformed %s", async (_name, item, failure) => {
    const transport = scriptedFetch(jsonResponse(page(item)));
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    const error = await expectErrorCode(
      client.getAlbums(),
      "invalid_server_response",
    );

    expect(error.responseFailure).toBe(failure);
  });

  it.each([
    [undefined, "Fallback sort title", "Fallback sort title"],
    [null, undefined, "Unknown Album"],
    ["   ", undefined, "Unknown Album"],
  ] as const)(
    "normalizes an unusable album name %# with a safe fallback",
    async (name, sortName, expectedName) => {
      const item: Record<string, unknown> = {
        Id: "album-id",
        Name: name,
        SortName: sortName,
        Type: "MusicAlbum",
      };
      const transport = scriptedFetch(jsonResponse(page(item)));
      const client = new JellyfinApiClient({
        connection: CONNECTION,
        fetch: transport.fetch,
      });

      await expect(client.getAlbums()).resolves.toMatchObject({
        items: [{ id: "album-id", kind: "album", name: expectedName }],
      });
    },
  );

  it.each([
    [{}, "page_shape"],
    [
      { Items: [null], StartIndex: 5, TotalRecordCount: 40 },
      "page_item_shape",
    ],
  ] as const)("classifies malformed album page %#", async (payload, failure) => {
    const transport = scriptedFetch(jsonResponse(payload));
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    const error = await expectErrorCode(
      client.getAlbums(),
      "invalid_server_response",
    );

    expect(error.responseFailure).toBe(failure);
  });

  it("gets album tracks in disc and track order while encoding the album ID", async () => {
    const transport = scriptedFetch(
      jsonResponse(
        page({
          Id: "track-id",
          Name: "Jóga",
          Type: "Audio",
          AlbumId: "album/id β",
          Album: "Homogenic",
          ArtistItems: [{ Id: "artist-id", Name: "Björk" }],
          ParentIndexNumber: 2,
          IndexNumber: 3,
          Container: "flac",
          RunTimeTicks: 21_000_000,
        }),
      ),
    );
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    await expect(
      client.getAlbumTracks("album/id β", { startIndex: 5, limit: 25 }),
    ).resolves.toEqual({
      items: [
        {
          id: "track-id",
          name: "Jóga",
          kind: "track",
          albumId: "album/id β",
          albumName: "Homogenic",
          artists: [{ id: "artist-id", name: "Björk" }],
          discNumber: 2,
          trackNumber: 3,
          container: "flac",
          durationMs: 2_100,
        },
      ],
      startIndex: 5,
      totalRecordCount: 40,
    });
    expectGetRequest(transport.calls[0], "/Items", {
      ...COMMON_PAGE_QUERY,
      albumIds: "album/id β",
      includeItemTypes: "Audio",
      recursive: "true",
      sortBy: "ParentIndexNumber,IndexNumber,SortName",
      sortOrder: "Ascending",
    });
  });

  it("gets playlists from an optional library scope", async () => {
    const transport = scriptedFetch(
      jsonResponse(
        page({
          Id: "playlist-id",
          Name: "Morning",
          Type: "Playlist",
          ChildCount: 12,
          ImageTags: { Primary: "playlist-image" },
        }),
      ),
    );
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    await expect(
      client.getPlaylists({
        libraryId: "library/id",
        startIndex: 5,
        limit: 25,
      }),
    ).resolves.toEqual({
      items: [
        {
          id: "playlist-id",
          name: "Morning",
          kind: "playlist",
          childCount: 12,
          primaryImageTag: "playlist-image",
        },
      ],
      startIndex: 5,
      totalRecordCount: 40,
    });
    expectGetRequest(transport.calls[0], "/Items", {
      ...COMMON_PAGE_QUERY,
      parentId: "library/id",
      includeItemTypes: "Playlist",
      mediaTypes: "Audio",
      recursive: "true",
      sortBy: "SortName",
      sortOrder: "Ascending",
    });
  });

  it("preserves Jellyfin playlist order and avoids unsupported total-count parameters", async () => {
    const transport = scriptedFetch(
      jsonResponse(
        page(
          {
            Id: "track-2",
            PlaylistItemId: "entry-1",
            Name: "Second in album, first in playlist",
            Type: "Audio",
            IndexNumber: 2,
            ArtistItems: [],
          },
          {
            Id: "track-1",
            PlaylistItemId: "entry-2",
            Name: "First in album, second in playlist",
            Type: "Audio",
            IndexNumber: 1,
            ArtistItems: [],
          },
        ),
      ),
    );
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    const result = await client.getPlaylistTracks("playlist/id β", {
      startIndex: 5,
      limit: 25,
    });
    expect(result.items.map((item) => item.id)).toEqual(["track-2", "track-1"]);
    expect(result.items.map((item) => item.playlistItemId)).toEqual([
      "entry-1",
      "entry-2",
    ]);
    expect(result.items.every((item) => item.kind === "track")).toBe(true);
    expectGetRequest(
      transport.calls[0],
      "/Playlists/playlist%2Fid%20%CE%B2/Items",
      {
        userId: "user-id",
        startIndex: "5",
        limit: "25",
        fields: "SortName,ParentId,PrimaryImageAspectRatio",
        enableImages: "true",
        imageTypeLimit: "1",
        enableImageTypes: "Primary",
      },
    );
  });

  it.each([
    [
      "artist",
      "MusicArtist",
      "/Artists",
      {
        Id: "artist-id",
        Name: "Artist",
        Type: "MusicArtist",
        IsFolder: true,
        PrimaryImageAspectRatio: 1,
      },
      {
        id: "artist-id",
        name: "Artist",
        kind: "artist",
        isFolder: true,
        primaryImageAspectRatio: 1,
      },
    ],
    [
      "album",
      "MusicAlbum",
      "/Items",
      {
        Id: "album-id",
        Name: "Album",
        Type: "MusicAlbum",
        AlbumArtists: [{ Id: "artist-id", Name: "Artist" }],
      },
      {
        id: "album-id",
        name: "Album",
        kind: "album",
        artists: [{ id: "artist-id", name: "Artist" }],
      },
    ],
    [
      "track",
      "Audio",
      "/Items",
      {
        Id: "track-id",
        Name: "Track",
        Type: "Audio",
        ArtistItems: [{ Id: "artist-id", Name: "Artist" }],
      },
      {
        id: "track-id",
        name: "Track",
        kind: "track",
        artists: [{ id: "artist-id", name: "Artist" }],
      },
    ],
    [
      "playlist",
      "Playlist",
      "/Items",
      { Id: "playlist-id", Name: "Playlist", Type: "Playlist" },
      {
        id: "playlist-id",
        name: "Playlist",
        kind: "playlist",
      },
    ],
  ] as const)(
    "searches only the %s category with a URL-encoded term and library scope",
    async (category, itemType, pathname, item, expected) => {
      const transport = scriptedFetch(jsonResponse(page(item)));
      const client = new JellyfinApiClient({
        connection: CONNECTION,
        fetch: transport.fetch,
      });

      await expect(
        client.search("Björk & 100%", {
          category,
          libraryId: "library/id",
          startIndex: 5,
          limit: 25,
        }),
      ).resolves.toEqual({
        items: [expected],
        startIndex: 5,
        totalRecordCount: 40,
      });
      expectGetRequest(transport.calls[0], pathname, {
        ...COMMON_PAGE_QUERY,
        parentId: "library/id",
        searchTerm: "Björk & 100%",
        sortBy: "SortName",
        sortOrder: "Ascending",
        ...(category === "artist"
          ? {}
          : {
              includeItemTypes: itemType,
              ...(category === "playlist" ? { mediaTypes: "Audio" } : {}),
              recursive: "true",
            }),
      });
    },
  );

  it("gets metadata for an encoded item ID and retains an unknown Jellyfin kind", async () => {
    const transport = scriptedFetch(
      jsonResponse({
        Id: "movie/id β",
        Name: "Unexpected video",
        Type: "Movie",
        SortName: "Unexpected video",
        Overview: "Metadata can represent non-music items safely.",
      }),
    );
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    await expect(client.getItemMetadata("movie/id β")).resolves.toEqual({
      id: "movie/id β",
      name: "Unexpected video",
      kind: "unknown",
      jellyfinType: "Movie",
      sortName: "Unexpected video",
      overview: "Metadata can represent non-music items safely.",
    });
    expectGetRequest(
      transport.calls[0],
      "/Items/movie%2Fid%20%CE%B2",
      { userId: "user-id" },
    );
  });

  it("normalizes playback media sources and audio streams", async () => {
    const transport = scriptedFetch(
      jsonResponse({
        PlaySessionId: "play-session-id",
        ErrorCode: "NoCompatibleStream",
        MediaSources: [
          {
            Id: "source-id",
            Name: "Original",
            Protocol: "File",
            Container: "flac",
            Size: 123_456,
            Bitrate: 987_654,
            RunTimeTicks: 30_000_000,
            SupportsDirectPlay: true,
            SupportsDirectStream: false,
            SupportsTranscoding: true,
            TranscodingUrl: "/Audio/item/transcode",
            TranscodingSubProtocol: "http",
            TranscodingContainer: "mp3",
            DefaultAudioStreamIndex: 0,
            RequiredHttpHeaders: { "X-Media-Token": "header-value" },
            MediaStreams: [
              {
                Index: 0,
                Type: "Audio",
                Codec: "flac",
                Profile: "24-bit",
                Language: "eng",
                DisplayTitle: "English FLAC Stereo",
                Channels: 2,
                ChannelLayout: "stereo",
                SampleRate: 96_000,
                BitRate: 2_304_000,
                BitDepth: 24,
                IsDefault: true,
              },
              { Index: 1, Type: "Subtitle", IsDefault: false },
            ],
          },
        ],
      }),
    );
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    await expect(client.getPlaybackInfo("track/id β")).resolves.toEqual({
      playSessionId: "play-session-id",
      errorCode: "NoCompatibleStream",
      mediaSources: [
        {
          id: "source-id",
          name: "Original",
          protocol: "File",
          container: "flac",
          sizeBytes: 123_456,
          bitrate: 987_654,
          durationMs: 3_000,
          supportsDirectPlay: true,
          supportsDirectStream: false,
          supportsTranscoding: true,
          transcodingUrl: "/Audio/item/transcode",
          transcodingSubProtocol: "http",
          transcodingContainer: "mp3",
          defaultAudioStreamIndex: 0,
          requiredHttpHeaders: { "X-Media-Token": "header-value" },
          audioStreams: [
            {
              index: 0,
              codec: "flac",
              profile: "24-bit",
              language: "eng",
              displayTitle: "English FLAC Stereo",
              channels: 2,
              channelLayout: "stereo",
              sampleRate: 96_000,
              bitrate: 2_304_000,
              bitDepth: 24,
              isDefault: true,
            },
          ],
        },
      ],
    });
    expectPostRequest(
      transport.calls[0],
      "/Items/track%2Fid%20%CE%B2/PlaybackInfo",
      SONOS_PLAYBACK_BODY,
    );
  });

  it("uses bounded default pages when callers omit options", async () => {
    const transport = scriptedFetch(jsonResponse(page()));
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    await client.getArtists();

    expectGetRequest(transport.calls[0], "/Artists/AlbumArtists", {
      userId: "user-id",
      startIndex: "0",
      limit: "100",
      fields: "SortName,ParentId,PrimaryImageAspectRatio",
      enableImages: "true",
      imageTypeLimit: "1",
      enableImageTypes: "Primary",
      enableTotalRecordCount: "true",
      sortBy: "SortName",
      sortOrder: "Ascending",
    });
  });
});

describe("JellyfinApiClient validation and safe failures", () => {
  it("validates page bounds and filters before contacting Jellyfin", async () => {
    const transport = scriptedFetch();
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });
    const invalidCalls = [
      client.getArtists({ startIndex: -1 }),
      client.getAlbums({ limit: 0 }),
      client.getAlbumTracks("album-id", { startIndex: 1.5 }),
      client.getPlaylists({ limit: 501 }),
      client.getPlaylistTracks("playlist-id", {
        startIndex: Number.MAX_SAFE_INTEGER + 1,
      }),
      client.search("term", { category: "artist", limit: Number.NaN }),
      client.getAlbums({ libraryId: "" }),
      client.getAlbums({ artistId: "   " }),
    ];

    for (const call of invalidCalls) {
      await expectErrorCode(call, "invalid_input");
    }
    expect(transport.calls).toHaveLength(0);
  });

  it("validates required IDs and search terms before contacting Jellyfin", async () => {
    const transport = scriptedFetch();
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });
    const malformedUnicode = String.fromCharCode(0xd800);
    const invalidCalls = [
      client.getAlbumTracks(""),
      client.getPlaylistTracks("   "),
      client.getItemMetadata(malformedUnicode),
      client.getPlaybackInfo(""),
      client.search("", { category: "artist" }),
      client.search("   ", { category: "artist" }),
      client.search(malformedUnicode, { category: "artist" }),
      client.search("x".repeat(513), { category: "artist" }),
    ];

    for (const call of invalidCalls) {
      await expectErrorCode(call, "invalid_input");
    }
    expect(transport.calls).toHaveLength(0);
  });

  it("requires an allow-listed Sonofin search category before contacting Jellyfin", async () => {
    const transport = scriptedFetch();
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });
    const invalidOptions = [
      undefined,
      {},
      { category: "MusicArtist" },
      { category: "artists" },
      { category: "constructor" },
    ];

    for (const options of invalidOptions) {
      await expectErrorCode(
        client.search("term", options as JellyfinSearchOptions),
        "invalid_input",
      );
    }
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects a search result outside the requested category", async () => {
    const transport = scriptedFetch(
      jsonResponse(
        page({ Id: "album-id", Name: "Album", Type: "MusicAlbum" }),
      ),
    );
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    await expectErrorCode(
      client.search("term", { category: "artist" }),
      "invalid_server_response",
    );
  });

  it.each([
    {},
    { Items: {}, StartIndex: 0, TotalRecordCount: 0 },
    { Items: [], StartIndex: -1, TotalRecordCount: 0 },
    { Items: [], StartIndex: 0, TotalRecordCount: -1 },
    { Items: [], StartIndex: 0.5, TotalRecordCount: 0 },
    { Items: [], StartIndex: 0, TotalRecordCount: Number.MAX_SAFE_INTEGER + 1 },
    {
      Items: [{ Id: "", Name: "Artist", Type: "MusicArtist" }],
      StartIndex: 0,
      TotalRecordCount: 1,
    },
    {
      Items: [{ Id: "artist-id", Type: "MusicArtist" }],
      StartIndex: 0,
      TotalRecordCount: 1,
    },
  ])("rejects a malformed page response %#", async (payload) => {
    const transport = scriptedFetch(jsonResponse(payload));
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    await expectErrorCode(client.getArtists(), "invalid_server_response");
  });

  it.each([
    {},
    { MediaSources: {} },
    { MediaSources: [{ Id: "source-id", MediaStreams: {} }] },
    { MediaSources: [{ MediaStreams: [] }] },
    {
      MediaSources: [
        {
          Id: "source-id",
          MediaStreams: [{ Type: "Audio", IsDefault: true }],
        },
      ],
    },
  ])("rejects malformed playback response %#", async (payload) => {
    const transport = scriptedFetch(jsonResponse(payload));
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    await expectErrorCode(
      client.getPlaybackInfo("track-id"),
      "invalid_server_response",
    );
  });

  it("discards malformed playback sources without losing a valid candidate", async () => {
    const transport = scriptedFetch(
      jsonResponse({
        MediaSources: [
          { Id: "broken-source", MediaStreams: {} },
          {
            Id: "valid-source",
            Protocol: "File",
            Container: "mp3",
            SupportsDirectPlay: true,
            MediaStreams: [
              {
                Index: 0,
                Type: "Audio",
                Codec: "mp3",
                Channels: 2,
                SampleRate: 44_100,
              },
            ],
          },
        ],
      }),
    );
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    await expect(client.getPlaybackInfo("track-id")).resolves.toEqual({
      mediaSources: [
        {
          id: "valid-source",
          protocol: "File",
          container: "mp3",
          supportsDirectPlay: true,
          supportsDirectStream: false,
          supportsTranscoding: false,
          audioStreams: [
            {
              index: 0,
              codec: "mp3",
              channels: 2,
              sampleRate: 44_100,
              isDefault: false,
            },
          ],
        },
      ],
    });
  });

  it("rejects server identity changes and non-Jellyfin products", async () => {
    for (const payload of [
      {
        Id: "different-server",
        ProductName: "Jellyfin Server",
        ServerName: "name",
        Version: "10.11.0",
      },
      {
        Id: "server-id",
        ProductName: "Other Server",
        ServerName: "name",
        Version: "10.11.0",
      },
    ]) {
      const transport = scriptedFetch(jsonResponse(payload));
      const client = new JellyfinApiClient({
        connection: CONNECTION,
        fetch: transport.fetch,
      });
      await expectErrorCode(client.getServerInfo(), "invalid_server_response");
    }
  });

  it.each([
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 1.5 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: Number.NaN },
  ])("rejects invalid transport bounds at construction", (options) => {
    expect(
      () => new JellyfinApiClient({ connection: CONNECTION, ...options }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("requires HTTPS unless insecure HTTP is explicitly enabled", async () => {
    const connection = {
      ...CONNECTION,
      serverUrl: "http://media.example.com:8096/jellyfin/",
    };
    expect(() => new JellyfinApiClient({ connection })).toThrowError(
      expect.objectContaining({ code: "insecure_url" }),
    );

    const transport = scriptedFetch(
      jsonResponse({
        Id: "server-id",
        ProductName: "Jellyfin Server",
        ServerName: "name",
        Version: "version",
      }),
    );
    const client = new JellyfinApiClient({
      connection,
      fetch: transport.fetch,
      allowInsecureHttp: true,
    });
    await client.getServerInfo();
    expect(transport.calls[0]?.url).toBe(
      "http://media.example.com:8096/jellyfin/System/Info",
    );
  });

  it.each([
    ["server information", (client: JellyfinApiClient) => client.getServerInfo(), false],
    ["user libraries", (client: JellyfinApiClient) => client.getUserLibraries(), false],
    ["artists", (client: JellyfinApiClient) => client.getArtists(), false],
    ["albums", (client: JellyfinApiClient) => client.getAlbums(), false],
    ["album tracks", (client: JellyfinApiClient) => client.getAlbumTracks("album-id"), true],
    ["playlists", (client: JellyfinApiClient) => client.getPlaylists(), false],
    [
      "playlist tracks",
      (client: JellyfinApiClient) => client.getPlaylistTracks("playlist-id"),
      true,
    ],
    [
      "search",
      (client: JellyfinApiClient) =>
        client.search("term", { category: "artist" }),
      false,
    ],
    ["item metadata", (client: JellyfinApiClient) => client.getItemMetadata("item-id"), true],
    ["playback", (client: JellyfinApiClient) => client.getPlaybackInfo("item-id"), true],
  ] as const)(
    "maps protected status responses for %s",
    async (_name, invoke, hasRequiredItemId) => {
      for (const [status, code] of [
        [401, "token_invalid"],
        [403, "token_invalid"],
        [404, hasRequiredItemId ? "item_not_found" : "server_rejected"],
        [302, "server_rejected"],
        [429, "server_rejected"],
        [500, "server_rejected"],
      ] as const) {
        const transport = scriptedFetch(
          new Response("untrusted response body", {
            status,
            headers: { location: "https://redirect.example.test" },
          }),
        );
        const client = new JellyfinApiClient({
          connection: CONNECTION,
          fetch: transport.fetch,
        });

        await expectErrorCode(invoke(client), code);
        expect(transport.calls).toHaveLength(1);
        expect(transport.calls[0]?.init?.redirect).toBe("manual");
      }
    },
  );

  it("enforces a finite deadline even if fetch ignores abort", async () => {
    const fetch = (() =>
      new Promise<Response>(() => {})) as typeof globalThis.fetch;
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch,
      requestTimeoutMs: 5,
    });

    await expectErrorCode(client.getArtists(), "server_unreachable");
  });

  it("keeps the deadline active while reading a response body", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
    });
    const transport = scriptedFetch(new Response(body, { status: 200 }));
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
      requestTimeoutMs: 5,
    });

    await expectErrorCode(client.getArtists(), "server_unreachable");
  });

  it("rejects declared and streamed responses beyond the configured byte bound", async () => {
    const declaredTransport = scriptedFetch(
      jsonResponse(page(), 200, { "content-length": "1000" }),
    );
    const declaredClient = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: declaredTransport.fetch,
      maxResponseBytes: 128,
    });
    const declaredError = await expectErrorCode(
      declaredClient.getArtists(),
      "invalid_server_response",
    );
    expect(declaredError.responseFailure).toBe("body_too_large");

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
        controller.close();
      },
    });
    const streamedTransport = scriptedFetch(new Response(body, { status: 200 }));
    const streamedClient = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: streamedTransport.fetch,
      maxResponseBytes: 64,
    });
    const streamedError = await expectErrorCode(
      streamedClient.getArtists(),
      "invalid_server_response",
    );
    expect(streamedError.responseFailure).toBe("body_too_large");
  });

  it("classifies an invalid response body without retaining its contents", async () => {
    const secretBody = "not-json-never-log-this-response";
    const transport = scriptedFetch(new Response(secretBody, { status: 200 }));
    const client = new JellyfinApiClient({
      connection: CONNECTION,
      fetch: transport.fetch,
    });

    const error = await expectErrorCode(
      client.getArtists(),
      "invalid_server_response",
    );
    const serialized =
      `${error.name} ${error.message} ${error.stack ?? ""} ` +
      JSON.stringify(error);

    expect(error.responseFailure).toBe("body_invalid");
    expect(serialized).not.toContain(secretBody);
  });

  it("keeps tokens, response bodies, and transport details out of errors and URLs", async () => {
    const token = "TOKEN-DO-NOT-LEAK";
    const transportSecret = "TRANSPORT-DO-NOT-LEAK";
    const connection = { ...CONNECTION, accessToken: token };
    const transport = scriptedFetch(
      new Error(`${token} ${transportSecret}`),
      new Response(`${token} ${transportSecret}`, { status: 500 }),
    );
    const client = new JellyfinApiClient({
      connection,
      fetch: transport.fetch,
    });

    const errors = [
      await expectErrorCode(client.getArtists(), "server_unreachable"),
      await expectErrorCode(client.getPlaybackInfo("track-id"), "server_rejected"),
    ];
    for (const call of transport.calls) {
      expect(call.url).not.toContain(token);
    }
    for (const error of errors) {
      const serialized = `${error.name} ${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(transportSecret);
    }
  });

  it("percent-encodes device and token authorization values", async () => {
    const connection = {
      ...CONNECTION,
      deviceId: 'device", Token="injected!',
      accessToken: 'tok"en, /!*\'()',
    };
    const transport = scriptedFetch(jsonResponse(page()));
    const client = new JellyfinApiClient({
      connection,
      fetch: transport.fetch,
    });

    await client.getArtists();

    expect(headersOf(transport.calls[0]).get("authorization")).toBe(
      'MediaBrowser Client="Sonofin", Device="Cloudflare Worker", ' +
        'DeviceId="device%22%2C%20Token%3D%22injected%21", ' +
        'Version="0.0.0", Token="tok%22en%2C%20%2F%21%2A%27%28%29"',
    );
  });
});
