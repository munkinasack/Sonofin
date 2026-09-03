import {
  MAX_SONOS_HOUSEHOLD_ID_CHARACTERS,
  SONOS_AUTH_TOKEN_HASH_LENGTH,
  SONOS_AUTH_TOKEN_PREFIX,
  SONOS_CONNECTION_ID_LENGTH,
  SONOS_CREDENTIAL_BASE64URL_LENGTH,
  SONOS_CREDENTIAL_BYTE_LENGTH,
  SONOS_JELLYFIN_CONNECTION_ID_LENGTH,
  SONOS_PRIVATE_KEY_PREFIX,
  SONOS_SIGNING_KEY_BYTE_LENGTH,
  SonosAuthenticationIntegrityError,
  SonosAuthenticationValidationError,
  type AuthenticateSonosInput,
  type AuthenticateSonosResult,
  type IssueSonosAuthenticationInput,
  type IssueSonosAuthenticationResult,
  type NewSonosConnectionRecord,
  type RevokeSonosAuthenticationInput,
  type SonosAuthenticationServiceOptions,
  type SonosConnectionRecord,
  type SonosConnectionRepository,
} from "./types";

const AUTH_TOKEN_DERIVATION_DOMAIN =
  "sonofin/sonos-auth/auth-token/hmac-sha256/v1";
const PRIVATE_KEY_DERIVATION_DOMAIN =
  "sonofin/sonos-auth/private-key/hmac-sha256/v1";
const LOWERCASE_HEX_PATTERN = /^[0-9a-f]+$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const textEncoder = new TextEncoder();
type CryptoBytes = Uint8Array<ArrayBuffer>;

export class SonosAuthenticationService {
  readonly #repository: SonosConnectionRepository;
  readonly #now: () => number;
  readonly #signingKeys: readonly Promise<CryptoKey>[];

  constructor(options: SonosAuthenticationServiceOptions) {
    if (!isValidOptions(options)) {
      throw new SonosAuthenticationValidationError("invalid_options");
    }

    const signingKeys = [
      options.signingKey,
      ...(options.fallbackSigningKeys ?? []),
    ].map(decodeSigningKey);

    this.#repository = options.repository;
    this.#now = options.now;
    this.#signingKeys = signingKeys.map(importSigningKey);
  }

  async issue(
    input: IssueSonosAuthenticationInput,
  ): Promise<IssueSonosAuthenticationResult> {
    if (!isIssueInput(input)) {
      throw new SonosAuthenticationValidationError("invalid_input");
    }

    const createdAt = this.#readNow();
    const currentCredentials = await this.#deriveCredentials(
      this.#signingKeys[0] as Promise<CryptoKey>,
      input,
    );
    const record: NewSonosConnectionRecord = {
      id: input.linkId,
      jellyfinConnectionId: input.jellyfinConnectionId,
      householdId: input.householdId,
      authTokenHash: currentCredentials.authTokenHash,
      createdAt,
      revokedAt: null,
    };

    const inserted = await this.#repository.insert(record);
    if (inserted) {
      return {
        outcome: "success",
        authToken: currentCredentials.authToken,
        privateKey: currentCredentials.privateKey,
        alreadyIssued: false,
      };
    }

