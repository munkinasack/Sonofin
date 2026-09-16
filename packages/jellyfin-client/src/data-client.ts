import type {
  JellyfinAlbum,
  JellyfinAlbumPageOptions,
  JellyfinApiClientOptions,
  JellyfinArtist,
  JellyfinAudioStreamInfo,
  JellyfinDataClient,
  JellyfinItemMetadata,
  JellyfinLibrary,
  JellyfinLibraryPageOptions,
  JellyfinMediaSource,
  JellyfinNamedItem,
  JellyfinPage,
  JellyfinPageOptions,
  JellyfinPlaybackInfo,
  JellyfinPlaylist,
  JellyfinSearchCategory,
  JellyfinSearchOptions,
  JellyfinSearchResult,
  JellyfinServerInfo,
  JellyfinTrack,
  JellyfinUnknownItem,
} from "./data-types";
import {
  JellyfinClientError,
  type JellyfinClientErrorCode,
  type JellyfinResponseFailure,
} from "./errors";
import { sonosPlaybackInfoRequest } from "./sonos-playback-profile";
import {
  endpoint,
  isCharacterLength,
  isJsonObject,
  isWellFormedUnicode,
  JellyfinJsonTransport,
  jsonHeaders,
  normalizeServerUrl,
  readPositiveSafeInteger,
  requiredMetadata,
  type JsonObject,
} from "./transport";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;
const MAX_IDENTIFIER_CHARACTERS = 255;
const MAX_DEVICE_ID_CHARACTERS = 255;
const MAX_ACCESS_TOKEN_CHARACTERS = 4_096;
const MAX_SEARCH_QUERY_CHARACTERS = 512;
const LIST_FIELDS = "SortName,ParentId,PrimaryImageAspectRatio";
const UNKNOWN_ALBUM_NAME = "Unknown Album";

interface NormalizedPageOptions {
  readonly startIndex: number;
  readonly limit: number;
}

interface NormalizedLibraryPageOptions extends NormalizedPageOptions {
  readonly libraryId?: string;
}

interface NormalizedAlbumPageOptions extends NormalizedLibraryPageOptions {
  readonly artistId?: string;
}

interface NormalizedSearchOptions extends NormalizedLibraryPageOptions {
  readonly category: JellyfinSearchCategory;
}

type JellyfinSearchItemType =
  | "MusicArtist"
  | "MusicAlbum"
  | "Audio"
  | "Playlist";

interface NormalizedItemBase {
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

type ItemParser<Item> = (value: JsonObject) => Item;

function invalidResponse(responseFailure: JellyfinResponseFailure): never {
  throw new JellyfinClientError("invalid_server_response", {
    responseFailure,
  });
}

export class JellyfinApiClient implements JellyfinDataClient {
  readonly #transport: JellyfinJsonTransport;
  readonly #serverUrl: string;
  readonly #serverId: string;
  readonly #userId: string;
  readonly #headers: Headers;

