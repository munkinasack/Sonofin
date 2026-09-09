import {
  JellyfinClientError,
  type JellyfinClientOperation,
} from "./errors";
import {
  endpoint,
  isCharacterLength,
  isJsonObject,
  JellyfinJsonTransport,
  jsonHeaders,
  normalizeServerUrl,
  readPositiveSafeInteger,
  requiredCredential,
  requiredMetadata,
  requiredObject,
} from "./transport";
import type {
  JellyfinAuthentication,
  JellyfinAuthenticationClientOptions,
  JellyfinConnection,
  JellyfinPasswordAuthenticationInput,
  JellyfinServer,
  JellyfinTokenAuthenticationInput,
} from "./types";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DEVICE_ID_CHARACTERS = 255;
const MAX_USERNAME_CHARACTERS = 255;
const MAX_PASSWORD_CHARACTERS = 4_096;
const MAX_ACCESS_TOKEN_CHARACTERS = 4_096;

interface IdentifiedServer extends JellyfinServer {
  endpointBaseUrl: string;
}

export class JellyfinAuthenticationClient implements JellyfinAuthentication {
  readonly #transport: JellyfinJsonTransport;
  readonly #deviceId: string;
  readonly #allowInsecureHttp: boolean;

  constructor(options: JellyfinAuthenticationClientOptions = {}) {
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options)
    ) {
      throw new JellyfinClientError("invalid_input");
    }
    if (
      options.allowInsecureHttp !== undefined &&
      typeof options.allowInsecureHttp !== "boolean"
    ) {
      throw new JellyfinClientError("invalid_input");
    }
    if (options.fetch !== undefined && typeof options.fetch !== "function") {
      throw new JellyfinClientError("invalid_input");
    }
    if (
      options.deviceId !== undefined &&
      (!isCharacterLength(options.deviceId, 1, MAX_DEVICE_ID_CHARACTERS) ||
        options.deviceId.trim().length === 0)
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
    this.#transport = new JellyfinJsonTransport(
      options.fetch ?? globalThis.fetch,
      requestTimeoutMs,
      maxResponseBytes,
    );
    this.#deviceId = options.deviceId ?? crypto.randomUUID();
    this.#allowInsecureHttp = options.allowInsecureHttp ?? false;
  }

  async identifyServer(serverUrl: string): Promise<JellyfinServer> {
    const identified = await this.#identifyServer(serverUrl);
    return publicServer(identified);
  }

  async authenticateWithPassword(
    input: JellyfinPasswordAuthenticationInput,
  ): Promise<JellyfinConnection> {
    if (
      !isJsonObject(input) ||
      !isCharacterLength(input.username, 1, MAX_USERNAME_CHARACTERS)
    ) {
      throw new JellyfinClientError("invalid_input");
    }
    if (!isCharacterLength(input.password, 0, MAX_PASSWORD_CHARACTERS)) {
      throw new JellyfinClientError("invalid_input");
    }

    const server = await this.#identifyServer(input.serverUrl);
    const payload = await this.#transport.requestJson(
      endpoint(server.endpointBaseUrl, "/Users/AuthenticateByName"),
      {
        method: "POST",
        headers: jsonHeaders(this.#deviceId, undefined, true),
        body: JSON.stringify({ Username: input.username, Pw: input.password }),
      },
      (status) =>
        status === 400 || status === 401 || status === 403
          ? "authentication_failed"
          : "server_rejected",
      "password_authentication",
    );
    let accessToken: string;
    let responseServerId: string;
    let userId: string;
    let username: string;
    try {
      accessToken = requiredCredential(payload, "AccessToken");
      responseServerId = requiredMetadata(payload, "ServerId");
      const user = requiredObject(payload, "User");
      userId = requiredMetadata(user, "Id");
      username = requiredMetadata(user, "Name");
    } catch (error) {
      rethrowWithOperation(error, "password_authentication");
    }

    if (responseServerId !== server.serverId) {
      throw new JellyfinClientError("invalid_server_response", {
        operation: "password_authentication",
      });
    }

    return {
      ...publicServer(server),
      deviceId: this.#deviceId,
      userId,
      username,
      accessToken,
    };
  }

  async authenticateWithToken(
    input: JellyfinTokenAuthenticationInput,
  ): Promise<JellyfinConnection> {
    if (
      !isJsonObject(input) ||
      !isCharacterLength(input.accessToken, 1, MAX_ACCESS_TOKEN_CHARACTERS) ||
      input.accessToken.trim().length === 0
    ) {
      throw new JellyfinClientError("invalid_input");
    }

    const server = await this.#identifyServer(input.serverUrl);
    const user = await this.#transport.requestJson(
      endpoint(server.endpointBaseUrl, "/Users/Me"),
      {
        method: "GET",
        headers: jsonHeaders(this.#deviceId, input.accessToken),
      },
      (status) =>
        status === 400 || status === 401 || status === 403
          ? "token_invalid"
          : "server_rejected",
      "token_authentication",
    );
    let userId: string;
    let username: string;
    try {
      userId = requiredMetadata(user, "Id");
      username = requiredMetadata(user, "Name");
      if (
        user.ServerId !== undefined &&
        requiredMetadata(user, "ServerId") !== server.serverId
      ) {
        throw new JellyfinClientError("invalid_server_response");
      }
    } catch (error) {
      rethrowWithOperation(error, "token_authentication");
    }

    return {
      ...publicServer(server),
      deviceId: this.#deviceId,
      userId,
      username,
      accessToken: input.accessToken,
    };
  }

  async revokeAccessToken(
    input: JellyfinTokenAuthenticationInput,
  ): Promise<void> {
    if (
      !isJsonObject(input) ||
      !isCharacterLength(input.accessToken, 1, MAX_ACCESS_TOKEN_CHARACTERS) ||
      input.accessToken.trim().length === 0
    ) {
      throw new JellyfinClientError("invalid_input");
    }

    const endpointBaseUrl = normalizeServerUrl(
      input.serverUrl,
      this.#allowInsecureHttp,
    );
    await this.#transport.requestWithoutResponse(
      endpoint(endpointBaseUrl, "/Sessions/Logout"),
      {
        method: "POST",
        headers: jsonHeaders(this.#deviceId, input.accessToken),
      },
      () => "server_rejected",
      "token_revocation",
    );
  }

  async #identifyServer(serverUrl: string): Promise<IdentifiedServer> {
    const endpointBaseUrl = normalizeServerUrl(
      serverUrl,
      this.#allowInsecureHttp,
    );
    const payload = await this.#transport.requestJson(
      endpoint(endpointBaseUrl, "/System/Info/Public"),
      {
        method: "GET",
        headers: jsonHeaders(this.#deviceId),
      },
      () => "server_rejected",
      "server_discovery",
    );
    try {
      if (
        requiredMetadata(payload, "ProductName").toLowerCase() !==
        "jellyfin server"
      ) {
        throw new JellyfinClientError("invalid_server_response");
      }
      return {
        endpointBaseUrl,
        serverUrl: endpointBaseUrl,
        serverId: requiredMetadata(payload, "Id"),
        serverName: requiredMetadata(payload, "ServerName"),
        serverVersion: requiredMetadata(payload, "Version"),
      };
    } catch (error) {
      rethrowWithOperation(error, "server_discovery");
    }
  }
}

function rethrowWithOperation(
  error: unknown,
  operation: JellyfinClientOperation,
): never {
  if (error instanceof JellyfinClientError && error.operation === undefined) {
    throw new JellyfinClientError(error.code, { operation });
  }
  throw error;
}

function publicServer(server: IdentifiedServer): JellyfinServer {
  return {
    serverUrl: server.serverUrl,
    serverId: server.serverId,
    serverName: server.serverName,
    serverVersion: server.serverVersion,
  };
}
