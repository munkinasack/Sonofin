import { describe, expect, it, vi } from "vitest";

import {
  JellyfinConnectionService,
  type JellyfinConnectionRecord,
  type JellyfinConnectionRepository,
  type NewJellyfinConnectionRecord,
} from "@sonofin/connections";
import { AesGcmTokenCipher } from "@sonofin/crypto";
import type {
  JellyfinAuthentication,
  JellyfinConnection,
  JellyfinDataClient,
} from "@sonofin/jellyfin-client";
import {
  LinkService,
  type ClaimCompletedLinkInput,
  type CompletePendingLinkInput,
  type GuardedLinkMutationResult,
  type LinkRecord,
  type LinkRepository,
  type NewPendingLink,
} from "@sonofin/linking";
import {
  SonosAuthenticationService,
  type NewSonosConnectionRecord,
  type RevokeSonosConnectionInput,
  type SonosConnectionRecord,
  type SonosConnectionRepository,
} from "@sonofin/sonos-auth";

import {
  handleRequest as handleSmapi,
  SonofinBrowseService,
  SonofinExtendedMetadataService,
  SonofinMediaMetadataService,
  SonofinSearchService,
} from "../../smapi-worker/src";
import { handleRequest as handleOnboarding } from "../src";

const JELLYFIN_SERVER_URL = "https://jellyfin.example.test/media";
const JELLYFIN_PASSWORD = "lifecycle-password-must-never-leak";
const JELLYFIN_TOKEN = "lifecycle-token-must-never-leak";
const TOKEN_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WRONG_TOKEN_ENCRYPTION_KEY = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA";
const SONOS_SIGNING_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";

const JELLYFIN_CONNECTION = {
  accessToken: JELLYFIN_TOKEN,
  deviceId: "lifecycle-device-id",
  serverId: "lifecycle-server-id",
  serverName: "Lifecycle Jellyfin",
  serverUrl: JELLYFIN_SERVER_URL,
  serverVersion: "10.11.0",
  userId: "lifecycle-user-id",
  username: "lifecycle-user",
} satisfies JellyfinConnection;

function createJellyfin(): JellyfinAuthentication {
  return {
    authenticateWithPassword: vi.fn().mockResolvedValue(JELLYFIN_CONNECTION),
    authenticateWithToken: vi.fn().mockResolvedValue(JELLYFIN_CONNECTION),
    identifyServer: vi.fn().mockResolvedValue({
      serverId: JELLYFIN_CONNECTION.serverId,
      serverName: JELLYFIN_CONNECTION.serverName,
      serverUrl: JELLYFIN_CONNECTION.serverUrl,
      serverVersion: JELLYFIN_CONNECTION.serverVersion,
    }),
    revokeAccessToken: vi.fn().mockResolvedValue(undefined),
  };
}

class MemoryLinks implements LinkRepository {
  readonly records = new Map<string, LinkRecord>();

  async insertPending(link: NewPendingLink): Promise<boolean> {
    if (this.records.has(link.linkCodeHash)) {
      return false;
    }

    this.records.set(link.linkCodeHash, {
      ...link,
      claimedAt: null,
      completedAt: null,
      jellyfinConnectionId: null,
    });
    return true;
  }

  async findByLinkCodeHash(hash: string): Promise<LinkRecord | null> {
    const record = this.records.get(hash);
    return record === undefined ? null : { ...record };
  }

  async completePending(
    input: CompletePendingLinkInput,
  ): Promise<GuardedLinkMutationResult> {
    const record = this.records.get(input.linkCodeHash);
    if (
      record === undefined ||
      record.completedAt !== null ||
      record.claimedAt !== null ||
      record.expiresAt <= input.completedAt
    ) {
      return {
        link: record === undefined ? null : { ...record },
        outcome: "unchanged",
      };
    }

    const updated: LinkRecord = {
      ...record,
      completedAt: input.completedAt,
      jellyfinConnectionId: input.jellyfinConnectionId,
    };
    this.records.set(input.linkCodeHash, updated);
    return { link: { ...updated }, outcome: "updated" };
  }

