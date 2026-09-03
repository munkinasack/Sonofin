import {
  defaultRandomBytes,
  generateLinkToken,
  isLinkToken,
  sha256Hex,
} from "./crypto";
import {
  DEFAULT_LINK_COLLISION_RETRIES,
  InvalidLinkInputError,
  LinkCollisionError,
  MAX_LINK_TTL_SECONDS,
  MIN_LINK_TTL_SECONDS,
  type ClaimLinkInput,
  type ClaimLinkResult,
  type CompleteLinkResult,
  type CompleteWithConnectionInput,
  type CreatedPendingLink,
  type CreatePendingLinkInput,
  type LinkRecord,
  type LinkConnectionAssociationInput,
  type LinkRepository,
  type LinkServiceOptions,
  type LinkState,
} from "./types";

const MAX_OPAQUE_IDENTIFIER_LENGTH = 255;
const LINK_ID_DOMAIN = "sonofin/onboarding-link/id/v1";

export class LinkService {
  readonly #repository: LinkRepository;
  readonly #now: () => number;
  readonly #randomBytes: NonNullable<LinkServiceOptions["randomBytes"]>;
  readonly #collisionRetries: number;

  constructor(options: LinkServiceOptions) {
    if (!Number.isSafeInteger(options.collisionRetries ?? 0)) {
      throw new InvalidLinkInputError(
        "collisionRetries must be a non-negative safe integer",
      );
    }

    const collisionRetries =
      options.collisionRetries ?? DEFAULT_LINK_COLLISION_RETRIES;
    if (collisionRetries < 0) {
      throw new InvalidLinkInputError(
        "collisionRetries must be a non-negative safe integer",
      );
    }

    this.#repository = options.repository;
    this.#now = options.now;
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#collisionRetries = collisionRetries;
  }

  async createPendingLink(
    input: CreatePendingLinkInput,
  ): Promise<CreatedPendingLink> {
    assertOpaqueIdentifier(input.householdId, "householdId");
    assertTtl(input.ttlSeconds);

    const createdAt = this.#readNow();
    const expiresAt = createdAt + input.ttlSeconds;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new InvalidLinkInputError("The calculated expiry is out of range");
    }

