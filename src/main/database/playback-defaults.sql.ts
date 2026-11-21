export const PLAYBACK_DEFAULTS_SQL = `
CREATE TABLE IF NOT EXISTS playback_defaults (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE ON UPDATE CASCADE,
  season_number INTEGER NOT NULL CHECK (season_number >= -1),
  audio_language TEXT,
  subtitle_language TEXT,
  PRIMARY KEY (account_id, item_id, season_number)
) WITHOUT ROWID;
`
