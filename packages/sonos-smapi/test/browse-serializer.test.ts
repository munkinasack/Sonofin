import { describe, expect, it } from "vitest";
import { SaxesParser } from "saxes";

import {
  SONOS_MAX_COLLECTION_TEXT_CHARACTERS,
  SONOS_MAX_PAGE_COUNT,
  SONOS_MAX_SIGNED_INT,
  serializeGetMetadataResponse,
  type SonosBrowseCollection,
  type SonosBrowseTrack,
} from "../src";

function expectWellFormedXml(xml: string): void {
  expect(() => new SaxesParser({ xmlns: true }).write(xml).close()).not.toThrow();
}

const collection: SonosBrowseCollection = {
  kind: "collection",
  id: "album-1",
  itemType: "album",
  displayType: "grid",
  title: "An Album",
  summary: "A summary",
  isFavorite: false,
  isExplicit: true,
  isEphemeral: false,
  artist: "An Artist",
  artistId: "artist-1",
  canScroll: false,
  canPlay: true,
  canEnumerate: true,
  canAddToFavorites: false,
  containsFavorite: false,
  canSkip: true,
  canResume: false,
  total: 12,
};

const track: SonosBrowseTrack = {
  kind: "track",
  id: "track-1",
  itemType: "track",
  displayType: "list",
  title: "A Track",
  summary: "Track summary",
  isFavorite: true,
  isExplicit: false,
  isEphemeral: false,
  mimeType: "audio/flac",
  trackMetadata: {
    artistId: "artist-1",
    artist: "An Artist",
    composerId: "composer-1",
    composer: "A Composer",
    albumArtistId: "album-artist-1",
    albumArtist: "An Album Artist",
    albumId: "album-1",
    album: "An Album",
    genreId: "genre-1",
    genre: "Rock",
    duration: 181,
    rating: 5,
    trackNumber: 2,
    canPlay: true,
    canSkip: false,
    canAddToFavorites: false,
    canResume: false,
    canSeek: true,
  },
};

