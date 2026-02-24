import * as repositoryService from './repository.service'
import * as searchRepo from '../database/repositories/search.repo'
import type { SearchIndexEntry } from '@shared/types'

// Rebuilds the FTS index from scratch. Useful for migration or corruption recovery.
export function rebuildSearchIndex() {
  console.log('[Search] Rebuilding FTS index...')
  searchRepo.rebuildFtsIndex()
  console.log('[Search] FTS index rebuild complete.')
}

/**
 * Initializes the search index. Checks if FTS is populated, and rebuilds if empty but items exist.
 */
export function buildFullSearchIndex(_items?: any[]) {
  try {
    const { count, itemCount } = searchRepo.getFtsIndexCount()

    if (count === 0 && itemCount > 0) {
      console.log('[Search] FTS index is empty but items exist. Triggering rebuild.')
      rebuildSearchIndex()
    }
  } catch (e) {
    console.error('[Search] Failed to check/build FTS index:', e)
  }
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
  const { text, tags } = query
  const limit = query.limit || 30

  let rows: any[] = []

  // 1. Text Search Logic
  if (text.trim()) {
    const normalized = normalizeText(text)

    if (normalized.length < 3) {
      // --- Short Query Strategy (LIKE) ---
      rows = searchRepo.findByShortQuery(normalized, tags, limit)
    } else {
      // --- Long Query Strategy (FTS Trigram) ---
      const cols = '{title original_title name}'

      try {
        const matchQuery = `${cols} : "${normalized}"`
        rows = searchRepo.findByFtsQuery(matchQuery, tags, limit)

        // Fuzzy Fallback
        if (rows.length === 0) {
          const trigrams = toTrigrams(normalized)
          if (trigrams.length > 0) {
            const fuzzyMatchQuery = `${cols} : (${trigrams.map((t) => `"${t}"`).join(' OR ')})`
            rows = searchRepo.findByFtsQuery(fuzzyMatchQuery, tags, limit)
          }
        }
      } catch (e) {
        console.error('[Search] Execution failed:', e)
        return []
      }
    }
  } else {
    // --- No Text Query ---
    rows = searchRepo.findByTagsOnly(tags, limit)
  }

  return rows.map(mapRowToEntry)
}

function mapRowToEntry(row: any): SearchIndexEntry {
  const entry = {
    id: row.id,
    title: row.title ?? row.name,
    type: row.type,
    posterPath: row.poster_path ?? null,
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
