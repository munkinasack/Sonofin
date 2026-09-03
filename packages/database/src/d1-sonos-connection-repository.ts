import type {
  NewSonosConnectionRecord,
  RevokeSonosConnectionInput,
  SonosConnectionRecord,
  SonosConnectionRepository,
} from "@sonofin/sonos-auth";

interface SonosConnectionRow {
  id: string;
  jellyfin_connection_id: string;
  household_id: string;
  auth_token_hash: string;
  created_at: number;
  revoked_at: number | null;
}

const SELECT_CONNECTION = `
  SELECT
    id,
    jellyfin_connection_id,
    household_id,
    auth_token_hash,
    created_at,
    revoked_at
  FROM sonos_connections
`;

export class D1SonosConnectionRepository
  implements SonosConnectionRepository
{
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async insert(connection: NewSonosConnectionRecord): Promise<boolean> {
    const result = await this.#database
      .prepare(
        `
          INSERT INTO sonos_connections (
            id,
            jellyfin_connection_id,
            household_id,
            auth_token_hash,
            created_at,
            revoked_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT DO NOTHING
        `,
      )
      .bind(
        connection.id,
        connection.jellyfinConnectionId,
        connection.householdId,
        connection.authTokenHash,
        connection.createdAt,
        connection.revokedAt,
      )
      .run();

    return result.meta.changes === 1;
  }

  async findById(id: string): Promise<SonosConnectionRecord | null> {
    const session = this.#database.withSession("first-primary");
    const row = await session
      .prepare(`${SELECT_CONNECTION} WHERE id = ?1 LIMIT 1`)
      .bind(id)
      .first<SonosConnectionRow>();

    return row === null ? null : mapConnection(row);
  }

  async findByAuthTokenHash(
    authTokenHash: string,
  ): Promise<SonosConnectionRecord | null> {
    const session = this.#database.withSession("first-primary");
    const row = await session
      .prepare(`${SELECT_CONNECTION} WHERE auth_token_hash = ?1 LIMIT 1`)
      .bind(authTokenHash)
      .first<SonosConnectionRow>();

    return row === null ? null : mapConnection(row);
  }

  async revokeByAuthTokenHash(
    input: RevokeSonosConnectionInput,
  ): Promise<SonosConnectionRecord | null> {
    const session = this.#database.withSession("first-primary");
    const result = await session
      .prepare(
        `
          UPDATE sonos_connections
          SET revoked_at = ?3
          WHERE auth_token_hash = ?1
            AND household_id = ?2
            AND revoked_at IS NULL
        `,
      )
      .bind(input.authTokenHash, input.householdId, input.revokedAt)
      .run();
    if (result.meta.changes !== 1) {
      return null;
    }

    const row = await session
      .prepare(
        `${SELECT_CONNECTION}
         WHERE auth_token_hash = ?1 AND household_id = ?2
         LIMIT 1`,
      )
      .bind(input.authTokenHash, input.householdId)
      .first<SonosConnectionRow>();

    if (row === null) {
      throw new Error(
        "D1 revoked a Sonos connection that could not be read back",
      );
    }
    return mapConnection(row);
  }
}

function mapConnection(row: SonosConnectionRow): SonosConnectionRecord {
  return {
    id: row.id,
    jellyfinConnectionId: row.jellyfin_connection_id,
    householdId: row.household_id,
    authTokenHash: row.auth_token_hash,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}
