import { describe, expect, it } from "vitest";

import {
  JellyfinAuthenticationClient,
  JellyfinClientError,
  type JellyfinClientErrorCode,
  type JellyfinConnection,
  type JellyfinServer,
} from "../src";

const SERVER_PAYLOAD = {
  Id: "server-id",
  ProductName: "Jellyfin Server",
  ServerName: "Living Room",
  Version: "10.11.0",
};

const NORMALIZED_SERVER: JellyfinServer = {
  serverUrl: "https://media.example.com/jellyfin",
  serverId: "server-id",
  serverName: "Living Room",
  serverVersion: "10.11.0",
};

const TEST_DEVICE_ID = "test-device-id";
const CLIENT_IDENTITY =
  'MediaBrowser Client="Sonofin", Device="Cloudflare Worker", ' +
  `DeviceId="${TEST_DEVICE_ID}", Version="0.0.0"`;
const CLIENT_AUTHORIZATION = `${CLIENT_IDENTITY}, Token=""`;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

type FetchScript =
  | Response
  | Error
  | ((url: string, init: RequestInit | undefined) => Response | Promise<Response>);

function scriptedFetch(...scripts: FetchScript[]): {
  calls: FetchCall[];
  fetch: typeof globalThis.fetch;
} {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const script = scripts[index];
    index += 1;
    if (script === undefined) {
      throw new Error("Unexpected fetch call");
    }
    if (script instanceof Error) {
      throw script;
    }
    return typeof script === "function" ? script(url, init) : script;
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders,
  });
}

async function expectErrorCode(
  promise: Promise<unknown>,
  code: JellyfinClientErrorCode,
): Promise<JellyfinClientError> {
  const caught = await promise.catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(JellyfinClientError);
  expect(caught).toMatchObject({ code, name: "JellyfinClientError" });
  return caught as JellyfinClientError;
}

function headersOf(call: FetchCall | undefined): Headers {
  expect(call).toBeDefined();
  return new Headers(call?.init?.headers);
}

