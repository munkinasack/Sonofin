import type { JellyfinSearchCategory } from "@sonofin/jellyfin-client";
import type { SonosBrowseCollection } from "@sonofin/sonos-smapi";

export const SMAPI_SEARCH_CATEGORIES = Object.freeze([
  Object.freeze({ id: "artist", title: "Artists" }),
  Object.freeze({ id: "album", title: "Albums" }),
  Object.freeze({ id: "track", title: "Tracks" }),
  Object.freeze({ id: "playlist", title: "Playlists" }),
] as const satisfies readonly {
  readonly id: JellyfinSearchCategory;
  readonly title: string;
}[]);

export type SmapiSearchCategory =
  (typeof SMAPI_SEARCH_CATEGORIES)[number]["id"];

export const SMAPI_SEARCH_CATEGORY_ITEMS: readonly SonosBrowseCollection[] =
  Object.freeze(
    SMAPI_SEARCH_CATEGORIES.map((category) =>
      Object.freeze({
        canAddToFavorites: false,
        canEnumerate: false,
        canPlay: false,
        canScroll: false,
        id: category.id,
        itemType: "search" as const,
        kind: "collection" as const,
        title: category.title,
      }),
    ),
  );
