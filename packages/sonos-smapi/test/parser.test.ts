import { describe, expect, it } from "vitest";

import {
  parseSoapAction,
  parseSoapRequest,
  SoapRequestError,
} from "../src";

const getLastUpdateRequest = `
  <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
    <s:Body>
      <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
    </s:Body>
  </s:Envelope>
`;

function expectSoapError(
  callback: () => unknown,
  code: SoapRequestError["code"],
): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(SoapRequestError);
    expect((error as SoapRequestError).code).toBe(code);
    return;
  }

  throw new Error(`Expected SoapRequestError with code ${code}`);
}

describe("parseSoapAction", () => {
  it.each([
    '"http://www.sonos.com/Services/1.1#getLastUpdate"',
    "'http://www.sonos.com/Services/1.1#getLastUpdate'",
    "<http://www.sonos.com/Services/1.1#getLastUpdate>",
    "http://www.sonos.com/Services/1.1#getLastUpdate",
  ])("parses supported SOAPAction wrappers", (header) => {
    expect(parseSoapAction(header)).toEqual({
      action: "http://www.sonos.com/Services/1.1#getLastUpdate",
      method: "getLastUpdate",
    });
  });

  it.each([
    null,
    "",
    '"https://www.sonos.com/Services/1.1#getLastUpdate"',
    '"http://www.sonos.com/Services/1.1#bad method"',
  ])("rejects a missing or invalid SOAPAction", (header) => {
    expect(() => parseSoapAction(header)).toThrow(SoapRequestError);
  });
});

