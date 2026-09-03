import {
  TokenCipherError,
  type EncryptedToken,
  type TokenCipher,
} from "./types";

const ALGORITHM = "A256GCM";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTHENTICATION_TAG_BITS = 128;
const AUTHENTICATION_TAG_BYTES = AUTHENTICATION_TAG_BITS / 8;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

const textEncoder = new TextEncoder();
type CryptoBytes = Uint8Array<ArrayBuffer>;

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
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function encodeExactUtf8(value: unknown): CryptoBytes | null {
  if (typeof value !== "string") {
    return null;
  }

  const bytes: CryptoBytes = new Uint8Array(textEncoder.encode(value));
  try {
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return decoded === value ? bytes : null;
  } catch {
    return null;
  }
}

function parseKey(encodedKey: unknown): CryptoBytes {
  const key = decodeBase64Url(encodedKey);
  if (key === null || key.byteLength !== KEY_BYTES) {
    throw new TokenCipherError("invalid_key");
  }
  return key;
}

function parseAssociatedData(associatedData: unknown): CryptoBytes {
  const bytes = encodeExactUtf8(associatedData);
  if (bytes === null || bytes.byteLength === 0) {
    throw new TokenCipherError("invalid_input");
  }
  return bytes;
}

function parsePlaintext(plaintext: unknown): CryptoBytes {
  const bytes = encodeExactUtf8(plaintext);
  if (bytes === null) {
    throw new TokenCipherError("invalid_input");
  }
  return bytes;
}

function parseRecord(record: unknown): {
  ciphertext: CryptoBytes;
  nonce: CryptoBytes;
} {
  if (typeof record !== "object" || record === null) {
    throw new TokenCipherError("invalid_record");
  }

  const candidate = record as Partial<EncryptedToken>;
  if (candidate.algorithm !== ALGORITHM) {
    throw new TokenCipherError("invalid_record");
  }

  const nonce = decodeBase64Url(candidate.nonce);
  const ciphertext = decodeBase64Url(candidate.ciphertext);
  if (
    nonce === null ||
    nonce.byteLength !== NONCE_BYTES ||
    ciphertext === null ||
    ciphertext.byteLength < AUTHENTICATION_TAG_BYTES
  ) {
    throw new TokenCipherError("invalid_record");
  }

  return { ciphertext, nonce };
}

function defaultNonceSource(): CryptoBytes {
  return crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
}

export class AesGcmTokenCipher implements TokenCipher {
  readonly #key: Promise<CryptoKey>;
  readonly #nonceSource: () => Uint8Array;

  constructor(
    encodedKey: string,
    nonceSource: () => Uint8Array = defaultNonceSource,
  ) {
    const key = parseKey(encodedKey);
    if (typeof nonceSource !== "function") {
      throw new TokenCipherError("invalid_input");
    }

    this.#nonceSource = nonceSource;
    this.#key = crypto.subtle.importKey(
      "raw",
      key,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async encrypt(
    plaintext: string,
    associatedData: string,
  ): Promise<EncryptedToken> {
    const plaintextBytes = parsePlaintext(plaintext);
    const associatedDataBytes = parseAssociatedData(associatedData);

    let nonce: CryptoBytes;
    try {
      const generatedNonce = this.#nonceSource();
      if (
        !(generatedNonce instanceof Uint8Array) ||
        generatedNonce.byteLength !== NONCE_BYTES
      ) {
        throw new TokenCipherError("invalid_input");
      }
      nonce = new Uint8Array(generatedNonce);
    } catch (error) {
      if (error instanceof TokenCipherError) {
        throw error;
      }
      throw new TokenCipherError("encryption_failed");
    }

    try {
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: associatedDataBytes,
          tagLength: AUTHENTICATION_TAG_BITS,
        },
        await this.#key,
        plaintextBytes,
      );

      return {
        algorithm: ALGORITHM,
        ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
        nonce: encodeBase64Url(nonce),
      };
    } catch {
      throw new TokenCipherError("encryption_failed");
    }
  }

  async decrypt(
    record: EncryptedToken,
    associatedData: string,
  ): Promise<string> {
    const { ciphertext, nonce } = parseRecord(record);
    const associatedDataBytes = parseAssociatedData(associatedData);

    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: associatedDataBytes,
          tagLength: AUTHENTICATION_TAG_BITS,
        },
        await this.#key,
        ciphertext,
      );

      return new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(plaintext);
    } catch {
      throw new TokenCipherError("decryption_failed");
    }
  }
}
