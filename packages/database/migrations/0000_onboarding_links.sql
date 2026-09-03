CREATE TABLE onboarding_links (
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
  fake_jellyfin_connection_id TEXT
    CHECK (
      fake_jellyfin_connection_id IS NULL
      OR length(fake_jellyfin_connection_id) BETWEEN 1 AND 255
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
    (completed_at IS NULL AND fake_jellyfin_connection_id IS NULL)
    OR
    (completed_at IS NOT NULL AND fake_jellyfin_connection_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX onboarding_links_expires_at_idx
  ON onboarding_links (expires_at);
