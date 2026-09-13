const CATALOG_REFRESH_INTERVAL_MILLISECONDS = 30_000;

/**
 * Returns the globally stable catalog version for one UTC epoch-time bucket.
 * The value depends only on the supplied clock reading; no isolate or durable
 * state participates in catalog invalidation.
 */
export function getCatalogRefreshToken(nowMilliseconds: number): string {
  if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0) {
    throw new RangeError(
      "Catalog refresh time must be a non-negative safe integer",
    );
  }

  return Math.floor(
    nowMilliseconds / CATALOG_REFRESH_INTERVAL_MILLISECONDS,
  ).toString(10);
}
