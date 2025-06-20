import type {
  MediaFolder,
  Settings,
  ResolvedViewSettings,
  StoredViewSettings,
  BaseViewSettings
} from './types'
import { LAYOUT_SPECIFIC_SETTINGS_CONFIG } from './types'

// This type alias helps clarify that the function can accept a folder-like item
// which could be a real MediaFolder, a virtual one, or undefined.
type ResolvableItem = (MediaFolder & { isVirtual?: boolean }) | undefined | null

/**
 * Resolves the final, effective view settings for a given item by applying a specificity cascade.
 * The cascade is: Item-specific > Type-specific default > Global default.
 *
 * @param item The folder item whose view settings need to be resolved.
 * @param settings The global application settings object.
 * @returns A complete, resolved view settings object ready for the UI.
 */
export function resolveViewSettings(
  item: ResolvableItem,
  settings: Settings | null
): ResolvedViewSettings {
  // If settings aren't loaded, provide a safe, hardcoded default.
  if (!settings) {
    return {
      layout: item?.layout ?? 'grid',
      clickAction: item?.clickAction ?? 'detail',
      groupBy: item?.groupBy ?? 'folder',
      gridPosterSize: item?.gridPosterSize ?? 200
    }
  }

  // 1. Determine the hierarchy of settings to check, from most to least specific.
  const typeDefaultKey = item?.mediaType
    ? (`default${
        item.mediaType.charAt(0).toUpperCase() + item.mediaType.slice(1)
      }ViewSettings` as keyof Settings)
    : null
  const typeDefaultSettings = typeDefaultKey ? (settings[typeDefaultKey] as StoredViewSettings) : {}

  const settingsCascade: StoredViewSettings[] = [
    item ?? {}, // Item-specific overrides
    typeDefaultSettings, // Type-specific overrides
    settings.defaultViewSettings // Global base defaults
  ].filter(Boolean)

  // 2. Resolve the base properties (`layout` and `clickAction`).
  const resolvedBase: BaseViewSettings = {
    layout: settingsCascade.find((s) => s.layout)?.layout ?? 'grid',
    clickAction: settingsCascade.find((s) => s.clickAction)?.clickAction ?? 'detail'
  }

  // 3. Get the list of layout-specific keys for the now-resolved layout.
  const layoutConfig = (LAYOUT_SPECIFIC_SETTINGS_CONFIG as any)[resolvedBase.layout] ?? {}
  const specificKeys = Object.keys(layoutConfig)
  const resolvedSpecific: Record<string, any> = {}

  // 4. For each layout-specific key, resolve its value using the cascade.
  for (const key of specificKeys) {
    // Find the first settings object in the cascade that defines this key.
    const winningLayer = settingsCascade.find((s: any) => s[key] != null)

    if (winningLayer) {
      resolvedSpecific[key] = (winningLayer as any)[key]
    } else {
      // If no override is found, use the global default from `defaultLayoutSettings`.
      resolvedSpecific[key] = (settings.defaultLayoutSettings as any)[resolvedBase.layout]?.[key]
    }
  }

  // 5. Combine and return the final, complete settings object.
  return {
    ...resolvedBase,
    ...resolvedSpecific
  }
}