    const attempts = this.#collisionRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const linkCode = generateLinkToken(this.#randomBytes);
      const linkDeviceId = generateLinkToken(this.#randomBytes);
      const [linkCodeHash, linkDeviceIdHash] = await Promise.all([
        sha256Hex(linkCode),
        sha256Hex(linkDeviceId),
      ]);
      const id = await sha256Hex(
        `${LINK_ID_DOMAIN}\u0000${linkCodeHash}\u0000${linkDeviceIdHash}`,
      );

      const inserted = await this.#repository.insertPending({
        id,
        linkCodeHash,
        linkDeviceIdHash,
        householdId: input.householdId,
        createdAt,
        expiresAt,
      });
      if (inserted) {
        return { linkCode, linkDeviceId, expiresAt };
      }
    }

    throw new LinkCollisionError(attempts);
  }

  async getOnboardingState(linkCode: string): Promise<LinkState> {
    if (!isLinkToken(linkCode)) {
      return "invalid";
    }

    const link = await this.#repository.findByLinkCodeHash(
      await sha256Hex(linkCode),
    );
    if (link === null) {
      return "invalid";
    }

    return stateOf(link, this.#readNow());
  }

  async isConnectionAssociated(
    input: LinkConnectionAssociationInput,
  ): Promise<boolean> {
    if (
      !isLinkToken(input.linkCode) ||
      !isOpaqueIdentifier(input.jellyfinConnectionId)
    ) {
      return false;
    }

    const link = await this.#repository.findByLinkCodeHash(
      await sha256Hex(input.linkCode),
    );
    return (
      link !== null &&
      link.completedAt !== null &&
      link.jellyfinConnectionId === input.jellyfinConnectionId
    );
  }

  async completeWithConnection(
    input: CompleteWithConnectionInput,
  ): Promise<CompleteLinkResult> {
    assertOpaqueIdentifier(
      input.jellyfinConnectionId,
      "jellyfinConnectionId",
    );
    if (!isLinkToken(input.linkCode)) {
      return { outcome: "failure", reason: "invalid" };
    }

    const completedAt = this.#readNow();
    const mutation = await this.#repository.completePending({
      linkCodeHash: await sha256Hex(input.linkCode),
      completedAt,
      jellyfinConnectionId: input.jellyfinConnectionId,
    });
    const link = mutation.link;

    if (mutation.outcome === "updated") {
      return {
        outcome: "success",
        state: mutation.link.claimedAt === null ? "complete" : "claimed",
        alreadyCompleted: false,
      };
    }
    if (link === null) {
      return { outcome: "failure", reason: "invalid" };
    }
    if (link.expiresAt <= completedAt) {
      return { outcome: "failure", reason: "expired" };
    }
    if (link.completedAt !== null) {
      if (
        link.jellyfinConnectionId !== input.jellyfinConnectionId
      ) {
        return { outcome: "failure", reason: "connection_mismatch" };
      }

      return {
        outcome: "success",
        state: link.claimedAt === null ? "complete" : "claimed",
        alreadyCompleted: true,
      };
    }
    return { outcome: "failure", reason: "invalid" };
  }

  async claim(input: ClaimLinkInput): Promise<ClaimLinkResult> {
    if (!isLinkToken(input.linkCode)) {
      return { outcome: "failure", reason: "unknown" };
    }

    const linkCodeHash = await sha256Hex(input.linkCode);
    const link = await this.#repository.findByLinkCodeHash(linkCodeHash);
    if (link === null) {
      return { outcome: "failure", reason: "unknown" };
    }
    const now = this.#readNow();
    if (link.expiresAt <= now) {
      return { outcome: "failure", reason: "expired" };
    }
    if (
      !isOpaqueIdentifier(input.householdId) ||
      input.householdId !== link.householdId ||
      input.linkDeviceId === undefined ||
      !isLinkToken(input.linkDeviceId) ||
      (await sha256Hex(input.linkDeviceId)) !== link.linkDeviceIdHash
    ) {
      return { outcome: "failure", reason: "mismatch" };
    }

    if (link.claimedAt !== null) {
      return this.#successfulClaim(link, true);
    }
    if (link.completedAt === null) {
      return { outcome: "retry" };
    }

    const mutation = await this.#repository.claimCompleted({
      linkCodeHash,
      claimedAt: now,
    });
    if (mutation.outcome === "updated") {
      return this.#successfulClaim(mutation.link, false);
    }
    if (mutation.link !== null && mutation.link.claimedAt !== null) {
      return this.#successfulClaim(mutation.link, true);
    }

    return { outcome: "failure", reason: "unknown" };
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new InvalidLinkInputError(
        "now() must return a non-negative integer Unix timestamp",
      );
    }

    return now;
  }

  async #successfulClaim(
    link: LinkRecord,
    alreadyClaimed: boolean,
  ): Promise<ClaimLinkResult> {
    if (link.jellyfinConnectionId === null) {
      return { outcome: "failure", reason: "unknown" };
    }

    return {
      outcome: "success",
      alreadyClaimed,
      householdId: link.householdId,
      jellyfinConnectionId: link.jellyfinConnectionId,
      linkId: link.id,
    };
  }
}

function stateOf(link: LinkRecord, now: number): LinkState {
  if (link.expiresAt <= now) {
    return "expired";
  }
  if (link.claimedAt !== null) {
    return "claimed";
  }
  if (link.completedAt !== null) {
    return "complete";
  }
  return "pending";
}

function assertTtl(ttlSeconds: number): void {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < MIN_LINK_TTL_SECONDS ||
    ttlSeconds > MAX_LINK_TTL_SECONDS
  ) {
    throw new InvalidLinkInputError(
      `ttlSeconds must be an integer from ${MIN_LINK_TTL_SECONDS} through ${MAX_LINK_TTL_SECONDS}`,
    );
  }
}

function isOpaqueIdentifier(value: string): boolean {
  const length = Array.from(value).length;
  return length >= 1 && length <= MAX_OPAQUE_IDENTIFIER_LENGTH;
}

function assertOpaqueIdentifier(value: string, field: string): void {
  if (!isOpaqueIdentifier(value)) {
    throw new InvalidLinkInputError(
      `${field} must contain from 1 through ${MAX_OPAQUE_IDENTIFIER_LENGTH} characters`,
    );
  }
}