  constructor(options: JellyfinApiClientOptions) {
    if (
      !isJsonObject(options) ||
      !isJsonObject(options.connection) ||
      (options.fetch !== undefined && typeof options.fetch !== "function") ||
      (options.allowInsecureHttp !== undefined &&
        typeof options.allowInsecureHttp !== "boolean")
    ) {
      throw new JellyfinClientError("invalid_input");
    }

    const connection = options.connection;
    if (
      !isIdentifier(connection.serverId) ||
      !isIdentifier(connection.userId) ||
      !isBoundedNonBlankText(
        connection.deviceId,
        MAX_DEVICE_ID_CHARACTERS,
      ) ||
      !isBoundedNonBlankText(
        connection.accessToken,
        MAX_ACCESS_TOKEN_CHARACTERS,
      )
    ) {
      throw new JellyfinClientError("invalid_input");
    }

    const requestTimeoutMs = readPositiveSafeInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const maxResponseBytes = readPositiveSafeInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.#serverUrl = normalizeServerUrl(
      connection.serverUrl,
      options.allowInsecureHttp ?? false,
    );
    this.#serverId = connection.serverId;
    this.#userId = connection.userId;
    this.#headers = jsonHeaders(connection.deviceId, connection.accessToken);
    this.#transport = new JellyfinJsonTransport(
      options.fetch ?? globalThis.fetch,
      requestTimeoutMs,
      maxResponseBytes,
    );
  }

  async getServerInfo(): Promise<JellyfinServerInfo> {
    const payload = await this.#request("/System/Info");
    const productName = requiredMetadata(payload, "ProductName");
    const serverId = requiredMetadata(payload, "Id");
    if (
      productName.toLowerCase() !== "jellyfin server" ||
      serverId !== this.#serverId
    ) {
      throw new JellyfinClientError("invalid_server_response");
    }

    return {
      serverUrl: this.#serverUrl,
      serverId,
      serverName: requiredMetadata(payload, "ServerName"),
      serverVersion: requiredMetadata(payload, "Version"),
      productName,
      ...optionalTextProperty(payload, "OperatingSystem", "operatingSystem"),
      ...optionalTextProperty(payload, "LocalAddress", "localAddress"),
      ...optionalBooleanProperty(
        payload,
        "StartupWizardCompleted",
        "startupWizardCompleted",
      ),
    };
  }

  async getUserLibraries(): Promise<JellyfinPage<JellyfinLibrary>> {
    const query = new URLSearchParams({
      userId: this.#userId,
      includeExternalContent: "false",
      includeHidden: "false",
    });
    const payload = await this.#request("/UserViews", query);
    const page = parsePage(payload, parseLibrary);
    const items = page.items.filter(
      (item) => item.collectionType?.toLowerCase() === "music",
    );
    return { items, startIndex: 0, totalRecordCount: items.length };
  }

  async getArtists(
    options: JellyfinLibraryPageOptions = {},
  ): Promise<JellyfinPage<JellyfinArtist>> {
    const normalized = normalizeLibraryPageOptions(options);
    const query = this.#listQuery(normalized);
    setOptional(query, "parentId", normalized.libraryId);
    query.set("sortBy", "SortName");
    query.set("sortOrder", "Ascending");
    return this.#requestPage("/Artists/AlbumArtists", query, parseArtist);
  }

  async getAlbums(
    options: JellyfinAlbumPageOptions = {},
  ): Promise<JellyfinPage<JellyfinAlbum>> {
    const normalized = normalizeAlbumPageOptions(options);
    const query = this.#listQuery(normalized);
    query.set("includeItemTypes", "MusicAlbum");
    query.set("recursive", "true");
    query.set("sortBy", "AlbumArtist,SortName");
    query.set("sortOrder", "Ascending");
    setOptional(query, "parentId", normalized.libraryId);
    setOptional(query, "albumArtistIds", normalized.artistId);
    return this.#requestPage("/Items", query, parseAlbum);
  }

  async getAlbumTracks(
    albumId: string,
    options: JellyfinPageOptions = {},
  ): Promise<JellyfinPage<JellyfinTrack>> {
    assertIdentifier(albumId);
    const normalized = normalizePageOptions(options);
    const query = this.#listQuery(normalized);
    query.set("includeItemTypes", "Audio");
    query.set("albumIds", albumId);
    query.set("recursive", "true");
    query.set("sortBy", "ParentIndexNumber,IndexNumber,SortName");
    query.set("sortOrder", "Ascending");
    return this.#requestPage("/Items", query, parseTrack, true);
  }

  async getPlaylists(
    options: JellyfinLibraryPageOptions = {},
  ): Promise<JellyfinPage<JellyfinPlaylist>> {
    const normalized = normalizeLibraryPageOptions(options);
    const query = this.#listQuery(normalized);
    query.set("includeItemTypes", "Playlist");
    query.set("mediaTypes", "Audio");
    query.set("recursive", "true");
    query.set("sortBy", "SortName");
    query.set("sortOrder", "Ascending");
    setOptional(query, "parentId", normalized.libraryId);
    return this.#requestPage("/Items", query, parsePlaylist);
  }

  async getPlaylistTracks(
    playlistId: string,
    options: JellyfinPageOptions = {},
  ): Promise<JellyfinPage<JellyfinTrack>> {
    assertIdentifier(playlistId);
    const normalized = normalizePageOptions(options);
    const query = new URLSearchParams({
      userId: this.#userId,
      startIndex: String(normalized.startIndex),
      limit: String(normalized.limit),
      fields: LIST_FIELDS,
      enableImages: "true",
      imageTypeLimit: "1",
      enableImageTypes: "Primary",
    });
    return this.#requestPage(
      `/Playlists/${encodeURIComponent(playlistId)}/Items`,
      query,
      parseTrack,
      true,
    );
  }

  async search(
    queryText: string,
    options: JellyfinSearchOptions,
  ): Promise<JellyfinPage<JellyfinSearchResult>> {
    if (
      !isCharacterLength(queryText, 1, MAX_SEARCH_QUERY_CHARACTERS) ||
      queryText.trim().length === 0
    ) {
      throw new JellyfinClientError("invalid_input");
    }
    const normalized = normalizeSearchOptions(options);
    const itemType = jellyfinSearchItemType(normalized.category);
    const query = this.#listQuery(normalized);
    query.set("searchTerm", queryText.trim());
    query.set("sortBy", "SortName");
    query.set("sortOrder", "Ascending");
    setOptional(query, "parentId", normalized.libraryId);
    if (normalized.category === "playlist") {
      query.set("mediaTypes", "Audio");
    }

    let pathname = "/Artists";
    if (normalized.category !== "artist") {
      pathname = "/Items";
      query.set("includeItemTypes", itemType);
      query.set("recursive", "true");
    }

    return this.#requestPage(pathname, query, (value) =>
      parseSearchResult(value, itemType),
    );
  }

  async getItemMetadata(itemId: string): Promise<JellyfinItemMetadata> {
    assertIdentifier(itemId);
    const query = new URLSearchParams({ userId: this.#userId });
    const payload = await this.#request(
      `/Items/${encodeURIComponent(itemId)}`,
      query,
      true,
    );
    return parseItemMetadata(payload);
  }

  async getPlaybackInfo(itemId: string): Promise<JellyfinPlaybackInfo> {
    assertIdentifier(itemId);
    const headers = new Headers(this.#headers);
    headers.set("content-type", "application/json");
    const payload = await this.#request(
      `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`,
      undefined,
      true,
      {
        method: "POST",
        headers,
        body: JSON.stringify(sonosPlaybackInfoRequest(this.#userId)),
      },
    );
    return parsePlaybackInfo(payload);
  }

  #listQuery(options: NormalizedPageOptions): URLSearchParams {
    return new URLSearchParams({
      userId: this.#userId,
      startIndex: String(options.startIndex),
      limit: String(options.limit),
      fields: LIST_FIELDS,
      enableImages: "true",
      enableTotalRecordCount: "true",
      imageTypeLimit: "1",
      enableImageTypes: "Primary",
    });
  }

  async #requestPage<Item>(
    pathname: string,
    query: URLSearchParams,
    parser: ItemParser<Item>,
    itemSpecific = false,
  ): Promise<JellyfinPage<Item>> {
    return parsePage(
      await this.#request(pathname, query, itemSpecific),
      parser,
    );
  }

  async #request(
    pathname: string,
    query?: URLSearchParams,
    itemSpecific = false,
    init?: RequestInit,
  ): Promise<JsonObject> {
    const queryText = query?.toString();
    const url = endpoint(
      this.#serverUrl,
      queryText === undefined || queryText === ""
        ? pathname
        : `${pathname}?${queryText}`,
    );
    return this.#transport.requestJson(
      url,
      { method: "GET", headers: this.#headers, ...init },
      (status) => rejectedCode(status, itemSpecific),
    );
  }
}

