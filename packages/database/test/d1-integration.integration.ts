import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness, type WorkerHandle } from "wrangler";

import {
  JellyfinConnectionService,
  type NewJellyfinConnectionRecord,
} from "@sonofin/connections";
import { AesGcmTokenCipher } from "@sonofin/crypto";
import type { NewPendingLink } from "@sonofin/linking";
import {
  SonosAuthenticationService,
  type NewSonosConnectionRecord,
} from "@sonofin/sonos-auth";

import migration0000 from "../migrations/0000_onboarding_links.sql?raw";
import migration0001 from "../migrations/0001_secure_jellyfin_connections.sql?raw";
import {
  D1JellyfinConnectionRepository,
  D1LinkRepository,
  D1SonosConnectionRepository,
} from "../src";

interface TestEnv {
  DB: D1Database;
}

const TEST_ENCRYPTION_KEY = "A".repeat(43);
const PLAINTEXT_TOKEN_SENTINEL = "SF_PLAINTEXT_TOKEN_MUST_NOT_REACH_D1";

function pending(seed: string, id = seed.repeat(64)): NewPendingLink {
  return {
    createdAt: 1_000,
    expiresAt: 1_420,
    householdId: `HH-${seed}`,
    id,
    linkCodeHash: seed.repeat(64),
    linkDeviceIdHash: (seed === "a" ? "b" : "a").repeat(64),
  };
}

function connection(seed: string): NewJellyfinConnectionRecord {
  return {
    id: seed.repeat(32),
    serverUrl: "https://media.example/jellyfin",
    serverId: "server-id",
    serverName: " Living Room 🎵 ",
    serverVersion: "10.11.0",
    userId: "user-id",
    username: "  exact user  ",
    deviceId: "device-id",
    tokenAlgorithm: "A256GCM",
    encryptedToken: `${seed.repeat(21)}A`,
    tokenNonce: seed.repeat(16),
    createdAt: 1_000,
  };
}

function sonosConnection(
  idSeed: string,
  jellyfinConnectionId: string,
  householdId: string,
  authTokenHashSeed: string,
): NewSonosConnectionRecord {
  return {
    id: idSeed.repeat(64),
    jellyfinConnectionId,
    householdId,
    authTokenHash: authTokenHashSeed.repeat(64),
    createdAt: 1_200,
    revokedAt: null,
  };
}

async function applySql(database: D1Database, sql: string): Promise<void> {
  for (const statement of sql.split(";")) {
    const query = statement.trim();
    if (query !== "") {
      await database.prepare(query).run();
    }
  }
}

