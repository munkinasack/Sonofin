import { JellyfinConnectionService } from "@sonofin/connections";
import { AesGcmTokenCipher } from "@sonofin/crypto";
import {
  D1JellyfinConnectionRepository,
  D1LinkRepository,
} from "@sonofin/database";
import {
  JellyfinAuthenticationClient,
  JellyfinClientError,
  type JellyfinAuthentication,
  type JellyfinClientErrorCode,
  type JellyfinClientOperation,
  type JellyfinConnection,
} from "@sonofin/jellyfin-client";
import {
  LinkService,
  type CompleteLinkResult,
  type LinkState,
} from "@sonofin/linking";
import {
  InvalidUtf8BodyError,
  readUtf8Body,
  RequestBodyTooLargeError,
} from "@sonofin/shared";

const FORM_BODY_LIMIT_BYTES = 8 * 1024;

interface Env {
  DB: D1Database;
  JELLYFIN_TOKEN_ENCRYPTION_KEY: string;
  ALLOW_INSECURE_JELLYFIN_HTTP?: string;
}

export interface OnboardingLinkService {
  getOnboardingState(linkCode: string): Promise<LinkState>;
  isConnectionAssociated(input: {
    linkCode: string;
    jellyfinConnectionId: string;
  }): Promise<boolean>;
  completeWithConnection(input: {
    linkCode: string;
    jellyfinConnectionId: string;
  }): Promise<CompleteLinkResult>;
}

export interface OnboardingConnectionStorage {
  store(connection: JellyfinConnection): Promise<{ connectionId: string }>;
  delete(connectionId: string): Promise<boolean>;
}

export interface OnboardingJellyfinFailure {
  code: JellyfinClientErrorCode;
  operation: JellyfinClientOperation | "not_available";
  upstreamStatus: number | null;
}

export interface OnboardingDiagnostics {
  jellyfinAuthenticationFailed(failure: OnboardingJellyfinFailure): void;
}

const NOOP_DIAGNOSTICS: OnboardingDiagnostics = {
  jellyfinAuthenticationFailed(): void {},
};

const CONSOLE_DIAGNOSTICS: OnboardingDiagnostics = {
  jellyfinAuthenticationFailed(failure): void {
    console.warn(
      JSON.stringify({
        event: "onboarding_jellyfin_failure",
        ...failure,
      }),
    );
  },
};

function securityHeaders(contentType: string, scriptNonce?: string): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" +
      (scriptNonce === undefined ? "" : `; script-src 'nonce-${scriptNonce}'`),
    "content-type": contentType,
    "permissions-policy":
      "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

function responseWithRequestId(response: Response, requestId: string): Response {
  const result = new Response(response.body, response);
  result.headers.set("x-request-id", requestId);
  return result;
}

function textResponse(body: string, status: number, allow?: string): Response {
  const headers = securityHeaders("text/plain; charset=utf-8");
  if (allow !== undefined) {
    headers.set("allow", allow);
  }

  return new Response(body, { headers, status });
}

function htmlResponse(
  body: string,
  status = 200,
  scriptNonce?: string,
): Response {
  return new Response(body, {
    headers: securityHeaders("text/html; charset=utf-8", scriptNonce),
    status,
  });
}

