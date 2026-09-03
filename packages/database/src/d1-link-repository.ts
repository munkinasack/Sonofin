import type {
  ClaimCompletedLinkInput,
  CompletePendingLinkInput,
  GuardedLinkMutationResult,
  LinkRecord,
  LinkRepository,
  NewPendingLink,
} from "@sonofin/linking";

interface OnboardingLinkRow {
  id: string;
  link_code_hash: string;
  link_device_id_hash: string;
  household_id: string;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
  claimed_at: number | null;
  jellyfin_connection_id: string | null;
}

const SELECT_LINK = `
  SELECT
    id,
    link_code_hash,
    link_device_id_hash,
    household_id,
    created_at,
    expires_at,
    completed_at,
    claimed_at,
    jellyfin_connection_id
  FROM onboarding_links
  WHERE link_code_hash = ?1
  LIMIT 1
`;

export class D1LinkRepository implements LinkRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async insertPending(link: NewPendingLink): Promise<boolean> {
    const result = await this.#database
      .prepare(
        `
          INSERT INTO onboarding_links (
            id,
            link_code_hash,
            link_device_id_hash,
            household_id,
            created_at,
            expires_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT DO NOTHING
        `,
      )
      .bind(
        link.id,
        link.linkCodeHash,
        link.linkDeviceIdHash,
        link.householdId,
        link.createdAt,
        link.expiresAt,
      )
      .run();

    return result.meta.changes === 1;
  }

  async findByLinkCodeHash(linkCodeHash: string): Promise<LinkRecord | null> {
    const session = this.#database.withSession("first-primary");
    return findByLinkCodeHash(session, linkCodeHash);
  }

  async completePending(
    input: CompletePendingLinkInput,
  ): Promise<GuardedLinkMutationResult> {
    const session = this.#database.withSession("first-primary");
    const result = await session
      .prepare(
        `
          UPDATE onboarding_links
          SET
            completed_at = ?2,
            jellyfin_connection_id = ?3
          WHERE link_code_hash = ?1
            AND completed_at IS NULL
            AND claimed_at IS NULL
            AND expires_at > ?2
        `,
      )
      .bind(
        input.linkCodeHash,
        input.completedAt,
        input.jellyfinConnectionId,
      )
      .run();
    const link = await findByLinkCodeHash(session, input.linkCodeHash);

    if (result.meta.changes === 1) {
      if (link === null) {
        throw new Error("D1 completed a link that could not be read back");
      }
      return { outcome: "updated", link };
    }

    return { outcome: "unchanged", link };
  }

  async claimCompleted(
    input: ClaimCompletedLinkInput,
  ): Promise<GuardedLinkMutationResult> {
    const session = this.#database.withSession("first-primary");
    const result = await session
      .prepare(
        `
          UPDATE onboarding_links
          SET claimed_at = ?2
          WHERE link_code_hash = ?1
            AND completed_at IS NOT NULL
            AND claimed_at IS NULL
            AND expires_at > ?2
        `,
      )
      .bind(input.linkCodeHash, input.claimedAt)
      .run();
    const link = await findByLinkCodeHash(session, input.linkCodeHash);

    if (result.meta.changes === 1) {
      if (link === null) {
        throw new Error("D1 claimed a link that could not be read back");
      }
      return { outcome: "updated", link };
    }

    return { outcome: "unchanged", link };
  }
}

async function findByLinkCodeHash(
  session: D1DatabaseSession,
  linkCodeHash: string,
): Promise<LinkRecord | null> {
  const row = await session
    .prepare(SELECT_LINK)
    .bind(linkCodeHash)
    .first<OnboardingLinkRow>();

  return row === null ? null : mapLink(row);
}

function mapLink(row: OnboardingLinkRow): LinkRecord {
  return {
    id: row.id,
    linkCodeHash: row.link_code_hash,
    linkDeviceIdHash: row.link_device_id_hash,
    householdId: row.household_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
    claimedAt: row.claimed_at,
    jellyfinConnectionId: row.jellyfin_connection_id,
  };
}
