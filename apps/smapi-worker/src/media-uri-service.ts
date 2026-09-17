import {
  resolveSonosPlaybackTarget,
} from "@sonofin/jellyfin-client";
import {
  decodeSonosContentId,
  SonosContentIdError,
  type GetMediaURIResult,
} from "@sonofin/sonos-smapi";

import type { SmapiAuthenticatedRequestContext } from "./authenticated-context";
import { SmapiBrowseError } from "./browse-service";

export interface SmapiGetMediaURIRequest {
  readonly context: SmapiAuthenticatedRequestContext;
  readonly id: unknown;
  readonly action?: string;
  readonly secondsSinceExplicit?: string;
  readonly deviceSessionToken?: string;
}

export interface SmapiMediaURIService {
  getMediaURI(request: SmapiGetMediaURIRequest): Promise<GetMediaURIResult>;
}

export class SonofinMediaURIService implements SmapiMediaURIService {
  async getMediaURI(request: SmapiGetMediaURIRequest): Promise<GetMediaURIResult> {
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

    // A canonical track ID must still resolve to the same Jellyfin track.
    const item = await request.context.jellyfin.getItemMetadata(contentId.value);
    if (item.kind !== "track" || item.id !== contentId.value) {
      throw new SmapiBrowseError("item_not_found");
    }

    const playback = await request.context.jellyfin.getPlaybackInfo(contentId.value);
    return resolveSonosPlaybackTarget(
      contentId.value,
      playback,
      request.context.connection,
    );
  }
}
