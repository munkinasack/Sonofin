export type SoapRequestErrorCode =
  | "action_body_mismatch"
  | "doctype_not_allowed"
  | "invalid_action"
  | "invalid_credentials"
  | "invalid_envelope"
  | "invalid_method_namespace"
  | "invalid_parameter"
  | "malformed_xml"
  | "missing_action"
  | "missing_body"
  | "missing_method"
  | "multiple_bodies"
  | "multiple_methods"
  | "must_understand"
  | "version_mismatch";

export class SoapRequestError extends Error {
  readonly code: SoapRequestErrorCode;

  constructor(code: SoapRequestErrorCode) {
    super("Invalid SOAP request");
    this.name = "SoapRequestError";
    this.code = code;
  }
}
