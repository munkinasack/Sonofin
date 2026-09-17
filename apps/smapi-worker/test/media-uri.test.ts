import { describe, expect, it, vi } from "vitest";

import {
  JellyfinClientError,
  type JellyfinConnection,
  type JellyfinDataClient,
  type JellyfinPlaybackInfo,
} from "@sonofin/jellyfin-client";
import type { SmapiLogSink } from "@sonofin/shared";
import { encodeSonosContentId } from "@sonofin/sonos-smapi";

import {
  handleRequest,
  SmapiBrowseError,
  SonofinMediaURIService,
  type SmapiDependencies,
  type SmapiGetMediaURIRequest,
} from "../src";

const TRACK_ID = "track-id";
const ENCODED_TRACK_ID = encodeSonosContentId({
  kind: "track",
  value: TRACK_ID,
});
const ACCESS_TOKEN = "private-jellyfin-token";
const CONNECTION = {
  accessToken: ACCESS_TOKEN,
  deviceId: "sonofin-test-device",
  serverId: "jellyfin-server-id",
  serverName: "Test Jellyfin",
  serverUrl: "https://media.example.test/jellyfin",
  serverVersion: "10.11.11",
  userId: "jellyfin-user-id",
  username: "jellyfin-user",
} satisfies JellyfinConnection;

function soapRequest(
  parameters = `<id>${ENCODED_TRACK_ID}</id>`,
  includeCredentials = true,
): Request {
  return new Request("https://smapi.example.test/smapi", {
    method: "POST",
    headers: {
      "content-type": "text/xml; charset=utf-8",
      soapaction: '"http://www.sonos.com/Services/1.1#getMediaURI"',
    },
    body:
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
      (includeCredentials
        ? '<soap:Header><credentials xmlns="http://www.sonos.com/Services/1.1">' +
          '<loginToken><token>private-sonos-token</token>' +
          '<householdId>CaseSensitiveHousehold</householdId></loginToken>' +
          '</credentials></soap:Header>'
        : "") +
      '<soap:Body><getMediaURI xmlns="http://www.sonos.com/Services/1.1">' +
      parameters +
      '</getMediaURI></soap:Body></soap:Envelope>',
  });
}

function dataClient(
  overrides: Partial<JellyfinDataClient> = {},
): JellyfinDataClient {
  return {
    getAlbumTracks: vi.fn(),
    getAlbums: vi.fn(),
    getArtists: vi.fn(),
    getItemMetadata: vi.fn(),
    getPlaybackInfo: vi.fn(),
    getPlaylistTracks: vi.fn(),
    getPlaylists: vi.fn(),
    getServerInfo: vi.fn(),
    getUserLibraries: vi.fn(),
    search: vi.fn(),
    ...overrides,
  };
}

function dependencies(
  jellyfin: JellyfinDataClient = dataClient(),
  overrides: Partial<SmapiDependencies> = {},
): SmapiDependencies {
  return {
    browse: { getMetadata: vi.fn() },
    createJellyfinDataClient: vi.fn().mockReturnValue(jellyfin),
    extendedMetadata: { getExtendedMetadata: vi.fn() },
    jellyfinConnections: {
      retrieve: vi.fn().mockResolvedValue(CONNECTION),
    },
    links: {
      claim: vi.fn(),
      createPendingLink: vi.fn(),
    },
    mediaMetadata: { getMediaMetadata: vi.fn() },
    mediaUri: new SonofinMediaURIService(),
    nowMilliseconds: () => 0,
    onboardingUrl: "https://auth.example.test/onboarding",
    search: { search: vi.fn() },
    sonosAuthentication: {
      authenticate: vi.fn().mockResolvedValue({
        outcome: "success",
        connection: {
          householdId: "CaseSensitiveHousehold",
          id: "a".repeat(64),
          jellyfinConnectionId: "J".repeat(32),
        },
      }),
      issue: vi.fn(),
      revoke: vi.fn(),
    },
    ...overrides,
  };
}

function directPlaybackInfo(): JellyfinPlaybackInfo {
  return {
    mediaSources: [
      {
        id: "source-id",
        protocol: "File",
        container: "mp3",
        bitrate: 192_000,
        supportsDirectPlay: true,
        supportsDirectStream: false,
        supportsTranscoding: true,
        requiredHttpHeaders: {},
        audioStreams: [
          {
            index: 0,
            codec: "mp3",
            channels: 2,
            sampleRate: 44_100,
            isDefault: true,
          },
        ],
      },
    ],
  };
}

