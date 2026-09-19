import { describe, expect, it, vi } from "vitest";

import {
  JellyfinClientError,
  type JellyfinConnection,
  type JellyfinDataClient,
  type JellyfinTrack,
} from "@sonofin/jellyfin-client";
import type { SmapiLogSink } from "@sonofin/shared";
import { encodeSonosContentId } from "@sonofin/sonos-smapi";

import smapiWorker, {
  handleRequest,
  formatJellyfinTrackAsSonosBrowseTrack,
  mapJellyfinErrorToSoapFault,
  resolveSmapiAuthenticatedContext,
  SmapiBrowseError,
  SonofinBrowseService,
  SonofinExtendedMetadataService,
  SonofinMediaMetadataService,
  SonofinMediaURIService,
  SonofinSearchService,
  type SmapiDependencies,
  type SmapiGetExtendedMetadataRequest,
  type SmapiGetMediaMetadataRequest,
  type SmapiGetMetadataRequest,
  type SmapiJellyfinConnectionResolver,
  type SmapiLinkService,
  type SmapiSearchRequest,
  type SmapiSonosAuthentication,
} from "../src";

const LINK_CODE = "A".repeat(32);
const LINK_DEVICE_ID = "B".repeat(32);
const JELLYFIN_ACCESS_TOKEN = "never-log-this-jellyfin-token";
const JELLYFIN_CONNECTION = {
  accessToken: JELLYFIN_ACCESS_TOKEN,
  deviceId: "sonofin-smapi-test-device",
  serverId: "jellyfin-server-id",
  serverName: "Test Jellyfin",
  serverUrl: "https://user:password@jellyfin.example.test/media",
  serverVersion: "10.11.0",
  userId: "jellyfin-user-id",
  username: "jellyfin-user",
} satisfies JellyfinConnection;
const FAKE_DATA_CLIENT = {} as JellyfinDataClient;

function makeSoapRequest(
  method: string,
  options: {
    bodyMethod?: string;
    includeCredentials?: boolean;
    parameters?: string;
  } = {},
): Request {
  const bodyMethod = options.bodyMethod ?? method;
  const parameters = options.parameters ?? "";
  const body = `
    <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
      ${
        options.includeCredentials === false
          ? ""
          : `<soap:Header>
        <credentials xmlns="http://www.sonos.com/Services/1.1">
          <loginToken>
            <token>never-log-this-token</token>
            <key>never-log-this-key</key>
            <householdId>Sonos_household</householdId>
          </loginToken>
        </credentials>
      </soap:Header>`
      }
      <soap:Body>
        <${bodyMethod} xmlns="http://www.sonos.com/Services/1.1">${parameters}</${bodyMethod}>
      </soap:Body>
    </soap:Envelope>
  `;

  return new Request("https://smapi.example.test/smapi", {
    body,
    headers: {
      authorization: "Bearer never-log-this-authorization",
      "content-type": 'text/xml; charset="utf-8"',
      soapaction: `"http://www.sonos.com/Services/1.1#${method}"`,
    },
    method: "POST",
  });
}

function createSonosAuthentication(): SmapiSonosAuthentication {
  return {
    authenticate: vi.fn().mockResolvedValue({
      connection: {
        householdId: "Sonos_household",
        id: "a".repeat(64),
        jellyfinConnectionId: "J".repeat(32),
      },
      outcome: "success",
    }),
    issue: vi.fn().mockResolvedValue({
      alreadyIssued: false,
      authToken: `SF_${"T".repeat(43)}`,
      outcome: "success",
      privateKey: `SF_NO_REFRESH_${"K".repeat(43)}`,
    }),
    revoke: vi.fn().mockResolvedValue(true),
  };
}

function createLinks(): SmapiLinkService {
  return {
    claim: vi.fn().mockResolvedValue({ outcome: "retry" }),
    createPendingLink: vi.fn().mockResolvedValue({
      expiresAt: 2_000,
      linkCode: LINK_CODE,
      linkDeviceId: LINK_DEVICE_ID,
    }),
  };
}

function createJellyfinConnections(): SmapiJellyfinConnectionResolver {
  return {
    retrieve: vi.fn().mockResolvedValue(JELLYFIN_CONNECTION),
  };
}

function createJellyfinDataClientSpies(): JellyfinDataClient {
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
  };
}

function createDependencies(
  overrides: Partial<SmapiDependencies> = {},
): SmapiDependencies {
  return {
    browse: new SonofinBrowseService(),
    createJellyfinDataClient: vi.fn().mockReturnValue(FAKE_DATA_CLIENT),
    extendedMetadata: new SonofinExtendedMetadataService(),
    jellyfinConnections: createJellyfinConnections(),
    links: createLinks(),
    mediaMetadata: new SonofinMediaMetadataService(),
    mediaUri: new SonofinMediaURIService(),
    nowMilliseconds: () => Date.now(),
    onboardingUrl: "https://auth.example.test/onboarding",
    search: new SonofinSearchService(),
    sonosAuthentication: createSonosAuthentication(),
    ttlSeconds: 600,
    ...overrides,
  };
}