function redirectToOnboarding(linkCode: string): Response {
  const location = `/onboarding?linkCode=${encodeURIComponent(linkCode)}`;
  const headers = securityHeaders("text/plain; charset=utf-8");
  headers.set("location", location);
  return new Response(null, { headers, status: 303 });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, content: string): string {
  return (
    "<!doctype html>" +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title)} · Sonofin 2.0</title></head>` +
    `<body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`
  );
}

interface PendingPageValues {
  serverUrl?: string;
  username?: string;
}

function pendingPage(
  linkCode: string,
  options: {
    error?: string;
    status?: number;
    values?: PendingPageValues;
  } = {},
): Response {
  const error =
    options.error === undefined
      ? ""
      : `<p role="alert">${escapeHtml(options.error)}</p>`;
  const serverUrl = escapeHtml(options.values?.serverUrl ?? "");
  const username = escapeHtml(options.values?.username ?? "");

  return htmlResponse(
    page(
      "Connect Sonofin",
      "<p>Enter your Jellyfin server and either your username and password " +
        "or an existing access token. Sonofin exchanges your password for a " +
        "token and does not retain the password.</p>" +
        error +
        '<form method="post" action="/onboarding">' +
        `<input type="hidden" name="linkCode" value="${escapeHtml(linkCode)}">` +
        '<p><label for="serverUrl">Jellyfin server URL</label><br>' +
        `<input id="serverUrl" name="serverUrl" type="url" maxlength="2048" ` +
        `autocomplete="url" required value="${serverUrl}" ` +
        'placeholder="https://jellyfin.example.com"></p>' +
        '<fieldset><legend>Sign in with a Jellyfin account</legend>' +
        '<p><label for="username">Username</label><br>' +
        `<input id="username" name="username" maxlength="255" ` +
        `autocomplete="username" value="${username}"></p>` +
        '<p><label for="password">Password</label><br>' +
        '<input id="password" name="password" type="password" maxlength="2048" ' +
        'autocomplete="current-password"></p></fieldset>' +
        '<p><strong>Or</strong></p>' +
        '<p><label for="accessToken">Existing Jellyfin access token</label><br>' +
        '<input id="accessToken" name="accessToken" type="password" maxlength="4096" ' +
        'autocomplete="off"></p>' +
        '<button type="submit">Connect Jellyfin</button></form>',
    ),
    options.status,
  );
}

function completedPage(): Response {
  const scriptNonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
  );
  return htmlResponse(
    page(
      "Connection complete",
      "<p>Your Jellyfin connection is stored securely. " +
        "If this page stays open, switch back to the Sonos app to continue.</p>" +
        `<script nonce="${scriptNonce}">window.close()</script>`,
    ),
    200,
    scriptNonce,
  );
}

function linkStateResponse(state: LinkState, linkCode: string): Response {
  switch (state) {
    case "pending":
      return pendingPage(linkCode);
    case "complete":
    case "claimed":
      return completedPage();
    case "expired":
      return htmlResponse(
        page(
          "Link expired",
          "<p>Return to the Sonos app and start the connection again.</p>",
        ),
        410,
      );
    case "invalid":
      return htmlResponse(
        page("Link not found", "<p>This onboarding link is not valid.</p>"),
        404,
      );
  }
}

function singleLinkCode(values: URLSearchParams): string | undefined {
  const linkCodes = values.getAll("linkCode");
  if (linkCodes.length !== 1) {
    return undefined;
  }

  for (const key of values.keys()) {
    if (key !== "linkCode") {
      return undefined;
    }
  }

  const linkCode = linkCodes[0];
  return linkCode === undefined || linkCode === "" ? undefined : linkCode;
}

function isFormContentType(value: string | null): boolean {
  return (
    value?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/x-www-form-urlencoded"
  );
}

interface OnboardingSubmission {
  linkCode: string;
  serverUrl: string;
  username: string;
}

const FORM_FIELDS = new Set([
  "accessToken",
  "linkCode",
  "password",
  "serverUrl",
  "username",
]);

function parseSubmission(values: URLSearchParams): OnboardingSubmission | null {
  for (const key of values.keys()) {
    if (!FORM_FIELDS.has(key) || values.getAll(key).length !== 1) {
      return null;
    }
  }

  const linkCode = values.get("linkCode");
  const serverUrl = values.get("serverUrl");
  if (linkCode === null || linkCode === "" || serverUrl === null) {
    return null;
  }

  return {
    linkCode,
    serverUrl,
    username: values.get("username") ?? "",
  };
}

function authenticationErrorResponse(
  error: JellyfinClientError,
  linkCode: string,
  values: PendingPageValues,
): Response {
  switch (error.code) {
    case "invalid_url":
    case "insecure_url":
    case "unsafe_url":
    case "invalid_input":
      return pendingPage(linkCode, {
        error: error.message,
        status: 400,
      });
    case "authentication_failed":
    case "token_invalid":
      return pendingPage(linkCode, {
        error: "Jellyfin rejected those credentials.",
        status: 401,
        values,
      });
    case "server_rejected":
    case "server_unreachable":
    case "invalid_server_response":
    case "item_not_found":
      return pendingPage(linkCode, {
        error: "Sonofin could not verify that Jellyfin server.",
        status: 502,
        values,
      });
  }
}

type AuthenticationAttempt =
  | {
      outcome: "success";
      connection: JellyfinConnection;
      method: "password" | "token";
    }
  | { outcome: "response"; response: Response };

async function authenticateConnection(
  form: URLSearchParams,
  submission: OnboardingSubmission,
  jellyfin: JellyfinAuthentication,
  diagnostics: OnboardingDiagnostics,
): Promise<AuthenticationAttempt> {
  const password = form.get("password") ?? "";
  const accessToken = form.get("accessToken") ?? "";
  form.delete("password");
  form.delete("accessToken");

  const publicValues = {
    serverUrl: submission.serverUrl,
    username: submission.username,
  };
  try {
    if (accessToken !== "") {
      if (submission.username !== "" || password !== "") {
        return {
          outcome: "response",
          response: pendingPage(submission.linkCode, {
            error:
              "Use either username and password or an access token, not both.",
            status: 400,
          }),
        };
      }
      const connection = await jellyfin.authenticateWithToken({
        accessToken,
        serverUrl: submission.serverUrl,
      });
      return {
        connection,
        method: "token",
        outcome: "success",
      };
    } else {
      if (submission.username === "") {
        return {
          outcome: "response",
          response: pendingPage(submission.linkCode, {
            error: "Enter a username or an access token.",
            status: 400,
          }),
        };
      }
      const connection = await jellyfin.authenticateWithPassword({
        password,
        serverUrl: submission.serverUrl,
        username: submission.username,
      });
      return { connection, method: "password", outcome: "success" };
    }
  } catch (error) {
    if (error instanceof JellyfinClientError) {
      try {
        diagnostics.jellyfinAuthenticationFailed({
          code: error.code,
          operation: error.operation ?? "not_available",
          upstreamStatus: error.upstreamStatus ?? null,
        });
      } catch {
        // Diagnostics must never change the credential-handling path.
      }
      return {
        outcome: "response",
        response: authenticationErrorResponse(
          error,
          submission.linkCode,
          publicValues,
        ),
      };
    }
    throw error;
  }
}

async function discardFailedConnection(
  authentication: Extract<AuthenticationAttempt, { outcome: "success" }>,
  connectionId: string | undefined,
  linkCode: string,
  links: OnboardingLinkService,
  connections: OnboardingConnectionStorage,
  jellyfin: JellyfinAuthentication,
): Promise<void> {
  if (connectionId !== undefined) {
    const associated = await links.isConnectionAssociated({
      jellyfinConnectionId: connectionId,
      linkCode,
    });
    if (associated) {
      return;
    }
  }

  if (authentication.method === "password") {
    await jellyfin.revokeAccessToken({
      accessToken: authentication.connection.accessToken,
      serverUrl: authentication.connection.serverUrl,
    });
  }

  if (connectionId !== undefined) {
    await connections.delete(connectionId);
  }
}

async function handleGet(
  url: URL,
  links: OnboardingLinkService,
): Promise<Response> {
  const linkCode = singleLinkCode(url.searchParams);
  if (linkCode === undefined) {
    return textResponse("A single linkCode is required", 400);
  }

  const state = await links.getOnboardingState(linkCode);
  return linkStateResponse(state, linkCode);
}

async function handlePost(
  request: Request,
  links: OnboardingLinkService,
  jellyfin: JellyfinAuthentication,
  connections: OnboardingConnectionStorage,
  diagnostics: OnboardingDiagnostics,
): Promise<Response> {
  if (!isFormContentType(request.headers.get("content-type"))) {
    return textResponse("Expected a form submission", 415);
  }

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(
      await readUtf8Body(request, FORM_BODY_LIMIT_BYTES),
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return textResponse("Form submission is too large", 413);
    }

    if (error instanceof InvalidUtf8BodyError) {
      return textResponse("Form submission is invalid", 400);
    }

    throw error;
  }

  const submission = parseSubmission(form);
  if (submission === null) {
    form.delete("password");
    form.delete("accessToken");
    return textResponse("The form submission is invalid", 400);
  }

  const state = await links.getOnboardingState(submission.linkCode);
  if (state !== "pending") {
    form.delete("password");
    form.delete("accessToken");
    return linkStateResponse(state, submission.linkCode);
  }

  const authentication = await authenticateConnection(
    form,
    submission,
    jellyfin,
    diagnostics,
  );
  if (authentication.outcome === "response") {
    return authentication.response;
  }

  let connectionId: string | undefined;
  let completed = false;
  try {
    const stored = await connections.store(authentication.connection);
    connectionId = stored.connectionId;
    const completion = await links.completeWithConnection({
      jellyfinConnectionId: connectionId,
      linkCode: submission.linkCode,
    });

    if (completion.outcome === "success") {
      completed = true;
      return redirectToOnboarding(submission.linkCode);
    }

    if (completion.reason === "expired") {
      return textResponse("This onboarding link has expired", 410);
    }

    if (completion.reason === "connection_mismatch") {
      return textResponse("This onboarding link was already completed", 409);
    }

    return textResponse("This onboarding link is not valid", 404);
  } finally {
    if (!completed) {
      await discardFailedConnection(
        authentication,
        connectionId,
        submission.linkCode,
        links,
        connections,
        jellyfin,
      );
    }
  }
}

async function routeRequest(
  request: Request,
  links: OnboardingLinkService,
  jellyfin: JellyfinAuthentication,
  connections: OnboardingConnectionStorage,
  diagnostics: OnboardingDiagnostics,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/onboarding") {
    return textResponse("Not found", 404);
  }

  if (request.method === "GET") {
    return handleGet(url, links);
  }

  if (request.method === "POST") {
    return handlePost(request, links, jellyfin, connections, diagnostics);
  }

  return textResponse("Method not allowed", 405, "GET, POST");
}

export async function handleRequest(
  request: Request,
  links: OnboardingLinkService,
  jellyfin: JellyfinAuthentication,
  connections: OnboardingConnectionStorage,
  diagnostics: OnboardingDiagnostics = NOOP_DIAGNOSTICS,
): Promise<Response> {
  const requestId = crypto.randomUUID();

  try {
    return responseWithRequestId(
      await routeRequest(request, links, jellyfin, connections, diagnostics),
      requestId,
    );
  } catch {
    return responseWithRequestId(
      textResponse("The onboarding service could not process the request", 500),
      requestId,
    );
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const links = new LinkService({
      now: () => Math.floor(Date.now() / 1000),
      repository: new D1LinkRepository(env.DB),
    });
    const jellyfin = new JellyfinAuthenticationClient({
      allowInsecureHttp: env.ALLOW_INSECURE_JELLYFIN_HTTP === "true",
    });
    const connections = new JellyfinConnectionService({
      cipher: new AesGcmTokenCipher(env.JELLYFIN_TOKEN_ENCRYPTION_KEY),
      now: () => Math.floor(Date.now() / 1000),
      repository: new D1JellyfinConnectionRepository(env.DB),
    });
    return handleRequest(
      request,
      links,
      jellyfin,
      connections,
      CONSOLE_DIAGNOSTICS,
    );
  },
} satisfies ExportedHandler<Env>;
