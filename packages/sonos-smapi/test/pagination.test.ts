import { describe, expect, it } from "vitest";

import {
  SONOS_MAX_PAGE_COUNT,
  SONOS_MAX_SIGNED_INT,
  SonosPaginationError,
  parseSonosPagination,
  type SonosPaginationErrorCode,
} from "../src";

function expectPaginationError(
  callback: () => unknown,
  code: SonosPaginationErrorCode,
): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(SonosPaginationError);
    expect(error).toMatchObject({
      code,
      message: "Invalid Sonos pagination parameters",
      name: "SonosPaginationError",
    });
    return;
  }

  throw new Error(`Expected SonosPaginationError with code ${code}`);
}

describe("parseSonosPagination", () => {
  it("parses the inclusive request boundaries", () => {
    const minimum = parseSonosPagination("0", "1");
    const maximum = parseSonosPagination(
      String(SONOS_MAX_SIGNED_INT),
      String(SONOS_MAX_PAGE_COUNT),
    );

    expect(minimum).toEqual({ index: 0, count: 1 });
    expect(maximum).toEqual({
      index: SONOS_MAX_SIGNED_INT,
      count: SONOS_MAX_PAGE_COUNT,
    });
    expect(Object.isFrozen(minimum)).toBe(true);
  });

  it.each([
    undefined,
    null,
    "",
    " ",
    " 1",
    "1 ",
    "+1",
    "-1",
    "00",
    "01",
    "1.0",
    "1e2",
    "0x10",
    String(SONOS_MAX_SIGNED_INT + 1),
  ])("rejects non-canonical or out-of-range index %j", (index) => {
    expectPaginationError(
      () => parseSonosPagination(index, "1"),
      "invalid_index",
    );
  });

  it.each([
    undefined,
    null,
    "",
    " ",
    " 1",
    "+1",
    "-1",
    "0",
    "01",
    "1.5",
    "1e2",
    String(SONOS_MAX_PAGE_COUNT + 1),
  ])("rejects non-canonical or out-of-range count %j", (count) => {
    expectPaginationError(
      () => parseSonosPagination("0", count),
      "invalid_count",
    );
  });
});
