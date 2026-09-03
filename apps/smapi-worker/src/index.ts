import {
  D1JellyfinConnectionRepository,
  D1LinkRepository,
  D1SonosConnectionRepository,
} from "@sonofin/database";
import { JellyfinConnectionService } from "@sonofin/connections";
import { AesGcmTokenCipher } from "@sonofin/crypto";
import {
  JellyfinApiClient,
  type JellyfinConnection,
  type JellyfinDataClient,
} from "@sonofin/jellyfin-client";
import { LinkService } from "@sonofin/linking";
import {
  InvalidUtf8BodyError,
  readUtf8Body,
  RequestBodyTooLargeError,
  writeSmapiRequestLog,
  type SmapiLogOutcome,
  type SmapiLogReason,
  type SmapiLogSink,
} from "@sonofin/shared";
import { SonosAuthenticationService } from "@sonofin/sonos-auth";
import {
  parseSoapRequest,
  serializeGetAppLinkResponse,
  serializeGetDeviceAuthTokenResponse,
  serializeGetLastUpdateResponse,
  serializeGetMetadataResponse,
  serializeSoapFault,
  SoapRequestError,
  type SoapFaultCode,
} from "@sonofin/sonos-smapi";

import {
  mapJellyfinErrorToSoapFault,
  resolveSmapiAuthenticatedContext,
  type SmapiAuthenticatedContextDependencies,
  type SmapiAuthenticatedRequestContext,
  type SmapiSafeSoapFault,
  type SmapiSonosCredentialAuthenticator,
} from "./authenticated-context";
import {
  SmapiBrowseError,
  SonofinBrowseService,
  type SmapiBrowseService,
} from "./browse-service";

export {
  mapJellyfinErrorToSoapFault,
  resolveSmapiAuthenticatedContext,
} from "./authenticated-context";
export type {
  SmapiAuthenticatedContextDependencies,
  SmapiAuthenticatedContextResult,
  SmapiAuthenticatedRequestContext,
  SmapiJellyfinConnectionResolver,
  SmapiJellyfinDataClientFactory,
  SmapiSafeSoapFault,
  SmapiSonosCredentialAuthenticator,
} from "./authenticated-context";
export {
  SmapiBrowseError,
  SonofinBrowseService,
  type SmapiBrowseErrorCode,
  type SmapiBrowseService,
  type SmapiGetMetadataRequest,
} from "./browse-service";
export { formatJellyfinTrackAsSonosBrowseTrack } from "./track-formatter";

const DEFAULT_LINK_TTL_SECONDS = 10 * 60;
const MAX_SOAP_BODY_BYTES = 64 * 1024;
const XML_CONTENT_TYPE = "text/xml; charset=utf-8";

type SupportedMethod =
  | "getAppLink"
  | "getDeviceAuthToken"
  | "getLastUpdate"
  | "getMetadata";

interface Env {
  ALLOW_INSECURE_JELLYFIN_HTTP?: string;
  DB: D1Database;
  JELLYFIN_TOKEN_ENCRYPTION_KEY: string;
  LINK_CODE_TTL_SECONDS?: string;
  ONBOARDING_URL?: string;
  SONOS_TOKEN_FALLBACK_SIGNING_KEYS?: string;
  SONOS_TOKEN_SIGNING_KEY: string;
}

export interface SmapiLinkService {
  createPendingLink(input: {
    householdId: string;
    ttlSeconds: number;
  }): Promise<{
    expiresAt: number;
    linkCode: string;
    linkDeviceId: string;
  }>;
  claim(input: {
    householdId: string;
    linkCode: string;
    linkDeviceId?: string;
  }): Promise<
    | { outcome: "retry" }
    | { outcome: "failure"; reason: "unknown" | "expired" | "mismatch" }
    | {
      outcome: "success";
      alreadyClaimed: boolean;
      householdId: string;
      jellyfinConnectionId: string;
      linkId: string;
    }
  >;
}

