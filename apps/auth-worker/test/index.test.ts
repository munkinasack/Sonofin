import { describe, expect, it, vi } from "vitest";

import {
  JellyfinClientError,
  type JellyfinAuthentication,
  type JellyfinClientErrorCode,
  type JellyfinConnection,
} from "@sonofin/jellyfin-client";

import {
  handleRequest as handleOnboardingRequest,
  type OnboardingConnectionStorage,
  type OnboardingLinkService,
} from "../src";

const SERVER_URL = "https://jellyfin.example.test/base";
const PASSWORD = "password-must-never-leak";
const DIRECT_TOKEN = "direct-token-must-never-leak";
const RETURNED_TOKEN = "returned-token-must-never-leak";
const CONNECTION_ID = "C".repeat(32);

const CONNECTION = {
  accessToken: RETURNED_TOKEN,
  deviceId: "device-id",
  serverId: "server-id",
  serverName: "Living Room Jellyfin",
  serverUrl: SERVER_URL,
  serverVersion: "10.11.0",
  userId: "user-id",
  username: "alice",
} satisfies JellyfinConnection;

type LinkState = Awaited<
  ReturnType<OnboardingLinkService["getOnboardingState"]>
>;

function createLinks(state: LinkState = "pending"): OnboardingLinkService {
  return {
    completeWithConnection: vi.fn().mockResolvedValue({
      alreadyCompleted: false,
      outcome: "success",
      state: "complete",
    }),
    getOnboardingState: vi.fn().mockResolvedValue(state),
    isConnectionAssociated: vi.fn().mockResolvedValue(false),
  };
}

function createJellyfin(
  connection: JellyfinConnection = CONNECTION,
): JellyfinAuthentication {
  return {
    authenticateWithPassword: vi.fn().mockResolvedValue(connection),
    authenticateWithToken: vi.fn().mockResolvedValue(connection),
    identifyServer: vi.fn().mockResolvedValue({
      serverId: connection.serverId,
      serverName: connection.serverName,
      serverUrl: connection.serverUrl,
      serverVersion: connection.serverVersion,
    }),
    revokeAccessToken: vi.fn().mockResolvedValue(undefined),
  };
}

function createConnections(): OnboardingConnectionStorage {
  return {
    delete: vi.fn().mockResolvedValue(true),
    store: vi.fn().mockResolvedValue({ connectionId: CONNECTION_ID }),
  };
}

function handleRequest(
  request: Request,
  links: OnboardingLinkService,
  jellyfin: JellyfinAuthentication,
  connections: OnboardingConnectionStorage = createConnections(),
): Promise<Response> {
  return handleOnboardingRequest(request, links, jellyfin, connections);
}

interface SubmissionFields {
  accessToken: string;
  linkCode: string;
  password: string;
  serverUrl: string;
  username: string;
}

function submission(
  overrides: Partial<SubmissionFields> = {},
): URLSearchParams {
  return new URLSearchParams({
    accessToken: "",
    linkCode: "test-code",
    password: PASSWORD,
    serverUrl: SERVER_URL,
    username: "alice",
    ...overrides,
  });
}

function postRequest(
  body: string | URLSearchParams | Uint8Array = submission(),
  contentType = "application/x-www-form-urlencoded; charset=utf-8",
): Request {
  return new Request("https://auth.example.test/onboarding", {
    body,
    headers: { "content-type": contentType },
    method: "POST",
  });
}

function expectNoJellyfinContact(jellyfin: JellyfinAuthentication): void {
  expect(jellyfin.identifyServer).not.toHaveBeenCalled();
  expect(jellyfin.authenticateWithPassword).not.toHaveBeenCalled();
  expect(jellyfin.authenticateWithToken).not.toHaveBeenCalled();
  expect(jellyfin.revokeAccessToken).not.toHaveBeenCalled();
}

function storedCompletion(links: OnboardingLinkService): {
  jellyfinConnectionId: string;
  linkCode: string;
} {
  const call = vi.mocked(links.completeWithConnection).mock.calls[0];
  if (call === undefined) {
    throw new Error("Expected a stored completion");
  }
  return call[0];
}

