import type {
  JellyfinAudioStreamInfo,
  JellyfinDataConnection,
  JellyfinMediaSource,
  JellyfinPlaybackInfo,
} from "./data-types";
import { JellyfinClientError } from "./errors";
import {
  isCharacterLength,
  isWellFormedUnicode,
  jsonHeaders,
  normalizeServerUrl,
} from "./transport";

type PlaybackMethod = "direct-play" | "transcode";
type PlaybackMimeType =
  | "audio/mpeg"
  | "audio/aac"
  | "audio/mp4"
  | "audio/flac"
  | "application/vnd.apple.mpegurl";
export type JellyfinPlaybackFailure =
  | "playback_no_compatible_stream"
  | "playback_info_error"
  | "playback_no_media_sources"
  | "playback_credential_conflict"
  | "playback_source_metadata"
  | "playback_transcode_profile"
  | "playback_transcode_url_missing"
  | "playback_transcode_url_malformed"
  | "playback_transcode_url_unsafe_path"
  | "playback_transcode_url_insecure_scheme"
  | "playback_transcode_url_origin"
  | "playback_transcode_url_base_path"
  | "playback_transcode_url_route"
  | "playback_transcode_url_too_long"
  | "playback_transcode_query_shape"
  | "playback_transcode_query_binding"
  | "playback_transcode_query_audio"
  | "playback_transcode_query_options";

export interface JellyfinPlaybackTarget {
  readonly method: PlaybackMethod;
  readonly url: string;
  readonly mimeType: PlaybackMimeType;
  readonly httpHeaders: readonly {
    readonly header: "Authorization";
    readonly value: string;
  }[];
}

/** No upstream value is retained in this public failure. */
export class JellyfinPlaybackTargetError extends Error {
  readonly code = "no_compatible_stream" as const;
  readonly failure: JellyfinPlaybackFailure;

  constructor(failure: JellyfinPlaybackFailure = "playback_no_compatible_stream") {
    super("No compatible Jellyfin audio stream is available");
    this.name = "JellyfinPlaybackTargetError";
    this.failure = failure;
  }
}

interface Candidate extends JellyfinPlaybackTarget {
  readonly sourceId: string;
  readonly fileSource: boolean;
}

type SourceResolution = Candidate | JellyfinPlaybackFailure;
type TranscodeUrlResolution =
  | { readonly url: string }
  | { readonly failure: JellyfinPlaybackFailure };
type TranscodeQueryResolution =
  | { readonly query: string }
  | { readonly failure: JellyfinPlaybackFailure };

const FAILURE_PRIORITY: readonly JellyfinPlaybackFailure[] = [
  "playback_transcode_query_audio",
  "playback_transcode_query_binding",
  "playback_transcode_query_options",
  "playback_transcode_query_shape",
  "playback_transcode_url_unsafe_path",
  "playback_transcode_url_insecure_scheme",
  "playback_transcode_url_origin",
  "playback_transcode_url_base_path",
  "playback_transcode_url_route",
  "playback_transcode_url_too_long",
  "playback_transcode_url_malformed",
  "playback_transcode_url_missing",
  "playback_transcode_profile",
  "playback_source_metadata",
];

