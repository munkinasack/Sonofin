export interface JellyfinServer {
  serverUrl: string;
  serverId: string;
  serverName: string;
  serverVersion: string;
}

export interface JellyfinConnection extends JellyfinServer {
  deviceId: string;
  userId: string;
  username: string;
  accessToken: string;
}

export interface JellyfinPasswordAuthenticationInput {
  serverUrl: string;
  username: string;
  password: string;
}

export interface JellyfinTokenAuthenticationInput {
  serverUrl: string;
  accessToken: string;
}

export interface JellyfinAuthentication {
  identifyServer(serverUrl: string): Promise<JellyfinServer>;

  authenticateWithPassword(
    input: JellyfinPasswordAuthenticationInput,
  ): Promise<JellyfinConnection>;

  authenticateWithToken(
    input: JellyfinTokenAuthenticationInput,
  ): Promise<JellyfinConnection>;

  revokeAccessToken(input: JellyfinTokenAuthenticationInput): Promise<void>;
}

export interface JellyfinAuthenticationClientOptions {
  fetch?: typeof globalThis.fetch;
  deviceId?: string;
  allowInsecureHttp?: boolean;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}
