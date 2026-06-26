import { tableExists } from './sqlite-helpers'
import type { Migration } from './types'

function recreateUserState(db: any): void {
  if (!tableExists(db, 'user_state')) return
  db.exec(`
    ALTER TABLE user_state RENAME TO user_state_old;

    CREATE TABLE user_state (
      item_id TEXT,
      user_id TEXT DEFAULT 'default',
      watched INTEGER DEFAULT 0,
      last_watched_at INTEGER,
      continue_watching_dismissed INTEGER DEFAULT 0,
      next_up_dismissed INTEGER DEFAULT 0,
      next_up_episode_id TEXT,
      PRIMARY KEY (item_id, user_id),
      FOREIGN KEY(item_id) REFERENCES media_items(id) ON DELETE CASCADE ON UPDATE CASCADE
    );

    INSERT INTO user_state (
      item_id, user_id, watched, last_watched_at,
      continue_watching_dismissed, next_up_dismissed, next_up_episode_id
    )
    SELECT
      item_id, user_id, watched, last_watched_at,
      continue_watching_dismissed, next_up_dismissed, next_up_episode_id
    FROM user_state_old
    WHERE EXISTS (SELECT 1 FROM media_items WHERE id = user_state_old.item_id);

    DROP TABLE user_state_old;
  `)
}

function recreateFolderSettings(db: any): void {
  if (!tableExists(db, 'folder_settings')) return
  db.exec(`
    ALTER TABLE folder_settings RENAME TO folder_settings_old;

    CREATE TABLE folder_settings (
      item_id TEXT PRIMARY KEY,
      view_settings_json TEXT,
      applied_grouping TEXT,
      retrieve_children_metadata INTEGER NOT NULL DEFAULT 0,
      children_type_hint TEXT,
      process_tv_children INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(item_id) REFERENCES media_items(id) ON DELETE CASCADE ON UPDATE CASCADE
    );

    INSERT INTO folder_settings (
      item_id, view_settings_json, applied_grouping,
      retrieve_children_metadata, children_type_hint, process_tv_children
    )
    SELECT
      item_id, view_settings_json, applied_grouping,
      retrieve_children_metadata, children_type_hint, process_tv_children
    FROM folder_settings_old
    WHERE EXISTS (SELECT 1 FROM media_items WHERE id = folder_settings_old.item_id);

    DROP TABLE folder_settings_old;
  `)
}

function recreateAccountVisibleItems(db: any): void {
  if (!tableExists(db, 'account_visible_items')) return
  db.exec(`
    ALTER TABLE account_visible_items RENAME TO account_visible_items_old;

    CREATE TABLE account_visible_items (
      account_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      PRIMARY KEY (account_id, item_id),
      FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES media_items(id) ON DELETE CASCADE
    );

    INSERT INTO account_visible_items (account_id, item_id)
    SELECT account_id, item_id
    FROM account_visible_items_old
    WHERE EXISTS (SELECT 1 FROM media_items WHERE id = account_visible_items_old.item_id);

    DROP TABLE account_visible_items_old;

    CREATE INDEX IF NOT EXISTS idx_account_visible_items_account
      ON account_visible_items(account_id);
  `)
}

export const migration: Migration = {
  version: 4,
  name: 'retarget item state foreign keys to media_items',
  up: (db) => {
    recreateUserState(db)
    recreateFolderSettings(db)
    recreateAccountVisibleItems(db)
  }
}