const MAX_URL_LENGTH = 4_096;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_TOKEN_LENGTH = 4_096;
const PERCENT = /%(?![0-9a-fA-F]{2})/u;
const ENCODED_SEPARATOR = /%(?:2f|5c|25)/iu;
const GUID_N = /^[0-9a-f]{32}$/iu;
const GUID_D = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TRANSCODE_REASONS = [
  "ContainerNotSupported",
  "ContainerBitrateExceedsLimit",
  "AudioCodecNotSupported",
  "AudioBitrateNotSupported",
  "AudioChannelsNotSupported",
  "AudioProfileNotSupported",
  "AudioSampleRateNotSupported",
  "AudioBitDepthNotSupported",
  "SecondaryAudioNotSupported",
  "AudioIsExternal",
] as const;
const REASONS = new Set<string>(TRANSCODE_REASONS);
const QUERY_ORDER = [
  "DeviceId",
  "MediaSourceId",
  "AudioCodec",
  "AudioStreamIndex",
  "AudioBitrate",
  "AudioSampleRate",
  "SegmentContainer",
  "SegmentLength",
  "MinSegments",
  "BreakOnNonKeyFrames",
  "TranscodingMaxAudioChannels",
  "RequireAvc",
  "EnableAudioVbrEncoding",
  "audiochannels",
  "aac-audiochannels",
  "allowAudioStreamCopy",
  "allowVideoStreamCopy",
  "TranscodeReasons",
] as const;
const ALLOWED_QUERY = new Set<string>([
  ...QUERY_ORDER,
  "PlaySessionId",
  "Tag",
  "ApiKey",
]);

/** Resolve a negotiated PlaybackInfo response without passing through Jellyfin URLs or headers. */
export function resolveSonosPlaybackTarget(
  itemId: string,
  playbackInfo: JellyfinPlaybackInfo,
  connection: JellyfinDataConnection,
): JellyfinPlaybackTarget {
  if (
    !safeId(itemId) ||
    !connection ||
    !safeText(connection.deviceId, MAX_IDENTIFIER_LENGTH) ||
    !safeText(connection.accessToken, MAX_TOKEN_LENGTH) ||
    !playbackInfo ||
    !Array.isArray(playbackInfo.mediaSources)
  ) {
    throw new JellyfinClientError("invalid_input");
  }

  // Local development may permit HTTP for API calls, but player URLs never do.
  const serverUrl = normalizeServerUrl(connection.serverUrl, false);
  if (!safeConfiguredBasePath(connection.serverUrl)) {
    throw new JellyfinClientError("invalid_input");
  }
  if (
    containsCredential(serverUrl, connection.accessToken) ||
    itemId.includes(connection.accessToken) ||
    connection.deviceId.includes(connection.accessToken)
  ) {
    throw new JellyfinPlaybackTargetError("playback_credential_conflict");
  }
  const baseUrl = new URL(serverUrl);
  const authorization = jsonHeaders(
    connection.deviceId,
    connection.accessToken,
  ).get("authorization");
  if (authorization === null || hasControl(authorization)) {
    throw new JellyfinClientError("invalid_input");
  }
  if (playbackInfo.errorCode !== undefined) {
    throw new JellyfinPlaybackTargetError("playback_info_error");
  }

  const candidates: Candidate[] = [];
  const failures = new Set<JellyfinPlaybackFailure>();
  if (playbackInfo.mediaSources.length === 0) {
    throw new JellyfinPlaybackTargetError("playback_no_media_sources");
  }
  const sourceCounts = new Map<string, number>();
  for (const source of playbackInfo.mediaSources) {
    if (source && safeId(source.id)) {
      sourceCounts.set(source.id, (sourceCounts.get(source.id) ?? 0) + 1);
    }
  }
  for (const source of playbackInfo.mediaSources) {
    if (source && sourceCounts.get(source.id) !== 1) {
      failures.add("playback_source_metadata");
      continue;
    }
    const candidate = resolveSource(
      source,
      itemId,
      connection,
      baseUrl,
      authorization,
    );
    if (typeof candidate === "string") failures.add(candidate);
    else candidates.push(candidate);
  }
  candidates.sort(
    (left, right) =>
      Number(right.method === "direct-play") -
        Number(left.method === "direct-play") ||
      Number(right.fileSource) - Number(left.fileSource) ||
      (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0),
  );
  const selected = candidates[0];
  if (selected === undefined) {
    throw new JellyfinPlaybackTargetError(
      FAILURE_PRIORITY.find((failure) => failures.has(failure)) ??
        "playback_source_metadata",
    );
  }
  return {
    method: selected.method,
    url: selected.url,
    mimeType: selected.mimeType,
    httpHeaders: selected.httpHeaders,
  };
}

