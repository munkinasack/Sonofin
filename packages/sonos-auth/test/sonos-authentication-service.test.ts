import { describe, expect, it } from "vitest";

import {
  MAX_SONOS_HOUSEHOLD_ID_CHARACTERS,
  SONOS_AUTH_TOKEN_PREFIX,
  SONOS_PRIVATE_KEY_PREFIX,
  SonosAuthenticationIntegrityError,
  SonosAuthenticationService,
  SonosAuthenticationValidationError,
  type NewSonosConnectionRecord,
  type RevokeSonosConnectionInput,
  type SonosAuthenticationValidationErrorCode,
  type SonosConnectionRecord,
  type SonosConnectionRepository,
} from "../src";

const SIGNING_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_SIGNING_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const LINK_ID = "a".repeat(64);
const OTHER_LINK_ID = "b".repeat(64);
const JELLYFIN_CONNECTION_ID = "J".repeat(32);
const OTHER_JELLYFIN_CONNECTION_ID = "K".repeat(32);
const HOUSEHOLD_ID = "  Sonos_HH:Case-Sensitive/é/🔊  ";

class MemorySonosConnectionRepository
  implements SonosConnectionRepository
{
  readonly records = new Map<string, SonosConnectionRecord>();
  readonly insertAttempts: NewSonosConnectionRecord[] = [];
  findByIdCalls = 0;
  findByHashCalls = 0;

  async insert(record: NewSonosConnectionRecord): Promise<boolean> {
    this.insertAttempts.push({ ...record });
    if (this.records.has(record.id)) {
      return false;
    }
    this.records.set(record.id, { ...record });
    return true;
  }

  async findById(id: string): Promise<SonosConnectionRecord | null> {
    this.findByIdCalls += 1;
    const record = this.records.get(id);
    return record === undefined ? null : { ...record };
  }

  async findByAuthTokenHash(
    authTokenHash: string,
  ): Promise<SonosConnectionRecord | null> {
    this.findByHashCalls += 1;
    const record = [...this.records.values()].find(
      (candidate) => candidate.authTokenHash === authTokenHash,
    );
    return record === undefined ? null : { ...record };
  }

  async revokeByAuthTokenHash(
    input: RevokeSonosConnectionInput,
  ): Promise<SonosConnectionRecord | null> {
    const entry = [...this.records.entries()].find(
      ([, candidate]) => candidate.authTokenHash === input.authTokenHash,
    );
    if (
      entry === undefined ||
      entry[1].householdId !== input.householdId ||
      entry[1].revokedAt !== null
    ) {
      return null;
    }

    const revoked = { ...entry[1], revokedAt: input.revokedAt };
    this.records.set(entry[0], revoked);
    return { ...revoked };
  }
}

function makeHarness(options?: {
  repository?: MemorySonosConnectionRepository;
  signingKey?: string;
  fallbackSigningKeys?: readonly string[];
  now?: () => number;
}) {
  const repository =
    options?.repository ?? new MemorySonosConnectionRepository();
  const service = new SonosAuthenticationService({
    repository,
    signingKey: options?.signingKey ?? SIGNING_KEY,
    ...(options?.fallbackSigningKeys === undefined
      ? {}
      : { fallbackSigningKeys: options.fallbackSigningKeys }),
    now: options?.now ?? (() => 1_000),
  });
  return { repository, service };
}

