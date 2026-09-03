import { SaxesParser } from "saxes";

import { SMAPI_NAMESPACE, SOAP_ENVELOPE_NAMESPACE } from "./constants";
import { SoapRequestError } from "./errors";

const MAX_METHOD_NAME_LENGTH = 64;
const METHOD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SOAP_NEXT_ACTOR = "http://schemas.xmlsoap.org/soap/actor/next";

export interface ParsedSoapAction {
  action: string;
  method: string;
}

export interface ParsedLoginToken {
  readonly token?: string;
  readonly key?: string;
  readonly householdId?: string;
}

export interface ParsedCredentials {
  readonly loginToken?: ParsedLoginToken;
}

export interface ParsedSoapRequest extends ParsedSoapAction {
  readonly credentials?: ParsedCredentials;
  readonly parameters: Readonly<Record<string, string>>;
}

function removeOptionalWrapper(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("<") && value.endsWith(">"))
  ) {
    return value.slice(1, -1).trim();
  }

  return value;
}

export function parseSoapAction(headerValue: string | null): ParsedSoapAction {
  if (headerValue === null || headerValue.trim() === "") {
    throw new SoapRequestError("missing_action");
  }

  const action = removeOptionalWrapper(headerValue.trim());
  const expectedPrefix = `${SMAPI_NAMESPACE}#`;

  if (!action.startsWith(expectedPrefix)) {
    throw new SoapRequestError("invalid_action");
  }

  const method = action.slice(expectedPrefix.length);
  if (
    method.length === 0 ||
    method.length > MAX_METHOD_NAME_LENGTH ||
    !METHOD_NAME_PATTERN.test(method)
  ) {
    throw new SoapRequestError("invalid_action");
  }

  return { action, method };
}

interface ParsedSoapEnvelope {
  credentials?: ParsedCredentials;
  method: string;
  parameters: Readonly<Record<string, string>>;
}

const LOGIN_TOKEN_FIELDS = new Set(["token", "key", "householdId"]);

