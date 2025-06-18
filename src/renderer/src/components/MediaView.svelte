<script lang="ts">
  import GridView from './media-views/GridView.svelte'
  import TreeView from './media-views/TreeView.svelte'
  import TabsView from './media-views/TabsView.svelte'
  import SectionsView from './media-views/SectionsView.svelte'
  import ListView from './media-views/ListView.svelte'
  import { filterItems } from '../../../shared/filter'

  type Layout = 'grid' | 'tree' | 'tabs' | 'sections' | 'list'
  type DisplayableItem = LibraryItem | SearchIndexEntry
  type VirtualFolder = MediaFolder & {
    isVirtual: boolean
    physicalParentId: string
    groupByKey: string
    groupByValue: string
  }

  let {
    parentItem,
    items = [],
    onItemClick,
    layout: layoutProp,
    onShowContextMenu,
    searchQuery,
    suggestions,
    highlightedIndex,
    isPreSorted = false,
    grayOutWatched = true
  }: {
    parentItem?: MediaFolder | VirtualFolder
    items: DisplayableItem[]
    onItemClick: (item: DisplayableItem) => void
    layout?: Layout
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string }
    ) => void
    searchQuery?: { text: string; tags: { key: string; value: string }[] }
    suggestions?: AutocompleteSuggestions
    highlightedIndex?: number | null
    isPreSorted?: boolean
    grayOutWatched?: boolean
  } = $props()

  const layout = $derived(layoutProp ?? parentItem?.layout ?? 'grid')

  // --- Helpers for data processing ---

  function getValuesForKey(item: DisplayableItem, key: string): string[] {
    if (key === 'mediaType') return item.mediaType ? [item.mediaType] : []
    if (key === 'genre') return item.genres ?? []
    if (key === 'year') return item.year ? [item.year.toString()] : []
    if (key.startsWith('tags.')) {
      const tagKey = key.substring(5)
      const tagValue = item.tags?.[tagKey]
      return tagValue ? tagValue.split(',').map((v) => v.trim()) : []
    }
    if (key.startsWith('vt.')) {
      const vtKey = key.substring(3)
      const vtValue = item.virtualTags?.[vtKey]
      return vtValue ? [vtValue] : []
    }
    return []
  }

  function compareItems(a: DisplayableItem, b: DisplayableItem): number {
    // The properties 'seasonNumber' and 'episodeNumber' might not exist on SearchIndexEntry
    const aSeason = 'seasonNumber' in a ? (a as any).seasonNumber : undefined
    const bSeason = 'seasonNumber' in b ? (b as any).seasonNumber : undefined
    const aEpisode = 'episodeNumber' in a ? (a as any).episodeNumber : undefined
    const bEpisode = 'episodeNumber' in b ? (b as any).episodeNumber : undefined

    // Handle season numbers (nulls last)
    if (aSeason != null && bSeason != null) {
      if (aSeason !== bSeason) return aSeason - bSeason
    } else if (aSeason != null) {
      return -1 // a has season, b doesn't. a comes first.
    } else if (bSeason != null) {
      return 1 // b has season, a doesn't. b comes first.
    }

    // Handle episode numbers (nulls last)
    if (aEpisode != null && bEpisode != null) {
      if (aEpisode !== bEpisode) return aEpisode - bEpisode
    } else if (aEpisode != null) {
      return -1
    } else if (bEpisode != null) {
      return 1
    }

    // Fallback to alphabetical name sort
    const aName = a.title ?? ('name' in a ? (a as LibraryItem).name : '')
    const bName = b.title ?? ('name' in b ? (b as LibraryItem).name : '')
    return aName.localeCompare(bName, undefined, { numeric: true })
  }

  // --- Derived State for different layouts ---
  const { itemsForViews, foldersForTabsOrSections } = $derived.by(() => {
    // 1. Filter first.
    const filteredItems = filterItems(items, searchQuery ?? { text: '', tags: [] })

    // 2. Handle grouping for tabs/sections.
    if (layout === 'tabs' || layout === 'sections') {
      if (parentItem?.groupBy && parentItem.groupBy !== 'folder') {
        // Group by metadata (create virtual folders).
        const groupByKey = parentItem.groupBy
        const groups: Record<string, DisplayableItem[]> = {}
        for (const item of filteredItems) {
          const values = getValuesForKey(item, groupByKey)
          if (values.length === 0) {
            if (!groups['Uncategorized']) groups['Uncategorized'] = []
            groups['Uncategorized'].push(item)
          } else {
            for (const value of values) {
              if (!groups[value]) groups[value] = []
              groups[value].push(item)
            }
          }
        }
        const vFolders = Object.entries(groups)
          .map(([groupValue, groupItems]) => {
            const virtualSettings =
              parentItem.virtualFolderSettings?.[groupByKey]?.[groupValue] ?? {}
            const virtualFolder: VirtualFolder = {
              id: `virtual--${parentItem.id}--${groupByKey}--${groupValue}`,
              name: groupValue,
              title: virtualSettings.title ?? groupValue,
              type: 'folder',
              children: groupItems as LibraryItem[],
              path: '',
              isVirtual: true,
              physicalParentId: parentItem.id,
              groupByKey: groupByKey,
              groupByValue: groupValue,
              ...virtualSettings
            }
            return virtualFolder
          })
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

        return { itemsForViews: [], foldersForTabsOrSections: vFolders }
      } else {
        // Group by physical folders.
        const sortedFolders = [...filteredItems.filter((item) => item.type === 'folder')].sort(
          compareItems
        ) as MediaFolder[]
        return { itemsForViews: [], foldersForTabsOrSections: sortedFolders }
      }
    }

    // 3. Handle simple views (grid, list, tree): sort items, then map to add episode number prefixes.
    const processedItems = (isPreSorted ? filteredItems : [...filteredItems].sort(compareItems)).map(
      (item) => {
        const episodeNumber = 'episodeNumber' in item ? item.episodeNumber : undefined
        if (item.mediaType === 'episode' && episodeNumber != null) {
          const baseTitle = item.title ?? ('name' in item ? (item as LibraryItem).name : '')
          // Create a new object to prevent mutation and ensure reactivity
          return { ...item, title: `${episodeNumber}. ${baseTitle}` }
        }
        return item
      }
    )

    return { itemsForViews: processedItems, foldersForTabsOrSections: [] }
  })
</script>

<div
  class="media-grid-container"
  oncontextmenu={parentItem ? (e) => onShowContextMenu(parentItem, e, { layout }) : undefined}
>
  {#if layout === 'grid'}
    <GridView items={itemsForViews} {onItemClick} {onShowContextMenu} {grayOutWatched} />
  {:else if layout === 'tree'}
    <TreeView items={itemsForViews} {onItemClick} {onShowContextMenu} {grayOutWatched} />
  {:else if layout === 'list'}
    <ListView
      items={itemsForViews}
      {onItemClick}
      {onShowContextMenu}
      {highlightedIndex}
      {grayOutWatched}
    />
  {:else if layout === 'tabs'}
    <TabsView
      folders={foldersForTabsOrSections}
      {onItemClick}
      {onShowContextMenu}
      {suggestions}
      {grayOutWatched}
    />
  {:else if layout === 'sections'}
    <SectionsView
      folders={foldersForTabsOrSections}
      {onItemClick}
      {onShowContextMenu}
      {suggestions}
      {grayOutWatched}
    />
  {/if}
</div>

<style>
  .media-grid-container {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
  }
</style>
