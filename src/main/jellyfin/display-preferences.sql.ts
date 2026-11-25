/** Jellyfin client settings, stored as the client sent them. Owned by the Jellyfin adapter. */
export const DISPLAY_PREFERENCES_SQL = `
CREATE TABLE IF NOT EXISTS jellyfin_display_preferences (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    client TEXT NOT NULL,
    preferences_id TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, client, preferences_id)
) WITHOUT ROWID;
`
