import {
  JellyfinClientError,
  type JellyfinAlbum,
  type JellyfinArtist,
  type JellyfinPage,
  type JellyfinPlaylist,
  type JellyfinTrack,
} from "@sonofin/jellyfin-client";
import {
  decodeSonosContentId,
  encodeSonosContentId,
  parseSonosPagination,
  SONOS_MAX_COLLECTION_TEXT_CHARACTERS,
  SONOS_MAX_SIGNED_INT,
  SonosContentIdError,
  SonosPaginationError,
  type GetMetadataResult,
  type SonosBrowseCollection,
  type SonosBrowseItem,
  type SonosPagination,
} from "@sonofin/sonos-smapi";

import type { SmapiAuthenticatedRequestContext } from "./authenticated-context";
import { SMAPI_SEARCH_CATEGORY_ITEMS } from "./search-categories";
import { formatJellyfinTrackAsSonosBrowseTrack } from "./track-formatter";

export type SmapiBrowseErrorCode =
  | "invalid_parameters"
  | "item_not_found";

export class SmapiBrowseError extends Error {
  readonly code: SmapiBrowseErrorCode;

  constructor(code: SmapiBrowseErrorCode) {
    super("The SMAPI browse request could not be completed");
    this.name = "SmapiBrowseError";
    this.code = code;
  }
}

export interface SmapiGetMetadataRequest {
  readonly context: SmapiAuthenticatedRequestContext;
  readonly id: unknown;
  readonly index: unknown;
  readonly count: unknown;
  readonly recursive?: unknown;
}

export interface SmapiBrowseService {
  getMetadata(request: SmapiGetMetadataRequest): Promise<GetMetadataResult>;
}

function rootCollection(
  category: "artists" | "albums" | "playlists" | "search",
  title: string,
  itemType: SonosBrowseCollection["itemType"],
): SonosBrowseCollection {
  return Object.freeze({
    canAddToFavorites: false,
    canEnumerate: true,
    canPlay: false,
    canScroll: false,
    id: encodeSonosContentId({ kind: "category", value: category }),
    itemType,
    kind: "collection",
    title,
  });
}

const ROOT_MENU_ITEMS = Object.freeze([
  rootCollection("artists", "Artists", "container"),
  rootCollection("albums", "Albums", "albumList"),
  rootCollection("playlists", "Playlists", "playlist"),
  rootCollection("search", "Search", "container"),
]);
const SONOS_LINE_BREAK_PATTERN = /[\n\r\u0085\u2028\u2029]/u;

function isXmlText(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d &&
      (codePoint === undefined ||
        codePoint < 0x20 ||
        (codePoint > 0xd7ff && codePoint < 0xe000) ||
        (codePoint > 0xfffd && codePoint < 0x10000) ||
        codePoint > 0x10ffff)
    ) {
      return false;
    }
  }

  return true;
}

function isSonosDisplayText(value: unknown): value is string {
  return (
    isXmlText(value) &&
    !SONOS_LINE_BREAK_PATTERN.test(value) &&
    [...value].length <= SONOS_MAX_COLLECTION_TEXT_CHARACTERS
  );
}

function invalidJellyfinPage(): never {
  throw new JellyfinClientError("invalid_server_response");
}

function encodeRequiredEntityId(
  kind: "artist" | "album" | "playlist",
  value: unknown,
): string {
  if (!isXmlText(value)) {
    return invalidJellyfinPage();
  }

  try {
    return encodeSonosContentId({ kind, value });
  } catch {
    return invalidJellyfinPage();
  }
}

export function formatJellyfinEntityAsSonosBrowseCollection(
  item: JellyfinArtist | JellyfinAlbum | JellyfinPlaylist,
): SonosBrowseCollection {
  if (!isSonosDisplayText(item.name)) {
    return invalidJellyfinPage();
  }

  const kind = item.kind;
  const base = {
    canAddToFavorites: false,
    canEnumerate: true,
    canPlay: false,
    canScroll: false,
    id: encodeRequiredEntityId(kind, item.id),
    itemType: kind,
    kind: "collection" as const,
    title: item.name,
  };

  if (kind === "artist") {
    return Object.freeze(base);
  }

  if (kind === "playlist") {
    const total = item.childCount;
    return Object.freeze({
      ...base,
      ...(Number.isSafeInteger(total) &&
      (total as number) >= 0 &&
      (total as number) <= SONOS_MAX_SIGNED_INT
        ? { total }
        : {}),
    });
  }

  const albumArtist = item.artists.find((artist) =>
    isSonosDisplayText(artist.name),
  );
  if (albumArtist === undefined) {
    return Object.freeze(base);
  }

  let artistId: string | undefined;
  if (isXmlText(albumArtist.id)) {
    try {
      artistId = encodeSonosContentId({
        kind: "artist",
        value: albumArtist.id,
      });
    } catch {
      // Artist identity is optional album metadata. An unusable value must not
      // prevent the album itself from being browsed.
    }
  }

  return Object.freeze({
    ...base,
    artist: albumArtist.name,
    ...(artistId === undefined ? {} : { artistId }),
  });
}

