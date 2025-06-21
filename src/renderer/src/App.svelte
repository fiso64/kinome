<script lang="ts">
  import AppHeader from './components/layout/AppHeader.svelte'
  import MainView from './components/layout/MainView.svelte'
  import SettingsModal from './components/modals/SettingsModal.svelte'
  import ContextMenu from './components/ui/ContextMenu.svelte'
  import ItemSettingsModal from './components/modals/ItemSettingsModal.svelte'
  import ManualSearchModal from './components/modals/ManualSearchModal.svelte'
  import PropertiesModal from './components/modals/PropertiesModal.svelte'
  import RenameModal from './components/modals/RenameModal.svelte'
  import FilterBar from './components/ui/FilterBar.svelte'
  import InitialFolderSettingsModal from './components/modals/InitialFolderSettingsModal.svelte'
  import Dialog from './components/ui/Dialog.svelte'
  import { initializeShortcuts } from './lib/shortcuts'
  import { dialogStore } from './lib/dialog-store'
  import { resolveViewSettings } from '../../shared/settings-helpers'
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
    | {
        type: 'itemSettings'
        item: LibraryItem
        initialTab: 'metadata' | 'view' | 'folder' | 'settings'
        defaultLayout: 'grid' | 'tree'
      }
    | { type: 'manualSearch'; item: LibraryItem; initialTab?: 'match' | 'artwork' }
    | { type: 'properties'; item: LibraryItem }
    | { type: 'rename'; item: LibraryItem }
    | { type: 'initialFolderSettings'; root: MediaFolder }

  let viewStack: MediaFolder[] = $state([])
  let lastDetailItem: LibraryItem | null = $state(null)
  let isScanning = $state(true)
  let isRefreshing = $state(false)

  // --- Search & Filter State ---
  let globalSearchQuery = $state({ text: '', tags: [] as { key: string; value: string }[] })
  const isGlobalSearchActive = $derived(
    globalSearchQuery.text.trim() !== '' || globalSearchQuery.tags.length > 0
  )
  let searchResults = $state<SearchIndexEntry[]>([])
  let highlightedGlobalSearchItemIndex = $state<number | null>(null)
  let isPerformingSearch = $state(false)

  let detailViewSearchQuery = $state({ text: '', tags: [] as { key: string; value: string }[] })
  const isDetailSearchActive = $derived(
    detailViewSearchQuery.text.trim() !== '' || detailViewSearchQuery.tags.length > 0
  )
  let detailViewSearchResults = $state<SearchIndexEntry[]>([])
  let highlightedDetailSearchItemIndex = $state<number | null>(null)
  let isPerformingDetailSearch = $state(false)

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
    virtualTagKeys: [],
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
  let activeModal = $state<ActiveModal | null>(null)
  let settings = $state<Settings | null>(null)

  // Global Context Menu State
  let contextMenuItem = $state<LibraryItem | null>(null)
  let contextMenuPosition = $state({ top: 0, left: 0 })
  let contextMenuLayout = $state<string | undefined>(undefined)
  let isContextMenuVisible = $state(false)

  // --- Global Dialog State ---
  let activeDialogs = $state<any[]>([])
  $effect(() => {
    const unsubscribe = dialogStore.subscribe((dialogs) => {
      activeDialogs = dialogs
    })
    return unsubscribe
  })
  // ---

  const currentFolder = $derived(viewStack.length > 0 ? viewStack[viewStack.length - 1] : null)
  const isDetailViewActive = $derived(selectedItemForDetailView !== null)
  const canGoBack = $derived(isDetailViewActive || viewStack.length > 1 || isGlobalSearchActive)

  const currentFolderClickAction = $derived(
    resolveViewSettings(currentFolder, settings).settings.clickAction
  )

  const folderToConfigureLayout = $derived(
    selectedItemForDetailView?.type === 'folder'
      ? (selectedItemForDetailView as MediaFolder)
      : currentFolder
  )

  let appHeaderComponent = $state<any>()

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

    const unlistenErrors = window.api.onShowErrorDialog((options) => {
      try {
        dialogStore.showError(options)
      } catch (e) {
        console.error(
          'FATAL: Custom error dialog system failed to show. Falling back to native alert.',
          e
        )
        console.error('Original Error Message:', options)
        alert(`[ERROR] ${options.title}\n\n${options.message}\n\n${options.detail ?? ''}`)
      }
    })

    return () => {
      unlistenSuggestions()
      unlistenErrors()
    }
  })

  // This effect is reactive and will update the global default CSS variable whenever the settings change
  $effect(() => {
    document.documentElement.style.setProperty(
      '--grid-poster-size',
      `${settings?.gridPosterSize ?? 200}px`
    )
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
    const query = globalSearchQuery
    if (isGlobalSearchActive) {
      isPerformingSearch = true
      selectedItemForDetailView = null
      const plainQuery = JSON.parse(JSON.stringify(query))
      window.api.performSearch(plainQuery).then((results) => {
        searchResults = results
        isPerformingSearch = false
        highlightedGlobalSearchItemIndex = results.length > 0 ? 0 : null
      })
    } else {
      searchResults = []
      isPerformingSearch = false
      highlightedGlobalSearchItemIndex = null
    }
  })

  // --- Detail View Search Effect ---
  $effect(() => {
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

  $effect(() => {
    // Auto-highlight the first search result or clear highlight
    if (searchResults.length > 0) {
      if (
        highlightedGlobalSearchItemIndex === null ||
        highlightedGlobalSearchItemIndex >= searchResults.length
      ) {
        highlightedGlobalSearchItemIndex = 0
      }
    } else {
      highlightedGlobalSearchItemIndex = null
    }
  })

  // Set up a listener for real-time metadata updates from the main process.
  $effect(() => {
    const unlisten = window.api.onLibraryItemUpdated((updatedItem) => {
      if (updatedItem.isHidden) {
        // The item was just hidden. We need to remove it from all visible lists.
        if (selectedItemForDetailView?.id === updatedItem.id) {
          goBack()
        }

        const parentInStack = findParentOfItem(currentFolder, updatedItem.id)
        if (parentInStack) {
          parentInStack.children = parentInStack.children.filter((c) => c.id !== updatedItem.id)
          viewStack = [...viewStack]
        }

        if (selectedItemForDetailView?.type === 'folder') {
          const parentInDetail = findParentOfItem(selectedItemForDetailView, updatedItem.id)
          if (parentInDetail) {
            parentInDetail.children = parentInDetail.children.filter((c) => c.id !== updatedItem.id)
            selectedItemForDetailView = { ...selectedItemForDetailView }
          }
        }

        searchResults = searchResults.filter((r) => r.id !== updatedItem.id)
        detailViewSearchResults = detailViewSearchResults.filter((r) => r.id !== updatedItem.id)
        return // Stop further processing for the hidden item.
      }

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
          const parentInDetailView = findParentOfItem(selectedItemForDetailView, updatedItem.id)
          if (parentInDetailView) {
            const childIndex = parentInDetailView.children.findIndex((c) => c.id === updatedItem.id)
            if (childIndex !== -1) {
              parentInDetailView.children = [
                ...parentInDetailView.children.slice(0, childIndex),
                updatedItem,
                ...parentInDetailView.children.slice(childIndex + 1)
              ]
              selectedItemForDetailView = { ...selectedItemForDetailView }
              wasHandledInView = true
            }
          }
        }
      }

      // --- Case 2: Update the main grid/list view if not handled by detail view. ---
      if (!wasHandledInView && currentFolder) {
        // A) Is the updated item the folder being viewed itself? (e.g., layout change)
        if (currentFolder.id === updatedItem.id) {
          viewStack[viewStack.length - 1] = updatedItem as MediaFolder
          viewStack = [...viewStack]
        }
        // B) Is the updated item a child of the current view?
        else {
          const parent = findParentOfItem(currentFolder, updatedItem.id)
          if (parent) {
            const itemIndex = parent.children.findIndex((child) => child.id === updatedItem.id)
            if (itemIndex !== -1) {
              parent.children = [
                ...parent.children.slice(0, itemIndex),
                updatedItem,
                ...parent.children.slice(itemIndex + 1)
              ]
              viewStack = [...viewStack]
            }
          }
        }
      }

      // --- Case 3: Update search results list, if active. ---
      const indexInSearch = searchResults.findIndex((i) => i.id === updatedItem.id)
      if (indexInSearch > -1) {
        const itemInSearch = searchResults[indexInSearch]
        Object.assign(itemInSearch, {
          title: updatedItem.title ?? updatedItem.name,
          posterPath: updatedItem.posterPath,
          _v: updatedItem._v,
          watched: 'watched' in updatedItem ? updatedItem.watched : undefined
        })
        searchResults = [...searchResults]
      }

      // --- Case 4: Update the item in an active modal. ---
      if (
        (activeModal?.type === 'manualSearch' ||
          activeModal?.type === 'itemSettings' ||
          activeModal?.type === 'properties' ||
          activeModal?.type === 'rename') &&
        activeModal.item.id === updatedItem.id
      ) {
        activeModal = {
          ...activeModal,
          item: { ...activeModal.item, ...updatedItem }
        }
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
        const indexInSearch = searchResults.findIndex((i) => i.id === updatedItem.id)
        if (indexInSearch > -1) {
          const itemInSearch = searchResults[indexInSearch]
          itemInSearch.title = updatedItem.title ?? updatedItem.name
          itemInSearch.posterPath = updatedItem.posterPath
          itemInSearch._v = updatedItem._v
        }

        if (
          (activeModal?.type === 'manualSearch' ||
            activeModal?.type === 'itemSettings' ||
            activeModal?.type === 'properties' ||
            activeModal?.type === 'rename') &&
          activeModal.item.id === updatedItem.id
        ) {
          Object.assign(activeModal.item, updatedItem)
        }
      }

      viewStack = [...viewStack]
      searchResults = [...searchResults]
      if (selectedItemForDetailView) {
        selectedItemForDetailView = { ...selectedItemForDetailView }
      }
      if (activeModal) {
        activeModal = { ...activeModal }
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
    await window.api.playFile(plainFile)
  }

  async function handleRevealItem(item: LibraryItem) {
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

    const confirmed = await dialogStore.showConfirmation({
      title: 'Confirm Deletion',
      message: `Are you sure you want to move "${item.title ?? item.name}" to the trash?`,
      detail: 'This action cannot be undone from within the app.',
      confirmText: 'Move to Trash',
      cancelText: 'Cancel',
      confirmClass: 'danger'
    })

    if (!confirmed) {
      return
    }

    const success = await window.api.trashItem(item.path)
    if (success) {
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

    if (selectedItemForDetailView) {
      const parent = selectedItemForDetailView
      if (selectedItemForDetailView.id === item.id && item.type === 'file') {
        handlePlayFile(loadedItem)
        return
      }
      if (loadedItem.type === 'file' && !loadedItem.opensAsFolder) {
        handlePlayFile(loadedItem)
        return
      }
      if (
        loadedItem.type === 'folder' &&
        (parent as MediaFolder).childrenClickAction === 'navigate'
      ) {
        drillDown(loadedItem as MediaFolder)
      } else {
        lastDetailItem = parent
        if (parent.type === 'folder') {
          viewStack.push(parent)
        }
        const processedItem = await window.api.getItemDetails(loadedItem.id)
        selectedItemForDetailView = processedItem ?? loadedItem
      }
      return
    }

    if (loadedItem.type === 'file' && !loadedItem.opensAsFolder) {
      handlePlayFile(loadedItem)
      return
    }
    if (loadedItem.type === 'file' && (currentFolder?.layout ?? 'grid') === 'tree') {
      handlePlayFile(loadedItem)
      return
    }
    if (loadedItem.type === 'folder' && currentFolderClickAction === 'navigate') {
      handleNavigateFolder(loadedItem as MediaFolder)
      return
    }

    lastDetailItem = null
    const processedItem = await window.api.getItemDetails(loadedItem.id)
    selectedItemForDetailView = processedItem ?? loadedItem
    detailViewSearchQuery = { text: '', tags: [] }

    if (fromSearch) {
      const clickedIndex = searchResults.findIndex((sr) => sr.id === item.id)
      if (clickedIndex !== -1) {
        highlightedGlobalSearchItemIndex = clickedIndex
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

    if (selectedItemForDetailView && isDetailSearchActive) {
      detailViewSearchQuery = { text: '', tags: [] }
      return
    }

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
    const loadedItem = await getLoadedItem(item.id)
    if (!loadedItem) {
      console.error('Failed to load item from store:', item.id)
      return
    }

    lastDetailItem = selectedItemForDetailView
    if (lastDetailItem?.type === 'folder') {
      viewStack.push(lastDetailItem as MediaFolder)
    }

    const processedItem = await window.api.getItemDetails(loadedItem.id)
    selectedItemForDetailView = processedItem ?? loadedItem
    detailViewSearchQuery = { text: '', tags: [] }
  }

  function handleSearchByTag(key: string, value: string): void {
    selectedItemForDetailView = null
    globalSearchQuery = { text: '', tags: [{ key, value }] }
  }

  $effect(() => {
    const cleanupShortcuts = initializeShortcuts({
      openSettings: () => (activeModal = { type: 'settings' }),
      focusSearch: () => appHeaderComponent?.focusSearchInput(),
      navigateBack: goBack,
      navigateForward: goForward,
      reloadLibrary: handleRefresh,
      showAndFocusFilterBar: () => {
        if (isFilterBarVisible) {
          filterFocusKey++
        } else {
          isFilterBarVisible = true
        }
      }
    })
    return () => cleanupShortcuts()
  })

  function openLayoutSelector() {
    if (folderToConfigureLayout) {
      const resolvedSettings = resolveViewSettings(folderToConfigureLayout, settings).settings
      activeModal = {
        type: 'itemSettings',
        item: folderToConfigureLayout,
        initialTab: 'view',
        defaultLayout: resolvedSettings.layout
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

    if ('staticScore' in item) {
      const fullItem = await getLoadedItem(item.id)
      if (fullItem) {
        contextMenuItem = fullItem
      } else {
        return
      }
    } else {
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
      {settings}
      close={() => {
        const wasSettings = activeModal?.type === 'settings'
        activeModal = null
        if (wasSettings) {
          window.api.getSettings().then((s) => (settings = s))
        }
      }}
      scanLibrary={handleScan}
    />
  {:else if activeModal.type === 'itemSettings'}
    <ItemSettingsModal
      item={activeModal.item}
      initialTab={activeModal.initialTab}
      defaultLayout={activeModal.defaultLayout}
      {groupByKeys}
      {settings}
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
    layout={contextMenuLayout}
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
        const resolvedSettings = resolveViewSettings(contextMenuItem as MediaFolder, settings)
          .settings
        activeModal = {
          type: 'itemSettings',
          item: contextMenuItem,
          initialTab: 'metadata',
          defaultLayout: resolvedSettings.layout
        }
      }
    }}
    onSetLayout={() => {
      if (contextMenuItem?.type === 'folder') {
        const resolvedSettings = resolveViewSettings(contextMenuItem as MediaFolder, settings)
          .settings
        activeModal = {
          type: 'itemSettings',
          item: contextMenuItem as MediaFolder,
          initialTab: 'view',
          defaultLayout: resolvedSettings.layout
        }
      }
    }}
    onOpenFolderSettings={() => {
      if (contextMenuItem?.type === 'folder') {
        const resolvedSettings = resolveViewSettings(contextMenuItem as MediaFolder, settings)
          .settings
        activeModal = {
          type: 'itemSettings',
          item: contextMenuItem as MediaFolder,
          initialTab: 'folder',
          defaultLayout: resolvedSettings.layout
        }
      }
    }}
    onOpenFileSettings={() => {
      if (contextMenuItem) {
        activeModal = {
          type: 'itemSettings',
          item: contextMenuItem,
          initialTab: 'settings',
          defaultLayout: 'grid'
        }
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

{#if activeDialogs.length > 0}
  {@const dialog = activeDialogs[0]}
  <Dialog
    title={dialog.title}
    message={dialog.message}
    detail={dialog.detail}
    buttons={dialog.buttons}
    onClose={(value) => dialogStore.close(value)}
  />
{/if}

<main>
  <AppHeader
    bind:this={appHeaderComponent}
    {canGoBack}
    {isDetailViewActive}
    {isGlobalSearchActive}
    {currentFolder}
    {isRefreshing}
    {isScanning}
    {isContextMenuVisible}
    {folderToConfigureLayout}
    suggestions={allAutocompleteSuggestions}
    isPerformingGlobalSearch={isPerformingSearch}
    globalSearchResults={searchResults}
    {isPerformingDetailSearch}
    detailSearchResults={detailViewSearchResults}
    {isDetailSearchActive}
    bind:globalSearchQuery
    bind:detailViewSearchQuery
    bind:highlightedGlobalSearchItemIndex
    bind:highlightedDetailSearchItemIndex
    on:back={goBack}
    on:refresh={handleRefresh}
    on:openSettings={() => (activeModal = { type: 'settings' })}
    on:openLayoutSelector={openLayoutSelector}
    on:showContextMenu={(e) => handleShowContextMenu(e.detail.item, e.detail.event)}
    on:globalSearchItemClick={(e) => handleItemClick(e.detail.item)}
    on:detailSearchItemClick={(e) => handleDetailSearchItemClick(e.detail.item)}
  />

  <MainView
    {isScanning}
    {currentFolder}
    {isGlobalSearchActive}
    {searchResults}
    {isPerformingSearch}
    highlightedSearchItemIndex={highlightedGlobalSearchItemIndex}
    {selectedItemForDetailView}
    {filterQuery}
    suggestions={allAutocompleteSuggestions}
    {settings}
    on:scanLibrary={handleScan}
    on:itemClick={(e) => handleItemClick(e.detail.item)}
    on:showContextMenu={(e) =>
      handleShowContextMenu(e.detail.item, e.detail.event, e.detail.options)}
    on:searchByTag={(e) => handleSearchByTag(e.detail.key, e.detail.value)}
  />

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
  main {
    --header-height: 54px;
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }
</style>