describe("D1 repositories against local D1", () => {
  let server: TestHarness;
  let worker: WorkerHandle<TestEnv>;
  let database: D1Database;
  let connections: D1JellyfinConnectionRepository;
  let links: D1LinkRepository;
  let sonosConnections: D1SonosConnectionRepository;

  beforeAll(async () => {
    server = createTestHarness({
      root: ".",
      workers: [{ configPath: "apps/smapi-worker/wrangler.jsonc" }],
    });
    await server.listen();
    worker = server.getWorker<TestEnv>("sonofin-smapi");
    await worker.applyD1Migrations("DB");
    database = (await worker.getEnv()).DB;
    connections = new D1JellyfinConnectionRepository(database);
    links = new D1LinkRepository(database);
    sonosConnections = new D1SonosConnectionRepository(database);
  });

  afterAll(async () => {
    await server.close();
  });

  it("enforces migration constraints, conflicts, expiry, and atomic claims", async () => {
    const first = pending("a");
    await expect(links.insertPending(first)).resolves.toBe(true);
    await expect(links.insertPending(first)).resolves.toBe(false);

    await expect(
      links.insertPending({
        ...pending("b"),
        householdId: "x".repeat(256),
      }),
    ).rejects.toThrow();

    // A different code colliding with the generated record ID is retryable,
    // while the CHECK violation above propagates instead of being hidden.
    await expect(
      links.insertPending(pending("c", first.id)),
    ).resolves.toBe(false);

    const boundary = pending("d");
    await links.insertPending(boundary);
    await expect(
      links.completePending({
        completedAt: boundary.expiresAt,
        jellyfinConnectionId: "B".repeat(32),
        linkCodeHash: boundary.linkCodeHash,
      }),
    ).resolves.toMatchObject({ outcome: "unchanged" });

    const raced = pending("e");
    const racedConnection = connection("R");
    await connections.insert(racedConnection);
    await links.insertPending(raced);
    const completions = await Promise.all([
      links.completePending({
        completedAt: 1_100,
        jellyfinConnectionId: racedConnection.id,
        linkCodeHash: raced.linkCodeHash,
      }),
      links.completePending({
        completedAt: 1_100,
        jellyfinConnectionId: racedConnection.id,
        linkCodeHash: raced.linkCodeHash,
      }),
    ]);
    expect(completions.map((result) => result.outcome).sort()).toEqual([
      "unchanged",
      "updated",
    ]);

    await expect(
      links.claimCompleted({
        claimedAt: raced.expiresAt,
        linkCodeHash: raced.linkCodeHash,
      }),
    ).resolves.toMatchObject({ outcome: "unchanged" });

    const claims = await Promise.all([
      links.claimCompleted({
        claimedAt: 1_200,
        linkCodeHash: raced.linkCodeHash,
      }),
      links.claimCompleted({
        claimedAt: 1_200,
        linkCodeHash: raced.linkCodeHash,
      }),
    ]);
    expect(claims.map((result) => result.outcome).sort()).toEqual([
      "unchanged",
      "updated",
    ]);

    const stored = await database
      .prepare(
        `
          SELECT
            length(link_code_hash) AS code_hash_length,
            length(link_device_id_hash) AS device_hash_length,
            completed_at,
            claimed_at,
            jellyfin_connection_id
          FROM onboarding_links
          WHERE link_code_hash = ?1
        `,
      )
      .bind(raced.linkCodeHash)
      .first<{
        code_hash_length: number;
        device_hash_length: number;
        completed_at: number;
        claimed_at: number;
        jellyfin_connection_id: string;
      }>();

    expect(stored).toEqual({
      claimed_at: 1_200,
      code_hash_length: 64,
      completed_at: 1_100,
      device_hash_length: 64,
      jellyfin_connection_id: racedConnection.id,
    });
  });

  it("persists encrypted connections, exact metadata, and link associations", async () => {
    const record = connection("C");
    await expect(connections.insert(record)).resolves.toBe(true);
    await expect(connections.insert(record)).resolves.toBe(false);
    await expect(connections.findById(record.id)).resolves.toEqual(record);

    // Server/user identity is metadata rather than a uniqueness boundary. A
    // user may create more than one separately encrypted connection.
    const sameIdentity = {
      ...connection("D"),
      serverId: record.serverId,
      userId: record.userId,
    };
    await expect(connections.insert(sameIdentity)).resolves.toBe(true);

    const invalidRecords: NewJellyfinConnectionRecord[] = [
      { ...connection("H"), id: "H".repeat(31) },
      { ...connection("I"), id: `+${"I".repeat(31)}` },
      { ...connection("J"), serverUrl: "x".repeat(2_049) },
      { ...connection("K"), encryptedToken: `+${"K".repeat(20)}A` },
      { ...connection("L"), tokenNonce: "L".repeat(15) },
      {
        ...connection("M"),
        tokenAlgorithm: "AES-GCM" as "A256GCM",
      },
      { ...connection("N"), createdAt: -1 },
    ];
    for (const invalid of invalidRecords) {
      await expect(connections.insert(invalid)).rejects.toThrow();
    }

    const raw = await database
      .prepare("SELECT * FROM jellyfin_connections WHERE id = ?1")
      .bind(record.id)
      .first<Record<string, unknown>>();
    expect(raw).not.toBeNull();
    expect(raw).toMatchObject({
      encrypted_token: record.encryptedToken,
      token_algorithm: record.tokenAlgorithm,
      token_nonce: record.tokenNonce,
    });
    expect(Object.keys(raw ?? {})).not.toEqual(
      expect.arrayContaining(["access_token", "password", "plaintext_token"]),
    );
    const associationIndex = await database
      .prepare(
        `
          SELECT sql
          FROM sqlite_master
          WHERE type = 'index' AND name = ?1
        `,
      )
      .bind("onboarding_links_jellyfin_connection_id_idx")
      .first<{ sql: string }>();
    expect(associationIndex?.sql).toContain("jellyfin_connection_id");

    const associated = pending("f");
    await links.insertPending(associated);
    await expect(
      links.completePending({
        completedAt: 1_100,
        jellyfinConnectionId: record.id,
        linkCodeHash: associated.linkCodeHash,
      }),
    ).resolves.toMatchObject({
      outcome: "updated",
      link: { jellyfinConnectionId: record.id },
    });

    await expect(connections.deleteById(record.id)).rejects.toThrow();
    await expect(connections.findById(record.id)).resolves.toEqual(record);

    const nonexistentAssociation = pending("6");
    await links.insertPending(nonexistentAssociation);
    await expect(
      links.completePending({
        completedAt: 1_100,
        jellyfinConnectionId: "Z".repeat(32),
        linkCodeHash: nonexistentAssociation.linkCodeHash,
      }),
    ).rejects.toThrow();

    const invalidAssociation = pending("7");
    await links.insertPending(invalidAssociation);
    await expect(
      links.completePending({
        completedAt: 1_100,
        jellyfinConnectionId: `+${"I".repeat(31)}`,
        linkCodeHash: invalidAssociation.linkCodeHash,
      }),
    ).rejects.toThrow();

    const deletable = connection("Z");
    await expect(connections.insert(deletable)).resolves.toBe(true);
    await expect(connections.deleteById(deletable.id)).resolves.toBe(true);
    await expect(connections.deleteById(deletable.id)).resolves.toBe(false);
    await expect(connections.findById(deletable.id)).resolves.toBeNull();
  });

  it("stores only Sonos token hashes and revokes an exact household mapping", async () => {
    const jellyfin = connection("Y");
    await expect(connections.insert(jellyfin)).resolves.toBe(true);

    const householdId = "Sonos_HH_Case-Sensitive";
    const linkSeeds = ["0", "1", "2", "5"];
    for (const seed of linkSeeds) {
      const link = { ...pending(seed), householdId };
      await expect(links.insertPending(link)).resolves.toBe(true);
      await expect(
        links.completePending({
          completedAt: 1_100,
          jellyfinConnectionId: jellyfin.id,
          linkCodeHash: link.linkCodeHash,
        }),
      ).resolves.toMatchObject({ outcome: "updated" });
      await expect(
        links.claimCompleted({
          claimedAt: 1_150,
          linkCodeHash: link.linkCodeHash,
        }),
      ).resolves.toMatchObject({ outcome: "updated" });
    }

    const first = sonosConnection("0", jellyfin.id, householdId, "3");
    const second = sonosConnection("1", jellyfin.id, householdId, "4");
    await expect(sonosConnections.insert(first)).resolves.toBe(true);
    await expect(sonosConnections.insert(second)).resolves.toBe(true);

    const active = await database
      .prepare(
        `
          SELECT id, household_id, revoked_at
          FROM sonos_connections
          WHERE household_id = ?1
          ORDER BY id
        `,
      )
      .bind(householdId)
      .all<{
        id: string;
        household_id: string;
        revoked_at: number | null;
      }>();
    expect(active.results).toEqual([
      {
        id: first.id,
        household_id: householdId,
        revoked_at: null,
      },
      {
        id: second.id,
        household_id: householdId,
        revoked_at: null,
      },
    ]);

    const duplicateHash = sonosConnection("2", jellyfin.id, householdId, "3");
    await expect(sonosConnections.insert(duplicateHash)).resolves.toBe(false);
    await expect(sonosConnections.findById(duplicateHash.id)).resolves.toBeNull();

    await expect(
      sonosConnections.revokeByAuthTokenHash({
        authTokenHash: first.authTokenHash,
        householdId: householdId.toLowerCase(),
        revokedAt: 1_299,
      }),
    ).resolves.toBeNull();
    await expect(
      sonosConnections.findByAuthTokenHash(first.authTokenHash),
    ).resolves.toEqual(first);

    await expect(
      sonosConnections.revokeByAuthTokenHash({
        authTokenHash: first.authTokenHash,
        householdId,
        revokedAt: 1_300,
      }),
    ).resolves.toEqual({ ...first, revokedAt: 1_300 });
    await expect(
      sonosConnections.findByAuthTokenHash(first.authTokenHash),
    ).resolves.toEqual({ ...first, revokedAt: 1_300 });
    await expect(
      sonosConnections.findByAuthTokenHash(second.authTokenHash),
    ).resolves.toEqual(second);

    const schema = await database
      .prepare(
        `
          SELECT sql
          FROM sqlite_master
          WHERE type = 'table' AND name = 'sonos_connections'
        `,
      )
      .first<{ sql: string }>();
    expect(schema?.sql).toContain(
      "REFERENCES onboarding_links(id) ON DELETE RESTRICT",
    );
    expect(schema?.sql).toContain(
      "REFERENCES jellyfin_connections(id) ON DELETE RESTRICT",
    );
    expect(schema?.sql).toContain("auth_token_hash TEXT NOT NULL UNIQUE");
    expect(schema?.sql).toContain("STRICT");
    expect(schema?.sql).not.toMatch(/household_id[^,]*unique/iu);

    const associationTrigger = await database
      .prepare(
        `
          SELECT sql
          FROM sqlite_master
          WHERE type = 'trigger'
            AND name = 'sonos_connections_require_claimed_link'
        `,
      )
      .first<{ sql: string }>();
    expect(associationTrigger?.sql).toContain("claimed_at IS NOT NULL");
    expect(associationTrigger?.sql).toContain(
      "household_id = NEW.household_id",
    );
    expect(associationTrigger?.sql).toContain(
      "jellyfin_connection_id = NEW.jellyfin_connection_id",
    );
    const updateAssociationTrigger = await database
      .prepare(
        `
          SELECT sql
          FROM sqlite_master
          WHERE type = 'trigger'
            AND name = 'sonos_connections_preserve_claimed_link'
        `,
      )
      .first<{ sql: string }>();
    expect(updateAssociationTrigger?.sql).toContain(
      "BEFORE UPDATE OF id, jellyfin_connection_id, household_id",
    );

    const columns = await database
      .prepare("PRAGMA table_info(sonos_connections)")
      .all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toEqual([
      "id",
      "jellyfin_connection_id",
      "household_id",
      "auth_token_hash",
      "created_at",
      "revoked_at",
    ]);
    expect(JSON.stringify(columns.results)).not.toMatch(
      /plaintext|raw_token|password|private_key/iu,
    );

    const indexes = await database
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'index' AND name LIKE 'sonos_connections_%_idx'
          ORDER BY name
        `,
      )
      .all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toEqual([
      "sonos_connections_household_id_idx",
      "sonos_connections_jellyfin_connection_id_idx",
    ]);

    const validUnstored = sonosConnection("5", jellyfin.id, householdId, "5");
    const invalidRecords: NewSonosConnectionRecord[] = [
      { ...validUnstored, householdId: "" },
      { ...validUnstored, householdId: "x".repeat(256) },
      { ...validUnstored, authTokenHash: "A".repeat(64) },
      { ...validUnstored, createdAt: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...validUnstored,
        revokedAt: (validUnstored.createdAt - 1) as unknown as null,
      },
    ];
    for (const invalid of invalidRecords) {
      await expect(sonosConnections.insert(invalid)).rejects.toThrow();
    }

    const pendingLink = { ...pending("9"), householdId };
    await links.insertPending(pendingLink);
    await expect(
      sonosConnections.insert(
        sonosConnection("9", jellyfin.id, householdId, "7"),
      ),
    ).rejects.toThrow();
    await expect(
      sonosConnections.insert({
        ...validUnstored,
        householdId: `${householdId}-wrong`,
      }),
    ).rejects.toThrow();
    await expect(
      sonosConnections.insert({
        ...validUnstored,
        jellyfinConnectionId: connection("R").id,
      }),
    ).rejects.toThrow();
    await expect(
      database
        .prepare(
          "UPDATE sonos_connections SET household_id = ?1 WHERE id = ?2",
        )
        .bind(`${householdId}-wrong`, second.id)
        .run(),
    ).rejects.toThrow();

    await expect(
      sonosConnections.insert(
        sonosConnection("b", jellyfin.id, householdId, "6"),
      ),
    ).rejects.toThrow();
    await expect(
      sonosConnections.insert({
        ...validUnstored,
        jellyfinConnectionId: "U".repeat(32),
      }),
    ).rejects.toThrow();
    await expect(
      database
        .prepare("DELETE FROM onboarding_links WHERE id = ?1")
        .bind(second.id)
        .run(),
    ).rejects.toThrow();
  });

  it("round-trips Sonos authentication through D1 without storing credentials", async () => {
    const jellyfin = connection("Q");
    const link = { ...pending("8"), householdId: "Sonos_HH_D1_Round_Trip" };
    await connections.insert(jellyfin);
    await links.insertPending(link);
    await links.completePending({
      completedAt: 1_100,
      jellyfinConnectionId: jellyfin.id,
      linkCodeHash: link.linkCodeHash,
    });
    await links.claimCompleted({
      claimedAt: 1_150,
      linkCodeHash: link.linkCodeHash,
    });

    let now = 1_200;
    const authentication = new SonosAuthenticationService({
      now: () => now,
      repository: sonosConnections,
      signingKey: "A".repeat(43),
    });
    const issued = await authentication.issue({
      householdId: link.householdId,
      jellyfinConnectionId: jellyfin.id,
      linkId: link.id,
    });
    expect(issued.outcome).toBe("success");
    if (issued.outcome !== "success") {
      throw new Error("Expected a durable Sonos credential");
    }

    const raw = await database
      .prepare("SELECT * FROM sonos_connections WHERE id = ?1")
      .bind(link.id)
      .first<Record<string, unknown>>();
    expect(raw).toMatchObject({
      household_id: link.householdId,
      jellyfin_connection_id: jellyfin.id,
      revoked_at: null,
    });
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain(issued.authToken);
    expect(serialized).not.toContain(issued.privateKey);
    expect(serialized).not.toContain("A".repeat(43));

    await expect(
      authentication.authenticate({
        authToken: issued.authToken,
        householdId: link.householdId,
      }),
    ).resolves.toEqual({
      outcome: "success",
      connection: {
        householdId: link.householdId,
        id: link.id,
        jellyfinConnectionId: jellyfin.id,
      },
    });

    now = 1_300;
    await expect(
      authentication.revoke({
        authToken: issued.authToken,
        householdId: link.householdId,
      }),
    ).resolves.toBe(true);
    await expect(
      authentication.authenticate({
        authToken: issued.authToken,
        householdId: link.householdId,
      }),
    ).resolves.toEqual({ outcome: "failure" });
  });

  it("round-trips a real encrypted token without storing plaintext", async () => {
    const normalizedConnection = {
      serverUrl: "https://media.example/jellyfin",
      serverId: "server-round-trip",
      serverName: "Round Trip Server",
      serverVersion: "10.11.0",
      userId: "user-round-trip",
      username: "Music Fan",
      deviceId: "device-round-trip",
      accessToken: PLAINTEXT_TOKEN_SENTINEL,
    };
    const service = new JellyfinConnectionService({
      repository: new D1JellyfinConnectionRepository(database),
      cipher: new AesGcmTokenCipher(
        TEST_ENCRYPTION_KEY,
        () => new Uint8Array(12).fill(9),
      ),
      now: () => 1_700_000_000,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });

    const { connectionId } = await service.store(normalizedConnection);
    const raw = await database
      .prepare("SELECT * FROM jellyfin_connections WHERE id = ?1")
      .bind(connectionId)
      .first<Record<string, unknown>>();

    expect(raw).not.toBeNull();
    expect(JSON.stringify(raw)).not.toContain(PLAINTEXT_TOKEN_SENTINEL);
    expect(raw?.encrypted_token).not.toBe(PLAINTEXT_TOKEN_SENTINEL);

    const recreatedService = new JellyfinConnectionService({
      repository: new D1JellyfinConnectionRepository(database),
      cipher: new AesGcmTokenCipher(TEST_ENCRYPTION_KEY),
      now: () => 1_700_000_001,
    });
    await expect(recreatedService.retrieve(connectionId)).resolves.toEqual(
      normalizedConnection,
    );
  });
});

describe("0000 to 0001 populated migration", () => {
  let server: TestHarness;
  let database: D1Database;

  beforeAll(async () => {
    server = createTestHarness({
      root: ".",
      workers: [{ configPath: "apps/smapi-worker/wrangler.jsonc" }],
    });
    await server.listen();
    const worker = server.getWorker<TestEnv>("sonofin-smapi");
    database = (await worker.getEnv()).DB;

    await applySql(database, migration0000);
    await database
      .prepare(
        `
          INSERT INTO onboarding_links (
            id,
            link_code_hash,
            link_device_id_hash,
            household_id,
            created_at,
            expires_at,
            completed_at,
            claimed_at,
            fake_jellyfin_connection_id
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        `,
      )
      .bind(
        "0".repeat(64),
        "1".repeat(64),
        "2".repeat(64),
        "HH-legacy-complete",
        1_000,
        1_420,
        1_100,
        1_200,
        "m3:validated-marker",
      )
      .run();
    await database
      .prepare(
        `
          INSERT INTO onboarding_links (
            id,
            link_code_hash,
            link_device_id_hash,
            household_id,
            created_at,
            expires_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        `,
      )
      .bind(
        "3".repeat(64),
        "4".repeat(64),
        "5".repeat(64),
        "HH-legacy-pending",
        2_000,
        2_420,
      )
      .run();
    await applySql(database, migration0001);
  });

  afterAll(async () => {
    await server.close();
  });

  it("preserves link bindings while clearing non-durable M3 completion", async () => {
    const rows = await database
      .prepare(
        `
          SELECT
            id,
            link_code_hash,
            link_device_id_hash,
            household_id,
            created_at,
            expires_at,
            completed_at,
            claimed_at,
            jellyfin_connection_id
          FROM onboarding_links
          ORDER BY created_at
        `,
      )
      .all<Record<string, unknown>>();

    expect(rows.results).toEqual([
      {
        id: "0".repeat(64),
        link_code_hash: "1".repeat(64),
        link_device_id_hash: "2".repeat(64),
        household_id: "HH-legacy-complete",
        created_at: 1_000,
        expires_at: 1_420,
        completed_at: null,
        claimed_at: null,
        jellyfin_connection_id: null,
      },
      {
        id: "3".repeat(64),
        link_code_hash: "4".repeat(64),
        link_device_id_hash: "5".repeat(64),
        household_id: "HH-legacy-pending",
        created_at: 2_000,
        expires_at: 2_420,
        completed_at: null,
        claimed_at: null,
        jellyfin_connection_id: null,
      },
    ]);
  });

  it("installs the restrictive association schema and both indexes", async () => {
    const table = await database
      .prepare(
        `
          SELECT sql
          FROM sqlite_master
          WHERE type = 'table' AND name = 'onboarding_links'
        `,
      )
      .first<{ sql: string }>();
    expect(table?.sql).toContain(
      "REFERENCES jellyfin_connections(id) ON DELETE RESTRICT",
    );
    expect(table?.sql).toContain("length(jellyfin_connection_id) = 32");
    expect(table?.sql).not.toContain("fake_jellyfin_connection_id");

    const indexes = await database
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'index' AND name LIKE 'onboarding_links_%_idx'
          ORDER BY name
        `,
      )
      .all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toEqual([
      "onboarding_links_expires_at_idx",
      "onboarding_links_jellyfin_connection_id_idx",
    ]);
  });
});