function rejectedCode(
  status: number,
  itemSpecific: boolean,
): JellyfinClientErrorCode {
  if (status === 401 || status === 403) {
    return "token_invalid";
  }
  if (itemSpecific && status === 404) {
    return "item_not_found";
  }
  return "server_rejected";
}

function normalizePageOptions(options: unknown): NormalizedPageOptions {
  if (!isJsonObject(options)) {
    throw new JellyfinClientError("invalid_input");
  }
  const startIndex = options.startIndex ?? 0;
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  if (
    !Number.isSafeInteger(startIndex) ||
    (startIndex as number) < 0 ||
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_PAGE_LIMIT
  ) {
    throw new JellyfinClientError("invalid_input");
  }
  return { startIndex: startIndex as number, limit: limit as number };
}

function normalizeLibraryPageOptions(
  options: unknown,
): NormalizedLibraryPageOptions {
  const page = normalizePageOptions(options);
  const libraryId = (options as JsonObject).libraryId;
  if (libraryId !== undefined && !isIdentifier(libraryId)) {
    throw new JellyfinClientError("invalid_input");
  }
  return {
    ...page,
    ...(libraryId === undefined ? {} : { libraryId }),
  };
}

function normalizeAlbumPageOptions(
  options: unknown,
): NormalizedAlbumPageOptions {
  const page = normalizeLibraryPageOptions(options);
  const artistId = (options as JsonObject).artistId;
  if (artistId !== undefined && !isIdentifier(artistId)) {
    throw new JellyfinClientError("invalid_input");
  }
  return {
    ...page,
    ...(artistId === undefined ? {} : { artistId }),
  };
}