function issueInput(overrides?: {
  linkId?: string;
  householdId?: string;
  jellyfinConnectionId?: string;
}) {
  return {
    linkId: overrides?.linkId ?? LINK_ID,
    householdId: overrides?.householdId ?? HOUSEHOLD_ID,
    jellyfinConnectionId:
      overrides?.jellyfinConnectionId ?? JELLYFIN_CONNECTION_ID,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function expectValidationError(
  action: () => unknown | Promise<unknown>,
  code: SonosAuthenticationValidationErrorCode,
  secrets: readonly string[] = [],
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(SonosAuthenticationValidationError);
    expect(error).toMatchObject({
      code,
      name: "SonosAuthenticationValidationError",
    });
    const rendered = `${String(error)} ${(error as Error).stack ?? ""}`;
    for (const secret of secrets) {
      if (secret.length > 0) {
        expect(rendered).not.toContain(secret);
      }
    }
    return;
  }
  throw new Error(`Expected a validation error with code ${code}`);
}

describe("SonosAuthenticationService", () => {
  it("derives opaque domain-separated credentials and persists only the token hash", async () => {
    const { repository, service } = makeHarness();

    const issued = await service.issue(issueInput());
    expect(issued.outcome).toBe("success");
    if (issued.outcome !== "success") {
      throw new Error("Expected successful issuance");
    }

    expect(issued.authToken).toMatch(/^SF_[A-Za-z0-9_-]{43}$/u);
    expect(issued.privateKey).toMatch(
      /^SF_NO_REFRESH_[A-Za-z0-9_-]{43}$/u,
    );
    expect(issued.authToken).toBe(
      "SF_ozjYX2LcevlD-TiVOYELa_8qUGN3mAm8K7YHQhCPbhw",
    );
    expect(issued.privateKey).toBe(
      "SF_NO_REFRESH_MvprlTPiH_Nwk5M5EGeI2_tNkUbAh-Gv_HkVlCyYdDQ",
    );
    expect(issued.authToken.slice(SONOS_AUTH_TOKEN_PREFIX.length)).not.toBe(
      issued.privateKey.slice(SONOS_PRIVATE_KEY_PREFIX.length),
    );
    expect(issued.alreadyIssued).toBe(false);

    const record = repository.records.get(LINK_ID);
    expect(record).toEqual({
      id: LINK_ID,
      jellyfinConnectionId: JELLYFIN_CONNECTION_ID,
      householdId: HOUSEHOLD_ID,
      authTokenHash: await sha256Hex(issued.authToken),
      createdAt: 1_000,
      revokedAt: null,
    });
    const persisted = JSON.stringify(record);
    expect(persisted).not.toContain(issued.authToken);
    expect(persisted).not.toContain(issued.privateKey);
    expect(persisted).not.toContain(SIGNING_KEY);

    await expect(
      service.authenticate({
        authToken: issued.authToken,
        householdId: HOUSEHOLD_ID,
      }),
    ).resolves.toEqual({
      outcome: "success",
      connection: {
        id: LINK_ID,
        jellyfinConnectionId: JELLYFIN_CONNECTION_ID,
        householdId: HOUSEHOLD_ID,
      },
    });
  });

  it("replays the same credentials without changing their original creation time", async () => {
    const repository = new MemorySonosConnectionRepository();
    let now = 1_000;
    const { service } = makeHarness({ repository, now: () => now });

    const first = await service.issue(issueInput());
    now = 2_000;
    const replay = await service.issue(issueInput());

    expect(first.outcome).toBe("success");
    expect(replay.outcome).toBe("success");
    if (first.outcome !== "success" || replay.outcome !== "success") {
      throw new Error("Expected successful issuance and replay");
    }
    expect(replay).toEqual({ ...first, alreadyIssued: true });
    expect(repository.records.get(LINK_ID)?.createdAt).toBe(1_000);
    expect(repository.insertAttempts).toHaveLength(2);
    expect(repository.findByIdCalls).toBe(1);
  });

  it("replays an in-progress issuance across signing-key rotation", async () => {
    const repository = new MemorySonosConnectionRepository();
    const original = makeHarness({ repository }).service;
    const issued = await original.issue(issueInput());
    if (issued.outcome !== "success") {
      throw new Error("Expected successful original issuance");
    }

    const rotated = makeHarness({
      fallbackSigningKeys: [SIGNING_KEY],
      repository,
      signingKey: OTHER_SIGNING_KEY,
    }).service;
    await expect(rotated.issue(issueInput())).resolves.toEqual({
      ...issued,
      alreadyIssued: true,
    });

    const withoutFallbackKey = makeHarness({
      repository,
      signingKey: OTHER_SIGNING_KEY,
    }).service;
    await expect(
      withoutFallbackKey.issue(issueInput()),
    ).rejects.toBeInstanceOf(SonosAuthenticationIntegrityError);
    await expect(
      original.revoke({
        authToken: issued.authToken,
        householdId: HOUSEHOLD_ID,
      }),
    ).resolves.toBe(true);
    await expect(withoutFallbackKey.issue(issueInput())).resolves.toEqual({
      outcome: "failure",
      reason: "superseded",
    });

    const newUnderRotatedKey = await rotated.issue(
      issueInput({
        linkId: OTHER_LINK_ID,
        jellyfinConnectionId: OTHER_JELLYFIN_CONNECTION_ID,
      }),
    );
    const oldKeyNewLink = await makeHarness().service.issue(
      issueInput({
        linkId: OTHER_LINK_ID,
        jellyfinConnectionId: OTHER_JELLYFIN_CONNECTION_ID,
      }),
    );
    if (
      newUnderRotatedKey.outcome !== "success" ||
      oldKeyNewLink.outcome !== "success"
    ) {
      throw new Error("Expected successful rotated-key comparison");
    }
    expect(newUnderRotatedKey.authToken).not.toBe(oldKeyNewLink.authToken);

    const rolloutRepository = new MemorySonosConnectionRepository();
    const newGeneration = makeHarness({
      repository: rolloutRepository,
      signingKey: OTHER_SIGNING_KEY,
    }).service;
    const issuedByNewGeneration = await newGeneration.issue(issueInput());
    if (issuedByNewGeneration.outcome !== "success") {
      throw new Error("Expected successful new-generation issuance");
    }
    const stagedOldGeneration = makeHarness({
      fallbackSigningKeys: [OTHER_SIGNING_KEY],
      repository: rolloutRepository,
      signingKey: SIGNING_KEY,
    }).service;
    await expect(stagedOldGeneration.issue(issueInput())).resolves.toEqual({
      ...issuedByNewGeneration,
      alreadyIssued: true,
    });
  });

  it("makes concurrent matching issuance attempts converge on one credential", async () => {
    const { repository, service } = makeHarness();

    const results = await Promise.all([
      service.issue(issueInput()),
      service.issue(issueInput()),
      service.issue(issueInput()),
    ]);
    const successes = results.filter((result) => result.outcome === "success");

    expect(successes).toHaveLength(3);
    expect(new Set(successes.map((result) => result.authToken)).size).toBe(1);
    expect(new Set(successes.map((result) => result.privateKey)).size).toBe(1);
    expect(successes.map((result) => result.alreadyIssued).sort()).toEqual([
      false,
      true,
      true,
    ]);
    expect(repository.records.size).toBe(1);
  });

  it("binds derivation to the signing key and every immutable input", async () => {
    const baseline = await makeHarness().service.issue(issueInput());
    const otherKey = await makeHarness({
      signingKey: OTHER_SIGNING_KEY,
    }).service.issue(issueInput());
    const otherLink = await makeHarness().service.issue(
      issueInput({ linkId: OTHER_LINK_ID }),
    );
    const otherHousehold = await makeHarness().service.issue(
      issueInput({ householdId: `${HOUSEHOLD_ID}-other` }),
    );
    const otherJellyfin = await makeHarness().service.issue(
      issueInput({ jellyfinConnectionId: OTHER_JELLYFIN_CONNECTION_ID }),
    );
    const successes = [
      baseline,
      otherKey,
      otherLink,
      otherHousehold,
      otherJellyfin,
    ].filter((result) => result.outcome === "success");

    expect(successes).toHaveLength(5);
    expect(new Set(successes.map((result) => result.authToken)).size).toBe(5);
    expect(new Set(successes.map((result) => result.privateKey)).size).toBe(5);
  });

  it("uses generic authentication failures for malformed, unknown, revoked, and mismatched credentials", async () => {
    const { repository, service } = makeHarness();
    const issued = await service.issue(issueInput());
    if (issued.outcome !== "success") {
      throw new Error("Expected successful issuance");
    }

    await expect(
      service.authenticate({ authToken: "malformed", householdId: HOUSEHOLD_ID }),
    ).resolves.toEqual({ outcome: "failure" });
    expect(repository.findByHashCalls).toBe(0);

    await expect(
      service.authenticate({
        authToken: `${SONOS_AUTH_TOKEN_PREFIX}${"A".repeat(43)}`,
        householdId: HOUSEHOLD_ID,
      }),
    ).resolves.toEqual({ outcome: "failure" });
    await expect(
      service.authenticate({
        authToken: issued.authToken,
        householdId: HOUSEHOLD_ID.toLowerCase(),
      }),
    ).resolves.toEqual({ outcome: "failure" });
    await expect(
      service.authenticate({
        authToken: issued.authToken,
        householdId: HOUSEHOLD_ID.trim(),
      }),
    ).resolves.toEqual({ outcome: "failure" });

    expect(
      await service.revoke({
        authToken: issued.authToken,
        householdId: HOUSEHOLD_ID,
      }),
    ).toBe(true);
    await expect(
      service.authenticate({
        authToken: issued.authToken,
        householdId: HOUSEHOLD_ID,
      }),
    ).resolves.toEqual({ outcome: "failure" });
  });

  it("allows multiple credentials per household and revokes only the targeted one", async () => {
    const repository = new MemorySonosConnectionRepository();
    let now = 1_000;
    const { service } = makeHarness({ repository, now: () => now });
    const first = await service.issue(issueInput());
    now = 1_100;
    const second = await service.issue(
      issueInput({
        linkId: OTHER_LINK_ID,
        jellyfinConnectionId: OTHER_JELLYFIN_CONNECTION_ID,
      }),
    );
    if (first.outcome !== "success" || second.outcome !== "success") {
      throw new Error("Expected two successful issuances");
    }

    expect(repository.records.size).toBe(2);
    await expect(
      service.authenticate({
        authToken: first.authToken,
        householdId: HOUSEHOLD_ID,
      }),
    ).resolves.toMatchObject({ outcome: "success" });
    await expect(
      service.authenticate({
        authToken: second.authToken,
        householdId: HOUSEHOLD_ID,
      }),
    ).resolves.toMatchObject({ outcome: "success" });

    now = 1_200;
    expect(
      await service.revoke({
        authToken: first.authToken,
        householdId: HOUSEHOLD_ID.toLowerCase(),
      }),
    ).toBe(false);
    expect(
      await service.revoke({
        authToken: first.authToken,
        householdId: HOUSEHOLD_ID,
      }),
    ).toBe(true);
    expect(
      await service.revoke({
        authToken: first.authToken,
        householdId: HOUSEHOLD_ID,
      }),
    ).toBe(false);

    await expect(
      service.authenticate({
        authToken: first.authToken,
        householdId: HOUSEHOLD_ID,
      }),
    ).resolves.toEqual({ outcome: "failure" });
    await expect(
      service.authenticate({
        authToken: second.authToken,
        householdId: HOUSEHOLD_ID,
      }),
    ).resolves.toMatchObject({ outcome: "success" });
    await expect(service.issue(issueInput())).resolves.toEqual({
      outcome: "failure",
      reason: "superseded",
    });
  });

  it("rejects id collisions whose immutable mapping or token hash does not match", async () => {
    const { repository, service } = makeHarness();
    const issued = await service.issue(issueInput());
    if (issued.outcome !== "success") {
      throw new Error("Expected successful issuance");
    }
    const stored = repository.records.get(LINK_ID);
    if (stored === undefined) {
      throw new Error("Expected a stored record");
    }
    repository.records.set(LINK_ID, {
      ...stored,
      jellyfinConnectionId: OTHER_JELLYFIN_CONNECTION_ID,
    });

    await expect(service.issue(issueInput())).rejects.toMatchObject({
      name: "SonosAuthenticationIntegrityError",
      code: "integrity_failure",
    });
  });

  it("treats an insert conflict without a readable record as an integrity failure", async () => {
    const repository = new MemorySonosConnectionRepository();
    repository.insert = async () => false;
    const service = makeHarness({ repository }).service;

    await expect(service.issue(issueInput())).rejects.toBeInstanceOf(
      SonosAuthenticationIntegrityError,
    );
  });

  it("validates service options and exact canonical 32-byte signing keys", async () => {
    const repository = new MemorySonosConnectionRepository();
    const invalidKeys = [
      "",
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(43)}=`,
      `${"A".repeat(42)}!`,
      `${"A".repeat(42)}B`,
    ];
    for (const signingKey of invalidKeys) {
      await expectValidationError(
        () =>
          new SonosAuthenticationService({
            repository,
            now: () => 1_000,
            signingKey,
          }),
        "invalid_signing_key",
        [signingKey],
      );
    }

    for (const fallbackSigningKey of invalidKeys) {
      await expectValidationError(
        () =>
          new SonosAuthenticationService({
            now: () => 1_000,
            fallbackSigningKeys: [fallbackSigningKey],
            repository,
            signingKey: SIGNING_KEY,
          }),
        "invalid_signing_key",
        [fallbackSigningKey, SIGNING_KEY],
      );
    }

    await expectValidationError(
      () =>
        new SonosAuthenticationService({
          repository: {} as SonosConnectionRepository,
          now: () => 1_000,
          signingKey: SIGNING_KEY,
        }),
      "invalid_options",
      [SIGNING_KEY],
    );
    expect(
      new SonosAuthenticationService({
        repository,
        now: () => 1_000,
        signingKey: OTHER_SIGNING_KEY,
      }),
    ).toBeInstanceOf(SonosAuthenticationService);
  });

  it("rejects malformed issuance fields without exposing their values", async () => {
    const service = makeHarness().service;
    const malformedHousehold = "secret-household".repeat(100);
    const invalidInputs = [
      issueInput({ linkId: "A".repeat(64) }),
      issueInput({ linkId: "a".repeat(63) }),
      issueInput({ householdId: "" }),
      issueInput({ householdId: malformedHousehold }),
      issueInput({ householdId: "unpaired\ud800" }),
      issueInput({ jellyfinConnectionId: "J".repeat(31) }),
      issueInput({ jellyfinConnectionId: `${"J".repeat(31)}!` }),
    ];

    for (const input of invalidInputs) {
      await expectValidationError(
        () => service.issue(input),
        "invalid_input",
        [input.linkId, input.householdId, input.jellyfinConnectionId],
      );
    }

    await expect(
      service.issue(
        issueInput({
          householdId: "🎵".repeat(MAX_SONOS_HOUSEHOLD_ID_CHARACTERS),
        }),
      ),
    ).resolves.toMatchObject({ outcome: "success" });
  });

  it("rejects invalid or throwing clocks with credential-safe errors", async () => {
    const clockSecret = "clock-secret-must-not-escape";
    const invalidClocks: Array<() => number> = [
      () => -1,
      () => 1.5,
      () => Number.MAX_SAFE_INTEGER + 1,
      () => {
        throw new Error(clockSecret);
      },
    ];

    for (const now of invalidClocks) {
      const service = makeHarness({ now }).service;
      await expectValidationError(
        () => service.issue(issueInput()),
        "invalid_clock",
        [clockSecret, SIGNING_KEY],
      );
    }

    let now = 1_000;
    const service = makeHarness({ now: () => now }).service;
    const issued = await service.issue(issueInput());
    if (issued.outcome !== "success") {
      throw new Error("Expected successful issuance");
    }
    now = 999;
    await expectValidationError(
      () =>
        service.revoke({
          authToken: issued.authToken,
          householdId: HOUSEHOLD_ID,
        }),
      "invalid_clock",
      [issued.authToken, SIGNING_KEY],
    );
  });
});
