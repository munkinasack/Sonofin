import type { EncryptedToken } from "@sonofin/crypto";
import type { JellyfinConnection } from "@sonofin/jellyfin-client";

import {
  CONNECTION_ID_BYTE_LENGTH,
  CONNECTION_ID_LENGTH,
  DEFAULT_CONNECTION_COLLISION_RETRIES,
  JellyfinConnectionCollisionError,
  JellyfinConnectionValidationError,
  MAX_CONNECTION_ACCESS_TOKEN_CHARACTERS,
  MAX_CONNECTION_METADATA_CHARACTERS,
  MAX_CONNECTION_SERVER_URL_CHARACTERS,
  type ConnectionRandomSource,
  type JellyfinConnectionRecord,
  type JellyfinConnectionRepository,
  type JellyfinConnectionServiceOptions,
} from "./types";

const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const TOKEN_ALGORITHM = "A256GCM";
const TOKEN_AAD_DOMAIN = "sonofin/jellyfin-connection/token/v1";
const MAX_ENCRYPTED_TOKEN_CHARACTERS = 22_000;
const TOKEN_NONCE_LENGTH = 16;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

interface ValidatedConnectionMetadata {
  readonly serverUrl: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly userId: string;
  readonly username: string;
  readonly deviceId: string;
}

export class JellyfinConnectionService {
  readonly #repository: JellyfinConnectionRepository;
  readonly #cipher: JellyfinConnectionServiceOptions["cipher"];
  readonly #now: () => number;
  readonly #randomBytes: ConnectionRandomSource;
  readonly #collisionRetries: number;

  constructor(options: JellyfinConnectionServiceOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      typeof options.repository !== "object" ||
      options.repository === null ||
      typeof options.repository.insert !== "function" ||
      typeof options.repository.findById !== "function" ||
      typeof options.repository.deleteById !== "function" ||
      typeof options.cipher !== "object" ||
      options.cipher === null ||
      typeof options.cipher.encrypt !== "function" ||
      typeof options.cipher.decrypt !== "function" ||
      typeof options.now !== "function" ||
      (options.randomBytes !== undefined &&
        typeof options.randomBytes !== "function") ||
      (options.collisionRetries !== undefined &&
        (!Number.isSafeInteger(options.collisionRetries) ||
          options.collisionRetries < 0))
    ) {
      throw new JellyfinConnectionValidationError("invalid_options");
    }

    this.#repository = options.repository;
    this.#cipher = options.cipher;
    this.#now = options.now;
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#collisionRetries =
      options.collisionRetries ?? DEFAULT_CONNECTION_COLLISION_RETRIES;
  }

  async store(
    connection: JellyfinConnection,
  ): Promise<{ connectionId: string }> {
    const metadata = validateConnection(connection);
    const createdAt = this.#readNow();
    const attempts = this.#collisionRetries + 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const connectionId = generateConnectionId(this.#randomBytes);
      const encrypted = await this.#cipher.encrypt(
        connection.accessToken,
        associatedData(connectionId, metadata),
      );
      assertEncryptedToken(encrypted, "invalid_input");

      const inserted = await this.#repository.insert({
        id: connectionId,
        ...metadata,
        tokenAlgorithm: encrypted.algorithm,
        encryptedToken: encrypted.ciphertext,
        tokenNonce: encrypted.nonce,
        createdAt,
      });
      if (inserted) {
        return { connectionId };
      }
    }

    throw new JellyfinConnectionCollisionError(attempts);
  }

  async retrieve(connectionId: string): Promise<JellyfinConnection | null> {
    assertConnectionId(connectionId);
    const record = await this.#repository.findById(connectionId);
    if (record === null) {
      return null;
    }

    const metadata = validateRecord(record, connectionId);
    const accessToken = await this.#cipher.decrypt(
      encryptedToken(record),
      associatedData(record.id, metadata),
    );
    assertAccessToken(accessToken, "invalid_record");

    return { ...metadata, accessToken };
  }

  async delete(connectionId: string): Promise<boolean> {
    assertConnectionId(connectionId);
    return this.#repository.deleteById(connectionId);
  }

  #readNow(): number {
    let now: number;
    try {
      now = this.#now();
    } catch {
      throw new JellyfinConnectionValidationError("invalid_clock");
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new JellyfinConnectionValidationError("invalid_clock");
    }
    return now;
  }
}

function validateConnection(
  connection: JellyfinConnection,
): ValidatedConnectionMetadata {
  if (typeof connection !== "object" || connection === null) {
    throw new JellyfinConnectionValidationError("invalid_input");
  }

  const metadata = validateMetadata(connection, "invalid_input");
  assertAccessToken(connection.accessToken, "invalid_input");
  return metadata;
}

