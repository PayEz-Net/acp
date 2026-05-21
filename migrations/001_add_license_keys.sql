-- Migration: Free-tier license key table for ACP soft launch
-- Run against VibeSQL server (e.g., via psql or VibeSQL /v1/query endpoint)

CREATE TABLE IF NOT EXISTS vibe.license_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash      VARCHAR(64) NOT NULL UNIQUE,
  key_prefix    VARCHAR(8)  NOT NULL,
  tier          VARCHAR(32) NOT NULL DEFAULT 'free_year',
  status        VARCHAR(16) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','redeemed','revoked','expired')),
  redeemed_by   VARCHAR(256),
  redeemed_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  revoke_reason TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  created_by    VARCHAR(64) DEFAULT 'batch_script'
);

CREATE INDEX IF NOT EXISTS idx_license_keys_hash   ON vibe.license_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_license_keys_status ON vibe.license_keys(status);
CREATE INDEX IF NOT EXISTS idx_license_keys_prefix ON vibe.license_keys(key_prefix);
