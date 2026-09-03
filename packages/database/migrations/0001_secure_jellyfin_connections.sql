CREATE TABLE jellyfin_connections (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 32
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  server_url TEXT NOT NULL
    CHECK (
      length(server_url) BETWEEN 1 AND 2048
      AND length(trim(server_url)) >= 1
    ),
  server_id TEXT NOT NULL
    CHECK (
      length(server_id) BETWEEN 1 AND 255
      AND length(trim(server_id)) >= 1
    ),
  server_name TEXT NOT NULL
    CHECK (
      length(server_name) BETWEEN 1 AND 255
      AND length(trim(server_name)) >= 1
    ),
  server_version TEXT NOT NULL
    CHECK (
      length(server_version) BETWEEN 1 AND 255
      AND length(trim(server_version)) >= 1
    ),
  user_id TEXT NOT NULL
    CHECK (
      length(user_id) BETWEEN 1 AND 255
      AND length(trim(user_id)) >= 1
    ),
  username TEXT NOT NULL
    CHECK (
      length(username) BETWEEN 1 AND 255
      AND length(trim(username)) >= 1
    ),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 255
      AND length(trim(device_id)) >= 1
    ),
  token_algorithm TEXT NOT NULL
    CHECK (token_algorithm = 'A256GCM'),
  encrypted_token TEXT NOT NULL
    CHECK (
      length(encrypted_token) BETWEEN 22 AND 22000
      AND length(encrypted_token) % 4 != 1
      AND encrypted_token NOT GLOB '*[^A-Za-z0-9_-]*'
      AND (
        length(encrypted_token) % 4 = 0
        OR (
          length(encrypted_token) % 4 = 2
          AND substr(encrypted_token, -1) GLOB '[AQgw]'
        )
        OR (
          length(encrypted_token) % 4 = 3
          AND substr(encrypted_token, -1) GLOB '[AEIMQUYcgkosw048]'
        )
      )
    ),
  token_nonce TEXT NOT NULL
    CHECK (
      length(token_nonce) = 16
      AND token_nonce NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  created_at INTEGER NOT NULL
    CHECK (created_at BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TABLE onboarding_links_m4 (
  id TEXT NOT NULL UNIQUE
    CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  link_code_hash TEXT PRIMARY KEY
    CHECK (
      length(link_code_hash) = 64
      AND link_code_hash NOT GLOB '*[^0-9a-f]*'
    ),
  link_device_id_hash TEXT NOT NULL
    CHECK (
      length(link_device_id_hash) = 64
      AND link_device_id_hash NOT GLOB '*[^0-9a-f]*'
    ),
  household_id TEXT NOT NULL
    CHECK (length(household_id) BETWEEN 1 AND 255),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  claimed_at INTEGER,
  jellyfin_connection_id TEXT
    REFERENCES jellyfin_connections(id) ON DELETE RESTRICT
    CHECK (
      jellyfin_connection_id IS NULL
      OR (
        length(jellyfin_connection_id) = 32
        AND jellyfin_connection_id NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  CHECK (expires_at - created_at BETWEEN 420 AND 3600),
  CHECK (
    completed_at IS NULL
    OR (completed_at >= created_at AND completed_at < expires_at)
  ),
  CHECK (
    claimed_at IS NULL
    OR (
      completed_at IS NOT NULL
      AND claimed_at >= completed_at
      AND claimed_at < expires_at
    )
  ),
  CHECK (
    (completed_at IS NULL AND jellyfin_connection_id IS NULL)
    OR
    (completed_at IS NOT NULL AND jellyfin_connection_id IS NOT NULL)
  )
) STRICT;

INSERT INTO onboarding_links_m4 (
  id,
  link_code_hash,
  link_device_id_hash,
  household_id,
  created_at,
  expires_at
)
SELECT
  id,
  link_code_hash,
  link_device_id_hash,
  household_id,
  created_at,
  expires_at
FROM onboarding_links;

DROP TABLE onboarding_links;

ALTER TABLE onboarding_links_m4 RENAME TO onboarding_links;

CREATE INDEX onboarding_links_expires_at_idx
  ON onboarding_links (expires_at);

CREATE INDEX onboarding_links_jellyfin_connection_id_idx
  ON onboarding_links (jellyfin_connection_id);