function browsePage<Item>(
  page: JellyfinPage<Item>,
  pagination: SonosPagination,
  formatItem: (item: Item) => SonosBrowseItem,
): GetMetadataResult {
  if (
    page.startIndex !== pagination.index ||
    page.items.length > pagination.count
  ) {
    return invalidJellyfinPage();
  }

  const items = Object.freeze(page.items.map(formatItem));
  return Object.freeze({
    index: pagination.index,
    items,
    total: page.totalRecordCount,
  });
}

export class SonofinBrowseService implements SmapiBrowseService {
  async getMetadata(
    request: SmapiGetMetadataRequest,
  ): Promise<GetMetadataResult> {
    if (
      request.recursive !== undefined &&
      request.recursive !== "false" &&
      request.recursive !== "0"
    ) {
      // Flattened recursive track enumeration is not advertised by the
      // non-playable root collections and belongs to later category tasks.
      throw new SmapiBrowseError("invalid_parameters");
    }

    let pagination;
    try {
      pagination = parseSonosPagination(request.index, request.count);
    } catch (error) {
      if (error instanceof SonosPaginationError) {
        throw new SmapiBrowseError("invalid_parameters");
      }
      throw error;
    }

    let contentId;
    try {
      contentId = decodeSonosContentId(request.id);
    } catch (error) {
      if (error instanceof SonosContentIdError) {
        throw new SmapiBrowseError("invalid_parameters");
      }
      throw error;
    }

    if (contentId.kind === "category" && contentId.value === "artists") {
      const page = await request.context.jellyfin.getArtists({
        limit: pagination.count,
        startIndex: pagination.index,
      });
      return browsePage(
        page,
        pagination,
        formatJellyfinEntityAsSonosBrowseCollection,
      );
    }

    if (contentId.kind === "category" && contentId.value === "albums") {
      const page = await request.context.jellyfin.getAlbums({
        limit: pagination.count,
        startIndex: pagination.index,
      });
      return browsePage(
        page,
        pagination,
        formatJellyfinEntityAsSonosBrowseCollection,
      );
    }

    if (contentId.kind === "category" && contentId.value === "playlists") {
      const page = await request.context.jellyfin.getPlaylists({
        limit: pagination.count,
        startIndex: pagination.index,
      });
      return browsePage(
        page,
        pagination,
        formatJellyfinEntityAsSonosBrowseCollection,
      );
    }

    if (contentId.kind === "artist") {
      const page = await request.context.jellyfin.getAlbums({
        artistId: contentId.value,
        limit: pagination.count,
        startIndex: pagination.index,
      });
      return browsePage(
        page,
        pagination,
        formatJellyfinEntityAsSonosBrowseCollection,
      );
    }

    if (contentId.kind === "album") {
      const page = await request.context.jellyfin.getAlbumTracks(
        contentId.value,
        {
          limit: pagination.count,
          startIndex: pagination.index,
        },
      );
      return browsePage<JellyfinTrack>(
        page,
        pagination,
        formatJellyfinTrackAsSonosBrowseTrack,
      );
    }

    if (contentId.kind === "playlist") {
      const page = await request.context.jellyfin.getPlaylistTracks(
        contentId.value,
        {
          limit: pagination.count,
          startIndex: pagination.index,
        },
      );
      return browsePage<JellyfinTrack>(
        page,
        pagination,
        formatJellyfinTrackAsSonosBrowseTrack,
      );
    }

    if (contentId.kind === "category" && contentId.value === "search") {
      const end = Math.min(
        SMAPI_SEARCH_CATEGORY_ITEMS.length,
        pagination.index + pagination.count,
      );
      return Object.freeze({
        index: pagination.index,
        items: Object.freeze(
          SMAPI_SEARCH_CATEGORY_ITEMS.slice(pagination.index, end),
        ),
        total: SMAPI_SEARCH_CATEGORY_ITEMS.length,
      });
    }

    if (contentId.kind === "root") {
      const end = Math.min(
        ROOT_MENU_ITEMS.length,
        pagination.index + pagination.count,
      );
      const items = Object.freeze(
        ROOT_MENU_ITEMS.slice(pagination.index, end),
      );
      return Object.freeze({
        index: pagination.index,
        items,
        total: ROOT_MENU_ITEMS.length,
      });
    }

    throw new SmapiBrowseError("item_not_found");
  }
}
