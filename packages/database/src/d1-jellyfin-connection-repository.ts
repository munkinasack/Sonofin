import type {
  JellyfinConnectionRecord,
  JellyfinConnectionRepository,
  NewJellyfinConnectionRecord,
} from "@sonofin/connections";

interface JellyfinConnectionRow {
  id: string;
  server_url: string;
  server_id: string;
  server_name: string;
  server_version: string;
  user_id: string;
  username: string;
  device_id: string;
  token_algorithm: JellyfinConnectionRecord["tokenAlgorithm"];
  encrypted_token: string;
  token_nonce: string;
  created_at: number;
}

const SELECT_CONNECTION = `
  SELECT
    id,
    server_url,
    server_id,
    server_name,
    server_version,
    user_id,
    username,
    device_id,
    token_algorithm,
    encrypted_token,
    token_nonce,
    created_at
  FROM jellyfin_connections
  WHERE id = ?1
  LIMIT 1
`;

export class D1JellyfinConnectionRepository
  implements JellyfinConnectionRepository
{
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async insert(connection: NewJellyfinConnectionRecord): Promise<boolean> {
    const result = await this.#database
      .prepare(
        `
          INSERT INTO jellyfin_connections (
            id,
            server_url,
            server_id,
            server_name,
            server_version,
            user_id,
            username,
            device_id,
            token_algorithm,
            encrypted_token,
            token_nonce,
            created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
          ON CONFLICT DO NOTHING
        `,
      )
      .bind(
        connection.id,
        connection.serverUrl,
        connection.serverId,
        connection.serverName,
        connection.serverVersion,
        connection.userId,
        connection.username,
        connection.deviceId,
        connection.tokenAlgorithm,
        connection.encryptedToken,
        connection.tokenNonce,
        connection.createdAt,
      )
      .run();

    return result.meta.changes === 1;
  }

  async findById(id: string): Promise<JellyfinConnectionRecord | null> {
    const row = await this.#database
      .withSession("first-primary")
      .prepare(SELECT_CONNECTION)
      .bind(id)
      .first<JellyfinConnectionRow>();

    return row === null ? null : mapConnection(row);
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.#database
      .prepare("DELETE FROM jellyfin_connections WHERE id = ?1")
      .bind(id)
      .run();

    return result.meta.changes === 1;
  }
}

function mapConnection(row: JellyfinConnectionRow): JellyfinConnectionRecord {
  return {
    id: row.id,
    serverUrl: row.server_url,
    serverId: row.server_id,
    serverName: row.server_name,
    serverVersion: row.server_version,
    userId: row.user_id,
    username: row.username,
    deviceId: row.device_id,
    tokenAlgorithm: row.token_algorithm,
    encryptedToken: row.encrypted_token,
    tokenNonce: row.token_nonce,
    createdAt: row.created_at,
  };
}