function normalizeSearchOptions(options: unknown): NormalizedSearchOptions {
  const page = normalizeLibraryPageOptions(options);
  const category = (options as JsonObject).category;
  if (!isSearchCategory(category)) {
    throw new JellyfinClientError("invalid_input");
  }
  return { ...page, category };
}

function isSearchCategory(value: unknown): value is JellyfinSearchCategory {
  return (
    value === "artist" ||
    value === "album" ||
    value === "track" ||
    value === "playlist"
  );
}

function jellyfinSearchItemType(
  category: JellyfinSearchCategory,
): JellyfinSearchItemType {
  switch (category) {
    case "artist":
      return "MusicArtist";
    case "album":
      return "MusicAlbum";
    case "track":
      return "Audio";
    case "playlist":
      return "Playlist";
  }
}

function assertIdentifier(value: unknown): asserts value is string {
  if (!isIdentifier(value)) {
    throw new JellyfinClientError("invalid_input");
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    isCharacterLength(value, 1, MAX_IDENTIFIER_CHARACTERS) &&
    value.trim() === value &&
    value.length > 0
  );
}

function isBoundedNonBlankText(value: unknown, maximum: number): value is string {
  return (
    isCharacterLength(value, 1, maximum) && value.trim().length > 0
  );
}

function setOptional(
  query: URLSearchParams,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    query.set(key, value);
  }
}

function parsePage<Item>(
  payload: JsonObject,
  parser: ItemParser<Item>,
): JellyfinPage<Item> {
  const values = payload.Items;
  if (!Array.isArray(values)) {
    return invalidResponse("page_shape");
  }
  let startIndex: number;
  let totalRecordCount: number;
  try {
    startIndex = requiredNonNegativeInteger(payload, "StartIndex");
    totalRecordCount = requiredNonNegativeInteger(
      payload,
      "TotalRecordCount",
    );
  } catch {
    return invalidResponse("page_shape");
  }
  const items = values.map((value) => {
    if (!isJsonObject(value)) {
      return invalidResponse("page_item_shape");
    }
    return parser(value);
  });
  return { items, startIndex, totalRecordCount };
}

