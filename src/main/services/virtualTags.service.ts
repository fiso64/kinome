import type { LibraryItem, Settings } from '../../shared/types'

// Blacklist properties that are unsafe, unnecessary, or could cause
// performance issues/circular dependencies in user expressions.
const BLACKLISTED_CONTEXT_KEYS = new Set([
  'children', // Large array, could cause performance issues.
  'tmdbSeasons', // Large raw object from API.
  'virtualTags', // Prevents recursive evaluation.
  'virtualFolderSettings' // Internal setting.
])

/**
 * Evaluates all virtual tags defined in settings for a given library item.
 * @param item The library item to evaluate.
 * @param settings The application settings containing virtual tag definitions.
 * @returns A record of evaluated virtual tag keys and their string-coerced values.
 */
export function evaluateVirtualTagsForItem(
  item: LibraryItem,
  settings: Settings
): Record<string, string> {
  const evaluatedTags: Record<string, string> = {}
  if (!settings.virtualTags || settings.virtualTags.length === 0) {
    return evaluatedTags
  }

  // Dynamically create the context from the item's properties, excluding blacklisted ones.
  const context: Record<string, unknown> = {}
  for (const key in item) {
    if (Object.prototype.hasOwnProperty.call(item, key) && !BLACKLISTED_CONTEXT_KEYS.has(key)) {
      context[key] = (item as any)[key]
    }
  }

  // Provide safe defaults for potentially missing complex types.
  if (!context.tags) context.tags = {}
  if (!context.genres) context.genres = []

  const contextKeys = Object.keys(context)
  const contextValues = Object.values(context)

  for (const virtualTag of settings.virtualTags) {
    if (!virtualTag.name || !virtualTag.expression) {
      continue
    }

    try {
      // Create a function with a controlled scope. The user's code can only
      // access the variables we explicitly pass into the context.
      const func = new Function(...contextKeys, "'use strict'; return " + virtualTag.expression)

      const result = func(...contextValues)

      // Only add the tag if the expression returned a meaningful value.
      if (result !== null && typeof result !== 'undefined') {
        evaluatedTags[virtualTag.name] = String(result)
      }
    } catch (e) {
      console.error(
        `[VirtualTags] Error evaluating expression for tag "${virtualTag.name}" on item "${item.name}":`,
        e
      )
    }
  }

  return evaluatedTags
}
