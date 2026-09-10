import { SMAPI_NAMESPACE, SOAP_ENVELOPE_NAMESPACE } from "./constants";
import {
  SONOS_MAX_ITEM_ID_CHARACTERS,
} from "./content-id";
import {
  SONOS_MAX_PAGE_COUNT,
  SONOS_MAX_SIGNED_INT,
} from "./pagination";
import {
  SONOS_MAX_COLLECTION_TEXT_CHARACTERS,
  type GetExtendedMetadataResult,
  type GetMediaMetadataResult,
  type GetMetadataResult,
  type SearchResult,
  type SonosBrowseCollection,
  type SonosBrowseItem,
  type SonosBrowseTrack,
  type SonosCollectionItemType,
  type SonosTrackMetadata,
} from "./browse";

const XML_DECLARATION = '<?xml version="1.0" encoding="utf-8"?>';

export interface LastUpdateResult {
  catalog: string;
  favorites: string;
  pollInterval?: number;
}

export interface AppLinkResult {
  appUrlStringId: string;
  registrationUrl: string;
  linkCode: string;
  linkDeviceId?: string;
  showLinkCode: boolean;
}

export interface DeviceAuthTokenResult {
  authToken: string;
  privateKey: string;
}

export interface SoapFaultDetail {
  exceptionInfo: string;
  sonosError: number;
}

export type SonosFaultCode =
  | "Client.AuthTokenExpired"
  | "Client.DeviceCertExpired"
  | "Client.DeviceCertInvalid"
  | "Client.DeviceCertRequired"
  | "Client.DeviceCertRevoked"
  | "Client.DeviceLimit"
  | "Client.ItemNotFound"
  | "Client.LoginDisabled"
  | "Client.LoginInvalid"
  | "Client.LoginUnauthorized"
  | "Client.LoginUnsupported"
  | "Client.NOT_LINKED_FAILURE"
  | "Client.NOT_LINKED_RETRY"
  | "Client.SessionIdInvalid"
  | "Client.TokenRefreshRequired"
  | "Client.UnsupportedTerritory"
  | "Server.ServiceUnavailable"
  | "Server.ServiceUnknownError";

export type SoapFaultCode =
  | SonosFaultCode
  | "soap:Client"
  | "soap:MustUnderstand"
  | "soap:Server"
  | "soap:VersionMismatch";

const SOAP_FAULT_CODES: ReadonlySet<SoapFaultCode> = new Set([
  "Client.AuthTokenExpired",
  "Client.DeviceCertExpired",
  "Client.DeviceCertInvalid",
  "Client.DeviceCertRequired",
  "Client.DeviceCertRevoked",
  "Client.DeviceLimit",
  "Client.ItemNotFound",
  "Client.LoginDisabled",
  "Client.LoginInvalid",
  "Client.LoginUnauthorized",
  "Client.LoginUnsupported",
  "Client.NOT_LINKED_FAILURE",
  "Client.NOT_LINKED_RETRY",
  "Client.SessionIdInvalid",
  "Client.TokenRefreshRequired",
  "Client.UnsupportedTerritory",
  "Server.ServiceUnavailable",
  "Server.ServiceUnknownError",
  "soap:Client",
  "soap:MustUnderstand",
  "soap:Server",
  "soap:VersionMismatch",
]);

function escapeXmlText(value: string): string {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const isValidXmlCharacter =
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint !== undefined &&
        ((codePoint >= 0x20 && codePoint <= 0xd7ff) ||
          (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
          (codePoint >= 0x10000 && codePoint <= 0x10ffff)));

    if (!isValidXmlCharacter) {
      throw new TypeError("Value contains a character forbidden by XML 1.0");
    }
  }

  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function soapEnvelope(body: string): string {
  return (
    `${XML_DECLARATION}` +
    `<soap:Envelope xmlns:soap="${SOAP_ENVELOPE_NAMESPACE}">` +
    `<soap:Body>${body}</soap:Body>` +
    `</soap:Envelope>`
  );
}