    const existing = await this.#repository.findById(record.id);
    assertMatchingAssociation(existing, record);
    if (existing.revokedAt !== null) {
      return { outcome: "failure", reason: "superseded" };
    }
    const credentials = await this.#credentialsMatchingStoredHash(
      existing.authTokenHash,
      input,
      currentCredentials,
    );

    return {
      outcome: "success",
      authToken: credentials.authToken,
      privateKey: credentials.privateKey,
      alreadyIssued: true,
    };
  }

  async authenticate(
    input: AuthenticateSonosInput,
  ): Promise<AuthenticateSonosResult> {
    if (!isCredentialInput(input)) {
      return { outcome: "failure" };
    }

    const authTokenHash = await sha256Hex(input.authToken);
    const connection = await this.#repository.findByAuthTokenHash(authTokenHash);
    if (connection === null) {
      return { outcome: "failure" };
    }
    assertValidRecord(connection);
    if (connection.authTokenHash !== authTokenHash) {
      throw new SonosAuthenticationIntegrityError();
    }
    if (
      connection.revokedAt !== null ||
      connection.householdId !== input.householdId
    ) {
      return { outcome: "failure" };
    }

    return {
      outcome: "success",
      connection: {
        id: connection.id,
        jellyfinConnectionId: connection.jellyfinConnectionId,
        householdId: connection.householdId,
      },
    };
  }

  async revoke(input: RevokeSonosAuthenticationInput): Promise<boolean> {
    if (!isCredentialInput(input)) {
      return false;
    }

    const authTokenHash = await sha256Hex(input.authToken);
    const current = await this.#repository.findByAuthTokenHash(authTokenHash);
    if (current === null) {
      return false;
    }
    assertValidRecord(current);
    if (current.authTokenHash !== authTokenHash) {
      throw new SonosAuthenticationIntegrityError();
    }
    if (
      current.revokedAt !== null ||
      current.householdId !== input.householdId
    ) {
      return false;
    }

    const revokedAt = this.#readNow();
    if (revokedAt < current.createdAt) {
      throw new SonosAuthenticationValidationError("invalid_clock");
    }
    const revoked = await this.#repository.revokeByAuthTokenHash({
      authTokenHash,
      householdId: input.householdId,
      revokedAt,
    });
    if (revoked === null) {
      return false;
    }

    assertValidRecord(revoked);
    if (
      revoked.authTokenHash !== authTokenHash ||
      revoked.householdId !== input.householdId ||
      revoked.revokedAt !== revokedAt
    ) {
      throw new SonosAuthenticationIntegrityError();
    }
    return true;
  }

  #readNow(): number {
    let now: number;
    try {
      now = this.#now();
    } catch {
      throw new SonosAuthenticationValidationError("invalid_clock");
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new SonosAuthenticationValidationError("invalid_clock");
    }
    return now;
  }

  async #deriveCredentials(
    signingKey: Promise<CryptoKey>,
    input: IssueSonosAuthenticationInput,
  ): Promise<DerivedCredentials> {
    const [authTokenDigest, privateKeyDigest] = await Promise.all([
      this.#deriveCredential(
        signingKey,
        AUTH_TOKEN_DERIVATION_DOMAIN,
        input,
      ),
      this.#deriveCredential(
        signingKey,
        PRIVATE_KEY_DERIVATION_DOMAIN,
        input,
      ),
    ]);
    const authToken = `${SONOS_AUTH_TOKEN_PREFIX}${encodeBase64Url(authTokenDigest)}`;
    return {
      authToken,
      authTokenHash: await sha256Hex(authToken),
      privateKey: `${SONOS_PRIVATE_KEY_PREFIX}${encodeBase64Url(privateKeyDigest)}`,
    };
  }

  async #credentialsMatchingStoredHash(
    storedHash: string,
    input: IssueSonosAuthenticationInput,
    current: DerivedCredentials,
  ): Promise<DerivedCredentials> {
    if (current.authTokenHash === storedHash) {
      return current;
    }

    for (const signingKey of this.#signingKeys.slice(1)) {
      const candidate = await this.#deriveCredentials(signingKey, input);
      if (candidate.authTokenHash === storedHash) {
        return candidate;
      }
    }

    throw new SonosAuthenticationIntegrityError();
  }

  async #deriveCredential(
    signingKey: Promise<CryptoKey>,
    domain: string,
    input: IssueSonosAuthenticationInput,
  ): Promise<CryptoBytes> {
    const message = textEncoder.encode(
      JSON.stringify([
        domain,
        input.linkId,
        input.householdId,
        input.jellyfinConnectionId,
      ]),
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      await signingKey,
      message,
    );
    const bytes: CryptoBytes = new Uint8Array(signature);
    if (bytes.byteLength !== SONOS_CREDENTIAL_BYTE_LENGTH) {
      throw new SonosAuthenticationIntegrityError();
    }
    return bytes;
  }
}

interface DerivedCredentials {
  readonly authToken: string;
  readonly authTokenHash: string;
  readonly privateKey: string;
}

