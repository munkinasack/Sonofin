export const SONOS_CONNECTION_ID_LENGTH = 64;
export const SONOS_JELLYFIN_CONNECTION_ID_LENGTH = 32;
export const SONOS_AUTH_TOKEN_HASH_LENGTH = 64;
export const SONOS_SIGNING_KEY_BYTE_LENGTH = 32;
export const SONOS_SIGNING_KEY_LENGTH = 43;
export const SONOS_CREDENTIAL_BYTE_LENGTH = 32;
export const SONOS_CREDENTIAL_BASE64URL_LENGTH = 43;
export const SONOS_AUTH_TOKEN_PREFIX = "SF_";
export const SONOS_PRIVATE_KEY_PREFIX = "SF_NO_REFRESH_";
export const SONOS_AUTH_TOKEN_LENGTH =
  SONOS_AUTH_TOKEN_PREFIX.length + SONOS_CREDENTIAL_BASE64URL_LENGTH;
export const SONOS_PRIVATE_KEY_LENGTH =
  SONOS_PRIVATE_KEY_PREFIX.length + SONOS_CREDENTIAL_BASE64URL_LENGTH;
export const MAX_SONOS_HOUSEHOLD_ID_CHARACTERS = 255;

export interface NewSonosConnectionRecord {
  readonly id: string;
  readonly jellyfinConnectionId: string;
  readonly householdId: string;
  readonly authTokenHash: string;
  readonly createdAt: number;
  readonly revokedAt: null;
}

export interface SonosConnectionRecord {
  readonly id: string;
  readonly jellyfinConnectionId: string;
  readonly householdId: string;
  readonly authTokenHash: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

export interface RevokeSonosConnectionInput {
  readonly authTokenHash: string;
  readonly householdId: string;
  readonly revokedAt: number;
}

export interface SonosConnectionRepository {
  insert(record: NewSonosConnectionRecord): Promise<boolean>;
  findById(id: string): Promise<SonosConnectionRecord | null>;
  findByAuthTokenHash(
    authTokenHash: string,
  ): Promise<SonosConnectionRecord | null>;
  revokeByAuthTokenHash(
    input: RevokeSonosConnectionInput,
  ): Promise<SonosConnectionRecord | null>;
}

export interface SonosAuthenticationServiceOptions {
  readonly repository: SonosConnectionRepository;
  readonly now: () => number;
  readonly signingKey: string;
  readonly fallbackSigningKeys?: readonly string[];
}

export interface IssueSonosAuthenticationInput {
  readonly linkId: string;
  readonly householdId: string;
  readonly jellyfinConnectionId: string;
}

export type IssueSonosAuthenticationResult =
  | {
      readonly outcome: "success";
      readonly authToken: string;
      readonly privateKey: string;
      readonly alreadyIssued: boolean;
    }
  | {
      readonly outcome: "failure";
      readonly reason: "superseded";
    };

export interface AuthenticateSonosInput {
  readonly authToken: string;
  readonly householdId: string;
}

export interface SonosAuthenticationMapping {
  readonly id: string;
  readonly jellyfinConnectionId: string;
  readonly householdId: string;
}

export type AuthenticateSonosResult =
  | {
      readonly outcome: "success";
      readonly connection: SonosAuthenticationMapping;
    }
  | { readonly outcome: "failure" };

export interface RevokeSonosAuthenticationInput {
  readonly authToken: string;
  readonly householdId: string;
}

export type SonosAuthenticationValidationErrorCode =
  | "invalid_clock"
  | "invalid_input"
  | "invalid_options"
  | "invalid_signing_key";

const VALIDATION_ERROR_MESSAGES = {
  invalid_clock: "The Sonos authentication clock is invalid",
  invalid_input: "The Sonos authentication input is invalid",
  invalid_options: "The Sonos authentication service options are invalid",
  invalid_signing_key: "The Sonos authentication signing key is invalid",
} satisfies Record<SonosAuthenticationValidationErrorCode, string>;

export class SonosAuthenticationValidationError extends Error {
  readonly code: SonosAuthenticationValidationErrorCode;

  constructor(code: SonosAuthenticationValidationErrorCode) {
    super(VALIDATION_ERROR_MESSAGES[code]);
    this.name = "SonosAuthenticationValidationError";
    this.code = code;
  }
}

export class SonosAuthenticationIntegrityError extends Error {
  readonly code = "integrity_failure" as const;

  constructor() {
    super("The stored Sonos authentication record failed integrity validation");
    this.name = "SonosAuthenticationIntegrityError";
  }
}