function createSink(): SmapiLogSink {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

const HOUSEHOLD_PARAMETER = "<householdId>Sonos_household</householdId>";
const DEVICE_TOKEN_PARAMETERS =
  HOUSEHOLD_PARAMETER +
  `<linkCode>${LINK_CODE}</linkCode>` +
  `<linkDeviceId>${LINK_DEVICE_ID}</linkDeviceId>`;
const ROOT_METADATA_PARAMETERS =
  "<id>root</id><index>0</index><count>100</count>";
const ROOT_EXTENDED_METADATA_PARAMETERS = "<id>root</id>";
const TRACK_MEDIA_METADATA_PARAMETERS = `<id>${encodeSonosContentId({
  kind: "track",
  value: "track-id",
})}</id>`;
const SEARCH_PARAMETERS =
  "<id>track</id><term>Björk 東京 &amp; 🎵</term>" +
  "<index>0</index><count>10</count>";

describe("SMAPI Worker", () => {
  it("returns the authenticated 30-second catalog refresh contract without catalog reads", async () => {
    const jellyfin = createJellyfinDataClientSpies();
    const browse = { getMetadata: vi.fn() };
    const extendedMetadata = { getExtendedMetadata: vi.fn() };
    const mediaMetadata = { getMediaMetadata: vi.fn() };
    const search = { search: vi.fn() };
    const dependencies = createDependencies({
      browse,
      createJellyfinDataClient: vi.fn().mockReturnValue(jellyfin),
      extendedMetadata,
      mediaMetadata,
      nowMilliseconds: () => 90_000,
      search,
    });
    const response = await handleRequest(
      makeSoapRequest("getLastUpdate"),
      dependencies,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/xml; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(body).toContain(
      '<getLastUpdateResponse xmlns="http://www.sonos.com/Services/1.1">' +
        "<getLastUpdateResult><catalog>3</catalog><favorites>1</favorites>" +
        "<pollInterval>30</pollInterval></getLastUpdateResult>" +
        "</getLastUpdateResponse>",
    );
    expect(dependencies.sonosAuthentication.authenticate).toHaveBeenCalledWith({
      authToken: "never-log-this-token",
      householdId: "Sonos_household",
    });
    expect(dependencies.jellyfinConnections.retrieve).toHaveBeenCalledWith(
      "J".repeat(32),
    );
    expect(dependencies.createJellyfinDataClient).toHaveBeenCalledWith(
      JELLYFIN_CONNECTION,
    );
    for (const method of Object.values(jellyfin)) {
      expect(method).not.toHaveBeenCalled();
    }
    expect(browse.getMetadata).not.toHaveBeenCalled();
    expect(extendedMetadata.getExtendedMetadata).not.toHaveBeenCalled();
    expect(mediaMetadata.getMediaMetadata).not.toHaveBeenCalled();
    expect(search.search).not.toHaveBeenCalled();
    expect(dependencies.links.createPendingLink).not.toHaveBeenCalled();
    expect(dependencies.links.claim).not.toHaveBeenCalled();
    expect(dependencies.sonosAuthentication.issue).not.toHaveBeenCalled();
    expect(dependencies.sonosAuthentication.revoke).not.toHaveBeenCalled();
    expect(body).not.toContain(JELLYFIN_ACCESS_TOKEN);
    expect(body).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it("keeps one catalog token within a bucket and changes it at the exact boundary", async () => {
    let nowMilliseconds = 60_000;
    const dependencies = createDependencies({
      nowMilliseconds: () => nowMilliseconds,
    });
    const requestCatalog = async (): Promise<string | undefined> => {
      const response = await handleRequest(
        makeSoapRequest("getLastUpdate"),
        dependencies,
      );
      const body = await response.text();
      expect(response.status).toBe(200);
      return /<catalog>([0-9]+)<\/catalog>/u.exec(body)?.[1];
    };

    const first = await requestCatalog();
    nowMilliseconds = 89_999;
    const sameBucket = await requestCatalog();
    nowMilliseconds = 90_000;
    const nextBucket = await requestCatalog();

    expect([first, sameBucket, nextBucket]).toEqual(["2", "2", "3"]);
  });

  it("routes authenticated getExtendedMetadata through its service boundary", async () => {
    const service = new SonofinExtendedMetadataService();
    const getExtendedMetadata = vi.fn(
      (request: SmapiGetExtendedMetadataRequest) =>
        service.getExtendedMetadata(request),
    );
    const dependencies = createDependencies({
      extendedMetadata: { getExtendedMetadata },
    });

    const response = await handleRequest(
      makeSoapRequest("getExtendedMetadata", {
        parameters: ROOT_EXTENDED_METADATA_PARAMETERS,
      }),
      dependencies,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      '<getExtendedMetadataResponse xmlns="http://www.sonos.com/Services/1.1">' +
        '<getExtendedMetadataResult><mediaCollection><id>root</id>' +
        '<itemType>container</itemType><title>Sonofin</title>',
    );
    expect(getExtendedMetadata).toHaveBeenCalledWith({
      context: {
        connection: JELLYFIN_CONNECTION,
        jellyfin: FAKE_DATA_CLIENT,
        sonosMapping: {
          householdId: "Sonos_household",
          id: "a".repeat(64),
          jellyfinConnectionId: "J".repeat(32),
        },
      },
      id: "root",
    });
    expect(body).not.toContain(JELLYFIN_ACCESS_TOKEN);
    expect(body).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it.each([
    ["missing id", "", false],
    ["empty id", "<id></id>", true],
    ["unknown parameter", "<id>root</id><private>secret</private>", false],
  ] as const)(
    "rejects getExtendedMetadata with %s",
    async (_description, parameters, reachesBoundary) => {
      const getExtendedMetadata = vi
        .fn()
        .mockRejectedValue(new SmapiBrowseError("invalid_parameters"));
      const response = await handleRequest(
        makeSoapRequest("getExtendedMetadata", { parameters }),
        createDependencies({
          extendedMetadata: { getExtendedMetadata },
        }),
      );
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(body).toContain("<faultcode>soap:Client</faultcode>");
      expect(body).toContain("The getExtendedMetadata parameters are invalid");
      expect(body).not.toContain("secret");
      expect(getExtendedMetadata).toHaveBeenCalledTimes(
        reachesBoundary ? 1 : 0,
      );
    },
  );

  it("authenticates before validating or executing getExtendedMetadata", async () => {
    const getExtendedMetadata = vi.fn();
    const dependencies = createDependencies({
      extendedMetadata: { getExtendedMetadata },
    });

    const response = await handleRequest(
      makeSoapRequest("getExtendedMetadata", {
        includeCredentials: false,
        parameters: "<private>secret</private>",
      }),
      dependencies,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Client.LoginUnauthorized");
    expect(getExtendedMetadata).not.toHaveBeenCalled();
    expect(dependencies.jellyfinConnections.retrieve).not.toHaveBeenCalled();
    expect(dependencies.createJellyfinDataClient).not.toHaveBeenCalled();
  });

  it("routes authenticated getMediaMetadata through its service boundary", async () => {
    const encodedTrackId = encodeSonosContentId({
      kind: "track",
      value: "track-id",
    });
    const getMediaMetadata = vi.fn(
      (request: SmapiGetMediaMetadataRequest) => {
        void request;
        return Promise.resolve({
          id: encodedTrackId,
          itemType: "track" as const,
          kind: "track" as const,
          mimeType: "audio/flac",
          title: "Track <one>",
          trackMetadata: {
            album: "Album & one",
            canPlay: true,
            canSkip: false,
          },
        });
      },
    );
    const dependencies = createDependencies({
      mediaMetadata: { getMediaMetadata },
    });

    const response = await handleRequest(
      makeSoapRequest("getMediaMetadata", {
        parameters: TRACK_MEDIA_METADATA_PARAMETERS,
      }),
      dependencies,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      '<getMediaMetadataResponse xmlns="http://www.sonos.com/Services/1.1">' +
        `<getMediaMetadataResult><id>${encodedTrackId}</id>` +
        "<itemType>track</itemType><title>Track &lt;one&gt;</title>" +
        "<mimeType>audio/flac</mimeType><trackMetadata>" +
        "<album>Album &amp; one</album><canPlay>true</canPlay>" +
        "<canSkip>false</canSkip></trackMetadata>" +
        "</getMediaMetadataResult></getMediaMetadataResponse>",
    );
    expect(body).not.toContain("<mediaMetadata>");
    expect(getMediaMetadata).toHaveBeenCalledWith({
      context: {
        connection: JELLYFIN_CONNECTION,
        jellyfin: FAKE_DATA_CLIENT,
        sonosMapping: {
          householdId: "Sonos_household",
          id: "a".repeat(64),
          jellyfinConnectionId: "J".repeat(32),
        },
      },
      id: encodedTrackId,
    });
    expect(body).not.toContain(JELLYFIN_ACCESS_TOKEN);
    expect(body).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it.each([
    ["missing id", "", false],
    ["empty id", "<id></id>", true],
    [
      "unknown parameter",
      `${TRACK_MEDIA_METADATA_PARAMETERS}<private>secret</private>`,
      false,
    ],
  ] as const)(
    "rejects getMediaMetadata with %s",
    async (_description, parameters, reachesBoundary) => {
      const getMediaMetadata = vi
        .fn()
        .mockRejectedValue(new SmapiBrowseError("invalid_parameters"));
      const response = await handleRequest(
        makeSoapRequest("getMediaMetadata", { parameters }),
        createDependencies({ mediaMetadata: { getMediaMetadata } }),
      );
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(body).toContain("<faultcode>soap:Client</faultcode>");
      expect(body).toContain("The getMediaMetadata parameters are invalid");
      expect(body).not.toContain("secret");
      expect(getMediaMetadata).toHaveBeenCalledTimes(
        reachesBoundary ? 1 : 0,
      );
    },
  );

  it("authenticates before validating or executing getMediaMetadata", async () => {
    const getMediaMetadata = vi.fn();
    const dependencies = createDependencies({
      mediaMetadata: { getMediaMetadata },
    });

    const response = await handleRequest(
      makeSoapRequest("getMediaMetadata", {
        includeCredentials: false,
        parameters: "<private>secret</private>",
      }),
      dependencies,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Client.LoginUnauthorized");
    expect(getMediaMetadata).not.toHaveBeenCalled();
    expect(dependencies.jellyfinConnections.retrieve).not.toHaveBeenCalled();
    expect(dependencies.createJellyfinDataClient).not.toHaveBeenCalled();
  });

  it("routes authenticated getMetadata through the browse boundary", async () => {
    const service = new SonofinBrowseService();
    const getMetadata = vi.fn((request: SmapiGetMetadataRequest) =>
      service.getMetadata(request),
    );
    const dependencies = createDependencies({
      browse: { getMetadata },
    });
    const response = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters: `${ROOT_METADATA_PARAMETERS}<recursive>false</recursive>`,
      }),
      dependencies,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      '<getMetadataResponse xmlns="http://www.sonos.com/Services/1.1">' +
        "<getMetadataResult><index>0</index><count>3</count><total>3</total>",
    );
    const expectedCollections = [
      '<mediaCollection><id>artists</id><itemType>container</itemType>' +
        "<title>Artists</title><canScroll>false</canScroll>" +
        "<canPlay>false</canPlay><canEnumerate>true</canEnumerate>" +
        "<canAddToFavorites>false</canAddToFavorites></mediaCollection>",
      '<mediaCollection><id>albums</id><itemType>albumList</itemType>' +
        "<title>Albums</title><canScroll>false</canScroll>" +
        "<canPlay>false</canPlay><canEnumerate>true</canEnumerate>" +
        "<canAddToFavorites>false</canAddToFavorites></mediaCollection>",
      '<mediaCollection><id>playlists</id><itemType>container</itemType>' +
        "<title>Playlists</title><canScroll>false</canScroll>" +
        "<canPlay>false</canPlay><canEnumerate>true</canEnumerate>" +
        "<canAddToFavorites>false</canAddToFavorites></mediaCollection>",
    ];
    for (const collection of expectedCollections) {
      expect(body).toContain(collection);
    }
    expect(body.indexOf("<id>artists</id>")).toBeLessThan(
      body.indexOf("<id>albums</id>"),
    );
    expect(body.indexOf("<id>albums</id>")).toBeLessThan(
      body.indexOf("<id>playlists</id>"),
    );
    expect(body).not.toContain(
      "<id>search</id><itemType>container</itemType><title>Search</title>",
    );
    expect(getMetadata).toHaveBeenCalledWith({
      context: {
        connection: JELLYFIN_CONNECTION,
        jellyfin: FAKE_DATA_CLIENT,
        sonosMapping: {
          householdId: "Sonos_household",
          id: "a".repeat(64),
          jellyfinConnectionId: "J".repeat(32),
        },
      },
      count: "100",
      id: "root",
      index: "0",
      recursive: "false",
    });
    expect(body).not.toContain(JELLYFIN_ACCESS_TOKEN);
    expect(body).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it.each([
    ["2", "2", ["playlists"]],
    ["3", "100", []],
    ["4", "100", []],
    ["30", "10", []],
    ["2147483647", "100", []],
  ] as const)(
    "serializes root page index %s and count %s",
    async (index, count, expectedIds) => {
      const response = await handleRequest(
        makeSoapRequest("getMetadata", {
          parameters:
            `<id>root</id><index>${index}</index>` +
            `<count>${count}</count>`,
        }),
        createDependencies(),
      );
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain(`<index>${index}</index>`);
      expect(body).toContain(`<count>${expectedIds.length}</count>`);
      expect(body).toContain("<total>3</total>");
      expect(body).not.toContain(
        "<id>search</id><itemType>container</itemType><title>Search</title>",
      );
      expect(body.match(/<mediaCollection>/gu) ?? []).toHaveLength(
        expectedIds.length,
      );
      for (const id of expectedIds) {
        expect(body).toContain(`<id>${id}</id>`);
      }
    },
  );

  it.each([
    ["missing id", "<index>0</index><count>100</count>"],
    ["empty id", "<id></id><index>0</index><count>100</count>"],
    [
      "malformed id",
      "<id>malformed-secret-id</id><index>0</index><count>100</count>",
    ],
    ["missing index", "<id>root</id><count>100</count>"],
    ["negative index", "<id>root</id><index>-1</index><count>100</count>"],
    ["missing count", "<id>root</id><index>0</index>"],
    ["zero count", "<id>root</id><index>0</index><count>0</count>"],
    [
      "unknown parameter",
      ROOT_METADATA_PARAMETERS + "<privateParameter>secret-value</privateParameter>",
    ],
    [
      "out-of-order parameters",
      "<index>0</index><id>root</id><count>100</count>",
    ],
    [
      "recursive flattening",
      ROOT_METADATA_PARAMETERS + "<recursive>true</recursive>",
    ],
    [
      "malformed recursive flag",
      ROOT_METADATA_PARAMETERS + "<recursive>yes</recursive>",
    ],
  ] as const)("rejects %s with a fixed parameter fault", async (_name, parameters) => {
    const response = await handleRequest(
      makeSoapRequest("getMetadata", { parameters }),
      createDependencies(),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("<faultcode>soap:Client</faultcode>");
    expect(body).toContain("The getMetadata parameters are invalid");
    expect(body).not.toContain("malformed-secret-id");
    expect(body).not.toContain("secret-value");
  });

  it("authenticates before validating or browsing getMetadata", async () => {
    const missingBrowse = { getMetadata: vi.fn() };
    const missingDependencies = createDependencies({ browse: missingBrowse });
    const missing = await handleRequest(
      makeSoapRequest("getMetadata", {
        includeCredentials: false,
        parameters: ROOT_METADATA_PARAMETERS,
      }),
      missingDependencies,
    );
    const sonosAuthentication = createSonosAuthentication();
    vi.mocked(sonosAuthentication.authenticate).mockResolvedValue({
      outcome: "failure",
    });
    const rejectedBrowse = { getMetadata: vi.fn() };
    const rejectedDependencies = createDependencies({
      browse: rejectedBrowse,
      sonosAuthentication,
    });
    const rejected = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters: "<id>not-valid</id>",
      }),
      rejectedDependencies,
    );

    expect(missing.status).toBe(500);
    expect(await missing.text()).toContain("Client.LoginUnauthorized");
    expect(rejected.status).toBe(500);
    expect(await rejected.text()).toContain("Client.LoginUnauthorized");
    expect(missingBrowse.getMetadata).not.toHaveBeenCalled();
    expect(rejectedBrowse.getMetadata).not.toHaveBeenCalled();
    expect(missingDependencies.jellyfinConnections.retrieve).not.toHaveBeenCalled();
    expect(rejectedDependencies.jellyfinConnections.retrieve).not.toHaveBeenCalled();
  });

  it("returns ItemNotFound for the deferred tracks browse ID", async () => {
    const response = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters: "<id>tracks</id><index>0</index><count>100</count>",
      }),
      createDependencies(),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("<faultcode>Client.ItemNotFound</faultcode>");
    expect(body).toContain("The requested item is not available");
    expect(body).not.toContain("tracks");
  });

  it("serializes the four stable search categories through getMetadata", async () => {
    const response = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters: "<id>search</id><index>0</index><count>100</count>",
      }),
      createDependencies(),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      "<getMetadataResult><index>0</index><count>4</count><total>4</total>",
    );
    const categories = [
      ["artist", "Artists"],
      ["album", "Albums"],
      ["track", "Tracks"],
      ["playlist", "Playlists"],
    ] as const;
    for (const [id, title] of categories) {
      expect(body).toContain(
        `<mediaCollection><id>${id}</id><itemType>search</itemType>` +
          `<title>${title}</title><canScroll>false</canScroll>` +
          "<canPlay>false</canPlay><canEnumerate>false</canEnumerate>" +
          "<canAddToFavorites>false</canAddToFavorites></mediaCollection>",
      );
    }
    for (let index = 1; index < categories.length; index += 1) {
      expect(body.indexOf(`<id>${categories[index - 1]?.[0]}</id>`)).toBeLessThan(
        body.indexOf(`<id>${categories[index]?.[0]}</id>`),
      );
    }
    expect(body).not.toContain(JELLYFIN_ACCESS_TOKEN);
    expect(body).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it("routes an authenticated mixed-Unicode search through the exact boundary context", async () => {
    const trackId = encodeSonosContentId({
      kind: "track",
      value: "track-三",
    });
    const search = vi.fn(() =>
      Promise.resolve({
        index: 7,
        items: [
          {
            id: trackId,
            itemType: "track" as const,
            kind: "track" as const,
            mimeType: "audio/flac",
            title: "Söngur <東京> & 🎵",
            trackMetadata: {
              canAddToFavorites: false,
              canPlay: true,
              canResume: false,
              canSeek: false,
              canSkip: false,
            },
          },
        ],
        total: 8,
      }),
    );
    const dependencies = createDependencies({ search: { search } });
    const response = await handleRequest(
      makeSoapRequest("search", {
        parameters:
          "<id>track</id><term>  Björk 東京 &amp; Café 🎵  </term>" +
          "<index>7</index><count>2</count>",
      }),
      dependencies,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      '<searchResponse xmlns="http://www.sonos.com/Services/1.1">' +
        "<searchResult><index>7</index><count>1</count><total>8</total>" +
        `<mediaMetadata><id>${trackId}</id><itemType>track</itemType>` +
        "<title>Söngur &lt;東京&gt; &amp; 🎵</title>" +
        "<mimeType>audio/flac</mimeType><trackMetadata>" +
        "<canPlay>true</canPlay><canSkip>false</canSkip>" +
        "<canAddToFavorites>false</canAddToFavorites>" +
        "<canResume>false</canResume><canSeek>false</canSeek>" +
        "</trackMetadata></mediaMetadata></searchResult></searchResponse>",
    );
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith({
      context: {
        connection: JELLYFIN_CONNECTION,
        jellyfin: FAKE_DATA_CLIENT,
        sonosMapping: {
          householdId: "Sonos_household",
          id: "a".repeat(64),
          jellyfinConnectionId: "J".repeat(32),
        },
      },
      count: "2",
      id: "track",
      index: "7",
      term: "  Björk 東京 & Café 🎵  ",
    });
    expect(body).not.toContain(JELLYFIN_ACCESS_TOKEN);
    expect(body).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it.each([
    [
      "missing id",
      "<term>private-search-term</term><index>0</index><count>10</count>",
      true,
    ],
    [
      "empty id",
      "<id></id><term>private-search-term</term><index>0</index><count>10</count>",
      true,
    ],
    [
      "plural category",
      "<id>tracks</id><term>private-search-term</term><index>0</index><count>10</count>",
      true,
    ],
    ["missing term", "<id>track</id><index>0</index><count>10</count>", true],
    [
      "blank term",
      "<id>track</id><term>   </term><index>0</index><count>10</count>",
      true,
    ],
    [
      "overlong term",
      `<id>track</id><term>${"🎵".repeat(513)}</term>` +
        "<index>0</index><count>10</count>",
      true,
    ],
    [
      "missing index",
      "<id>track</id><term>private-search-term</term><count>10</count>",
      true,
    ],
    [
      "negative index",
      "<id>track</id><term>private-search-term</term><index>-1</index><count>10</count>",
      true,
    ],
    [
      "missing count",
      "<id>track</id><term>private-search-term</term><index>0</index>",
      true,
    ],
    [
      "zero count",
      "<id>track</id><term>private-search-term</term><index>0</index><count>0</count>",
      true,
    ],
    [
      "extra parameter",
      SEARCH_PARAMETERS + "<privateParameter>secret-value</privateParameter>",
      false,
    ],
    [
      "out-of-order parameters",
      "<term>private-search-term</term><id>track</id><index>0</index><count>10</count>",
      false,
    ],
  ] as const)(
    "rejects search with %s using a fixed parameter fault",
    async (_name, parameters, reachesSearchBoundary) => {
      const jellyfinSearch = vi.fn();
      const service = new SonofinSearchService();
      const search = vi.fn((request: SmapiSearchRequest) =>
        service.search(request),
      );
      const response = await handleRequest(
        makeSoapRequest("search", { parameters }),
        createDependencies({
          createJellyfinDataClient: vi.fn().mockReturnValue({
            search: jellyfinSearch,
          } as unknown as JellyfinDataClient),
          search: { search },
        }),
      );
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(body).toContain("<faultcode>soap:Client</faultcode>");
      expect(body).toContain("The search parameters are invalid");
      expect(body).not.toContain("private-search-term");
      expect(body).not.toContain("secret-value");
      expect(search).toHaveBeenCalledTimes(reachesSearchBoundary ? 1 : 0);
      expect(jellyfinSearch).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate search parameters as fixed invalid SOAP without echoing them", async () => {
    const dependencies = createDependencies();
    const response = await handleRequest(
      makeSoapRequest("search", {
        parameters:
          "<id>track</id><term>first-private-term</term>" +
          "<term>second-private-term</term><index>0</index><count>10</count>",
      }),
      dependencies,
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("<faultcode>soap:Client</faultcode>");
    expect(body).toContain("The SOAP request is invalid");
    expect(body).not.toContain("first-private-term");
    expect(body).not.toContain("second-private-term");
    expect(dependencies.sonosAuthentication.authenticate).not.toHaveBeenCalled();
    expect(dependencies.jellyfinConnections.retrieve).not.toHaveBeenCalled();
  });

  it("authenticates before validating or executing search", async () => {
    const missingSearch = { search: vi.fn() };
    const missingDependencies = createDependencies({ search: missingSearch });
    const missing = await handleRequest(
      makeSoapRequest("search", {
        includeCredentials: false,
        parameters: "<id>private-invalid-category</id>",
      }),
      missingDependencies,
    );
    const sonosAuthentication = createSonosAuthentication();
    vi.mocked(sonosAuthentication.authenticate).mockResolvedValue({
      outcome: "failure",
    });
    const rejectedSearch = { search: vi.fn() };
    const rejectedDependencies = createDependencies({
      search: rejectedSearch,
      sonosAuthentication,
    });
    const rejected = await handleRequest(
      makeSoapRequest("search", {
        parameters: "<id>private-invalid-category</id>",
      }),
      rejectedDependencies,
    );

    expect(missing.status).toBe(500);
    expect(await missing.text()).toContain("Client.LoginUnauthorized");
    expect(rejected.status).toBe(500);
    expect(await rejected.text()).toContain("Client.LoginUnauthorized");
    expect(missingSearch.search).not.toHaveBeenCalled();
    expect(rejectedSearch.search).not.toHaveBeenCalled();
    expect(missingDependencies.jellyfinConnections.retrieve).not.toHaveBeenCalled();
    expect(rejectedDependencies.jellyfinConnections.retrieve).not.toHaveBeenCalled();
    expect(missingDependencies.createJellyfinDataClient).not.toHaveBeenCalled();
    expect(rejectedDependencies.createJellyfinDataClient).not.toHaveBeenCalled();
  });

  it.each([
    ["token_invalid", "Client.AuthTokenExpired"],
    ["item_not_found", "Client.ItemNotFound"],
    ["server_unreachable", "Server.ServiceUnavailable"],
    ["invalid_server_response", "Server.ServiceUnknownError"],
  ] as const)(
    "maps search Jellyfin %s to the fixed %s fault",
    async (code, faultCode) => {
      const response = await handleRequest(
        makeSoapRequest("search", { parameters: SEARCH_PARAMETERS }),
        createDependencies({
          search: {
            search: vi.fn().mockRejectedValue(new JellyfinClientError(code)),
          },
        }),
      );

      expect(response.status).toBe(500);
      expect(await response.text()).toContain(
        `<faultcode>${faultCode}</faultcode>`,
      );
    },
  );

  it("redacts arbitrary search failures from SOAP faults and allow-listed logs", async () => {
    const secretCanary =
      "https://user:password@example.test/private?token=search-secret";
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("search", {
        parameters:
          "<id>track</id><term>private-failure-term</term>" +
          "<index>0</index><count>10</count>",
      }),
      createDependencies({
        logSink: sink,
        search: {
          search: vi.fn().mockRejectedValue(new Error(secretCanary)),
        },
      }),
    );
    const body = await response.text();
    const logged = [
      ...vi.mocked(sink.error).mock.calls.flat(),
      ...vi.mocked(sink.info).mock.calls.flat(),
      ...vi.mocked(sink.warn).mock.calls.flat(),
    ].join("");

    expect(response.status).toBe(500);
    expect(body).toContain(
      "<faultcode>Server.ServiceUnknownError</faultcode>",
    );
    expect(logged).toContain('"soapMethod":"search"');
    expect(logged).toContain('"reason":"internal_error"');
    expect(body).not.toContain(secretCanary);
    expect(logged).not.toContain(secretCanary);
    expect(logged).not.toContain("private-failure-term");
    expect(logged).not.toContain("never-log-this-token");
    expect(logged).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it("logs search success and rejection with exactly the allow-listed fields", async () => {
    const successSink = createSink();
    await handleRequest(
      makeSoapRequest("search", {
        parameters:
          "<id>track</id><term>private-success-term</term>" +
          "<index>0</index><count>10</count>",
      }),
      createDependencies({
        logSink: successSink,
        search: {
          search: vi.fn().mockResolvedValue({ index: 0, items: [], total: 0 }),
        },
      }),
    );
    const rejectionSink = createSink();
    await handleRequest(
      makeSoapRequest("search", {
        parameters:
          "<id>private-invalid-id</id><term>private-rejection-term</term>" +
          "<index>0</index><count>10</count>",
      }),
      createDependencies({ logSink: rejectionSink }),
    );
    const successMessage = vi.mocked(successSink.info).mock.calls[0]?.[0];
    const rejectionMessage = vi.mocked(rejectionSink.warn).mock.calls[0]?.[0];
    const successLog = JSON.parse(successMessage ?? "") as unknown;
    const rejectionLog = JSON.parse(rejectionMessage ?? "") as unknown;
    const logged = `${successMessage ?? ""}${rejectionMessage ?? ""}`;

    expect(successLog).toEqual({
      contentCategory: "track",
      contentKind: "category",
      durationMs: expect.any(Number),
      event: "smapi.request",
      httpStatus: 200,
      outcome: "success",
      requestId: expect.any(String),
      soapMethod: "search",
    });
    expect(rejectionLog).toEqual({
      durationMs: expect.any(Number),
      event: "smapi.request",
      httpStatus: 500,
      outcome: "rejected",
      reason: "invalid_parameters",
      requestId: expect.any(String),
      soapMethod: "search",
    });
    expect(logged).not.toContain("private-success-term");
    expect(logged).not.toContain("private-invalid-id");
    expect(logged).not.toContain("private-rejection-term");
    expect(logged).not.toContain("never-log-this-token");
  });

  it("serializes artists and artist-filtered albums through the authenticated route", async () => {
    const getArtists = vi.fn().mockResolvedValue({
      items: [{ id: "artist-二", kind: "artist", name: "Björk & 二" }],
      startIndex: 0,
      totalRecordCount: 1,
    });
    const getAlbums = vi.fn().mockResolvedValue({
      items: [
        {
          artists: [{ id: "artist-二", name: "Björk & 二" }],
          id: "album-一",
          kind: "album",
          name: "Álbum <一>",
        },
      ],
      startIndex: 0,
      totalRecordCount: 1,
    });
    const dependencies = createDependencies({
      createJellyfinDataClient: vi.fn().mockReturnValue({
        getAlbums,
        getArtists,
      } as unknown as JellyfinDataClient),
    });

    const artistsResponse = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters: "<id>artists</id><index>0</index><count>10</count>",
      }),
      dependencies,
    );
    const artistsBody = await artistsResponse.text();
    const encodedArtistId = encodeSonosContentId({
      kind: "artist",
      value: "artist-二",
    });
    expect(artistsResponse.status).toBe(200);
    expect(artistsBody).toContain(
      `<mediaCollection><id>${encodedArtistId}</id>` +
        "<itemType>artist</itemType><title>Björk &amp; 二</title>",
    );

    const albumsResponse = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters:
          `<id>${encodedArtistId}</id><index>0</index><count>10</count>`,
      }),
      dependencies,
    );
    const albumsBody = await albumsResponse.text();
    expect(albumsResponse.status).toBe(200);
    expect(albumsBody).toContain(
      `<mediaCollection><id>${encodeSonosContentId({ kind: "album", value: "album-一" })}</id>` +
        "<itemType>album</itemType><title>Álbum &lt;一&gt;</title>" +
        `<artist>Björk &amp; 二</artist><artistId>${encodedArtistId}</artistId>`,
    );
    expect(getArtists).toHaveBeenCalledWith({ limit: 10, startIndex: 0 });
    expect(getAlbums).toHaveBeenCalledWith({
      artistId: "artist-二",
      limit: 10,
      startIndex: 0,
    });
  });

  it("serializes global albums and album tracks in exact WSDL order", async () => {
    const albumId = "album-一";
    const artistId = "artist-二";
    const trackId = "track-三";
    const getAlbums = vi.fn().mockResolvedValue({
      items: [
        {
          artists: [{ id: artistId, name: "Björk & 二" }],
          id: albumId,
          kind: "album",
          name: "Álbum <一>",
        },
      ],
      startIndex: 0,
      totalRecordCount: 1,
    });
    const getAlbumTracks = vi.fn().mockResolvedValue({
      items: [
        {
          albumId,
          albumName: "Álbum <一>",
          artists: [{ id: artistId, name: "Björk & 二" }],
          container: "flac",
          discNumber: 2,
          durationMs: 123_999,
          id: trackId,
          kind: "track",
          name: "Track <三>",
          trackNumber: 4,
        },
      ],
      startIndex: 0,
      totalRecordCount: 1,
    });
    const dependencies = createDependencies({
      createJellyfinDataClient: vi.fn().mockReturnValue({
        getAlbums,
        getAlbumTracks,
      } as unknown as JellyfinDataClient),
    });

    const albumsResponse = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters: "<id>albums</id><index>0</index><count>10</count>",
      }),
      dependencies,
    );
    const albumsBody = await albumsResponse.text();
    const encodedAlbumId = encodeSonosContentId({
      kind: "album",
      value: albumId,
    });
    const encodedArtistId = encodeSonosContentId({
      kind: "artist",
      value: artistId,
    });
    expect(albumsResponse.status).toBe(200);
    expect(albumsBody).toContain(
      `<mediaCollection><id>${encodedAlbumId}</id>` +
        "<itemType>album</itemType><title>Álbum &lt;一&gt;</title>" +
        `<artist>Björk &amp; 二</artist><artistId>${encodedArtistId}</artistId>` +
        "<canScroll>false</canScroll><canPlay>false</canPlay>" +
        "<canEnumerate>true</canEnumerate>" +
        "<canAddToFavorites>false</canAddToFavorites>" +
        "<albumArtURI></albumArtURI></mediaCollection>",
    );
    expect(getAlbums).toHaveBeenCalledWith({ limit: 10, startIndex: 0 });

    const tracksResponse = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters:
          `<id>${encodedAlbumId}</id><index>0</index><count>10</count>`,
      }),
      dependencies,
    );
    const tracksBody = await tracksResponse.text();
    const encodedTrackId = encodeSonosContentId({
      kind: "track",
      value: trackId,
    });
    expect(tracksResponse.status).toBe(200);
    expect(tracksBody).toContain(
      "<getMetadataResult><index>0</index><count>1</count><total>1</total>" +
        `<mediaMetadata><id>${encodedTrackId}</id><itemType>track</itemType>` +
        "<title>Track &lt;三&gt;</title><mimeType>audio/flac</mimeType>" +
        `<trackMetadata><artistId>${encodedArtistId}</artistId>` +
        "<artist>Björk &amp; 二</artist>" +
        `<albumId>${encodedAlbumId}</albumId>` +
        "<album>Álbum &lt;一&gt;</album><duration>123</duration>" +
        "<trackNumber>4</trackNumber><canPlay>true</canPlay>" +
        "<canSkip>false</canSkip><canAddToFavorites>false</canAddToFavorites>" +
        "<canResume>false</canResume><canSeek>false</canSeek>" +
        "</trackMetadata></mediaMetadata></getMetadataResult>",
    );
    expect(tracksBody).not.toContain("discNumber");
    expect(getAlbumTracks).toHaveBeenCalledWith(albumId, {
      limit: 10,
      startIndex: 0,
    });
  });

  it("serializes playlists and duplicate playlist tracks without changing catalog identity", async () => {
    const playlistId = "playlist/一";
    const duplicateTrackId = "track-duplicate";
    const collisionTrackId = "track-collision";
    const getPlaylists = vi.fn().mockResolvedValue({
      items: [
        {
          childCount: 3,
          id: playlistId,
          kind: "playlist",
          name: "Road & Rail <Mix>",
        },
      ],
      startIndex: 0,
      totalRecordCount: 1,
    });
    const getPlaylistTracks = vi.fn().mockResolvedValue({
      items: [
        {
          artists: [],
          container: "mp3",
          id: duplicateTrackId,
          kind: "track",
          name: "Repeated <Track>",
          playlistItemId: collisionTrackId,
        },
        {
          artists: [],
          container: "mp3",
          id: duplicateTrackId,
          kind: "track",
          name: "Repeated <Track>",
          playlistItemId: "entry-two",
        },
        {
          artists: [],
          container: "flac",
          id: collisionTrackId,
          kind: "track",
          name: "Collision Canary",
          playlistItemId: "entry-three",
        },
      ],
      startIndex: 0,
      totalRecordCount: 3,
    });
    const dependencies = createDependencies({
      createJellyfinDataClient: vi.fn().mockReturnValue({
        getPlaylistTracks,
        getPlaylists,
      } as unknown as JellyfinDataClient),
    });

    const playlistsResponse = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters: "<id>playlists</id><index>0</index><count>10</count>",
      }),
      dependencies,
    );
    const playlistsBody = await playlistsResponse.text();
    const encodedPlaylistId = encodeSonosContentId({
      kind: "playlist",
      value: playlistId,
    });
    expect(playlistsResponse.status).toBe(200);
    expect(playlistsBody).toContain(
      "<getMetadataResult><index>0</index><count>1</count><total>1</total>" +
        `<mediaCollection><id>${encodedPlaylistId}</id>` +
        "<itemType>playlist</itemType>" +
        "<title>Road &amp; Rail &lt;Mix&gt;</title>" +
        "<canScroll>false</canScroll><canPlay>false</canPlay>" +
        "<canEnumerate>true</canEnumerate>" +
        "<canAddToFavorites>false</canAddToFavorites><total>3</total>" +
        "</mediaCollection></getMetadataResult>",
    );
    expect(getPlaylists).toHaveBeenCalledWith({ limit: 10, startIndex: 0 });

    const tracksResponse = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters:
          `<id>${encodedPlaylistId}</id><index>0</index><count>10</count>`,
      }),
      dependencies,
    );
    const tracksBody = await tracksResponse.text();
    const encodedDuplicateTrackId = encodeSonosContentId({
      kind: "track",
      value: duplicateTrackId,
    });
    const encodedCollisionTrackId = encodeSonosContentId({
      kind: "track",
      value: collisionTrackId,
    });
    expect(tracksResponse.status).toBe(200);
    expect(tracksBody).toContain(
      "<getMetadataResult><index>0</index><count>3</count><total>3</total>" +
        `<mediaMetadata><id>${encodedDuplicateTrackId}</id>` +
        "<itemType>track</itemType><title>Repeated &lt;Track&gt;</title>" +
        "<mimeType>audio/mpeg</mimeType><trackMetadata>" +
        "<canPlay>true</canPlay><canSkip>false</canSkip>" +
        "<canAddToFavorites>false</canAddToFavorites>" +
        "<canResume>false</canResume><canSeek>false</canSeek>" +
        "</trackMetadata></mediaMetadata>" +
        `<mediaMetadata><id>${encodedDuplicateTrackId}</id>` +
        "<itemType>track</itemType><title>Repeated &lt;Track&gt;</title>" +
        "<mimeType>audio/mpeg</mimeType><trackMetadata>" +
        "<canPlay>true</canPlay><canSkip>false</canSkip>" +
        "<canAddToFavorites>false</canAddToFavorites>" +
        "<canResume>false</canResume><canSeek>false</canSeek>" +
        "</trackMetadata></mediaMetadata>" +
        `<mediaMetadata><id>${encodedCollisionTrackId}</id>` +
        "<itemType>track</itemType><title>Collision Canary</title>" +
        "<mimeType>audio/flac</mimeType><trackMetadata>" +
        "<canPlay>true</canPlay><canSkip>false</canSkip>" +
        "<canAddToFavorites>false</canAddToFavorites>" +
        "<canResume>false</canResume><canSeek>false</canSeek>" +
        "</trackMetadata></mediaMetadata></getMetadataResult>",
    );
    expect(tracksBody.split(encodedDuplicateTrackId)).toHaveLength(3);
    expect(tracksBody.split(encodedCollisionTrackId)).toHaveLength(2);
    expect(tracksBody).not.toContain(
      encodeSonosContentId({ kind: "track", value: "entry-two" }),
    );
    expect(tracksBody).not.toContain(
      encodeSonosContentId({ kind: "track", value: "entry-three" }),
    );
    expect(getPlaylistTracks).toHaveBeenCalledWith(playlistId, {
      limit: 10,
      startIndex: 0,
    });
  });

  it.each([
    ["token_invalid", "Client.AuthTokenExpired"],
    ["item_not_found", "Client.ItemNotFound"],
    ["server_unreachable", "Server.ServiceUnavailable"],
  ] as const)(
    "maps browse %s to the fixed %s fault",
    async (code, faultCode) => {
      const response = await handleRequest(
        makeSoapRequest("getMetadata", {
          parameters: ROOT_METADATA_PARAMETERS,
        }),
        createDependencies({
          browse: {
            getMetadata: vi
              .fn()
              .mockRejectedValue(new JellyfinClientError(code)),
          },
        }),
      );

      expect(response.status).toBe(500);
      expect(await response.text()).toContain(
        `<faultcode>${faultCode}</faultcode>`,
      );
    },
  );

  it.each([
    ["token_invalid", "Client.AuthTokenExpired"],
    ["item_not_found", "Client.ItemNotFound"],
    ["server_unreachable", "Server.ServiceUnavailable"],
    ["invalid_server_response", "Server.ServiceUnknownError"],
  ] as const)(
    "maps getExtendedMetadata Jellyfin %s to the fixed %s fault",
    async (code, faultCode) => {
      const response = await handleRequest(
        makeSoapRequest("getExtendedMetadata", {
          parameters: `<id>${encodeSonosContentId({ kind: "album", value: "album-id" })}</id>`,
        }),
        createDependencies({
          extendedMetadata: {
            getExtendedMetadata: vi
              .fn()
              .mockRejectedValue(new JellyfinClientError(code)),
          },
        }),
      );

      expect(response.status).toBe(500);
      expect(await response.text()).toContain(
        `<faultcode>${faultCode}</faultcode>`,
      );
    },
  );

  it.each([
    ["token_invalid", "Client.AuthTokenExpired"],
    ["item_not_found", "Client.ItemNotFound"],
    ["server_unreachable", "Server.ServiceUnavailable"],
    ["invalid_server_response", "Server.ServiceUnknownError"],
  ] as const)(
    "maps getMediaMetadata Jellyfin %s to the fixed %s fault",
    async (code, faultCode) => {
      const response = await handleRequest(
        makeSoapRequest("getMediaMetadata", {
          parameters: TRACK_MEDIA_METADATA_PARAMETERS,
        }),
        createDependencies({
          mediaMetadata: {
            getMediaMetadata: vi
              .fn()
              .mockRejectedValue(new JellyfinClientError(code)),
          },
        }),
      );

      expect(response.status).toBe(500);
      expect(await response.text()).toContain(
        `<faultcode>${faultCode}</faultcode>`,
      );
    },
  );

  it("classifies and redacts getMediaMetadata item failures", async () => {
    const sourceId = "private-media-track-id";
    const encodedId = encodeSonosContentId({
      kind: "track",
      value: sourceId,
    });
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getMediaMetadata", {
        parameters: `<id>${encodedId}</id>`,
      }),
      createDependencies({
        logSink: sink,
        mediaMetadata: {
          getMediaMetadata: vi
            .fn()
            .mockRejectedValue(new SmapiBrowseError("item_not_found")),
        },
      }),
    );
    const message = vi.mocked(sink.warn).mock.calls[0]?.[0] ?? "";

    expect(response.status).toBe(500);
    expect(JSON.parse(message)).toMatchObject({
      contentKind: "track",
      itemNotFoundOrigin: "metadata_service",
      outcome: "rejected",
      reason: "item_not_found",
      soapMethod: "getMediaMetadata",
    });
    expect(message).not.toContain(sourceId);
    expect(message).not.toContain(encodedId);
  });

  it("redacts arbitrary getMediaMetadata failures", async () => {
    const secretCanary =
      "https://user:password@example.test/private?token=media-secret";
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getMediaMetadata", {
        parameters: TRACK_MEDIA_METADATA_PARAMETERS,
      }),
      createDependencies({
        logSink: sink,
        mediaMetadata: {
          getMediaMetadata: vi
            .fn()
            .mockRejectedValue(new Error(secretCanary)),
        },
      }),
    );
    const body = await response.text();
    const logged = [
      ...vi.mocked(sink.error).mock.calls.flat(),
      ...vi.mocked(sink.info).mock.calls.flat(),
      ...vi.mocked(sink.warn).mock.calls.flat(),
    ].join("");

    expect(response.status).toBe(500);
    expect(body).toContain("<faultcode>Server.ServiceUnknownError</faultcode>");
    expect(logged).toContain('"soapMethod":"getMediaMetadata"');
    expect(logged).toContain('"reason":"internal_error"');
    expect(body).not.toContain(secretCanary);
    expect(logged).not.toContain(secretCanary);
    expect(logged).not.toContain("never-log-this-token");
    expect(logged).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it("classifies and redacts getExtendedMetadata item failures", async () => {
    const sourceId = "private-extended-album-id";
    const encodedId = encodeSonosContentId({
      kind: "album",
      value: sourceId,
    });
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getExtendedMetadata", {
        parameters: `<id>${encodedId}</id>`,
      }),
      createDependencies({
        extendedMetadata: {
          getExtendedMetadata: vi
            .fn()
            .mockRejectedValue(new SmapiBrowseError("item_not_found")),
        },
        logSink: sink,
      }),
    );
    const message = vi.mocked(sink.warn).mock.calls[0]?.[0] ?? "";

    expect(response.status).toBe(500);
    expect(JSON.parse(message)).toMatchObject({
      contentKind: "album",
      itemNotFoundOrigin: "metadata_service",
      outcome: "rejected",
      reason: "item_not_found",
      soapMethod: "getExtendedMetadata",
    });
    expect(message).not.toContain(sourceId);
    expect(message).not.toContain(encodedId);
  });

  it("redacts arbitrary getExtendedMetadata failures", async () => {
    const secretCanary =
      "https://user:password@example.test/private?token=extended-secret";
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getExtendedMetadata", {
        parameters: ROOT_EXTENDED_METADATA_PARAMETERS,
      }),
      createDependencies({
        extendedMetadata: {
          getExtendedMetadata: vi
            .fn()
            .mockRejectedValue(new Error(secretCanary)),
        },
        logSink: sink,
      }),
    );
    const body = await response.text();
    const logged = [
      ...vi.mocked(sink.error).mock.calls.flat(),
      ...vi.mocked(sink.info).mock.calls.flat(),
      ...vi.mocked(sink.warn).mock.calls.flat(),
    ].join("");

    expect(response.status).toBe(500);
    expect(body).toContain("<faultcode>Server.ServiceUnknownError</faultcode>");
    expect(logged).toContain('"soapMethod":"getExtendedMetadata"');
    expect(logged).toContain('"reason":"internal_error"');
    expect(body).not.toContain(secretCanary);
    expect(logged).not.toContain(secretCanary);
    expect(logged).not.toContain("never-log-this-token");
    expect(logged).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it("classifies item-not-found origin and target without logging content IDs", async () => {
    const sourceId = "private-track-id-canary";
    const encodedTrackId = encodeSonosContentId({
      kind: "track",
      value: sourceId,
    });
    const localSink = createSink();
    const localResponse = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters:
          `<id>${encodedTrackId}</id><index>0</index><count>10</count>`,
      }),
      createDependencies({ logSink: localSink }),
    );
    const localMessage = vi.mocked(localSink.warn).mock.calls[0]?.[0] ?? "";

    const categorySink = createSink();
    const categoryResponse = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters: "<id>album</id><index>0</index><count>10</count>",
      }),
      createDependencies({ logSink: categorySink }),
    );
    const categoryMessage =
      vi.mocked(categorySink.warn).mock.calls[0]?.[0] ?? "";

    const upstreamSink = createSink();
    const encodedAlbumId = encodeSonosContentId({
      kind: "album",
      value: sourceId,
    });
    const upstreamResponse = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters:
          `<id>${encodedAlbumId}</id><index>0</index><count>10</count>`,
      }),
      createDependencies({
        browse: {
          getMetadata: vi
            .fn()
            .mockRejectedValue(new JellyfinClientError("item_not_found")),
        },
        logSink: upstreamSink,
      }),
    );
    const upstreamMessage =
      vi.mocked(upstreamSink.warn).mock.calls[0]?.[0] ?? "";

    expect(localResponse.status).toBe(500);
    expect(JSON.parse(localMessage)).toMatchObject({
      contentKind: "track",
      itemNotFoundOrigin: "browse_service",
      reason: "item_not_found",
      soapMethod: "getMetadata",
    });
    expect(categoryResponse.status).toBe(500);
    expect(JSON.parse(categoryMessage)).toMatchObject({
      contentCategory: "album",
      contentKind: "category",
      itemNotFoundOrigin: "browse_service",
      reason: "item_not_found",
      soapMethod: "getMetadata",
    });
    expect(upstreamResponse.status).toBe(500);
    expect(JSON.parse(upstreamMessage)).toMatchObject({
      contentKind: "album",
      itemNotFoundOrigin: "jellyfin",
      reason: "item_not_found",
      soapMethod: "getMetadata",
    });
    expect(
      `${localMessage}${categoryMessage}${upstreamMessage}`,
    ).not.toContain(sourceId);
    expect(localMessage).not.toContain(encodedTrackId);
    expect(upstreamMessage).not.toContain(encodedAlbumId);
  });

  it("redacts browse failures from SOAP faults and allow-listed logs", async () => {
    const secretCanary =
      "https://user:password@example.test/private?token=browse-secret";
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters: ROOT_METADATA_PARAMETERS,
      }),
      createDependencies({
        browse: {
          getMetadata: vi.fn().mockRejectedValue(new Error(secretCanary)),
        },
        logSink: sink,
      }),
    );
    const body = await response.text();
    const logged = [
      ...vi.mocked(sink.error).mock.calls.flat(),
      ...vi.mocked(sink.info).mock.calls.flat(),
      ...vi.mocked(sink.warn).mock.calls.flat(),
    ].join("");

    expect(response.status).toBe(500);
    expect(body).toContain(
      "<faultcode>Server.ServiceUnknownError</faultcode>",
    );
    expect(logged).toContain('"soapMethod":"getMetadata"');
    expect(logged).toContain('"reason":"internal_error"');
    expect(logged).toContain('"internalErrorOrigin":"unexpected"');
    expect(body).not.toContain(secretCanary);
    expect(logged).not.toContain(secretCanary);
    expect(logged).not.toContain("never-log-this-token");
    expect(logged).not.toContain("root");
  });

  it("classifies a track-container failure without logging track data", async () => {
    const sourceId = "private-album-id-canary";
    const encodedAlbumId = encodeSonosContentId({
      kind: "album",
      value: sourceId,
    });
    const privateTrack = {
      artists: [{ id: "private-artist-id", name: "Private Artist" }],
      container: "never-log-private-container",
      id: "private-track-id",
      kind: "track",
      name: "Private Track Title",
    } satisfies JellyfinTrack;
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters:
          `<id>${encodedAlbumId}</id><index>0</index><count>10</count>`,
      }),
      createDependencies({
        browse: {
          getMetadata: vi.fn((): never => {
            formatJellyfinTrackAsSonosBrowseTrack(privateTrack);
            throw new Error("unreachable");
          }),
        },
        logSink: sink,
      }),
    );
    const body = await response.text();
    const logged = vi.mocked(sink.error).mock.calls[0]?.[0] ?? "";

    expect(response.status).toBe(500);
    expect(body).toContain(
      "<faultcode>Server.ServiceUnknownError</faultcode>",
    );
    expect(JSON.parse(logged)).toMatchObject({
      contentKind: "album",
      internalErrorOrigin: "track_container_other",
      reason: "internal_error",
      soapMethod: "getMetadata",
    });
    expect(`${body}${logged}`).not.toContain(sourceId);
    expect(`${body}${logged}`).not.toContain(encodedAlbumId);
    expect(`${body}${logged}`).not.toContain(privateTrack.id);
    expect(`${body}${logged}`).not.toContain(privateTrack.name);
    expect(`${body}${logged}`).not.toContain(privateTrack.container);
    expect(`${body}${logged}`).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it("classifies invalid track data without logging track data", async () => {
    const sourceId = "private-album-data-id-canary";
    const encodedAlbumId = encodeSonosContentId({
      kind: "album",
      value: sourceId,
    });
    const privateTrack = {
      artists: [],
      container: "mp3",
      id: "private-invalid-track-id",
      kind: "track",
      name: " ",
    } satisfies JellyfinTrack;
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters:
          `<id>${encodedAlbumId}</id><index>0</index><count>10</count>`,
      }),
      createDependencies({
        browse: {
          getMetadata: vi.fn((): never => {
            formatJellyfinTrackAsSonosBrowseTrack(privateTrack);
            throw new Error("unreachable");
          }),
        },
        logSink: sink,
      }),
    );
    const logged = vi.mocked(sink.error).mock.calls[0]?.[0] ?? "";

    expect(response.status).toBe(500);
    expect(JSON.parse(logged)).toMatchObject({
      contentKind: "album",
      internalErrorOrigin: "track_data",
      reason: "internal_error",
      soapMethod: "getMetadata",
    });
    expect(logged).not.toContain(sourceId);
    expect(logged).not.toContain(encodedAlbumId);
    expect(logged).not.toContain(privateTrack.id);
    expect(logged).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it("classifies invalid Jellyfin responses without logging content IDs", async () => {
    const sourceId = "private-album-response-id-canary";
    const encodedAlbumId = encodeSonosContentId({
      kind: "album",
      value: sourceId,
    });
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters:
          `<id>${encodedAlbumId}</id><index>0</index><count>10</count>`,
      }),
      createDependencies({
        browse: {
          getMetadata: vi
            .fn()
            .mockRejectedValue(
              new JellyfinClientError("invalid_server_response"),
            ),
        },
        logSink: sink,
      }),
    );
    const logged = vi.mocked(sink.error).mock.calls[0]?.[0] ?? "";

    expect(response.status).toBe(500);
    expect(JSON.parse(logged)).toMatchObject({
      contentKind: "album",
      internalErrorOrigin: "jellyfin_response",
      reason: "internal_error",
      soapMethod: "getMetadata",
    });
    expect(logged).not.toContain(sourceId);
    expect(logged).not.toContain(encodedAlbumId);
    expect(logged).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it("classifies oversized Jellyfin responses without logging content IDs", async () => {
    const sourceId = "private-album-size-id-canary";
    const encodedAlbumId = encodeSonosContentId({
      kind: "album",
      value: sourceId,
    });
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters:
          `<id>${encodedAlbumId}</id><index>0</index><count>10</count>`,
      }),
      createDependencies({
        browse: {
          getMetadata: vi.fn().mockRejectedValue(
            new JellyfinClientError("invalid_server_response", {
              responseFailure: "body_too_large",
            }),
          ),
        },
        logSink: sink,
      }),
    );
    const logged = vi.mocked(sink.error).mock.calls[0]?.[0] ?? "";

    expect(response.status).toBe(500);
    expect(JSON.parse(logged)).toMatchObject({
      contentKind: "album",
      internalErrorOrigin: "jellyfin_response_too_large",
      reason: "internal_error",
      soapMethod: "getMetadata",
    });
    expect(logged).not.toContain(sourceId);
    expect(logged).not.toContain(encodedAlbumId);
    expect(logged).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it("classifies malformed album-artist metadata without logging content IDs", async () => {
    const sourceId = "private-album-artist-id-canary";
    const encodedAlbumId = encodeSonosContentId({
      kind: "album",
      value: sourceId,
    });
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters:
          `<id>${encodedAlbumId}</id><index>0</index><count>10</count>`,
      }),
      createDependencies({
        browse: {
          getMetadata: vi.fn().mockRejectedValue(
            new JellyfinClientError("invalid_server_response", {
              responseFailure: "album_artists",
            }),
          ),
        },
        logSink: sink,
      }),
    );
    const logged = vi.mocked(sink.error).mock.calls[0]?.[0] ?? "";

    expect(response.status).toBe(500);
    expect(JSON.parse(logged)).toMatchObject({
      contentKind: "album",
      internalErrorOrigin: "jellyfin_album_artists",
      reason: "internal_error",
      soapMethod: "getMetadata",
    });
    expect(logged).not.toContain(sourceId);
    expect(logged).not.toContain(encodedAlbumId);
    expect(logged).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it("classifies response serialization failures at the serializer boundary", async () => {
    const sourceId = "private-album-serialization-id-canary";
    const encodedAlbumId = encodeSonosContentId({
      kind: "album",
      value: sourceId,
    });
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters:
          `<id>${encodedAlbumId}</id><index>0</index><count>10</count>`,
      }),
      createDependencies({
        browse: {
          getMetadata: vi.fn().mockResolvedValue(undefined as never),
        },
        logSink: sink,
      }),
    );
    const logged = vi.mocked(sink.error).mock.calls[0]?.[0] ?? "";

    expect(response.status).toBe(500);
    expect(JSON.parse(logged)).toMatchObject({
      contentKind: "album",
      internalErrorOrigin: "serialization",
      reason: "internal_error",
      soapMethod: "getMetadata",
    });
    expect(logged).not.toContain(sourceId);
    expect(logged).not.toContain(encodedAlbumId);
    expect(logged).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it("logs getMetadata success and rejection with allow-listed fields only", async () => {
    const successSink = createSink();
    await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters: ROOT_METADATA_PARAMETERS,
      }),
      createDependencies({ logSink: successSink }),
    );
    const rejectionSink = createSink();
    await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters:
          "<id>private-invalid-id</id><index>0</index><count>100</count>",
      }),
      createDependencies({ logSink: rejectionSink }),
    );
    const logged = [
      ...vi.mocked(successSink.info).mock.calls.flat(),
      ...vi.mocked(rejectionSink.warn).mock.calls.flat(),
    ].join("");

    expect(logged).toContain('"soapMethod":"getMetadata"');
    expect(logged).toContain('"outcome":"success"');
    expect(logged).toContain('"reason":"invalid_parameters"');
    expect(logged).not.toContain("private-invalid-id");
    expect(logged).not.toContain("never-log-this-token");
    expect(logged).not.toContain(JELLYFIN_CONNECTION.serverUrl);
  });

  it("retains the exact mapping and Jellyfin connection without Sonos credentials", async () => {
    const sonosAuthentication = createSonosAuthentication();
    const sonosMapping = {
      householdId: "Sonos_Household_CaseSensitive_🎵",
      id: "a".repeat(64),
      jellyfinConnectionId: "K".repeat(32),
    };
    vi.mocked(sonosAuthentication.authenticate).mockResolvedValue({
      connection: sonosMapping,
      outcome: "success",
    });
    const dependencies = createDependencies({ sonosAuthentication });

    const result = await resolveSmapiAuthenticatedContext(
      {
        loginToken: {
          householdId: sonosMapping.householdId,
          key: "never-retain-this-private-key",
          token: "never-retain-this-auth-token",
        },
      },
      dependencies,
    );

    expect(result).toEqual({
      context: {
        connection: JELLYFIN_CONNECTION,
        jellyfin: FAKE_DATA_CLIENT,
        sonosMapping,
      },
      outcome: "success",
    });
    expect(dependencies.jellyfinConnections.retrieve).toHaveBeenCalledWith(
      sonosMapping.jellyfinConnectionId,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("never-retain-this-auth-token");
    expect(serialized).not.toContain("never-retain-this-private-key");
  });

  it("creates pending state before returning a browser getAppLink response", async () => {
    const dependencies = createDependencies();
    const response = await handleRequest(
      makeSoapRequest("getAppLink", { parameters: HOUSEHOLD_PARAMETER }),
      dependencies,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(dependencies.links.createPendingLink).toHaveBeenCalledWith({
      householdId: "Sonos_household",
      ttlSeconds: 600,
    });
    expect(body).toContain("<getAppLinkResponse");
    expect(body).toContain(`<linkCode>${LINK_CODE}</linkCode>`);
    expect(body).toContain(`<linkDeviceId>${LINK_DEVICE_ID}</linkDeviceId>`);
    expect(body).toContain("<showLinkCode>false</showLinkCode>");
    expect(body).toContain(
      `https://auth.example.test/onboarding?linkCode=${LINK_CODE}`,
    );
  });

  it("rejects an onboarding base URL with conflicting query parameters", async () => {
    const links = createLinks();
    const response = await handleRequest(
      makeSoapRequest("getAppLink", { parameters: HOUSEHOLD_PARAMETER }),
      createDependencies({
        links,
        onboardingUrl: "https://auth.example.test/onboarding?source=sonos",
      }),
    );

    expect(response.status).toBe(500);
    expect(links.createPendingLink).not.toHaveBeenCalled();
  });

  it("returns NOT_LINKED_RETRY with SonosError 5 while onboarding is pending", async () => {
    const dependencies = createDependencies();
    const response = await handleRequest(
      makeSoapRequest("getDeviceAuthToken", {
        parameters: DEVICE_TOKEN_PARAMETERS,
      }),
      dependencies,
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(dependencies.links.claim).toHaveBeenCalledWith({
      householdId: "Sonos_household",
      linkCode: LINK_CODE,
      linkDeviceId: LINK_DEVICE_ID,
    });
    expect(body).toContain("<faultcode>Client.NOT_LINKED_RETRY</faultcode>");
    expect(body).toContain("<smapi:SonosError>5</smapi:SonosError>");
  });

  it("returns NOT_LINKED_FAILURE with SonosError 6 for a permanent failure", async () => {
    const links = createLinks();
    vi.mocked(links.claim).mockResolvedValue({
      outcome: "failure",
      reason: "mismatch",
    });
    const response = await handleRequest(
      makeSoapRequest("getDeviceAuthToken", {
        parameters: DEVICE_TOKEN_PARAMETERS,
      }),
      createDependencies({ links }),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("<faultcode>Client.NOT_LINKED_FAILURE</faultcode>");
    expect(body).toContain("<smapi:SonosError>6</smapi:SonosError>");
  });

  it("returns authToken then privateKey after onboarding completes", async () => {
    const links = createLinks();
    vi.mocked(links.claim).mockResolvedValue({
      alreadyClaimed: false,
      householdId: "Sonos_household",
      jellyfinConnectionId: "J".repeat(32),
      linkId: "a".repeat(64),
      outcome: "success",
    });
    const dependencies = createDependencies({ links });
    const response = await handleRequest(
      makeSoapRequest("getDeviceAuthToken", {
        parameters: DEVICE_TOKEN_PARAMETERS,
      }),
      dependencies,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<getDeviceAuthTokenResponse");
    expect(body).toContain(`<authToken>SF_${"T".repeat(43)}</authToken>`);
    expect(
      dependencies.sonosAuthentication.issue,
    ).toHaveBeenCalledWith({
      householdId: "Sonos_household",
      jellyfinConnectionId: "J".repeat(32),
      linkId: "a".repeat(64),
    });
    expect(body.indexOf("<authToken>")).toBeLessThan(
      body.indexOf("<privateKey>"),
    );
  });

  it("fails cleanly when durable Sonos credential issuance was superseded", async () => {
    const links = createLinks();
    vi.mocked(links.claim).mockResolvedValue({
      alreadyClaimed: true,
      householdId: "Sonos_household",
      jellyfinConnectionId: "J".repeat(32),
      linkId: "a".repeat(64),
      outcome: "success",
    });
    const sonosAuthentication = createSonosAuthentication();
    vi.mocked(sonosAuthentication.issue).mockResolvedValue({
      outcome: "failure",
      reason: "superseded",
    });

    const response = await handleRequest(
      makeSoapRequest("getDeviceAuthToken", {
        parameters: DEVICE_TOKEN_PARAMETERS,
      }),
      createDependencies({ links, sonosAuthentication }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(
      "<faultcode>Client.NOT_LINKED_FAILURE</faultcode>",
    );
  });

  it("replaces only an authenticated prior credential supplied by Sonos", async () => {
    const links = createLinks();
    vi.mocked(links.claim).mockResolvedValue({
      alreadyClaimed: false,
      householdId: "Sonos_household",
      jellyfinConnectionId: "J".repeat(32),
      linkId: "b".repeat(64),
      outcome: "success",
    });
    const sonosAuthentication = createSonosAuthentication();

    const response = await handleRequest(
      makeSoapRequest("getDeviceAuthToken", {
        parameters: DEVICE_TOKEN_PARAMETERS,
      }),
      createDependencies({ links, sonosAuthentication }),
    );

    expect(response.status).toBe(200);
    expect(sonosAuthentication.revoke).toHaveBeenCalledWith({
      authToken: "never-log-this-token",
      householdId: "Sonos_household",
    });
  });

  it("returns LoginUnauthorized for missing or unknown long-lived credentials", async () => {
    const missingDependencies = createDependencies();
    const missing = await handleRequest(
      makeSoapRequest("getLastUpdate", { includeCredentials: false }),
      missingDependencies,
    );
    const sonosAuthentication = createSonosAuthentication();
    vi.mocked(sonosAuthentication.authenticate).mockResolvedValue({
      outcome: "failure",
    });
    const unknownDependencies = createDependencies({ sonosAuthentication });
    const unknown = await handleRequest(
      makeSoapRequest("getLastUpdate"),
      unknownDependencies,
    );

    expect(missing.status).toBe(500);
    expect(await missing.text()).toContain(
      "<faultcode>Client.LoginUnauthorized</faultcode>",
    );
    expect(unknown.status).toBe(500);
    const unknownBody = await unknown.text();
    expect(unknownBody).toContain(
      "<faultcode>Client.LoginUnauthorized</faultcode>",
    );
    expect(unknownBody).not.toContain("never-log-this-token");
    expect(missingDependencies.jellyfinConnections.retrieve).not.toHaveBeenCalled();
    expect(missingDependencies.createJellyfinDataClient).not.toHaveBeenCalled();
    expect(sonosAuthentication.authenticate).toHaveBeenCalledOnce();
    expect(unknownDependencies.jellyfinConnections.retrieve).not.toHaveBeenCalled();
    expect(unknownDependencies.createJellyfinDataClient).not.toHaveBeenCalled();
  });

  it("maps missing and failed connection resolution to a fixed unknown-service fault", async () => {
    const secretCanary =
      "https://user:password@example.test/private?token=server-body-secret";

    for (const retrieveResult of [
      null,
      new Error(secretCanary),
    ] as const) {
      const jellyfinConnections = createJellyfinConnections();
      if (retrieveResult === null) {
        vi.mocked(jellyfinConnections.retrieve).mockResolvedValue(null);
      } else {
        vi.mocked(jellyfinConnections.retrieve).mockRejectedValue(
          retrieveResult,
        );
      }
      const sink = createSink();
      const dependencies = createDependencies({
        jellyfinConnections,
        logSink: sink,
      });

      const response = await handleRequest(
        makeSoapRequest("getLastUpdate"),
        dependencies,
      );
      const body = await response.text();
      const logged = JSON.stringify([
        vi.mocked(sink.error).mock.calls,
        vi.mocked(sink.info).mock.calls,
        vi.mocked(sink.warn).mock.calls,
      ]);

      expect(response.status).toBe(500);
      expect(body).toContain(
        "<faultcode>Server.ServiceUnknownError</faultcode>",
      );
      expect(body).toContain("The service could not process the request");
      expect(body).not.toContain(secretCanary);
      expect(logged).not.toContain(secretCanary);
      expect(dependencies.createJellyfinDataClient).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["authentication_failed", "Client.AuthTokenExpired"],
    ["token_invalid", "Client.AuthTokenExpired"],
    ["item_not_found", "Client.ItemNotFound"],
    ["server_unreachable", "Server.ServiceUnavailable"],
    ["server_rejected", "Server.ServiceUnknownError"],
    ["invalid_input", "Server.ServiceUnknownError"],
    ["invalid_server_response", "Server.ServiceUnknownError"],
    ["invalid_url", "Server.ServiceUnknownError"],
    ["insecure_url", "Server.ServiceUnknownError"],
    ["unsafe_url", "Server.ServiceUnknownError"],
  ] as const)(
    "maps Jellyfin %s to the fixed %s SOAP fault",
    async (code, faultCode) => {
      const createJellyfinDataClient = vi.fn((): JellyfinDataClient => {
        throw new JellyfinClientError(code);
      });
      const response = await handleRequest(
        makeSoapRequest("getLastUpdate"),
        createDependencies({ createJellyfinDataClient }),
      );

      expect(response.status).toBe(500);
      expect(await response.text()).toContain(
        `<faultcode>${faultCode}</faultcode>`,
      );
    },
  );

  it("discards arbitrary factory failures instead of exposing their contents", async () => {
    const secretCanary =
      "jellyfin-token response-body https://user:password@example.test";
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getLastUpdate"),
      createDependencies({
        createJellyfinDataClient: vi.fn(() => {
          throw new Error(secretCanary);
        }),
        logSink: sink,
      }),
    );
    const body = await response.text();
    const logged = JSON.stringify([
      vi.mocked(sink.error).mock.calls,
      vi.mocked(sink.info).mock.calls,
      vi.mocked(sink.warn).mock.calls,
    ]);

    expect(body).toContain(
      "<faultcode>Server.ServiceUnknownError</faultcode>",
    );
    expect(body).not.toContain(secretCanary);
    expect(logged).not.toContain(secretCanary);
    expect(
      mapJellyfinErrorToSoapFault(new Error(secretCanary)),
    ).toMatchObject({
      faultCode: "Server.ServiceUnknownError",
      message: "The service could not process the request",
    });
  });

  it.each(["encryption", "signing"] as const)(
    "maps invalid production %s-key configuration to a fixed safe fault",
    async (invalidKey) => {
      const secretCanary =
        "https://user:password@example.test/?token=configuration-secret";
      const errorLog = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      try {
        const jellyfinTokenEncryptionKey = {
          get: () =>
            Promise.resolve(
              invalidKey === "encryption"
                ? secretCanary
                : "A".repeat(43),
            ),
        };

        const response = await smapiWorker.fetch(
          makeSoapRequest("getLastUpdate"),
          {
            DB: {} as D1Database,
            JELLYFIN_TOKEN_ENCRYPTION_KEY: jellyfinTokenEncryptionKey,
            ONBOARDING_URL: "https://auth.example.test/onboarding",
            SONOS_TOKEN_SIGNING_KEY:
              invalidKey === "signing"
                ? secretCanary
                : "B".repeat(42) + "A",
          },
        );
        const body = await response.text();
        const logged = errorLog.mock.calls.flat().join("");

        expect(response.status).toBe(500);
        expect(response.headers.get("x-request-id")).toBeTruthy();
        expect(body).toContain(
          "<faultcode>Server.ServiceUnknownError</faultcode>",
        );
        expect(body).toContain("The service could not process the request");
        expect(body).not.toContain(secretCanary);
        expect(logged).toContain('"reason":"internal_error"');
        expect(logged).not.toContain(secretCanary);
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it("requires household and link-code parameters", async () => {
    const dependencies = createDependencies();
    const appLink = await handleRequest(
      makeSoapRequest("getAppLink"),
      dependencies,
    );
    const deviceToken = await handleRequest(
      makeSoapRequest("getDeviceAuthToken", {
        parameters: HOUSEHOLD_PARAMETER,
      }),
      dependencies,
    );

    expect(appLink.status).toBe(500);
    expect(await appLink.text()).toContain("<faultcode>soap:Client</faultcode>");
    expect(deviceToken.status).toBe(500);
    expect(dependencies.links.createPendingLink).not.toHaveBeenCalled();
    expect(dependencies.links.claim).not.toHaveBeenCalled();
  });

  it("measures opaque household limits in Unicode characters", async () => {
    const links = createLinks();
    const householdId = "🎵".repeat(255);
    const response = await handleRequest(
      makeSoapRequest("getAppLink", {
        parameters: `<householdId>${householdId}</householdId>`,
      }),
      createDependencies({ links }),
    );

    expect(response.status).toBe(200);
    expect(links.createPendingLink).toHaveBeenCalledWith({
      householdId,
      ttlSeconds: 600,
    });
  });

  it("allows loopback HTTP only for local onboarding", async () => {
    const local = await handleRequest(
      makeSoapRequest("getAppLink", { parameters: HOUSEHOLD_PARAMETER }),
      createDependencies({
        onboardingUrl: "http://127.0.0.1:8788/onboarding",
      }),
    );
    const insecureLinks = createLinks();
    const insecure = await handleRequest(
      makeSoapRequest("getAppLink", { parameters: HOUSEHOLD_PARAMETER }),
      createDependencies({
        links: insecureLinks,
        onboardingUrl: "http://auth.example.test/onboarding",
      }),
    );

    expect(local.status).toBe(200);
    expect(insecure.status).toBe(500);
    expect(insecureLinks.createPendingLink).not.toHaveBeenCalled();
  });

  it("validates the configured link lifetime", async () => {
    const links = createLinks();
    const response = await handleRequest(
      makeSoapRequest("getAppLink", { parameters: HOUSEHOLD_PARAMETER }),
      createDependencies({ links, ttlSeconds: 60 }),
    );

    expect(response.status).toBe(500);
    expect(links.createPendingLink).not.toHaveBeenCalled();
  });

  it("returns a SOAP fault for malformed XML without echoing it", async () => {
    const request = new Request("https://smapi.example.test/smapi", {
      body: "<private-token>never-echo-this",
      headers: {
        "content-type": "text/xml",
        soapaction: '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      },
      method: "POST",
    });

    const response = await handleRequest(request, createDependencies());
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("<soap:Fault>");
    expect(body).toContain("<faultcode>soap:Client</faultcode>");
    expect(body).not.toContain("never-echo-this");
  });

  it("rejects a SOAPAction and body mismatch", async () => {
    const response = await handleRequest(
      makeSoapRequest("getAppLink", { bodyMethod: "getLastUpdate" }),
      createDependencies(),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(
      "<faultcode>soap:Client</faultcode>",
    );
  });

  it("returns VersionMismatch for a SOAP 1.2 envelope", async () => {
    const request = new Request("https://smapi.example.test/smapi", {
      body: `
        <soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
          <soap:Body>
            <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
          </soap:Body>
        </soap:Envelope>
      `,
      headers: {
        "content-type": "application/soap+xml",
        soapaction: '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      },
      method: "POST",
    });

    const response = await handleRequest(request, createDependencies());

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(
      "<faultcode>soap:VersionMismatch</faultcode>",
    );
  });

  it("returns MustUnderstand for an unsupported mandatory header", async () => {
    const request = new Request("https://smapi.example.test/smapi", {
      body: `
        <soap:Envelope
          xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
          xmlns:smapi="http://www.sonos.com/Services/1.1"
        >
          <soap:Header>
            <smapi:unsupported soap:mustUnderstand="1" />
          </soap:Header>
          <soap:Body><smapi:getLastUpdate /></soap:Body>
        </soap:Envelope>
      `,
      headers: {
        "content-type": "text/xml",
        soapaction: '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      },
      method: "POST",
    });

    const response = await handleRequest(request, createDependencies());

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(
      "<faultcode>soap:MustUnderstand</faultcode>",
    );
  });

  it("logs a fixed classification for known unsupported methods", async () => {
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest("getExtendedMetadataText"),
      createDependencies({ logSink: sink }),
    );
    const message = vi.mocked(sink.warn).mock.calls[0]?.[0] ?? "";

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(
      "The requested SMAPI method is not supported",
    );
    expect(JSON.parse(message)).toMatchObject({
      outcome: "rejected",
      reason: "unsupported_method",
      soapMethod: "getExtendedMetadataText",
    });
  });

  it("does not log arbitrary unsupported method names", async () => {
    const privateMethod = "privateCanaryMethod";
    const sink = createSink();
    const response = await handleRequest(
      makeSoapRequest(privateMethod),
      createDependencies({ logSink: sink }),
    );
    const message = vi.mocked(sink.warn).mock.calls[0]?.[0] ?? "";

    expect(response.status).toBe(500);
    expect(JSON.parse(message)).toMatchObject({
      outcome: "rejected",
      reason: "unsupported_method",
    });
    expect(JSON.parse(message)).not.toHaveProperty("soapMethod");
    expect(message).not.toContain(privateMethod);
  });

  it("allows only POST on the SMAPI route", async () => {
    const response = await handleRequest(
      new Request("https://smapi.example.test/smapi"),
      createDependencies(),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("requires an XML content type", async () => {
    const response = await handleRequest(
      new Request("https://smapi.example.test/smapi", {
        body: "not XML",
        headers: { "content-type": "text/plain" },
        method: "POST",
      }),
      createDependencies(),
    );

    expect(response.status).toBe(415);
  });

  it("stops reading chunked request bodies at 64 KiB", async () => {
    const encoder = new TextEncoder();
    let cancelCalled = false;
    let chunkIndex = 0;
    const chunks = [
      encoder.encode("x".repeat(40 * 1024)),
      encoder.encode("y".repeat(40 * 1024)),
      encoder.encode("should-not-be-read"),
    ];
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalled = true;
      },
      pull(controller) {
        const chunk = chunks[chunkIndex];
        chunkIndex += 1;

        if (chunk === undefined) {
          controller.close();
          return;
        }

        controller.enqueue(chunk);
      },
    });
    const request = new Request("https://smapi.example.test/smapi", {
      body,
      duplex: "half",
      headers: {
        "content-type": "text/xml",
        soapaction: '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      },
      method: "POST",
    } as RequestInit & { duplex: "half" });

    const response = await handleRequest(request, createDependencies());

    expect(response.status).toBe(413);
    expect(cancelCalled).toBe(true);
    expect(chunkIndex).toBeLessThan(chunks.length);
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    const response = await handleRequest(
      new Request("https://smapi.example.test/smapi", {
        body: "small body",
        headers: {
          "content-length": String(64 * 1024 + 1),
          "content-type": "text/xml",
          soapaction: '"http://www.sonos.com/Services/1.1#getLastUpdate"',
        },
        method: "POST",
      }),
      createDependencies(),
    );

    expect(response.status).toBe(413);
  });

  it("returns 404 outside the SMAPI route", async () => {
    const response = await handleRequest(
      new Request("https://smapi.example.test/unknown"),
      createDependencies(),
    );

    expect(response.status).toBe(404);
  });

  it("never includes request headers, bodies, codes, or tokens in logs", async () => {
    const sink = createSink();
    await handleRequest(
      makeSoapRequest("getDeviceAuthToken", {
        parameters: DEVICE_TOKEN_PARAMETERS,
      }),
      createDependencies({ logSink: sink }),
    );

    const logged = JSON.stringify({
      error: vi.mocked(sink.error).mock.calls,
      info: vi.mocked(sink.info).mock.calls,
      warn: vi.mocked(sink.warn).mock.calls,
    });

    expect(logged).toContain("getDeviceAuthToken");
    expect(logged).not.toContain("never-log-this-token");
    expect(logged).not.toContain("never-log-this-authorization");
    expect(logged).not.toContain(LINK_CODE);
    expect(logged).not.toContain(LINK_DEVICE_ID);
  });
});
