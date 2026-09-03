import { describe, expect, it } from "vitest";

import { D1LinkRepository } from "../src";

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

const ROW = {
  id: "a".repeat(64),
  link_code_hash: "b".repeat(64),
  link_device_id_hash: "c".repeat(64),
  household_id: "HH:Opaque",
  created_at: 1_000,
  expires_at: 1_420,
  completed_at: null,
  claimed_at: null,
  jellyfin_connection_id: null,
};

function makeRepository(database: ScriptedD1Database): D1LinkRepository {
  return new D1LinkRepository(database as unknown as D1Database);
}

describe("D1LinkRepository", () => {
  it("inserts a pending link with numbered parameters and reports collisions", async () => {
    const database = new ScriptedD1Database();
    database.runChanges.push(1, 0);
    const repository = makeRepository(database);
    const pending = {
      id: ROW.id,
      linkCodeHash: ROW.link_code_hash,
      linkDeviceIdHash: ROW.link_device_id_hash,
      householdId: ROW.household_id,
      createdAt: ROW.created_at,
      expiresAt: ROW.expires_at,
    };

    await expect(repository.insertPending(pending)).resolves.toBe(true);
    await expect(repository.insertPending(pending)).resolves.toBe(false);

    const first = database.calls[0];
    expect(first?.operation).toBe("run");
    expect(first?.source).toBe("database");
    expect(first?.sql).toContain("INSERT INTO onboarding_links");
    expect(first?.sql).toContain("ON CONFLICT DO NOTHING");
    expect(first?.sql).not.toContain("INSERT OR IGNORE");
    for (let index = 1; index <= 6; index += 1) {
      expect(first?.sql).toContain(`?${index}`);
    }
    expect(first?.bindings).toEqual([
      ROW.id,
      ROW.link_code_hash,
      ROW.link_device_id_hash,
      ROW.household_id,
      ROW.created_at,
      ROW.expires_at,
    ]);
    expect(database.sessionConstraints).toEqual([]);
  });

  it("reads and maps an onboarding link without selecting raw secrets", async () => {
    const database = new ScriptedD1Database();
    database.firstRows.push(ROW);
    const repository = makeRepository(database);

    await expect(
      repository.findByLinkCodeHash(ROW.link_code_hash),
    ).resolves.toEqual({
      id: ROW.id,
      linkCodeHash: ROW.link_code_hash,
      linkDeviceIdHash: ROW.link_device_id_hash,
      householdId: ROW.household_id,
      createdAt: ROW.created_at,
      expiresAt: ROW.expires_at,
      completedAt: null,
      claimedAt: null,
      jellyfinConnectionId: null,
    });

    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.operation).toBe("first");
    expect(database.calls[0]?.source).toBe("session");
    expect(database.calls[0]?.sql).toContain("WHERE link_code_hash = ?1");
    expect(database.calls[0]?.bindings).toEqual([ROW.link_code_hash]);
    expect(database.sessionConstraints).toEqual(["first-primary"]);
  });

  it("atomically completes only an active pending row, then returns it", async () => {
    const database = new ScriptedD1Database();
    database.runChanges.push(1);
    database.firstRows.push({
      ...ROW,
      completed_at: 1_100,
      jellyfin_connection_id: "jf-1",
    });
    const repository = makeRepository(database);

    await expect(
      repository.completePending({
        linkCodeHash: ROW.link_code_hash,
        completedAt: 1_100,
        jellyfinConnectionId: "jf-1",
      }),
    ).resolves.toMatchObject({
      outcome: "updated",
      link: {
        completedAt: 1_100,
        jellyfinConnectionId: "jf-1",
      },
    });

    const update = database.calls[0];
    expect(update?.operation).toBe("run");
    expect(update?.source).toBe("session");
    expect(update?.sql).toContain("completed_at IS NULL");
    expect(update?.sql).toContain("claimed_at IS NULL");
    expect(update?.sql).toContain("expires_at > ?2");
    expect(update?.bindings).toEqual([ROW.link_code_hash, 1_100, "jf-1"]);
    expect(database.calls[1]?.operation).toBe("first");
    expect(database.calls[1]?.source).toBe("session");
    expect(database.sessionConstraints).toEqual(["first-primary"]);
  });

  it("returns the current row when guarded completion does not change it", async () => {
    const database = new ScriptedD1Database();
    database.runChanges.push(0);
    database.firstRows.push({
      ...ROW,
      completed_at: 1_050,
      jellyfin_connection_id: "jf-existing",
    });
    const repository = makeRepository(database);

    await expect(
      repository.completePending({
        linkCodeHash: ROW.link_code_hash,
        completedAt: 1_100,
        jellyfinConnectionId: "jf-other",
      }),
    ).resolves.toMatchObject({
      outcome: "unchanged",
      link: { jellyfinConnectionId: "jf-existing" },
    });
    expect(database.sessionConstraints).toEqual(["first-primary"]);
  });

  it("claims a completed row once with a guarded numbered update", async () => {
    const database = new ScriptedD1Database();
    database.runChanges.push(1);
    database.firstRows.push({
      ...ROW,
      completed_at: 1_100,
      claimed_at: 1_200,
      jellyfin_connection_id: "jf-1",
    });
    const repository = makeRepository(database);

    await expect(
      repository.claimCompleted({
        linkCodeHash: ROW.link_code_hash,
        claimedAt: 1_200,
      }),
    ).resolves.toMatchObject({
      outcome: "updated",
      link: { claimedAt: 1_200 },
    });

    const update = database.calls[0];
    expect(update?.source).toBe("session");
    expect(update?.sql).toContain("SET claimed_at = ?2");
    expect(update?.sql).toContain("completed_at IS NOT NULL");
    expect(update?.sql).toContain("claimed_at IS NULL");
    expect(update?.sql).toContain("expires_at > ?2");
    expect(update?.bindings).toEqual([ROW.link_code_hash, 1_200]);
    expect(database.calls[1]?.source).toBe("session");
    expect(database.sessionConstraints).toEqual(["first-primary"]);
  });
});
