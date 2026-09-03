export type SmapiLogOutcome = "success" | "rejected" | "error";

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
  reason?: SmapiLogReason;
  soapMethod?:
    | "getAppLink"
    | "getDeviceAuthToken"
    | "getLastUpdate"
    | "getMetadata";
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