function parseSoapEnvelope(xml: string): ParsedSoapEnvelope {
  let depth = 0;
  let envelopeFound = false;
  let headerDepth: number | undefined;
  let headerFound = false;
  let credentialsDepth: number | undefined;
  let credentialsSeen = false;
  let credentialsFound = false;
  let loginTokenDepth: number | undefined;
  let loginTokenFound = false;
  let loginTokenFieldDepth: number | undefined;
  let loginTokenFieldName: string | undefined;
  let loginTokenFieldText = "";
  const loginTokenFields = new Map<string, string>();
  let bodyDepth: number | undefined;
  let bodyFound = false;
  let methodDepth: number | undefined;
  let method: string | undefined;
  let parameterDepth: number | undefined;
  let parameterName: string | undefined;
  let parameterText = "";
  const parameters = new Map<string, string>();

  try {
    const parser = new SaxesParser({ xmlns: true });

    parser.on("doctype", () => {
      throw new SoapRequestError("doctype_not_allowed");
    });

    parser.on("processinginstruction", () => {
      throw new SoapRequestError("malformed_xml");
    });

    parser.on("xmldecl", (declaration) => {
      if (
        declaration.version !== "1.0" ||
        (declaration.encoding !== undefined &&
          declaration.encoding.toLowerCase() !== "utf-8")
      ) {
        throw new SoapRequestError("malformed_xml");
      }
    });

    parser.on("opentag", (tag) => {
      depth += 1;

      if (depth === 1) {
        if (
          tag.local === "Envelope" &&
          tag.uri !== SOAP_ENVELOPE_NAMESPACE
        ) {
          throw new SoapRequestError("version_mismatch");
        }

        if (
          tag.local !== "Envelope" ||
          tag.uri !== SOAP_ENVELOPE_NAMESPACE
        ) {
          throw new SoapRequestError("invalid_envelope");
        }

        envelopeFound = true;
        return;
      }

      if (depth === 2) {
        if (
          tag.local === "Header" &&
          tag.uri === SOAP_ENVELOPE_NAMESPACE
        ) {
          if (headerFound || bodyFound) {
            throw new SoapRequestError("invalid_envelope");
          }

          headerFound = true;
          headerDepth = depth;
          return;
        }

        if (
          tag.local === "Body" &&
          tag.uri === SOAP_ENVELOPE_NAMESPACE
        ) {
          if (bodyFound) {
            throw new SoapRequestError("multiple_bodies");
          }

          bodyFound = true;
          bodyDepth = depth;
          return;
        }

        if (
          bodyFound &&
          tag.uri !== "" &&
          tag.uri !== SOAP_ENVELOPE_NAMESPACE
        ) {
          return;
        }

        throw new SoapRequestError("invalid_envelope");
      }

      if (headerDepth !== undefined && depth === headerDepth + 1) {
        if (tag.uri === "") {
          throw new SoapRequestError("invalid_envelope");
        }

        const attributes = Object.values(tag.attributes);
        const mustUnderstand = attributes.find(
          (attribute) =>
            attribute.local === "mustUnderstand" &&
            attribute.uri === SOAP_ENVELOPE_NAMESPACE,
        )?.value;
        const actor = attributes.find(
          (attribute) =>
            attribute.local === "actor" &&
            attribute.uri === SOAP_ENVELOPE_NAMESPACE,
        )?.value;

        if (
          mustUnderstand !== undefined &&
          mustUnderstand !== "0" &&
          mustUnderstand !== "1"
        ) {
          throw new SoapRequestError("malformed_xml");
        }

        const targetsThisNode =
          actor === undefined || actor === SOAP_NEXT_ACTOR;
        const isCredentials =
          tag.local === "credentials" && tag.uri === SMAPI_NAMESPACE;

        if (isCredentials) {
          if (!targetsThisNode) {
            return;
          }

          if (credentialsSeen) {
            throw new SoapRequestError("invalid_credentials");
          }

          credentialsSeen = true;
          credentialsFound = true;
          credentialsDepth = depth;
          return;
        }

        if (mustUnderstand === "1" && targetsThisNode) {
          throw new SoapRequestError("must_understand");
        }

        return;
      }

      if (credentialsDepth !== undefined) {
        if (
          loginTokenFieldDepth !== undefined &&
          depth > loginTokenFieldDepth
        ) {
          throw new SoapRequestError("invalid_credentials");
        }

        if (
          loginTokenDepth !== undefined &&
          depth === loginTokenDepth + 1
        ) {
          if (
            tag.uri !== SMAPI_NAMESPACE ||
            !LOGIN_TOKEN_FIELDS.has(tag.local) ||
            loginTokenFields.has(tag.local)
          ) {
            throw new SoapRequestError("invalid_credentials");
          }

          loginTokenFieldDepth = depth;
          loginTokenFieldName = tag.local;
          loginTokenFieldText = "";
          return;
        }

        if (depth === credentialsDepth + 1) {
          if (tag.local === "loginToken") {
            if (tag.uri !== SMAPI_NAMESPACE || loginTokenFound) {
              throw new SoapRequestError("invalid_credentials");
            }

            loginTokenFound = true;
            loginTokenDepth = depth;
          }

          // Other credentials children contain device/context information that
          // this parser deliberately does not consume.
          return;
        }

        // Descendants of ignored credentials children remain opaque. Only a
        // direct loginToken child is authentication input.
        return;
      }

      if (bodyDepth !== undefined && depth === bodyDepth + 1) {
        if (method !== undefined) {
          throw new SoapRequestError("multiple_methods");
        }

        if (tag.uri !== SMAPI_NAMESPACE) {
          throw new SoapRequestError("invalid_method_namespace");
        }

        method = tag.local;
        methodDepth = depth;
        return;
      }

      if (methodDepth !== undefined && depth === methodDepth + 1) {
        if (tag.uri !== SMAPI_NAMESPACE || parameters.has(tag.local)) {
          throw new SoapRequestError("invalid_parameter");
        }

        parameterDepth = depth;
        parameterName = tag.local;
        parameterText = "";
        return;
      }

      if (parameterDepth !== undefined && depth > parameterDepth) {
        throw new SoapRequestError("invalid_parameter");
      }
    });

    parser.on("closetag", () => {
      if (
        loginTokenFieldDepth !== undefined &&
        depth === loginTokenFieldDepth
      ) {
        if (loginTokenFieldName === undefined) {
          throw new SoapRequestError("malformed_xml");
        }

        loginTokenFields.set(loginTokenFieldName, loginTokenFieldText);
        loginTokenFieldDepth = undefined;
        loginTokenFieldName = undefined;
        loginTokenFieldText = "";
      }

      if (loginTokenDepth !== undefined && depth === loginTokenDepth) {
        loginTokenDepth = undefined;
      }

      if (credentialsDepth !== undefined && depth === credentialsDepth) {
        credentialsDepth = undefined;
      }

      if (parameterDepth !== undefined && depth === parameterDepth) {
        if (parameterName === undefined) {
          throw new SoapRequestError("malformed_xml");
        }

        parameters.set(parameterName, parameterText);
        parameterDepth = undefined;
        parameterName = undefined;
        parameterText = "";
      }

      if (methodDepth !== undefined && depth === methodDepth) {
        methodDepth = undefined;
      }

      if (headerDepth !== undefined && depth === headerDepth) {
        headerDepth = undefined;
      }

      if (bodyDepth !== undefined && depth === bodyDepth) {
        bodyDepth = undefined;
      }

      depth -= 1;
    });

    parser.on("text", (text) => {
      if (
        loginTokenFieldDepth !== undefined &&
        depth === loginTokenFieldDepth
      ) {
        loginTokenFieldText += text;
        return;
      }

      if (parameterDepth !== undefined && depth === parameterDepth) {
        parameterText += text;
        return;
      }

      if (text.trim() === "") {
        return;
      }

      if (
        credentialsDepth !== undefined &&
        (depth === credentialsDepth || depth === loginTokenDepth)
      ) {
        throw new SoapRequestError("invalid_credentials");
      }

      if (
        depth === 1 ||
        (headerDepth !== undefined && depth === headerDepth) ||
        (bodyDepth !== undefined && depth === bodyDepth) ||
        (methodDepth !== undefined && depth === methodDepth)
      ) {
        throw new SoapRequestError(
          methodDepth !== undefined && depth === methodDepth
            ? "invalid_parameter"
            : "malformed_xml",
        );
      }
    });

    parser.on("cdata", (text) => {
      if (
        loginTokenFieldDepth !== undefined &&
        depth === loginTokenFieldDepth
      ) {
        loginTokenFieldText += text;
        return;
      }

      if (parameterDepth !== undefined && depth === parameterDepth) {
        parameterText += text;
        return;
      }

      if (
        credentialsDepth !== undefined &&
        (depth === credentialsDepth || depth === loginTokenDepth)
      ) {
        throw new SoapRequestError("invalid_credentials");
      }

      if (
        depth === 1 ||
        (headerDepth !== undefined && depth === headerDepth) ||
        (bodyDepth !== undefined && depth === bodyDepth) ||
        (methodDepth !== undefined && depth === methodDepth)
      ) {
        throw new SoapRequestError(
          methodDepth !== undefined && depth === methodDepth
            ? "invalid_parameter"
            : "malformed_xml",
        );
      }
    });

    parser.write(xml).close();
  } catch (error) {
    if (error instanceof SoapRequestError) {
      throw error;
    }

    throw new SoapRequestError("malformed_xml");
  }

  if (!envelopeFound) {
    throw new SoapRequestError("invalid_envelope");
  }

  if (!bodyFound) {
    throw new SoapRequestError("missing_body");
  }

  if (method === undefined) {
    throw new SoapRequestError("missing_method");
  }

  const loginToken: ParsedLoginToken | undefined = loginTokenFound
    ? Object.freeze({
        ...(loginTokenFields.has("token")
          ? { token: loginTokenFields.get("token") as string }
          : {}),
        ...(loginTokenFields.has("key")
          ? { key: loginTokenFields.get("key") as string }
          : {}),
        ...(loginTokenFields.has("householdId")
          ? { householdId: loginTokenFields.get("householdId") as string }
          : {}),
      })
    : undefined;
  const credentials: ParsedCredentials | undefined = credentialsFound
    ? Object.freeze({
        ...(loginToken === undefined ? {} : { loginToken }),
      })
    : undefined;

  return {
    ...(credentials === undefined ? {} : { credentials }),
    method,
    parameters: Object.freeze(Object.fromEntries(parameters)),
  };
}

export function parseSoapRequest(
  xml: string,
  soapActionHeader: string | null,
): ParsedSoapRequest {
  const action = parseSoapAction(soapActionHeader);
  const envelope = parseSoapEnvelope(xml);

  if (action.method !== envelope.method) {
    throw new SoapRequestError("action_body_mismatch");
  }

  return { ...action, ...envelope };
}