function parseLibrary(value: JsonObject): JellyfinLibrary {
  requiredMetadata(value, "Type");
  return {
    ...parseItemBase(value),
    kind: "library",
    ...optionalTextProperty(value, "CollectionType", "collectionType"),
  };
}

function parseArtist(value: JsonObject): JellyfinArtist {
  assertItemType(value, "MusicArtist");
  return { ...parseItemBase(value), kind: "artist" };
}

function parseAlbum(value: JsonObject): JellyfinAlbum {
  try {
    assertItemType(value, "MusicAlbum");
  } catch {
    return invalidResponse("album_type");
  }

  try {
    requiredMetadata(value, "Id");
  } catch {
    return invalidResponse("album_id");
  }

  let name: string;
  try {
    name = requiredMetadata(value, "Name");
  } catch {
    try {
      name = optionalText(value, "SortName") ?? UNKNOWN_ALBUM_NAME;
    } catch {
      return invalidResponse("album_optional_metadata");
    }
  }

  let base: NormalizedItemBase;
  try {
    base = parseItemBase(value, name);
  } catch {
    return invalidResponse("album_optional_metadata");
  }

  let artists: readonly JellyfinNamedItem[];
  try {
    artists =
      parseNamedItems(value, "AlbumArtists") ??
      parseNamedItems(value, "ArtistItems") ??
      parseNamedArtists(value);
  } catch {
    return invalidResponse("album_artists");
  }

  return {
    ...base,
    kind: "album",
    artists,
  };
}

function parseTrack(value: JsonObject): JellyfinTrack {
  assertItemType(value, "Audio");
  return {
    ...parseItemBase(value),
    kind: "track",
    ...optionalTextProperty(value, "PlaylistItemId", "playlistItemId"),
    ...optionalTextProperty(value, "AlbumId", "albumId"),
    ...optionalTextProperty(value, "Album", "albumName"),
    artists: parseNamedItems(value, "ArtistItems") ?? parseNamedArtists(value),
    ...optionalIntegerProperty(value, "ParentIndexNumber", "discNumber"),
    ...optionalIntegerProperty(value, "IndexNumber", "trackNumber"),
    ...optionalTextProperty(value, "Container", "container"),
  };
}

function parsePlaylist(value: JsonObject): JellyfinPlaylist {
  assertItemType(value, "Playlist");
  return {
    ...parseItemBase(value),
    kind: "playlist",
    ...optionalIntegerProperty(value, "ChildCount", "childCount"),
  };
}

function parseSearchResult(
  value: JsonObject,
  expectedType?: JellyfinSearchItemType,
): JellyfinSearchResult {
  const type = requiredMetadata(value, "Type");
  if (expectedType !== undefined && type !== expectedType) {
    throw new JellyfinClientError("invalid_server_response");
  }
  switch (type) {
    case "MusicArtist":
      return parseArtist(value);
    case "MusicAlbum":
      return parseAlbum(value);
    case "Audio":
      return parseTrack(value);
    case "Playlist":
      return parsePlaylist(value);
    default:
      throw new JellyfinClientError("invalid_server_response");
  }
}

function parseItemMetadata(value: JsonObject): JellyfinItemMetadata {
  const type = requiredMetadata(value, "Type");
  switch (type) {
    case "MusicArtist":
    case "MusicAlbum":
    case "Audio":
    case "Playlist":
      return parseSearchResult(value);
    default:
      return parseUnknownItem(value, type);
  }
}

function parseUnknownItem(
  value: JsonObject,
  jellyfinType: string,
): JellyfinUnknownItem {
  return {
    ...parseItemBase(value),
    kind: "unknown",
    jellyfinType,
  };
}

