import {
  resolveSonosPlaybackTarget,
} from "@sonofin/jellyfin-client";
import {
  decodeSonosContentId,
  SonosContentIdError,
  type GetMediaMetadataResult,
} from "@sonofin/sonos-smapi";

import type { SmapiAuthenticatedRequestContext } from "./authenticated-context";
import { SmapiBrowseError } from "./browse-service";
import { formatJellyfinTrackWithPlaybackMime } from "./track-formatter";

export interface SmapiGetMediaMetadataRequest {
  readonly context: SmapiAuthenticatedRequestContext;
  readonly id: unknown;
}

export interface SmapiMediaMetadataService {
  getMediaMetadata(
    request: SmapiGetMediaMetadataRequest,
  ): Promise<GetMediaMetadataResult>;
}

export class SonofinMediaMetadataService
  implements SmapiMediaMetadataService
{
  async getMediaMetadata(
    request: SmapiGetMediaMetadataRequest,
  ): Promise<GetMediaMetadataResult> {
    let contentId;
    try {
      contentId = decodeSonosContentId(request.id);
    } catch (error) {
      if (error instanceof SonosContentIdError) {
        throw new SmapiBrowseError("invalid_parameters");
      }
      throw error;
    }

    if (contentId.kind !== "track") {
      throw new SmapiBrowseError("item_not_found");
    }

    const item = await request.context.jellyfin.getItemMetadata(
      contentId.value,
    );
    if (item.kind !== "track" || item.id !== contentId.value) {
      throw new SmapiBrowseError("item_not_found");
    }

    const playback = await request.context.jellyfin.getPlaybackInfo(
      contentId.value,
    );
    const target = resolveSonosPlaybackTarget(
      contentId.value,
      playback,
      request.context.connection,
    );
    return formatJellyfinTrackWithPlaybackMime(item, target.mimeType);
  }
}
