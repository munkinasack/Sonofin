import { describe, expect, it } from "vitest";

import {
  InvalidLinkInputError,
  LinkCollisionError,
  LinkService,
  MAX_LINK_TTL_SECONDS,
  MIN_LINK_TTL_SECONDS,
  sha256Hex,
  type ClaimCompletedLinkInput,
  type CompletePendingLinkInput,
  type GuardedLinkMutationResult,
  type LinkRandomSource,
  type LinkRecord,
  type LinkRepository,
  type NewPendingLink,
} from "../src";

class InMemoryLinkRepository implements LinkRepository {
  readonly insertAttempts: NewPendingLink[] = [];
  readonly links = new Map<string, LinkRecord>();
  collisionsRemaining = 0;

  async insertPending(link: NewPendingLink): Promise<boolean> {
    this.insertAttempts.push({ ...link });
    if (this.collisionsRemaining > 0) {
      this.collisionsRemaining -= 1;
      return false;
    }
    if (this.links.has(link.linkCodeHash)) {
      return false;
    }

    this.links.set(link.linkCodeHash, {
      ...link,
      completedAt: null,
      claimedAt: null,
      jellyfinConnectionId: null,
    });
    return true;
  }

  async findByLinkCodeHash(linkCodeHash: string): Promise<LinkRecord | null> {
    const link = this.links.get(linkCodeHash);
    return link === undefined ? null : { ...link };
  }

  async completePending(
    input: CompletePendingLinkInput,
  ): Promise<GuardedLinkMutationResult> {
    const current = this.links.get(input.linkCodeHash);
    if (
      current === undefined ||
      current.completedAt !== null ||
      current.claimedAt !== null ||
      current.expiresAt <= input.completedAt
    ) {
      return {
        outcome: "unchanged",
        link: current === undefined ? null : { ...current },
      };
    }

    const updated: LinkRecord = {
      ...current,
      completedAt: input.completedAt,
      jellyfinConnectionId: input.jellyfinConnectionId,
    };
    this.links.set(input.linkCodeHash, updated);
    return { outcome: "updated", link: { ...updated } };
  }

  async claimCompleted(
    input: ClaimCompletedLinkInput,
  ): Promise<GuardedLinkMutationResult> {
    const current = this.links.get(input.linkCodeHash);
    if (
      current === undefined ||
      current.completedAt === null ||
      current.claimedAt !== null ||
      current.expiresAt <= input.claimedAt
    ) {
      return {
        outcome: "unchanged",
        link: current === undefined ? null : { ...current },
      };
    }

    const updated: LinkRecord = { ...current, claimedAt: input.claimedAt };
    this.links.set(input.linkCodeHash, updated);
    return { outcome: "updated", link: { ...updated } };
  }
}

function sequentialRandom(requests?: number[]): LinkRandomSource {
  let value = 0;
  return (length) => {
    requests?.push(length);
    const bytes = new Uint8Array(length);
    bytes.fill(value);
    value = (value + 1) & 0xff;
    return bytes;
  };
}

