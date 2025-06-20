import type { MediaFolder, Settings, ViewSettings } from './types'

// This type alias helps clarify that the function can accept a folder-like item
// which could be a real MediaFolder, a virtual one, or undefined.
type ResolvableItem = (MediaFolder & { isVirtual?: boolean }) | undefined | null

/**
 * Resolves the final, effective view settings for a given item by applying a specificity cascade.
 * The cascade is: Item-specific > Type-specific default > Global default.
 *
 * @param item The folder item whose view settings need to be resolved.
 * @param settings The global application settings object.
 * @returns A complete ViewSettings object with the final computed values.
 */
export function resolveViewSettings(
  item: ResolvableItem,
  settings: Settings | null
): ViewSettings & { gridPosterSize: number | undefined | null } {
  // If settings aren't loaded, provide a safe, hardcoded default.
  if (!settings) {
    const layout = item?.layout ?? 'grid'
    const clickAction = item?.childrenClickAction ?? 'detail'
    const groupBy = item?.groupBy ?? 'folder'
    const gridPosterSize = item?.gridPosterSize ?? 200
    return { layout, clickAction, groupBy, gridPosterSize }
  }

  // 1. Start with the most general global defaults.
  let resolved: ViewSettings = { ...settings.defaultViewSettings }
  // gridPosterSize is handled separately to ensure correct inheritance.
  let resolvedGridPosterSize = settings.gridPosterSize

  // 2. Layer on type-specific defaults if the item has a mediaType.
  if (item?.mediaType) {
    let typeDefaults: ViewSettings | undefined
    switch (item.mediaType) {
      case 'movie':
        typeDefaults = settings.defaultMovieViewSettings
        break
      case 'tv':
        typeDefaults = settings.defaultTvShowViewSettings
        break
      case 'season':
        typeDefaults = settings.defaultSeasonViewSettings
        break
    }
    if (typeDefaults) {
      resolved = { ...resolved, ...typeDefaults }
      // Only override gridPosterSize if it's explicitly set on the type-specific settings.
      if (typeDefaults.gridPosterSize != null) {
        resolvedGridPosterSize = typeDefaults.gridPosterSize
      }
    }
  }

  // 3. Layer on the most specific settings from the item itself.
  // This works for both physical and virtual folders.
  if (item?.type === 'folder') {
    const { layout, childrenClickAction, groupBy, gridPosterSize } = item
    if (layout) resolved.layout = layout
    if (childrenClickAction) resolved.clickAction = childrenClickAction
    if (groupBy) resolved.groupBy = groupBy
    if (gridPosterSize != null) resolvedGridPosterSize = gridPosterSize
  }

  // Combine the resolved parts.
  return { ...resolved, gridPosterSize: resolvedGridPosterSize }
}