function requireNonEmpty(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must not be empty`);
  }
}

function requireMaximumLength(
  value: string,
  maximumLength: number,
  field: string,
): void {
  if ([...value].length > maximumLength) {
    throw new RangeError(`${field} must not exceed ${maximumLength} characters`);
  }
}

function requireBoolean(
  value: unknown,
  field: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean`);
  }
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): asserts value is number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new RangeError(
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
}

function requiredTextElement(
  element: string,
  value: unknown,
  field = element,
): string {
  requireNonEmpty(value, field);
  return `<${element}>${escapeXmlText(value)}</${element}>`;
}

const SONOS_LINE_BREAK_PATTERN = /[\n\r\u0085\u2028\u2029]/u;

function requireSingleLineText(
  value: unknown,
  field: string,
): asserts value is string {
  requireNonEmpty(value, field);
  if (SONOS_LINE_BREAK_PATTERN.test(value)) {
    throw new TypeError(`${field} must not contain newlines`);
  }
}

function requireDisplayText(
  value: unknown,
  field: string,
): asserts value is string {
  requireSingleLineText(value, field);
  requireMaximumLength(value, SONOS_MAX_COLLECTION_TEXT_CHARACTERS, field);
}

function requiredSingleLineTextElement(
  element: string,
  value: unknown,
  field = element,
): string {
  requireSingleLineText(value, field);
  return `<${element}>${escapeXmlText(value)}</${element}>`;
}

function requiredDisplayTextElement(
  element: string,
  value: unknown,
  field = element,
): string {
  requireDisplayText(value, field);
  return `<${element}>${escapeXmlText(value)}</${element}>`;
}

function optionalDisplayTextElement(
  element: string,
  value: unknown,
  field = element,
): string {
  return value === undefined
    ? ""
    : requiredDisplayTextElement(element, value, field);
}

function optionalTextElement(
  element: string,
  value: unknown,
  field = element,
): string {
  if (value === undefined) {
    return "";
  }
  return requiredTextElement(element, value, field);
}

function optionalBooleanElement(
  element: string,
  value: unknown,
  field = element,
): string {
  if (value === undefined) {
    return "";
  }
  requireBoolean(value, field);
  return `<${element}>${String(value)}</${element}>`;
}

function optionalIntegerElement(
  element: string,
  value: unknown,
  minimum: number,
  field = element,
): string {
  if (value === undefined) {
    return "";
  }
  requireInteger(value, minimum, SONOS_MAX_SIGNED_INT, field);
  return `<${element}>${value}</${element}>`;
}

function itemIdElement(element: string, value: unknown, field = element): string {
  requireNonEmpty(value, field);
  requireMaximumLength(value, SONOS_MAX_ITEM_ID_CHARACTERS, field);
  return `<${element}>${escapeXmlText(value)}</${element}>`;
}

function optionalItemIdElement(
  element: string,
  value: unknown,
  field = element,
): string {
  return value === undefined ? "" : itemIdElement(element, value, field);
}

const COLLECTION_ITEM_TYPES: ReadonlySet<SonosCollectionItemType> = new Set([
  "artist",
  "album",
  "genre",
  "playlist",
  "search",
  "favorites",
  "favorite",
  "collection",
  "container",
  "albumList",
  "trackList",
  "streamList",
  "artistTrackList",
  "audiobook",
  "other",
]);

function serializeBrowseBase(
  item: SonosBrowseItem,
  itemType: string,
): string {
  return (
    itemIdElement("id", item.id) +
    `<itemType>${itemType}</itemType>` +
    optionalTextElement("displayType", item.displayType) +
    (item.kind === "collection"
      ? requiredDisplayTextElement("title", item.title)
      : requiredSingleLineTextElement("title", item.title)) +
    optionalTextElement("summary", item.summary) +
    optionalBooleanElement("isFavorite", item.isFavorite) +
    optionalBooleanElement("isExplicit", item.isExplicit) +
    optionalBooleanElement("isEphemeral", item.isEphemeral)
  );
}

