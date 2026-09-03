export const LINK_TOKEN_BYTE_LENGTH = 24;
export const LINK_TOKEN_LENGTH = 32;
export const MIN_LINK_TTL_SECONDS = 420;
export const MAX_LINK_TTL_SECONDS = 3_600;
export const DEFAULT_LINK_COLLISION_RETRIES = 4;

export type LinkState =
  | "invalid"
  | "expired"
  | "pending"
  | "complete"
  | "claimed";

export interface NewPendingLink {
  id: string;
  linkCodeHash: string;
  linkDeviceIdHash: string;
  householdId: string;
  createdAt: number;
  expiresAt: number;
}

export interface LinkRecord extends NewPendingLink {
  completedAt: number | null;
  claimedAt: number | null;
  jellyfinConnectionId: string | null;
}

export interface CompletePendingLinkInput {
  linkCodeHash: string;
  completedAt: number;
  jellyfinConnectionId: string;
}

export interface ClaimCompletedLinkInput {
  linkCodeHash: string;
  claimedAt: number;
}

export type GuardedLinkMutationResult =
  | { outcome: "updated"; link: LinkRecord }
  | { outcome: "unchanged"; link: LinkRecord | null };

export interface LinkRepository {
  insertPending(link: NewPendingLink): Promise<boolean>;
  findByLinkCodeHash(linkCodeHash: string): Promise<LinkRecord | null>;
  completePending(
    input: CompletePendingLinkInput,
  ): Promise<GuardedLinkMutationResult>;
  claimCompleted(
    input: ClaimCompletedLinkInput,
  ): Promise<GuardedLinkMutationResult>;
}

export type LinkRandomSource = (length: number) => Uint8Array;

export interface LinkServiceOptions {
  repository: LinkRepository;
  now: () => number;
  randomBytes?: LinkRandomSource;
  collisionRetries?: number;
}

export interface CreatePendingLinkInput {
  householdId: string;
  ttlSeconds: number;
}

export interface CreatedPendingLink {
  linkCode: string;
  linkDeviceId: string;
  expiresAt: number;
}

export interface CompleteWithConnectionInput {
  linkCode: string;
  jellyfinConnectionId: string;
}

export interface LinkConnectionAssociationInput {
  linkCode: string;
  jellyfinConnectionId: string;
}

export type CompleteLinkResult =
  | {
      outcome: "success";
      state: "complete" | "claimed";
      alreadyCompleted: boolean;
    }
  | {
      outcome: "failure";
      reason: "invalid" | "expired" | "connection_mismatch";
    };

export interface ClaimLinkInput {
  householdId: string;
  linkCode: string;
  linkDeviceId?: string;
}

export type ClaimLinkResult =
  | { outcome: "retry" }
  | { outcome: "failure"; reason: "unknown" | "expired" | "mismatch" }
  | {
      outcome: "success";
      alreadyClaimed: boolean;
      householdId: string;
      jellyfinConnectionId: string;
      linkId: string;
    };

export class InvalidLinkInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLinkInputError";
  }
}

export class LinkCollisionError extends Error {
  readonly attempts: number;

  constructor(attempts: number) {
    super(`Could not allocate a unique link code after ${attempts} attempts`);
    this.name = "LinkCollisionError";
    this.attempts = attempts;
  }
}
