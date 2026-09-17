import {
  JellyfinClientError,
  type JellyfinConnection,
  type JellyfinDataClient,
} from "@sonofin/jellyfin-client";
import type { SmapiLogOutcome, SmapiLogReason } from "@sonofin/shared";
import type { SonosAuthenticationMapping } from "@sonofin/sonos-auth";
import type {
  ParsedCredentials,
  SoapFaultCode,
} from "@sonofin/sonos-smapi";

export interface SmapiSonosCredentialAuthenticator {
  authenticate(input: {
    authToken: string;
    householdId: string;
  }): Promise<
    | {
        outcome: "success";
        connection: SonosAuthenticationMapping;
      }
    | { outcome: "failure" }
  >;
}

export interface SmapiJellyfinConnectionResolver {
  retrieve(connectionId: string): Promise<JellyfinConnection | null>;
}

export type SmapiJellyfinDataClientFactory = (
  connection: JellyfinConnection,
) => JellyfinDataClient;

export interface SmapiAuthenticatedRequestContext {
  /** The exact, case-sensitive association authenticated for this request. */
  readonly sonosMapping: SonosAuthenticationMapping;
  /** The decrypted connection is confined to this authenticated request. */
  readonly connection: JellyfinConnection;
  /** A request-scoped client for Jellyfin catalog and playback negotiation. */
  readonly jellyfin: JellyfinDataClient;
}

export interface SmapiSafeSoapFault {
  readonly faultCode: SoapFaultCode;
  readonly message: string;
  readonly outcome: SmapiLogOutcome;
  readonly reason: SmapiLogReason;
}

export interface SmapiAuthenticatedContextDependencies {
  readonly sonosAuthentication: SmapiSonosCredentialAuthenticator;
  readonly jellyfinConnections: SmapiJellyfinConnectionResolver;
  readonly createJellyfinDataClient: SmapiJellyfinDataClientFactory;
}

export type SmapiAuthenticatedContextResult =
  | {
      readonly outcome: "success";
      readonly context: SmapiAuthenticatedRequestContext;
    }
  | {
      readonly outcome: "failure";
      readonly fault: SmapiSafeSoapFault;
    };

const LOGIN_UNAUTHORIZED_FAULT = {
  faultCode: "Client.LoginUnauthorized",
  message: "The account credentials are not authorized",
  outcome: "rejected",
  reason: "unauthorized",
} as const satisfies SmapiSafeSoapFault;

const AUTH_TOKEN_EXPIRED_FAULT = {
  faultCode: "Client.AuthTokenExpired",
  message: "The linked account credentials must be renewed",
  outcome: "rejected",
  reason: "unauthorized",
} as const satisfies SmapiSafeSoapFault;

const ITEM_NOT_FOUND_FAULT = {
  faultCode: "Client.ItemNotFound",
  message: "The requested item is not available",
  outcome: "rejected",
  reason: "item_not_found",
} as const satisfies SmapiSafeSoapFault;

const SERVICE_UNAVAILABLE_FAULT = {
  faultCode: "Server.ServiceUnavailable",
  message: "The linked music server is temporarily unavailable",
  outcome: "error",
  reason: "service_unavailable",
} as const satisfies SmapiSafeSoapFault;

const UNKNOWN_SERVICE_FAULT = {
  faultCode: "Server.ServiceUnknownError",
  message: "The service could not process the request",
  outcome: "error",
  reason: "internal_error",
} as const satisfies SmapiSafeSoapFault;

/**
 * Maps only stable Jellyfin error codes to fixed SOAP faults. The upstream
 * message is deliberately ignored because it may contain credentials or a
 * server response.
 */
export function mapJellyfinErrorToSoapFault(
  error: unknown,
): SmapiSafeSoapFault {
  if (!(error instanceof JellyfinClientError)) {
    return UNKNOWN_SERVICE_FAULT;
  }

  switch (error.code) {
    case "authentication_failed":
    case "token_invalid":
      return AUTH_TOKEN_EXPIRED_FAULT;
    case "item_not_found":
      return ITEM_NOT_FOUND_FAULT;
    case "server_unreachable":
      return SERVICE_UNAVAILABLE_FAULT;
    case "invalid_input":
    case "invalid_server_response":
    case "invalid_url":
    case "insecure_url":
    case "server_rejected":
    case "unsafe_url":
      return UNKNOWN_SERVICE_FAULT;
  }
}

export async function resolveSmapiAuthenticatedContext(
  credentials: ParsedCredentials | undefined,
  dependencies: SmapiAuthenticatedContextDependencies,
): Promise<SmapiAuthenticatedContextResult> {
  const loginToken = credentials?.loginToken;
  if (
    loginToken?.token === undefined ||
    loginToken.householdId === undefined
  ) {
    return { outcome: "failure", fault: LOGIN_UNAUTHORIZED_FAULT };
  }

  let authentication: Awaited<
    ReturnType<SmapiSonosCredentialAuthenticator["authenticate"]>
  >;
  try {
    authentication = await dependencies.sonosAuthentication.authenticate({
      authToken: loginToken.token,
      householdId: loginToken.householdId,
    });
  } catch {
    return { outcome: "failure", fault: UNKNOWN_SERVICE_FAULT };
  }

  if (authentication.outcome === "failure") {
    return { outcome: "failure", fault: LOGIN_UNAUTHORIZED_FAULT };
  }

  const sonosMapping = authentication.connection;
  let connection: JellyfinConnection | null;
  try {
    connection = await dependencies.jellyfinConnections.retrieve(
      sonosMapping.jellyfinConnectionId,
    );
  } catch {
    return { outcome: "failure", fault: UNKNOWN_SERVICE_FAULT };
  }

  if (connection === null) {
    return { outcome: "failure", fault: UNKNOWN_SERVICE_FAULT };
  }

  let jellyfin: JellyfinDataClient;
  try {
    jellyfin = dependencies.createJellyfinDataClient(connection);
  } catch (error) {
    return {
      outcome: "failure",
      fault: mapJellyfinErrorToSoapFault(error),
    };
  }

  return {
    outcome: "success",
    context: {
      connection,
      jellyfin,
      sonosMapping,
    },
  };
}
