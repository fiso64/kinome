import type { ViewHierarchyNode } from '@shared/types'
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
  'button-grid': [...CORE_FIELDS, 'backdropPath'],
  tree: [...CORE_FIELDS],
  tabs: [...CORE_FIELDS],
  sections: [...CORE_FIELDS]
}

/**
 * Returns the list of additional fields that need to be fetched for a specific layout.
 * Defaults to an empty array if the layout is unknown.
 *
 * @param layout The layout mode (e.g. 'list', 'grid', 'tabs', 'sections')
 */
export function getRequiredFieldsForLayout(layout: string): string[] {
  return VIEW_REQUIRED_FIELDS[layout] ?? []
}

/**
 * Recursively collects all required fields from a ViewHierarchyNode.
 * This determines all metadata fields needed to render the current view and all its nested sub-views.
 *
 * @param viewHierarchy The fully resolved view hierarchy from the backend.
 */
export function getAllRequiredFields(
  viewHierarchy: ViewHierarchyNode | undefined | null
): string[] {
  const fields = new Set<string>()

  if (!viewHierarchy) return []

  function traverse(node: ViewHierarchyNode) {
    if (!node.effective) return

    // 1. Collect fields for the current node's layout
    if (node.effective.layout) {
      const req = getRequiredFieldsForLayout(node.effective.layout)
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