export interface SmapiSonosAuthentication
  extends SmapiSonosCredentialAuthenticator {
  issue(input: {
    householdId: string;
    jellyfinConnectionId: string;
    linkId: string;
  }): Promise<
    | {
        outcome: "success";
        alreadyIssued: boolean;
        authToken: string;
        privateKey: string;
      }
    | { outcome: "failure"; reason: "superseded" }
  >;
  revoke(input: {
    authToken: string;
    householdId: string;
  }): Promise<boolean>;
}

export interface SmapiDependencies
  extends SmapiAuthenticatedContextDependencies {
  browse: SmapiBrowseService;
  links: SmapiLinkService;
  onboardingUrl: string;
  sonosAuthentication: SmapiSonosAuthentication;
  ttlSeconds?: number;
  logSink?: SmapiLogSink;
}

interface RequestResult {
  outcome: SmapiLogOutcome;
  reason?: SmapiLogReason;
  response: Response;
  soapMethod?: SupportedMethod;
}

function xmlResponse(xml: string, status = 200): Response {
  return new Response(xml, {
    headers: {
      "cache-control": "no-store",
      "content-type": XML_CONTENT_TYPE,
      "x-content-type-options": "nosniff",
    },
    status,
  });
}

function textResponse(body: string, status: number, allow?: string): Response {
  return new Response(body, {
    headers: {
      ...(allow === undefined ? {} : { allow }),
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    status,
  });
}

function soapFault(
  message: string,
  faultCode?: SoapFaultCode,
  detail?: { exceptionInfo: string; sonosError: 5 | 6 },
): Response {
  return xmlResponse(serializeSoapFault(message, faultCode, detail), 500);
}

function safeSoapFailure(
  method: SupportedMethod,
  fault: SmapiSafeSoapFault,
): RequestResult {
  return {
    outcome: fault.outcome,
    reason: fault.reason,
    response: soapFault(fault.message, fault.faultCode),
    soapMethod: method,
  };
}

const INVALID_BROWSE_PARAMETERS_FAULT = {
  faultCode: "soap:Client",
  message: "The getMetadata parameters are invalid",
  outcome: "rejected",
  reason: "invalid_parameters",
} as const satisfies SmapiSafeSoapFault;

const BROWSE_ITEM_NOT_FOUND_FAULT = {
  faultCode: "Client.ItemNotFound",
  message: "The requested item is not available",
  outcome: "rejected",
  reason: "item_not_found",
} as const satisfies SmapiSafeSoapFault;

function browseErrorToSoapFault(error: unknown): SmapiSafeSoapFault {
  if (!(error instanceof SmapiBrowseError)) {
    return mapJellyfinErrorToSoapFault(error);
  }

  switch (error.code) {
    case "invalid_parameters":
      return INVALID_BROWSE_PARAMETERS_FAULT;
    case "item_not_found":
      return BROWSE_ITEM_NOT_FOUND_FAULT;
  }
}

function isXmlContentType(value: string | null): boolean {
  if (value === null) {
    return false;
  }

  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/xml" || mediaType === "application/soap+xml";
}

function isSupportedMethod(method: string): method is SupportedMethod {
  return (
    method === "getAppLink" ||
    method === "getDeviceAuthToken" ||
    method === "getLastUpdate" ||
    method === "getMetadata"
  );
}

const GET_METADATA_PARAMETER_ORDER = [
  "id",
  "index",
  "count",
  "recursive",
] as const;

function hasValidGetMetadataParameterShape(
  parameters: Readonly<Record<string, string>>,
): boolean {
  let previousPosition = -1;
  for (const name of Object.keys(parameters)) {
    const position = GET_METADATA_PARAMETER_ORDER.indexOf(
      name as (typeof GET_METADATA_PARAMETER_ORDER)[number],
    );
    if (position < 0 || position <= previousPosition) {
      return false;
    }
    previousPosition = position;
  }

  return true;
}

function requiredParameter(
  parameters: Readonly<Record<string, string>>,
  name: string,
  maxLength: number,
): string | undefined {
  const value = parameters[name];
  if (
    value === undefined ||
    value.trim() === "" ||
    Array.from(value).length > maxLength
  ) {
    return undefined;
  }

  return value;
}

function validTtlSeconds(value: number | undefined): number {
  const ttl = value ?? DEFAULT_LINK_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 420 || ttl > 3600) {
    throw new RangeError("Link-code TTL must be an integer from 420 to 3600");
  }

  return ttl;
}

