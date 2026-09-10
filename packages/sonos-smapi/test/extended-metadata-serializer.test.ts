import { describe, expect, it } from "vitest";
import { SaxesParser } from "saxes";

import {
  serializeGetExtendedMetadataResponse,
  type SonosBrowseCollection,
  type SonosBrowseTrack,
} from "../src";

function expectWellFormedXml(xml: string): void {
  expect(() => new SaxesParser({ xmlns: true }).write(xml).close()).not.toThrow();
}

describe("serializeGetExtendedMetadataResponse", () => {
  it("serializes one collection in exact WSDL order", () => {
    const collection: SonosBrowseCollection = {
      kind: "collection",
      id: "album-1",
      itemType: "album",
      title: "An Album",
      artist: "An Artist",
      artistId: "artist-1",
      canScroll: false,
      canPlay: false,
      canEnumerate: true,
      canAddToFavorites: false,
    };

    const xml = serializeGetExtendedMetadataResponse(collection);

    expect(xml).toBe(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
        '<soap:Body><getExtendedMetadataResponse xmlns="http://www.sonos.com/Services/1.1">' +
        '<getExtendedMetadataResult><mediaCollection>' +
        '<id>album-1</id><itemType>album</itemType><title>An Album</title>' +
        '<artist>An Artist</artist><artistId>artist-1</artistId>' +
        '<canScroll>false</canScroll><canPlay>false</canPlay>' +
        '<canEnumerate>true</canEnumerate><canAddToFavorites>false</canAddToFavorites>' +
        '</mediaCollection></getExtendedMetadataResult>' +
        '</getExtendedMetadataResponse></soap:Body></soap:Envelope>',
    );
    expectWellFormedXml(xml);
  });

  it("serializes one track with escaped metadata in exact WSDL order", () => {
    const track: SonosBrowseTrack = {
      kind: "track",
      id: "track-1",
      itemType: "track",
      title: "Track <one>",
      mimeType: "audio/flac",
      trackMetadata: {
        artistId: "artist-1",
        artist: "Artist & guest",
        albumId: "album-1",
        album: "Album one",
        duration: 181,
        canPlay: false,
        canSkip: false,
      },
    };

    const xml = serializeGetExtendedMetadataResponse(track);

    expect(xml).toContain(
      '<getExtendedMetadataResult><mediaMetadata><id>track-1</id>' +
        '<itemType>track</itemType><title>Track &lt;one&gt;</title>' +
        '<mimeType>audio/flac</mimeType><trackMetadata>' +
        '<artistId>artist-1</artistId><artist>Artist &amp; guest</artist>' +
        '<albumId>album-1</albumId><album>Album one</album>' +
        '<duration>181</duration><canPlay>false</canPlay>' +
        '<canSkip>false</canSkip></trackMetadata></mediaMetadata>' +
        '</getExtendedMetadataResult>',
    );
    expectWellFormedXml(xml);
  });

  it("rejects a missing or unsupported result item", () => {
    expect(() =>
      serializeGetExtendedMetadataResponse(undefined as never),
    ).toThrow(TypeError);
    expect(() =>
      serializeGetExtendedMetadataResponse({ kind: "stream" } as never),
    ).toThrow(TypeError);
  });
});
