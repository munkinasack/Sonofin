import { describe, expect, it } from "vitest";
import { SaxesParser } from "saxes";

import {
  serializeGetAppLinkResponse,
  serializeGetDeviceAuthTokenResponse,
  serializeGetLastUpdateResponse,
  serializeSoapFault,
  type SoapFaultCode,
} from "../src";

function expectWellFormedXml(xml: string): void {
  expect(() => new SaxesParser({ xmlns: true }).write(xml).close()).not.toThrow();
}

describe("serializeGetLastUpdateResponse", () => {
  it("generates a SOAP 1.1 response in WSDL element order", () => {
    const xml = serializeGetLastUpdateResponse({
      catalog: "catalog-1",
      favorites: "favorites-1",
      pollInterval: 120,
    });

    expect(xml).toContain(
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
    );
    expect(xml).toContain(
      '<getLastUpdateResponse xmlns="http://www.sonos.com/Services/1.1">',
    );
    expect(xml.indexOf("<catalog>")).toBeLessThan(xml.indexOf("<favorites>"));
    expect(xml).toContain("<pollInterval>120</pollInterval>");
    expectWellFormedXml(xml);
  });

  it.each([29, 3601, 30.5])("rejects invalid poll intervals", (value) => {
    expect(() =>
      serializeGetLastUpdateResponse({
        catalog: "1",
        favorites: "1",
        pollInterval: value,
      }),
    ).toThrow(RangeError);
  });

  it("escapes dynamic text", () => {
    const xml = serializeGetLastUpdateResponse({
      catalog: "<catalog>&",
      favorites: 'favorites"',
    });

    expect(xml).toContain("<catalog>&lt;catalog&gt;&amp;</catalog>");
    expect(xml).toContain("<favorites>favorites&quot;</favorites>");
  });

  it.each(["invalid\u0000value", "unpaired\ud800surrogate"])(
    "rejects text that XML 1.0 cannot represent",
    (value) => {
      expect(() =>
        serializeGetLastUpdateResponse({
          catalog: value,
          favorites: "1",
        }),
      ).toThrow(TypeError);
    },
  );
});

describe("serializeGetAppLinkResponse", () => {
  it("generates the browser device-link response", () => {
    const xml = serializeGetAppLinkResponse({
      appUrlStringId: "SIGN_IN",
      linkCode: "TEST1",
      linkDeviceId: "DEVICE1",
      registrationUrl: "https://example.invalid/link?code=TEST1&source=sonos",
      showLinkCode: true,
    });

    expect(xml).toContain(
      '<getAppLinkResponse xmlns="http://www.sonos.com/Services/1.1">',
    );
    expect(xml).toContain("<authorizeAccount>");
    expect(xml).toContain("<appUrlStringId>SIGN_IN</appUrlStringId>");
    expect(xml).toContain(
      "<regUrl>https://example.invalid/link?code=TEST1&amp;source=sonos</regUrl>",
    );
    expect(xml).toContain("<linkDeviceId>DEVICE1</linkDeviceId>");
    expect(xml.indexOf("<linkCode>")).toBeLessThan(
      xml.indexOf("<linkDeviceId>"),
    );
    expect(xml.indexOf("<showLinkCode>")).toBeLessThan(
      xml.indexOf("<linkDeviceId>"),
    );
    expect(xml).toContain("<showLinkCode>true</showLinkCode>");
    expectWellFormedXml(xml);
  });

  it("rejects XML 1.0-forbidden characters in app-link values", () => {
    expect(() =>
      serializeGetAppLinkResponse({
        appUrlStringId: "SIGN_IN",
        linkCode: "TEST1",
        registrationUrl: "invalid\u0000url",
        showLinkCode: true,
      }),
    ).toThrow(TypeError);
  });

  it("omits linkDeviceId when it is not supplied", () => {
    const xml = serializeGetAppLinkResponse({
      appUrlStringId: "SIGN_IN",
      linkCode: "TEST1",
      registrationUrl: "https://example.invalid/link?code=TEST1",
      showLinkCode: false,
    });

    expect(xml).not.toContain("<linkDeviceId>");
    expectWellFormedXml(xml);
  });

  it("allows a 32-character link code", () => {
    expect(() =>
      serializeGetAppLinkResponse({
        appUrlStringId: "SIGN_IN",
        linkCode: "A".repeat(32),
        registrationUrl: "https://example.invalid/link",
        showLinkCode: false,
      }),
    ).not.toThrow();
  });

  it("rejects a link code longer than 32 characters", () => {
    expect(() =>
      serializeGetAppLinkResponse({
        appUrlStringId: "SIGN_IN",
        linkCode: "A".repeat(33),
        registrationUrl: "https://example.invalid/link",
        showLinkCode: false,
      }),
    ).toThrow(RangeError);
  });

  it("rejects an empty optional linkDeviceId", () => {
    expect(() =>
      serializeGetAppLinkResponse({
        appUrlStringId: "SIGN_IN",
        linkCode: "TEST1",
        linkDeviceId: " ",
        registrationUrl: "https://example.invalid/link",
        showLinkCode: false,
      }),
    ).toThrow(TypeError);
  });
});

