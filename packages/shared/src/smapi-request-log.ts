export type SmapiLogOutcome = "success" | "rejected" | "error";

export type SmapiLogContentCategory =
  | "artists"
  | "albums"
  | "tracks"
  | "playlists"
  | "search"
  | "artist"
  | "album"
  | "track"
  | "playlist";

export type SmapiLogContentKind =
  | "root"
  | "category"
  | "artist"
  | "album"
  | "track"
  | "playlist";

export type SmapiItemNotFoundOrigin =
  | "authenticated_context"
  | "browse_service"
  | "metadata_service"
  | "jellyfin";

export type SmapiInternalErrorOrigin =
  | "browse_entity_id"
  | "browse_page"
  | "jellyfin_configuration"
  | "jellyfin_album_artists"
  | "jellyfin_album_id"
  | "jellyfin_album_metadata"
  | "jellyfin_album_type"
  | "jellyfin_page"
  | "jellyfin_rejected"
  | "jellyfin_response_body"
  | "jellyfin_response_too_large"
  | "jellyfin_response"
  | "serialization"
  | "track_container_ambiguous"
  | "track_container_missing"
  | "track_container_opus"
  | "track_container_other"
  | "track_container_webm"
  | "track_data"
  | "unexpected";

export type SmapiLogMethod =
  | "getAppLink"
  | "getDeviceAuthToken"
  | "getLastUpdate"
  | "getMetadata"
  | "search"
  | "getExtendedMetadata"
  | "getExtendedMetadataText"
  | "getMediaMetadata"
  | "getMediaURI";

export type SmapiLogReason =
  | "internal_error"
  | "invalid_soap"
  | "invalid_parameters"
  | "item_not_found"
  | "link_failed"
  | "link_pending"
  | "method_not_allowed"
  | "not_found"
  | "payload_too_large"
  | "service_unavailable"
  | "unauthorized"
  | "unsupported_media_type"
  | "unsupported_method";

export interface SmapiRequestLog {
  requestId: string;
  httpStatus: number;
  durationMs: number;
  outcome: SmapiLogOutcome;
  contentCategory?: SmapiLogContentCategory;
  contentKind?: SmapiLogContentKind;
  internalErrorOrigin?: SmapiInternalErrorOrigin;
  itemNotFoundOrigin?: SmapiItemNotFoundOrigin;
  reason?: SmapiLogReason;
  soapMethod?: SmapiLogMethod;
}

export interface SmapiLogSink {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Writes a deliberately allow-listed request summary. The API cannot accept
 * headers, request bodies, credentials, link codes, or tokens.
 */
export function writeSmapiRequestLog(
  sink: SmapiLogSink,
  entry: SmapiRequestLog,
): void {
  const message = JSON.stringify({
    event: "smapi.request",
    requestId: entry.requestId,
    httpStatus: entry.httpStatus,
    durationMs: entry.durationMs,
    outcome: entry.outcome,
    ...(entry.contentCategory === undefined
      ? {}
      : { contentCategory: entry.contentCategory }),
    ...(entry.contentKind === undefined
      ? {}
      : { contentKind: entry.contentKind }),
    ...(entry.internalErrorOrigin === undefined
      ? {}
      : { internalErrorOrigin: entry.internalErrorOrigin }),
    ...(entry.itemNotFoundOrigin === undefined
      ? {}
      : { itemNotFoundOrigin: entry.itemNotFoundOrigin }),
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    ...(entry.soapMethod === undefined ? {} : { soapMethod: entry.soapMethod }),
  });

  if (entry.outcome === "success") {
    sink.info(message);
    return;
  }

  if (entry.outcome === "rejected") {
    sink.warn(message);
    return;
  }

  sink.error(message);
}
