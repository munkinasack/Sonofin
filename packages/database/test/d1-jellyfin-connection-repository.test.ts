import { describe, expect, it } from "vitest";

import { D1JellyfinConnectionRepository } from "../src";

interface DatabaseCall {
  operation: "run" | "first";
  sql: string;
  bindings: unknown[];
}

class ScriptedD1Database {
  readonly calls: DatabaseCall[] = [];
  readonly runChanges: number[] = [];
  readonly firstRows: Array<Record<string, unknown> | null> = [];
  readonly sessionConstraints: Array<string | undefined> = [];

  withSession(constraint?: string): D1DatabaseSession {
    this.sessionConstraints.push(constraint);
    return this as unknown as D1DatabaseSession;
  }

  prepare(sql: string): D1PreparedStatement {
    let bindings: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        bindings = values;
        return statement;
      },
      first: async () => {
        this.calls.push({ operation: "first", sql, bindings: [...bindings] });
        const row = this.firstRows.shift();
        return row === undefined ? null : row;
      },
      run: async () => {
        this.calls.push({ operation: "run", sql, bindings: [...bindings] });
        const changes = this.runChanges.shift() ?? 0;
        return { meta: { changes } };
      },
    };

    return statement as unknown as D1PreparedStatement;
  }
}

const CONNECTION = {
  id: "A_b-".repeat(8),
  serverUrl: "https://media.example/jellyfin",
  serverId: "server-id",
  serverName: "Living Room 🎵",
  serverVersion: "10.11.0",
  userId: "user-id",
  username: "exact user",
  deviceId: "device-id",
  tokenAlgorithm: "A256GCM" as const,
  encryptedToken: "c".repeat(43),
  tokenNonce: "n".repeat(16),
  createdAt: 1_234,
};

const ROW = {
  id: CONNECTION.id,
  server_url: CONNECTION.serverUrl,
  server_id: CONNECTION.serverId,
  server_name: CONNECTION.serverName,
  server_version: CONNECTION.serverVersion,
  user_id: CONNECTION.userId,
  username: CONNECTION.username,
  device_id: CONNECTION.deviceId,
  token_algorithm: CONNECTION.tokenAlgorithm,
  encrypted_token: CONNECTION.encryptedToken,
  token_nonce: CONNECTION.tokenNonce,
  created_at: CONNECTION.createdAt,
};

function makeRepository(
  database: ScriptedD1Database,
): D1JellyfinConnectionRepository {
  return new D1JellyfinConnectionRepository(
    database as unknown as D1Database,
  );
}

describe("D1JellyfinConnectionRepository", () => {
  it("inserts only encrypted credential fields with numbered parameters", async () => {
    const database = new ScriptedD1Database();
    database.runChanges.push(1, 0);
    const repository = makeRepository(database);

    await expect(repository.insert(CONNECTION)).resolves.toBe(true);
    await expect(repository.insert(CONNECTION)).resolves.toBe(false);

    const first = database.calls[0];
    expect(first?.operation).toBe("run");
    expect(first?.sql).toContain("INSERT INTO jellyfin_connections");
    expect(first?.sql).toContain("ON CONFLICT DO NOTHING");
    expect(first?.sql).not.toContain("INSERT OR IGNORE");
    expect(first?.sql).not.toMatch(/plaintext|access_token|password/iu);
    for (let index = 1; index <= 12; index += 1) {
      expect(first?.sql).toContain(`?${index}`);
    }
    expect(first?.bindings).toEqual([
      CONNECTION.id,
      CONNECTION.serverUrl,
      CONNECTION.serverId,
      CONNECTION.serverName,
      CONNECTION.serverVersion,
      CONNECTION.userId,
      CONNECTION.username,
      CONNECTION.deviceId,
      CONNECTION.tokenAlgorithm,
      CONNECTION.encryptedToken,
      CONNECTION.tokenNonce,
      CONNECTION.createdAt,
    ]);
  });

  it("reads and maps exact metadata and encrypted token material", async () => {
    const database = new ScriptedD1Database();
    database.firstRows.push(ROW, null);
    const repository = makeRepository(database);

    await expect(repository.findById(CONNECTION.id)).resolves.toEqual(
      CONNECTION,
    );
    await expect(repository.findById("missing".padEnd(32, "x"))).resolves.toBe(
      null,
    );

    expect(database.calls[0]).toMatchObject({
      operation: "first",
      bindings: [CONNECTION.id],
    });
    expect(database.calls[0]?.sql).toContain("WHERE id = ?1");
    expect(database.calls[0]?.sql).not.toMatch(
      /plaintext|access_token|password/iu,
    );
    expect(database.sessionConstraints).toEqual([
      "first-primary",
      "first-primary",
    ]);
  });

  it("deletes by ID and reports whether a row changed", async () => {
    const database = new ScriptedD1Database();
    database.runChanges.push(1, 0);
    const repository = makeRepository(database);

    await expect(repository.deleteById(CONNECTION.id)).resolves.toBe(true);
    await expect(repository.deleteById(CONNECTION.id)).resolves.toBe(false);

    expect(database.calls).toEqual([
      {
        operation: "run",
        sql: "DELETE FROM jellyfin_connections WHERE id = ?1",
        bindings: [CONNECTION.id],
      },
      {
        operation: "run",
        sql: "DELETE FROM jellyfin_connections WHERE id = ?1",
        bindings: [CONNECTION.id],
      },
    ]);
  });
});
