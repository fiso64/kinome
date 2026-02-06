import { getDb, runTransaction } from './repository.service'
import type { SearchIndexEntry } from '@shared/types'

// Rebuilds the FTS index from scratch. Useful for migration or corruption recovery.
export function rebuildSearchIndex() {
  const db = getDb()
  console.log('[Search] Rebuilding FTS index...')
  runTransaction(() => {
    db.prepare('DELETE FROM items_fts').run()
    db.prepare(
      `
      INSERT INTO items_fts (id, name, title, original_title, overview, people, tags)
      SELECT 
        i.id, i.name, 
        m.title, m.original_title, m.overview, m.people_json, 
        m.tags_json || ' ' || coalesce(m.virtual_tags_json, '')
      FROM items i
      LEFT JOIN metadata m ON i.id = m.item_id
    `
    ).run()
  })
  console.log('[Search] FTS index rebuild complete.')
}

/**
 * Initializes the search index. Checks if FTS is populated, and rebuilds if empty but items exist.
 */
export function buildFullSearchIndex(_items?: any[]) {
  const db = getDb()
  try {
    const count = db.prepare('SELECT count(*) as c FROM items_fts').get() as { c: number }
    const itemCount = db.prepare('SELECT count(*) as c FROM items').get() as { c: number }

    if (count.c === 0 && itemCount.c > 0) {
      console.log('[Search] FTS index is empty but items exist. Triggering rebuild.')
      rebuildSearchIndex()
    }
  } catch (e) {
    console.error('[Search] Failed to check/build FTS index:', e)
  }
}

export function updateIndexForItems(_items: any[]) {
  // Handled by SQL triggers. No-op.
}

export function removeItemFromIndex(_itemId: string) {
  // Handled by SQL triggers. No-op.
}

