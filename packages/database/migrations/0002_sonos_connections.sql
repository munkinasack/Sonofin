CREATE TABLE sonos_connections (
  id TEXT PRIMARY KEY
    REFERENCES onboarding_links(id) ON DELETE RESTRICT
    CHECK (
      length(id) = 64
      AND id NOT GLOB '*[^0-9a-f]*'
    ),
  jellyfin_connection_id TEXT NOT NULL
    REFERENCES jellyfin_connections(id) ON DELETE RESTRICT
    CHECK (
      length(jellyfin_connection_id) = 32
      AND jellyfin_connection_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  household_id TEXT NOT NULL
    CHECK (length(household_id) BETWEEN 1 AND 255),
  auth_token_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(auth_token_hash) = 64
      AND auth_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
  created_at INTEGER NOT NULL
    CHECK (created_at BETWEEN 0 AND 9007199254740991),
  revoked_at INTEGER
    CHECK (
      revoked_at IS NULL
      OR revoked_at BETWEEN created_at AND 9007199254740991
    )
) STRICT;

CREATE TRIGGER sonos_connections_require_claimed_link
BEFORE INSERT ON sonos_connections
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM onboarding_links
  WHERE id = NEW.id
    AND claimed_at IS NOT NULL
    AND household_id = NEW.household_id
    AND jellyfin_connection_id = NEW.jellyfin_connection_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Sonos connection must match its claimed onboarding link'
  );
END;

CREATE TRIGGER sonos_connections_preserve_claimed_link
BEFORE UPDATE OF id, jellyfin_connection_id, household_id ON sonos_connections
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM onboarding_links
  WHERE id = NEW.id
    AND claimed_at IS NOT NULL
    AND household_id = NEW.household_id
    AND jellyfin_connection_id = NEW.jellyfin_connection_id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Sonos connection must match its claimed onboarding link'
  );
END;

CREATE INDEX sonos_connections_household_id_idx
  ON sonos_connections (household_id);

CREATE INDEX sonos_connections_jellyfin_connection_id_idx
  ON sonos_connections (jellyfin_connection_id);
