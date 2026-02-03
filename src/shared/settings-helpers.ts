import type {
  MediaFolder,
  Settings,
  ResolvedViewSettings,
  StoredViewSettings,
  DefaultLayoutKey,
  ResolutionInfo,
  ResolutionSource
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
 * @param ignoreLayers A set of default layout keys to ignore during resolution. This is used by settings modals to correctly calculate their "inherited" values from the level above them.
 * @returns A complete, resolved view settings object ready for the UI.
 */
export function resolveViewSettings(
  item: ResolvableItem,
  settings: Settings | null,
  ignoreLayers: Set<DefaultLayoutKey> = new Set()
): ResolutionInfo {

  // If settings aren't loaded, provide a safe, hardcoded default based on the config.
  if (!settings) {

    const defaultLayout = item?.layout ?? 'grid';

    // Only apply specific settings for the active layout, just like the real logic
    const layoutConfig = (LAYOUT_SPECIFIC_SETTINGS_CONFIG as any)[defaultLayout] ?? {};

    const fallbackResolution: ResolutionInfo = {
      settings: {
        layout: item?.layout ?? 'grid',
        clickAction: item?.clickAction ?? 'detail',
        // ...fallbackSpecifics 
        ...layoutConfig // Use specific config instead
      },
      sources: {}
    }
    return fallbackResolution
  }

  // 1. Determine the hierarchy of settings to check, from most to least specific.
  const cascadeLayers: { settings: StoredViewSettings; sourceInfo: ResolutionSource }[] = []

  // Add item-specific layer if it exists
  if (item) {
    cascadeLayers.push({ settings: item, sourceInfo: { source: 'item' } })
  }

  // Add type-specific default layer if applicable and not ignored
  const mediaTypeKey = item?.mediaType
  if (
    mediaTypeKey &&
    mediaTypeKey in settings.defaultLayouts &&
    !ignoreLayers.has(mediaTypeKey as DefaultLayoutKey)
  ) {
    cascadeLayers.push({
      settings: (settings.defaultLayouts as any)[mediaTypeKey],
      sourceInfo: { source: 'type', sourceKey: mediaTypeKey as DefaultLayoutKey }
    })
  }

  // Add global default layer if not ignored
  if (!ignoreLayers.has('_default')) {
    cascadeLayers.push({
      settings: settings.defaultLayouts._default,
      sourceInfo: { source: 'global', sourceKey: '_default' }
    })
  }

  const resolvedSources: ResolutionInfo['sources'] = {}

  // 2. Resolve the base properties (`layout`, `clickAction`, `childViewSettings`).
  const layoutLayer = cascadeLayers.find((layer) => layer.settings.layout)
  const clickActionLayer = cascadeLayers.find((layer) => layer.settings.clickAction)
  const childViewSettingsLayer = cascadeLayers.find((layer) => layer.settings.childViewSettings)

  const resolvedBase: any = {
    layout: layoutLayer?.settings.layout ?? 'grid',
    clickAction: clickActionLayer?.settings.clickAction ?? 'detail',
    childViewSettings: childViewSettingsLayer?.settings.childViewSettings ?? undefined
  }

  if (layoutLayer) resolvedSources.layout = layoutLayer.sourceInfo
  if (clickActionLayer) resolvedSources.clickAction = clickActionLayer.sourceInfo
  if (childViewSettingsLayer)
    (resolvedSources as any).childViewSettings = childViewSettingsLayer.sourceInfo

  // 3. Get the list of layout-specific keys for the now-resolved layout.
  const layoutConfig =
    LAYOUT_SPECIFIC_SETTINGS_CONFIG[
    resolvedBase.layout as keyof typeof LAYOUT_SPECIFIC_SETTINGS_CONFIG
    ] ?? {}
  const specificKeys = Object.keys(layoutConfig)
  const resolvedSpecific: Record<string, any> = {}

  // 4. For each layout-specific key, resolve its value using the cascade.
  for (const key of specificKeys) {
    // Find the first settings object in the cascade that defines this key.
    const winningLayer = cascadeLayers.find((layer: any) => layer.settings[key] != null)

    if (winningLayer) {
      resolvedSpecific[key] = (winningLayer.settings as any)[key]
      resolvedSources[key as keyof ResolvedViewSettings] = winningLayer.sourceInfo
    } else {
      // If no override is found, use the global default from `defaultLayoutSettings`.
      resolvedSpecific[key] = (settings.defaultLayoutSettings as any)[resolvedBase.layout]?.[key]
      resolvedSources[key as keyof ResolvedViewSettings] = {
        source: 'global',
        sourceKey: '_default'
      }
    }
  }

  // 5. Combine and return the final, complete settings object.
  return {
    settings: {
      ...resolvedBase,
      ...resolvedSpecific
    },
    sources: resolvedSources
  }
}

/**
 * Creates a human-readable string describing a layout and its grouping.
 * @param viewSettings The view settings object to format.
 * @returns A descriptive string like "Tabs by Genre" or "Grid".
 */
export function formatLayoutString(viewSettings: StoredViewSettings | null | undefined): string {
  if (!viewSettings?.layout) return 'Not set'

  const layout = viewSettings.layout.charAt(0).toUpperCase() + viewSettings.layout.slice(1)
  if (viewSettings.layout === 'tabs' || viewSettings.layout === 'sections') {
    const groupByKey = viewSettings.groupBy
    if (!groupByKey || groupByKey === 'folder') return layout

    let displayKey = groupByKey
    if (groupByKey.startsWith('tags.')) {
      displayKey = groupByKey.substring(5)
    } else if (groupByKey.startsWith('vt.')) {
      displayKey = groupByKey.substring(3)
    }
    const formattedKey = displayKey.charAt(0).toUpperCase() + displayKey.slice(1)
    return `${layout} by ${formattedKey}`
  }
  return layout
}