function makeHarness(options?: {
  now?: number;
  repository?: InMemoryLinkRepository;
  collisionRetries?: number;
}) {
  let now = options?.now ?? 1_000;
  const repository = options?.repository ?? new InMemoryLinkRepository();
  const service = new LinkService({
    repository,
    now: () => now,
    randomBytes: sequentialRandom(),
    ...(options?.collisionRetries === undefined
      ? {}
      : { collisionRetries: options.collisionRetries }),
  });

  return {
    repository,
    service,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("LinkService.createPendingLink", () => {
  it("creates two independent 24-byte base64url secrets and persists only hashes", async () => {
    const requests: number[] = [];
    const repository = new InMemoryLinkRepository();
    const service = new LinkService({
      repository,
      now: () => 10_000,
      randomBytes: sequentialRandom(requests),
    });

    const created = await service.createPendingLink({
      householdId: "  HH:Case-Sensitive/opaque  ",
      ttlSeconds: MIN_LINK_TTL_SECONDS,
    });

    expect(requests).toEqual([24, 24]);
    expect(created.linkCode).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(created.linkDeviceId).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(created.linkDeviceId).not.toBe(created.linkCode);
    expect(created.expiresAt).toBe(10_420);

    const stored = repository.insertAttempts[0];
    expect(stored).toBeDefined();
    expect(stored?.householdId).toBe("  HH:Case-Sensitive/opaque  ");
    expect(stored?.linkCodeHash).toBe(await sha256Hex(created.linkCode));
    expect(stored?.linkDeviceIdHash).toBe(
      await sha256Hex(created.linkDeviceId),
    );
    expect(stored?.linkCodeHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored?.linkDeviceIdHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored?.id).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain(created.linkCode);
    expect(JSON.stringify(stored)).not.toContain(created.linkDeviceId);
  });

  it("accepts the inclusive TTL limits and rejects values outside them", async () => {
    const minimum = makeHarness();
    await expect(
      minimum.service.createPendingLink({
        householdId: "hh",
        ttlSeconds: MIN_LINK_TTL_SECONDS,
      }),
    ).resolves.toMatchObject({ expiresAt: 1_420 });

    const maximum = makeHarness();
    await expect(
      maximum.service.createPendingLink({
        householdId: "hh",
        ttlSeconds: MAX_LINK_TTL_SECONDS,
      }),
    ).resolves.toMatchObject({ expiresAt: 4_600 });

    for (const ttlSeconds of [
      MIN_LINK_TTL_SECONDS - 1,
      MAX_LINK_TTL_SECONDS + 1,
      MIN_LINK_TTL_SECONDS + 0.5,
      Number.NaN,
    ]) {
      await expect(
        makeHarness().service.createPendingLink({
          householdId: "hh",
          ttlSeconds,
        }),
      ).rejects.toBeInstanceOf(InvalidLinkInputError);
    }
  });

  it("validates opaque identifiers by Unicode character count without normalizing", async () => {
    const service = makeHarness().service;
    const exactLimit = "🎵".repeat(255);

    await expect(
      service.createPendingLink({
        householdId: exactLimit,
        ttlSeconds: MIN_LINK_TTL_SECONDS,
      }),
    ).resolves.toBeDefined();
    await expect(
      service.createPendingLink({
        householdId: "",
        ttlSeconds: MIN_LINK_TTL_SECONDS,
      }),
    ).rejects.toBeInstanceOf(InvalidLinkInputError);
    await expect(
      service.createPendingLink({
        householdId: `${exactLimit}x`,
        ttlSeconds: MIN_LINK_TTL_SECONDS,
      }),
    ).rejects.toBeInstanceOf(InvalidLinkInputError);
  });

  it("regenerates both secrets on collisions and stops at the configured bound", async () => {
    const repository = new InMemoryLinkRepository();
    repository.collisionsRemaining = 2;
    const service = new LinkService({
      repository,
      now: () => 1_000,
      randomBytes: sequentialRandom(),
      collisionRetries: 2,
    });

    await expect(
      service.createPendingLink({
        householdId: "hh",
        ttlSeconds: MIN_LINK_TTL_SECONDS,
      }),
    ).resolves.toBeDefined();
    expect(repository.insertAttempts).toHaveLength(3);
    expect(
      new Set(repository.insertAttempts.map((link) => link.linkCodeHash)).size,
    ).toBe(3);
    expect(
      new Set(repository.insertAttempts.map((link) => link.linkDeviceIdHash))
        .size,
    ).toBe(3);

    const alwaysCollides = new InMemoryLinkRepository();
    alwaysCollides.collisionsRemaining = 10;
    const exhausted = new LinkService({
      repository: alwaysCollides,
      now: () => 1_000,
      randomBytes: sequentialRandom(),
      collisionRetries: 1,
    });
    const error = await exhausted
      .createPendingLink({
        householdId: "hh",
        ttlSeconds: MIN_LINK_TTL_SECONDS,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LinkCollisionError);
    expect((error as LinkCollisionError).attempts).toBe(2);
  });

  it("allows multiple active links for the same exact household", async () => {
    const { repository, service } = makeHarness();

    const first = await service.createPendingLink({
      householdId: "HH",
      ttlSeconds: MIN_LINK_TTL_SECONDS,
    });
    const second = await service.createPendingLink({
      householdId: "HH",
      ttlSeconds: MIN_LINK_TTL_SECONDS,
    });

    expect(first.linkCode).not.toBe(second.linkCode);
    expect(repository.links.size).toBe(2);
  });

  it("rejects invalid clocks, retry options, and random sources", async () => {
    expect(
      () =>
        new LinkService({
          repository: new InMemoryLinkRepository(),
          now: () => 1,
          collisionRetries: -1,
        }),
    ).toThrow(InvalidLinkInputError);

    const invalidClock = new LinkService({
      repository: new InMemoryLinkRepository(),
      now: () => 1.5,
      randomBytes: sequentialRandom(),
    });
    await expect(
      invalidClock.createPendingLink({
        householdId: "hh",
        ttlSeconds: MIN_LINK_TTL_SECONDS,
      }),
    ).rejects.toBeInstanceOf(InvalidLinkInputError);

    const shortRandom = new LinkService({
      repository: new InMemoryLinkRepository(),
      now: () => 1,
      randomBytes: () => new Uint8Array(23),
    });
    await expect(
      shortRandom.createPendingLink({
        householdId: "hh",
        ttlSeconds: MIN_LINK_TTL_SECONDS,
      }),
    ).rejects.toBeInstanceOf(InvalidLinkInputError);
  });
});

describe("LinkService state and connection completion", () => {
  it("reports invalid, pending, expired, complete, and claimed states", async () => {
    const harness = makeHarness();
    const created = await harness.service.createPendingLink({
      householdId: "hh",
      ttlSeconds: MIN_LINK_TTL_SECONDS,
    });

    await expect(harness.service.getOnboardingState("not-a-token")).resolves.toBe(
      "invalid",
    );
    await expect(
      harness.service.getOnboardingState("z".repeat(32)),
    ).resolves.toBe("invalid");
    await expect(
      harness.service.getOnboardingState(created.linkCode),
    ).resolves.toBe("pending");

    harness.setNow(created.expiresAt);
    await expect(
      harness.service.getOnboardingState(created.linkCode),
    ).resolves.toBe("expired");

    const completedHarness = makeHarness();
    const completedLink = await completedHarness.service.createPendingLink({
      householdId: "hh",
      ttlSeconds: MIN_LINK_TTL_SECONDS,
    });
    await completedHarness.service.completeWithConnection({
      linkCode: completedLink.linkCode,
      jellyfinConnectionId: "jf-1",
    });
    await expect(
      completedHarness.service.getOnboardingState(completedLink.linkCode),
    ).resolves.toBe("complete");
    await completedHarness.service.claim({
      householdId: "hh",
      linkCode: completedLink.linkCode,
      linkDeviceId: completedLink.linkDeviceId,
    });
    await expect(
      completedHarness.service.getOnboardingState(completedLink.linkCode),
    ).resolves.toBe("claimed");
    completedHarness.setNow(completedLink.expiresAt);
    await expect(
      completedHarness.service.getOnboardingState(completedLink.linkCode),
    ).resolves.toBe("expired");
  });

  it("completes once, makes matching repeats idempotent, and never overwrites", async () => {
    const { repository, service } = makeHarness();
    const created = await service.createPendingLink({
      householdId: "hh",
      ttlSeconds: MIN_LINK_TTL_SECONDS,
    });

    await expect(
      service.completeWithConnection({
        linkCode: created.linkCode,
        jellyfinConnectionId: "jf-original",
      }),
    ).resolves.toEqual({
      outcome: "success",
      state: "complete",
      alreadyCompleted: false,
    });
    await expect(
      service.completeWithConnection({
        linkCode: created.linkCode,
        jellyfinConnectionId: "jf-original",
      }),
    ).resolves.toEqual({
      outcome: "success",
      state: "complete",
      alreadyCompleted: true,
    });
    await expect(
      service.completeWithConnection({
        linkCode: created.linkCode,
        jellyfinConnectionId: "jf-other",
      }),
    ).resolves.toEqual({
      outcome: "failure",
      reason: "connection_mismatch",
    });

    await expect(
      service.isConnectionAssociated({
        linkCode: created.linkCode,
        jellyfinConnectionId: "jf-original",
      }),
    ).resolves.toBe(true);
    await expect(
      service.isConnectionAssociated({
        linkCode: created.linkCode,
        jellyfinConnectionId: "jf-other",
      }),
    ).resolves.toBe(false);
    await expect(
      service.isConnectionAssociated({
        linkCode: "invalid",
        jellyfinConnectionId: "jf-original",
      }),
    ).resolves.toBe(false);

    const stored = repository.links.get(await sha256Hex(created.linkCode));
    expect(stored?.jellyfinConnectionId).toBe("jf-original");
  });

  it("rejects unknown and expired pending completions", async () => {
    const harness = makeHarness();
    const created = await harness.service.createPendingLink({
      householdId: "hh",
      ttlSeconds: MIN_LINK_TTL_SECONDS,
    });

    await expect(
      harness.service.completeWithConnection({
        linkCode: "bad",
        jellyfinConnectionId: "jf",
      }),
    ).resolves.toEqual({ outcome: "failure", reason: "invalid" });
    await expect(
      harness.service.completeWithConnection({
        linkCode: "z".repeat(32),
        jellyfinConnectionId: "jf",
      }),
    ).resolves.toEqual({ outcome: "failure", reason: "invalid" });

    harness.setNow(created.expiresAt);
    await expect(
      harness.service.completeWithConnection({
        linkCode: created.linkCode,
        jellyfinConnectionId: "jf",
      }),
    ).resolves.toEqual({ outcome: "failure", reason: "expired" });
  });

  it("uses the guarded repository mutation to resolve racing completions", async () => {
    const { repository, service } = makeHarness();
    const created = await service.createPendingLink({
      householdId: "hh",
      ttlSeconds: MIN_LINK_TTL_SECONDS,
    });

    const results = await Promise.all([
      service.completeWithConnection({
        linkCode: created.linkCode,
        jellyfinConnectionId: "jf-a",
      }),
      service.completeWithConnection({
        linkCode: created.linkCode,
        jellyfinConnectionId: "jf-b",
      }),
    ]);

    expect(results).toContainEqual({
      outcome: "success",
      state: "complete",
      alreadyCompleted: false,
    });
    expect(results).toContainEqual({
      outcome: "failure",
      reason: "connection_mismatch",
    });
    const stored = repository.links.get(await sha256Hex(created.linkCode));
    expect(["jf-a", "jf-b"]).toContain(stored?.jellyfinConnectionId);
  });
});

describe("LinkService.claim", () => {
  it("returns retry only for a correctly bound, active pending link", async () => {
    const { service } = makeHarness();
    const created = await service.createPendingLink({
      householdId: "HH:Opaque",
      ttlSeconds: MIN_LINK_TTL_SECONDS,
    });

    await expect(
      service.claim({
        householdId: "HH:Opaque",
        linkCode: created.linkCode,
        linkDeviceId: created.linkDeviceId,
      }),
    ).resolves.toEqual({ outcome: "retry" });
    await expect(
      service.claim({
        householdId: "hh:opaque",
        linkCode: created.linkCode,
        linkDeviceId: created.linkDeviceId,
      }),
    ).resolves.toEqual({ outcome: "failure", reason: "mismatch" });
    await expect(
      service.claim({
        householdId: "HH:Opaque",
        linkCode: created.linkCode,
      }),
    ).resolves.toEqual({ outcome: "failure", reason: "mismatch" });
    await expect(
      service.claim({
        householdId: "HH:Opaque",
        linkCode: created.linkCode,
        linkDeviceId: "x".repeat(32),
      }),
    ).resolves.toEqual({ outcome: "failure", reason: "mismatch" });
  });

  it("distinguishes unknown, expired, and binding mismatch failures", async () => {
    const harness = makeHarness();
    const created = await harness.service.createPendingLink({
      householdId: "hh",
      ttlSeconds: MIN_LINK_TTL_SECONDS,
    });

    await expect(
      harness.service.claim({
        householdId: "hh",
        linkCode: "bad",
        linkDeviceId: created.linkDeviceId,
      }),
    ).resolves.toEqual({ outcome: "failure", reason: "unknown" });
    await expect(
      harness.service.claim({
        householdId: "hh",
        linkCode: "z".repeat(32),
        linkDeviceId: created.linkDeviceId,
      }),
    ).resolves.toEqual({ outcome: "failure", reason: "unknown" });

    harness.setNow(created.expiresAt);
    await expect(
      harness.service.claim({
        householdId: "hh",
        linkCode: created.linkCode,
        linkDeviceId: created.linkDeviceId,
      }),
    ).resolves.toEqual({ outcome: "failure", reason: "expired" });
    await expect(
      harness.service.claim({
        householdId: "other",
        linkCode: created.linkCode,
        linkDeviceId: created.linkDeviceId,
      }),
    ).resolves.toEqual({ outcome: "failure", reason: "expired" });
  });

  it("claims a completed link once and returns its durable association", async () => {
    const harness = makeHarness();
    const created = await harness.service.createPendingLink({
      householdId: "hh",
      ttlSeconds: MIN_LINK_TTL_SECONDS,
    });
    await harness.service.completeWithConnection({
      linkCode: created.linkCode,
      jellyfinConnectionId: "jf",
    });
    harness.setNow(1_100);

    const first = await harness.service.claim({
      householdId: "hh",
      linkCode: created.linkCode,
      linkDeviceId: created.linkDeviceId,
    });
    if (first.outcome !== "success") {
      throw new Error("Expected a successful claim");
    }
    expect(first).toMatchObject({
      alreadyClaimed: false,
      householdId: "hh",
      jellyfinConnectionId: "jf",
    });
    expect(first.linkId).toMatch(/^[0-9a-f]{64}$/u);

    const repeat = await harness.service.claim({
      householdId: "hh",
      linkCode: created.linkCode,
      linkDeviceId: created.linkDeviceId,
    });
    expect(repeat).toEqual({ ...first, alreadyClaimed: true });

    await expect(
      harness.service.completeWithConnection({
        linkCode: created.linkCode,
        jellyfinConnectionId: "jf",
      }),
    ).resolves.toEqual({
      outcome: "success",
      state: "claimed",
      alreadyCompleted: true,
    });

    harness.setNow(created.expiresAt);
    await expect(
      harness.service.claim({
        householdId: "hh",
        linkCode: created.linkCode,
        linkDeviceId: created.linkDeviceId,
      }),
    ).resolves.toEqual({ outcome: "failure", reason: "expired" });
    await expect(
      harness.service.completeWithConnection({
        linkCode: created.linkCode,
        jellyfinConnectionId: "jf",
      }),
    ).resolves.toEqual({ outcome: "failure", reason: "expired" });
  });

  it("makes concurrent matching claims converge on the same association", async () => {
    const { service } = makeHarness();
    const created = await service.createPendingLink({
      householdId: "hh",
      ttlSeconds: MIN_LINK_TTL_SECONDS,
    });
    await service.completeWithConnection({
      linkCode: created.linkCode,
      jellyfinConnectionId: "jf",
    });

    const results = await Promise.all([
      service.claim({
        householdId: "hh",
        linkCode: created.linkCode,
        linkDeviceId: created.linkDeviceId,
      }),
      service.claim({
        householdId: "hh",
        linkCode: created.linkCode,
        linkDeviceId: created.linkDeviceId,
      }),
    ]);
    const successes = results.filter(
      (result) => result.outcome === "success",
    );
    expect(successes).toHaveLength(2);
    expect(new Set(successes.map((result) => result.linkId)).size).toBe(1);
    expect(
      new Set(successes.map((result) => result.jellyfinConnectionId)).size,
    ).toBe(1);
    expect(successes.map((result) => result.alreadyClaimed).sort()).toEqual([
      false,
      true,
    ]);
  });
});