function resolveSource(
  source: JellyfinMediaSource,
  itemId: string,
  connection: JellyfinDataConnection,
  baseUrl: URL,
  authorization: string,
): SourceResolution {
  if (
    !source ||
    !safeId(source.id) ||
    source.id.includes(connection.accessToken) ||
    !Array.isArray(source.audioStreams) ||
    !safeRequiredHeaders(source.requiredHttpHeaders)
  ) {
    return "playback_source_metadata";
  }
  const stream = selectAudioStream(source);
  if (stream === undefined) {
    return "playback_source_metadata";
  }
  const httpHeaders = [{ header: "Authorization" as const, value: authorization }];
  const fileSource =
    typeof source.protocol === "string" &&
    source.protocol.toLowerCase() === "file";
  const container = boundedToken(source.container)?.toLowerCase();
  const codec = boundedToken(stream.codec)?.toLowerCase();
  const directMime = directPlayMime(container, codec, stream, source.bitrate);
  if (fileSource && source.supportsDirectPlay && directMime !== undefined) {
    const path = `/Audio/${encodeSegment(itemId)}/stream.${container}`;
    const url = new URL(`${baseUrl.pathname.replace(/\/$/u, "")}${path}`, baseUrl);
    url.search = `static=true&mediaSourceId=${encodeSegment(source.id)}`;
    if (url.href.length <= MAX_URL_LENGTH) {
      return {
        method: "direct-play",
        url: url.href,
        mimeType: directMime,
        httpHeaders,
        sourceId: source.id,
        fileSource,
      };
    }
  }
  if (
    !source.supportsTranscoding ||
    boundedToken(source.transcodingContainer)?.toLowerCase() !== "ts" ||
    boundedToken(source.transcodingSubProtocol)?.toLowerCase() !== "hls"
  ) {
    return "playback_transcode_profile";
  }
  const target = normalizeTranscodeUrl(
    source.transcodingUrl,
    itemId,
    source.id,
    stream.index,
    connection,
    baseUrl,
  );
  if ("failure" in target) return target.failure;
  return {
    method: "transcode",
    url: target.url,
    mimeType: "application/vnd.apple.mpegurl",
    httpHeaders,
    sourceId: source.id,
    fileSource,
  };
}

function selectAudioStream(
  source: JellyfinMediaSource,
): JellyfinAudioStreamInfo | undefined {
  const streams = source.audioStreams;
  if (
    streams.length === 0 ||
    streams.length > 32 ||
    streams.some(
      (stream) =>
        !stream ||
        !Number.isSafeInteger(stream.index) ||
        stream.index < 0 ||
        stream.index > 10_000,
    ) ||
    new Set(streams.map((stream) => stream.index)).size !== streams.length
  ) {
    return undefined;
  }
  if (source.defaultAudioStreamIndex !== undefined) {
    return streams.find((stream) => stream.index === source.defaultAudioStreamIndex);
  }
  const defaults = streams.filter((stream) => stream.isDefault);
  if (defaults.length === 1) {
    return defaults[0];
  }
  return defaults.length === 0 && streams.length === 1 ? streams[0] : undefined;
}

