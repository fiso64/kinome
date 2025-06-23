<script lang="ts">
  import GridView from '../views/GridView.svelte'
  import HorizontalGridView from '../views/HorizontalGridView.svelte'
  import TreeView from '../views/TreeView.svelte'
  import TabsView from '../views/TabsView.svelte'
  import SectionsView from '../views/SectionsView.svelte'
  import ListView from '../views/ListView.svelte'
  import { filterItems } from '../../../../shared/filter'
  import { resolveViewSettings } from '../../../../shared/settings-helpers'
  import { isTypingTag as isTypingTagHelper } from '../../lib/view-helpers'

  type Layout = 'grid' | 'horizontal-grid' | 'tree' | 'tabs' | 'sections' | 'list'
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
    grayOutWatched = true,
    settings,
    listFixedAspectRatio = false
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
    settings?: Settings | null
    listFixedAspectRatio?: boolean
  } = $props()

  const { layout, groupBy, gridPosterSize, listDescriptionRows, showHorizontalScrollbar } =
    $derived.by(() => {
      // Resolve settings using the centralized helper function.
      const resolved = resolveViewSettings(parentItem, settings).settings

      // The `layoutProp` is a special, one-off override from a parent component (e.g., search results view).
      // It should take precedence over all other resolved layout settings.
      if (layoutProp) {
        resolved.layout = layoutProp
      }

      return {
        layout: resolved.layout,
        groupBy: resolved.groupBy,
        gridPosterSize: resolved.gridPosterSize,
        listDescriptionRows: resolved.listDescriptionRows,
        showHorizontalScrollbar: (resolved as any).showHorizontalScrollbar
      }
    })

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

  // --- Derived State for different layouts ---
  const { itemsForViews, foldersForTabsOrSections } = $derived.by(() => {
    // 1. Filter first.
    const filteredItems = filterItems(items, stableSearchQuery ?? { text: '', tags: [] })

    // 2. Handle grouping for tabs/sections.
    if (layout === 'tabs' || layout === 'sections') {
      if (groupBy && groupBy !== 'folder') {
        // Group by metadata (create virtual folders).
        const groupByKey = groupBy
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
        // Group by physical folders, but also create virtual folders for loose files.
        const physicalFolders = [...filteredItems.filter((item) => item.type === 'folder')].sort(
          compareItems
        ) as MediaFolder[]

        const looseFiles = filteredItems.filter((item) => item.type === 'file') as LibraryItem[]
        const allVirtualFolders: VirtualFolder[] = []

        if (looseFiles.length > 0 && parentItem) {
          const filesBySeason = new Map<number, LibraryItem[]>()
          const unseasonedFiles: LibraryItem[] = []

          // 1. Categorize all loose files
          for (const file of looseFiles) {
            const seasonNum = 'seasonNumber' in file ? (file as MediaFile).seasonNumber : undefined
            if (seasonNum !== undefined && seasonNum !== null) {
              if (!filesBySeason.has(seasonNum)) {
                filesBySeason.set(seasonNum, [])
              }
              filesBySeason.get(seasonNum)!.push(file)
            } else {
              unseasonedFiles.push(file)
            }
          }

          // 2. Create sorted virtual folders for each season
          const sortedSeasonNumbers = Array.from(filesBySeason.keys()).sort((a, b) => a - b)
          for (const seasonNum of sortedSeasonNumbers) {
            let seasonLayout: Layout = settings?.defaultSeasonFolderLayout ?? 'list'
            if (seasonLayout === 'tabs' || seasonLayout === 'sections') {
              seasonLayout = 'list' // Safety downgrade
            }

            const seasonFolder: VirtualFolder = {
              id: `virtual--${parentItem.id}--season--${seasonNum}`,
              name: `Season ${seasonNum}`,
              title: `Season ${seasonNum}`,
              type: 'folder',
              children: filesBySeason.get(seasonNum)!,
              path: '',
              isVirtual: true,
              physicalParentId: parentItem.id,
              groupByKey: 'folder',
              groupByValue: `__season_${seasonNum}__`,
              layout: seasonLayout,
              mediaType: 'season',
              seasonNumber: seasonNum
            }
            allVirtualFolders.push(seasonFolder)
          }

          // 3. Create a virtual folder for any remaining "unseasoned" files
          if (unseasonedFiles.length > 0) {
            let filesLayout: Layout = 'tree' // Safe fallback
            if (settings) {
              switch (parentItem.mediaType) {
                case 'movie':
                  filesLayout = settings.defaultMovieFolderLayout ?? 'tree'
                  break
                case 'tv':
                  filesLayout = settings.defaultTvShowFolderLayout ?? 'list'
                  break
                default:
                  filesLayout = settings.defaultFolderLayout ?? 'grid'
              }
            }
            if (filesLayout === 'tabs' || filesLayout === 'sections') {
              filesLayout = 'tree' // Safety downgrade
            }

            const filesFolder: VirtualFolder = {
              id: `virtual--${parentItem.id}--files`,
              name: 'Files',
              title: 'Files',
              type: 'folder',
              children: unseasonedFiles,
              path: '',
              isVirtual: true,
              physicalParentId: parentItem.id,
              groupByKey: 'folder',
              groupByValue: '__files__',
              layout: filesLayout
            }
            allVirtualFolders.push(filesFolder)
          }
        }

        const finalFolders = [...allVirtualFolders, ...physicalFolders]
        return { itemsForViews: [], foldersForTabsOrSections: finalFolders }
      }
    }

    // 3. Handle simple views (grid, list, tree): just sort items.
    const sortedItems = isPreSorted ? filteredItems : [...filteredItems].sort(compareItems)

    return { itemsForViews: sortedItems, foldersForTabsOrSections: [] }
  })
</script>

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
      folders={foldersForTabsOrSections}
      {onItemClick}
      {onShowContextMenu}
      {suggestions}
      {grayOutWatched}
      {settings}
    />
  {:else if layout === 'sections'}
    <SectionsView
      folders={foldersForTabsOrSections}
      {onItemClick}
      {onShowContextMenu}
      {suggestions}
      {grayOutWatched}
      {settings}
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
