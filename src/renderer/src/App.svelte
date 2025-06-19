<script lang="ts">
  import MediaView from './components/MediaView.svelte'
  import SettingsModal from './components/SettingsModal.svelte'
  import SearchInput from './components/SearchInput.svelte'
  import WindowControls from './components/WindowControls.svelte'
  import ItemDetail from './components/ItemDetail.svelte'
  import LayoutSelector from './components/LayoutSelector.svelte'
  import ContextMenu from './components/ContextMenu.svelte'
  import MetadataEditor from './components/MetadataEditor.svelte'
  import FolderSettingsModal from './components/FolderSettingsModal.svelte'
  import ManualSearchModal from './components/ManualSearchModal.svelte'
  import PropertiesModal from './components/PropertiesModal.svelte'
  import RenameModal from './components/RenameModal.svelte'
  import FilterBar from './components/FilterBar.svelte'
  import ListView from './components/media-views/ListView.svelte'
  import InitialFolderSettingsModal from './components/InitialFolderSettingsModal.svelte'
  import { initializeShortcuts } from './lib/shortcuts'
  import {
    getLoadedItem,
    updateCachedItem,
    clearItemCache,
    primeCacheWithRoot
  } from './lib/item-store'

  const log = (message: string): void => {
    console.log(`[${new Date().toISOString()}] [Renderer] ${message}`)
  }

  type ActiveModal =
    | { type: 'settings' }
    | { type: 'layoutSelector'; item: MediaFolder; defaultLayout: 'grid' | 'tree' }
    | { type: 'metadataEditor'; item: LibraryItem }
    | { type: 'folderSettings'; item: MediaFolder }
    | { type: 'manualSearch'; item: LibraryItem; initialTab?: 'match' | 'artwork' }
    | { type: 'properties'; item: LibraryItem }
    | { type: 'rename'; item: LibraryItem }
    | { type: 'initialFolderSettings'; root: MediaFolder }

  let viewStack: MediaFolder[] = $state([])
  let lastDetailItem: LibraryItem | null = $state(null)
  let isScanning = $state(true)
  let isRefreshing = $state(false)

  // --- Search & Filter State ---
  // For the main, full-page search
  let globalSearchQuery = $state({ text: '', tags: [] as { key: string; value: string }[] })
  const isGlobalSearchActive = $derived(
    globalSearchQuery.text.trim() !== '' || globalSearchQuery.tags.length > 0
  )
  let searchResults = $state<SearchIndexEntry[]>([])
  let highlightedSearchItemIndex = $state<number | null>(null)
  let isPerformingSearch = $state(false)

  // For the search dropdown in the detail view
  let detailViewSearchQuery = $state({ text: '', tags: [] as { key: string; value: string }[] })
  const isDetailSearchActive = $derived(
    detailViewSearchQuery.text.trim() !== '' || detailViewSearchQuery.tags.length > 0
  )
  let detailViewSearchResults = $state<SearchIndexEntry[]>([])
  let highlightedDetailSearchItemIndex = $state<number | null>(null)
  let isPerformingDetailSearch = $state(false)

  // For the local filter bar
  let filterQuery = $state<{ text: string; tags: { key: string; value: string }[] }>({
    text: '',
    tags: []
  })
  let isFilterBarVisible = $state(false)
  let filterFocusKey = $state(0)
  // --- End Search & Filter State ---

  let allAutocompleteSuggestions = $state<AutocompleteSuggestions>({
    mediaTypes: [],
    genres: [],
    tagKeys: [],
    tagValues: {}
  })

  const groupByKeys = $derived([
    'folder',
    'mediaType',
    'genre',
    'year',
    ...(settings?.virtualTags?.map((vt) => `vt.${vt.name}`) ?? []),
    ...allAutocompleteSuggestions.tagKeys.map((k) => `tags.${k}`)
  ])
  let selectedItemForDetailView: LibraryItem | null = $state(null)
  let searchInputEl = $state<HTMLInputElement | undefined>(undefined)
  let activeModal = $state<ActiveModal | null>(null)
  let settings = $state<Settings | null>(null)

  // Global Context Menu State
  let contextMenuItem = $state<LibraryItem | null>(null)
  let contextMenuPosition = $state({ top: 0, left: 0 })
  let contextMenuLayout = $state<string | undefined>(undefined)
  let isContextMenuVisible = $state(false)

  const currentFolder = $derived(viewStack.length > 0 ? viewStack[viewStack.length - 1] : null)
  const canGoBack = $derived(
    selectedItemForDetailView !== null || viewStack.length > 1 || isGlobalSearchActive
  )

  const folderToConfigureLayout = $derived(
    selectedItemForDetailView?.type === 'folder'
      ? (selectedItemForDetailView as MediaFolder)
      : currentFolder
  )

  // This effect runs once on mount to fetch initial data
  $effect(() => {
    log('App mounted. Requesting library root from main process...')
    window.api.getLibraryRoot().then(async (root) => {
      log('Library root received from main process.')
      if (root) {
        primeCacheWithRoot(root)
        viewStack = [root]
        log('Root view rendered.')
      } else {
        log('No library found. Displaying welcome screen.')
      }
      isScanning = false
    })

    window.api.getAutocompleteSuggestions().then((s) => (allAutocompleteSuggestions = s))
    window.api.getSettings().then((s) => (settings = s))

    const unlistenSuggestions = window.api.onAutocompleteSuggestionsUpdated((s) => {
      allAutocompleteSuggestions = s
    })
    return () => unlistenSuggestions()
  })

  // This effect is reactive and will update the CSS variable whenever the settings change
  $effect(() => {
    if (settings?.gridPosterSize) {
      document.documentElement.style.setProperty(
        '--grid-poster-size',
        `${settings.gridPosterSize}px`
      )
    }
  })

  $effect(() => {
    // When navigating away from search results, clear the filter.
    void currentFolder?.id
    if (!isGlobalSearchActive) {
      filterQuery = { text: '', tags: [] }
    }
  })

  let wasFilterBarVisible = false
  $effect(() => {
    // Hide filter bar when navigating to detail view or global search, and restore it when returning.
    if (selectedItemForDetailView || isGlobalSearchActive) {
      if (isFilterBarVisible) {
        wasFilterBarVisible = true
        isFilterBarVisible = false
      }
    } else {
      if (wasFilterBarVisible) {
        isFilterBarVisible = true
        wasFilterBarVisible = false // Reset the flag
      }
    }
  })

  // --- Global Search Effect (No Debounce) ---
  $effect(() => {
    // VERY IMPORTANT NOTE:
    // This search is intentionally not debounced to provide instant feedback on
    // local filesystems. When network-based sources (like Rclone/Jellyfin) are
    // implemented, the search logic for those sources MUST be debounced to
    // prevent excessive network requests and API calls. The current implementation
    // would be highly inefficient over a network.

    const query = globalSearchQuery
    if (isGlobalSearchActive) {
      isPerformingSearch = true
      selectedItemForDetailView = null
      const plainQuery = JSON.parse(JSON.stringify(query))
      window.api.performSearch(plainQuery).then((results) => {
        searchResults = results
        isPerformingSearch = false
        highlightedSearchItemIndex = results.length > 0 ? 0 : null
      })
    } else {
      searchResults = []
      isPerformingSearch = false
      highlightedSearchItemIndex = null
    }
  })

  // --- Detail View Search Effect ---
  $effect(() => {
    // VERY IMPORTANT NOTE: See the note on the global search effect. This search
    // must also be debounced when network sources are added.

    const query = detailViewSearchQuery
    if (selectedItemForDetailView && isDetailSearchActive) {
      isPerformingDetailSearch = true
      const plainQuery = JSON.parse(JSON.stringify(query))
      window.api.performSearch(plainQuery).then((results) => {
        detailViewSearchResults = results
        isPerformingDetailSearch = false
        highlightedDetailSearchItemIndex = results.length > 0 ? 0 : null
      })
    } else {
      detailViewSearchResults = []
      isPerformingDetailSearch = false
      highlightedDetailSearchItemIndex = null
    }
  })

  // Effect to close detail view search dropdown when clicking outside
  $effect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const searchContainer = document.querySelector('.search-container')
      if (searchContainer && !searchContainer.contains(event.target as Node)) {
        detailViewSearchQuery = { text: '', tags: [] }
      }
    }
    if (selectedItemForDetailView && isDetailSearchActive) {
      window.addEventListener('click', handleClickOutside, { capture: true })
    }
    return () => {
      window.removeEventListener('click', handleClickOutside, { capture: true })
    }
  })

  $effect(() => {
    // Auto-highlight the first search result or clear highlight
    if (searchResults.length > 0) {
      if (
        highlightedSearchItemIndex === null ||
        highlightedSearchItemIndex >= searchResults.length
      ) {
        highlightedSearchItemIndex = 0
      }
    } else {
      highlightedSearchItemIndex = null
    }
  })

  // Set up a listener for real-time metadata updates from the main process.
  $effect(() => {
    const unlisten = window.api.onLibraryItemUpdated((updatedItem) => {
      updateCachedItem(updatedItem)

      let wasHandledInView = false

      // --- Case 1: A detail view is active. Check for updates there first. ---
      if (selectedItemForDetailView) {
        // A) Is the updated item the main subject of the detail view?
        if (selectedItemForDetailView.id === updatedItem.id) {
          selectedItemForDetailView = { ...selectedItemForDetailView, ...updatedItem }
          wasHandledInView = true
        }
        // B) Is the updated item a descendant of the detail view item?
        else if (selectedItemForDetailView.type === 'folder') {
          // Recursively find the parent of the updated item within the detail view's data structure.
          const parentInDetailView = findParentOfItem(selectedItemForDetailView, updatedItem.id)
          if (parentInDetailView) {
            const childIndex = parentInDetailView.children.findIndex((c) => c.id === updatedItem.id)
            if (childIndex !== -1) {
              // To trigger reactivity, we need to replace the children array, not just mutate it.
              parentInDetailView.children = [
                ...parentInDetailView.children.slice(0, childIndex),
                updatedItem,
                ...parentInDetailView.children.slice(childIndex + 1)
              ]
              // Then, trigger a top-level update on the detail view item to ensure Svelte
              // re-renders the component tree and picks up the deep change.
              selectedItemForDetailView = { ...selectedItemForDetailView }
              wasHandledInView = true
            }
          }
        }
      }

      // --- Case 2: Update the main grid/list view if not handled by detail view. ---
      if (!wasHandledInView && currentFolder) {
        const parent = findParentOfItem(currentFolder, updatedItem.id)
        if (parent) {
          const itemIndex = parent.children.findIndex((child) => child.id === updatedItem.id)
          if (itemIndex !== -1) {
            parent.children = [
              ...parent.children.slice(0, itemIndex),
              updatedItem,
              ...parent.children.slice(itemIndex + 1)
            ]
          }
        }
      }

      // --- Case 3: Update search results list, if active. ---
      const indexInSearch = searchResults.findIndex((i) => i.id === updatedItem.id)
      if (indexInSearch > -1) {
        const itemInSearch = searchResults[indexInSearch]
        // Update all relevant fields for the search result entry
        Object.assign(itemInSearch, {
          title: updatedItem.title ?? updatedItem.name,
          posterPath: updatedItem.posterPath,
          _v: updatedItem._v,
          watched: 'watched' in updatedItem ? updatedItem.watched : undefined
        })
        searchResults = [...searchResults]
      }
    })
    return () => unlisten()
  })

  // Listener for BATCH metadata updates
  $effect(() => {
    const unlisten = window.api.onLibraryItemsUpdated((updatedItems) => {
      log(`Received batch update for ${updatedItems.length} items.`)

      for (const updatedItem of updatedItems) {
        updateCachedItem(updatedItem)

        let itemInTree: LibraryItem | null = null
        for (const folder of viewStack) {
          itemInTree = findItemInTree(folder, updatedItem.id)
          if (itemInTree) break
        }
        if (itemInTree) Object.assign(itemInTree, updatedItem)

        // Find and update item if it's the detail view subject or one of its descendants.
        if (selectedItemForDetailView) {
          if (selectedItemForDetailView.id === updatedItem.id) {
            Object.assign(selectedItemForDetailView, updatedItem)
          } else if (selectedItemForDetailView.type === 'folder') {
            const itemInDetailTree = findItemInTree(selectedItemForDetailView, updatedItem.id)
            if (itemInDetailTree) {
              Object.assign(itemInDetailTree, updatedItem)
            }
          }
        }
        // Update item if it's in the current search results
        const indexInSearch = searchResults.findIndex((i) => i.id === updatedItem.id)
        if (indexInSearch > -1) {
          const itemInSearch = searchResults[indexInSearch]
          // Only update fields that exist on SearchIndexEntry
          itemInSearch.title = updatedItem.title ?? updatedItem.name
          itemInSearch.posterPath = updatedItem.posterPath
          itemInSearch._v = updatedItem._v
        }
      }

      // Trigger reactivity after all items in the batch are processed
      viewStack = [...viewStack]
      searchResults = [...searchResults]
      if (selectedItemForDetailView) {
        selectedItemForDetailView = { ...selectedItemForDetailView }
      }
    })
    return () => unlisten()
  })

  function findPathToItem(root: MediaFolder, id: string): MediaFolder[] {
    const path: MediaFolder[] = []
    function find(current: MediaFolder): boolean {
      path.push(current)
      if (current.id === id) return true
      for (const child of current.children) {
        if (child.type === 'folder') {
          if (find(child as MediaFolder)) return true
        }
      }
      path.pop()
      return false
    }
    if (root && find(root)) {
      return path
    }
    return []
  }

  function findItemInTree(node: MediaFolder, id: string): LibraryItem | null {
    if (!node || !node.children) return null
    if (node.id === id) {
      return node
    }
    for (const child of node.children) {
      if (child.id === id) {
        return child
      }
      if (child.type === 'folder') {
        const found = findItemInTree(child, id)
        if (found) return found
      }
    }
    return null
  }

  function findParentOfItem(node: MediaFolder, id: string): MediaFolder | null {
    if (!node || !node.children) return null
    for (const child of node.children) {
      if (child.id === id) {
        return node
      }
      if (child.type === 'folder') {
        const found = findParentOfItem(child, id)
        if (found) return found
      }
    }
    return null
  }

  function drillDown(childFolder: MediaFolder) {
    const parent = selectedItemForDetailView
    if (!parent) return

    const root = viewStack[0]
    if (!root) return

    const pathToParent = findPathToItem(root, parent.id)
    if (pathToParent.length > 0) {
      lastDetailItem = parent
      selectedItemForDetailView = null
      viewStack = [...pathToParent, childFolder]
    }
  }

  function handleContextMenuOpen(item: LibraryItem | SearchIndexEntry) {
    handleItemClick(item)
  }

  async function handleScan(): Promise<void> {
    isScanning = true
    selectedItemForDetailView = null
    lastDetailItem = null
    clearItemCache()
    viewStack = [] // Clear the view stack to show the welcome/loading screen
    const newRoot = await window.api.scanLibrary()
    if (newRoot) {
      primeCacheWithRoot(newRoot)
      activeModal = { type: 'initialFolderSettings', root: newRoot }
    }
    isScanning = false
  }

  async function handleRefresh(): Promise<void> {
    if (isRefreshing || isScanning) return
    isRefreshing = true
    lastDetailItem = null
    clearItemCache()
    const refreshedRoot = await window.api.refreshLibrary()
    if (refreshedRoot) {
      const loadedRoot = await getLoadedItem(refreshedRoot.id)
      if (loadedRoot) {
        viewStack = [loadedRoot as MediaFolder]
        selectedItemForDetailView = null
      }
    }
    isRefreshing = false
  }

  async function handlePlayFile(item: MediaFile): Promise<void> {
    const plainFile: MediaFile = {
      id: item.id,
      name: item.name,
      path: item.path,
      type: 'file',
      watched: item.watched
    }
    // Call the main process to play the file and update the DB.
    // The main process will now broadcast the 'library-item-updated' event
    // via the proxy, which will be caught by the listener.
    await window.api.playFile(plainFile)
  }

  async function handleRevealItem(item: LibraryItem) {
    // No path means it's probably a virtual item or from a remote source
    if (!item.path) {
      console.warn('Item has no path, cannot reveal.', item)
      return
    }
    window.api.revealInExplorer(item.path)
  }

  async function handleApplyInitialSettings(
    settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]
  ) {
    await window.api.applyInitialFolderSettings(settings)
    // After applying, load and display the root of the library.
    const root = await window.api.getLibraryRoot()
    if (root) {
      primeCacheWithRoot(root)
      const loadedRoot = await getLoadedItem(root.id)
      if (loadedRoot) viewStack = [loadedRoot as MediaFolder]
    }
  }

  async function handleDeleteItem(item: LibraryItem) {
    if (!item.path) {
      console.warn('Item has no path, cannot delete.', item)
      return
    }

    const confirmed = confirm(
      `Are you sure you want to move "${item.title ?? item.name}" to the trash?\n\nThis action cannot be undone from within the app.`
    )
    if (!confirmed) {
      return
    }

    const success = await window.api.trashItem(item.path)
    if (success) {
      // Refresh the library to reflect the deletion
      await handleRefresh()
    }
  }

  async function handleRenameItem(item: LibraryItem) {
    if (!item.path) return
    activeModal = { type: 'rename', item }
  }

  function handleShowProperties(item: LibraryItem) {
    if (!item.path) return
    activeModal = { type: 'properties', item }
  }

  async function handleItemClick(item: LibraryItem | SearchIndexEntry): Promise<void> {
    const fromSearch = 'staticScore' in item

    const loadedItem = await getLoadedItem(item.id)
    if (!loadedItem) {
      console.error('Failed to load item from store:', item.id)
      return
    }

    // --- Is the click on an item INSIDE an active detail view? ---
    if (selectedItemForDetailView) {
      const parent = selectedItemForDetailView

      // Playable file click inside detail view
      if (loadedItem.type === 'file' && !loadedItem.opensAsFolder) {
        handlePlayFile(loadedItem)
        return
      }

      // It's a folder or special file that opens another detail view from within a detail view
      if (
        loadedItem.type === 'folder' &&
        (parent as MediaFolder).childrenClickAction === 'navigate'
      ) {
        drillDown(loadedItem as MediaFolder)
      } else {
        // Default 'detail' action when drilling down
        lastDetailItem = parent
        // The current detail view's item becomes part of the breadcrumb trail if it's a folder
        if (parent.type === 'folder') {
          viewStack.push(parent)
        }
        selectedItemForDetailView = loadedItem
      }
      return
    }

    // --- The click is from the main view (grid, list, etc.) or search results ---

    // Playable file click from main view
    if (loadedItem.type === 'file' && !loadedItem.opensAsFolder) {
      handlePlayFile(loadedItem)
      return
    }
    // Tree view special case for playing files
    if (loadedItem.type === 'file' && (currentFolder?.layout ?? 'grid') === 'tree') {
      handlePlayFile(loadedItem)
      return
    }

    // Main view folder navigation
    if (loadedItem.type === 'folder' && currentFolder?.childrenClickAction === 'navigate') {
      handleNavigateFolder(loadedItem as MediaFolder)
      return
    }

    // Default action from main view: open detail view
    lastDetailItem = null // Important: reset lastDetailItem
    selectedItemForDetailView = loadedItem
    detailViewSearchQuery = { text: '', tags: [] }

    // If click was from search results, update highlight
    if (fromSearch) {
      const clickedIndex = searchResults.findIndex((sr) => sr.id === item.id)
      if (clickedIndex !== -1) {
        highlightedSearchItemIndex = clickedIndex
      }
    }
  }

  function handleNavigateFolder(folder: MediaFolder): void {
    selectedItemForDetailView = null
    lastDetailItem = null
    viewStack.push(folder)
  }

  function goBack(): void {
    if (!canGoBack) return

    if (isGlobalSearchActive && !selectedItemForDetailView) {
      globalSearchQuery = { text: '', tags: [] }
      return
    }

    if (selectedItemForDetailView) {
      if (lastDetailItem) {
        selectedItemForDetailView = lastDetailItem
        viewStack.pop()
        lastDetailItem = null
      } else {
        selectedItemForDetailView = null
      }
    } else {
      if (lastDetailItem) {
        selectedItemForDetailView = lastDetailItem
        viewStack.pop()
        viewStack.pop()
        lastDetailItem = null
      } else if (viewStack.length > 1) {
        viewStack.pop()
      }
    }
  }

  function goForward(): void {
    // This can be implemented in the future to handle forward navigation.
  }

  async function handleDetailSearchItemClick(item: SearchIndexEntry) {
    // This click replaces the current detail view with a new one.
    const loadedItem = await getLoadedItem(item.id)
    if (!loadedItem) {
      console.error('Failed to load item from store:', item.id)
      return
    }

    // Treat this as a navigation: the current item becomes the "last" one for back-button purposes.
    lastDetailItem = selectedItemForDetailView
    // The viewStack logic for `lastDetailItem` expects a folder, so we only push if it is one.
    // This is a simplification; a more robust solution might need a separate history stack.
    if (lastDetailItem?.type === 'folder') {
      viewStack.push(lastDetailItem as MediaFolder)
    }

    selectedItemForDetailView = loadedItem
    detailViewSearchQuery = { text: '', tags: [] } // This will hide the dropdown.
  }

  function handleSearchByTag(key: string, value: string): void {
    selectedItemForDetailView = null
    globalSearchQuery = { text: '', tags: [{ key, value }] }
  }

  function handleSearchKeyDown(event: KeyboardEvent) {
    const autocompleteMenu = document.querySelector('.autocomplete-menu')
    if (autocompleteMenu && autocompleteMenu.contains(event.target as Node)) {
      return // Let autocomplete handle its own keyboard events
    }

    const isDetailContext = !!selectedItemForDetailView
    const items = isDetailContext ? detailViewSearchResults : searchResults
    let highlightedIndex = isDetailContext
      ? highlightedDetailSearchItemIndex
      : highlightedSearchItemIndex

    if (items.length === 0) return

    let newIndex = highlightedIndex
    let shouldPreventDefault = false

    if (event.key === 'ArrowDown') {
      shouldPreventDefault = true
      if (highlightedIndex === null) {
        newIndex = 0
      } else {
        newIndex = (highlightedIndex + 1) % items.length
      }
    } else if (event.key === 'ArrowUp') {
      shouldPreventDefault = true
      if (highlightedIndex === null || highlightedIndex === 0) {
        newIndex = items.length - 1
      } else {
        newIndex--
      }
    } else if (event.key === 'Enter') {
      shouldPreventDefault = true
      if (highlightedIndex !== null) {
        const selectedResult = items[highlightedIndex]
        if (selectedResult) {
          if (isDetailContext) {
            handleDetailSearchItemClick(selectedResult)
          } else {
            handleItemClick(selectedResult)
          }
        }
      }
    }

    if (shouldPreventDefault) {
      event.preventDefault()
    }

    if (newIndex !== highlightedIndex) {
      if (isDetailContext) {
        highlightedDetailSearchItemIndex = newIndex
      } else {
        highlightedSearchItemIndex = newIndex
      }
    }
  }

  $effect(() => {
    const cleanupShortcuts = initializeShortcuts({
      openSettings: () => (activeModal = { type: 'settings' }),
      focusSearch: () => {
        searchInputEl?.focus()
        searchInputEl?.select()
      },
      navigateBack: goBack,
      navigateForward: goForward,
      reloadLibrary: handleRefresh,
      showAndFocusFilterBar: () => {
        if (isFilterBarVisible) {
          // If already visible, just increment the key to trigger a refocus.
          filterFocusKey++
        } else {
          // Otherwise, make it visible. The effect in FilterBar will handle the initial focus.
          isFilterBarVisible = true
        }
      }
    })
    return () => cleanupShortcuts()
  })

  function openLayoutSelector() {
    if (folderToConfigureLayout) {
      const isDetailViewContext = selectedItemForDetailView?.id === folderToConfigureLayout.id
      activeModal = {
        type: 'layoutSelector',
        item: folderToConfigureLayout,
        defaultLayout: isDetailViewContext ? 'tree' : 'grid'
      }
    }
  }

  async function handleShowContextMenu(
    item: LibraryItem | SearchIndexEntry,
    event: MouseEvent,
    options?: { layout?: string }
  ) {
    event.preventDefault()
    event.stopPropagation()

    // If it's a search result, we only have partial data.
    // Fetch the full LibraryItem before showing the menu.
    if ('staticScore' in item) {
      const fullItem = await getLoadedItem(item.id)
      if (fullItem) {
        contextMenuItem = fullItem
      } else {
        return // Can't show menu if full item fails to load
      }
    } else {
      // It's already a full LibraryItem
      contextMenuItem = item
    }

    contextMenuLayout = options?.layout
    contextMenuPosition = { top: event.clientY, left: event.clientX }
    isContextMenuVisible = true
  }
