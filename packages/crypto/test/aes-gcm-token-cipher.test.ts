import { describe, expect, it } from "vitest";

import {
  AesGcmTokenCipher,
  TokenCipherError,
  type EncryptedToken,
  type TokenCipherErrorCode,
} from "../src";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const ASSOCIATED_DATA = "jellyfin-connection:connection-1";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

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

function sequentialNonceSource(): () => Uint8Array {
  let value = 0;
  return () => {
    const nonce = new Uint8Array(12);
    nonce.fill(value);
    value += 1;
    return nonce;
  };
}

async function expectCipherError(
  action: () => unknown | Promise<unknown>,
  code: TokenCipherErrorCode,
  secrets: readonly string[] = [],
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(TokenCipherError);
    expect(error).toMatchObject({ code, name: "TokenCipherError" });
    const rendered = `${String(error)} ${(error as Error).stack ?? ""}`;
    for (const secret of secrets) {
      if (secret.length > 0) {
        expect(rendered).not.toContain(secret);
      }
    }
    return;
  }
  throw new Error(`Expected TokenCipherError with code ${code}`);
}

function mutateFirstCharacter(value: string): string {
  return `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
}

describe("AesGcmTokenCipher", () => {
  it("round-trips a Unicode token with authenticated associated data", async () => {
    const token = "\ufeffjeton-é-雪-🔐-\u0000-end";
    const cipher = new AesGcmTokenCipher(KEY, sequentialNonceSource());

    const encrypted = await cipher.encrypt(token, "connexion-é-🔗");

    expect(encrypted.algorithm).toBe("A256GCM");
    expect(encrypted.ciphertext).toMatch(BASE64URL_PATTERN);
    expect(encrypted.nonce).toMatch(BASE64URL_PATTERN);
    expect(encrypted.ciphertext).not.toContain("=");
    expect(encrypted.nonce).not.toContain("=");
    await expect(cipher.decrypt(encrypted, "connexion-é-🔗")).resolves.toBe(
      token,
    );
  });

  it("requests a fresh 12-byte nonce for every encryption", async () => {
    const requestedNonces: Uint8Array[] = [];
    let next = 0;
    const cipher = new AesGcmTokenCipher(KEY, () => {
      const nonce = new Uint8Array(12);
      nonce[11] = next;
      next += 1;
      requestedNonces.push(nonce);
      return nonce;
    });

    const first = await cipher.encrypt("same-token", ASSOCIATED_DATA);
    const second = await cipher.encrypt("same-token", ASSOCIATED_DATA);

    expect(requestedNonces).toHaveLength(2);
    expect(requestedNonces.every((nonce) => nonce.byteLength === 12)).toBe(true);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejects ciphertext, nonce, key, and associated-data tampering uniformly", async () => {
    const cipher = new AesGcmTokenCipher(KEY, sequentialNonceSource());
    const encrypted = await cipher.encrypt("token-must-not-leak", ASSOCIATED_DATA);

    await expectCipherError(
      () =>
        cipher.decrypt(
          {
            ...encrypted,
            ciphertext: mutateFirstCharacter(encrypted.ciphertext),
          },
          ASSOCIATED_DATA,
        ),
      "decryption_failed",
      ["token-must-not-leak", encrypted.ciphertext],
    );
    await expectCipherError(
      () =>
        cipher.decrypt(
          { ...encrypted, nonce: mutateFirstCharacter(encrypted.nonce) },
          ASSOCIATED_DATA,
        ),
      "decryption_failed",
      ["token-must-not-leak", encrypted.nonce],
    );
    await expectCipherError(
      () => new AesGcmTokenCipher(OTHER_KEY).decrypt(encrypted, ASSOCIATED_DATA),
      "decryption_failed",
      ["token-must-not-leak", encrypted.ciphertext],
    );
    await expectCipherError(
      () => cipher.decrypt(encrypted, "jellyfin-connection:other"),
      "decryption_failed",
      ["token-must-not-leak", encrypted.ciphertext],
    );
  });

  it.each([
    ["empty", ""],
    ["padded", `${KEY}=`],
    ["non-url-safe alphabet", `${KEY.slice(0, -1)}+`],
    ["whitespace", ` ${KEY}`],
    ["31 bytes", encodeBase64Url(new Uint8Array(31))],
    ["33 bytes", encodeBase64Url(new Uint8Array(33))],
    ["noncanonical tail bits", `${KEY.slice(0, -1)}B`],
  ])("rejects a %s encryption key", async (_description, key) => {
    await expectCipherError(
      () => new AesGcmTokenCipher(key),
      "invalid_key",
      [key],
    );
  });

  it.each([
    ["missing record", null],
    ["wrong algorithm", { algorithm: "AES-GCM", ciphertext: "AA", nonce: "AA" }],
    ["padded nonce", { algorithm: "A256GCM", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA", nonce: "AAAAAAAAAAAAAAAA=" }],
    ["short nonce", { algorithm: "A256GCM", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA", nonce: "AA" }],
    ["invalid nonce alphabet", { algorithm: "A256GCM", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA", nonce: "AAAAAAAAAAAAAAA+" }],
    ["empty ciphertext", { algorithm: "A256GCM", ciphertext: "", nonce: "AAAAAAAAAAAAAAAA" }],
    ["short ciphertext", { algorithm: "A256GCM", ciphertext: "AA", nonce: "AAAAAAAAAAAAAAAA" }],
    ["noncanonical ciphertext", { algorithm: "A256GCM", ciphertext: "AB", nonce: "AAAAAAAAAAAAAAAA" }],
  ])("rejects a malformed envelope with %s", async (_description, record) => {
    const cipher = new AesGcmTokenCipher(KEY);
    await expectCipherError(
      () => cipher.decrypt(record as EncryptedToken, ASSOCIATED_DATA),
      "invalid_record",
    );
  });

  it("rejects empty associated data for encryption and decryption", async () => {
    const cipher = new AesGcmTokenCipher(KEY, sequentialNonceSource());
    const plaintext = "plaintext-secret-must-not-leak";
    const encrypted = await cipher.encrypt(plaintext, ASSOCIATED_DATA);

    await expectCipherError(
      () => cipher.encrypt(plaintext, ""),
      "invalid_input",
      [plaintext],
    );
    await expectCipherError(
      () => cipher.decrypt(encrypted, ""),
      "invalid_input",
      [encrypted.ciphertext],
    );
  });

  it("rejects an invalid nonce source without exposing its error", async () => {
    const sourceSecret = "nonce-source-secret-must-not-leak";
    const plaintext = "nonce-test-plaintext-must-not-leak";
    const throwingCipher = new AesGcmTokenCipher(KEY, () => {
      throw new Error(sourceSecret);
    });
    const shortCipher = new AesGcmTokenCipher(KEY, () => new Uint8Array(11));

    await expectCipherError(
      () => throwingCipher.encrypt(plaintext, ASSOCIATED_DATA),
      "encryption_failed",
      [sourceSecret, plaintext],
    );
    await expectCipherError(
      () => shortCipher.encrypt(plaintext, ASSOCIATED_DATA),
      "invalid_input",
      [plaintext],
    );
  });

  it("fails closed when authenticated plaintext is not valid UTF-8", async () => {
    const nonce = new Uint8Array(12);
    const associatedData = new TextEncoder().encode(ASSOCIATED_DATA);
    const rawKey = new Uint8Array(32);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: associatedData,
        tagLength: 128,
      },
      cryptoKey,
      new Uint8Array([0xc3, 0x28]),
    );
    const record: EncryptedToken = {
      algorithm: "A256GCM",
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
      nonce: encodeBase64Url(nonce),
    };

    await expectCipherError(
      () => new AesGcmTokenCipher(KEY).decrypt(record, ASSOCIATED_DATA),
      "decryption_failed",
      [record.ciphertext],
    );
  });

  it("rejects ill-formed UTF-16 inputs instead of changing their bytes", async () => {
    const malformed = String.fromCharCode(0xd800);
    const plaintext = "unicode-test-plaintext-must-not-leak";
    const cipher = new AesGcmTokenCipher(KEY);

    await expectCipherError(
      () => cipher.encrypt(malformed, ASSOCIATED_DATA),
      "invalid_input",
    );
    await expectCipherError(
      () => cipher.encrypt(plaintext, malformed),
      "invalid_input",
      [plaintext],
    );
  });
});
