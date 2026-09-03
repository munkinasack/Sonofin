import { describe, expect, it } from "vitest";

import {
  SONOS_CONTENT_CATEGORIES,
  SonosContentIdError,
  decodeSonosContentId,
  encodeSonosContentId,
  type SonosContentIdErrorCode,
  type SonosContentIdKind,
} from "../src";

function expectContentIdError(
  callback: () => unknown,
  code: SonosContentIdErrorCode,
): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(SonosContentIdError);
    expect(error).toMatchObject({
      code,
      message: "Invalid Sonos content ID",
      name: "SonosContentIdError",
    });
    return;
  }

  throw new Error(`Expected SonosContentIdError with code ${code}`);
}

describe("Sonos content IDs", () => {
  it("uses Sonos's fixed root and category IDs reversibly", () => {
    expect(encodeSonosContentId({ kind: "root" })).toBe("root");
    expect(decodeSonosContentId("root")).toEqual({ kind: "root" });

    for (const category of SONOS_CONTENT_CATEGORIES) {
      expect(
        encodeSonosContentId({ kind: "category", value: category }),
      ).toBe(category);
      expect(decodeSonosContentId(category, "category")).toEqual({
        kind: "category",
        value: category,
      });
    }
  });

  it.each(["artist", "album", "playlist", "track"] as const)(
    "round trips exact opaque %s IDs through canonical UTF-8 base64url",
    (kind) => {
      const sourceId = "Jellyfin:Exact.Case/雪?e\u0301";
      const encoded = encodeSonosContentId({ kind, value: sourceId });

      expect(encoded).toMatch(new RegExp(`^sf1\\.${kind}\\.`));
      expect(encoded).not.toContain(sourceId);
      expect(decodeSonosContentId(encoded, kind)).toEqual({
        kind,
        value: sourceId,
      });
      expect(Object.isFrozen(decodeSonosContentId(encoded))).toBe(true);
    },
  );

  it.each([
    ["artist", "sf1.artist.SmVsbHlmaW4tNDI"],
    ["album", "sf1.album.SmVsbHlmaW4tNDI"],
    ["playlist", "sf1.playlist.SmVsbHlmaW4tNDI"],
    ["track", "sf1.track.SmVsbHlmaW4tNDI"],
  ] as const)("keeps the stable %s wire encoding", (kind, expected) => {
    expect(encodeSonosContentId({ kind, value: "Jellyfin-42" })).toBe(
      expected,
    );
  });

  it("keeps equal source IDs distinct across entity kinds", () => {
    const sourceId = "same-source-id";
    const encoded = (["artist", "album", "playlist", "track"] as const).map(
      (kind) => encodeSonosContentId({ kind, value: sourceId }),
    );

    expect(new Set(encoded).size).toBe(encoded.length);
  });

  it("narrows an expected entity kind in the public decode type", () => {
    const encoded = encodeSonosContentId({ kind: "artist", value: "artist-id" });
    const decoded = decodeSonosContentId(encoded, "artist");

    expect(decoded.kind).toBe("artist");
    expect(decoded.value).toBe("artist-id");
  });

  it("accepts an exactly 128-character item ID and rejects 129", () => {
    const maximum = encodeSonosContentId({
      kind: "track",
      value: "x".repeat(88),
    });

    expect(maximum).toHaveLength(128);
    expect(decodeSonosContentId(maximum, "track")).toEqual({
      kind: "track",
      value: "x".repeat(88),
    });
    expectContentIdError(
      () =>
        encodeSonosContentId({
          kind: "track",
          value: "x".repeat(89),
        }),
      "content_id_too_long",
    );
    expectContentIdError(
      () => decodeSonosContentId("x".repeat(129)),
      "content_id_too_long",
    );
  });

  it("rejects an otherwise valid ID when the expected kind differs", () => {
    const trackId = encodeSonosContentId({
      kind: "track",
      value: "track-id",
    });

    expectContentIdError(
      () => decodeSonosContentId(trackId, "album"),
      "wrong_content_id_kind",
    );
    expectContentIdError(
      () => decodeSonosContentId("root", "category"),
      "wrong_content_id_kind",
    );
  });

  it.each([
    "",
    "ROOT",
    "unknown-category",
    "sf2.artist.YQ",
    "sf1.unknown.YQ",
    "sf1.artist.",
    "sf1.artist.YQ==",
    "sf1.artist.YQ.extra",
    "sf1.artist.YR",
    "sf1.artist._w",
  ])("rejects malformed or non-canonical ID %j", (value) => {
    expectContentIdError(
      () => decodeSonosContentId(value),
      "invalid_content_id",
    );
  });

  it.each(["", " padded", "padded ", "unpaired\ud800surrogate"])(
    "rejects a malformed source ID %j without echoing it",
    (value) => {
      expectContentIdError(
        () => encodeSonosContentId({ kind: "artist", value }),
        "invalid_content_id",
      );
    },
  );

  it("rejects unknown categories, kinds, and expected kinds at runtime", () => {
    expectContentIdError(
      () =>
        encodeSonosContentId({
          kind: "category",
          value: "unknown",
        } as never),
      "invalid_content_id",
    );
    expectContentIdError(
      () => encodeSonosContentId({ kind: "stream", value: "id" } as never),
      "invalid_content_id",
    );
    expectContentIdError(
      () =>
        decodeSonosContentId(
          encodeSonosContentId({ kind: "track", value: "id" }),
          "stream" as SonosContentIdKind,
        ),
      "invalid_content_id",
    );
  });
});