describe("JellyfinAuthenticationClient server discovery", () => {
  it("normalizes an HTTPS base URL and preserves a Jellyfin subpath", async () => {
    const transport = scriptedFetch(jsonResponse(SERVER_PAYLOAD));
    const client = new JellyfinAuthenticationClient({
      deviceId: TEST_DEVICE_ID,
      fetch: transport.fetch,
    });

    await expect(
      client.identifyServer("  https://MEDIA.EXAMPLE.COM:443/jellyfin///  "),
    ).resolves.toEqual(NORMALIZED_SERVER);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe(
      "https://media.example.com/jellyfin/System/Info/Public",
    );
    expect(transport.calls[0]?.init).toMatchObject({
      method: "GET",
      redirect: "manual",
    });
    expect(transport.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    const headers = headersOf(transport.calls[0]);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe(CLIENT_AUTHORIZATION);
    expect(headers.has("content-type")).toBe(false);
  });

  it("normalizes a root URL without leaving a trailing slash", async () => {
    const transport = scriptedFetch(jsonResponse(SERVER_PAYLOAD));
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    await expect(
      client.identifyServer("https://media.example.com/"),
    ).resolves.toMatchObject({ serverUrl: "https://media.example.com" });
    expect(transport.calls[0]?.url).toBe(
      "https://media.example.com/System/Info/Public",
    );
  });

  it("uses a fresh UUID DeviceId for each client by default", async () => {
    const firstTransport = scriptedFetch(jsonResponse(SERVER_PAYLOAD));
    const secondTransport = scriptedFetch(jsonResponse(SERVER_PAYLOAD));
    const first = new JellyfinAuthenticationClient({
      fetch: firstTransport.fetch,
    });
    const second = new JellyfinAuthenticationClient({
      fetch: secondTransport.fetch,
    });

    await Promise.all([
      first.identifyServer("https://media.example.com"),
      second.identifyServer("https://media.example.com"),
    ]);
    const firstAuthorization = headersOf(firstTransport.calls[0]).get(
      "authorization",
    );
    const secondAuthorization = headersOf(secondTransport.calls[0]).get(
      "authorization",
    );
    expect(firstAuthorization).toMatch(
      /DeviceId="[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/u,
    );
    expect(secondAuthorization).not.toBe(firstAuthorization);
  });

  it("percent-encodes an injected DeviceId before putting it in a header", async () => {
    const transport = scriptedFetch(jsonResponse(SERVER_PAYLOAD));
    const client = new JellyfinAuthenticationClient({
      deviceId: 'device", Token="injected!',
      fetch: transport.fetch,
    });

    await client.identifyServer("https://media.example.com");

    expect(headersOf(transport.calls[0]).get("authorization")).toBe(
      'MediaBrowser Client="Sonofin", Device="Cloudflare Worker", ' +
        'DeviceId="device%22%2C%20Token%3D%22injected%21", ' +
        'Version="0.0.0", Token=""',
    );
  });

  it("requires HTTPS unless insecure HTTP is explicitly enabled", async () => {
    const rejectedTransport = scriptedFetch(jsonResponse(SERVER_PAYLOAD));
    const defaultClient = new JellyfinAuthenticationClient({
      fetch: rejectedTransport.fetch,
    });
    await expectErrorCode(
      defaultClient.identifyServer("http://media.example.com/jellyfin"),
      "insecure_url",
    );
    expect(rejectedTransport.calls).toHaveLength(0);

    const allowedTransport = scriptedFetch(jsonResponse(SERVER_PAYLOAD));
    const localDevelopmentClient = new JellyfinAuthenticationClient({
      allowInsecureHttp: true,
      fetch: allowedTransport.fetch,
    });
    await expect(
      localDevelopmentClient.identifyServer(
        "http://media.example.com:8096/jellyfin/",
      ),
    ).resolves.toMatchObject({
      serverUrl: "http://media.example.com:8096/jellyfin",
    });
    expect(allowedTransport.calls[0]?.url).toBe(
      "http://media.example.com:8096/jellyfin/System/Info/Public",
    );
  });

  it.each([
    ["", "invalid_url"],
    ["media.example.com", "invalid_url"],
    ["ftp://media.example.com", "invalid_url"],
    ["https://user:password@media.example.com", "unsafe_url"],
    ["https://media.example.com?mode=test", "invalid_url"],
    ["https://media.example.com?", "invalid_url"],
    ["https://media.example.com/#section", "invalid_url"],
    ["https://localhost:8096", "unsafe_url"],
    ["https://jellyfin", "unsafe_url"],
    ["https://jellyfin.localhost", "unsafe_url"],
    ["https://jellyfin.local", "unsafe_url"],
    ["https://jellyfin.lan", "unsafe_url"],
    ["https://jellyfin.localdomain", "unsafe_url"],
    ["https://jellyfin.home", "unsafe_url"],
    ["https://10.0.0.4", "unsafe_url"],
    ["https://127.1", "unsafe_url"],
    ["https://169.254.1.1", "unsafe_url"],
    ["https://172.16.0.1", "unsafe_url"],
    ["https://192.168.1.20", "unsafe_url"],
    ["https://[::1]", "unsafe_url"],
    ["https://[fd00::1]", "unsafe_url"],
    ["https://[fe80::1]", "unsafe_url"],
    ["https://[::ffff:192.168.1.1]", "unsafe_url"],
  ] as const)("rejects unsafe URL %s", async (url, code) => {
    const transport = scriptedFetch(jsonResponse(SERVER_PAYLOAD));
    const client = new JellyfinAuthenticationClient({
      allowInsecureHttp: true,
      fetch: transport.fetch,
    });

    await expectErrorCode(client.identifyServer(url), code);
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects discovery redirects and non-success statuses without a second request", async () => {
    for (const status of [301, 307, 404, 503]) {
      const transport = scriptedFetch(
        new Response(null, {
          status,
          headers: { location: "https://redirect.example.com/jellyfin" },
        }),
      );
      const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

      await expectErrorCode(
        client.identifyServer("https://media.example.com"),
        "server_rejected",
      );
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]?.init?.redirect).toBe("manual");
    }
  });

  it.each([
    {},
    {
      Id: "",
      ProductName: "Jellyfin Server",
      ServerName: "name",
      Version: "version",
    },
    { Id: "id", ProductName: "Jellyfin Server", Version: "version" },
    {
      Id: "id",
      ProductName: "Jellyfin Server",
      ServerName: "name",
      Version: 10,
    },
  ])("requires all public server identity fields", async (payload) => {
    const transport = scriptedFetch(jsonResponse(payload));
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    await expectErrorCode(
      client.identifyServer("https://media.example.com"),
      "invalid_server_response",
    );
  });

  it.each([undefined, "", "Some Other Media Server", 42])(
    "rejects a server that does not identify its product as Jellyfin: %s",
    async (productName) => {
      const payload: Record<string, unknown> = { ...SERVER_PAYLOAD };
      if (productName === undefined) {
        delete payload.ProductName;
      } else {
        payload.ProductName = productName;
      }
      const transport = scriptedFetch(jsonResponse(payload));
      const client = new JellyfinAuthenticationClient({
        fetch: transport.fetch,
      });

      await expectErrorCode(
        client.identifyServer("https://media.example.com"),
        "invalid_server_response",
      );
    },
  );
});