function onboardingBaseUrl(value: string): URL {
  const url = new URL(value);
  const localHttpHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
  const isSecure = url.protocol === "https:";
  const isLocalHttp =
    url.protocol === "http:" && localHttpHosts.has(url.hostname);

  if (
    (!isSecure && !isLocalHttp) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.pathname !== "/onboarding" ||
    url.search !== ""
  ) {
    throw new TypeError(
      "ONBOARDING_URL must be HTTPS, or loopback HTTP for local development",
    );
  }

  return url;
}

function invalidParameters(method: SupportedMethod): RequestResult {
  return {
    outcome: "rejected",
    reason: "invalid_soap",
    response: soapFault("The SOAP request parameters are invalid", "soap:Client"),
    soapMethod: method,
  };
}

async function handleGetAppLink(
  parameters: Readonly<Record<string, string>>,
  dependencies: SmapiDependencies,
): Promise<RequestResult> {
  const householdId = requiredParameter(parameters, "householdId", 255);
  if (householdId === undefined) {
    return invalidParameters("getAppLink");
  }

  // Validate configuration before creating state so a bad registration URL
  // cannot leave behind a pending link that Sonos never receives.
  const registrationUrl = onboardingBaseUrl(dependencies.onboardingUrl);
  const created = await dependencies.links.createPendingLink({
    householdId,
    ttlSeconds: validTtlSeconds(dependencies.ttlSeconds),
  });
  registrationUrl.searchParams.set("linkCode", created.linkCode);

  return {
    outcome: "success",
    response: xmlResponse(
      serializeGetAppLinkResponse({
        appUrlStringId: "SIGN_IN",
        linkCode: created.linkCode,
        linkDeviceId: created.linkDeviceId,
        registrationUrl: registrationUrl.toString(),
        showLinkCode: false,
      }),
    ),
    soapMethod: "getAppLink",
  };
}

async function handleGetDeviceAuthToken(
  parameters: Readonly<Record<string, string>>,
  credentials: ReturnType<typeof parseSoapRequest>["credentials"],
  dependencies: SmapiDependencies,
): Promise<RequestResult> {
  const householdId = requiredParameter(parameters, "householdId", 255);
  const linkCode = requiredParameter(parameters, "linkCode", 32);
  if (householdId === undefined || linkCode === undefined) {
    return invalidParameters("getDeviceAuthToken");
  }

  const linkDeviceId = parameters.linkDeviceId;
  const claim = await dependencies.links.claim({
    householdId,
    linkCode,
    ...(linkDeviceId === undefined ? {} : { linkDeviceId }),
  });

  if (claim.outcome === "retry") {
    return {
      outcome: "rejected",
      reason: "link_pending",
      response: soapFault(
        "Account linking is still in progress",
        "Client.NOT_LINKED_RETRY",
        {
          exceptionInfo: "Retry the device token request",
          sonosError: 5,
        },
      ),
      soapMethod: "getDeviceAuthToken",
    };
  }

  if (claim.outcome === "failure") {
    return {
      outcome: "rejected",
      reason: "link_failed",
      response: soapFault(
        "Account linking could not be completed",
        "Client.NOT_LINKED_FAILURE",
        {
          exceptionInfo: "Start account linking again",
          sonosError: 6,
        },
      ),
      soapMethod: "getDeviceAuthToken",
    };
  }

  const issued = await dependencies.sonosAuthentication.issue({
    householdId: claim.householdId,
    jellyfinConnectionId: claim.jellyfinConnectionId,
    linkId: claim.linkId,
  });
  if (issued.outcome === "failure") {
    return {
      outcome: "rejected",
      reason: "link_failed",
      response: soapFault(
        "Account linking could not be completed",
        "Client.NOT_LINKED_FAILURE",
        {
          exceptionInfo: "Start account linking again",
          sonosError: 6,
        },
      ),
      soapMethod: "getDeviceAuthToken",
    };
  }

  const priorLoginToken = credentials?.loginToken;
  if (
    priorLoginToken?.token !== undefined &&
    priorLoginToken.householdId === claim.householdId
  ) {
    const prior = await dependencies.sonosAuthentication.authenticate({
      authToken: priorLoginToken.token,
      householdId: priorLoginToken.householdId,
    });
    if (
      prior.outcome === "success" &&
      prior.connection.id !== claim.linkId
    ) {
      await dependencies.sonosAuthentication.revoke({
        authToken: priorLoginToken.token,
        householdId: priorLoginToken.householdId,
      });
    }
  }

  return {
    outcome: "success",
    response: xmlResponse(
      serializeGetDeviceAuthTokenResponse({
        authToken: issued.authToken,
        privateKey: issued.privateKey,
      }),
    ),
    soapMethod: "getDeviceAuthToken",
  };
}

