import {
  decodeSonosContentId,
  SonosContentIdError,
  type GetExtendedMetadataResult,
} from "@sonofin/sonos-smapi";

import type { SmapiAuthenticatedRequestContext } from "./authenticated-context";
import {
  formatJellyfinEntityAsSonosBrowseCollection,
  getStaticSonosBrowseCollection,
  SmapiBrowseError,
} from "./browse-service";
import { formatJellyfinTrackAsSonosBrowseTrack } from "./track-formatter";

export interface SmapiGetExtendedMetadataRequest {
  readonly context: SmapiAuthenticatedRequestContext;
  readonly id: unknown;
}

export interface SmapiExtendedMetadataService {
  getExtendedMetadata(
    request: SmapiGetExtendedMetadataRequest,
  ): Promise<GetExtendedMetadataResult>;
}

export class SonofinExtendedMetadataService
  implements SmapiExtendedMetadataService
{
  async getExtendedMetadata(
    request: SmapiGetExtendedMetadataRequest,
  ): Promise<GetExtendedMetadataResult> {
    let contentId;
    try {
      contentId = decodeSonosContentId(request.id);
    } catch (error) {
      if (error instanceof SonosContentIdError) {
        throw new SmapiBrowseError("invalid_parameters");
      }
      throw error;
    }

    const staticCollection = getStaticSonosBrowseCollection(contentId);
    if (staticCollection !== undefined) {
      return staticCollection;
    }
    if (contentId.kind === "root" || contentId.kind === "category") {
      throw new SmapiBrowseError("item_not_found");
    }

    const item = await request.context.jellyfin.getItemMetadata(
      contentId.value,
    );
    if (item.kind === "unknown" || item.kind !== contentId.kind) {
      throw new SmapiBrowseError("item_not_found");
    }

    return item.kind === "track"
      ? formatJellyfinTrackAsSonosBrowseTrack(item)
      : formatJellyfinEntityAsSonosBrowseCollection(item);
  }
}