  async claimCompleted(
    input: ClaimCompletedLinkInput,
  ): Promise<GuardedLinkMutationResult> {
    const record = this.records.get(input.linkCodeHash);
    if (
      record === undefined ||
      record.completedAt === null ||
      record.claimedAt !== null ||
      record.expiresAt <= input.claimedAt
    ) {
      return {
        link: record === undefined ? null : { ...record },
        outcome: "unchanged",
      };
    }

    const updated: LinkRecord = { ...record, claimedAt: input.claimedAt };
    this.records.set(input.linkCodeHash, updated);
    return { link: { ...updated }, outcome: "updated" };
  }
}

class MemoryConnections implements JellyfinConnectionRepository {
  readonly records = new Map<string, JellyfinConnectionRecord>();

  async insert(record: NewJellyfinConnectionRecord): Promise<boolean> {
    if (this.records.has(record.id)) {
      return false;
    }
    this.records.set(record.id, { ...record });
    return true;
  }

  async findById(id: string): Promise<JellyfinConnectionRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : { ...record };
  }

  async deleteById(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

class MemorySonosConnections implements SonosConnectionRepository {
  readonly records = new Map<string, SonosConnectionRecord>();

  async insert(record: NewSonosConnectionRecord): Promise<boolean> {
    if (this.records.has(record.id)) {
      return false;
    }
    this.records.set(record.id, { ...record, revokedAt: null });
    return true;
  }

  async findById(id: string): Promise<SonosConnectionRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : { ...record };
  }

  async findByAuthTokenHash(
    authTokenHash: string,
  ): Promise<SonosConnectionRecord | null> {
    const record = [...this.records.values()].find(
      (candidate) => candidate.authTokenHash === authTokenHash,
    );
    return record === undefined ? null : { ...record };
  }

  async revokeByAuthTokenHash(
    input: RevokeSonosConnectionInput,
  ): Promise<SonosConnectionRecord | null> {
    const record = [...this.records.values()].find(
      (candidate) =>
        candidate.authTokenHash === input.authTokenHash &&
        candidate.householdId === input.householdId,
    );
    if (record === undefined || record.revokedAt !== null) {
      return null;
    }
    const revoked = { ...record, revokedAt: input.revokedAt };
    this.records.set(record.id, revoked);
    return { ...revoked };
  }
}

function soapRequest(
  method: string,
  parameters: string,
  credentials?: {
    authToken: string;
    householdId: string;
    privateKey: string;
  },
): Request {
  const header =
    credentials === undefined
      ? ""
      : `<soap:Header><credentials xmlns="http://www.sonos.com/Services/1.1">` +
        `<loginToken><token>${credentials.authToken}</token>` +
        `<key>${credentials.privateKey}</key>` +
        `<householdId>${credentials.householdId}</householdId>` +
        `</loginToken></credentials></soap:Header>`;
  return new Request("https://smapi.example.test/smapi", {
    body:
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
      header +
      `<soap:Body><${method} xmlns="http://www.sonos.com/Services/1.1">` +
      `${parameters}</${method}></soap:Body></soap:Envelope>`,
    headers: {
      "content-type": "text/xml; charset=utf-8",
      soapaction: `"http://www.sonos.com/Services/1.1#${method}"`,
    },
    method: "POST",
  });
}

function element(xml: string, name: string): string {
  const match = new RegExp(`<${name}>([^<]+)</${name}>`, "u").exec(xml);
  if (match?.[1] === undefined) {
    throw new Error(`Missing ${name} in test SOAP response`);
  }

  return match[1];
}

