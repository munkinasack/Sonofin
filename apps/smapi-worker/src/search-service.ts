import {
  JellyfinClientError,
  type JellyfinPage,
  type JellyfinSearchResult,
} from "@sonofin/jellyfin-client";
import {
  parseSonosPagination,
  SonosPaginationError,
  type SearchResult,
  type SonosBrowseItem,
  type SonosPagination,
} from "@sonofin/sonos-smapi";

import type { SmapiAuthenticatedRequestContext } from "./authenticated-context";
import { formatJellyfinEntityAsSonosBrowseCollection } from "./browse-service";
import {
  SMAPI_SEARCH_CATEGORIES,
  type SmapiSearchCategory,
} from "./search-categories";
import { formatJellyfinTrackAsSonosBrowseTrack } from "./track-formatter";

const MAX_SEARCH_TERM_CHARACTERS = 512;
const SEARCH_CATEGORY_IDS = new Set<string>(
  SMAPI_SEARCH_CATEGORIES.map((category) => category.id),
);

export type SmapiSearchErrorCode = "invalid_parameters";

export class SmapiSearchError extends Error {
  readonly code: SmapiSearchErrorCode;

  constructor(code: SmapiSearchErrorCode) {
    super("The SMAPI search request could not be completed");
    this.name = "SmapiSearchError";
    this.code = code;
  }
}

export interface SmapiSearchRequest {
  readonly context: SmapiAuthenticatedRequestContext;
  readonly id: unknown;
  readonly term: unknown;
  readonly index: unknown;
  readonly count: unknown;
}

export interface SmapiSearchService {
  search(request: SmapiSearchRequest): Promise<SearchResult>;
}

function invalidParameters(): never {
  throw new SmapiSearchError("invalid_parameters");
}

function parseSearchCategory(value: unknown): SmapiSearchCategory {
  if (typeof value !== "string" || !SEARCH_CATEGORY_IDS.has(value)) {
    return invalidParameters();
  }

  return value as SmapiSearchCategory;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }

  return true;
}

function parseSearchTerm(value: unknown): string {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) {
    return invalidParameters();
  }

  const term = value.trim();
  if (
    term.length === 0 ||
    [...term].length > MAX_SEARCH_TERM_CHARACTERS
  ) {
    return invalidParameters();
  }

  return term;
}

function invalidJellyfinPage(): never {
  throw new JellyfinClientError("invalid_server_response");
}

function formatSearchItem(
  category: SmapiSearchCategory,
  item: JellyfinSearchResult,
): SonosBrowseItem {
  if (item.kind !== category) {
    return invalidJellyfinPage();
  }

  if (item.kind === "track") {
    return formatJellyfinTrackAsSonosBrowseTrack(item);
  }

  return formatJellyfinEntityAsSonosBrowseCollection(item);
}

function formatSearchPage(
  page: JellyfinPage<JellyfinSearchResult>,
  pagination: SonosPagination,
  category: SmapiSearchCategory,
): SearchResult {
  if (
    page.startIndex !== pagination.index ||
    page.items.length > pagination.count
  ) {
    return invalidJellyfinPage();
  }

  return Object.freeze({
    index: pagination.index,
    items: Object.freeze(
      page.items.map((item) => formatSearchItem(category, item)),
    ),
    total: page.totalRecordCount,
  });
}

export class SonofinSearchService implements SmapiSearchService {
  async search(request: SmapiSearchRequest): Promise<SearchResult> {
    const category = parseSearchCategory(request.id);
    const term = parseSearchTerm(request.term);
    let pagination: SonosPagination;
    try {
      pagination = parseSonosPagination(request.index, request.count);
    } catch (error) {
      if (error instanceof SonosPaginationError) {
        return invalidParameters();
      }
      throw error;
    }

    const page = await request.context.jellyfin.search(term, {
      category,
      limit: pagination.count,
      startIndex: pagination.index,
    });
    return formatSearchPage(page, pagination, category);
  }
}
