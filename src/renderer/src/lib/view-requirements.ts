import type { BaseViewSettings, Settings, ViewHierarchyNode } from '@shared/types'
import { CORE_FIELDS } from '@shared/types'

/**
 * Fields required for the ItemDetail header and primary metadata.
 */
export const DETAIL_HEADER_FIELDS = [
  ...CORE_FIELDS,
  'title',
  'overview',
  'backdropPath',
  'logoPath',
  'runtime',
  'releaseDate',
  'genres',
  'tags',
  'tmdbId',
  '_v'
]

/**
 * A mapping of layout modes to the metadata fields they require to render correctly.
 * This ensures that when switching views, we always fetch the necessary data.
 */
export const VIEW_REQUIRED_FIELDS: Record<string, string[]> = {
  list: [...CORE_FIELDS, 'overview'],
  grid: [...CORE_FIELDS],
  'horizontal-grid': [...CORE_FIELDS],
  tree: [...CORE_FIELDS],
  tabs: [...CORE_FIELDS],
  sections: [...CORE_FIELDS]
}

/**
 * Returns the list of additional fields that need to be fetched for a specific layout.
 * Defaults to an empty array if the layout is unknown.
 *
 * @param layout The layout mode (e.g. 'list', 'grid', 'tabs', 'sections')
 * @param groupBy A grouping key (e.g. 'genre', 'vt.is_anime')
 */
export function getRequiredFieldsForLayout(layout: string, groupBy?: string): string[] {
  const baseFields = VIEW_REQUIRED_FIELDS[layout] ?? []
  const groupFields: string[] = []

  if (groupBy) {
    if (groupBy === 'genre' || groupBy === 'genres') {
      groupFields.push('genres')
    } else if (groupBy.startsWith('vt.') || groupBy === 'virtualTags') {
      groupFields.push('virtualTags')
    } else if (groupBy.startsWith('tags.') || groupBy === 'tags') {
      groupFields.push('tags')
    } else if (groupBy === 'seasonNumber') {
      groupFields.push('seasonNumber')
    }
  }

  return [...baseFields, ...groupFields]
}

/**
 * Recursively collects all required fields from a ViewHierarchyNode.
 * This determines all metadata fields needed to render the current view and all its nested sub-views.
 *
 * @param viewHierarchy The fully resolved view hierarchy from the backend.
 */
export function getAllRequiredFields(
  viewHierarchy: ViewHierarchyNode | undefined | null,
): string[] {
  const fields = new Set<string>()

  if (!viewHierarchy) return []

  function traverse(node: ViewHierarchyNode) {
    if (!node.effective) return

    // 1. Collect fields for the current node's layout
    if (node.effective.layout) {
      const req = getRequiredFieldsForLayout(node.effective.layout, node.effective.groupBy)
      req.forEach((f) => fields.add(f))
    }

    // 2. Recurse into children (if any known children exist in the hierarchy)
    if (node.children) {
      Object.values(node.children).forEach((childNode) => traverse(childNode))
    }
  }

  traverse(viewHierarchy)
  return Array.from(fields)
}