function sink(): SmapiLogSink {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function loggedText(logSink: SmapiLogSink): string {
  return [
    ...vi.mocked(logSink.error).mock.calls.flat(),
    ...vi.mocked(logSink.info).mock.calls.flat(),
    ...vi.mocked(logSink.warn).mock.calls.flat(),
  ].join("");
}

describe("getMediaURI Worker integration", () => {
  it("authenticates, resolves a direct Jellyfin target, and returns only metadata", async () => {
    const getItemMetadata = vi.fn().mockResolvedValue({
      id: TRACK_ID,
      kind: "track",
      name: "A Track",
      artists: [],
      container: "mp3",
    });
    const getPlaybackInfo = vi.fn().mockResolvedValue(directPlaybackInfo());
    const jellyfin = dataClient({ getItemMetadata, getPlaybackInfo });
    const deps = dependencies(jellyfin);
    const audioFetch = vi.fn();
    vi.stubGlobal("fetch", audioFetch);
    let first: Response;
    let second: Response;
    try {
      first = await handleRequest(soapRequest(), deps);
      second = await handleRequest(soapRequest(), deps);
    } finally {
      vi.unstubAllGlobals();
    }
    const firstBody = await first.text();

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/xml; charset=utf-8");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await second.text()).toBe(firstBody);
    expect(firstBody).toContain(
      '<getMediaURIResponse xmlns="http://www.sonos.com/Services/1.1">',
    );
    expect(firstBody).toContain(
      "<getMediaURIResult>https://media.example.test/jellyfin/Audio/",
    );
    expect(firstBody).toContain(
      "<httpHeaders><httpHeader><header>Authorization</header>",
    );
    expect(firstBody).toContain("MediaBrowser Client=&quot;Sonofin&quot;");
    expect(firstBody).toContain("</value></httpHeader></httpHeaders>");
    const uri = /<getMediaURIResult>([^<]+)<\/getMediaURIResult>/u.exec(firstBody)?.[1];
    expect(uri).toBeDefined();
    expect(uri).not.toContain(ACCESS_TOKEN);
    expect(uri).not.toContain("ApiKey");
    expect(getItemMetadata).toHaveBeenCalledTimes(2);
    expect(getItemMetadata).toHaveBeenCalledWith(TRACK_ID);
    expect(getPlaybackInfo).toHaveBeenCalledTimes(2);
    expect(getPlaybackInfo).toHaveBeenCalledWith(TRACK_ID);
    expect(deps.createJellyfinDataClient).toHaveBeenCalledWith(CONNECTION);
    expect(jellyfin.getAlbumTracks).not.toHaveBeenCalled();
    expect(jellyfin.getPlaylists).not.toHaveBeenCalled();
    expect(deps.browse.getMetadata).not.toHaveBeenCalled();
    expect(audioFetch).not.toHaveBeenCalled();
  });

  it("passes bounded optional playback parameters to the service without echoing them", async () => {
    const getMediaURI = vi.fn(
      (request: SmapiGetMediaURIRequest) => {
        void request;
        return Promise.resolve({
          url: "https://media.example.test/jellyfin/Audio/item/stream.mp3?x=1&y=2",
          httpHeaders: [
            { header: "Authorization" as const, value: 'MediaBrowser Token="a&b"' },
          ],
        });
      },
    );
    const response = await handleRequest(
      soapRequest(
        `<id>${ENCODED_TRACK_ID}</id><action>EXPLICIT:PLAY</action>` +
          "<secondsSinceExplicit>0</secondsSinceExplicit>" +
          "<deviceSessionToken>opaque-session</deviceSessionToken>",
      ),
      dependencies(dataClient(), { mediaUri: { getMediaURI } }),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(getMediaURI).toHaveBeenCalledWith({
      context: expect.objectContaining({ connection: CONNECTION }),
      id: ENCODED_TRACK_ID,
      action: "EXPLICIT:PLAY",
      secondsSinceExplicit: "0",
      deviceSessionToken: "opaque-session",
    });
    expect(body).toContain("stream.mp3?x=1&amp;y=2</getMediaURIResult>");
    expect(body).toContain("MediaBrowser Token=&quot;a&amp;b&quot;");
    expect(body).not.toContain("opaque-session");
  });

  it.each([
    ["missing id", ""],
    ["empty id", "<id></id>"],
    ["unknown parameter", `<id>${ENCODED_TRACK_ID}</id><secret>hidden</secret>`],
    ["wrong order", `<action>EXPLICIT:PLAY</action><id>${ENCODED_TRACK_ID}</id>`],
    ["invalid action", `<id>${ENCODED_TRACK_ID}</id><action>play</action>`],
  ] as const)("rejects %s with a fixed parameter fault", async (_name, parameters) => {
    const getMediaURI = vi.fn();
    const response = await handleRequest(
      soapRequest(parameters),
      dependencies(dataClient(), { mediaUri: { getMediaURI } }),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("<faultcode>soap:Client</faultcode>");
    expect(body).toContain("The getMediaURI parameters are invalid");
    expect(body).not.toContain("hidden");
    expect(getMediaURI).not.toHaveBeenCalled();
  });

  it("authenticates before validating parameters or resolving playback", async () => {
    const getMediaURI = vi.fn();
    const deps = dependencies(dataClient(), { mediaUri: { getMediaURI } });
    const response = await handleRequest(
      soapRequest("<secret>hidden</secret>", false),
      deps,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Client.LoginUnauthorized");
    expect(deps.jellyfinConnections.retrieve).not.toHaveBeenCalled();
    expect(deps.createJellyfinDataClient).not.toHaveBeenCalled();
    expect(getMediaURI).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", "soap:Client"],
    ["root", "Client.ItemNotFound"],
    [encodeSonosContentId({ kind: "album", value: "album-id" }), "Client.ItemNotFound"],
  ] as const)("rejects a non-track ID safely", async (id, faultCode) => {
    const getItemMetadata = vi.fn();
    const getPlaybackInfo = vi.fn();
    const response = await handleRequest(
      soapRequest(`<id>${id}</id>`),
      dependencies(dataClient({ getItemMetadata, getPlaybackInfo })),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(`<faultcode>${faultCode}</faultcode>`);
    expect(getItemMetadata).not.toHaveBeenCalled();
    expect(getPlaybackInfo).not.toHaveBeenCalled();
  });

  it.each([
    { id: TRACK_ID, kind: "artist", name: "Wrong kind" },
    { id: "different-id", kind: "track", name: "Wrong ID", artists: [], container: "mp3" },
  ])("does not negotiate playback for a stale or wrong-kind item", async (item) => {
    const getPlaybackInfo = vi.fn();
    const response = await handleRequest(
      soapRequest(),
      dependencies(dataClient({
        getItemMetadata: vi.fn().mockResolvedValue(item),
        getPlaybackInfo,
      })),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Client.ItemNotFound");
    expect(getPlaybackInfo).not.toHaveBeenCalled();
  });

  it("returns a fixed fault when Jellyfin has no compatible source", async () => {
    const response = await handleRequest(
      soapRequest(),
      dependencies(dataClient({
        getItemMetadata: vi.fn().mockResolvedValue({
          id: TRACK_ID,
          kind: "track",
          name: "A Track",
          artists: [],
          container: "mp3",
        }),
        getPlaybackInfo: vi.fn().mockResolvedValue({ mediaSources: [] }),
      })),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("<faultcode>Server.ServiceUnknownError</faultcode>");
    expect(body).toContain("No compatible audio stream is available");
    expect(body).not.toContain(TRACK_ID);
    expect(body).not.toContain(ACCESS_TOKEN);
  });

  it.each([
    ["token_invalid", "Client.AuthTokenExpired"],
    ["item_not_found", "Client.ItemNotFound"],
    ["server_unreachable", "Server.ServiceUnavailable"],
    ["invalid_server_response", "Server.ServiceUnknownError"],
  ] as const)("maps Jellyfin %s to %s", async (code, faultCode) => {
    const response = await handleRequest(
      soapRequest(),
      dependencies(dataClient({
        getItemMetadata: vi.fn().mockRejectedValue(new JellyfinClientError(code)),
      })),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(`<faultcode>${faultCode}</faultcode>`);
  });

  it("redacts rejected media data from SOAP faults and allow-listed logs", async () => {
    const canary = "https://user:password@wrong.example.test/audio?ApiKey=secret";
    const logSink = sink();
    const response = await handleRequest(
      soapRequest(),
      dependencies(dataClient(), {
        logSink,
        mediaUri: {
          getMediaURI: vi.fn().mockRejectedValue(new Error(canary)),
        },
      }),
    );
    const body = await response.text();
    const logs = loggedText(logSink);

    expect(response.status).toBe(500);
    expect(body).toContain("<faultcode>Server.ServiceUnknownError</faultcode>");
    expect(logs).toContain('"soapMethod":"getMediaURI"');
    expect(body + logs).not.toContain(canary);
    expect(body + logs).not.toContain(ACCESS_TOKEN);
    expect(body + logs).not.toContain("private-sonos-token");
    expect(logs).not.toContain(ENCODED_TRACK_ID);
  });

  it("maps local item rejection to ItemNotFound without logging the track ID", async () => {
    const logSink = sink();
    const response = await handleRequest(
      soapRequest(),
      dependencies(dataClient(), {
        logSink,
        mediaUri: {
          getMediaURI: vi.fn().mockRejectedValue(new SmapiBrowseError("item_not_found")),
        },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Client.ItemNotFound");
    expect(JSON.parse(vi.mocked(logSink.warn).mock.calls[0]?.[0] ?? "{}")).toMatchObject({
      contentKind: "track",
      reason: "item_not_found",
      soapMethod: "getMediaURI",
    });
    expect(loggedText(logSink)).not.toContain(ENCODED_TRACK_ID);
  });
});