function handleGetLastUpdate(
  context: SmapiAuthenticatedRequestContext,
): RequestResult {
  // The context is intentionally constructed for every authenticated request.
  // Later browse methods consume both fields; this method currently needs only
  // the authentication and connection-integrity guarantee.
  void context;
  return {
    outcome: "success",
    response: xmlResponse(
      serializeGetLastUpdateResponse({
        catalog: "1",
        favorites: "1",
        pollInterval: 120,
      }),
    ),
    soapMethod: "getLastUpdate",
  };
}

async function handleGetMetadata(
  parameters: Readonly<Record<string, string>>,
  context: SmapiAuthenticatedRequestContext,
  dependencies: SmapiDependencies,
): Promise<RequestResult> {
  try {
    if (!hasValidGetMetadataParameterShape(parameters)) {
      throw new SmapiBrowseError("invalid_parameters");
    }

    const result = await dependencies.browse.getMetadata({
      context,
      count: parameters.count,
      id: parameters.id,
      index: parameters.index,
      recursive: parameters.recursive,
    });
    return {
      outcome: "success",
      response: xmlResponse(serializeGetMetadataResponse(result)),
      soapMethod: "getMetadata",
    };
  } catch (error) {
    return safeSoapFailure(
      "getMetadata",
      browseErrorToSoapFault(error),
    );
  }
}

async function routeRequest(
  request: Request,
  dependencies: SmapiDependencies,
): Promise<RequestResult> {
  const url = new URL(request.url);

  if (url.pathname !== "/smapi") {
    return {
      outcome: "rejected",
      reason: "not_found",
      response: textResponse("Not found", 404),
    };
  }

  if (request.method !== "POST") {
    return {
      outcome: "rejected",
      reason: "method_not_allowed",
      response: textResponse("Method not allowed", 405, "POST"),
    };
  }

  if (!isXmlContentType(request.headers.get("content-type"))) {
    return {
      outcome: "rejected",
      reason: "unsupported_media_type",
      response: textResponse("Expected a SOAP XML request", 415),
    };
  }

  let body: string;
  try {
    body = await readUtf8Body(request, MAX_SOAP_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return {
        outcome: "rejected",
        reason: "payload_too_large",
        response: textResponse("Request body is too large", 413),
      };
    }

    if (error instanceof InvalidUtf8BodyError) {
      return {
        outcome: "rejected",
        reason: "invalid_soap",
        response: soapFault("The SOAP request is invalid", "soap:Client"),
      };
    }

    throw error;
  }

  let parsed: ReturnType<typeof parseSoapRequest>;
  try {
    parsed = parseSoapRequest(body, request.headers.get("soapaction"));
  } catch (error) {
    if (error instanceof SoapRequestError) {
      const fault =
        error.code === "version_mismatch"
          ? soapFault(
              "The SOAP envelope version is not supported",
              "soap:VersionMismatch",
            )
          : error.code === "must_understand"
            ? soapFault(
                "A mandatory SOAP header is not supported",
                "soap:MustUnderstand",
              )
            : soapFault("The SOAP request is invalid", "soap:Client");

      return {
        outcome: "rejected",
        reason: "invalid_soap",
        response: fault,
      };
    }

    throw error;
  }

  if (!isSupportedMethod(parsed.method)) {
    return {
      outcome: "rejected",
      reason: "unsupported_method",
      response: soapFault("The requested SMAPI method is not supported"),
    };
  }

  if (
    parsed.method === "getLastUpdate" ||
    parsed.method === "getMetadata"
  ) {
    const authenticated = await resolveSmapiAuthenticatedContext(
      parsed.credentials,
      dependencies,
    );
    if (authenticated.outcome === "failure") {
      return safeSoapFailure(parsed.method, authenticated.fault);
    }

    if (parsed.method === "getLastUpdate") {
      return handleGetLastUpdate(authenticated.context);
    }

    return handleGetMetadata(
      parsed.parameters,
      authenticated.context,
      dependencies,
    );
  }

  if (parsed.method === "getAppLink") {
    return handleGetAppLink(parsed.parameters, dependencies);
  }

  return handleGetDeviceAuthToken(
    parsed.parameters,
    parsed.credentials,
    dependencies,
  );
}