function parseItemBase(
  value: JsonObject,
  nameOverride?: string,
): NormalizedItemBase {
  const imageTags = optionalObject(value, "ImageTags");
  const primaryImageTag =
    optionalText(imageTags, "Primary") ?? optionalText(value, "PrimaryImageTag");
  const runtimeTicks = optionalNonNegativeInteger(value, "RunTimeTicks");
  return {
    id: requiredMetadata(value, "Id"),
    name: nameOverride ?? requiredMetadata(value, "Name"),
    ...optionalTextProperty(value, "SortName", "sortName"),
    ...optionalTextProperty(value, "ParentId", "parentId"),
    ...optionalTextProperty(value, "MediaType", "mediaType"),
    ...optionalBooleanProperty(value, "IsFolder", "isFolder"),
    ...optionalTextProperty(value, "Overview", "overview"),
    ...optionalIntegerProperty(value, "ProductionYear", "productionYear"),
    ...(runtimeTicks === undefined
      ? {}
      : { durationMs: Math.floor(runtimeTicks / 10_000) }),
    ...(primaryImageTag === undefined ? {} : { primaryImageTag }),
    ...optionalNumberProperty(
      value,
      "PrimaryImageAspectRatio",
      "primaryImageAspectRatio",
    ),
    ...optionalTextProperty(
      value,
      "AlbumPrimaryImageTag",
      "albumPrimaryImageTag",
    ),
  };
}

function parseNamedItems(
  value: JsonObject,
  key: string,
): readonly JellyfinNamedItem[] | undefined {
  const rawItems = value[key];
  if (rawItems === undefined || rawItems === null) {
    return undefined;
  }
  if (!Array.isArray(rawItems)) {
    throw new JellyfinClientError("invalid_server_response");
  }
  return rawItems.map((rawItem) => {
    if (!isJsonObject(rawItem)) {
      throw new JellyfinClientError("invalid_server_response");
    }
    const id = optionalText(rawItem, "Id");
    return {
      name: requiredMetadata(rawItem, "Name"),
      ...(id === undefined ? {} : { id }),
    };
  });
}

function parseNamedArtists(value: JsonObject): readonly JellyfinNamedItem[] {
  const names = optionalTextArray(value, "Artists") ?? [];
  const ids = optionalTextArray(value, "ArtistIds") ?? [];
  return names.map((name, index) => {
    const id = ids[index];
    return { name, ...(id === undefined ? {} : { id }) };
  });
}

function parsePlaybackInfo(value: JsonObject): JellyfinPlaybackInfo {
  const rawSources = value.MediaSources;
  if (!Array.isArray(rawSources)) {
    throw new JellyfinClientError("invalid_server_response");
  }
  const mediaSources: JellyfinMediaSource[] = [];
  for (const rawSource of rawSources) {
    if (!isJsonObject(rawSource)) {
      continue;
    }
    try {
      mediaSources.push(parseMediaSource(rawSource));
    } catch (error) {
      if (
        !(error instanceof JellyfinClientError) ||
        error.code !== "invalid_server_response"
      ) {
        throw error;
      }
    }
  }
  if (rawSources.length > 0 && mediaSources.length === 0) {
    throw new JellyfinClientError("invalid_server_response");
  }
  return {
    ...optionalTextProperty(value, "PlaySessionId", "playSessionId"),
    ...optionalTextProperty(value, "ErrorCode", "errorCode"),
    mediaSources,
  };
}