describe("parseSoapRequest", () => {
  it("identifies getLastUpdate independently of XML prefixes", () => {
    expect(
      parseSoapRequest(
        getLastUpdateRequest,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ),
    ).toEqual({
      action: "http://www.sonos.com/Services/1.1#getLastUpdate",
      method: "getLastUpdate",
      parameters: {},
    });
  });

  it("identifies getAppLink with a qualified operation prefix", () => {
    const request = `<?xml version="1.0" encoding="utf-8"?>
      <soapenv:Envelope
        xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:smapi="http://www.sonos.com/Services/1.1"
      >
        <soapenv:Header><smapi:credentials /></soapenv:Header>
        <soapenv:Body>
          <smapi:getAppLink>
            <smapi:householdId>household</smapi:householdId>
          </smapi:getAppLink>
        </soapenv:Body>
      </soapenv:Envelope>
    `;

    expect(
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getAppLink"',
      ),
    ).toEqual({
      action: "http://www.sonos.com/Services/1.1#getAppLink",
      credentials: {},
      method: "getAppLink",
      parameters: { householdId: "household" },
    });
  });

  it("extracts exact prefixed Sonos login credentials", () => {
    const request = `
      <s:Envelope
        xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:smapi="http://www.sonos.com/Services/1.1"
      >
        <s:Header>
          <smapi:credentials>
            <smapi:deviceId>ignored-device</smapi:deviceId>
            <smapi:deviceProvider>Sonos</smapi:deviceProvider>
            <smapi:loginToken>
              <smapi:token> SF_Exact&amp;Case </smapi:token>
              <smapi:key>refresh<![CDATA[-key]]></smapi:key>
              <smapi:householdId>Sonos_HH_CaseSensitive</smapi:householdId>
            </smapi:loginToken>
          </smapi:credentials>
        </s:Header>
        <s:Body><smapi:getLastUpdate /></s:Body>
      </s:Envelope>
    `;

    const parsed = parseSoapRequest(
      request,
      '"http://www.sonos.com/Services/1.1#getLastUpdate"',
    );

    expect(parsed.credentials).toEqual({
      loginToken: {
        token: " SF_Exact&Case ",
        key: "refresh-key",
        householdId: "Sonos_HH_CaseSensitive",
      },
    });
    expect(Object.isFrozen(parsed.credentials)).toBe(true);
    expect(Object.isFrozen(parsed.credentials?.loginToken)).toBe(true);
  });

  it("extracts partial default-namespace credentials and allows optional headers", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Header>
          <trace xmlns="urn:example:trace"><id>ignored</id></trace>
          <credentials xmlns="http://www.sonos.com/Services/1.1">
            <loginToken><token>token-only</token></loginToken>
          </credentials>
          <context xmlns="http://www.sonos.com/Services/1.1">
            <timeZone>-04:00</timeZone>
          </context>
        </s:Header>
        <s:Body>
          <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
        </s:Body>
      </s:Envelope>
    `;

    expect(
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ).credentials,
    ).toEqual({ loginToken: { token: "token-only" } });
  });

  it("keeps absent and empty login credential fields optional", () => {
    const emptyCredentials = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Header>
          <credentials xmlns="http://www.sonos.com/Services/1.1">
            <loginToken><key>key-only</key></loginToken>
          </credentials>
        </s:Header>
        <s:Body>
          <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
        </s:Body>
      </s:Envelope>
    `;

    expect(
      parseSoapRequest(
        getLastUpdateRequest,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ).credentials,
    ).toBeUndefined();
    expect(
      parseSoapRequest(
        emptyCredentials,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ).credentials,
    ).toEqual({ loginToken: { key: "key-only" } });
  });

  it.each([
    [
      "duplicate credentials",
      `<smapi:credentials /><smapi:credentials />`,
    ],
    [
      "duplicate loginToken",
      `<smapi:credentials><smapi:loginToken /><smapi:loginToken /></smapi:credentials>`,
    ],
    [
      "duplicate login field",
      `<smapi:credentials><smapi:loginToken><smapi:token>one</smapi:token><smapi:token>two</smapi:token></smapi:loginToken></smapi:credentials>`,
    ],
    [
      "nested login field markup",
      `<smapi:credentials><smapi:loginToken><smapi:token><smapi:value>nested</smapi:value></smapi:token></smapi:loginToken></smapi:credentials>`,
    ],
    [
      "foreign login field namespace",
      `<smapi:credentials><smapi:loginToken><other:token>token</other:token></smapi:loginToken></smapi:credentials>`,
    ],
    [
      "foreign loginToken namespace",
      `<smapi:credentials><other:loginToken /></smapi:credentials>`,
    ],
  ])("rejects %s without exposing its contents", (_name, header) => {
    const request = `
      <s:Envelope
        xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:smapi="http://www.sonos.com/Services/1.1"
        xmlns:other="urn:example:other"
      >
        <s:Header>${header}</s:Header>
        <s:Body><smapi:getLastUpdate /></s:Body>
      </s:Envelope>
    `;

    expectSoapError(
      () =>
        parseSoapRequest(
          request,
          '"http://www.sonos.com/Services/1.1#getLastUpdate"',
        ),
      "invalid_credentials",
    );
  });

  it("parses credentials without changing body parameter handling", () => {
    const request = `
      <s:Envelope
        xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:smapi="http://www.sonos.com/Services/1.1"
      >
        <s:Header>
          <smapi:credentials>
            <smapi:loginToken>
              <smapi:token>auth-token</smapi:token>
              <smapi:householdId>HH</smapi:householdId>
            </smapi:loginToken>
          </smapi:credentials>
        </s:Header>
        <s:Body>
          <smapi:getDeviceAuthToken>
            <smapi:householdId>Body-HH</smapi:householdId>
            <smapi:linkCode>body-code</smapi:linkCode>
          </smapi:getDeviceAuthToken>
        </s:Body>
      </s:Envelope>
    `;

    const parsed = parseSoapRequest(
      request,
      '"http://www.sonos.com/Services/1.1#getDeviceAuthToken"',
    );
    expect(parsed.credentials?.loginToken?.householdId).toBe("HH");
    expect(parsed.parameters).toEqual({
      householdId: "Body-HH",
      linkCode: "body-code",
    });
  });

  it("extracts decoded, direct SMAPI scalar parameters", () => {
    const request = `
      <s:Envelope
        xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:smapi="http://www.sonos.com/Services/1.1"
      >
        <s:Body>
          <smapi:getDeviceAuthToken>
            <smapi:householdId>Sonos_123&amp;456</smapi:householdId>
            <smapi:linkCode>ABC<![CDATA[-123]]></smapi:linkCode>
            <smapi:linkDeviceId>device-1</smapi:linkDeviceId>
          </smapi:getDeviceAuthToken>
        </s:Body>
      </s:Envelope>
    `;

    const parsed = parseSoapRequest(
      request,
      '"http://www.sonos.com/Services/1.1#getDeviceAuthToken"',
    );

    expect(parsed.parameters).toEqual({
      householdId: "Sonos_123&456",
      linkCode: "ABC-123",
      linkDeviceId: "device-1",
    });
    expect(Object.isFrozen(parsed.parameters)).toBe(true);
  });

  it("preserves scalar parameter whitespace for method-specific validation", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body>
          <getAppLink xmlns="http://www.sonos.com/Services/1.1">
            <householdId> household </householdId>
          </getAppLink>
        </s:Body>
      </s:Envelope>
    `;

    expect(
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getAppLink"',
      ).parameters.householdId,
    ).toBe(" household ");
  });

  it("rejects malformed XML", () => {
    expect(() =>
      parseSoapRequest(
        "<not-closed>",
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ),
    ).toThrow(SoapRequestError);
  });

  it("rejects a non-SOAP envelope", () => {
    expect(() =>
      parseSoapRequest(
        '<Envelope><Body><getLastUpdate /></Body></Envelope>',
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ),
    ).toThrow(SoapRequestError);
  });

  it("rejects a method outside the Sonos namespace", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body><getLastUpdate /></s:Body>
      </s:Envelope>
    `;

    expect(() =>
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ),
    ).toThrow(SoapRequestError);
  });

  it("rejects a SOAPAction and body mismatch", () => {
    expect(() =>
      parseSoapRequest(
        getLastUpdateRequest,
        '"http://www.sonos.com/Services/1.1#getAppLink"',
      ),
    ).toThrow(SoapRequestError);
  });

  it("rejects multiple operations in the SOAP body", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body>
          <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
          <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
        </s:Body>
      </s:Envelope>
    `;

    expect(() =>
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ),
    ).toThrow(SoapRequestError);
  });

  it("does not treat elements after the SOAP body as operations", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body />
        <outside>
          <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
        </outside>
      </s:Envelope>
    `;

    expect(() =>
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ),
    ).toThrow(SoapRequestError);
  });

  it("rejects SOAP headers that appear after the body", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body>
          <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
        </s:Body>
        <s:Header />
      </s:Envelope>
    `;

    expect(() =>
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ),
    ).toThrow(SoapRequestError);
  });

  it("accepts namespace-qualified SOAP extensions after the body", () => {
    const request = `
      <s:Envelope
        xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:extension="urn:example:extension"
      >
        <s:Body>
          <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
        </s:Body>
        <extension:trace />
      </s:Envelope>
    `;

    expect(
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ).method,
    ).toBe("getLastUpdate");
  });

  it("rejects unqualified SOAP header entries", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Header><credentials /></s:Header>
        <s:Body>
          <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
        </s:Body>
      </s:Envelope>
    `;

    expect(() =>
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ),
    ).toThrow(SoapRequestError);
  });

  it("processes a recognized mandatory credentials header", () => {
    const request = `
      <s:Envelope
        xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:smapi="http://www.sonos.com/Services/1.1"
      >
        <s:Header>
          <smapi:credentials s:mustUnderstand="1" />
        </s:Header>
        <s:Body><smapi:getLastUpdate /></s:Body>
      </s:Envelope>
    `;

    expect(
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ).credentials,
    ).toEqual({});
  });

  it("rejects an unknown mandatory SOAP header targeted at this service", () => {
    const request = `
      <s:Envelope
        xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:smapi="http://www.sonos.com/Services/1.1"
      >
        <s:Header>
          <smapi:extension s:mustUnderstand="1" />
        </s:Header>
        <s:Body><smapi:getLastUpdate /></s:Body>
      </s:Envelope>
    `;

    expectSoapError(
      () =>
        parseSoapRequest(
          request,
          '"http://www.sonos.com/Services/1.1#getLastUpdate"',
        ),
      "must_understand",
    );
  });

  it("ignores mandatory headers explicitly targeted at another actor", () => {
    const request = `
      <s:Envelope
        xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:smapi="http://www.sonos.com/Services/1.1"
      >
        <s:Header>
          <smapi:extension
            s:actor="urn:example:another-actor"
            s:mustUnderstand="1"
          />
        </s:Header>
        <s:Body><smapi:getLastUpdate /></s:Body>
      </s:Envelope>
    `;

    expect(
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ).method,
    ).toBe("getLastUpdate");
  });

  it.each(["other-first", "local-first"])(
    "extracts local credentials when actor-targeted credentials are %s",
    (order) => {
      const other =
        '<smapi:credentials s:actor="urn:example:another-actor" ' +
        's:mustUnderstand="1"><smapi:opaque /></smapi:credentials>';
      const local =
        "<smapi:credentials><smapi:loginToken>" +
        "<smapi:token>local-token</smapi:token>" +
        "<smapi:householdId>Local-HH</smapi:householdId>" +
        "</smapi:loginToken></smapi:credentials>";
      const headers =
        order === "other-first" ? `${other}${local}` : `${local}${other}`;
      const request = `
        <s:Envelope
          xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
          xmlns:smapi="http://www.sonos.com/Services/1.1"
        >
          <s:Header>${headers}</s:Header>
          <s:Body><smapi:getLastUpdate /></s:Body>
        </s:Envelope>
      `;

      expect(
        parseSoapRequest(
          request,
          '"http://www.sonos.com/Services/1.1#getLastUpdate"',
        ).credentials,
      ).toEqual({
        loginToken: {
          householdId: "Local-HH",
          token: "local-token",
        },
      });
    },
  );

  it("accepts SOAP 1.1 mustUnderstand=0", () => {
    const request = `
      <s:Envelope
        xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:smapi="http://www.sonos.com/Services/1.1"
      >
        <s:Header>
          <smapi:credentials s:mustUnderstand="0" />
        </s:Header>
        <s:Body><smapi:getLastUpdate /></s:Body>
      </s:Envelope>
    `;

    expect(
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ).method,
    ).toBe("getLastUpdate");
  });

  it.each(["true", "false", "yes"])(
    "rejects non-SOAP-1.1 mustUnderstand value %s",
    (mustUnderstand) => {
      const request = `
        <s:Envelope
          xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
          xmlns:smapi="http://www.sonos.com/Services/1.1"
        >
          <s:Header>
            <smapi:credentials s:mustUnderstand="${mustUnderstand}" />
          </s:Header>
          <s:Body><smapi:getLastUpdate /></s:Body>
        </s:Envelope>
      `;

      expectSoapError(
        () =>
          parseSoapRequest(
            request,
            '"http://www.sonos.com/Services/1.1#getLastUpdate"',
          ),
        "malformed_xml",
      );
    },
  );

  it("rejects duplicate method parameters", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body>
          <getAppLink xmlns="http://www.sonos.com/Services/1.1">
            <householdId>first</householdId>
            <householdId>second</householdId>
          </getAppLink>
        </s:Body>
      </s:Envelope>
    `;

    expectSoapError(
      () =>
        parseSoapRequest(
          request,
          '"http://www.sonos.com/Services/1.1#getAppLink"',
        ),
      "invalid_parameter",
    );
  });

  it("rejects nested markup in scalar method parameters", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body>
          <getAppLink xmlns="http://www.sonos.com/Services/1.1">
            <householdId><value>nested</value></householdId>
          </getAppLink>
        </s:Body>
      </s:Envelope>
    `;

    expectSoapError(
      () =>
        parseSoapRequest(
          request,
          '"http://www.sonos.com/Services/1.1#getAppLink"',
        ),
      "invalid_parameter",
    );
  });

  it("rejects method parameters from another namespace", () => {
    const request = `
      <s:Envelope
        xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:other="urn:example:other"
      >
        <s:Body>
          <getAppLink xmlns="http://www.sonos.com/Services/1.1">
            <other:householdId>household</other:householdId>
          </getAppLink>
        </s:Body>
      </s:Envelope>
    `;

    expectSoapError(
      () =>
        parseSoapRequest(
          request,
          '"http://www.sonos.com/Services/1.1#getAppLink"',
        ),
      "invalid_parameter",
    );
  });

  it("rejects non-whitespace text directly in a method", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body>
          <getAppLink xmlns="http://www.sonos.com/Services/1.1">
            invalid method content
            <householdId>household</householdId>
          </getAppLink>
        </s:Body>
      </s:Envelope>
    `;

    expectSoapError(
      () =>
        parseSoapRequest(
          request,
          '"http://www.sonos.com/Services/1.1#getAppLink"',
        ),
      "invalid_parameter",
    );
  });

  it("rejects XML-invalid scalar parameter text", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body>
          <getAppLink xmlns="http://www.sonos.com/Services/1.1">
            <householdId>invalid&#x0;text</householdId>
          </getAppLink>
        </s:Body>
      </s:Envelope>
    `;

    expectSoapError(
      () =>
        parseSoapRequest(
          request,
          '"http://www.sonos.com/Services/1.1#getAppLink"',
        ),
      "malformed_xml",
    );
  });

  it("rejects character data directly inside the SOAP envelope", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        invalid envelope content
        <s:Body>
          <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
        </s:Body>
      </s:Envelope>
    `;

    expect(() =>
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ),
    ).toThrow(SoapRequestError);
  });

  it("rejects XML versions other than 1.0", () => {
    const request = `<?xml version="1.1" encoding="utf-8"?>
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body>
          <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
        </s:Body>
      </s:Envelope>
    `;

    expectSoapError(
      () =>
        parseSoapRequest(
          request,
          '"http://www.sonos.com/Services/1.1#getLastUpdate"',
        ),
      "malformed_xml",
    );
  });

  it("rejects processing instructions in SOAP messages", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <?unsupported value?>
        <s:Body>
          <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
        </s:Body>
      </s:Envelope>
    `;

    expect(() =>
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ),
    ).toThrow(SoapRequestError);
  });

  it("rejects CDATA directly inside the SOAP body", () => {
    const request = `
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body>
          <![CDATA[not an operation]]>
          <getLastUpdate xmlns="http://www.sonos.com/Services/1.1" />
        </s:Body>
      </s:Envelope>
    `;

    expect(() =>
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ),
    ).toThrow(SoapRequestError);
  });

  it("rejects document type declarations", () => {
    const request = `
      <!DOCTYPE envelope>
      ${getLastUpdateRequest}
    `;

    expect(() =>
      parseSoapRequest(
        request,
        '"http://www.sonos.com/Services/1.1#getLastUpdate"',
      ),
    ).toThrow(SoapRequestError);
  });
});
