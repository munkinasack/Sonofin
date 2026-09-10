import { describe, expect, it } from "vitest";
import { SaxesParser } from "saxes";

import {
  serializeGetMediaMetadataResponse,
  type SonosBrowseTrack,
} from "../src";

function expectWellFormedXml(xml: string): void {
  expect(() => new SaxesParser({ xmlns: true }).write(xml).close()).not.toThrow();
}

describe("serializeGetMediaMetadataResponse", () => {
  it("serializes track fields directly in getMediaMetadataResult in exact WSDL order", () => {
    const track: SonosBrowseTrack = {
      id: "track-1",
      itemType: "track",
      kind: "track",
      mimeType: "audio/flac",
      title: "Track <one>",
      trackMetadata: {
        album: "Album one",
        albumId: "album-1",
        artist: "Artist & guest",
        artistId: "artist-1",
        canPlay: false,
        canSkip: false,
        duration: 181,
      },
    };

    const xml = serializeGetMediaMetadataResponse(track);

    expect(xml).toBe(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
        '<soap:Body><getMediaMetadataResponse xmlns="http://www.sonos.com/Services/1.1">' +
        '<getMediaMetadataResult><id>track-1</id><itemType>track</itemType>' +
        '<title>Track &lt;one&gt;</title><mimeType>audio/flac</mimeType>' +
        '<trackMetadata><artistId>artist-1</artistId>' +
        '<artist>Artist &amp; guest</artist><albumId>album-1</albumId>' +
        '<album>Album one</album><duration>181</duration>' +
        '<canPlay>false</canPlay><canSkip>false</canSkip>' +
        '</trackMetadata></getMediaMetadataResult>' +
        '</getMediaMetadataResponse></soap:Body></soap:Envelope>',
    );
    expect(xml).not.toContain("<mediaMetadata>");
    expectWellFormedXml(xml);
  });

  it("rejects a missing or non-track result", () => {
    expect(() =>
      serializeGetMediaMetadataResponse(undefined as never),
    ).toThrow(TypeError);
    expect(() =>
      serializeGetMediaMetadataResponse({ kind: "collection" } as never),
    ).toThrow(TypeError);
  });
});
