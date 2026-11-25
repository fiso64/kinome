/**
 * Sign-in sessions and API keys. Only a hash of each token is stored.
 * The id is a non-secret handle for listing and revoking a token.
 */
export const AUTH_TOKENS_SQL = `
CREATE TABLE IF NOT EXISTS auth_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('session', 'api_key')),
    -- API key name, or the client application of a session
    name TEXT,
    device_id TEXT,
    device_name TEXT,
    client_version TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_account ON auth_tokens(account_id, kind);
`
