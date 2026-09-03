import {
  InvalidLinkInputError,
  LINK_TOKEN_BYTE_LENGTH,
  LINK_TOKEN_LENGTH,
  type LinkRandomSource,
} from "./types";

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/u;

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function isLinkToken(value: string): boolean {
  return LINK_TOKEN_PATTERN.test(value);
}

export function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function generateLinkToken(randomBytes: LinkRandomSource): string {
  const bytes = randomBytes(LINK_TOKEN_BYTE_LENGTH);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== LINK_TOKEN_BYTE_LENGTH
  ) {
    throw new InvalidLinkInputError(
      `The random source must return exactly ${LINK_TOKEN_BYTE_LENGTH} bytes`,
    );
  }

  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    if (first === undefined || second === undefined || third === undefined) {
      throw new InvalidLinkInputError("The random source returned partial input");
    }

    encoded += BASE64URL_ALPHABET[first >>> 2];
    encoded += BASE64URL_ALPHABET[((first & 0x03) << 4) | (second >>> 4)];
    encoded += BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third >>> 6)];
    encoded += BASE64URL_ALPHABET[third & 0x3f];
  }

  if (encoded.length !== LINK_TOKEN_LENGTH) {
    throw new InvalidLinkInputError("The generated link token has invalid length");
  }

  return encoded;
}
