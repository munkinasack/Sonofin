import { describe, expect, it, vi } from "vitest";

import {
  JellyfinClientError,
  type JellyfinDataClient,
  type JellyfinSearchResult,
} from "@sonofin/jellyfin-client";
import {
  decodeSonosContentId,
  encodeSonosContentId,
} from "@sonofin/sonos-smapi";

import {
  SmapiSearchError,
  SonofinSearchService,
  type SmapiAuthenticatedRequestContext,
  type SmapiSearchRequest,
} from "../src";

const sonosMapping = {
  householdId: "Sonos_Household_CaseSensitive",
  id: "a".repeat(64),
  jellyfinConnectionId: "J".repeat(32),
};

const connection: SmapiAuthenticatedRequestContext["connection"] = {
  accessToken: "synthetic-test-token",
  deviceId: "synthetic-test-device",
  serverId: "synthetic-test-server",
  serverName: "Test Jellyfin",
  serverUrl: "https://jellyfin.example.test",
  serverVersion: "10.11.11",
  userId: "synthetic-test-user",
  username: "test-user",
};

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
  jellyfin: Partial<JellyfinDataClient>,
  overrides: Partial<SmapiSearchRequest> = {},
): SmapiSearchRequest {
  return {
    context: context(jellyfin),
    count: "10",
    id: "artist",
    index: "0",
    term: "Björk & 東京",
    ...overrides,
  };
}

async function expectSearchError(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code: "invalid_parameters",
    message: "The SMAPI search request could not be completed",
    name: "SmapiSearchError",
  } satisfies Partial<SmapiSearchError>);
}

describe("SonofinSearchService", () => {
  it("maps every category with the same canonical IDs and metadata as browse", async () => {
    const fixtures = [
      {
        category: "artist" as const,
        item: {
          id: "artist-二",
          kind: "artist" as const,
          name: "Björk & 二",
        },
        expected: {
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: encodeSonosContentId({ kind: "artist", value: "artist-二" }),
          itemType: "artist",
          kind: "collection",
          title: "Björk & 二",
        },
      },
      {
        category: "album" as const,
        item: {
          artists: [{ id: "artist-二", name: "Björk & 二" }],
          id: "album-一",
          kind: "album" as const,
          name: "Álbum <一>",
        },
        expected: {
          artist: "Björk & 二",
          artistId: encodeSonosContentId({
            kind: "artist",
            value: "artist-二",
          }),
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: encodeSonosContentId({ kind: "album", value: "album-一" }),
          itemType: "album",
          kind: "collection",
          title: "Álbum <一>",
        },
      },
      {
        category: "track" as const,
        item: {
          albumId: "album-一",
          albumName: "Álbum <一>",
          artists: [{ id: "artist-二", name: "Björk & 二" }],
          container: "flac",
          durationMs: 181_999,
          id: "track-三",
          kind: "track" as const,
          name: "Söngur & 三",
          trackNumber: 4,
        },
        expected: {
          id: encodeSonosContentId({ kind: "track", value: "track-三" }),
          itemType: "track",
          kind: "track",
          mimeType: "audio/flac",
          title: "Söngur & 三",
          trackMetadata: {
            album: "Álbum <一>",
            albumId: encodeSonosContentId({
              kind: "album",
              value: "album-一",
            }),
            artist: "Björk & 二",
            artistId: encodeSonosContentId({
              kind: "artist",
              value: "artist-二",
            }),
            canAddToFavorites: false,
            canPlay: true,
            canResume: false,
            canSeek: false,
            canSkip: false,
            duration: 181,
            trackNumber: 4,
          },
        },
      },
      {
        category: "playlist" as const,
        item: {
          childCount: 12,
          id: "playlist-四",
          kind: "playlist" as const,
          name: "Mix & 四",
        },
        expected: {
          canAddToFavorites: false,
          canEnumerate: true,
          canPlay: false,
          canScroll: false,
          id: encodeSonosContentId({
            kind: "playlist",
            value: "playlist-四",
          }),
          itemType: "playlist",
          kind: "collection",
          title: "Mix & 四",
          total: 12,
        },
      },
    ];

    for (const fixture of fixtures) {
      const search = vi.fn().mockResolvedValue({
        items: [fixture.item],
        startIndex: 2,
        totalRecordCount: 9,
      });
      const result = await new SonofinSearchService().search(
        request({ search }, {
          count: "1",
          id: fixture.category,
          index: "2",
          term: "  Björk & 東京  ",
        }),
      );

      expect(search).toHaveBeenCalledWith("Björk & 東京", {
        category: fixture.category,
        limit: 1,
        startIndex: 2,
      });
      expect(result).toEqual({
        index: 2,
        items: [fixture.expected],
        total: 9,
      });
      const mapped = result.items[0];
      expect(mapped).toBeDefined();
      if (mapped !== undefined) {
        expect(decodeSonosContentId(mapped.id)).toMatchObject({
          kind: fixture.category,
          value: fixture.item.id,
        });
      }
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.items)).toBe(true);
      expect(result.items.every((item) => Object.isFrozen(item))).toBe(true);
    }
  });

  it("returns an empty out-of-range page with the accurate total", async () => {
    const search = vi.fn().mockResolvedValue({
      items: [],
      startIndex: 30,
      totalRecordCount: 4,
    });

    await expect(
      new SonofinSearchService().search(
        request({ search }, {
          count: "10",
          id: "playlist",
          index: "30",
        }),
      ),
    ).resolves.toEqual({ index: 30, items: [], total: 4 });
  });

  it.each([
    ["missing category", { id: undefined }],
    ["plural category", { id: "artists" }],
    ["unknown category", { id: "secret-category" }],
    ["missing term", { term: undefined }],
    ["empty term", { term: "" }],
    ["blank term", { term: "  \t " }],
    ["overlong term", { term: "🎵".repeat(513) }],
    ["malformed Unicode term", { term: "bad\ud800term" }],
    ["missing index", { index: undefined }],
    ["negative index", { index: "-1" }],
    ["non-canonical index", { index: "01" }],
    ["missing count", { count: undefined }],
    ["zero count", { count: "0" }],
    ["oversized count", { count: "101" }],
  ] as const)("rejects %s before calling Jellyfin", async (_name, overrides) => {
    const search = vi.fn();

    await expectSearchError(
      new SonofinSearchService().search(request({ search }, overrides)),
    );
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    {
      items: [{ id: "wrong-kind", kind: "album", name: "Wrong", artists: [] }],
      startIndex: 0,
      totalRecordCount: 1,
    },
    {
      items: [],
      startIndex: 1,
      totalRecordCount: 0,
    },
    {
      items: Array.from({ length: 11 }, (_, index) => ({
        id: `artist-${index}`,
        kind: "artist" as const,
        name: `Artist ${index}`,
      })),
      startIndex: 0,
      totalRecordCount: 11,
    },
  ])("rejects a malformed or category-inconsistent Jellyfin page %#", async (page) => {
    const search = vi.fn().mockResolvedValue(
      page as {
        items: JellyfinSearchResult[];
        startIndex: number;
        totalRecordCount: number;
      },
    );

    await expect(
      new SonofinSearchService().search(request({ search })),
    ).rejects.toMatchObject({
      code: "invalid_server_response",
      name: "JellyfinClientError",
    } satisfies Partial<JellyfinClientError>);
  });
});
