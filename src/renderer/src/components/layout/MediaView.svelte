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
    SearchIndexEntry
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
    listFixedAspectRatio = false
  }: {
    parentItem?: MediaFolder
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
    settings?: Settings | null
    listFixedAspectRatio?: boolean
  } = $props()

  const grayOutWatched = $derived(settings?.grayOutWatched ?? true)

  const { layout, gridPosterSize, listDescriptionRows, showHorizontalScrollbar } = $derived.by(
    () => {
      // Resolve settings using the centralized helper function.
      const resolved = resolveViewSettings(parentItem, settings).settings

      // The `layoutProp` is a special, one-off override from a parent component (e.g., search results view).
      // It should take precedence over all other resolved layout settings.
      if (layoutProp) {
        resolved.layout = layoutProp
      }

      return {
        layout: resolved.layout,
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
      // For these layouts, we expect the input `items` to ALREADY be grouped (virtual folders)
      // if a groupBy setting is active.
      // Or they are just physical subfolders.

      // If we have a groupBy, the backend returns Virtual Folders.
      // We just treat them as folders.
      const folders = filteredItems.filter((i) => i.type === 'folder') as MediaFolder[]

      // If we still have loose files here, it means they are NOT grouped or 'groupBy' is off.
      // In that case, we can't really show them in Tabs/Sections properly unless we wrap them??
      // But typically Tabs/Sections implies we want to see Groups.
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
</script>

{#if settings}
  <div
    class="media-grid-container"
    oncontextmenu={parentItem ? (e) => onShowContextMenu(parentItem, e, { layout }) : undefined}
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
      />
    {:else if layout === 'sections'}
      <SectionsView
        container={parentItem}
        folders={foldersForTabsOrSections}
        {onItemClick}
        {onShowContextMenu}
        {suggestions}
        {settings}
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
