export const SONOS_MAX_ITEM_ID_CHARACTERS = 128;

export const SONOS_CONTENT_CATEGORIES = [
  "artists",
  "albums",
  "tracks",
  "playlists",
  "search",
  "artist",
  "album",
  "track",
  "playlist",
] as const;

export type SonosContentCategory =
  (typeof SONOS_CONTENT_CATEGORIES)[number];

export type SonosContentIdKind =
  | "root"
  | "category"
  | "artist"
  | "album"
  | "playlist"
  | "track";

export type SonosContentId =
  | { readonly kind: "root" }
  | { readonly kind: "category"; readonly value: SonosContentCategory }
  | { readonly kind: "artist"; readonly value: string }
  | { readonly kind: "album"; readonly value: string }
  | { readonly kind: "playlist"; readonly value: string }
  | { readonly kind: "track"; readonly value: string };

export type SonosContentIdForKind<Kind extends SonosContentIdKind> = Extract<
  SonosContentId,
  { readonly kind: Kind }
>;

export type SonosContentIdErrorCode =
  | "invalid_content_id"
  | "content_id_too_long"
  | "wrong_content_id_kind";

export class SonosContentIdError extends Error {
  readonly code: SonosContentIdErrorCode;

  constructor(code: SonosContentIdErrorCode) {
    super("Invalid Sonos content ID");
    this.name = "SonosContentIdError";
    this.code = code;
  }
}

const ENTITY_KINDS = new Set<SonosContentIdKind>([
  "artist",
  "album",
  "playlist",
  "track",
]);
const ALL_KINDS = new Set<SonosContentIdKind>([
  "root",
  "category",
  ...ENTITY_KINDS,
]);
const CATEGORY_IDS = new Set<string>(SONOS_CONTENT_CATEGORIES);
const ENTITY_PREFIX = "sf1";
const ENCODED_ENTITY_PATTERN =
  /^sf1\.(artist|album|playlist|track)\.([A-Za-z0-9_-]+)$/;

function invalidContentId(): never {
  throw new SonosContentIdError("invalid_content_id");
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        invalidContentId();
      }
      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      invalidContentId();
    }
  }
}

function assertSourceValue(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.trim() !== value
  ) {
    invalidContentId();
  }
  if (value.length > SONOS_MAX_ITEM_ID_CHARACTERS) {
    throw new SonosContentIdError("content_id_too_long");
  }

  assertValidUnicode(value);
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  if (value.length % 4 === 1) {
    invalidContentId();
  }

  const paddingLength = (4 - (value.length % 4)) % 4;
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(value.length + paddingLength, "=");

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    return invalidContentId();
  }
}

function assertExpectedKind(
  actual: SonosContentIdKind,
  expected: SonosContentIdKind | undefined,
): void {
  if (expected !== undefined && !ALL_KINDS.has(expected)) {
    invalidContentId();
  }

  if (expected !== undefined && actual !== expected) {
    throw new SonosContentIdError("wrong_content_id_kind");
  }
}

export function encodeSonosContentId(contentId: SonosContentId): string {
  if (typeof contentId !== "object" || contentId === null) {
    return invalidContentId();
  }

  if (contentId.kind === "root") {
    return "root";
  }

  if (contentId.kind === "category") {
    if (!CATEGORY_IDS.has(contentId.value)) {
      return invalidContentId();
    }
    return contentId.value;
  }

  if (!ENTITY_KINDS.has(contentId.kind)) {
    return invalidContentId();
  }

  assertSourceValue(contentId.value);
  const encoded = `${ENTITY_PREFIX}.${contentId.kind}.${encodeBase64Url(contentId.value)}`;
  if (encoded.length > SONOS_MAX_ITEM_ID_CHARACTERS) {
    throw new SonosContentIdError("content_id_too_long");
  }

  return encoded;
}

export function decodeSonosContentId(value: unknown): SonosContentId;
export function decodeSonosContentId<Kind extends SonosContentIdKind>(
  value: unknown,
  expectedKind: Kind,
): SonosContentIdForKind<Kind>;
export function decodeSonosContentId(
  value: unknown,
  expectedKind?: SonosContentIdKind,
): SonosContentId {
  if (typeof value !== "string" || value === "") {
    return invalidContentId();
  }
  if ([...value].length > SONOS_MAX_ITEM_ID_CHARACTERS) {
    throw new SonosContentIdError("content_id_too_long");
  }

  if (value === "root") {
    assertExpectedKind("root", expectedKind);
    return Object.freeze({ kind: "root" });
  }

  if (CATEGORY_IDS.has(value)) {
    assertExpectedKind("category", expectedKind);
    return Object.freeze({
      kind: "category",
      value: value as SonosContentCategory,
    });
  }

  const match = ENCODED_ENTITY_PATTERN.exec(value);
  if (match === null) {
    return invalidContentId();
  }

  const kind = match[1] as "artist" | "album" | "playlist" | "track";
  const encodedSource = match[2] as string;
  const source = decodeBase64Url(encodedSource);
  assertSourceValue(source);

  if (encodeBase64Url(source) !== encodedSource) {
    return invalidContentId();
  }

  assertExpectedKind(kind, expectedKind);
  return Object.freeze({ kind, value: source });
}
