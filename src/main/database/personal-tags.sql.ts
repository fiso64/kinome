/** Tags an account sets on an item for itself, such as favorite:true. Other accounts do not see them. */
export const PERSONAL_TAGS_SQL = `
CREATE TABLE IF NOT EXISTS account_item_tags (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE ON UPDATE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (account_id, item_id, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_account_item_tags_value ON account_item_tags(account_id, key, value, item_id);
`
