import { describe, expect, it } from "vitest";

import { deriveSonosUserIdHashCode } from "../src/user-info";

describe("deriveSonosUserIdHashCode", () => {
  it("pins the immutable identity derivation contract", async () => {
    await expect(
      deriveSonosUserIdHashCode({
        serverId: "server-a",
        userId: "user-a",
      }),
    ).resolves.toBe(
      "bbb1d51340f15bc98b121f370059689bd4a5944b8f8271422b36ebfb94df46da",
    );
  });

  it("is stable and does not expose either Jellyfin identifier", async () => {
    const identity = {
      serverId: "private-jellyfin-server-id",
      userId: "private-jellyfin-user-id",
    };

    const first = await deriveSonosUserIdHashCode(identity);
    const second = await deriveSonosUserIdHashCode({ ...identity });

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toContain(identity.serverId);
    expect(first).not.toContain(identity.userId);
  });

  it("scopes equal user IDs to their Jellyfin server", async () => {
    const first = await deriveSonosUserIdHashCode({
      serverId: "server-a",
      userId: "same-user",
    });
    const second = await deriveSonosUserIdHashCode({
      serverId: "server-b",
      userId: "same-user",
    });

    expect(first).not.toBe(second);
  });

  it("keeps users on the same Jellyfin server distinct", async () => {
    const first = await deriveSonosUserIdHashCode({
      serverId: "same-server",
      userId: "user-a",
    });
    const second = await deriveSonosUserIdHashCode({
      serverId: "same-server",
      userId: "user-b",
    });

    expect(first).not.toBe(second);
  });
});