function isValidOptions(
  options: SonosAuthenticationServiceOptions,
): options is SonosAuthenticationServiceOptions {
  if (typeof options !== "object" || options === null) {
    return false;
  }
  const repository = options.repository;
  return (
    typeof repository === "object" &&
    repository !== null &&
    typeof repository.insert === "function" &&
    typeof repository.findById === "function" &&
    typeof repository.findByAuthTokenHash === "function" &&
    typeof repository.revokeByAuthTokenHash === "function" &&
    typeof options.now === "function" &&
    typeof options.signingKey === "string" &&
    (options.fallbackSigningKeys === undefined ||
      (Array.isArray(options.fallbackSigningKeys) &&
        options.fallbackSigningKeys.every(
          (signingKey) => typeof signingKey === "string",
        )))
  );
}

function isIssueInput(
  input: IssueSonosAuthenticationInput,
): input is IssueSonosAuthenticationInput {
  return (
    typeof input === "object" &&
    input !== null &&
    isLowercaseHex(input.linkId, SONOS_CONNECTION_ID_LENGTH) &&
    isHouseholdId(input.householdId) &&
    isBase64Url(input.jellyfinConnectionId, SONOS_JELLYFIN_CONNECTION_ID_LENGTH)
  );
}

function isCredentialInput(
  input: AuthenticateSonosInput | RevokeSonosAuthenticationInput,
): input is AuthenticateSonosInput | RevokeSonosAuthenticationInput {
  return (
    typeof input === "object" &&
    input !== null &&
    isAuthToken(input.authToken) &&
    isHouseholdId(input.householdId)
  );
}

function isAuthToken(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith(SONOS_AUTH_TOKEN_PREFIX)
  ) {
    return false;
  }
  const encoded = value.slice(SONOS_AUTH_TOKEN_PREFIX.length);
  const decoded = decodeBase64Url(encoded);
  return (
    encoded.length === SONOS_CREDENTIAL_BASE64URL_LENGTH &&
    decoded !== null &&
    decoded.byteLength === SONOS_CREDENTIAL_BYTE_LENGTH
  );
}

function isHouseholdId(value: unknown): value is string {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) {
    return false;
  }
  const length = Array.from(value).length;
  return (
    length >= 1 && length <= MAX_SONOS_HOUSEHOLD_ID_CHARACTERS
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

function assertMatchingAssociation(
  existing: SonosConnectionRecord | null,
  expected: NewSonosConnectionRecord,
): asserts existing is SonosConnectionRecord {
  if (existing === null) {
    throw new SonosAuthenticationIntegrityError();
  }
  assertValidRecord(existing);
  if (
    existing.id !== expected.id ||
    existing.jellyfinConnectionId !== expected.jellyfinConnectionId ||
    existing.householdId !== expected.householdId
  ) {
    throw new SonosAuthenticationIntegrityError();
  }
}

function decodeSigningKey(value: string): CryptoBytes {
  const signingKey = decodeBase64Url(value);
  if (
    signingKey === null ||
    signingKey.byteLength !== SONOS_SIGNING_KEY_BYTE_LENGTH
  ) {
    throw new SonosAuthenticationValidationError("invalid_signing_key");
  }
  return signingKey;
}

function assertValidRecord(
  record: SonosConnectionRecord,
): asserts record is SonosConnectionRecord {
  if (
    typeof record !== "object" ||
    record === null ||
    !isLowercaseHex(record.id, SONOS_CONNECTION_ID_LENGTH) ||
    !isBase64Url(
      record.jellyfinConnectionId,
      SONOS_JELLYFIN_CONNECTION_ID_LENGTH,
    ) ||
    !isHouseholdId(record.householdId) ||
    !isLowercaseHex(record.authTokenHash, SONOS_AUTH_TOKEN_HASH_LENGTH) ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0 ||
    (record.revokedAt !== null &&
      (!Number.isSafeInteger(record.revokedAt) ||
        record.revokedAt < record.createdAt))
  ) {
    throw new SonosAuthenticationIntegrityError();
  }
}

function isLowercaseHex(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    LOWERCASE_HEX_PATTERN.test(value)
  );
}

function isBase64Url(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    BASE64URL_PATTERN.test(value)
  );
}

async function importSigningKey(key: CryptoBytes): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "raw",
      key,
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
  } catch {
    throw new SonosAuthenticationValidationError("invalid_signing_key");
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: unknown): CryptoBytes | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return null;
  }

  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const paddingLength = (4 - (standard.length % 4)) % 4;
  const padded = standard.padEnd(standard.length + paddingLength, "=");
  try {
    const binary = atob(padded);
    const bytes: CryptoBytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}