export async function handleRequest(
  request: Request,
  dependencies: SmapiDependencies,
): Promise<Response> {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  let result: RequestResult;

  try {
    result = await routeRequest(request, dependencies);
  } catch {
    result = {
      outcome: "error",
      reason: "internal_error",
      response: soapFault("The service could not process the request"),
    };
  }

  const response = new Response(result.response.body, result.response);
  response.headers.set("x-request-id", requestId);

  writeSmapiRequestLog(dependencies.logSink ?? console, {
    durationMs: Date.now() - startedAt,
    httpStatus: response.status,
    outcome: result.outcome,
    requestId,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.soapMethod === undefined
      ? {}
      : { soapMethod: result.soapMethod }),
  });

  return response;
}

function configurationFailureResponse(startedAt: number): Response {
  const requestId = crypto.randomUUID();
  const response = soapFault("The service could not process the request");
  response.headers.set("x-request-id", requestId);

  writeSmapiRequestLog(console, {
    durationMs: Date.now() - startedAt,
    httpStatus: response.status,
    outcome: "error",
    reason: "internal_error",
    requestId,
  });

  return response;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const startedAt = Date.now();
    let dependencies: SmapiDependencies;
    try {
      const now = () => Math.floor(Date.now() / 1000);
      const links = new LinkService({
        now,
        repository: new D1LinkRepository(env.DB),
      });
      const jellyfinConnections = new JellyfinConnectionService({
        cipher: new AesGcmTokenCipher(
          env.JELLYFIN_TOKEN_ENCRYPTION_KEY,
        ),
        now,
        repository: new D1JellyfinConnectionRepository(env.DB),
      });
      const sonosAuthentication = new SonosAuthenticationService({
        now,
        fallbackSigningKeys:
          env.SONOS_TOKEN_FALLBACK_SIGNING_KEYS === undefined
            ? []
            : env.SONOS_TOKEN_FALLBACK_SIGNING_KEYS.split(","),
        repository: new D1SonosConnectionRepository(env.DB),
        signingKey: env.SONOS_TOKEN_SIGNING_KEY,
      });

      dependencies = {
        browse: new SonofinBrowseService(),
        createJellyfinDataClient: (
          connection: JellyfinConnection,
        ): JellyfinDataClient =>
          new JellyfinApiClient({
            allowInsecureHttp:
              env.ALLOW_INSECURE_JELLYFIN_HTTP === "true",
            connection,
          }),
        jellyfinConnections,
        links,
        onboardingUrl: env.ONBOARDING_URL ?? "",
        sonosAuthentication,
        ttlSeconds:
          env.LINK_CODE_TTL_SECONDS === undefined
            ? DEFAULT_LINK_TTL_SECONDS
            : Number(env.LINK_CODE_TTL_SECONDS),
      };
    } catch {
      return Promise.resolve(configurationFailureResponse(startedAt));
    }

    return handleRequest(request, dependencies);
  },
} satisfies ExportedHandler<Env>;