function directPlayMime(
  container: string | undefined,
  codec: string | undefined,
  stream: JellyfinAudioStreamInfo,
  sourceBitrate: number | undefined,
): PlaybackMimeType | undefined {
  const bitrates = [sourceBitrate, stream.bitrate].filter(
    (value): value is number => value !== undefined,
  );
  if (
    bitrates.length === 0 ||
    bitrates.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 8_000_000) ||
    !Number.isSafeInteger(stream.channels) ||
    stream.channels! < 1 ||
    stream.channels! > 2 ||
    !Number.isSafeInteger(stream.sampleRate) ||
    stream.sampleRate! < 1 ||
    stream.sampleRate! > 48_000
  ) {
    return undefined;
  }
  if (container === "mp3" && codec === "mp3") {
    return "audio/mpeg";
  }
  if (container === "aac" && codec === "aac") {
    return "audio/aac";
  }
  if ((container === "m4a" || container === "mp4") && codec === "aac") {
    return "audio/mp4";
  }
  if (
    container === "flac" &&
    codec === "flac" &&
    Number.isSafeInteger(stream.bitDepth) &&
    stream.bitDepth! >= 1 &&
    stream.bitDepth! <= 16
  ) {
    return "audio/flac";
  }
  return undefined;
}

function normalizeTranscodeUrl(
  raw: string | undefined,
  itemId: string,
  sourceId: string,
  audioStreamIndex: number,
  connection: JellyfinDataConnection,
  baseUrl: URL,
): TranscodeUrlResolution {
  if (raw === undefined || raw === "") {
    return { failure: "playback_transcode_url_missing" };
  }
  if (typeof raw !== "string" || !isWellFormedUnicode(raw)) {
    return { failure: "playback_transcode_url_malformed" };
  }
  if (raw.length > MAX_URL_LENGTH) {
    return { failure: "playback_transcode_url_too_long" };
  }
  if (raw.trim().length === 0) {
    return { failure: "playback_transcode_url_missing" };
  }
  if (hasControl(raw) || raw.includes("\\") || raw.includes("#")) {
    return { failure: "playback_transcode_url_unsafe_path" };
  }
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(raw);
  if ((!absolute && !raw.startsWith("/")) || raw.startsWith("//")) {
    return { failure: "playback_transcode_url_malformed" };
  }
  const rawPath = raw.split("?", 1)[0] ?? "";
  let path: string;
  if (absolute) {
    const authorityStart = raw.indexOf("://") + 3;
    const pathStart = raw.indexOf("/", authorityStart);
    const authority = raw.slice(authorityStart, pathStart < 0 ? undefined : pathStart).split("?", 1)[0];
    if (authority?.includes("@")) {
      return { failure: "playback_transcode_url_unsafe_path" };
    }
    path = pathStart < 0 ? "/" : raw.slice(pathStart).split("?", 1)[0] ?? "";
  } else {
    path = rawPath;
  }
  if (!safePath(path)) {
    return { failure: "playback_transcode_url_unsafe_path" };
  }
  let url: URL;
  try {
    url = new URL(raw, baseUrl);
  } catch {
    return { failure: "playback_transcode_url_malformed" };
  }
  if (url.protocol !== "https:") {
    return { failure: "playback_transcode_url_insecure_scheme" };
  }
  if (url.origin !== baseUrl.origin) {
    return { failure: "playback_transcode_url_origin" };
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    return { failure: "playback_transcode_url_unsafe_path" };
  }
  const basePath = baseUrl.pathname.replace(/\/$/u, "");
  const expectedSuffix = `/audio/${encodeSegment(itemId)}/master.m3u8`;
  const alreadyBased = path === basePath || path.startsWith(`${basePath}/`);
  if (absolute && basePath !== "" && !alreadyBased) {
    return { failure: "playback_transcode_url_base_path" };
  }
  const applicationPath = alreadyBased ? path.slice(basePath.length) : path;
  if (!pathMatches(applicationPath, itemId)) {
    return { failure: "playback_transcode_url_route" };
  }
  const query = parseTranscodeQuery(raw, sourceId, audioStreamIndex, connection);
  if ("failure" in query) return query;
  const normalized = new URL(`${basePath}${expectedSuffix}`, baseUrl);
  normalized.search = query.query;
  return normalized.href.length <= MAX_URL_LENGTH
    ? { url: normalized.href }
    : { failure: "playback_transcode_url_too_long" };
}

function safePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > MAX_URL_LENGTH ||
    hasControl(path) ||
    PERCENT.test(path) ||
    ENCODED_SEPARATOR.test(path)
  ) {
    return false;
  }
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("\\") ||
      decoded.includes("/") ||
      decoded.includes("%") ||
      hasControl(decoded)
    ) {
      return false;
    }
  }
  return true;
}

function pathMatches(path: string, itemId: string): boolean {
  const segments = path.split("/");
  if (
    segments.length !== 4 ||
    segments[0] !== "" ||
    segments[1] !== "audio" ||
    segments[3] !== "master.m3u8"
  ) {
    return false;
  }
  try {
    const pathId = decodeURIComponent(segments[2] ?? "");
    if (pathId === itemId) {
      return true;
    }
    const itemGuid = canonicalGuid(itemId);
    return itemGuid !== undefined && canonicalGuid(pathId) === itemGuid;
  } catch {
    return false;
  }
}

function canonicalGuid(value: string): string | undefined {
  if (GUID_N.test(value)) {
    return value.toLowerCase();
  }
  if (GUID_D.test(value)) {
    return value.replaceAll("-", "").toLowerCase();
  }
  return undefined;
}

function parseTranscodeQuery(
  rawUrl: string,
  sourceId: string,
  audioStreamIndex: number,
  connection: JellyfinDataConnection,
): TranscodeQueryResolution {
  const separator = rawUrl.indexOf("?");
  if (separator < 0) {
    return { failure: "playback_transcode_query_shape" };
  }
  const rawQuery = rawUrl.slice(separator + 1).replace(/^&/u, "");
  if (rawQuery.length === 0 || rawQuery.length > MAX_URL_LENGTH) {
    return { failure: "playback_transcode_query_shape" };
  }
  const values = new Map<string, string>();
  for (const entry of rawQuery.split("&")) {
    const equals = entry.indexOf("=");
    if (equals < 1) {
      return { failure: "playback_transcode_query_shape" };
    }
    const name = entry.slice(0, equals);
    const encodedValue = entry.slice(equals + 1);
    if (
      !ALLOWED_QUERY.has(name) ||
      values.has(name) ||
      encodedValue.length > (name === "ApiKey" ? MAX_TOKEN_LENGTH : 512) ||
      PERCENT.test(encodedValue)
    ) {
      return { failure: "playback_transcode_query_shape" };
    }
    let value: string;
    try {
      value = decodeURIComponent(encodedValue.replace(/\+/gu, " "));
    } catch {
      return { failure: "playback_transcode_query_shape" };
    }
    if (
      !isWellFormedUnicode(value) ||
      value.length > (name === "ApiKey" ? MAX_TOKEN_LENGTH : 255) ||
      hasControl(value)
    ) {
      return { failure: "playback_transcode_query_shape" };
    }
    values.set(name, value);
  }
  if (
    (values.has("ApiKey") && values.get("ApiKey") !== connection.accessToken) ||
    values.get("DeviceId") !== connection.deviceId ||
    values.get("MediaSourceId") !== sourceId ||
    values.get("AudioCodec") !== "aac" ||
    (values.has("AudioStreamIndex") &&
      values.get("AudioStreamIndex") !== String(audioStreamIndex))
  ) {
    return { failure: "playback_transcode_query_binding" };
  }
  const channelOptions = [
    values.get("audiochannels"),
    values.get("aac-audiochannels"),
  ].filter((value): value is string => value !== undefined);
  if (
    !boundedInteger(values.get("AudioBitrate"), 1, 320_000) ||
    !boundedInteger(values.get("AudioSampleRate"), 1, 48_000) ||
    !boundedInteger(values.get("TranscodingMaxAudioChannels"), 1, 2) ||
    channelOptions.length !== 1 ||
    !boundedInteger(channelOptions[0], 1, 2)
  ) {
    return { failure: "playback_transcode_query_audio" };
  }
  if (
    values.get("SegmentContainer") !== "ts" ||
    values.get("SegmentLength") !== "10" ||
    values.get("MinSegments") !== "1" ||
    !approvedBoolean(values.get("BreakOnNonKeyFrames"), false) ||
    !approvedBoolean(values.get("RequireAvc"), false) ||
    !approvedBoolean(values.get("EnableAudioVbrEncoding"), false) ||
    !approvedBoolean(values.get("allowAudioStreamCopy"), false) ||
    !approvedBoolean(values.get("allowVideoStreamCopy"), false) ||
    !validDiscardedId(values.get("PlaySessionId")) ||
    !validDiscardedId(values.get("Tag"))
  ) {
    return { failure: "playback_transcode_query_options" };
  }
  const transcodeReasons = canonicalTranscodeReasons(
    values.get("TranscodeReasons"),
  );
  if (transcodeReasons === null) {
    return { failure: "playback_transcode_query_options" };
  }
  for (const [name, expected] of [
    ["BreakOnNonKeyFrames", false],
    ["RequireAvc", false],
    ["EnableAudioVbrEncoding", false],
    ["allowAudioStreamCopy", false],
    ["allowVideoStreamCopy", false],
  ] as const) {
    values.set(name, String(expected));
  }
  if (transcodeReasons !== undefined) {
    values.set("TranscodeReasons", transcodeReasons);
  }
  const canonical = new URLSearchParams();
  for (const name of QUERY_ORDER) {
    const value = values.get(name);
    if (value !== undefined) {
      canonical.append(name, value);
    }
  }
  return { query: canonical.toString() };
}

