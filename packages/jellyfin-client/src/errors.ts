export type JellyfinClientErrorCode =
  | "invalid_url"
  | "insecure_url"
  | "unsafe_url"
  | "invalid_input"
  | "server_unreachable"
  | "server_rejected"
  | "invalid_server_response"
  | "authentication_failed"
  | "token_invalid"
  | "item_not_found";

export type JellyfinClientOperation =
  | "server_discovery"
  | "password_authentication"
  | "token_authentication"
  | "token_revocation";

export interface JellyfinClientErrorDetails {
  operation?: JellyfinClientOperation;
  upstreamStatus?: number;
}

const ERROR_MESSAGES: Readonly<Record<JellyfinClientErrorCode, string>> = {
  invalid_url: "The Jellyfin server URL is invalid",
  insecure_url: "The Jellyfin server URL must use HTTPS",
  unsafe_url: "The Jellyfin server URL is not allowed",
  invalid_input: "The Jellyfin authentication input is invalid",
  server_unreachable: "The Jellyfin server could not be reached",
  server_rejected: "The Jellyfin server rejected the request",
  invalid_server_response: "The Jellyfin server returned an invalid response",
  authentication_failed: "Jellyfin authentication failed",
  token_invalid: "The Jellyfin access token is invalid",
  item_not_found: "The Jellyfin item was not found",
};

/** A stable, credential-safe failure that callers may map to user-facing UI. */
export class JellyfinClientError extends Error {
  readonly code: JellyfinClientErrorCode;
  readonly operation: JellyfinClientOperation | undefined;
  readonly upstreamStatus: number | undefined;

  constructor(
    code: JellyfinClientErrorCode,
    details: JellyfinClientErrorDetails = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "JellyfinClientError";
    this.code = code;
    this.operation = details.operation;
    this.upstreamStatus = details.upstreamStatus;
  }
}
