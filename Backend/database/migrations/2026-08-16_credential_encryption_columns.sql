-- ─────────────────────────────────────────────────────────────────────────────
--  Schema support for application-wide credential encryption
--  (CredentialEncryptionService, app/services/common/credential_encryption_service.py).
--
--  1. Widen every column that now holds AES-256-GCM ciphertext instead of a
--     raw password/SSH password — ciphertext (base64, plus the "enc:v1:"
--     envelope prefix) is longer than the plaintext it replaces, so a
--     String(500) column can overflow for a long password. TEXT is
--     unbounded and this is a pure widen: no data is touched or lost.
--  2. Add the `*_hash` lookup columns for bearer tokens (agent enrollment
--     tokens), which are HASHED (HMAC-SHA256), not encrypted — see
--     credential_encryption_service.py's module docstring for why a
--     reversible cipher can't back an equality WHERE-clause lookup.
--
--  Existing plaintext data is NOT touched by this file — it only changes
--  column shape. The actual encryption of existing rows (and backfilling
--  the new *_hash columns from each row's current token) happens in
--  app/scripts/migrate_credentials_to_encrypted.py, which must be run once
--  after this file. Both this file and that script are idempotent — safe
--  to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- connection_master: DB password + SSH password
ALTER TABLE connection_master ALTER COLUMN password TYPE TEXT;
ALTER TABLE connection_master ALTER COLUMN ssh_password TYPE TEXT;

-- os_servers: SSH password (encrypted) + agent enrollment token (hashed)
ALTER TABLE os_servers ALTER COLUMN ssh_password TYPE TEXT;
ALTER TABLE os_servers ADD COLUMN IF NOT EXISTS agent_token_hash TEXT;
CREATE INDEX IF NOT EXISTS ix_os_servers_agent_token_hash ON os_servers (agent_token_hash);

-- agent_tokens: enrollment token (hashed)
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ix_agent_tokens_token_hash ON agent_tokens (token_hash);

-- agent_db_targets: DB password (encrypted) + lookup token (hashed)
ALTER TABLE agent_db_targets ALTER COLUMN password TYPE TEXT;
ALTER TABLE agent_db_targets ADD COLUMN IF NOT EXISTS token_hash TEXT;
CREATE INDEX IF NOT EXISTS ix_agent_db_targets_token_hash ON agent_db_targets (token_hash);

-- smtp_configs: legacy plaintext SMTP password column, now also encrypted at rest
-- (smtp_password_enc already existed and was already Fernet-encrypted before this change).
ALTER TABLE smtp_configs ALTER COLUMN smtp_password TYPE TEXT;

-- Per-engine report-schedule SMTP passwords (4 identical, previously-unencrypted columns).
ALTER TABLE postgres_report_schedules ALTER COLUMN smtp_password TYPE TEXT;
ALTER TABLE mysql_report_schedules    ALTER COLUMN smtp_password TYPE TEXT;
ALTER TABLE mssql_report_schedules    ALTER COLUMN smtp_password TYPE TEXT;
ALTER TABLE oracle_report_schedules   ALTER COLUMN smtp_password TYPE TEXT;