</script>

{#if activeModal}
  {#if activeModal.type === 'settings'}
    <SettingsModal
      close={() => {
        const wasSettings = activeModal?.type === 'settings'
        activeModal = null
        if (wasSettings) {
          window.api.getSettings().then((s) => (settings = s))
        }
      }}
      scanLibrary={handleScan}
    />
  {:else if activeModal.type === 'layoutSelector'}
    <LayoutSelector
      item={activeModal.item}
      {groupByKeys}
      onClose={() => (activeModal = null)}
      defaultLayout={activeModal.defaultLayout}
    />
  {:else if activeModal.type === 'metadataEditor'}
    <MetadataEditor item={activeModal.item} onClose={() => (activeModal = null)} />
  {:else if activeModal.type === 'folderSettings'}
    <FolderSettingsModal
      item={activeModal.item}
      onClose={() => (activeModal = null)}
      onNeedRefresh={handleRefresh}
    />
  {:else if activeModal.type === 'manualSearch'}
    <ManualSearchModal
      item={activeModal.item}
      initialTab={activeModal.initialTab}
      onClose={() => (activeModal = null)}
    />
  {:else if activeModal.type === 'properties'}
    <PropertiesModal item={activeModal.item} onClose={() => (activeModal = null)} />
  {:else if activeModal.type === 'rename'}
    <RenameModal
      item={activeModal.item}
      onClose={() => (activeModal = null)}
      onNeedRefresh={handleRefresh}
    />
  {:else if activeModal.type === 'initialFolderSettings'}
    <InitialFolderSettingsModal
      root={activeModal.root}
      onApply={handleApplyInitialSettings}
      onClose={() => {
        // If user closes without applying, we still need to show the (un-fetched) library
        handleApplyInitialSettings([])
        activeModal = null
      }}
    />
  {/if}
{/if}

{#if contextMenuItem}
  <ContextMenu
    item={contextMenuItem}
    position={contextMenuPosition}
    isTreeView={contextMenuLayout === 'tree'}
    onClose={() => {
      contextMenuItem = null
      isContextMenuVisible = false
    }}
    onOpen={() => {
      if (contextMenuItem) {
        handleContextMenuOpen(contextMenuItem)
      }
    }}
    onEditMetadata={() => {
      if (contextMenuItem) {
        activeModal = { type: 'metadataEditor', item: contextMenuItem }
      }
    }}
    onSetLayout={() => {
      if (contextMenuItem?.type === 'folder') {
        const itemToConfigure = contextMenuItem as MediaFolder
        const isDetailViewContext =
          selectedItemForDetailView && selectedItemForDetailView.id === itemToConfigure.id

        activeModal = {
          type: 'layoutSelector',
          item: itemToConfigure,
          defaultLayout: isDetailViewContext ? 'tree' : 'grid'
        }
      }
    }}
    onOpenFolderSettings={() => {
      if (contextMenuItem?.type === 'folder') {
        activeModal = { type: 'folderSettings', item: contextMenuItem }
      }
    }}
    onManualSearch={() => {
      if (contextMenuItem) {
        activeModal = { type: 'manualSearch', item: contextMenuItem, initialTab: 'match' }
      }
    }}
    onEditArtwork={() => {
      if (contextMenuItem) {
        activeModal = { type: 'manualSearch', item: contextMenuItem, initialTab: 'artwork' }
      }
    }}
    onRevealInExplorer={() => {
      if (contextMenuItem) {
        handleRevealItem(contextMenuItem)
      }
    }}
    onDeleteItem={() => {
      if (contextMenuItem) {
        handleDeleteItem(contextMenuItem)
      }
    }}
    onRenameItem={() => {
      if (contextMenuItem) {
        handleRenameItem(contextMenuItem)
      }
    }}
    onShowProperties={() => {
      if (contextMenuItem) {
        handleShowProperties(contextMenuItem)
      }
    }}
  />
{/if}

<main>
  <header class:in-detail-view={selectedItemForDetailView}>
    <div class="header-content" class:no-drag={isContextMenuVisible}>
      <div class="header-left">
        <button class="back-button" class:hidden={!canGoBack} onclick={goBack} title="Go back">
          ←
        </button>
        <!-- In detail view, the title is handled by the component itself -->
        {#if !selectedItemForDetailView}
          <h1>
            {#if isGlobalSearchActive}
              Search Results
            {:else}
              {currentFolder?.title ?? currentFolder?.name ?? 'Media Browser'}
            {/if}
          </h1>
        {/if}
      </div>

      <div class="search-container" onkeydown={handleSearchKeyDown}>
        {#if selectedItemForDetailView}
          <SearchInput
            bind:query={detailViewSearchQuery}
            suggestions={allAutocompleteSuggestions}
            bind:element={searchInputEl}
          />
        {:else}
          <SearchInput
            bind:query={globalSearchQuery}
            suggestions={allAutocompleteSuggestions}
            bind:element={searchInputEl}
          />
        {/if}

        {#if selectedItemForDetailView && (isDetailSearchActive || isPerformingDetailSearch)}
          <div class="search-dropdown">
            {#if isPerformingDetailSearch && detailViewSearchResults.length === 0}
              <div class="dropdown-status">Searching...</div>
            {:else if detailViewSearchResults.length > 0}
              <ListView
                items={detailViewSearchResults}
                onItemClick={handleDetailSearchItemClick}
                onShowContextMenu={(item, e) => handleShowContextMenu(item, e, { layout: 'list' })}
                highlightedIndex={highlightedDetailSearchItemIndex}
                fixedAspectRatio={true}
              />
            {:else if !isPerformingDetailSearch}
              <div class="dropdown-status">No results found.</div>
            {/if}
          </div>
        {/if}
      </div>

      <div class="header-right">
        {#if !selectedItemForDetailView}
          <button
            onclick={handleRefresh}
            disabled={isRefreshing || isScanning}
            title="Refresh Library (F5)"
            class="refresh-button"
          >
            <span class:reloading={isRefreshing}>⟳</span>
          </button>
        {/if}
        {#if folderToConfigureLayout}
          <button onclick={openLayoutSelector} title="Set View Layout" class="layout-button">
            <!-- A simple layout icon -->
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
              ></rect>
              <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
              ></rect>
              <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
              ></rect>
              <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"
              ></rect>
            </svg>
          </button>
          <button
            onclick={(e) => handleShowContextMenu(folderToConfigureLayout, e)}
            title="More options..."
            class="more-options-button"
          >
            <!-- vertical ellipsis icon -->
            <svg
              width="16"
              height="16"
              viewBox="0 0 4 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              ><path
                d="M2 4C3.10457 4 4 3.10457 4 2C4 0.895431 3.10457 0 2 0C0.895431 0 0 0.895431 0 2C0 3.10457 0.895431 4 2 4Z"
                fill="currentColor"
              /><path
                d="M2 10C3.10457 10 4 9.10457 4 8C4 6.89543 3.10457 6 2 6C0.895431 6 0 6.89543 0 8C0 9.10457 0.895431 10 2 10Z"
                fill="currentColor"
              /><path
                d="M2 16C3.10457 16 4 15.1046 4 14C4 12.8954 3.10457 12 2 12C0.895431 12 0 12.8954 0 14C0 15.1046 0.895431 16 2 16Z"
                fill="currentColor"
              /></svg
            >
          </button>
        {/if}
        <button
          onclick={() => (activeModal = { type: 'settings' })}
          title="Settings"
          class="settings-button">⚙️</button
        >
      </div>
    </div>
    <WindowControls />
  </header>

  <div class="content">
    {#if isScanning}
      <!-- <p class="status-text">Loading library...</p> -->
    {:else if !currentFolder && !isGlobalSearchActive}
      <div class="welcome-screen">
        <h2>Welcome to Media Browser</h2>
        <p>To get started, scan a folder containing your media.</p>
        <button onclick={handleScan}>Select Media Folder</button>
      </div>
    {:else}
      <div class="main-view-container" class:hidden={selectedItemForDetailView}>
        <!-- SEARCH VIEW: Rendered but hidden via CSS unless active -->
        <div class="view-wrapper" class:hidden={!isGlobalSearchActive}>
          <div class="search-header">
            {#if isPerformingSearch}
              <span>Searching...</span>
            {:else}
              <span>Found {searchResults.length} results.</span>
            {/if}
          </div>
          <div class="search-content-wrapper">
            {#if searchResults.length > 0}
              <MediaView
                items={searchResults}
                onItemClick={handleItemClick}
                layout="list"
                onShowContextMenu={handleShowContextMenu}
                suggestions={allAutocompleteSuggestions}
                highlightedIndex={highlightedSearchItemIndex}
                isPreSorted={true}
                grayOutWatched={false}
                listFixedAspectRatio={true}
              />
            {:else if !isPerformingSearch}
              <p class="status-text">No results found.</p>
            {/if}
          </div>
        </div>

        <!-- FOLDER VIEW: Rendered but hidden via CSS unless active -->
        {#if currentFolder}
          <div class="view-wrapper" class:hidden={isGlobalSearchActive}>
            <div class="folder-content-wrapper">
              <MediaView
                parentItem={currentFolder}
                items={currentFolder.children}
                searchQuery={filterQuery}
                onItemClick={handleItemClick}
                layout={currentFolder.layout ?? settings?.defaultFolderLayout ?? 'grid'}
                onShowContextMenu={handleShowContextMenu}
                suggestions={allAutocompleteSuggestions}
                {settings}
              />
            </div>
          </div>
        {/if}
      </div>

      {#if selectedItemForDetailView && settings}
        <ItemDetail
          item={selectedItemForDetailView}
          onItemClick={handleItemClick}
          onSearchByTag={handleSearchByTag}
          showContextMenu={handleShowContextMenu}
          {settings}
        />
      {/if}
    {/if}
  </div>

  {#if isFilterBarVisible}
    <FilterBar
      suggestions={allAutocompleteSuggestions}
      bind:query={filterQuery}
      focusKey={filterFocusKey}
      onClose={() => {
        isFilterBarVisible = false
        // Clear the filter state when it's manually closed.
        filterQuery = { text: '', tags: [] }
      }}
    />
  {/if}
</main>

<style>
  .search-container {
    display: flex;
    justify-content: center;
    min-width: 0; /* Let the child dictate min-width */
    position: relative;
    /* This shift is no longer needed with the new layout */
    /* left: 50px; */
  }

  .search-dropdown {
    position: absolute;
    top: calc(100% + 5px); /* Position below the search input */
    left: 0;
    right: 0;
    z-index: 200;
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-background-mute);
    border-radius: 8px;
    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
    max-height: 70vh;
    overflow-y: auto;
    /* The ListView inside will need some padding */
  }
  .search-dropdown :global(.media-list) {
    padding: 0.5rem;
  }
  .dropdown-status {
    padding: 2rem;
    text-align: center;
    color: var(--ev-c-text-2);
  }

  main {
    --header-height: 54px;
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }

  header {
    display: flex;
    border-bottom: 1px solid var(--color-background-mute);
    height: var(--header-height);
    flex-shrink: 0;
    transition: background-color 0.3s ease;
    position: relative;
    z-index: 10;
  }

  header.in-detail-view {
    background-color: transparent;
    border-bottom: none;
  }

  .header-content {
    flex-grow: 1;
    display: grid;
    /* The middle column will be at least its min-content size, but no more than 1000px. */
    /* The side columns take up the remaining space equally, ensuring stability. */
    grid-template-columns: 1fr minmax(auto, 1000px) 1fr;
    align-items: center;
    gap: 1.5rem;
    padding: 0 1.5rem;
    -webkit-app-region: drag;
  }

  .header-left,
  .header-right {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .header-left {
    overflow: hidden; /* For long folder names */
    justify-self: start;
  }

  .header-right {
    justify-self: end;
  }

  h1 {
    font-size: 1.2rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .back-button,
  .refresh-button,
  .layout-button,
  .more-options-button,
  .settings-button {
    width: 36px;
    height: 36px;
    padding: 0;
    font-size: 1.2rem;
    line-height: 1;
    display: inline-flex;
    justify-content: center;
    align-items: center;
    flex-shrink: 0;
  }

  .settings-button,
  .layout-button,
  .more-options-button {
    background-color: var(--ev-button-alt-bg);
    color: var(--ev-c-text-1);
  }

  .back-button.hidden {
    visibility: hidden;
  }

  .welcome-screen button {
    flex-shrink: 0;
  }

  .content {
    flex-grow: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    scrollbar-gutter: stable;
    position: relative; /* Needed for the absolute positioned detail view */
  }

  .main-view-container {
    display: flex;
    flex-direction: column;
    flex: 1;
    position: relative; /* For stacking contexts */
  }
  .main-view-container.hidden {
    visibility: hidden;
  }

  .view-wrapper {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .view-wrapper.hidden {
    visibility: hidden;
  }

  .folder-content-wrapper,
  .search-content-wrapper {
    flex-grow: 1;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  .search-content-wrapper :global(.media-list) {
    max-width: 1000px;
    margin: 0 auto;
  }

  .search-header {
    padding: 0.5rem 1.5rem;
    font-style: italic;
    color: var(--ev-c-text-2);
    border-bottom: 1px solid var(--color-background-mute);
    flex-shrink: 0;
  }

  .welcome-screen,
  .status-text {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 1rem;
    padding: 2rem;
    text-align: center;
  }

  /* --- Refresh Button Animation --- */
  .reloading {
    display: inline-block;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  /* Temporarily disable dragging on the header when a context menu is open */
  .header-content.no-drag {
    -webkit-app-region: no-drag;
  }
</style>
