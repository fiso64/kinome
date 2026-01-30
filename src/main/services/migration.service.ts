import * as repositoryService from './repository.service'
import { parseEpisodeInfo, parseSeasonFolder } from '../utils/tv-parser'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Migration Service] ${message}`)
}

export async function migrateTvStructure(): Promise<void> {
  log('Starting TV Structure Migration (V2)...')
  const db = repositoryService.getDb()

  // 1. Identify files that might be episodes but have no metadata
  // In V2, we rely on metadata table for season/episode info.
  // Query items joined with metadata where media_type IS NULL

  // Note: SQLite REGEXP might not be available by default.
  // If not, we iterate all files. Let's do all files to be safe, it's a one-time thing.

  const allFiles = db
    .prepare(
      `
        SELECT i.id, i.name, i.parent_id 
        FROM items i
        LEFT JOIN metadata m ON i.id = m.item_id
        WHERE i.type = 'file' 
          AND (m.media_type IS NULL OR m.season_number IS NULL OR m.episode_number IS NULL)
    `
    )
    .all() as { id: string; name: string; parent_id: string }[]

  log(`Found ${allFiles.length} files to check for TV structure...`)

  repositoryService.runTransaction(() => {
    let updateCount = 0
    for (const file of allFiles) {
      const epInfo = parseEpisodeInfo(file.name)
      if (epInfo) {
        const { season, episode } = epInfo
        // Upsert metadata
        db.prepare(
          `
                    INSERT INTO metadata (item_id, media_type, season_number, episode_number)
                    VALUES (@id, 'episode', @season, @episode)
                    ON CONFLICT(item_id) DO UPDATE SET
                       media_type = 'episode',
                       season_number = COALESCE(excluded.season_number, season_number),
                       episode_number = excluded.episode_number
                 `
        ).run({ id: file.id, season: season || null, episode })
        updateCount++
      }
    }
    log(`Migrated ${updateCount} episodes.`)
  })

  // 2. Identify Season Folders
  const allFolders = db
    .prepare(
      `
        SELECT i.id, i.name
        FROM items i
        LEFT JOIN metadata m ON i.id = m.item_id
        WHERE i.type = 'folder'
          AND (m.media_type IS NULL OR m.season_number IS NULL)
    `
    )
    .all() as { id: string; name: string }[]

  repositoryService.runTransaction(() => {
    let updateCount = 0
    for (const folder of allFolders) {
      const sNum = parseSeasonFolder(folder.name)
      if (sNum !== null) {
        db.prepare(
          `
                    INSERT INTO metadata (item_id, media_type, season_number)
                    VALUES (@id, 'season', @season)
                    ON CONFLICT(item_id) DO UPDATE SET
                       media_type = 'season',
                       season_number = excluded.season_number
                 `
        ).run({ id: folder.id, season: sNum })
        updateCount++
      }
    }
    log(`Migrated ${updateCount} season folders.`)
  })

  // 3. Identify TV Show Folders
  // A folder is likely a TV show if it contains "Season X" folders or is parent to many episodes
  const potentialShows = db
    .prepare(
      `
        SELECT i.id, i.name
        FROM items i
        LEFT JOIN metadata m ON i.id = m.item_id
        WHERE i.type = 'folder'
          AND (m.media_type IS NULL OR m.media_type = 'folder')
    `
    )
    .all() as { id: string; name: string }[]

  repositoryService.runTransaction(() => {
    let updateCount = 0
    for (const show of potentialShows) {
      // Check children
      const childrenMetas = db
        .prepare(
          `
                SELECT m.media_type, m.season_number
                FROM items i
                JOIN metadata m ON i.id = m.item_id
                WHERE i.parent_id = ?
            `
        )
        .all(show.id) as { media_type: string; season_number: number | null }[]

      const hasSeasons = childrenMetas.some(
        (m) => m.media_type === 'season' || m.season_number !== null
      )
      const episodeCount = childrenMetas.filter((m) => m.media_type === 'episode').length

      if (hasSeasons || episodeCount > 2) {
        db.prepare(
          `
                    INSERT INTO metadata (item_id, media_type)
                    VALUES (@id, 'tv')
                    ON CONFLICT(item_id) DO UPDATE SET
                       media_type = 'tv'
                 `
        ).run({ id: show.id })
        updateCount++
      }
    }
    log(`Identified ${updateCount} TV Shows.`)
  })
}
