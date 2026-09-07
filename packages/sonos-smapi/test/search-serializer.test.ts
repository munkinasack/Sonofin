import { describe, expect, it } from "vitest";
import { SaxesParser } from "saxes";

import {
  serializeSearchResponse,
  type SonosBrowseCollection,
  type SonosBrowseTrack,
} from "../src";

function expectWellFormedXml(xml: string): void {
  expect(() => new SaxesParser({ xmlns: true }).write(xml).close()).not.toThrow();
}

const collection: SonosBrowseCollection = {
  kind: "collection",
  id: "album-東京",
  itemType: "album",
  displayType: "grid",
  title: '夜の Café & <Live>',
  artist: "Björk 東京",
  artistId: "artist-日本",
  canPlay: true,
  canEnumerate: true,
  total: 9,
};

const track: SonosBrowseTrack = {
  kind: "track",
  id: "track-🎵",
  itemType: "track",
  displayType: "list",
  title: "Canción 東京 🎧",
  summary: "mix & match",
  mimeType: "audio/flac",
  trackMetadata: {
    artistId: "artist-日本",
    artist: "Björk 東京",
    albumId: "album-日本",
    album: "夜の Café",
    duration: 245,
    trackNumber: 3,
    canPlay: true,
    canSeek: true,
  },
};

describe("serializeSearchResponse", () => {
  it("serializes mixed collection and track results in exact SOAP and WSDL order", () => {
    const xml = serializeSearchResponse({
      index: 2,
      total: 9,
      items: [collection, track],
    });

    expect(xml).toBe(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
        '<soap:Body><searchResponse xmlns="http://www.sonos.com/Services/1.1">' +
        '<searchResult><index>2</index><count>2</count><total>9</total>' +
        '<mediaCollection><id>album-東京</id><itemType>album</itemType>' +
        '<displayType>grid</displayType><title>夜の Café &amp; &lt;Live&gt;</title>' +
        '<artist>Björk 東京</artist><artistId>artist-日本</artistId>' +
        '<canPlay>true</canPlay><canEnumerate>true</canEnumerate>' +
        '<total>9</total></mediaCollection>' +
        '<mediaMetadata><id>track-🎵</id><itemType>track</itemType>' +
        '<displayType>list</displayType><title>Canción 東京 🎧</title>' +
        '<summary>mix &amp; match</summary><mimeType>audio/flac</mimeType>' +
        '<trackMetadata><artistId>artist-日本</artistId>' +
        '<artist>Björk 東京</artist><albumId>album-日本</albumId>' +
        '<album>夜の Café</album><duration>245</duration>' +
        '<trackNumber>3</trackNumber><canPlay>true</canPlay>' +
        '<canSeek>true</canSeek></trackMetadata></mediaMetadata>' +
        '</searchResult></searchResponse></soap:Body></soap:Envelope>',
    );
    expectWellFormedXml(xml);
  });

  it("serializes an empty terminal page without media elements", () => {
    const xml = serializeSearchResponse({ index: 4, items: [], total: 4 });

    expect(xml).toBe(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
        '<soap:Body><searchResponse xmlns="http://www.sonos.com/Services/1.1">' +
        '<searchResult><index>4</index><count>0</count><total>4</total>' +
        '</searchResult></searchResponse></soap:Body></soap:Envelope>',
    );
    expectWellFormedXml(xml);
  });

  it("reuses media-list bounds and browse-item validation", () => {
    expect(() =>
      serializeSearchResponse({ index: 0, items: [], total: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      serializeSearchResponse({
        index: 0,
        items: [{ ...collection, id: "x".repeat(129) }],
        total: 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      serializeSearchResponse({
        index: 0,
        items: [{ ...track, kind: "unsupported" } as never],
        total: 1,
      }),
    ).toThrow(TypeError);
  });
});