function serializeCollection(item: SonosBrowseCollection): string {
  if (!COLLECTION_ITEM_TYPES.has(item.itemType)) {
    throw new TypeError("itemType must be a supported collection item type");
  }

  return (
    `<mediaCollection>` +
    serializeBrowseBase(item, item.itemType) +
    optionalDisplayTextElement("artist", item.artist) +
    optionalItemIdElement("artistId", item.artistId) +
    optionalBooleanElement("canScroll", item.canScroll) +
    optionalBooleanElement("canPlay", item.canPlay) +
    optionalBooleanElement("canEnumerate", item.canEnumerate) +
    optionalBooleanElement("canAddToFavorites", item.canAddToFavorites) +
    optionalBooleanElement("containsFavorite", item.containsFavorite) +
    optionalBooleanElement("canSkip", item.canSkip) +
    optionalBooleanElement("canResume", item.canResume) +
    optionalIntegerElement("total", item.total, 0) +
    `</mediaCollection>`
  );
}

function serializeTrackMetadata(metadata: SonosTrackMetadata): string {
  return (
    `<trackMetadata>` +
    optionalItemIdElement("artistId", metadata.artistId) +
    optionalDisplayTextElement("artist", metadata.artist) +
    optionalItemIdElement("composerId", metadata.composerId) +
    optionalDisplayTextElement("composer", metadata.composer) +
    optionalItemIdElement("albumArtistId", metadata.albumArtistId) +
    optionalDisplayTextElement("albumArtist", metadata.albumArtist) +
    optionalItemIdElement("albumId", metadata.albumId) +
    optionalDisplayTextElement("album", metadata.album) +
    optionalItemIdElement("genreId", metadata.genreId) +
    optionalDisplayTextElement("genre", metadata.genre) +
    optionalIntegerElement("duration", metadata.duration, 0) +
    optionalIntegerElement("rating", metadata.rating, -SONOS_MAX_SIGNED_INT - 1) +
    optionalIntegerElement("trackNumber", metadata.trackNumber, 0) +
    optionalBooleanElement("canPlay", metadata.canPlay) +
    optionalBooleanElement("canSkip", metadata.canSkip) +
    optionalBooleanElement(
      "canAddToFavorites",
      metadata.canAddToFavorites,
    ) +
    optionalBooleanElement("canResume", metadata.canResume) +
    optionalBooleanElement("canSeek", metadata.canSeek) +
    `</trackMetadata>`
  );
}

function serializeTrackContents(item: SonosBrowseTrack): string {
  if (item.itemType !== "track") {
    throw new TypeError("itemType must be track for browse tracks");
  }
  if (typeof item.trackMetadata !== "object" || item.trackMetadata === null) {
    throw new TypeError("trackMetadata must be an object");
  }

  return (
    serializeBrowseBase(item, item.itemType) +
    requiredTextElement("mimeType", item.mimeType) +
    serializeTrackMetadata(item.trackMetadata)
  );
}

function serializeTrack(item: SonosBrowseTrack): string {
  return `<mediaMetadata>${serializeTrackContents(item)}</mediaMetadata>`;
}

function serializeBrowseItem(item: SonosBrowseItem): string {
  if (typeof item !== "object" || item === null) {
    throw new TypeError("items must contain browse item objects");
  }

  if (item.kind === "collection") {
    return serializeCollection(item);
  }
  if (item.kind === "track") {
    return serializeTrack(item);
  }

  throw new TypeError("items must contain supported browse item kinds");
}

