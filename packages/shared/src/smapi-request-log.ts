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
