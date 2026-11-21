import { SPECIAL_FOLDER_NAMES_FOR_TV } from '../utils/tv-parser'
import { ITEM_READ_MODEL } from './media-read-model.sql'

const extrasFolders = [...SPECIAL_FOLDER_NAMES_FOR_TV, 'trailers', 'samples', 'interviews']
  .map((name) => `'${name}'`).join(', ')
const extraFileWords = ['trailer', 'teaser', 'sample', 'featurette']
const words = `(' ' || replace(replace(replace(lower(a.name), '.', ' '), '-', ' '), '_', ' ') || ' ')`
const extraFile = extraFileWords.map((word) => `${words} GLOB '* ${word} *'`).join(' OR ')

/**
 * A matched file always owns itself. Feature files can also belong to their
 * closest movie, and classified episodes to their season and show. Extras
 * and nested titles are boundaries. A file predicate always tests one selected
 * physical location, even when several paths exist for the logical file.
 */
export function playableFileMatchesSql(
  filePredicate: string,
  { preferTitle = false, targets, locations }: { preferTitle?: boolean; targets?: string; locations?: string } = {}
): string {
  // Descendants are a superset of the possible file witnesses. Ownership is
  // decided by the same upward walk for scoped and full evaluations.
  const candidates = targets ? `
    candidate_items(id) AS (
      ${targets}
      UNION
      SELECT child.id FROM candidate_items parent
      JOIN media_items child ON child.parent_item_id = parent.id
    ),
  ` : ''
  const files = targets ? `
      FROM candidate_items candidate
      CROSS JOIN ${ITEM_READ_MODEL} f ON f.id = candidate.id
      CROSS JOIN media_locations l ON l.id = f.selected_location_id
      CROSS JOIN local_media probe ON probe.location_id = l.id
  ` : locations ? `
      FROM (SELECT DISTINCT location_id FROM (${locations})) candidate
      CROSS JOIN media_locations l ON l.id = candidate.location_id
      CROSS JOIN local_media probe ON probe.location_id = l.id
      CROSS JOIN ${ITEM_READ_MODEL} f ON f.id = l.item_id AND f.selected_location_id = l.id
  ` : `
      FROM local_media probe
      CROSS JOIN media_locations l ON l.id = probe.location_id
      CROSS JOIN ${ITEM_READ_MODEL} f ON f.id = l.item_id AND f.selected_location_id = l.id
  `
  return `
    WITH RECURSIVE ${candidates} ancestors(file_id, item_id, parent_id, kind, name, type, episode, depth) AS (
      SELECT f.id, f.id, f.parent_id, f.media_kind, f.name, l.type, f.media_kind IS 'episode', 0
      ${files}
      WHERE probe.failures = 0 AND l.type = 'file' AND l.is_present = 1 AND f.is_virtual = 0
        AND f.is_item_hidden = 0 AND l.is_hidden = 0 AND l.is_ignored = 0 AND f.is_account_visible = 1
        AND (${filePredicate})
      UNION ALL
      SELECT a.file_id, p.id, p.parent_item_id, p.media_kind, p.name, p.physical_kind, a.episode, a.depth + 1
      FROM ancestors a JOIN media_items p ON p.id = a.parent_id
      WHERE (a.kind IS NULL OR a.kind NOT IN ('movie', 'tv'))
        AND p.physical_kind = 'folder' AND p.is_virtual = 0 AND p.is_hidden = 0
        AND (a.type != 'file' OR a.episode OR NOT (${extraFile}))
        AND (a.type != 'folder' OR a.kind = 'season' OR lower(a.name) NOT IN (${extrasFolders}))
        AND (p.media_kind IS NULL OR p.media_kind NOT IN ('tv', 'season') OR a.episode)
        AND (p.media_kind IS NOT 'movie' OR a.episode IS NOT 1)
    ),
    owners AS (
      SELECT a.item_id, a.file_id, a.depth
      FROM ancestors a
      WHERE a.depth = 0 OR a.kind IN ('movie', 'tv'${preferTitle ? '' : ", 'season'"})
    )
    ${preferTitle ? `
      SELECT item_id, file_id FROM (
        SELECT o.item_id, o.file_id,
          row_number() OVER (PARTITION BY o.file_id ORDER BY o.depth DESC) AS priority
        FROM owners o
        WHERE o.depth = 0 OR EXISTS (
          SELECT 1 FROM ${ITEM_READ_MODEL} owner
          WHERE owner.id = o.item_id AND owner.is_account_visible = 1 AND owner.is_hidden = 0 AND owner.is_ignored = 0
        )
      ) WHERE priority = 1
    ` : 'SELECT item_id, file_id FROM owners'}
  `
}
