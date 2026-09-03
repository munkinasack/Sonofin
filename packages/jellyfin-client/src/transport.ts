import {
  JellyfinClientError,
  type JellyfinClientErrorCode,
} from "./errors";

const MAX_SERVER_URL_CHARACTERS = 2_048;

export interface JsonObject {
  [key: string]: unknown;
}

class ResponseLimitError extends Error {}

export class JellyfinJsonTransport {
  readonly #fetch: typeof globalThis.fetch;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(
    fetch: typeof globalThis.fetch,
    requestTimeoutMs: number,
    maxResponseBytes: number,
  ) {
    this.#fetch = fetch;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
  }

  async requestJson(
    url: string,
    init: RequestInit,
    rejectedCode: (status: number) => JellyfinClientErrorCode,
  ): Promise<JsonObject> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new JellyfinClientError("server_unreachable"));
        controller.abort();
      }, this.#requestTimeoutMs);
    });

    const request = async (): Promise<JsonObject> => {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          ...init,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        throw new JellyfinClientError("server_unreachable");
      }
      if (!response.ok) {
        throw new JellyfinClientError(rejectedCode(response.status));
      }
      return this.#readJson(response, controller.signal);
    };

    try {
      return await Promise.race([request(), timeoutPromise]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      controller.abort();
    }
  }

  async requestWithoutResponse(
    url: string,
    init: RequestInit,
    rejectedCode: (status: number) => JellyfinClientErrorCode,
  ): Promise<void> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new JellyfinClientError("server_unreachable"));
        controller.abort();
      }, this.#requestTimeoutMs);
    });

    const request = async (): Promise<void> => {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          ...init,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        throw new JellyfinClientError("server_unreachable");
      }
      if (!response.ok) {
        throw new JellyfinClientError(rejectedCode(response.status));
      }
    };

    try {
      await Promise.race([request(), timeoutPromise]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      controller.abort();
    }
  }

  async #readJson(response: Response, signal: AbortSignal): Promise<JsonObject> {
    try {
      const contentLength = response.headers.get("content-length");
      if (
        contentLength !== null &&
        /^\d+$/u.test(contentLength) &&
        BigInt(contentLength) > BigInt(this.#maxResponseBytes)
      ) {
        throw new ResponseLimitError();
      }

      if (response.body === null) {
        throw new SyntaxError();
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      });
      let text = "";
      let byteLength = 0;
      let rejectOnAbort: ((reason: JellyfinClientError) => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = reject;
      });
      const abort = (): void => {
        rejectOnAbort?.(new JellyfinClientError("server_unreachable"));
        void reader.cancel().catch(() => {
          // Cancellation is best effort after a request deadline.
        });
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }

      try {
        while (true) {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (chunk.done) {
            break;
          }

          byteLength += chunk.value.byteLength;
          if (byteLength > this.#maxResponseBytes) {
            try {
              await reader.cancel();
            } catch {
              // Cancellation is best effort after the bounded read rejects.
            }
            throw new ResponseLimitError();
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        signal.removeEventListener("abort", abort);
        try {
          reader.releaseLock();
        } catch {
          // An aborted read may still be settling after best-effort cancel.
        }
      }

      const payload: unknown = JSON.parse(text);
      if (!isJsonObject(payload)) {
        throw new SyntaxError();
      }
      return payload;
    } catch (error) {
      if (error instanceof JellyfinClientError) {
        throw error;
      }
      throw new JellyfinClientError("invalid_server_response");
    }
  }
}

export function readPositiveSafeInteger(
  value: number | undefined,
  defaultValue: number,
): number {
  const result = value ?? defaultValue;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new JellyfinClientError("invalid_input");
  }
  return result;
}

export function endpoint(serverUrl: string, pathname: string): string {
  return `${serverUrl}${pathname}`;
}