describe("Milestone 5 browser-link and Sonos-authentication lifecycle", () => {
  it("stores separate encrypted Jellyfin and hash-only long-lived Sonos credentials", async () => {
    const repository = new MemoryLinks();
    const connectionRepository = new MemoryConnections();
    const sonosRepository = new MemorySonosConnections();
    const jellyfin = createJellyfin();
    let now = 1_000;
    let randomValue = 0;
    const links = new LinkService({
      now: () => now,
      randomBytes: (length) => {
        const bytes = new Uint8Array(length);
        bytes.fill(randomValue);
        randomValue += 1;
        return bytes;
      },
      repository,
    });
    const connections = new JellyfinConnectionService({
      cipher: new AesGcmTokenCipher(
        TOKEN_ENCRYPTION_KEY,
        () => new Uint8Array(12).fill(9),
      ),
      now: () => 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(7),
      repository: connectionRepository,
    });
    const smapiConnections = new JellyfinConnectionService({
      cipher: new AesGcmTokenCipher(TOKEN_ENCRYPTION_KEY),
      now: () => 1_000,
      repository: connectionRepository,
    });
    const sonosAuthentication = new SonosAuthenticationService({
      now: () => now,
      repository: sonosRepository,
      signingKey: SONOS_SIGNING_KEY,
    });
    const logSink = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const createJellyfinDataClient = vi
      .fn()
      .mockReturnValue({} as JellyfinDataClient);
    const dependencies = {
      browse: new SonofinBrowseService(),
      createJellyfinDataClient,
      extendedMetadata: new SonofinExtendedMetadataService(),
      jellyfinConnections: smapiConnections,
      links,
      logSink,
      mediaMetadata: new SonofinMediaMetadataService(),
      nowMilliseconds: () => now * 1_000,
      onboardingUrl: "https://auth.example.test/onboarding",
      search: new SonofinSearchService(),
      sonosAuthentication,
      ttlSeconds: 600,
    };
    const householdId = "Sonos_HH_case-sensitive";

    const appLink = await handleSmapi(
      soapRequest(
        "getAppLink",
        `<householdId>${householdId}</householdId>`,
      ),
      dependencies,
    );
    const appLinkXml = await appLink.text();
    const linkCode = element(appLinkXml, "linkCode");
    const linkDeviceId = element(appLinkXml, "linkDeviceId");

    expect(appLink.status).toBe(200);
    expect(linkCode).toHaveLength(32);
    expect(linkDeviceId).toHaveLength(32);
    expect(JSON.stringify([...repository.records.values()])).not.toContain(
      linkCode,
    );
    expect(JSON.stringify([...repository.records.values()])).not.toContain(
      linkDeviceId,
    );

    const deviceParameters =
      `<householdId>${householdId}</householdId>` +
      `<linkCode>${linkCode}</linkCode>` +
      `<linkDeviceId>${linkDeviceId}</linkDeviceId>`;
    const pending = await handleSmapi(
      soapRequest("getDeviceAuthToken", deviceParameters),
      dependencies,
    );
    expect(pending.status).toBe(500);
    expect(await pending.text()).toContain("Client.NOT_LINKED_RETRY");

    const onboardingUrl = `https://auth.example.test/onboarding?linkCode=${encodeURIComponent(linkCode)}`;
    const page = await handleOnboarding(
      new Request(onboardingUrl),
      links,
      jellyfin,
      connections,
    );
    const pageHtml = await page.text();
    expect(page.status).toBe(200);
    expect(pageHtml).toContain(
      "Enter your Jellyfin server and either your username and password",
    );
    expect(pageHtml).toContain("Connect Jellyfin");
    expect(pageHtml).not.toContain("Connect test account");

    const completion = await handleOnboarding(
      new Request("https://auth.example.test/onboarding", {
        body: new URLSearchParams({
          accessToken: "",
          linkCode,
          password: JELLYFIN_PASSWORD,
          serverUrl: JELLYFIN_SERVER_URL,
          username: JELLYFIN_CONNECTION.username,
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      links,
      jellyfin,
      connections,
    );
    expect(completion.status).toBe(303);
    const completionBody = await completion.text();
    expect(completionBody).not.toContain(JELLYFIN_PASSWORD);
    expect(completionBody).not.toContain(JELLYFIN_TOKEN);
    expect(jellyfin.authenticateWithPassword).toHaveBeenCalledOnce();
    expect(jellyfin.authenticateWithPassword).toHaveBeenCalledWith({
      password: JELLYFIN_PASSWORD,
      serverUrl: JELLYFIN_SERVER_URL,
      username: JELLYFIN_CONNECTION.username,
    });
    expect(jellyfin.authenticateWithToken).not.toHaveBeenCalled();
    expect(jellyfin.revokeAccessToken).not.toHaveBeenCalled();

    const storedAfterCompletion = JSON.stringify([
      ...repository.records.values(),
      ...connectionRepository.records.values(),
    ]);
    expect(storedAfterCompletion).toContain(JELLYFIN_CONNECTION.serverId);
    expect(storedAfterCompletion).toContain(JELLYFIN_CONNECTION.userId);
    expect(storedAfterCompletion).not.toContain(JELLYFIN_PASSWORD);
    expect(storedAfterCompletion).not.toContain(JELLYFIN_TOKEN);
    expect(connectionRepository.records.size).toBe(1);
    const linkedConnectionId = [...repository.records.values()][0]
      ?.jellyfinConnectionId;
    expect(linkedConnectionId).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    if (linkedConnectionId === null || linkedConnectionId === undefined) {
      throw new Error("Expected the link to reference a Jellyfin connection");
    }
    await expect(
      smapiConnections.retrieve(linkedConnectionId),
    ).resolves.toEqual(JELLYFIN_CONNECTION);

    const completedPage = await handleOnboarding(
      new Request(onboardingUrl),
      links,
      jellyfin,
      connections,
    );
    const completedPageHtml = await completedPage.text();
    expect(completedPageHtml).toContain("Connection complete");
    expect(completedPageHtml).not.toContain(JELLYFIN_PASSWORD);
    expect(completedPageHtml).not.toContain(JELLYFIN_TOKEN);

    const firstToken = await handleSmapi(
      soapRequest("getDeviceAuthToken", deviceParameters),
      dependencies,
    );
    const firstTokenXml = await firstToken.text();
    expect(firstToken.status).toBe(200);
    expect(element(firstTokenXml, "authToken")).toMatch(
      /^SF_[A-Za-z0-9_-]{43}$/u,
    );
    expect(element(firstTokenXml, "privateKey")).toMatch(
      /^SF_NO_REFRESH_[A-Za-z0-9_-]{43}$/u,
    );
    expect(firstTokenXml).not.toContain("SF_M2_FAKE_");
    expect(firstTokenXml).not.toContain(JELLYFIN_PASSWORD);
    expect(firstTokenXml).not.toContain(JELLYFIN_TOKEN);
    const authToken = element(firstTokenXml, "authToken");
    const privateKey = element(firstTokenXml, "privateKey");
    expect(sonosRepository.records.size).toBe(1);
    const storedSonos = JSON.stringify([...sonosRepository.records.values()]);
    expect(storedSonos).toContain(linkedConnectionId);
    expect(storedSonos).toContain(householdId);
    expect(storedSonos).not.toContain(authToken);
    expect(storedSonos).not.toContain(privateKey);

    const authenticated = await handleSmapi(
      soapRequest("getLastUpdate", "", {
        authToken,
        householdId,
        privateKey,
      }),
      dependencies,
    );
    expect(authenticated.status).toBe(200);
    expect(await authenticated.text()).toContain("<getLastUpdateResponse");
    expect(createJellyfinDataClient).toHaveBeenCalledOnce();
    expect(createJellyfinDataClient).toHaveBeenCalledWith(
      JELLYFIN_CONNECTION,
    );

    const rootBrowse = await handleSmapi(
      soapRequest(
        "getMetadata",
        "<id>root</id><index>0</index><count>100</count>",
        {
          authToken,
          householdId,
          privateKey,
        },
      ),
      dependencies,
    );
    const rootBrowseXml = await rootBrowse.text();
    expect(rootBrowse.status).toBe(200);
    expect(rootBrowseXml).toContain(
      "<getMetadataResult><index>0</index><count>3</count><total>3</total>",
    );
    expect(rootBrowseXml).toContain(
      "<id>artists</id><itemType>container</itemType><title>Artists</title>",
    );
    expect(rootBrowseXml).toContain(
      "<id>albums</id><itemType>albumList</itemType><title>Albums</title>",
    );
    expect(rootBrowseXml).toContain(
      "<id>playlists</id><itemType>container</itemType><title>Playlists</title>",
    );
    expect(rootBrowseXml).not.toContain(
      "<id>search</id><itemType>container</itemType><title>Search</title>",
    );
    expect(rootBrowseXml).not.toContain(JELLYFIN_PASSWORD);
    expect(rootBrowseXml).not.toContain(JELLYFIN_TOKEN);
    expect(createJellyfinDataClient).toHaveBeenCalledTimes(2);

    const wrongKeyConnections = new JellyfinConnectionService({
      cipher: new AesGcmTokenCipher(WRONG_TOKEN_ENCRYPTION_KEY),
      now: () => now,
      repository: connectionRepository,
    });
    const undecryptable = await handleSmapi(
      soapRequest("getLastUpdate", "", {
        authToken,
        householdId,
        privateKey,
      }),
      {
        ...dependencies,
        jellyfinConnections: wrongKeyConnections,
      },
    );
    const undecryptableBody = await undecryptable.text();
    expect(undecryptable.status).toBe(500);
    expect(undecryptableBody).toContain(
      "<faultcode>Server.ServiceUnknownError</faultcode>",
    );
    expect(undecryptableBody).not.toContain(JELLYFIN_TOKEN);
    expect(undecryptableBody).not.toContain(JELLYFIN_SERVER_URL);
    expect(createJellyfinDataClient).toHaveBeenCalledTimes(2);

    const unknownToken = await handleSmapi(
      soapRequest("getLastUpdate", "", {
        authToken: `SF_${"z".repeat(43)}`,
        householdId,
        privateKey,
      }),
      dependencies,
    );
    expect(unknownToken.status).toBe(500);
    expect(await unknownToken.text()).toContain("Client.LoginUnauthorized");

    const replay = await handleSmapi(
      soapRequest("getDeviceAuthToken", deviceParameters),
      dependencies,
    );
    expect(await replay.text()).toBe(firstTokenXml);

    now = 1_600;
    const afterLinkExpiry = await handleSmapi(
      soapRequest("getLastUpdate", "", {
        authToken,
        householdId,
        privateKey,
      }),
      dependencies,
    );
    expect(afterLinkExpiry.status).toBe(200);
    expect(await afterLinkExpiry.text()).toContain("<getLastUpdateResponse");

    const expiredLinkReplay = await handleSmapi(
      soapRequest("getDeviceAuthToken", deviceParameters),
      dependencies,
    );
    expect(expiredLinkReplay.status).toBe(500);
    expect(await expiredLinkReplay.text()).toContain(
      "Client.NOT_LINKED_FAILURE",
    );

    const wrongHousehold = await handleSmapi(
      soapRequest(
        "getDeviceAuthToken",
        deviceParameters.replace(householdId, `${householdId}-different`),
      ),
      dependencies,
    );
    expect(wrongHousehold.status).toBe(500);
    const wrongHouseholdXml = await wrongHousehold.text();
    expect(wrongHouseholdXml).toContain("Client.NOT_LINKED_FAILURE");
    expect(wrongHouseholdXml).not.toContain(JELLYFIN_PASSWORD);
    expect(wrongHouseholdXml).not.toContain(JELLYFIN_TOKEN);
    expect(pageHtml).not.toContain(JELLYFIN_PASSWORD);
    expect(pageHtml).not.toContain(JELLYFIN_TOKEN);
    const logs = JSON.stringify([
      vi.mocked(logSink.error).mock.calls,
      vi.mocked(logSink.info).mock.calls,
      vi.mocked(logSink.warn).mock.calls,
    ]);
    expect(logs).not.toContain(JELLYFIN_PASSWORD);
    expect(logs).not.toContain(JELLYFIN_TOKEN);
  });
});