function serializeMediaList(
  result: GetMetadataResult,
  resultName: string,
): string {
  if (typeof result !== "object" || result === null) {
    throw new TypeError(`${resultName} must be an object`);
  }
  requireInteger(result.index, 0, SONOS_MAX_SIGNED_INT, "index");
  requireInteger(result.total, 0, SONOS_MAX_SIGNED_INT, "total");
  if (!Array.isArray(result.items)) {
    throw new TypeError("items must be an array");
  }

  const count = result.items.length;
  if (count > SONOS_MAX_PAGE_COUNT) {
    throw new RangeError(
      `count must not exceed ${SONOS_MAX_PAGE_COUNT}`,
    );
  }
  if (count > result.total) {
    throw new RangeError("count must not exceed total");
  }
  if (count === 0 && result.index < result.total) {
    throw new RangeError("an empty page must not leave results remaining");
  }
  if (count > 0 && result.index + count > result.total) {
    throw new RangeError("the returned page must fit within total");
  }

  let items = "";
  for (const item of result.items) {
    items += serializeBrowseItem(item);
  }
  return (
    `<index>${result.index}</index>` +
    `<count>${count}</count>` +
    `<total>${result.total}</total>` +
    items
  );
}

export function serializeGetMetadataResponse(
  result: GetMetadataResult,
): string {
  const mediaList = serializeMediaList(result, "getMetadata result");
  return soapEnvelope(
    `<getMetadataResponse xmlns="${SMAPI_NAMESPACE}">` +
      `<getMetadataResult>` +
      mediaList +
      `</getMetadataResult>` +
      `</getMetadataResponse>`,
  );
}

export function serializeGetExtendedMetadataResponse(
  result: GetExtendedMetadataResult,
): string {
  const item = serializeBrowseItem(result);
  return soapEnvelope(
    `<getExtendedMetadataResponse xmlns="${SMAPI_NAMESPACE}">` +
      `<getExtendedMetadataResult>` +
      item +
      `</getExtendedMetadataResult>` +
      `</getExtendedMetadataResponse>`,
  );
}

export function serializeGetMediaMetadataResponse(
  result: GetMediaMetadataResult,
): string {
  if (typeof result !== "object" || result === null || result.kind !== "track") {
    throw new TypeError("getMediaMetadata result must be a track");
  }

  return soapEnvelope(
    `<getMediaMetadataResponse xmlns="${SMAPI_NAMESPACE}">` +
      `<getMediaMetadataResult>` +
      serializeTrackContents(result) +
      `</getMediaMetadataResult>` +
      `</getMediaMetadataResponse>`,
  );
}

export function serializeSearchResponse(result: SearchResult): string {
  const mediaList = serializeMediaList(result, "search result");
  return soapEnvelope(
    `<searchResponse xmlns="${SMAPI_NAMESPACE}">` +
      `<searchResult>` +
      mediaList +
      `</searchResult>` +
      `</searchResponse>`,
  );
}

export function serializeGetLastUpdateResponse(
  result: LastUpdateResult,
): string {
  requireNonEmpty(result.catalog, "catalog");
  requireNonEmpty(result.favorites, "favorites");

  if (
    result.pollInterval !== undefined &&
    (!Number.isInteger(result.pollInterval) ||
      result.pollInterval < 30 ||
      result.pollInterval > 3600)
  ) {
    throw new RangeError("pollInterval must be an integer from 30 to 3600");
  }

  const pollInterval =
    result.pollInterval === undefined
      ? ""
      : `<pollInterval>${result.pollInterval}</pollInterval>`;

  return soapEnvelope(
    `<getLastUpdateResponse xmlns="${SMAPI_NAMESPACE}">` +
      `<getLastUpdateResult>` +
      `<catalog>${escapeXmlText(result.catalog)}</catalog>` +
      `<favorites>${escapeXmlText(result.favorites)}</favorites>` +
      pollInterval +
      `</getLastUpdateResult>` +
      `</getLastUpdateResponse>`,
  );
}