describe("JellyfinAuthenticationClient password authentication", () => {
  it("authenticates with the official body/header and permits a passwordless user", async () => {
    const transport = scriptedFetch(
      jsonResponse(SERVER_PAYLOAD),
      jsonResponse({
        AccessToken: "issued-access-token",
        ServerId: "server-id",
        User: { Id: "user-id", Name: "Music Fan" },
      }),
    );
    const client = new JellyfinAuthenticationClient({
      deviceId: TEST_DEVICE_ID,
      fetch: transport.fetch,
    });

    const expected: JellyfinConnection = {
      ...NORMALIZED_SERVER,
      deviceId: TEST_DEVICE_ID,
      userId: "user-id",
      username: "Music Fan",
      accessToken: "issued-access-token",
    };
    await expect(
      client.authenticateWithPassword({
        serverUrl: "https://media.example.com/jellyfin/",
        username: "Music Fan",
        password: "",
      }),
    ).resolves.toEqual(expected);

    expect(transport.calls.map((call) => call.url)).toEqual([
      "https://media.example.com/jellyfin/System/Info/Public",
      "https://media.example.com/jellyfin/Users/AuthenticateByName",
    ]);
    const authenticationCall = transport.calls[1];
    expect(authenticationCall?.init).toMatchObject({
      method: "POST",
      redirect: "manual",
      body: JSON.stringify({ Username: "Music Fan", Pw: "" }),
    });
    const headers = headersOf(authenticationCall);
    expect(headers.get("authorization")).toBe(CLIENT_AUTHORIZATION);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("preserves credentials exactly in the JSON request without retaining them in output", async () => {
    const password = "  p@ss\"word  ";
    const transport = scriptedFetch(
      jsonResponse(SERVER_PAYLOAD),
      jsonResponse({
        AccessToken: "new-token",
        ServerId: "server-id",
        User: { Id: "user-id", Name: "server-selected-name" },
      }),
    );
    const client = new JellyfinAuthenticationClient({
      deviceId: TEST_DEVICE_ID,
      fetch: transport.fetch,
    });

    const connection = await client.authenticateWithPassword({
      serverUrl: "https://media.example.com/jellyfin",
      username: "  exact user  ",
      password,
    });

    expect(transport.calls[1]?.init?.body).toBe(
      JSON.stringify({ Username: "  exact user  ", Pw: password }),
    );
    expect(JSON.stringify(connection)).not.toContain(password);
    expect(connection.username).toBe("server-selected-name");
  });

  it("requires the authentication response to match the discovered server", async () => {
    const transport = scriptedFetch(
      jsonResponse(SERVER_PAYLOAD),
      jsonResponse({
        AccessToken: "token",
        ServerId: "different-server",
        User: { Id: "user-id", Name: "name" },
      }),
    );
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    await expectErrorCode(
      client.authenticateWithPassword({
        serverUrl: "https://media.example.com",
        username: "name",
        password: "password",
      }),
      "invalid_server_response",
    );
  });

  it.each([
    {},
    { AccessToken: "", ServerId: "server-id", User: { Id: "u", Name: "n" } },
    {
      AccessToken: String.fromCharCode(0xd800),
      ServerId: "server-id",
      User: { Id: "u", Name: "n" },
    },
    { AccessToken: "t", User: { Id: "u", Name: "n" } },
    { AccessToken: "t", ServerId: "server-id" },
    { AccessToken: "t", ServerId: "server-id", User: { Name: "n" } },
    { AccessToken: "t", ServerId: "server-id", User: { Id: "u" } },
  ])("validates required password-authentication fields", async (payload) => {
    const transport = scriptedFetch(
      jsonResponse(SERVER_PAYLOAD),
      jsonResponse(payload),
    );
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    await expectErrorCode(
      client.authenticateWithPassword({
        serverUrl: "https://media.example.com",
        username: "name",
        password: "password",
      }),
      "invalid_server_response",
    );
  });

  it.each([
    [400, "authentication_failed"],
    [401, "authentication_failed"],
    [403, "authentication_failed"],
    [429, "server_rejected"],
    [302, "server_rejected"],
    [500, "server_rejected"],
  ] as const)("maps password status %i to %s", async (status, code) => {
    const transport = scriptedFetch(
      jsonResponse(SERVER_PAYLOAD),
      new Response("untrusted status body", { status }),
    );
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    await expectErrorCode(
      client.authenticateWithPassword({
        serverUrl: "https://media.example.com",
        username: "name",
        password: "password",
      }),
      code,
    );
    expect(transport.calls).toHaveLength(2);
  });
});

describe("JellyfinAuthenticationClient direct-token authentication", () => {
  it("validates the token with Users/Me and percent-encodes its authorization value", async () => {
    const accessToken = "tok\"en, /!*'()";
    const transport = scriptedFetch(
      jsonResponse(SERVER_PAYLOAD),
      jsonResponse({
        Id: "user-id",
        Name: "Token User",
        ServerId: "server-id",
      }),
    );
    const client = new JellyfinAuthenticationClient({
      deviceId: TEST_DEVICE_ID,
      fetch: transport.fetch,
    });

    await expect(
      client.authenticateWithToken({
        serverUrl: "https://media.example.com/jellyfin/",
        accessToken,
      }),
    ).resolves.toEqual({
      ...NORMALIZED_SERVER,
      deviceId: TEST_DEVICE_ID,
      userId: "user-id",
      username: "Token User",
      accessToken,
    });

    expect(transport.calls.map((call) => call.url)).toEqual([
      "https://media.example.com/jellyfin/System/Info/Public",
      "https://media.example.com/jellyfin/Users/Me",
    ]);
    expect(headersOf(transport.calls[0]).get("authorization")).toBe(
      CLIENT_AUTHORIZATION,
    );
    expect(headersOf(transport.calls[1]).get("authorization")).toBe(
      `${CLIENT_IDENTITY}, Token="tok%22en%2C%20%2F%21%2A%27%28%29"`,
    );
    expect(transport.calls[1]?.init).toMatchObject({
      method: "GET",
      redirect: "manual",
    });
    expect(transport.calls[1]?.init?.body).toBeUndefined();
  });

  it.each([
    [401, "token_invalid"],
    [403, "token_invalid"],
    [400, "token_invalid"],
    [302, "server_rejected"],
    [500, "server_rejected"],
  ] as const)("maps token-validation status %i to %s", async (status, code) => {
    const transport = scriptedFetch(
      jsonResponse(SERVER_PAYLOAD),
      new Response(null, { status }),
    );
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    await expectErrorCode(
      client.authenticateWithToken({
        serverUrl: "https://media.example.com",
        accessToken: "access-token",
      }),
      code,
    );
  });

  it.each([
    {},
    { Id: "", Name: "name" },
    { Id: "user-id" },
    { Id: 7, Name: "name" },
  ])("validates the Users/Me response", async (payload) => {
    const transport = scriptedFetch(
      jsonResponse(SERVER_PAYLOAD),
      jsonResponse(payload),
    );
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    await expectErrorCode(
      client.authenticateWithToken({
        serverUrl: "https://media.example.com",
        accessToken: "access-token",
      }),
      "invalid_server_response",
    );
  });

  it("rejects a Users/Me response that names a different server", async () => {
    const transport = scriptedFetch(
      jsonResponse(SERVER_PAYLOAD),
      jsonResponse({
        Id: "user-id",
        Name: "Token User",
        ServerId: "different-server",
      }),
    );
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    await expectErrorCode(
      client.authenticateWithToken({
        serverUrl: "https://media.example.com",
        accessToken: "access-token",
      }),
      "invalid_server_response",
    );
  });
});

describe("JellyfinAuthenticationClient access-token revocation", () => {
  it("logs out the supplied token without discovery or a response body", async () => {
    const accessToken = "tok\"en, /!*'()";
    const transport = scriptedFetch(new Response(null, { status: 204 }));
    const client = new JellyfinAuthenticationClient({
      deviceId: TEST_DEVICE_ID,
      fetch: transport.fetch,
    });

    await expect(
      client.revokeAccessToken({
        serverUrl: "https://media.example.com/jellyfin/",
        accessToken,
      }),
    ).resolves.toBeUndefined();

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe(
      "https://media.example.com/jellyfin/Sessions/Logout",
    );
    expect(transport.calls[0]?.init).toMatchObject({
      method: "POST",
      redirect: "manual",
    });
    expect(transport.calls[0]?.init?.body).toBeUndefined();
    expect(headersOf(transport.calls[0]).get("authorization")).toBe(
      `${CLIENT_IDENTITY}, Token="tok%22en%2C%20%2F%21%2A%27%28%29"`,
    );
  });

  it.each([302, 400, 401, 403, 500])(
    "maps logout status %i to server_rejected without following redirects",
    async (status) => {
      const token = "logout-token-must-not-leak";
      const transport = scriptedFetch(
        new Response(`untrusted ${token}`, {
          headers: { location: "https://redirect.example.test" },
          status,
        }),
      );
      const client = new JellyfinAuthenticationClient({
        deviceId: TEST_DEVICE_ID,
        fetch: transport.fetch,
      });

      const error = await expectErrorCode(
        client.revokeAccessToken({
          serverUrl: "https://media.example.com",
          accessToken: token,
        }),
        "server_rejected",
      );

      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]?.init?.redirect).toBe("manual");
      expect(`${error.message} ${error.stack ?? ""}`).not.toContain(token);
    },
  );

  it("validates revocation input before contacting the server", async () => {
    const transport = scriptedFetch();
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    await expectErrorCode(
      client.revokeAccessToken({
        serverUrl: "https://media.example.com",
        accessToken: "",
      }),
      "invalid_input",
    );
    await expectErrorCode(
      client.revokeAccessToken({
        serverUrl: "https://user:password@media.example.com",
        accessToken: "access-token",
      }),
      "unsafe_url",
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("applies the request timeout while revoking a token", async () => {
    const fetch = (() =>
      new Promise<Response>(() => {})) as typeof globalThis.fetch;
    const client = new JellyfinAuthenticationClient({
      fetch,
      requestTimeoutMs: 5,
    });

    await expectErrorCode(
      client.revokeAccessToken({
        serverUrl: "https://media.example.com",
        accessToken: "access-token",
      }),
      "server_unreachable",
    );
  });
});

describe("JellyfinAuthenticationClient input and transport bounds", () => {
  it("validates credential inputs while keeping an empty password valid", async () => {
    const cases: Array<Promise<unknown>> = [];
    const transport = scriptedFetch();
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });
    cases.push(
      client.authenticateWithPassword({
        serverUrl: "https://media.example.com",
        username: "",
        password: "",
      }),
      client.authenticateWithPassword({
        serverUrl: "https://media.example.com",
        username: "x".repeat(256),
        password: "",
      }),
      client.authenticateWithPassword({
        serverUrl: "https://media.example.com",
        username: "name",
        password: "x".repeat(4_097),
      }),
      client.authenticateWithToken({
        serverUrl: "https://media.example.com",
        accessToken: "",
      }),
      client.authenticateWithToken({
        serverUrl: "https://media.example.com",
        accessToken: "   ",
      }),
      client.authenticateWithToken({
        serverUrl: "https://media.example.com",
        accessToken: "x".repeat(4_097),
      }),
      client.authenticateWithToken({
        serverUrl: "https://media.example.com",
        accessToken: String.fromCharCode(0xd800),
      }),
    );

    for (const promise of cases) {
      await expectErrorCode(promise, "invalid_input");
    }
    expect(transport.calls).toHaveLength(0);
  });

  it.each([
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 1.5 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: Number.NaN },
    { deviceId: "" },
    { deviceId: " ".repeat(10) },
    { deviceId: "x".repeat(256) },
    { deviceId: `device-${String.fromCharCode(0xd800)}` },
  ])("rejects invalid bounds at construction", (options) => {
    expect(
      () => new JellyfinAuthenticationClient(options),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects an excessively long server URL before fetch", async () => {
    const transport = scriptedFetch();
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    await expectErrorCode(
      client.identifyServer(`https://media.example.com/${"x".repeat(2_100)}`),
      "invalid_url",
    );
    expect(transport.calls).toHaveLength(0);
  });

  it.each([
    "not JSON",
    "null",
    "[]",
    '"string"',
  ])("rejects malformed or non-object JSON response %s", async (body) => {
    const transport = scriptedFetch(new Response(body, { status: 200 }));
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    await expectErrorCode(
      client.identifyServer("https://media.example.com"),
      "invalid_server_response",
    );
  });

  it("rejects a declared oversized response before buffering it", async () => {
    const transport = scriptedFetch(
      jsonResponse(SERVER_PAYLOAD, 200, { "content-length": "1000" }),
    );
    const client = new JellyfinAuthenticationClient({
      fetch: transport.fetch,
      maxResponseBytes: 128,
    });

    await expectErrorCode(
      client.identifyServer("https://media.example.com"),
      "invalid_server_response",
    );
  });

  it("stops a streaming response once the configured byte bound is crossed", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
        controller.close();
      },
    });
    const transport = scriptedFetch(new Response(body, { status: 200 }));
    const client = new JellyfinAuthenticationClient({
      fetch: transport.fetch,
      maxResponseBytes: 64,
    });

    await expectErrorCode(
      client.identifyServer("https://media.example.com"),
      "invalid_server_response",
    );
  });

  it("rejects invalid UTF-8 in a JSON response", async () => {
    const transport = scriptedFetch(
      new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 }),
    );
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    await expectErrorCode(
      client.identifyServer("https://media.example.com"),
      "invalid_server_response",
    );
  });

  it("turns network failures into a safe server_unreachable error", async () => {
    const secret = "network-secret-that-must-not-escape";
    const transport = scriptedFetch(new Error(`socket failure: ${secret}`));
    const client = new JellyfinAuthenticationClient({ fetch: transport.fetch });

    const error = await expectErrorCode(
      client.identifyServer("https://media.example.com"),
      "server_unreachable",
    );
    expect(`${error.name}: ${error.message}`).not.toContain(secret);
  });

  it("enforces a finite timeout even when an injected fetch ignores abort", async () => {
    const fetch = (() => new Promise<Response>(() => {})) as typeof globalThis.fetch;
    const client = new JellyfinAuthenticationClient({
      fetch,
      requestTimeoutMs: 5,
    });

    await expectErrorCode(
      client.identifyServer("https://media.example.com"),
      "server_unreachable",
    );
  });

  it("keeps the timeout active while reading the response body", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
    });
    const transport = scriptedFetch(new Response(body, { status: 200 }));
    const client = new JellyfinAuthenticationClient({
      fetch: transport.fetch,
      requestTimeoutMs: 5,
    });

    await expectErrorCode(
      client.identifyServer("https://media.example.com"),
      "server_unreachable",
    );
  });

  it("never includes a password, token, server response body, or URL credentials in errors", async () => {
    const password = "PASSWORD-DO-NOT-LEAK";
    const token = "TOKEN-DO-NOT-LEAK";
    const responseSecret = "RESPONSE-DO-NOT-LEAK";
    const passwordTransport = scriptedFetch(
      jsonResponse(SERVER_PAYLOAD),
      new Error(`${password} ${responseSecret}`),
    );
    const passwordClient = new JellyfinAuthenticationClient({
      fetch: passwordTransport.fetch,
    });
    const passwordError = await expectErrorCode(
      passwordClient.authenticateWithPassword({
        serverUrl: "https://media.example.com",
        username: "name",
        password,
      }),
      "server_unreachable",
    );

    const tokenTransport = scriptedFetch(
      jsonResponse(SERVER_PAYLOAD),
      new Response(`${token} ${responseSecret}`, { status: 401 }),
    );
    const tokenClient = new JellyfinAuthenticationClient({
      fetch: tokenTransport.fetch,
    });
    const tokenError = await expectErrorCode(
      tokenClient.authenticateWithToken({
        serverUrl: "https://media.example.com",
        accessToken: token,
      }),
      "token_invalid",
    );

    const credentialUrl = "https://URL-USER:URL-PASSWORD@media.example.com";
    const urlError = await expectErrorCode(
      tokenClient.identifyServer(credentialUrl),
      "unsafe_url",
    );

    for (const [error, secrets] of [
      [passwordError, [password, responseSecret]],
      [tokenError, [token, responseSecret]],
      [urlError, ["URL-USER", "URL-PASSWORD"]],
    ] as const) {
      const serialized = `${error.name} ${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
    }
  });
});
