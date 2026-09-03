import { describe, expect, it } from "vitest";

import { D1SonosConnectionRepository } from "../src";

interface DatabaseCall {
  operation: "run" | "first";
  source: "database" | "session";
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
    return {
      prepare: (sql: string) => this.#prepare(sql, "session"),
    } as unknown as D1DatabaseSession;
  }

  prepare(sql: string): D1PreparedStatement {
    return this.#prepare(sql, "database");
  }

  #prepare(
    sql: string,
    source: DatabaseCall["source"],
  ): D1PreparedStatement {
    let bindings: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        bindings = values;
        return statement;
      },
      first: async () => {
        this.calls.push({
          operation: "first",
          source,
          sql,
          bindings: [...bindings],
        });
        const row = this.firstRows.shift();
        return row === undefined ? null : row;
      },
      run: async () => {
        this.calls.push({
          operation: "run",
          source,
          sql,
          bindings: [...bindings],
        });
        const changes = this.runChanges.shift() ?? 0;
        return { meta: { changes } };
      },
    };

    return statement as unknown as D1PreparedStatement;
  }
}

const CONNECTION = {
  id: "a".repeat(64),
  jellyfinConnectionId: "A_b-".repeat(8),
  householdId: " HH:Case-Sensitive/opaque ",
  authTokenHash: "b".repeat(64),
  createdAt: 1_234,
  revokedAt: null,
};

const ROW = {
  id: CONNECTION.id,
  jellyfin_connection_id: CONNECTION.jellyfinConnectionId,
  household_id: CONNECTION.householdId,
  auth_token_hash: CONNECTION.authTokenHash,
  created_at: CONNECTION.createdAt,
  revoked_at: CONNECTION.revokedAt,
};

function makeRepository(
  database: ScriptedD1Database,
): D1SonosConnectionRepository {
  return new D1SonosConnectionRepository(database as unknown as D1Database);
}

describe("D1SonosConnectionRepository", () => {
  it("inserts only the token hash and Sonos-to-Jellyfin mapping", async () => {
    const database = new ScriptedD1Database();
    database.runChanges.push(1, 0);
    const repository = makeRepository(database);

    await expect(repository.insert(CONNECTION)).resolves.toBe(true);
    await expect(repository.insert(CONNECTION)).resolves.toBe(false);

    const first = database.calls[0];
    expect(first?.operation).toBe("run");
    expect(first?.source).toBe("database");
    expect(first?.sql).toContain("INSERT INTO sonos_connections");
    expect(first?.sql).toContain("ON CONFLICT DO NOTHING");
    expect(first?.sql).not.toContain("INSERT OR IGNORE");
    expect(first?.sql).not.toMatch(/plaintext|raw_token|password|private_key/iu);
    for (let index = 1; index <= 6; index += 1) {
      expect(first?.sql).toContain(`?${index}`);
    }
    expect(first?.bindings).toEqual([
      CONNECTION.id,
      CONNECTION.jellyfinConnectionId,
      CONNECTION.householdId,
      CONNECTION.authTokenHash,
      CONNECTION.createdAt,
      CONNECTION.revokedAt,
    ]);
    expect(JSON.stringify(first?.bindings)).not.toMatch(
      /raw-sonos-token|password/iu,
    );
  });

  it("finds and maps records by ID or token hash", async () => {
    const database = new ScriptedD1Database();
    database.firstRows.push(ROW, ROW, null);
    const repository = makeRepository(database);

    await expect(repository.findById(CONNECTION.id)).resolves.toEqual(CONNECTION);
    await expect(
      repository.findByAuthTokenHash(CONNECTION.authTokenHash),
    ).resolves.toEqual(CONNECTION);
    await expect(
      repository.findByAuthTokenHash("c".repeat(64)),
    ).resolves.toBeNull();

    expect(database.calls[0]?.sql).toContain("WHERE id = ?1");
    expect(database.calls[0]?.bindings).toEqual([CONNECTION.id]);
    expect(database.calls[1]?.sql).toContain("WHERE auth_token_hash = ?1");
    expect(database.calls[1]?.bindings).toEqual([CONNECTION.authTokenHash]);
    expect(database.calls.map(({ sql }) => sql).join("\n")).not.toMatch(
      /plaintext|raw_token|password|private_key/iu,
    );
    expect(database.sessionConstraints).toEqual([
      "first-primary",
      "first-primary",
      "first-primary",
    ]);
  });

  it("guards revocation by exact household and reads back consistently", async () => {
    const database = new ScriptedD1Database();
    const revoked = { ...ROW, revoked_at: 1_300 };
    database.runChanges.push(1, 0);
    database.firstRows.push(revoked);
    const repository = makeRepository(database);

    await expect(
      repository.revokeByAuthTokenHash({
        authTokenHash: CONNECTION.authTokenHash,
        householdId: CONNECTION.householdId,
        revokedAt: 1_300,
      }),
    ).resolves.toEqual({ ...CONNECTION, revokedAt: 1_300 });
    await expect(
      repository.revokeByAuthTokenHash({
        authTokenHash: CONNECTION.authTokenHash,
        householdId: CONNECTION.householdId.toLowerCase(),
        revokedAt: 1_301,
      }),
    ).resolves.toBeNull();

    const update = database.calls[0];
    expect(update).toMatchObject({
      operation: "run",
      source: "session",
      bindings: [
        CONNECTION.authTokenHash,
        CONNECTION.householdId,
        1_300,
      ],
    });
    expect(update?.sql).toContain("WHERE auth_token_hash = ?1");
    expect(update?.sql).toContain("AND household_id = ?2");
    expect(update?.sql).toContain("AND revoked_at IS NULL");
    expect(update?.sql).not.toMatch(/lower|collate\s+nocase/iu);
    expect(database.calls[1]).toMatchObject({
      operation: "first",
      source: "session",
      bindings: [CONNECTION.authTokenHash, CONNECTION.householdId],
    });
    expect(database.calls).toHaveLength(3);
    expect(database.calls[2]).toMatchObject({
      operation: "run",
      source: "session",
      bindings: [
        CONNECTION.authTokenHash,
        CONNECTION.householdId.toLowerCase(),
        1_301,
      ],
    });
    expect(database.sessionConstraints).toEqual([
      "first-primary",
      "first-primary",
    ]);
  });

  it("rejects a successful revocation that cannot be read back", async () => {
    const database = new ScriptedD1Database();
    database.runChanges.push(1);
    database.firstRows.push(null);
    const repository = makeRepository(database);

    await expect(
      repository.revokeByAuthTokenHash({
        authTokenHash: CONNECTION.authTokenHash,
        householdId: CONNECTION.householdId,
        revokedAt: 1_300,
      }),
    ).rejects.toThrow(
      "D1 revoked a Sonos connection that could not be read back",
    );
  });
});