describe("onboarding Worker", () => {
  it("shows the Jellyfin connection form for a pending link", async () => {
    const links = createLinks();
    const jellyfin = createJellyfin();
    const response = await handleRequest(
      new Request("https://auth.example.test/onboarding?linkCode=test-code"),
      links,
      jellyfin,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(body).toContain("Connect Sonofin");
    expect(body).toContain('name="linkCode" value="test-code"');
    expect(body).toContain('name="serverUrl"');
    expect(body).toContain('name="username"');
    expect(body).toContain('name="password" type="password"');
    expect(body).toContain('name="accessToken" type="password"');
    expect(body).toContain("Connect Jellyfin");
    expect(body).not.toContain("Connect test account");
    expect(body).not.toContain("does not ask for a server");
    expect(links.getOnboardingState).toHaveBeenCalledWith("test-code");
    expectNoJellyfinContact(jellyfin);
  });

  it("escapes untrusted link codes and retained public form values", async () => {
    const getLinks = createLinks();
    const getJellyfin = createJellyfin();
    const getResponse = await handleRequest(
      new Request(
        "https://auth.example.test/onboarding?linkCode=%22%3E%3Cscript%3E",
      ),
      getLinks,
      getJellyfin,
    );
    const getBody = await getResponse.text();

    expect(getBody).toContain("&quot;&gt;&lt;script&gt;");
    expect(getBody).not.toContain('"><script>');

    const links = createLinks();
    const jellyfin = createJellyfin();
    vi.mocked(jellyfin.authenticateWithPassword).mockRejectedValue(
      new JellyfinClientError("authentication_failed"),
    );
    const dangerousServer = 'https://example.test/&"><script>';
    const dangerousUsername = 'alice"><img src=x onerror=alert(1)>';
    const response = await handleRequest(
      postRequest(
        submission({
          serverUrl: dangerousServer,
          username: dangerousUsername,
        }),
      ),
      links,
      jellyfin,
    );
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toContain(
      'value="https://example.test/&amp;&quot;&gt;&lt;script&gt;"',
    );
    expect(body).toContain(
      'value="alice&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"',
    );
    expect(body).not.toContain(dangerousServer);
    expect(body).not.toContain(dangerousUsername);
    expect(body).not.toContain(PASSWORD);
  });

  it("does not echo a rejected URL that may itself contain credentials", async () => {
    const links = createLinks();
    const jellyfin = createJellyfin();
    const credentialBearingUrl =
      "https://url-user:url-password@jellyfin.example.test";
    vi.mocked(jellyfin.authenticateWithPassword).mockRejectedValue(
      new JellyfinClientError("unsafe_url"),
    );

    const response = await handleRequest(
      postRequest(submission({ serverUrl: credentialBearingUrl })),
      links,
      jellyfin,
    );
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("The Jellyfin server URL is not allowed");
    expect(body).not.toContain(credentialBearingUrl);
    expect(body).not.toContain("url-user");
    expect(body).not.toContain("url-password");
    expect(body).not.toContain(PASSWORD);
  });

  it("does not echo URL credentials when the authentication modes are mixed", async () => {
    const links = createLinks();
    const jellyfin = createJellyfin();
    const credentialBearingUrl =
      "https://url-user:url-password@jellyfin.example.test";

    const response = await handleRequest(
      postRequest(
        submission({
          accessToken: DIRECT_TOKEN,
          serverUrl: credentialBearingUrl,
        }),
      ),
      links,
      jellyfin,
    );
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain(
      "Use either username and password or an access token, not both.",
    );
    expect(body).not.toContain("url-user");
    expect(body).not.toContain("url-password");
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain(DIRECT_TOKEN);
    expectNoJellyfinContact(jellyfin);
  });

  it.each([
    ["pending", 200, "Connect Jellyfin"],
    ["invalid", 404, "Link not found"],
    ["expired", 410, "Link expired"],
    ["complete", 200, "Connection complete"],
    ["claimed", 200, "Connection complete"],
  ] as const)(
    "maps a GET for a %s link to HTTP %i",
    async (state, status, copy) => {
      const jellyfin = createJellyfin();
      const response = await handleRequest(
        new Request("https://auth.example.test/onboarding?linkCode=test-code"),
        createLinks(state),
        jellyfin,
      );

      expect(response.status).toBe(status);
      expect(await response.text()).toContain(copy);
      expectNoJellyfinContact(jellyfin);
    },
  );

  it("removes a stored direct-token connection without revoking the supplied token when link completion loses a race", async () => {
    const links = createLinks();
    vi.mocked(links.completeWithConnection).mockResolvedValue({
      outcome: "failure",
      reason: "connection_mismatch",
    });
    const jellyfin = createJellyfin({
      ...CONNECTION,
      accessToken: DIRECT_TOKEN,
    });
    const connections = createConnections();

    const response = await handleRequest(
      postRequest(
        submission({
          accessToken: DIRECT_TOKEN,
          password: "",
          username: "",
        }),
      ),
      links,
      jellyfin,
      connections,
    );

    expect(response.status).toBe(409);
    expect(connections.store).toHaveBeenCalledOnce();
    expect(connections.delete).toHaveBeenCalledWith(CONNECTION_ID);
    expect(jellyfin.revokeAccessToken).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(DIRECT_TOKEN);
  });

  it.each([
    ["a non-empty password", PASSWORD],
    ["an empty password", ""],
  ] as const)(
    "authenticates with %s and links the durable connection",
    async (_label, password) => {
      const links = createLinks();
      const jellyfin = createJellyfin();
      const connections = createConnections();
      const response = await handleRequest(
        postRequest(submission({ password })),
        links,
        jellyfin,
        connections,
      );

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        "/onboarding?linkCode=test-code",
      );
      expect(jellyfin.authenticateWithPassword).toHaveBeenCalledOnce();
      expect(jellyfin.authenticateWithPassword).toHaveBeenCalledWith({
        password,
        serverUrl: SERVER_URL,
        username: "alice",
      });
      expect(jellyfin.authenticateWithToken).not.toHaveBeenCalled();
      expect(jellyfin.revokeAccessToken).not.toHaveBeenCalled();
      expect(connections.store).toHaveBeenCalledOnce();
      expect(connections.store).toHaveBeenCalledWith(CONNECTION);
      expect(connections.delete).not.toHaveBeenCalled();

      const stored = storedCompletion(links);
      expect(stored).toEqual({
        jellyfinConnectionId: CONNECTION_ID,
        linkCode: "test-code",
      });
      const persisted = JSON.stringify(stored);
      expect(persisted).not.toContain(PASSWORD);
      expect(persisted).not.toContain(RETURNED_TOKEN);
      expect(await response.text()).not.toContain(RETURNED_TOKEN);
    },
  );

  it("authenticates a direct token without calling password authentication", async () => {
    const links = createLinks();
    const connections = createConnections();
    const jellyfin = createJellyfin({
      ...CONNECTION,
      accessToken: DIRECT_TOKEN,
    });
    const response = await handleRequest(
      postRequest(
        submission({
          accessToken: DIRECT_TOKEN,
          password: "",
          username: "",
        }),
      ),
      links,
      jellyfin,
      connections,
    );

    expect(response.status).toBe(303);
    expect(jellyfin.authenticateWithToken).toHaveBeenCalledOnce();
    expect(jellyfin.authenticateWithToken).toHaveBeenCalledWith({
      accessToken: DIRECT_TOKEN,
      serverUrl: SERVER_URL,
    });
    expect(jellyfin.authenticateWithPassword).not.toHaveBeenCalled();
    expect(jellyfin.revokeAccessToken).not.toHaveBeenCalled();
    expect(connections.store).toHaveBeenCalledWith({
      ...CONNECTION,
      accessToken: DIRECT_TOKEN,
    });
    expect(connections.delete).not.toHaveBeenCalled();
    const persisted = JSON.stringify(storedCompletion(links));
    expect(persisted).toContain(CONNECTION_ID);
    expect(persisted).not.toContain(DIRECT_TOKEN);
    expect(await response.text()).not.toContain(DIRECT_TOKEN);
  });

  it.each([
    [
      "expired",
      { outcome: "failure", reason: "expired" },
      410,
      "This onboarding link has expired",
    ],
    [
      "a connection mismatch",
      { outcome: "failure", reason: "connection_mismatch" },
      409,
      "This onboarding link was already completed",
    ],
    [
      "invalid",
      { outcome: "failure", reason: "invalid" },
      404,
      "This onboarding link is not valid",
    ],
  ] as const)(
    "maps the %s completion result after successful authentication",
    async (_label, completion, status, message) => {
      const links = createLinks();
      vi.mocked(links.completeWithConnection).mockResolvedValue(completion);
      const jellyfin = createJellyfin();
      const connections = createConnections();

      const response = await handleRequest(
        postRequest(),
        links,
        jellyfin,
        connections,
      );
      const body = await response.text();

      expect(jellyfin.authenticateWithPassword).toHaveBeenCalledOnce();
      expect(jellyfin.revokeAccessToken).toHaveBeenCalledOnce();
      expect(links.completeWithConnection).toHaveBeenCalledOnce();
      expect(connections.store).toHaveBeenCalledOnce();
      expect(connections.delete).toHaveBeenCalledWith(CONNECTION_ID);
      expect(links.isConnectionAssociated).toHaveBeenCalledWith({
        jellyfinConnectionId: CONNECTION_ID,
        linkCode: "test-code",
      });
      expect(
        vi.mocked(links.completeWithConnection).mock.invocationCallOrder[0] ??
          Number.NEGATIVE_INFINITY,
      ).toBeLessThan(
        vi.mocked(jellyfin.revokeAccessToken).mock.invocationCallOrder[0] ??
          Number.POSITIVE_INFINITY,
      );
      expect(
        vi.mocked(jellyfin.revokeAccessToken).mock.invocationCallOrder[0] ??
          Number.NEGATIVE_INFINITY,
      ).toBeLessThan(
        vi.mocked(connections.delete).mock.invocationCallOrder[0] ??
          Number.POSITIVE_INFINITY,
      );
      expect(response.status).toBe(status);
      expect(body).toBe(message);
      expect(body).not.toContain(PASSWORD);
      expect(body).not.toContain(DIRECT_TOKEN);
      expect(body).not.toContain(RETURNED_TOKEN);
      const persisted = JSON.stringify(storedCompletion(links));
      expect(persisted).toContain(CONNECTION_ID);
      expect(persisted).not.toContain(PASSWORD);
      expect(persisted).not.toContain(RETURNED_TOKEN);
    },
  );

  it.each([
    [
      "mixed password and token authentication",
      submission({ accessToken: DIRECT_TOKEN }),
    ],
    [
      "empty authentication fields",
      submission({ accessToken: "", password: "", username: "" }),
    ],
    ["an empty link code", submission({ linkCode: "" })],
    [
      "a duplicate field",
      (() => {
        const form = submission();
        form.append("password", "duplicate-secret");
        return form;
      })(),
    ],
    [
      "an unexpected field",
      (() => {
        const form = submission();
        form.append("debug", "true");
        return form;
      })(),
    ],
    [
      "a missing server URL field",
      (() => {
        const form = submission();
        form.delete("serverUrl");
        return form;
      })(),
    ],
  ] as const)("rejects %s", async (_label, form) => {
    const links = createLinks();
    const jellyfin = createJellyfin();
    const response = await handleRequest(postRequest(form), links, jellyfin);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain(DIRECT_TOKEN);
    expect(body).not.toContain("duplicate-secret");
    expectNoJellyfinContact(jellyfin);
    expect(links.completeWithConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid", 404, "Link not found"],
    ["expired", 410, "Link expired"],
    ["complete", 200, "Connection complete"],
    ["claimed", 200, "Connection complete"],
  ] as const)(
    "does not contact Jellyfin when a submitted link is %s",
    async (state, status, copy) => {
      const links = createLinks(state);
      const jellyfin = createJellyfin();
      const response = await handleRequest(postRequest(), links, jellyfin);
      const body = await response.text();

      expect(response.status).toBe(status);
      expect(body).toContain(copy);
      expect(body).not.toContain(PASSWORD);
      expectNoJellyfinContact(jellyfin);
      expect(links.completeWithConnection).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["invalid_url", "password", 400, "The Jellyfin server URL is invalid"],
    [
      "insecure_url",
      "password",
      400,
      "The Jellyfin server URL must use HTTPS",
    ],
    [
      "unsafe_url",
      "password",
      400,
      "The Jellyfin server URL is not allowed",
    ],
    [
      "invalid_input",
      "password",
      400,
      "The Jellyfin authentication input is invalid",
    ],
    [
      "authentication_failed",
      "password",
      401,
      "Jellyfin rejected those credentials.",
    ],
    [
      "token_invalid",
      "token",
      401,
      "Jellyfin rejected those credentials.",
    ],
    [
      "server_rejected",
      "password",
      502,
      "Sonofin could not verify that Jellyfin server.",
    ],
    [
      "server_unreachable",
      "password",
      502,
      "Sonofin could not verify that Jellyfin server.",
    ],
    [
      "invalid_server_response",
      "password",
      502,
      "Sonofin could not verify that Jellyfin server.",
    ],
    [
      "item_not_found",
      "password",
      502,
      "Sonofin could not verify that Jellyfin server.",
    ],
  ] as const)(
    "maps the typed %s error to a safe response",
    async (code, mode, status, message) => {
      const links = createLinks();
      const jellyfin = createJellyfin();
      const error = new JellyfinClientError(
        code satisfies JellyfinClientErrorCode,
      );
      const form =
        mode === "token"
          ? submission({
              accessToken: DIRECT_TOKEN,
              password: "",
              username: "",
            })
          : submission();

      if (mode === "token") {
        vi.mocked(jellyfin.authenticateWithToken).mockRejectedValue(error);
      } else {
        vi.mocked(jellyfin.authenticateWithPassword).mockRejectedValue(error);
      }

      const response = await handleRequest(
        postRequest(form),
        links,
        jellyfin,
      );
      const body = await response.text();

      expect(response.status).toBe(status);
      expect(body).toContain(message);
      expect(body).not.toContain(PASSWORD);
      expect(body).not.toContain(DIRECT_TOKEN);
      expect(body).not.toContain(RETURNED_TOKEN);
      expect(links.completeWithConnection).not.toHaveBeenCalled();
      expect(jellyfin.revokeAccessToken).not.toHaveBeenCalled();
    },
  );

  it("revokes a password-created token when encrypted persistence fails", async () => {
    const secret = "persistence-failure-must-never-leak";
    const links = createLinks();
    const jellyfin = createJellyfin();
    const connections = createConnections();
    vi.mocked(connections.store).mockRejectedValue(new Error(secret));

    const response = await handleRequest(
      postRequest(),
      links,
      jellyfin,
      connections,
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(secret);
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain(RETURNED_TOKEN);
    expect(jellyfin.revokeAccessToken).toHaveBeenCalledOnce();
    expect(jellyfin.revokeAccessToken).toHaveBeenCalledWith({
      accessToken: RETURNED_TOKEN,
      serverUrl: SERVER_URL,
    });
    expect(connections.delete).not.toHaveBeenCalled();
    expect(links.completeWithConnection).not.toHaveBeenCalled();
  });

  it("retains the encrypted recovery record when password-token revocation fails", async () => {
    const secret = "cleanup-failure-must-never-leak";
    const links = createLinks();
    vi.mocked(links.completeWithConnection).mockResolvedValue({
      outcome: "failure",
      reason: "expired",
    });
    const jellyfin = createJellyfin();
    const connections = createConnections();
    vi.mocked(jellyfin.revokeAccessToken).mockRejectedValue(new Error(secret));

    const response = await handleRequest(
      postRequest(),
      links,
      jellyfin,
      connections,
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(secret);
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain(RETURNED_TOKEN);
    expect(jellyfin.revokeAccessToken).toHaveBeenCalledOnce();
    expect(links.completeWithConnection).toHaveBeenCalledOnce();
    expect(links.isConnectionAssociated).toHaveBeenCalledWith({
      jellyfinConnectionId: CONNECTION_ID,
      linkCode: "test-code",
    });
    expect(connections.delete).not.toHaveBeenCalled();
  });

  it("preserves an associated credential after an uncertain completion error", async () => {
    const secret = "uncertain-commit-must-never-leak";
    const links = createLinks();
    vi.mocked(links.completeWithConnection).mockRejectedValue(new Error(secret));
    vi.mocked(links.isConnectionAssociated).mockResolvedValue(true);
    const jellyfin = createJellyfin();
    const connections = createConnections();

    const response = await handleRequest(
      postRequest(),
      links,
      jellyfin,
      connections,
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(secret);
    expect(links.isConnectionAssociated).toHaveBeenCalledWith({
      jellyfinConnectionId: CONNECTION_ID,
      linkCode: "test-code",
    });
    expect(connections.delete).not.toHaveBeenCalled();
    expect(jellyfin.revokeAccessToken).not.toHaveBeenCalled();
  });

  it("never revokes a user-supplied token when encrypted persistence fails", async () => {
    const secret = "direct-persistence-failure-must-never-leak";
    const links = createLinks();
    const jellyfin = createJellyfin({
      ...CONNECTION,
      accessToken: DIRECT_TOKEN,
    });
    const connections = createConnections();
    vi.mocked(connections.store).mockRejectedValue(new Error(secret));

    const response = await handleRequest(
      postRequest(
        submission({
          accessToken: DIRECT_TOKEN,
          password: "",
          username: "",
        }),
      ),
      links,
      jellyfin,
      connections,
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(secret);
    expect(body).not.toContain(DIRECT_TOKEN);
    expect(jellyfin.revokeAccessToken).not.toHaveBeenCalled();
    expect(connections.delete).not.toHaveBeenCalled();
    expect(links.completeWithConnection).not.toHaveBeenCalled();
  });

  it("requires form encoding, rejects malformed UTF-8, and enforces the body limit", async () => {
    const links = createLinks();
    const jellyfin = createJellyfin();
    const wrongType = await handleRequest(
      postRequest(submission(), "application/json"),
      links,
      jellyfin,
    );
    const malformedUtf8 = await handleRequest(
      postRequest(new Uint8Array([0xc3, 0x28])),
      links,
      jellyfin,
    );
    const streamedTooLarge = await handleRequest(
      postRequest("x".repeat(8 * 1024 + 1)),
      links,
      jellyfin,
    );
    const tooLarge = await handleRequest(
      new Request("https://auth.example.test/onboarding", {
        body: "small",
        headers: {
          "content-length": String(8 * 1024 + 1),
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }),
      links,
      jellyfin,
    );

    expect(wrongType.status).toBe(415);
    expect(malformedUtf8.status).toBe(400);
    expect(streamedTooLarge.status).toBe(413);
    expect(tooLarge.status).toBe(413);
    expectNoJellyfinContact(jellyfin);
    expect(links.getOnboardingState).not.toHaveBeenCalled();
  });

  it("rejects ambiguous queries, unknown routes, and unsupported methods", async () => {
    const links = createLinks();
    const jellyfin = createJellyfin();
    const ambiguous = await handleRequest(
      new Request(
        "https://auth.example.test/onboarding?linkCode=one&linkCode=two",
      ),
      links,
      jellyfin,
    );
    const unexpectedQuery = await handleRequest(
      new Request(
        "https://auth.example.test/onboarding?linkCode=one&debug=true",
      ),
      links,
      jellyfin,
    );
    const unknown = await handleRequest(
      new Request("https://auth.example.test/unknown"),
      links,
      jellyfin,
    );
    const method = await handleRequest(
      new Request("https://auth.example.test/onboarding", { method: "PUT" }),
      links,
      jellyfin,
    );

    expect(ambiguous.status).toBe(400);
    expect(unexpectedQuery.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, POST");
    expectNoJellyfinContact(jellyfin);
  });

  it.each(["link lookup", "Jellyfin authentication", "link completion"])(
    "redacts a generic error thrown during %s",
    async (stage) => {
      const secret = `${PASSWORD}:${DIRECT_TOKEN}:${stage}`;
      const links = createLinks();
      const jellyfin = createJellyfin();

      if (stage === "link lookup") {
        vi.mocked(links.getOnboardingState).mockRejectedValue(
          new Error(secret),
        );
      } else if (stage === "Jellyfin authentication") {
        vi.mocked(jellyfin.authenticateWithPassword).mockRejectedValue(
          new Error(secret),
        );
      } else {
        vi.mocked(links.completeWithConnection).mockRejectedValue(
          new Error(secret),
        );
      }

      const request =
        stage === "link lookup"
          ? new Request(
              "https://auth.example.test/onboarding?linkCode=test-code",
            )
          : postRequest();
      const response = await handleRequest(request, links, jellyfin);
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(body).toBe(
        "The onboarding service could not process the request",
      );
      expect(body).not.toContain(secret);
      expect(body).not.toContain(PASSWORD);
      expect(body).not.toContain(DIRECT_TOKEN);
      expect(body).not.toContain(RETURNED_TOKEN);
    },
  );
});