export function jsonHeaders(
  deviceId: string,
  accessToken?: string,
  hasBody = false,
): Headers {
  const headers = new Headers({
    accept: "application/json",
    authorization:
      'MediaBrowser Client="Sonofin", Device="Cloudflare Worker", ' +
      `DeviceId="${percentEncode(deviceId)}", Version="0.0.0", ` +
      `Token="${percentEncode(accessToken ?? "")}"`,
  });
  if (hasBody) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

function percentEncode(value: string): string {
  if (!isWellFormedUnicode(value)) {
    throw new JellyfinClientError("invalid_input");
  }
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function isCharacterLength(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) {
    return false;
  }
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

export function isWellFormedUnicode(value: string): boolean {
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

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredObject(object: JsonObject, key: string): JsonObject {
  const value = object[key];
  if (!isJsonObject(value)) {
    throw new JellyfinClientError("invalid_server_response");
  }
  return value;
}

export function requiredMetadata(object: JsonObject, key: string): string {
  const value = object[key];
  if (
    typeof value !== "string" ||
    !isWellFormedUnicode(value) ||
    value.trim().length === 0
  ) {
    throw new JellyfinClientError("invalid_server_response");
  }
  return value.trim();
}

export function requiredCredential(object: JsonObject, key: string): string {
  const value = object[key];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    !isWellFormedUnicode(value)
  ) {
    throw new JellyfinClientError("invalid_server_response");
  }
  return value;
}

export function normalizeServerUrl(
  input: unknown,
  allowInsecureHttp: boolean,
): string {
  if (typeof input !== "string") {
    throw new JellyfinClientError("invalid_url");
  }
  if (input.length > MAX_SERVER_URL_CHARACTERS) {
    throw new JellyfinClientError("invalid_url");
  }

  const candidate = input.trim();
  if (
    candidate.length === 0 ||
    Array.from(candidate).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new JellyfinClientError("invalid_url");
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new JellyfinClientError("invalid_url");
  }

  if (url.protocol === "http:") {
    if (!allowInsecureHttp) {
      throw new JellyfinClientError("insecure_url");
    }
  } else if (url.protocol !== "https:") {
    throw new JellyfinClientError("invalid_url");
  }

  if (url.username !== "" || url.password !== "") {
    throw new JellyfinClientError("unsafe_url");
  }
  if (url.href.includes("?") || url.href.includes("#")) {
    throw new JellyfinClientError("invalid_url");
  }
  if (isUnsafeHostname(url.hostname)) {
    throw new JellyfinClientError("unsafe_url");
  }

  const path = url.pathname.replace(/\/+$/u, "");
  return path === "" ? url.origin : `${url.origin}${path}`;
}

function isUnsafeHostname(input: string): boolean {
  const hostname = input
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.+$/u, "")
    .toLowerCase();

  if (
    (!hostname.includes(".") && !hostname.includes(":")) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".localdomain") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname === "home.arpa" ||
    hostname.endsWith(".home.arpa")
  ) {
    return true;
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== undefined) {
    return isUnsafeIpv4(ipv4);
  }

  const ipv6 = parseIpv6(hostname);
  if (ipv6 === undefined) {
    return false;
  }
  return isUnsafeIpv6(ipv6);
}

function parseIpv4(hostname: string): readonly number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) {
    return undefined;
  }
  const values = parts.map(Number);
  return values.every((value) => value >= 0 && value <= 255)
    ? values
    : undefined;
}

function isUnsafeIpv4(parts: readonly number[]): boolean {
  const first = parts[0];
  const second = parts[1];
  if (first === undefined || second === undefined) {
    return true;
  }
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function parseIpv6(hostname: string): readonly number[] | undefined {
  if (!hostname.includes(":")) {
    return undefined;
  }
  const compression = hostname.indexOf("::");
  if (compression !== -1 && compression !== hostname.lastIndexOf("::")) {
    return undefined;
  }

  const leftText = compression === -1 ? hostname : hostname.slice(0, compression);
  const rightText = compression === -1 ? "" : hostname.slice(compression + 2);
  const left = leftText === "" ? [] : leftText.split(":");
  const right = rightText === "" ? [] : rightText.split(":");
  if (
    [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/u.test(part)) ||
    left.length + right.length > 8 ||
    (compression === -1 && left.length !== 8)
  ) {
    return undefined;
  }

  const zeros = compression === -1 ? 0 : 8 - left.length - right.length;
  if (compression !== -1 && zeros < 1) {
    return undefined;
  }
  const groups = [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array<number>(zeros).fill(0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
  if (groups.length !== 8) {
    return undefined;
  }

  return groups.flatMap((group) => [group >>> 8, group & 0xff]);
}

function isUnsafeIpv6(bytes: readonly number[]): boolean {
  const allZero = bytes.every((byte) => byte === 0);
  const loopback =
    bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const uniqueLocal = (bytes[0] ?? 0) >= 0xfc && (bytes[0] ?? 0) <= 0xfd;
  const linkLocal = bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80;
  const siteLocal = bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0xc0;
  const multicast = bytes[0] === 0xff;
  const ipv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;

  return (
    allZero ||
    loopback ||
    uniqueLocal ||
    linkLocal ||
    siteLocal ||
    multicast ||
    (ipv4Mapped && isUnsafeIpv4(bytes.slice(12, 16)))
  );
}
