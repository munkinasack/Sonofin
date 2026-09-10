import { describe, expect, it, vi } from "vitest";

import {
  JellyfinClientError,
  type JellyfinDataClient,
  type JellyfinItemMetadata,
} from "@sonofin/jellyfin-client";
import { encodeSonosContentId } from "@sonofin/sonos-smapi";

import {
  SonofinExtendedMetadataService,
  type SmapiAuthenticatedRequestContext,
  type SmapiGetExtendedMetadataRequest,
} from "../src";

const sonosMapping = {
  householdId: "Sonos_Household_CaseSensitive",
  id: "a".repeat(64),
  jellyfinConnectionId: "J".repeat(32),
};

function context(
  methods: Partial<JellyfinDataClient>,
): SmapiAuthenticatedRequestContext {
  return {
    jellyfin: methods as JellyfinDataClient,
    sonosMapping,
  };
}

function request(
  id: string,
  methods: Partial<JellyfinDataClient> = {},
): SmapiGetExtendedMetadataRequest {
  return { context: context(methods), id };
}

describe("SonofinExtendedMetadataService", () => {
  it.each([
    ["root", "container", "Sonofin"],
    ["artists", "container", "Artists"],
    ["albums", "albumList", "Albums"],
    ["playlists", "container", "Playlists"],
    ["search", "container", "Search"],
    ["artist", "search", "Artists"],
    ["album", "search", "Albums"],
    ["track", "search", "Tracks"],
    ["playlist", "search", "Playlists"],
  ] as const)(
    "returns canonical static metadata for %s",
    async (id, itemType, title) => {
      const getItemMetadata = vi.fn();

      const result = await new SonofinExtendedMetadataService().getExtendedMetadata(
        request(id, { getItemMetadata }),
      );

      expect(result).toMatchObject({ id, itemType, kind: "collection", title });
      expect(getItemMetadata).not.toHaveBeenCalled();
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it.each([
    {
      item: { id: "artist-id", kind: "artist", name: "An Artist" },
      kind: "artist",
      expectedType: "artist",
    },
    {
      item: {
        artists: [{ id: "artist-id", name: "An Artist" }],
        id: "album-id",
        kind: "album",
        name: "An Album",
      },
      kind: "album",
      expectedType: "album",
    },
    {
      item: {
        childCount: 3,
        id: "playlist-id",
        kind: "playlist",
        name: "A Playlist",
      },
      kind: "playlist",
      expectedType: "playlist",
    },
    {
      item: {
        albumId: "album-id",
        albumName: "An Album",
        artists: [{ id: "artist-id", name: "An Artist" }],
        container: "mp3",
        durationMs: 125_500,
        id: "track-id",
        kind: "track",
        name: "A Track",
      },
      kind: "track",
      expectedType: "track",
    },
  ] as const)(
    "loads and formats a $kind entity with browse-consistent metadata",
    async ({ expectedType, item, kind }) => {
      const getItemMetadata = vi.fn().mockResolvedValue(item);
      const id = encodeSonosContentId({ kind, value: item.id });

      const result = await new SonofinExtendedMetadataService().getExtendedMetadata(
        request(id, { getItemMetadata }),
      );

      expect(getItemMetadata).toHaveBeenCalledWith(item.id);
      expect(result).toMatchObject({ id, itemType: expectedType });
    },
  );

  it.each([
    ["malformed", "invalid_parameters"],
    ["tracks", "item_not_found"],
  ] as const)("rejects %s static IDs safely", async (id, code) => {
    await expect(
      new SonofinExtendedMetadataService().getExtendedMetadata(request(id)),
    ).rejects.toMatchObject({ code, name: "SmapiBrowseError" });
  });

  it.each([
    {
      idKind: "album" as const,
      item: { id: "same-id", kind: "artist", name: "Wrong Kind" },
    },
    {
      idKind: "track" as const,
      item: {
        id: "same-id",
        jellyfinType: "Video",
        kind: "unknown",
        name: "Wrong Type",
      },
    },
  ])("rejects a $idKind ID whose Jellyfin kind does not match", async ({
    idKind,
    item,
  }) => {
    const getItemMetadata = vi
      .fn<() => Promise<JellyfinItemMetadata>>()
      .mockResolvedValue(item as JellyfinItemMetadata);

    await expect(
      new SonofinExtendedMetadataService().getExtendedMetadata(
        request(encodeSonosContentId({ kind: idKind, value: "same-id" }), {
          getItemMetadata,
        }),
      ),
    ).rejects.toMatchObject({
      code: "item_not_found",
      name: "SmapiBrowseError",
    });
  });

  it("preserves credential-safe Jellyfin failures for Worker fault mapping", async () => {
    const failure = new JellyfinClientError("item_not_found", {
      upstreamStatus: 404,
    });

    await expect(
      new SonofinExtendedMetadataService().getExtendedMetadata(
        request(encodeSonosContentId({ kind: "album", value: "deleted" }), {
          getItemMetadata: vi.fn().mockRejectedValue(failure),
        }),
      ),
    ).rejects.toBe(failure);
  });
});