describe("serializeGetMetadataResponse", () => {
  it("serializes collections and tracks in exact WSDL order", () => {
    const xml = serializeGetMetadataResponse({
      index: 3,
      total: 5,
      items: [collection, track],
    });

    expect(xml).toBe(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
        '<soap:Body><getMetadataResponse xmlns="http://www.sonos.com/Services/1.1">' +
        '<getMetadataResult><index>3</index><count>2</count><total>5</total>' +
        '<mediaCollection><id>album-1</id><itemType>album</itemType>' +
        '<displayType>grid</displayType><title>An Album</title>' +
        '<summary>A summary</summary><isFavorite>false</isFavorite>' +
        '<isExplicit>true</isExplicit><isEphemeral>false</isEphemeral>' +
        '<artist>An Artist</artist><artistId>artist-1</artistId>' +
        '<canScroll>false</canScroll><canPlay>true</canPlay>' +
        '<canEnumerate>true</canEnumerate>' +
        '<canAddToFavorites>false</canAddToFavorites>' +
        '<containsFavorite>false</containsFavorite><canSkip>true</canSkip>' +
        '<canResume>false</canResume><total>12</total></mediaCollection>' +
        '<mediaMetadata><id>track-1</id><itemType>track</itemType>' +
        '<displayType>list</displayType><title>A Track</title>' +
        '<summary>Track summary</summary><isFavorite>true</isFavorite>' +
        '<isExplicit>false</isExplicit><isEphemeral>false</isEphemeral>' +
        '<mimeType>audio/flac</mimeType><trackMetadata>' +
        '<artistId>artist-1</artistId><artist>An Artist</artist>' +
        '<composerId>composer-1</composerId><composer>A Composer</composer>' +
        '<albumArtistId>album-artist-1</albumArtistId>' +
        '<albumArtist>An Album Artist</albumArtist><albumId>album-1</albumId>' +
        '<album>An Album</album><genreId>genre-1</genreId><genre>Rock</genre>' +
        '<duration>181</duration><rating>5</rating><trackNumber>2</trackNumber>' +
        '<canPlay>true</canPlay><canSkip>false</canSkip>' +
        '<canAddToFavorites>false</canAddToFavorites>' +
        '<canResume>false</canResume><canSeek>true</canSeek>' +
        '</trackMetadata></mediaMetadata></getMetadataResult>' +
        '</getMetadataResponse></soap:Body></soap:Envelope>',
    );
    expectWellFormedXml(xml);
  });

  it("preserves a safely discriminated mixed item order", () => {
    const secondCollection = {
      ...collection,
      id: "collection-2",
      itemType: "container" as const,
      title: "Second collection",
    };
    const xml = serializeGetMetadataResponse({
      index: 0,
      total: 3,
      items: [collection, track, secondCollection],
    });

    const firstCollection = xml.indexOf("<mediaCollection>");
    const middleTrack = xml.indexOf("<mediaMetadata>");
    const lastCollection = xml.lastIndexOf("<mediaCollection>");
    expect(firstCollection).toBeGreaterThan(-1);
    expect(firstCollection).toBeLessThan(middleTrack);
    expect(middleTrack).toBeLessThan(lastCollection);
    expect(xml).toContain("<count>3</count>");
  });

  it.each([
    { index: 0, total: 0 },
    { index: 30, total: 20 },
    { index: SONOS_MAX_SIGNED_INT, total: 20 },
  ])("serializes an empty or out-of-range page %#", ({ index, total }) => {
    const xml = serializeGetMetadataResponse({ index, items: [], total });

    expect(xml).toContain(`<index>${index}</index><count>0</count>`);
    expect(xml).toContain(`<total>${total}</total>`);
    expect(xml).not.toContain("<mediaCollection>");
    expect(xml).not.toContain("<mediaMetadata>");
    expectWellFormedXml(xml);
  });

  it("derives count from the item list and enforces page-size and total invariants", () => {
    const oneHundred = Array.from(
      { length: SONOS_MAX_PAGE_COUNT },
      (_, index): SonosBrowseCollection => ({
        kind: "collection",
        id: `collection-${index}`,
        itemType: "container",
        title: `Collection ${index}`,
      }),
    );

    expect(
      serializeGetMetadataResponse({
        index: 0,
        items: oneHundred,
        total: SONOS_MAX_PAGE_COUNT,
      }),
    ).toContain(`<count>${SONOS_MAX_PAGE_COUNT}</count>`);
    expect(() =>
      serializeGetMetadataResponse({
        index: 0,
        items: [...oneHundred, collection],
        total: SONOS_MAX_PAGE_COUNT + 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      serializeGetMetadataResponse({ index: 0, items: [collection], total: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      serializeGetMetadataResponse({ index: 5, items: [collection], total: 5 }),
    ).toThrow(RangeError);
    expect(() =>
      serializeGetMetadataResponse({ index: 0, items: [], total: 1 }),
    ).toThrow(RangeError);
  });

  it("rejects sparse item arrays instead of overstating response count", () => {
    const sparse = new Array<SonosBrowseCollection>(1);

    expect(() =>
      serializeGetMetadataResponse({ index: 0, items: sparse, total: 1 }),
    ).toThrow(TypeError);
  });

  it.each([
    { index: -1, total: 0 },
    { index: 0.5, total: 1 },
    { index: SONOS_MAX_SIGNED_INT + 1, total: 0 },
    { index: 0, total: -1 },
    { index: 0, total: SONOS_MAX_SIGNED_INT + 1 },
  ])("rejects invalid response bounds %#", ({ index, total }) => {
    expect(() =>
      serializeGetMetadataResponse({ index, items: [], total }),
    ).toThrow(RangeError);
  });

  it("escapes every dynamic layer without accepting XML fragments", () => {
    const xml = serializeGetMetadataResponse({
      index: 0,
      total: 2,
      items: [
        {
          kind: "collection",
          id: "collection<&",
          itemType: "container",
          title: 'Title <&>"\'',
          artist: "Artist <&",
          artistId: "artist<&",
        },
        {
          kind: "track",
          id: "track<&",
          itemType: "track",
          title: "Track <&",
          mimeType: "audio/example<&",
          trackMetadata: {
            artist: "Nested <&",
            album: 'Album "\'',
          },
        },
      ],
    });

    expect(xml).toContain("<id>collection&lt;&amp;</id>");
    expect(xml).toContain("<title>Title &lt;&amp;&gt;&quot;&apos;</title>");
    expect(xml).toContain("<artist>Artist &lt;&amp;</artist>");
    expect(xml).toContain("<mimeType>audio/example&lt;&amp;</mimeType>");
    expect(xml).toContain("<artist>Nested &lt;&amp;</artist>");
    expect(xml).toContain("<album>Album &quot;&apos;</album>");
    expectWellFormedXml(xml);
  });

  it.each([
    ["item ID", { ...collection, id: "invalid\u0000id" }],
    ["title", { ...collection, title: "invalid\ud800title" }],
    ["nested metadata", {
      ...track,
      trackMetadata: { artist: "invalid\u0001artist" },
    }],
  ] as const)("rejects XML 1.0-forbidden characters in %s", (_name, item) => {
    expect(() =>
      serializeGetMetadataResponse({ index: 0, items: [item], total: 1 }),
    ).toThrow(TypeError);
  });

  it("enforces Sonos display-text limits for collections", () => {
    const maximum = "🎵".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS);
    expect(() =>
      serializeGetMetadataResponse({
        index: 0,
        items: [{ ...collection, artist: maximum, title: maximum }],
        total: 1,
      }),
    ).not.toThrow();

    for (const item of [
      {
        ...collection,
        title: "🎵".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS + 1),
      },
      {
        ...collection,
        artist: "🎵".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS + 1),
      },
    ]) {
      expect(() =>
        serializeGetMetadataResponse({ index: 0, items: [item], total: 1 }),
      ).toThrow(RangeError);
    }

    for (const lineBreak of ["\n", "\r", "\u0085", "\u2028", "\u2029"]) {
      for (const item of [
        { ...collection, title: `line${lineBreak}break` },
        { ...collection, artist: `line${lineBreak}break` },
      ]) {
        expect(() =>
          serializeGetMetadataResponse({ index: 0, items: [item], total: 1 }),
        ).toThrow(TypeError);
      }
    }
  });

  it("keeps track titles unbounded but single-line", () => {
    const longTitle = "🎵".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS + 1);
    expect(() =>
      serializeGetMetadataResponse({
        index: 0,
        items: [{ ...track, summary: "line one\nline two", title: longTitle }],
        total: 1,
      }),
    ).not.toThrow();
    expect(() =>
      serializeGetMetadataResponse({
        index: 0,
        items: [{ ...track, title: "line\nbreak" }],
        total: 1,
      }),
    ).toThrow(TypeError);
  });

  it("enforces Sonos display-text limits for nested track metadata", () => {
    const fields = [
      "artist",
      "composer",
      "albumArtist",
      "album",
      "genre",
    ] as const;
    const maximum = "🎵".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS);
    const maximumMetadata = Object.fromEntries(
      fields.map((field) => [field, maximum]),
    );

    expect(() =>
      serializeGetMetadataResponse({
        index: 0,
        items: [
          {
            ...track,
            trackMetadata: { ...track.trackMetadata, ...maximumMetadata },
          },
        ],
        total: 1,
      }),
    ).not.toThrow();

    for (const field of fields) {
      for (const value of [
        "x".repeat(SONOS_MAX_COLLECTION_TEXT_CHARACTERS + 1),
        "line\nbreak",
      ]) {
        expect(() =>
          serializeGetMetadataResponse({
            index: 0,
            items: [
              {
                ...track,
                trackMetadata: { ...track.trackMetadata, [field]: value },
              },
            ],
            total: 1,
          }),
        ).toThrow();
      }
    }
  });

  it("enforces the 128-character limit on serialized item IDs", () => {
    expect(() =>
      serializeGetMetadataResponse({
        index: 0,
        items: [{ ...collection, id: "x".repeat(128) }],
        total: 1,
      }),
    ).not.toThrow();
    expect(() =>
      serializeGetMetadataResponse({
        index: 0,
        items: [{ ...collection, id: "x".repeat(129) }],
        total: 1,
      }),
    ).toThrow(RangeError);
  });

  it("rejects ambiguous runtime item shapes and enum injection", () => {
    expect(() =>
      serializeGetMetadataResponse({
        index: 0,
        items: [{ ...collection, kind: "unknown" } as never],
        total: 1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      serializeGetMetadataResponse({
        index: 0,
        items: [{ ...collection, itemType: "</itemType>" } as never],
        total: 1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      serializeGetMetadataResponse({
        index: 0,
        items: [{ ...track, itemType: "stream" } as never],
        total: 1,
      }),
    ).toThrow(TypeError);
  });
});