function validateRecord(
  record: JellyfinConnectionRecord,
  expectedId: string,
): ValidatedConnectionMetadata {
  if (
    typeof record !== "object" ||
    record === null ||
    record.id !== expectedId ||
    !isConnectionId(record.id) ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0
  ) {
    throw new JellyfinConnectionValidationError("invalid_record");
  }

  const metadata = validateMetadata(record, "invalid_record");
  assertEncryptedToken(encryptedToken(record), "invalid_record");
  return metadata;
}

function validateMetadata(
  value: ValidatedConnectionMetadata,
  errorCode: "invalid_input" | "invalid_record",
): ValidatedConnectionMetadata {
  if (
    !isBoundedText(
      value.serverUrl,
      MAX_CONNECTION_SERVER_URL_CHARACTERS,
    ) ||
    !isBoundedText(value.serverId, MAX_CONNECTION_METADATA_CHARACTERS) ||
    !isBoundedText(value.serverName, MAX_CONNECTION_METADATA_CHARACTERS) ||
    !isBoundedText(value.serverVersion, MAX_CONNECTION_METADATA_CHARACTERS) ||
    !isBoundedText(value.userId, MAX_CONNECTION_METADATA_CHARACTERS) ||
    !isBoundedText(value.username, MAX_CONNECTION_METADATA_CHARACTERS) ||
    !isBoundedText(value.deviceId, MAX_CONNECTION_METADATA_CHARACTERS)
  ) {
    throw new JellyfinConnectionValidationError(errorCode);
  }

  return {
    serverUrl: value.serverUrl,
    serverId: value.serverId,
    serverName: value.serverName,
    serverVersion: value.serverVersion,
    userId: value.userId,
    username: value.username,
    deviceId: value.deviceId,
  };
}

function assertAccessToken(
  accessToken: unknown,
  errorCode: "invalid_input" | "invalid_record",
): asserts accessToken is string {
  if (
    !isBoundedText(
      accessToken,
      MAX_CONNECTION_ACCESS_TOKEN_CHARACTERS,
    )
  ) {
    throw new JellyfinConnectionValidationError(errorCode);
  }
}

function assertEncryptedToken(
  encrypted: EncryptedToken,
  errorCode: "invalid_input" | "invalid_record",
): void {
  if (
    typeof encrypted !== "object" ||
    encrypted === null ||
    encrypted.algorithm !== TOKEN_ALGORITHM ||
    typeof encrypted.ciphertext !== "string" ||
    encrypted.ciphertext.length < 22 ||
    encrypted.ciphertext.length > MAX_ENCRYPTED_TOKEN_CHARACTERS ||
    encrypted.ciphertext.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(encrypted.ciphertext) ||
    typeof encrypted.nonce !== "string" ||
    encrypted.nonce.length !== TOKEN_NONCE_LENGTH ||
    !BASE64URL_PATTERN.test(encrypted.nonce)
  ) {
    throw new JellyfinConnectionValidationError(errorCode);
  }
}

function encryptedToken(record: JellyfinConnectionRecord): EncryptedToken {
  return {
    algorithm: record.tokenAlgorithm,
    ciphertext: record.encryptedToken,
    nonce: record.tokenNonce,
  };
}

function associatedData(
  connectionId: string,
  metadata: ValidatedConnectionMetadata,
): string {
  return JSON.stringify([
    TOKEN_AAD_DOMAIN,
    connectionId,
    metadata.serverUrl,
    metadata.serverId,
    metadata.userId,
    metadata.deviceId,
  ]);
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    isWellFormedUnicode(value) &&
    Array.from(value).length <= maximum
  );
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertConnectionId(value: string): void {
  if (!isConnectionId(value)) {
    throw new JellyfinConnectionValidationError("invalid_input");
  }
}

function isConnectionId(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_ID_PATTERN.test(value);
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function generateConnectionId(randomBytes: ConnectionRandomSource): string {
  let bytes: Uint8Array;
  try {
    bytes = randomBytes(CONNECTION_ID_BYTE_LENGTH);
  } catch {
    throw new JellyfinConnectionValidationError("invalid_random_source");
  }
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== CONNECTION_ID_BYTE_LENGTH
  ) {
    throw new JellyfinConnectionValidationError("invalid_random_source");
  }

  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    if (first === undefined || second === undefined || third === undefined) {
      throw new JellyfinConnectionValidationError("invalid_random_source");
    }

    encoded += BASE64URL_ALPHABET[first >>> 2];
    encoded += BASE64URL_ALPHABET[((first & 0x03) << 4) | (second >>> 4)];
    encoded += BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third >>> 6)];
    encoded += BASE64URL_ALPHABET[third & 0x3f];
  }

  if (encoded.length !== CONNECTION_ID_LENGTH) {
    throw new JellyfinConnectionValidationError("invalid_random_source");
  }
  return encoded;
}
