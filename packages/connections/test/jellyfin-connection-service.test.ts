import { describe, expect, it } from "vitest";

import {
  TokenCipherError,
  type EncryptedToken,
  type TokenCipher,
} from "@sonofin/crypto";
import type { JellyfinConnection } from "@sonofin/jellyfin-client";

import {
  CONNECTION_ID_BYTE_LENGTH,
  JellyfinConnectionCollisionError,
  JellyfinConnectionService,
  JellyfinConnectionValidationError,
  MAX_CONNECTION_ACCESS_TOKEN_CHARACTERS,
  MAX_CONNECTION_METADATA_CHARACTERS,
  type JellyfinConnectionRecord,
  type JellyfinConnectionRepository,
  type NewJellyfinConnectionRecord,
} from "../src";

const ACCESS_TOKEN = "jellyfin-token-must-never-be-persisted-in-plaintext";
const CONNECTION = {
  accessToken: ACCESS_TOKEN,
  deviceId: "device-case-sensitive",
  serverId: "server-case-sensitive",
  serverName: "Living Room Jellyfin",
  serverUrl: "https://jellyfin.example.test/media",
  serverVersion: "10.11.0",
  userId: "user-case-sensitive",
  username: "Alice",
} satisfies JellyfinConnection;

class MemoryConnectionRepository implements JellyfinConnectionRepository {
  readonly records = new Map<string, JellyfinConnectionRecord>();
  readonly insertAttempts: NewJellyfinConnectionRecord[] = [];
  collisionsRemaining = 0;

