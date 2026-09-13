import { describe, expect, it } from "vitest";

import { getCatalogRefreshToken } from "../src";

describe("getCatalogRefreshToken", () => {
  it("is deterministic throughout one 30-second UTC epoch bucket", () => {
    const bucketStart = Date.UTC(2026, 8, 12, 7, 45, 30);

    expect(getCatalogRefreshToken(bucketStart)).toBe(
      getCatalogRefreshToken(bucketStart + 29_999),
    );
    expect(getCatalogRefreshToken(bucketStart)).toMatch(/^[0-9]+$/u);
  });

  it("changes by one at the exact 30-second boundary", () => {
    const bucketStart = Date.UTC(2026, 8, 12, 7, 45, 30);
    const current = Number(getCatalogRefreshToken(bucketStart + 29_999));
    const next = Number(getCatalogRefreshToken(bucketStart + 30_000));

    expect(next).toBe(current + 1);
  });

  it.each([
    [
      "UTC minute",
      Date.UTC(2026, 8, 12, 7, 45, 59, 999),
      Date.UTC(2026, 8, 12, 7, 46),
    ],
    [
      "UTC day",
      Date.UTC(2026, 5, 30, 23, 59, 59, 999),
      Date.UTC(2026, 6, 1),
    ],
    [
      "UTC year",
      Date.UTC(2026, 11, 31, 23, 59, 59, 999),
      Date.UTC(2027, 0, 1),
    ],
  ] as const)("advances exactly once across a %s transition", (_name, before, after) => {
    const beforeToken = Number(getCatalogRefreshToken(before));
    const afterToken = Number(getCatalogRefreshToken(after));

    expect(afterToken).toBe(beforeToken + 1);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid clock reading (%s)",
    (nowMilliseconds) => {
      expect(() => getCatalogRefreshToken(nowMilliseconds)).toThrow(
        RangeError,
      );
    },
  );
});