function normalizeText(text: string): string {
  // Remove special FTS5 chars to prevent syntax errors
  return text.replace(/["*]/g, '').trim()
}

/**
 * Generates trigrams from a string for fuzzy matching.
 * e.g., "hello" -> "hel", "ell", "llo"
 */
function toTrigrams(text: string): string[] {
  if (text.length < 3) return []
  const trigrams: string[] = []
  for (let i = 0; i < text.length - 2; i++) {
    trigrams.push(text.substring(i, i + 3))
  }
  return trigrams
}

export function performSearch(query: {
  text: string
  tags: { key: string; value: string }[]
  limit?: number
}): SearchIndexEntry[] {
  const db = getDb()
  const { text, tags } = query
  const limit = query.limit || 30
  const params: any = {}
  let sql = ''

  // 1. Text Search Logic
  if (text.trim()) {
    const normalized = normalizeText(text)

    if (normalized.length < 3) {
      // --- Short Query Strategy (LIKE) ---
      // Prioritize: Title StartsWith > Title Contains > Name StartsWith > Name Contains
      sql = `
          SELECT 
            i.id, i.type, i.name, i.path,
            m.title, m.overview, m.media_type, m.year, m.genres_json, m.tags_json, m.images_json,
            m.people_json, m.episode_number, m.virtual_tags_json,
            u.watched,
            0 as rank,
            0 as static_score
          FROM items i
          LEFT JOIN metadata m ON i.id = m.item_id
          LEFT JOIN user_state u ON i.id = u.item_id
          WHERE (i.name LIKE @likeQuery OR m.title LIKE @likeQuery)
        `
      params['@likeQuery'] = `%${normalized}%`
      params['@startQuery'] = `${normalized.toLowerCase()}%`

      sql += ` ORDER BY 
          CASE WHEN m.media_type IN ('movie', 'tv') THEN 1 ELSE 2 END ASC,
          CASE 
            WHEN lower(coalesce(m.title, '')) LIKE @startQuery THEN 1 
            WHEN lower(coalesce(m.title, '')) LIKE @likeQuery THEN 2 
            WHEN lower(i.name) LIKE @startQuery THEN 3 
            ELSE 4 
          END ASC, 
          m.title ASC, i.name ASC LIMIT ${limit}`
    } else {
      // --- Long Query Strategy (FTS Trigram) ---

      // Base Query Structure
      const buildFtsQuery = (matchQuery: string) => `
          SELECT 
            i.id, i.type, i.name, i.path,
            m.title, m.overview, m.media_type, m.year, m.genres_json, m.tags_json, m.images_json,
            m.people_json, m.episode_number, m.virtual_tags_json,
            u.watched,
            items_fts.rank,
            0 as static_score
          FROM items_fts
          JOIN items i ON items_fts.id = i.id
          LEFT JOIN metadata m ON i.id = m.item_id
          LEFT JOIN user_state u ON i.id = u.item_id
          WHERE items_fts MATCH ${matchQuery}
        `

      // Columns to search in. We explicitly EXCLUDE 'overview' to avoid noise.
      const cols = '{title original_title name people tags}'

      // --- Unified Execution Flow ---

      let finalSql = buildFtsQuery('@ftsQuery')

      // Append Tags
      tags.forEach((tag, idx) => {
        const pKey = `@tagVal${idx}`
        const tagValue = tag.value.toLowerCase()
        if (tag.key === 'mediaType') {
          finalSql += ` AND m.media_type = ${pKey}`
          params[pKey] = tagValue
        } else if (tag.key === 'year') {
          finalSql += ` AND m.year = ${pKey}`
          params[pKey] = parseInt(tagValue) || 0
        } else if (tag.key === 'genre') {
          finalSql += ` AND lower(m.genres_json) LIKE ${pKey}`
          params[pKey] = `%"${tagValue}"%`
        } else if (tag.key === 'person') {
          finalSql += ` AND lower(m.people_json) LIKE ${pKey}`
          params[pKey] = `%"${tagValue}"%`
        } else {
          const pValKey = `@tagVal${idx}`
          const pValLikeKey = `@tagValLike${idx}`
          const pPathKey = `@tagPath${idx}`
          params[pValKey] = tagValue
          params[pValLikeKey] = `%${tagValue}%`
          params[pPathKey] = `$.${tag.key}`
          finalSql += ` AND (
                    lower(json_extract(m.tags_json, ${pPathKey})) = ${pValKey} OR 
                    lower(json_extract(m.tags_json, ${pPathKey})) LIKE ${pValLikeKey} OR
                    lower(json_extract(m.virtual_tags_json, ${pPathKey})) = ${pValKey}
                )`
        }
      })

      finalSql += ` ORDER BY (CASE WHEN m.media_type IN ('movie', 'tv') THEN 0 ELSE 1 END) ASC, bm25(items_fts, 0.0, 10.0, 5.0, 1.0, 0.5, 0.5, 0.5) ASC LIMIT ${limit}`

      // Execute Standard
      sql = finalSql
      params['@ftsQuery'] = `${cols} : "${normalized}"`

      try {
        let results = db.prepare(sql).all(params) as any[]

        // Fuzzy Fallback
        if (results.length === 0) {
          const trigrams = toTrigrams(normalized)
          if (trigrams.length > 0) {
            const fuzzyMatchQuery = trigrams.map((t) => `"${t}"`).join(' OR ')
            params['@ftsQuery'] = `${cols} : (${fuzzyMatchQuery})`
            // Re-run with same tag filters (appended to sql already) but new fts param
            results = db.prepare(sql).all(params) as any[]
          }
        }

        return results.map(mapRowToEntry)
      } catch (e) {
        console.error('[Search] Execution failed:', e)
        return []
      }
    }
  } else {
    // --- No Text Query ---
    sql = `
      SELECT 
        i.id, i.type, i.name, i.path,
        m.title, m.overview, m.media_type, m.year, m.genres_json, m.tags_json, m.images_json,
        m.people_json, m.episode_number, m.virtual_tags_json,
        u.watched,
        0 as rank,
        0 as static_score
      FROM items i
      LEFT JOIN metadata m ON i.id = m.item_id
      LEFT JOIN user_state u ON i.id = u.item_id
      WHERE 1=1
    `
    // Append Tags
    tags.forEach((tag, idx) => {
      const pKey = `@tagVal${idx}`
      const tagValue = tag.value.toLowerCase()
      if (tag.key === 'mediaType') {
        sql += ` AND m.media_type = ${pKey}`
        params[pKey] = tagValue
      } else if (tag.key === 'year') {
        sql += ` AND m.year = ${pKey}`
        params[pKey] = parseInt(tagValue) || 0
      } else if (tag.key === 'genre') {
        sql += ` AND lower(m.genres_json) LIKE ${pKey}`
        params[pKey] = `%"${tagValue}"%`
      } else if (tag.key === 'person') {
        sql += ` AND lower(m.people_json) LIKE ${pKey}`
        params[pKey] = `%"${tagValue}"%`
      } else {
        const pValKey = `@tagVal${idx}`
        const pValLikeKey = `@tagValLike${idx}`
        const pPathKey = `@tagPath${idx}`
        params[pValKey] = tagValue
        params[pValLikeKey] = `%${tagValue}%`
        params[pPathKey] = `$.${tag.key}`
        sql += ` AND (
          lower(json_extract(m.tags_json, ${pPathKey})) = ${pValKey} OR 
          lower(json_extract(m.tags_json, ${pPathKey})) LIKE ${pValLikeKey} OR
          lower(json_extract(m.virtual_tags_json, ${pPathKey})) = ${pValKey}
        )`
      }
    })

    sql += ` ORDER BY m.title ASC, i.name ASC LIMIT ${limit}`
  }

  // Execute for Short/Empty query paths
  try {
    const rows = db.prepare(sql).all(params) as any[]
    return rows.map(mapRowToEntry)
  } catch (e) {
    console.error('[Search] Error executing search query:', e)
    return []
  }
}

function mapRowToEntry(row: any): SearchIndexEntry {
  const images = row.images_json ? JSON.parse(row.images_json) : {}
  const entry = {
    id: row.id,
    title: row.title ?? row.name,
    type: row.type,
    posterPath: images.poster,
    overview: row.overview,
    mediaType: row.media_type,
    year: row.year,
    genres: row.genres_json ? JSON.parse(row.genres_json) : [],
    tags: row.tags_json ? JSON.parse(row.tags_json) : {},
    virtualTags: row.virtual_tags_json ? JSON.parse(row.virtual_tags_json) : {},
    watched: Boolean(row.watched),
    episodeNumber: row.episode_number,
    isMissing: false,
    _v: 0,
    staticScore: 0
  }
  return entry
}

export function debugPerformSearch(query: any) {
  return performSearch(query)
}