  async insert(record: NewJellyfinConnectionRecord): Promise<boolean> {
    this.insertAttempts.push({ ...record });
    if (this.collisionsRemaining > 0) {
      this.collisionsRemaining -= 1;
      return false;
    }
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

interface CipherEntry {
  plaintext: string;
  associatedData: string;
  encrypted: EncryptedToken;
}

class RecordingCipher implements TokenCipher {
  readonly encryptions: CipherEntry[] = [];

  async encrypt(
    plaintext: string,
    associatedData: string,
  ): Promise<EncryptedToken> {
    const sequence = this.encryptions.length.toString(36).padStart(2, "0");
    const encrypted = {
      algorithm: "A256GCM",
      ciphertext: `ciphertext${sequence}${"A".repeat(20)}`,
      nonce: `${sequence}${"B".repeat(14)}`,
    } as const;
    this.encryptions.push({ plaintext, associatedData, encrypted });
    return encrypted;
  }

  async decrypt(
    encrypted: EncryptedToken,
    associatedData: string,
  ): Promise<string> {
    const match = this.encryptions.find(
      (entry) =>
        entry.encrypted.algorithm === encrypted.algorithm &&
        entry.encrypted.ciphertext === encrypted.ciphertext &&
        entry.encrypted.nonce === encrypted.nonce,
    );
    if (match === undefined || match.associatedData !== associatedData) {
      throw new TokenCipherError("decryption_failed");
    }
    return match.plaintext;
  }
}

function sequentialRandom(requests?: number[]): (length: number) => Uint8Array {
  let value = 0;
  return (length) => {
    requests?.push(length);
    const bytes = new Uint8Array(length);
    bytes.fill(value);
    value = (value + 1) & 0xff;
    return bytes;
  };
}

function makeHarness(options?: {
  repository?: MemoryConnectionRepository;
  cipher?: RecordingCipher;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  collisionRetries?: number;
}) {
  const repository = options?.repository ?? new MemoryConnectionRepository();
  const cipher = options?.cipher ?? new RecordingCipher();
  const service = new JellyfinConnectionService({
    repository,
    cipher,
    now: options?.now ?? (() => 1_000),
    randomBytes: options?.randomBytes ?? sequentialRandom(),
    ...(options?.collisionRetries === undefined
      ? {}
      : { collisionRetries: options.collisionRetries }),
  });
  return { cipher, repository, service };
}

describe("JellyfinConnectionService", () => {
  it("encrypts, persists metadata, and round-trips a normalized connection", async () => {
    const requests: number[] = [];
    const { cipher, repository, service } = makeHarness({
      randomBytes: sequentialRandom(requests),
    });

    const stored = await service.store(CONNECTION);
    const record = repository.records.get(stored.connectionId);

    expect(requests).toEqual([CONNECTION_ID_BYTE_LENGTH]);
    expect(stored.connectionId).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(record).toEqual({
      id: stored.connectionId,
      serverUrl: CONNECTION.serverUrl,
      serverId: CONNECTION.serverId,
      serverName: CONNECTION.serverName,
      serverVersion: CONNECTION.serverVersion,
      userId: CONNECTION.userId,
      username: CONNECTION.username,
      deviceId: CONNECTION.deviceId,
      tokenAlgorithm: "A256GCM",
      encryptedToken: cipher.encryptions[0]?.encrypted.ciphertext,
      tokenNonce: cipher.encryptions[0]?.encrypted.nonce,
      createdAt: 1_000,
    });
    expect(cipher.encryptions[0]).toMatchObject({ plaintext: ACCESS_TOKEN });
    expect(cipher.encryptions[0]?.associatedData).toBe(
      JSON.stringify([
        "sonofin/jellyfin-connection/token/v1",
        stored.connectionId,
        CONNECTION.serverUrl,
        CONNECTION.serverId,
        CONNECTION.userId,
        CONNECTION.deviceId,
      ]),
    );
    expect(JSON.stringify(record)).not.toContain(ACCESS_TOKEN);
    await expect(service.retrieve(stored.connectionId)).resolves.toEqual(
      CONNECTION,
    );
  });

  it("returns null for a missing record and deletes stored connections", async () => {
    const { repository, service } = makeHarness();
    const missingId = "z".repeat(32);

    await expect(service.retrieve(missingId)).resolves.toBeNull();
    await expect(service.delete(missingId)).resolves.toBe(false);

    const { connectionId } = await service.store(CONNECTION);
    expect(repository.records.has(connectionId)).toBe(true);
    await expect(service.delete(connectionId)).resolves.toBe(true);
    expect(repository.records.has(connectionId)).toBe(false);
    await expect(service.retrieve(connectionId)).resolves.toBeNull();
  });

  it("binds ciphertext to connection identity and metadata through AAD", async () => {
    const { repository, service } = makeHarness();
    const { connectionId } = await service.store(CONNECTION);
    const record = repository.records.get(connectionId);
    if (record === undefined) {
      throw new Error("Expected a stored connection");
    }

    repository.records.set(connectionId, {
      ...record,
      serverId: "different-server",
    });

    await expect(service.retrieve(connectionId)).rejects.toMatchObject({
      name: "TokenCipherError",
      code: "decryption_failed",
    });
  });

  it("propagates ciphertext tamper failures without exposing stored values", async () => {
    const { repository, service } = makeHarness();
    const { connectionId } = await service.store(CONNECTION);
    const record = repository.records.get(connectionId);
    if (record === undefined) {
      throw new Error("Expected a stored connection");
    }

    repository.records.set(connectionId, {
      ...record,
      encryptedToken: `${record.encryptedToken.slice(0, -1)}Z`,
    });
    const error = await service.retrieve(connectionId).catch((caught: unknown) =>
      caught,
    );

    expect(error).toBeInstanceOf(TokenCipherError);
    expect(String(error)).not.toContain(ACCESS_TOKEN);
    expect(String(error)).not.toContain(CONNECTION.serverUrl);
  });

  it("re-encrypts with a fresh identifier on repository collisions", async () => {
    const repository = new MemoryConnectionRepository();
    repository.collisionsRemaining = 2;
    const cipher = new RecordingCipher();
    const { service } = makeHarness({
      cipher,
      collisionRetries: 2,
      repository,
    });

    const stored = await service.store(CONNECTION);

    expect(repository.insertAttempts).toHaveLength(3);
    expect(cipher.encryptions).toHaveLength(3);
    expect(
      new Set(repository.insertAttempts.map((record) => record.id)).size,
    ).toBe(3);
    expect(
      new Set(cipher.encryptions.map((entry) => entry.associatedData)).size,
    ).toBe(3);
    expect(repository.records.has(stored.connectionId)).toBe(true);
  });

  it("throws a bounded typed error after exhausting collision retries", async () => {
    const repository = new MemoryConnectionRepository();
    repository.collisionsRemaining = 10;
    const { service } = makeHarness({
      collisionRetries: 1,
      repository,
    });

    const error = await service.store(CONNECTION).catch((caught: unknown) =>
      caught,
    );

    expect(error).toBeInstanceOf(JellyfinConnectionCollisionError);
    expect((error as JellyfinConnectionCollisionError).attempts).toBe(2);
    expect(String(error)).not.toContain(ACCESS_TOKEN);
  });

  it.each([
    ["an empty token", { accessToken: "" }],
    [
      "an oversized token",
      { accessToken: "x".repeat(MAX_CONNECTION_ACCESS_TOKEN_CHARACTERS + 1) },
    ],
    ["a blank server URL", { serverUrl: "   " }],
    [
      "oversized metadata",
      { serverName: "x".repeat(MAX_CONNECTION_METADATA_CHARACTERS + 1) },
    ],
    ["malformed Unicode", { username: "bad\ud800value" }],
  ] as const)("rejects %s before encryption", async (_label, overrides) => {
    const { cipher, repository, service } = makeHarness();
    const invalid = { ...CONNECTION, ...overrides };

    await expect(service.store(invalid)).rejects.toMatchObject({
      name: "JellyfinConnectionValidationError",
      code: "invalid_input",
    });
    expect(cipher.encryptions).toHaveLength(0);
    expect(repository.insertAttempts).toHaveLength(0);
  });

  it.each([[-1], [1.5], [Number.NaN]])(
    "rejects the invalid clock value %s before generating secrets",
    async (clock) => {
      const requests: number[] = [];
      const { service } = makeHarness({
        now: () => clock,
        randomBytes: sequentialRandom(requests),
      });

      await expect(service.store(CONNECTION)).rejects.toMatchObject({
        code: "invalid_clock",
      });
      expect(requests).toHaveLength(0);
    },
  );

  it("redacts a clock failure and invalid random-source failures", async () => {
    const clockSecret = "clock-secret-must-not-leak";
    const clock = makeHarness({
      now: () => {
        throw new Error(clockSecret);
      },
    });
    const clockError = await clock.service
      .store(CONNECTION)
      .catch((caught: unknown) => caught);

    expect(clockError).toBeInstanceOf(JellyfinConnectionValidationError);
    expect(String(clockError)).not.toContain(clockSecret);

    for (const randomBytes of [
      () => new Uint8Array(CONNECTION_ID_BYTE_LENGTH - 1),
      () => {
        throw new Error("random-secret-must-not-leak");
      },
    ]) {
      const { service } = makeHarness({ randomBytes });
      const error = await service
        .store(CONNECTION)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(JellyfinConnectionValidationError);
      expect(error).toMatchObject({ code: "invalid_random_source" });
      expect(String(error)).not.toContain("random-secret-must-not-leak");
    }
  });

  it("rejects invalid service options and connection identifiers", async () => {
    const { cipher, repository } = makeHarness();
    expect(
      () =>
        new JellyfinConnectionService({
          cipher,
          repository,
          now: () => 1,
          collisionRetries: -1,
        }),
    ).toThrow(JellyfinConnectionValidationError);

    const service = makeHarness().service;
    await expect(service.retrieve("not-an-id")).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(service.delete("not-an-id")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects malformed persisted records before decryption", async () => {
    const { cipher, repository, service } = makeHarness();
    const { connectionId } = await service.store(CONNECTION);
    const record = repository.records.get(connectionId);
    if (record === undefined) {
      throw new Error("Expected a stored connection");
    }
    repository.records.set(connectionId, { ...record, createdAt: -1 });

    await expect(service.retrieve(connectionId)).rejects.toMatchObject({
      code: "invalid_record",
    });
    expect(cipher.encryptions).toHaveLength(1);
  });
});
