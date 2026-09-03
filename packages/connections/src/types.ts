import type { EncryptedToken, TokenCipher } from "@sonofin/crypto";

export const CONNECTION_ID_BYTE_LENGTH = 24;
export const CONNECTION_ID_LENGTH = 32;
export const DEFAULT_CONNECTION_COLLISION_RETRIES = 4;
export const MAX_CONNECTION_SERVER_URL_CHARACTERS = 2_048;
export const MAX_CONNECTION_METADATA_CHARACTERS = 255;
export const MAX_CONNECTION_ACCESS_TOKEN_CHARACTERS = 4_096;

export interface NewJellyfinConnectionRecord {
  readonly id: string;
  readonly serverUrl: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly userId: string;
  readonly username: string;
  readonly deviceId: string;
  readonly tokenAlgorithm: EncryptedToken["algorithm"];
  readonly encryptedToken: string;
  readonly tokenNonce: string;
  readonly createdAt: number;
}

export type JellyfinConnectionRecord = NewJellyfinConnectionRecord;

export interface JellyfinConnectionRepository {
  insert(record: NewJellyfinConnectionRecord): Promise<boolean>;
  findById(id: string): Promise<JellyfinConnectionRecord | null>;
  deleteById(id: string): Promise<boolean>;
}

export type ConnectionRandomSource = (length: number) => Uint8Array;

export interface JellyfinConnectionServiceOptions {
  readonly repository: JellyfinConnectionRepository;
  readonly cipher: TokenCipher;
  readonly now: () => number;
  readonly randomBytes?: ConnectionRandomSource;
  readonly collisionRetries?: number;
}

export type JellyfinConnectionValidationErrorCode =
  | "invalid_input"
  | "invalid_record"
  | "invalid_clock"
  | "invalid_random_source"
  | "invalid_options";

const VALIDATION_ERROR_MESSAGES = {
  invalid_input: "The Jellyfin connection input is invalid",
  invalid_record: "The stored Jellyfin connection is invalid",
  invalid_clock: "The Jellyfin connection clock is invalid",
  invalid_random_source: "The Jellyfin connection random source is invalid",
  invalid_options: "The Jellyfin connection service options are invalid",
} satisfies Record<JellyfinConnectionValidationErrorCode, string>;

export class JellyfinConnectionValidationError extends Error {
  readonly code: JellyfinConnectionValidationErrorCode;

  constructor(code: JellyfinConnectionValidationErrorCode) {
    super(VALIDATION_ERROR_MESSAGES[code]);
    this.name = "JellyfinConnectionValidationError";
    this.code = code;
  }
}

export class JellyfinConnectionCollisionError extends Error {
  readonly attempts: number;

  constructor(attempts: number) {
    super("Could not allocate a unique Jellyfin connection identifier");
    this.name = "JellyfinConnectionCollisionError";
    this.attempts = attempts;
  }
}
