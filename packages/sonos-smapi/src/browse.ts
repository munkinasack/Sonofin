export const SONOS_MAX_COLLECTION_TEXT_CHARACTERS = 64;

export type SonosCollectionItemType =
  | "artist"
  | "album"
  | "genre"
  | "playlist"
  | "search"
  | "favorites"
  | "favorite"
  | "collection"
  | "container"
  | "albumList"
  | "trackList"
  | "streamList"
  | "artistTrackList"
  | "audiobook"
  | "other";

interface SonosBrowseItemBase {
  readonly id: string;
  readonly displayType?: string;
  readonly title: string;
  readonly summary?: string;
  readonly isFavorite?: boolean;
  readonly isExplicit?: boolean;
  readonly isEphemeral?: boolean;
}

export interface SonosBrowseCollection extends SonosBrowseItemBase {
  readonly kind: "collection";
  readonly itemType: SonosCollectionItemType;
  readonly artist?: string;
  readonly artistId?: string;
  readonly canScroll?: boolean;
  readonly canPlay?: boolean;
  readonly canEnumerate?: boolean;
  readonly canAddToFavorites?: boolean;
  readonly containsFavorite?: boolean;
  readonly canSkip?: boolean;
  readonly canResume?: boolean;
  readonly total?: number;
}

export interface SonosTrackMetadata {
  readonly artistId?: string;
  readonly artist?: string;
  readonly composerId?: string;
  readonly composer?: string;
  readonly albumArtistId?: string;
  readonly albumArtist?: string;
  readonly albumId?: string;
  readonly album?: string;
  readonly genreId?: string;
  readonly genre?: string;
  readonly duration?: number;
  readonly rating?: number;
  readonly trackNumber?: number;
  readonly canPlay?: boolean;
  readonly canSkip?: boolean;
  readonly canAddToFavorites?: boolean;
  readonly canResume?: boolean;
  readonly canSeek?: boolean;
}

export interface SonosBrowseTrack extends SonosBrowseItemBase {
  readonly kind: "track";
  readonly itemType: "track";
  readonly mimeType: string;
  readonly trackMetadata: SonosTrackMetadata;
}

export type SonosBrowseItem = SonosBrowseCollection | SonosBrowseTrack;

export interface GetMetadataResult {
  readonly index: number;
  readonly total: number;
  readonly items: readonly SonosBrowseItem[];
}

/** The SMAPI search response uses the same WSDL media-list shape as browse. */
export type SearchResult = GetMetadataResult;
