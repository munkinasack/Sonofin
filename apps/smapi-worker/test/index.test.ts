import { describe, expect, it, vi } from "vitest";

import {
  JellyfinClientError,
  type JellyfinConnection,
  type JellyfinDataClient,
} from "@sonofin/jellyfin-client";
import type { SmapiLogSink } from "@sonofin/shared";
import { encodeSonosContentId } from "@sonofin/sonos-smapi";

import smapiWorker, {
  handleRequest,
  mapJellyfinErrorToSoapFault,
  resolveSmapiAuthenticatedContext,
  SonofinBrowseService,
  type SmapiDependencies,
  type SmapiGetMetadataRequest,
  type SmapiJellyfinConnectionResolver,
  type SmapiLinkService,
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

function createDependencies(
  overrides: Partial<SmapiDependencies> = {},
): SmapiDependencies {
  return {
    browse: new SonofinBrowseService(),
    createJellyfinDataClient: vi.fn().mockReturnValue(FAKE_DATA_CLIENT),
    jellyfinConnections: createJellyfinConnections(),
    links: createLinks(),
    onboardingUrl: "https://auth.example.test/onboarding",
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

describe("SMAPI Worker", () => {
  it("returns the hard-coded getLastUpdate response", async () => {
    const dependencies = createDependencies();
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
    expect(body).toContain("<getLastUpdateResponse");
    expect(body).toContain("<catalog>1</catalog>");
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
    expect(body).not.toContain(JELLYFIN_ACCESS_TOKEN);
    expect(body).not.toContain(JELLYFIN_CONNECTION.serverUrl);
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
        "<getMetadataResult><index>0</index><count>4</count><total>4</total>",
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
      '<mediaCollection><id>playlists</id><itemType>playlist</itemType>' +
        "<title>Playlists</title><canScroll>false</canScroll>" +
        "<canPlay>false</canPlay><canEnumerate>true</canEnumerate>" +
        "<canAddToFavorites>false</canAddToFavorites></mediaCollection>",
      '<mediaCollection><id>search</id><itemType>container</itemType>' +
        "<title>Search</title><canScroll>false</canScroll>" +
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
    expect(body.indexOf("<id>playlists</id>")).toBeLessThan(
      body.indexOf("<id>search</id>"),
    );
    expect(getMetadata).toHaveBeenCalledWith({
      context: {
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
    ["2", "2", ["playlists", "search"]],
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
      expect(body).toContain("<total>4</total>");
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

  it.each([
    "tracks",
    "search",
  ])("returns ItemNotFound for deferred browse ID %s", async (id) => {
    const response = await handleRequest(
      makeSoapRequest("getMetadata", {
        parameters: `<id>${id}</id><index>0</index><count>100</count>`,
      }),
      createDependencies(),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("<faultcode>Client.ItemNotFound</faultcode>");
    expect(body).toContain("The requested item is not available");
    expect(body).not.toContain(id);
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
        "<canAddToFavorites>false</canAddToFavorites></mediaCollection>",
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
        "<trackNumber>4</trackNumber><canPlay>false</canPlay>" +
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
        "<canPlay>false</canPlay><canSkip>false</canSkip>" +
        "<canAddToFavorites>false</canAddToFavorites>" +
        "<canResume>false</canResume><canSeek>false</canSeek>" +
        "</trackMetadata></mediaMetadata>" +
        `<mediaMetadata><id>${encodedDuplicateTrackId}</id>` +
        "<itemType>track</itemType><title>Repeated &lt;Track&gt;</title>" +
        "<mimeType>audio/mpeg</mimeType><trackMetadata>" +
        "<canPlay>false</canPlay><canSkip>false</canSkip>" +
        "<canAddToFavorites>false</canAddToFavorites>" +
        "<canResume>false</canResume><canSeek>false</canSeek>" +
        "</trackMetadata></mediaMetadata>" +
        `<mediaMetadata><id>${encodedCollisionTrackId}</id>` +
        "<itemType>track</itemType><title>Collision Canary</title>" +
        "<mimeType>audio/flac</mimeType><trackMetadata>" +
        "<canPlay>false</canPlay><canSkip>false</canSkip>" +
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
    expect(body).not.toContain(secretCanary);
    expect(logged).not.toContain(secretCanary);
    expect(logged).not.toContain("never-log-this-token");
    expect(logged).not.toContain("root");
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

  it("retains the exact authenticated mapping without retaining raw credentials", async () => {
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
    expect(serialized).not.toContain(JELLYFIN_ACCESS_TOKEN);
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
        const response = await smapiWorker.fetch(
          makeSoapRequest("getLastUpdate"),
          {
            DB: {} as D1Database,
            JELLYFIN_TOKEN_ENCRYPTION_KEY:
              invalidKey === "encryption"
                ? secretCanary
                : "A".repeat(43),
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

  it("returns a SOAP fault for unsupported methods", async () => {
    const response = await handleRequest(
      makeSoapRequest("getExtendedMetadata"),
      createDependencies(),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(
      "The requested SMAPI method is not supported",
    );
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
