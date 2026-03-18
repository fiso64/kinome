<script lang="ts">
  import GridView from '../views/GridView.svelte'
  import HorizontalGridView from '../views/HorizontalGridView.svelte'
  import TreeView from '../views/TreeView.svelte'
  import TabsView from '../views/TabsView.svelte'
  import SectionsView from '../views/SectionsView.svelte'
  import ListView from '../views/ListView.svelte'
  import { filterItems } from '@shared/filter'
  import { resolveViewSettings } from '@shared/settings-helpers'
  import { isTypingTag as isTypingTagHelper } from '@lib/view-helpers'
  import type {
    LibraryItem,
    MediaFolder,
    Settings,
    AutocompleteSuggestions,
    SearchIndexEntry,
    ViewHierarchyNode,
    StoredViewSettings
  } from '@shared/types'

  type Layout = 'grid' | 'horizontal-grid' | 'tree' | 'tabs' | 'sections' | 'list'
  type DisplayableItem = LibraryItem | SearchIndexEntry

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
    settings,
    listFixedAspectRatio = false,
    viewNode,
    contextParent
  }: {
    parentItem?: MediaFolder
    items: DisplayableItem[]
    onItemClick: (item: DisplayableItem) => void
    layout?: Layout
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string; parentItem?: LibraryItem }
    ) => void
    searchQuery?: { text: string; tags: { key: string; value: string }[] }
    suggestions?: AutocompleteSuggestions
    highlightedIndex?: number | null
    isPreSorted?: boolean
    settings?: Settings | null
    listFixedAspectRatio?: boolean
    viewNode?: ViewHierarchyNode
    contextParent?: LibraryItem
  } = $props()

  const grayOutWatched = $derived(settings?.grayOutWatched ?? true)

  const { layout, gridPosterSize, listDescriptionRows, showHorizontalScrollbar } = $derived.by(
    () => {
      // Resolve settings: Use the Side-Channel Hierarchy if available, otherwise fallback to legacy frontend resolution.
      const resolved = viewNode?.effective ?? resolveViewSettings(parentItem, settings).settings

      // The `layoutProp` is a special, one-off override from a parent component (e.g., search results view).
      // It should take precedence over all other resolved layout settings.
      if (layoutProp) {
        resolved.layout = layoutProp
      }

      return {
        layout: resolved.layout,
        // Allow fallback to standard keys but prioritize resolved values if they match the active layout
        gridPosterSize: resolved.gridPosterSize,
        listDescriptionRows: resolved.listDescriptionRows,
        showHorizontalScrollbar: (resolved as any).showHorizontalScrollbar
      }
    }
  )

  // --- Search Query Stability ---
  // This prevents the view from re-filtering while the user is in the middle of typing a tag.
  const isTypingTag = $derived(isTypingTagHelper(searchQuery?.text ?? ''))
  let stableSearchQuery = $state(searchQuery)
  $effect(() => {
    if (!isTypingTag) {
      stableSearchQuery = searchQuery
    }
  })

  // --- Helpers for data processing ---

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

    // Primary sort: files before folders
    if (a.type === 'file' && b.type === 'folder') {
      return -1
    }
    if (a.type === 'folder' && b.type === 'file') {
      return 1
    }

    // If types are the same, fallback to alphabetical name sort
    const aName = a.title ?? ('name' in a ? (a as LibraryItem).name : '')
    const bName = b.title ?? ('name' in b ? (b as LibraryItem).name : '')
    return aName.localeCompare(bName, undefined, { numeric: true })
  }

  // --- Data Processing ---
  // The API (and Query) now handles grouping.
  // We simply filter (search/tags) and then sort for simple views.

  const { itemsForViews, foldersForTabsOrSections } = $derived.by(() => {
    // 1. Filter first.
    const filteredItems = filterItems(items, stableSearchQuery ?? { text: '', tags: [] })

    // 2. Separate Folders (which may be Virtual Groups from backend) vs Loose Items
    if (layout === 'tabs' || layout === 'sections') {
      const folders = filteredItems.filter((i) => i.type === 'folder') as MediaFolder[]
      const looseItems = filteredItems.filter((i) => i.type !== 'folder')

      // Wrap loose items in a synthetic "Files" folder so they appear as a tab/section
      if (looseItems.length > 0) {
        folders.push({
          id: `_files:${parentItem?.id ?? 'root'}`,
          name: 'Files',
          type: 'folder',
          children: looseItems
        } as MediaFolder)
      }

      return {
        itemsForViews: [],
        foldersForTabsOrSections: folders.sort(compareItems) as MediaFolder[]
      }
    }

    // 3. Simple Views (Grid, List, Tree)
    // Just sort everything.
    const sortedItems = isPreSorted ? filteredItems : [...filteredItems].sort(compareItems)
    return { itemsForViews: sortedItems, foldersForTabsOrSections: [] }
  })

  // Extend the viewNode with a synthetic entry for the "Files" tab so it
  // receives inherited settings (e.g. I3 season defaults) like real folders.
  const effectiveViewNode = $derived.by(() => {
    if (!viewNode?.children) return viewNode
    const filesId = `_files:${parentItem?.id ?? 'root'}`
    if (viewNode.children[filesId]) return viewNode // already has an entry

    // Only inject if the Files tab actually exists
    const hasFiles = foldersForTabsOrSections.some((f) => f.id === filesId)
    if (!hasFiles) return viewNode

    const childSettings = viewNode.effective.childViewSettings
    const filesEffective = childSettings
      ? resolveViewSettings({ id: filesId, type: 'folder' } as any, settings, new Set(), childSettings).settings
      : resolveViewSettings({ id: filesId, type: 'folder' } as any, settings).settings

    return {
      ...viewNode,
      children: {
        ...viewNode.children,
        [filesId]: {
          id: filesId,
          stored: {} as StoredViewSettings,
          effective: filesEffective,
          children: undefined
        }
      }
    }
  })
</script>

{#if settings}
  <div
    class="media-grid-container"
  >
    {#if layout === 'grid'}
      <GridView
        items={itemsForViews}
        {onItemClick}
        {onShowContextMenu}
        {grayOutWatched}
        {parentItem}
        {gridPosterSize}
      />
    {:else if layout === 'tree'}
      <TreeView
        items={itemsForViews}
        {onItemClick}
        {onShowContextMenu}
        {grayOutWatched}
        {parentItem}
      />
    {:else if layout === 'horizontal-grid'}
      <HorizontalGridView
        items={itemsForViews}
        {onItemClick}
        {onShowContextMenu}
        {grayOutWatched}
        {parentItem}
        {gridPosterSize}
        {showHorizontalScrollbar}
      />
    {:else if layout === 'list'}
      <ListView
        items={itemsForViews}
        {onItemClick}
        {onShowContextMenu}
        {highlightedIndex}
        {grayOutWatched}
        {parentItem}
        {listDescriptionRows}
        fixedAspectRatio={listFixedAspectRatio}
      />
    {:else if layout === 'tabs'}
      <TabsView
        container={parentItem}
        folders={foldersForTabsOrSections}
        {onItemClick}
        {onShowContextMenu}
        {suggestions}
        {settings}
        viewNode={effectiveViewNode}
      />
    {:else if layout === 'sections'}
      <SectionsView
        container={parentItem}
        folders={foldersForTabsOrSections}
        {onItemClick}
        {onShowContextMenu}
        {suggestions}
        {settings}
        viewNode={effectiveViewNode}
      />
    {/if}
  </div>
{/if}

<style>
  .media-grid-container {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
  }
</style>