function parseMediaSource(value: JsonObject): JellyfinMediaSource {
  const rawStreams = value.MediaStreams;
  if (!Array.isArray(rawStreams)) {
    throw new JellyfinClientError("invalid_server_response");
  }
  const audioStreams: JellyfinAudioStreamInfo[] = [];
  for (const rawStream of rawStreams) {
    if (!isJsonObject(rawStream)) {
      throw new JellyfinClientError("invalid_server_response");
    }
    const type = requiredMetadata(rawStream, "Type");
    if (type === "Audio") {
      audioStreams.push(parseAudioStream(rawStream));
    }
  }
  const runtimeTicks = optionalNonNegativeInteger(value, "RunTimeTicks");
  return {
    id: requiredMetadata(value, "Id"),
    ...optionalTextProperty(value, "Name", "name"),
    ...optionalTextProperty(value, "Protocol", "protocol"),
    ...optionalTextProperty(value, "Container", "container"),
    ...optionalIntegerProperty(value, "Size", "sizeBytes"),
    ...optionalIntegerProperty(value, "Bitrate", "bitrate"),
    ...(runtimeTicks === undefined
      ? {}
      : { durationMs: Math.floor(runtimeTicks / 10_000) }),
    supportsDirectPlay: optionalBoolean(value, "SupportsDirectPlay") ?? false,
    supportsDirectStream:
      optionalBoolean(value, "SupportsDirectStream") ?? false,
    supportsTranscoding:
      optionalBoolean(value, "SupportsTranscoding") ?? false,
    ...optionalUntrimmedTextProperty(value, "TranscodingUrl", "transcodingUrl"),
    ...optionalTextProperty(
      value,
      "TranscodingSubProtocol",
      "transcodingSubProtocol",
    ),
    ...optionalTextProperty(
      value,
      "TranscodingContainer",
      "transcodingContainer",
    ),
    ...optionalIntegerProperty(
      value,
      "DefaultAudioStreamIndex",
      "defaultAudioStreamIndex",
    ),
    ...optionalStringRecordProperty(
      value,
      "RequiredHttpHeaders",
      "requiredHttpHeaders",
    ),
    audioStreams,
  };
}

function parseAudioStream(value: JsonObject): JellyfinAudioStreamInfo {
  return {
    index: requiredNonNegativeInteger(value, "Index"),
    ...optionalTextProperty(value, "Codec", "codec"),
    ...optionalTextProperty(value, "Profile", "profile"),
    ...optionalTextProperty(value, "Language", "language"),
    ...optionalTextProperty(value, "DisplayTitle", "displayTitle"),
    ...optionalIntegerProperty(value, "Channels", "channels"),
    ...optionalTextProperty(value, "ChannelLayout", "channelLayout"),
    ...optionalIntegerProperty(value, "SampleRate", "sampleRate"),
    ...optionalIntegerProperty(value, "BitRate", "bitrate"),
    ...optionalIntegerProperty(value, "BitDepth", "bitDepth"),
    isDefault: optionalBoolean(value, "IsDefault") ?? false,
  };
}

function assertItemType(value: JsonObject, expected: string): void {
  if (requiredMetadata(value, "Type") !== expected) {
    throw new JellyfinClientError("invalid_server_response");
  }
}

function optionalObject(
  value: JsonObject,
  key: string,
): JsonObject | undefined {
  const result = value[key];
  if (result === undefined || result === null) {
    return undefined;
  }
  if (!isJsonObject(result)) {
    throw new JellyfinClientError("invalid_server_response");
  }
  return result;
}

function optionalText(
  value: JsonObject | undefined,
  key: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = value[key];
  if (result === undefined || result === null || result === "") {
    return undefined;
  }
  if (typeof result !== "string" || !isWellFormedUnicode(result)) {
    throw new JellyfinClientError("invalid_server_response");
  }
  const normalized = result.trim();
  return normalized === "" ? undefined : normalized;
}

function optionalTextArray(
  value: JsonObject,
  key: string,
): readonly string[] | undefined {
  const result = value[key];
  if (result === undefined || result === null) {
    return undefined;
  }
  if (!Array.isArray(result)) {
    throw new JellyfinClientError("invalid_server_response");
  }
  return result.map((entry) => {
    if (
      typeof entry !== "string" ||
      !isWellFormedUnicode(entry) ||
      entry.trim().length === 0
    ) {
      throw new JellyfinClientError("invalid_server_response");
    }
    return entry.trim();
  });
}

function optionalBoolean(value: JsonObject, key: string): boolean | undefined {
  const result = value[key];
  if (result === undefined || result === null) {
    return undefined;
  }
  if (typeof result !== "boolean") {
    throw new JellyfinClientError("invalid_server_response");
  }
  return result;
}

