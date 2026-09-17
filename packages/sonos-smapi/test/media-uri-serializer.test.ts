import { describe, expect, it } from "vitest";
import { SaxesParser } from "saxes";

import {
  serializeGetMediaURIResponse,
  type GetMediaURIResult,
} from "../src";

const TARGET: GetMediaURIResult = {
  url: "https://jellyfin.example/Audio/item/stream.mp3?static=true&mediaSourceId=source",
  httpHeaders: [
    {
      header: "Authorization",
      value: 'MediaBrowser Client="Sonofin & Co", Token="a<b>\'c"',
    },
  ],
};

describe("serializeGetMediaURIResponse", () => {
  it("emits the exact initial WSDL element order and XML-escapes URI and header data once", () => {
    const xml = serializeGetMediaURIResponse(TARGET);

    expect(xml).toBe(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
        '<soap:Body><getMediaURIResponse xmlns="http://www.sonos.com/Services/1.1">' +
        '<getMediaURIResult>https://jellyfin.example/Audio/item/stream.mp3?' +
        'static=true&amp;mediaSourceId=source</getMediaURIResult>' +
        '<httpHeaders><httpHeader><header>Authorization</header>' +
        '<value>MediaBrowser Client=&quot;Sonofin &amp; Co&quot;, ' +
        'Token=&quot;a&lt;b&gt;&apos;c&quot;</value>' +
        '</httpHeader></httpHeaders></getMediaURIResponse>' +
        '</soap:Body></soap:Envelope>',
    );
    expect(() => new SaxesParser({ xmlns: true }).write(xml).close()).not.toThrow();
  });

  it("rejects missing, non-HTTPS, and credential-bearing URLs", () => {
    expect(() => serializeGetMediaURIResponse(undefined as never)).toThrow(TypeError);
    for (const url of [
      "",
      "http://jellyfin.example/Audio/item/stream.mp3",
      "https://user:password@jellyfin.example/Audio/item/stream.mp3",
      "https://jellyfin.example/Audio/item/stream.mp3#fragment",
      "https://jellyfin.example/Audio/item/stream.mp3\r\nInjected: value",
      "https://jellyfin.example/Audio/item/stream.mp3\u2028Injected: value",
    ]) {
      expect(() => serializeGetMediaURIResponse({ ...TARGET, url })).toThrow(TypeError);
    }
  });

  it("permits only one safe Authorization header", () => {
    for (const httpHeaders of [
      [],
      [{ header: "Cookie", value: "session=secret" }],
      [
        { header: "Authorization", value: "MediaBrowser Token=one" },
        { header: "Authorization", value: "MediaBrowser Token=two" },
      ],
      [{ header: "Authorization", value: "line one\r\nInjected: value" }],
      [{ header: "Authorization", value: "line one\u0085Injected: value" }],
    ]) {
      expect(() =>
        serializeGetMediaURIResponse({ ...TARGET, httpHeaders } as never),
      ).toThrow(TypeError);
    }
  });
});
