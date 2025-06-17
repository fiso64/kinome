import type { LibraryItem } from '../shared/types'
import type { Settings } from './settings'

// These are the properties from a LibraryItem that will be available
// as global variables inside the user's JS expression.
const CONTEXT_KEYS = ['tags', 'genres', 'year', 'title', 'name', 'mediaType', 'path'] as const
type ContextKey = (typeof CONTEXT_KEYS)[number]

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

  // Prepare the context values from the item, providing safe defaults.
  const contextValues = CONTEXT_KEYS.map((key) => {
    const value = (item as Record<ContextKey, unknown>)[key]
    if (key === 'genres' && typeof value === 'undefined') {
      return []
    }
    if (key === 'tags' && typeof value === 'undefined') {
      return {}
    }
    return value
  })

  for (const virtualTag of settings.virtualTags) {
    if (!virtualTag.name || !virtualTag.expression) {
      continue
    }

    try {
      // Create a function with a controlled scope. The user's code can only
      // access the variables we explicitly pass into the context.
      const func = new Function(...CONTEXT_KEYS, "'use strict'; return " + virtualTag.expression)

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
