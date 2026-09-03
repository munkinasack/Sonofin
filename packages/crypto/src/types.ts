export interface EncryptedToken {
  readonly algorithm: "A256GCM";
  readonly ciphertext: string;
  readonly nonce: string;
}

export interface TokenCipher {
  encrypt(plaintext: string, associatedData: string): Promise<EncryptedToken>;
  decrypt(record: EncryptedToken, associatedData: string): Promise<string>;
}

export type TokenCipherErrorCode =
  | "invalid_key"
  | "invalid_input"
  | "invalid_record"
  | "encryption_failed"
  | "decryption_failed";

const ERROR_MESSAGES = {
  invalid_key: "The token encryption key is invalid",
  invalid_input: "The token cipher input is invalid",
  invalid_record: "The encrypted token record is invalid",
  encryption_failed: "Token encryption failed",
  decryption_failed: "Token decryption failed",
} satisfies Record<TokenCipherErrorCode, string>;

export class TokenCipherError extends Error {
  readonly code: TokenCipherErrorCode;

  constructor(code: TokenCipherErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "TokenCipherError";
    this.code = code;
  }
}
