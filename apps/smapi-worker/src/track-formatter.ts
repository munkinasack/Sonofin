import {
  JellyfinClientError,
  type JellyfinNamedItem,
  type JellyfinTrack,
} from "@sonofin/jellyfin-client";
import {
  encodeSonosContentId,
  SONOS_MAX_COLLECTION_TEXT_CHARACTERS,
  SONOS_MAX_SIGNED_INT,
  type SonosBrowseTrack,
} from "@sonofin/sonos-smapi";

const SONOS_LINE_BREAK_PATTERN = /[\n\r\u0085\u2028\u2029]/u;
const SONOS_MIME_TYPES_BY_JELLYFIN_CONTAINER = Object.freeze({
  aac: "audio/aac",
  asf: "audio/x-ms-wma",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  ogg: "application/ogg",
  wma: "audio/x-ms-wma",
} as const satisfies Readonly<Record<string, string>>);

function invalidJellyfinTrack(): never {
  throw new JellyfinClientError("invalid_server_response");
}

function isXmlText(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d &&
      (codePoint === undefined ||
        codePoint < 0x20 ||
        (codePoint > 0xd7ff && codePoint < 0xe000) ||
        (codePoint > 0xfffd && codePoint < 0x10000) ||
        codePoint > 0x10ffff)
    ) {
      return false;
    }
  }

  return true;
}

function isSingleLineXmlText(value: unknown): value is string {
  return isXmlText(value) && !SONOS_LINE_BREAK_PATTERN.test(value);
}

function isSonosMetadataText(value: unknown): value is string {
  return (
    isSingleLineXmlText(value) &&
    [...value].length <= SONOS_MAX_COLLECTION_TEXT_CHARACTERS
  );
}

function encodeRequiredTrackId(value: unknown): string {
  try {
    return encodeSonosContentId({ kind: "track", value: value as string });
  } catch {
    return invalidJellyfinTrack();
  }
}

function encodeOptionalEntityId(
  kind: "album" | "artist",
  value: unknown,
): string | undefined {
  if (!isXmlText(value)) {
    return undefined;
  }

  try {
    return encodeSonosContentId({ kind, value });
  } catch {
    return undefined;
  }
}

function firstSafeArtist(
  artists: readonly JellyfinNamedItem[],
): JellyfinNamedItem | undefined {
  return artists.find((artist) =>
    typeof artist === "object" &&
    artist !== null &&
    isSonosMetadataText(artist.name),
  );
}

function optionalSonosInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= SONOS_MAX_SIGNED_INT
    ? (value as number)
    : undefined;
}

function optionalDurationSeconds(durationMs: unknown): number | undefined {
  if (!Number.isSafeInteger(durationMs) || (durationMs as number) < 0) {
    return undefined;
  }

  const seconds = Math.floor((durationMs as number) / 1_000);
  return seconds <= SONOS_MAX_SIGNED_INT ? seconds : undefined;
}

function requiredMimeType(container: unknown): string {
  if (
    typeof container !== "string" ||
    container === "" ||
    container.trim() !== container
  ) {
    return invalidJellyfinTrack();
  }

  const mimeType = SONOS_MIME_TYPES_BY_JELLYFIN_CONTAINER[
    container.toLowerCase() as keyof typeof SONOS_MIME_TYPES_BY_JELLYFIN_CONTAINER
  ];
  return mimeType ?? invalidJellyfinTrack();
}

/**
 * Converts one normalized Jellyfin track to the single SMAPI representation
 * shared by album, playlist, search, and item-metadata routes.
 */
export function formatJellyfinTrackAsSonosBrowseTrack(
  track: JellyfinTrack,
): SonosBrowseTrack {
  if (
    typeof track !== "object" ||
    track === null ||
    track.kind !== "track" ||
    !isSingleLineXmlText(track.name) ||
    !Array.isArray(track.artists)
  ) {
    return invalidJellyfinTrack();
  }

  const artist = firstSafeArtist(track.artists);
  const artistId = encodeOptionalEntityId("artist", artist?.id);
  const albumId = encodeOptionalEntityId("album", track.albumId);
  const album = isSonosMetadataText(track.albumName)
    ? track.albumName
    : undefined;
  const duration = optionalDurationSeconds(track.durationMs);
  const trackNumber = optionalSonosInteger(track.trackNumber);
  const trackMetadata = Object.freeze({
    ...(artistId === undefined ? {} : { artistId }),
    ...(artist === undefined ? {} : { artist: artist.name }),
    ...(albumId === undefined ? {} : { albumId }),
    ...(album === undefined ? {} : { album }),
    ...(duration === undefined ? {} : { duration }),
    ...(trackNumber === undefined ? {} : { trackNumber }),
    canAddToFavorites: false,
    canPlay: false,
    canResume: false,
    canSeek: false,
    canSkip: false,
  });

  return Object.freeze({
    id: encodeRequiredTrackId(track.id),
    itemType: "track",
    kind: "track",
    mimeType: requiredMimeType(track.container),
    title: track.name,
    trackMetadata,
  });
}
