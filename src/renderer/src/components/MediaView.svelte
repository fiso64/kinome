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
    highlightedIndex
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

  // --- Derived State for different layouts ---
  const { displayedItems, virtualFolders } = $derived.by(() => {
    // This now calls the centralized filter function. Performance is maintained
    // because this filtering still happens entirely in the renderer process.
    const filteredItems = filterItems(items, searchQuery ?? { text: '', tags: [] })

    if (
      parentItem &&
      (layout === 'tabs' || layout === 'sections') &&
      parentItem.groupBy &&
      parentItem.groupBy !== 'folder'
    ) {
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
          const virtualSettings = parentItem.virtualFolderSettings?.[groupByKey]?.[groupValue] ?? {}
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
      // In tabs/sections view, the filtering happens inside the recursive MediaGrid call,
      // so we pass the original unfiltered items down. The sections themselves are built from filtered items.
      return { displayedItems: items, virtualFolders: vFolders }
    }
    return { displayedItems: filteredItems, virtualFolders: null }
  })

  const sortedTreeItems = $derived(
    [...displayedItems].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? 1 : -1
      const aTitle = a.title ?? ('name' in a ? (a as LibraryItem).name : '')
      const bTitle = b.title ?? ('name' in b ? (b as LibraryItem).name : '')
      return aTitle.localeCompare(bTitle, undefined, { numeric: true })
    })
  )

  const physicalFolderItems = $derived(
    displayedItems.filter((item) => item.type === 'folder') as MediaFolder[]
  )

  const foldersForTabsOrSections = $derived(virtualFolders ?? physicalFolderItems)
</script>

<div
  class="media-grid-container"
  oncontextmenu={parentItem ? (e) => onShowContextMenu(parentItem, e, { layout }) : undefined}
>
  {#if layout === 'grid'}
    <GridView items={displayedItems} {onItemClick} {onShowContextMenu} />
  {:else if layout === 'tree'}
    <TreeView items={sortedTreeItems} {onItemClick} {onShowContextMenu} />
  {:else if layout === 'list'}
    <ListView items={displayedItems} {onItemClick} {onShowContextMenu} {highlightedIndex} />
  {:else if layout === 'tabs'}
    <TabsView folders={foldersForTabsOrSections} {onItemClick} {onShowContextMenu} {suggestions} />
  {:else if layout === 'sections'}
    <SectionsView
      folders={foldersForTabsOrSections}
      {onItemClick}
      {onShowContextMenu}
      {suggestions}
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