function optionalNonNegativeInteger(
  value: JsonObject,
  key: string,
): number | undefined {
  const result = value[key];
  if (result === undefined || result === null) {
    return undefined;
  }
  if (!Number.isSafeInteger(result) || (result as number) < 0) {
    throw new JellyfinClientError("invalid_server_response");
  }
  return result as number;
}

function optionalNonNegativeNumber(
  value: JsonObject,
  key: string,
): number | undefined {
  const result = value[key];
  if (result === undefined || result === null) {
    return undefined;
  }
  if (typeof result !== "number" || !Number.isFinite(result) || result < 0) {
    throw new JellyfinClientError("invalid_server_response");
  }
  return result;
}

function optionalStringRecord(
  value: JsonObject,
  key: string,
): Readonly<Record<string, string>> | undefined {
  const result = value[key];
  if (result === undefined || result === null) {
    return undefined;
  }
  if (!isJsonObject(result)) {
    throw new JellyfinClientError("invalid_server_response");
  }
  const entries = Object.entries(result);
  for (const [entryKey, entryValue] of entries) {
    if (
      entryKey.trim().length === 0 ||
      !isWellFormedUnicode(entryKey) ||
      typeof entryValue !== "string" ||
      !isWellFormedUnicode(entryValue)
    ) {
      throw new JellyfinClientError("invalid_server_response");
    }
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function requiredNonNegativeInteger(value: JsonObject, key: string): number {
  const result = optionalNonNegativeInteger(value, key);
  if (result === undefined) {
    throw new JellyfinClientError("invalid_server_response");
  }
  return result;
}

function optionalTextProperty<Key extends string>(
  value: JsonObject,
  inputKey: string,
  outputKey: Key,
): Partial<Readonly<Record<Key, string>>> {
  const result = optionalText(value, inputKey);
  return result === undefined
    ? {}
    : ({ [outputKey]: result } as Readonly<Record<Key, string>>);
}

function optionalUntrimmedTextProperty<Key extends string>(
  value: JsonObject,
  inputKey: string,
  outputKey: Key,
): Partial<Readonly<Record<Key, string>>> {
  const raw = value[inputKey];
  if (raw === undefined || raw === null || raw === "") {
    return {};
  }
  if (
    typeof raw !== "string" ||
    !isWellFormedUnicode(raw) ||
    raw.trim() !== raw ||
    Array.from(raw).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new JellyfinClientError("invalid_server_response");
  }
  return { [outputKey]: raw } as Readonly<Record<Key, string>>;
}

function optionalBooleanProperty<Key extends string>(
  value: JsonObject,
  inputKey: string,
  outputKey: Key,
): Partial<Readonly<Record<Key, boolean>>> {
  const result = optionalBoolean(value, inputKey);
  return result === undefined
    ? {}
    : ({ [outputKey]: result } as Readonly<Record<Key, boolean>>);
}

function optionalIntegerProperty<Key extends string>(
  value: JsonObject,
  inputKey: string,
  outputKey: Key,
): Partial<Readonly<Record<Key, number>>> {
  const result = optionalNonNegativeInteger(value, inputKey);
  return result === undefined
    ? {}
    : ({ [outputKey]: result } as Readonly<Record<Key, number>>);
}

function optionalNumberProperty<Key extends string>(
  value: JsonObject,
  inputKey: string,
  outputKey: Key,
): Partial<Readonly<Record<Key, number>>> {
  const result = optionalNonNegativeNumber(value, inputKey);
  return result === undefined
    ? {}
    : ({ [outputKey]: result } as Readonly<Record<Key, number>>);
}

function optionalStringRecordProperty<Key extends string>(
  value: JsonObject,
  inputKey: string,
  outputKey: Key,
): Partial<Readonly<Record<Key, Readonly<Record<string, string>>>>> {
  const result = optionalStringRecord(value, inputKey);
  return result === undefined
    ? {}
    : ({ [outputKey]: result } as Readonly<
        Record<Key, Readonly<Record<string, string>>>
      >);
}
