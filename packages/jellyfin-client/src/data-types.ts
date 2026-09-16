import type { JellyfinServer } from "./types";

export interface JellyfinDataConnection {
  readonly serverUrl: string;
  readonly serverId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly accessToken: string;
}

export interface JellyfinApiClientOptions {
  readonly connection: JellyfinDataConnection;
  readonly fetch?: typeof globalThis.fetch;
  readonly allowInsecureHttp?: boolean;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface JellyfinPageOptions {
  readonly startIndex?: number;
  readonly limit?: number;
}

export interface JellyfinLibraryPageOptions extends JellyfinPageOptions {
  readonly libraryId?: string;
}

export interface JellyfinAlbumPageOptions extends JellyfinLibraryPageOptions {
  readonly artistId?: string;
}

export type JellyfinSearchCategory =
  | "artist"
  | "album"
  | "track"
  | "playlist";

export interface JellyfinSearchOptions extends JellyfinLibraryPageOptions {
  readonly category: JellyfinSearchCategory;
}

export interface JellyfinPage<Item> {
  readonly items: readonly Item[];
  readonly startIndex: number;
  readonly totalRecordCount: number;
}

export interface JellyfinServerInfo extends JellyfinServer {
  readonly productName: string;
  readonly operatingSystem?: string;
  readonly localAddress?: string;
  readonly startupWizardCompleted?: boolean;
}

export interface JellyfinNamedItem {
  readonly id?: string;
  readonly name: string;
}

interface JellyfinItemBase {
  readonly id: string;
  readonly name: string;
  readonly sortName?: string;
  readonly parentId?: string;
  readonly mediaType?: string;
  readonly isFolder?: boolean;
  readonly overview?: string;
  readonly productionYear?: number;
  readonly durationMs?: number;
  readonly primaryImageTag?: string;
  readonly primaryImageAspectRatio?: number;
  readonly albumPrimaryImageTag?: string;
}

export interface JellyfinLibrary extends JellyfinItemBase {
  readonly kind: "library";
  readonly collectionType?: string;
}

export interface JellyfinArtist extends JellyfinItemBase {
  readonly kind: "artist";
}

export interface JellyfinAlbum extends JellyfinItemBase {
  readonly kind: "album";
  readonly artists: readonly JellyfinNamedItem[];
}

export interface JellyfinTrack extends JellyfinItemBase {
  readonly kind: "track";
  readonly playlistItemId?: string;
  readonly albumId?: string;
  readonly albumName?: string;
  readonly artists: readonly JellyfinNamedItem[];
  readonly discNumber?: number;
  readonly trackNumber?: number;
  readonly container?: string;
}

export interface JellyfinPlaylist extends JellyfinItemBase {
  readonly kind: "playlist";
  readonly childCount?: number;
}

export interface JellyfinUnknownItem extends JellyfinItemBase {
  readonly kind: "unknown";
  readonly jellyfinType: string;
}

export type JellyfinMusicItem =
  | JellyfinArtist
  | JellyfinAlbum
  | JellyfinTrack
  | JellyfinPlaylist;

export type JellyfinSearchResult = JellyfinMusicItem;
export type JellyfinItemMetadata = JellyfinMusicItem | JellyfinUnknownItem;

export interface JellyfinAudioStreamInfo {
  readonly index: number;
  readonly codec?: string;
  readonly profile?: string;
  readonly language?: string;
  readonly displayTitle?: string;
  readonly channels?: number;
  readonly channelLayout?: string;
  readonly sampleRate?: number;
  readonly bitrate?: number;
  readonly bitDepth?: number;
  readonly isDefault: boolean;
}

export interface JellyfinMediaSource {
  readonly id: string;
  readonly name?: string;
  readonly protocol?: string;
  readonly container?: string;
  readonly sizeBytes?: number;
  readonly bitrate?: number;
  readonly durationMs?: number;
  readonly supportsDirectPlay: boolean;
  readonly supportsDirectStream: boolean;
  readonly supportsTranscoding: boolean;
  readonly transcodingUrl?: string;
  readonly transcodingSubProtocol?: string;
  readonly transcodingContainer?: string;
  readonly defaultAudioStreamIndex?: number;
  readonly requiredHttpHeaders?: Readonly<Record<string, string>>;
  readonly audioStreams: readonly JellyfinAudioStreamInfo[];
}

export interface JellyfinPlaybackInfo {
  readonly playSessionId?: string;
  readonly errorCode?: string;
  readonly mediaSources: readonly JellyfinMediaSource[];
}

export interface JellyfinDataClient {
  getServerInfo(): Promise<JellyfinServerInfo>;

  getUserLibraries(): Promise<JellyfinPage<JellyfinLibrary>>;

  getArtists(
    options?: JellyfinLibraryPageOptions,
  ): Promise<JellyfinPage<JellyfinArtist>>;

  getAlbums(
    options?: JellyfinAlbumPageOptions,
  ): Promise<JellyfinPage<JellyfinAlbum>>;

  getAlbumTracks(
    albumId: string,
    options?: JellyfinPageOptions,
  ): Promise<JellyfinPage<JellyfinTrack>>;

  getPlaylists(
    options?: JellyfinLibraryPageOptions,
  ): Promise<JellyfinPage<JellyfinPlaylist>>;

  getPlaylistTracks(
    playlistId: string,
    options?: JellyfinPageOptions,
  ): Promise<JellyfinPage<JellyfinTrack>>;

  search(
    query: string,
    options: JellyfinSearchOptions,
  ): Promise<JellyfinPage<JellyfinSearchResult>>;

  getItemMetadata(itemId: string): Promise<JellyfinItemMetadata>;

  getPlaybackInfo(itemId: string): Promise<JellyfinPlaybackInfo>;
}