export function serializeGetAppLinkResponse(result: AppLinkResult): string {
  requireNonEmpty(result.appUrlStringId, "appUrlStringId");
  requireNonEmpty(result.registrationUrl, "registrationUrl");
  requireNonEmpty(result.linkCode, "linkCode");
  requireMaximumLength(result.linkCode, 32, "linkCode");

  if (result.linkDeviceId !== undefined) {
    requireNonEmpty(result.linkDeviceId, "linkDeviceId");
  }

  const linkDeviceId =
    result.linkDeviceId === undefined
      ? ""
      : `<linkDeviceId>${escapeXmlText(result.linkDeviceId)}</linkDeviceId>`;

  return soapEnvelope(
    `<getAppLinkResponse xmlns="${SMAPI_NAMESPACE}">` +
      `<getAppLinkResult xsi:type="appLinkResult" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<authorizeAccount>` +
      `<appUrlStringId>${escapeXmlText(result.appUrlStringId)}</appUrlStringId>` +
      `<deviceLink>` +
      `<regUrl>${escapeXmlText(result.registrationUrl)}</regUrl>` +
      `<linkCode>${escapeXmlText(result.linkCode)}</linkCode>` +
      `<showLinkCode>${String(result.showLinkCode)}</showLinkCode>` +
      linkDeviceId +
      `</deviceLink>` +
      `</authorizeAccount>` +
      `</getAppLinkResult>` +
      `</getAppLinkResponse>`,
  );
}

export function serializeGetDeviceAuthTokenResponse(
  result: DeviceAuthTokenResult,
): string {
  requireNonEmpty(result.authToken, "authToken");
  requireMaximumLength(result.authToken, 2048, "authToken");
  requireNonEmpty(result.privateKey, "privateKey");
  requireMaximumLength(result.privateKey, 2048, "privateKey");

  return soapEnvelope(
    `<getDeviceAuthTokenResponse xmlns="${SMAPI_NAMESPACE}">` +
      `<getDeviceAuthTokenResult>` +
      `<authToken>${escapeXmlText(result.authToken)}</authToken>` +
      `<privateKey>${escapeXmlText(result.privateKey)}</privateKey>` +
      `</getDeviceAuthTokenResult>` +
      `</getDeviceAuthTokenResponse>`,
  );
}

export function serializeSoapFault(
  faultString: string,
  faultCode: SoapFaultCode = "Server.ServiceUnknownError",
  detail?: SoapFaultDetail,
): string {
  requireNonEmpty(faultString, "faultString");

  if (!SOAP_FAULT_CODES.has(faultCode)) {
    throw new TypeError("faultCode must be a supported SOAP fault code");
  }

  const expectedSonosError =
    faultCode === "Client.NOT_LINKED_RETRY"
      ? 5
      : faultCode === "Client.NOT_LINKED_FAILURE"
        ? 6
        : undefined;

  if (expectedSonosError !== undefined && detail === undefined) {
    throw new TypeError(`${faultCode} requires SOAP fault detail`);
  }

  if (detail !== undefined) {
    requireNonEmpty(detail.exceptionInfo, "exceptionInfo");

    if (
      !Number.isInteger(detail.sonosError) ||
      detail.sonosError < 0 ||
      detail.sonosError > 999
    ) {
      throw new RangeError("sonosError must be an integer from 0 to 999");
    }

    if (
      expectedSonosError !== undefined &&
      detail.sonosError !== expectedSonosError
    ) {
      throw new RangeError(
        `${faultCode} requires SonosError ${expectedSonosError}`,
      );
    }
  }

  const serializedDetail =
    detail === undefined
      ? ""
      : `<detail xmlns:smapi="${SMAPI_NAMESPACE}">` +
        `<smapi:ExceptionInfo>${escapeXmlText(detail.exceptionInfo)}</smapi:ExceptionInfo>` +
        `<smapi:SonosError>${detail.sonosError}</smapi:SonosError>` +
        `</detail>`;

  return soapEnvelope(
    `<soap:Fault>` +
      `<faultcode>${escapeXmlText(faultCode)}</faultcode>` +
      `<faultstring>${escapeXmlText(faultString)}</faultstring>` +
      serializedDetail +
      `</soap:Fault>`,
  );
}
