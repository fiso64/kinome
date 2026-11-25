import type { PlaybackDefault, PlaybackLanguageDefaults, PlaybackPreferences } from '@shared/web-playback'
import { getDb } from '../client'
import { effectiveMetadataColumn } from '../item-metadata.sql'

interface PlaybackDefaultTarget extends PlaybackDefault {
  itemId: string
  seasonNumber: number
}

// A whole-item target uses -1. A numbered season belongs to its show so regrouping
// or switching between physical and generated season folders preserves the settings.
export const playbackDefaultsQuery = `
WITH RECURSIVE ancestry(id, parent_id, physical_kind, virtual_type, entity_id, depth) AS (
  SELECT id, parent_item_id, physical_kind, virtual_type, entity_id, 0 FROM media_items WHERE id = $itemId
  UNION ALL
  SELECT i.id, i.parent_item_id, i.physical_kind, i.virtual_type, i.entity_id, a.depth + 1
  FROM ancestry a JOIN media_items i ON i.id = a.parent_id
),
context AS MATERIALIZED (
  SELECT a.*, ${effectiveMetadataColumn('media_type')} AS media_type,
         ${effectiveMetadataColumn('season_number')} AS season_number
  FROM ancestry a
  LEFT JOIN media_entities e ON e.id = a.entity_id
  LEFT JOIN media_item_metadata m ON m.item_id = a.id
),
item AS (SELECT * FROM context WHERE depth = 0),
title AS (
  SELECT a.* FROM context a, item
  WHERE a.depth > 0 AND a.physical_kind = 'folder'
    AND a.media_type IN ('movie', 'tv')
    AND CASE item.media_type
      WHEN 'movie' THEN a.media_type = 'movie'
      WHEN 'episode' THEN a.media_type = 'tv'
      WHEN 'season' THEN a.media_type = 'tv'
      ELSE 1
    END
  ORDER BY a.depth LIMIT 1
),
season AS (
  SELECT a.* FROM context a
  WHERE a.depth > 0 AND a.physical_kind = 'folder' AND a.media_type = 'season'
    AND a.depth < COALESCE((SELECT depth FROM title), a.depth + 1)
  ORDER BY a.depth LIMIT 1
),
targets(scope, item_id, season_number, priority) AS (
  SELECT CASE WHEN item.physical_kind = 'file' THEN 'file'
              WHEN item.media_type = 'tv' THEN 'show'
              ELSE item.media_type END,
         CASE WHEN item.physical_kind <> 'file' AND item.media_type = 'season'
                   AND item.season_number >= 0 AND title.id IS NOT NULL
              THEN title.id ELSE item.id END,
         CASE WHEN item.physical_kind <> 'file' AND item.media_type = 'season'
                   AND item.season_number >= 0 AND title.id IS NOT NULL
              THEN item.season_number ELSE -1 END, 0
  FROM item LEFT JOIN title ON 1
  WHERE item.physical_kind = 'file' OR
    (item.media_type IN ('movie', 'tv', 'season') AND (item.physical_kind = 'folder' OR item.virtual_type = 'season'))
  UNION ALL
  SELECT 'season',
         CASE WHEN title.id IS NOT NULL AND COALESCE(item.season_number, season.season_number) >= 0
              THEN title.id ELSE season.id END,
         CASE WHEN title.id IS NOT NULL AND COALESCE(item.season_number, season.season_number) >= 0
              THEN COALESCE(item.season_number, season.season_number) ELSE -1 END, 1
  FROM item LEFT JOIN title ON 1 LEFT JOIN season ON 1
  WHERE item.physical_kind = 'file' AND item.media_type IS NOT 'movie'
    AND title.media_type IS NOT 'movie'
    AND (season.id IS NOT NULL OR (title.id IS NOT NULL AND item.media_type = 'episode' AND item.season_number >= 0))
  UNION ALL
  SELECT CASE WHEN title.media_type = 'tv' THEN 'show' ELSE 'movie' END, title.id, -1, 2
  FROM item, title WHERE item.physical_kind = 'file'
)
SELECT t.scope, t.item_id AS itemId, t.season_number AS seasonNumber,
       d.audio_language AS audioLanguage, d.subtitle_language AS subtitleLanguage
FROM targets t
LEFT JOIN playback_defaults d ON d.account_id = $accountId AND d.item_id = t.item_id
  AND d.season_number = t.season_number
WHERE t.item_id IS NOT NULL
ORDER BY t.priority
`

const NO_PREFERENCES: PlaybackPreferences = { audioLanguage: null, subtitleLanguage: null, subtitles: 'default' }

export function getPlaybackPreferences(accountId: string): PlaybackPreferences {
  return getDb().query<PlaybackPreferences, [string]>(`
    SELECT audio_language AS audioLanguage, subtitle_language AS subtitleLanguage, subtitle_mode AS subtitles
    FROM accounts WHERE id = ?
  `).get(accountId) ?? NO_PREFERENCES
}

export function writePlaybackPreferences(accountId: string, preferences: PlaybackPreferences): void {
  getDb().query('UPDATE accounts SET audio_language = ?, subtitle_language = ?, subtitle_mode = ? WHERE id = ?')
    .run(preferences.audioLanguage, preferences.subtitleLanguage, preferences.subtitles, accountId)
}

export function getPlaybackDefaults(itemId: string, accountId: string): PlaybackDefaultTarget[] {
  return getDb().query<PlaybackDefaultTarget, { $itemId: string; $accountId: string }>(playbackDefaultsQuery)
    .all({ $itemId: itemId, $accountId: accountId })
}

export function writePlaybackDefault(
  accountId: string, target: PlaybackDefaultTarget, changes: Partial<PlaybackLanguageDefaults>
): void {
  const db = getDb()
  const audio = changes.audioLanguage === undefined ? target.audioLanguage : changes.audioLanguage
  const subtitle = changes.subtitleLanguage === undefined ? target.subtitleLanguage : changes.subtitleLanguage
  if (audio === null && subtitle === null) {
    db.query('DELETE FROM playback_defaults WHERE account_id = ? AND item_id = ? AND season_number = ?')
      .run(accountId, target.itemId, target.seasonNumber)
    return
  }
  db.query(`
    INSERT INTO playback_defaults (account_id, item_id, season_number, audio_language, subtitle_language)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (account_id, item_id, season_number) DO UPDATE
    SET audio_language = excluded.audio_language, subtitle_language = excluded.subtitle_language
  `).run(accountId, target.itemId, target.seasonNumber, audio, subtitle)
}