describe("serializeGetDeviceAuthTokenResponse", () => {
  it("generates the token response in WSDL element order", () => {
    const xml = serializeGetDeviceAuthTokenResponse({
      authToken: "token<&",
      privateKey: 'key"',
    });

    expect(xml).toContain(
      '<getDeviceAuthTokenResponse xmlns="http://www.sonos.com/Services/1.1">',
    );
    expect(xml).toContain("<authToken>token&lt;&amp;</authToken>");
    expect(xml).toContain("<privateKey>key&quot;</privateKey>");
    expect(xml.indexOf("<authToken>")).toBeLessThan(
      xml.indexOf("<privateKey>"),
    );
    expectWellFormedXml(xml);
  });

  it.each([
    { authToken: "", privateKey: "key" },
    { authToken: "token", privateKey: "" },
  ])("rejects missing token response values", (result) => {
    expect(() => serializeGetDeviceAuthTokenResponse(result)).toThrow(
      TypeError,
    );
  });

  it.each([
    { authToken: "A".repeat(2049), privateKey: "key" },
    { authToken: "token", privateKey: "A".repeat(2049) },
  ])("rejects token response values over 2048 characters", (result) => {
    expect(() => serializeGetDeviceAuthTokenResponse(result)).toThrow(
      RangeError,
    );
  });

  it("rejects XML 1.0-forbidden token response values", () => {
    expect(() =>
      serializeGetDeviceAuthTokenResponse({
        authToken: "invalid\u0000token",
        privateKey: "key",
      }),
    ).toThrow(TypeError);
  });
});

describe("serializeSoapFault", () => {
  it("generates a generic, safely escaped Sonos fault", () => {
    const xml = serializeSoapFault("Unsupported <request>");

    expect(xml).toContain("<soap:Fault>");
    expect(xml).toContain(
      "<faultcode>Server.ServiceUnknownError</faultcode>",
    );
    expect(xml).toContain(
      "<faultstring>Unsupported &lt;request&gt;</faultstring>",
    );
    expectWellFormedXml(xml);
  });

  it("rejects XML 1.0-forbidden characters in fault strings", () => {
    expect(() => serializeSoapFault("invalid\u0000fault")).toThrow(TypeError);
  });

  it("rejects fault codes outside the Sonos contract", () => {
    expect(() =>
      serializeSoapFault("Invalid request", "not a qname" as SoapFaultCode),
    ).toThrow(TypeError);
  });

  it.each([
    ["Client.NOT_LINKED_RETRY", 5, "Retry token request."],
    ["Client.NOT_LINKED_FAILURE", 6, "Restart authentication."],
  ] as const)(
    "generates qualified detail for %s",
    (faultCode, sonosError, exceptionInfo) => {
      const xml = serializeSoapFault("Link is not ready", faultCode, {
        exceptionInfo,
        sonosError,
      });

      expect(xml).toContain(
        '<detail xmlns:smapi="http://www.sonos.com/Services/1.1">',
      );
      expect(xml).toContain(
        `<smapi:ExceptionInfo>${exceptionInfo}</smapi:ExceptionInfo>`,
      );
      expect(xml).toContain(
        `<smapi:SonosError>${sonosError}</smapi:SonosError>`,
      );
      expect(xml.indexOf("<smapi:ExceptionInfo>")).toBeLessThan(
        xml.indexOf("<smapi:SonosError>"),
      );
      expectWellFormedXml(xml);
    },
  );

  it.each([
    ["Client.NOT_LINKED_RETRY", 6],
    ["Client.NOT_LINKED_FAILURE", 5],
  ] as const)("rejects the wrong SonosError for %s", (faultCode, sonosError) => {
    expect(() =>
      serializeSoapFault("Invalid link", faultCode, {
        exceptionInfo: "Invalid link",
        sonosError,
      }),
    ).toThrow(RangeError);
  });

  it.each([
    "Client.NOT_LINKED_RETRY",
    "Client.NOT_LINKED_FAILURE",
  ] as const)("requires detail for %s", (faultCode) => {
    expect(() => serializeSoapFault("Invalid link", faultCode)).toThrow(
      TypeError,
    );
  });

  it.each([-1, 1.5, 1000])("rejects invalid SonosError %s", (sonosError) => {
    expect(() =>
      serializeSoapFault("Invalid request", "soap:Client", {
        exceptionInfo: "Invalid request",
        sonosError,
      }),
    ).toThrow(RangeError);
  });

  it("escapes qualified fault detail", () => {
    const xml = serializeSoapFault("Invalid request", "soap:Client", {
      exceptionInfo: "Retry <later>&",
      sonosError: 12,
    });

    expect(xml).toContain(
      "<smapi:ExceptionInfo>Retry &lt;later&gt;&amp;</smapi:ExceptionInfo>",
    );
    expectWellFormedXml(xml);
  });
});
