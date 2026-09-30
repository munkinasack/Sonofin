import type { JellyfinConnection } from "@sonofin/jellyfin-client";

const USER_ID_HASH_DOMAIN =
  "sonofin/smapi/get-user-info/user-id-hash-code/sha256/v1";

type JellyfinUserIdentity = Pick<
  JellyfinConnection,
  "serverId" | "userId"
>;

/**
 * Produces the stable, non-identifying value Sonos uses for account matching.
 * The Jellyfin server ID keeps equal user IDs on different servers distinct;
 * neither source identifier is exposed in the resulting SOAP response.
 */
export async function deriveSonosUserIdHashCode(
  identity: JellyfinUserIdentity,
): Promise<string> {
  const canonicalIdentity = JSON.stringify([
    USER_ID_HASH_DOMAIN,
    identity.serverId,
    identity.userId,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalIdentity),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