function approvedBoolean(value: string | undefined, expected: boolean): boolean {
  return value === String(expected) || value === (expected ? "True" : "False");
}

function canonicalTranscodeReasons(
  value: string | undefined,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  const reasons = value.split(",");
  const reasonSet = new Set(reasons);
  if (
    reasons.length < 1 ||
    reasons.length > REASONS.size ||
    reasonSet.size !== reasons.length ||
    !reasons.every((reason) => REASONS.has(reason))
  ) {
    return null;
  }
  return TRANSCODE_REASONS.filter((reason) => reasonSet.has(reason)).join(",");
}

function validDiscardedId(value: string | undefined): boolean {
  return value === undefined || /^[A-Za-z0-9._~-]{1,255}$/u.test(value);
}

function boundedInteger(value: string | undefined, min: number, max: number): boolean {
  return (
    value !== undefined &&
    /^(?:0|[1-9][0-9]*)$/u.test(value) &&
    Number(value) >= min &&
    Number(value) <= max
  );
}

function safeRequiredHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): boolean {
  return (
    headers === undefined ||
    (headers !== null &&
      typeof headers === "object" &&
      !Array.isArray(headers) &&
      Object.keys(headers).length === 0)
  );
}

function boundedToken(value: string | undefined): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9]{1,32}$/u.test(value)
    ? value
    : undefined;
}

function safeId(value: unknown): value is string {
  return (
    isCharacterLength(value, 1, MAX_IDENTIFIER_LENGTH) &&
    value.trim() === value &&
    !hasControl(value) &&
    value !== "." &&
    value !== ".."
  );
}

function safeText(value: unknown, maxLength: number): value is string {
  return (
    isCharacterLength(value, 1, maxLength) &&
    value.trim().length > 0 &&
    !hasControl(value)
  );
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function safeConfiguredBasePath(serverUrl: string): boolean {
  const candidate = serverUrl.trim();
  const authorityStart = candidate.indexOf("://") + 3;
  const pathStart = candidate.indexOf("/", authorityStart);
  return pathStart < 0 || safePath(candidate.slice(pathStart));
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function containsCredential(value: string, credential: string): boolean {
  if (value.includes(credential)) {
    return true;
  }
  try {
    return decodeURIComponent(value).includes(credential);
  } catch {
    return true;
  }
}
