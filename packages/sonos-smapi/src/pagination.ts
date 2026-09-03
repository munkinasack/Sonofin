export const SONOS_MAX_SIGNED_INT = 2_147_483_647;
export const SONOS_MAX_PAGE_COUNT = 100;

export interface SonosPagination {
  readonly index: number;
  readonly count: number;
}

export type SonosPaginationErrorCode = "invalid_index" | "invalid_count";

export class SonosPaginationError extends Error {
  readonly code: SonosPaginationErrorCode;

  constructor(code: SonosPaginationErrorCode) {
    super("Invalid Sonos pagination parameters");
    this.name = "SonosPaginationError";
    this.code = code;
  }
}

const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

function parseBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: SonosPaginationErrorCode,
): number {
  if (
    typeof value !== "string" ||
    !CANONICAL_UNSIGNED_DECIMAL.test(value)
  ) {
    throw new SonosPaginationError(code);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SonosPaginationError(code);
  }

  return parsed;
}

export function parseSonosPagination(
  index: unknown,
  count: unknown,
): SonosPagination {
  return Object.freeze({
    index: parseBoundedInteger(
      index,
      0,
      SONOS_MAX_SIGNED_INT,
      "invalid_index",
    ),
    count: parseBoundedInteger(
      count,
      1,
      SONOS_MAX_PAGE_COUNT,
      "invalid_count",
    ),
  });
}
