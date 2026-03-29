import type {
  MediaFolder,
  Settings,
  ResolvedViewSettings,
  StoredViewSettings,
  CascadableViewSettings,
  DefaultLayoutKey,
  ResolutionInfo,
  ResolutionSource,
  ViewHierarchyNode
} from './types'
import { LAYOUT_SPECIFIC_SETTINGS_CONFIG, CONTAINER_LAYOUTS } from './types'

// This type alias helps clarify that the function can accept a folder-like item
// which could be a real MediaFolder, a virtual one, or undefined.
type ResolvableItem =
  | (MediaFolder & { isVirtual?: boolean; viewHierarchy?: ViewHierarchyNode })
  | undefined
  | null

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
  ignoreLayers: Set<DefaultLayoutKey> = new Set(),
  inheritedSettings?: CascadableViewSettings,
  ignoreOverrideId?: string | null
): ResolutionInfo {
  // If settings aren't loaded, provide a safe, hardcoded default based on the config.
  if (!settings) {
    const rawStored = { ...inheritedSettings, ...item?.viewSettings }
    const defaultLayout = rawStored?.layout ?? 'grid'

    // Only apply specific settings for the active layout, just like the real logic
    const layoutConfig = (LAYOUT_SPECIFIC_SETTINGS_CONFIG as any)[defaultLayout] ?? {}

    const fallbackResolution: ResolutionInfo = {
      settings: {
        layout: defaultLayout,
        clickAction: rawStored?.clickAction ?? 'detail',
        sortBy: rawStored?.sortBy,
        sortDescending: rawStored?.sortDescending,
        // ...fallbackSpecifics
        ...layoutConfig // Use specific config instead
      },
      sources: {}
    }
    return fallbackResolution
  }

  // 1. Determine the hierarchy of settings to check, from most to least specific.
  const cascadeLayers: { settings: CascadableViewSettings; sourceInfo: ResolutionSource }[] = []

  // Add Child-Specific Overrides (The Most Specific context)
  // These are instructions from a parent that target THIS specific child ID.
  if (
    inheritedSettings?.overrides &&
    item?.id &&
    inheritedSettings.overrides[item.id] &&
    item.id !== ignoreOverrideId
  ) {
    cascadeLayers.push({
      settings: inheritedSettings.overrides[item.id],
      sourceInfo: { source: 'override', sourceKey: item.id }
    })
  }

  // Add inherited context layer if provided (Parent's general childViewSettings)
  // This takes priority over the item's own settings in "inline" views (per spec).
  if (inheritedSettings && Object.keys(inheritedSettings).length > 0) {
    cascadeLayers.push({ settings: inheritedSettings, sourceInfo: { source: 'inherited' } })
  }

  // Add item-specific layer if it exists
  // This represents the item's own explicit configuration.
  const ownSettings = item?.viewSettings ?? item?.viewHierarchy?.stored
  if (ownSettings && Object.keys(ownSettings).length > 0) {
    cascadeLayers.push({ settings: ownSettings, sourceInfo: { source: 'item' } })
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

  // 2. Resolve the base properties (`layout`, `clickAction`, `sortBy`, `sortDescending`, `childViewSettings`).
  const layoutLayer = cascadeLayers.find((layer) => layer.settings.layout)
  const clickActionLayer = cascadeLayers.find((layer) => layer.settings.clickAction)
  const sortByLayer = cascadeLayers.find((layer) => layer.settings.sortBy !== undefined)
  // Use !== undefined so that sortDescending: false is treated as an explicit override.
  const sortDescendingLayer = cascadeLayers.find((layer) => layer.settings.sortDescending !== undefined)

  // Merge childViewSettings from all layers (most specific wins for each property)
  let resolvedChildViewSettings: CascadableViewSettings | undefined = undefined
  let childSettingsSource: ResolutionSource | undefined = undefined

  for (const layer of [...cascadeLayers].reverse()) {
    const layerChild = layer.settings.childViewSettings
    if (layerChild) {
      if (!resolvedChildViewSettings) resolvedChildViewSettings = {}
      childSettingsSource = layer.sourceInfo

      const prevOverrides = resolvedChildViewSettings.overrides

      Object.assign(resolvedChildViewSettings, layerChild)

      if (layerChild.overrides) {
        resolvedChildViewSettings.overrides = { ...prevOverrides, ...layerChild.overrides }
      }
    }
  }

  const resolvedBase: any = {
    layout: layoutLayer?.settings.layout ?? 'grid',
    clickAction: clickActionLayer?.settings.clickAction ?? 'detail',
  }

  if (sortByLayer) {
    resolvedBase.sortBy = sortByLayer.settings.sortBy
    resolvedSources.sortBy = sortByLayer.sourceInfo
  }
  if (sortDescendingLayer) {
    resolvedBase.sortDescending = sortDescendingLayer.settings.sortDescending
    resolvedSources.sortDescending = sortDescendingLayer.sourceInfo
  }

  // Invariant I3: Mixed Content Fallback (TV Show -> Season Defaults)
  const hasEffectiveChildLayout =
    resolvedChildViewSettings &&
    Object.keys(resolvedChildViewSettings).some((k) => k !== 'overrides')

  if (!hasEffectiveChildLayout && item?.mediaType === 'tv' && settings) {
    resolvedChildViewSettings = {
      ...(settings.defaultLayouts.season as any),
      ...(resolvedChildViewSettings || {})
    }
  }

  resolvedBase.childViewSettings = resolvedChildViewSettings

  if (layoutLayer) resolvedSources.layout = layoutLayer.sourceInfo
  if (clickActionLayer) resolvedSources.clickAction = clickActionLayer.sourceInfo
  if (childSettingsSource) resolvedSources.childViewSettings = childSettingsSource

  // 3. Resolve aesthetics (layout-specific settings)
  const layoutConfig = (LAYOUT_SPECIFIC_SETTINGS_CONFIG as any)[resolvedBase.layout] ?? {}
  const specificKeys = Object.keys(layoutConfig).filter(k => k !== 'groupBy')
  const resolvedSpecific: Record<string, any> = {}

  for (const key of specificKeys) {
    const winningLayer = cascadeLayers.find((layer: any) => layer.settings[key] != null)

    if (winningLayer) {
      resolvedSpecific[key] = (winningLayer.settings as any)[key]
      resolvedSources[key as keyof ResolvedViewSettings] = winningLayer.sourceInfo
    } else {
      const globalDefault = (settings.defaultLayoutSettings as any)[resolvedBase.layout]?.[key]
      resolvedSpecific[key] = globalDefault
      if (globalDefault !== undefined) {
        resolvedSources[key as keyof ResolvedViewSettings] = { source: 'global', sourceKey: '_default' }
      }
    }
  }

  return {
    settings: { ...resolvedBase, ...resolvedSpecific },
    sources: resolvedSources
  }
}

/**
 * Creates a human-readable string describing a layout and its grouping.
 */
export function formatLayoutString(viewSettings: StoredViewSettings | null | undefined): string {
  if (!viewSettings?.layout) return 'Not set'

  const layout = viewSettings.layout.charAt(0).toUpperCase() + viewSettings.layout.slice(1)
  if (CONTAINER_LAYOUTS.includes(viewSettings.layout)) {
    const groupByKey = viewSettings.appliedGrouping
    if (!groupByKey) return layout

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
