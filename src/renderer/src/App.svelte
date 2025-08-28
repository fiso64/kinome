<script lang="ts">
  import AppHeader from './components/layout/AppHeader.svelte'
  import MainView from './components/layout/MainView.svelte'
  import SettingsModal from './components/modals/SettingsModal.svelte'
  import ContextMenu from './components/ui/ContextMenu.svelte'
  import ItemSettingsModal from './components/modals/ItemSettingsModal.svelte'
  import ManualSearchModal from './components/modals/ManualSearchModal.svelte'
  import PropertiesModal from './components/modals/PropertiesModal.svelte'
  import RenameModal from './components/modals/RenameModal.svelte'
  import AssignSeasonsModal from './components/modals/AssignSeasonsModal.svelte'
  import FilterBar from './components/ui/FilterBar.svelte'
  import InitialFolderSettingsModal from './components/modals/InitialFolderSettingsModal.svelte'
  import Dialog from './components/ui/Dialog.svelte'
  import { initializeShortcuts } from './lib/shortcuts'
  import { dialogStore } from './lib/dialog-store'
  import { autocompleteState } from './lib/autocomplete-manager'
  import AutocompleteMenu from './components/ui/AutocompleteMenu.svelte'
  import { resolveViewSettings } from '../../shared/settings-helpers'
  import { isTypingTag as isTypingTagHelper } from './lib/view-helpers'
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
    | { type: 'assignSeasons'; item: MediaFolder }

  let viewStack: MediaFolder[] = $state([])
  let lastDetailItem: LibraryItem | null = $state(null)
  let isScanning = $state(true)
  let isRefreshing = $state(false)
  let continueWatchingItems = $state<{ show: MediaFolder; nextEpisode: MediaFile }[]>([])

  // --- Search & Filter State ---
  let globalSearchQuery = $state({ text: '', tags: [] as { key: string; value: string }[] })
  const isGlobalSearchActive = $derived(
    globalSearchQuery.text.trim() !== '' || globalSearchQuery.tags.length > 0
  )
  const isTypingGlobalTag = $derived(isTypingTagHelper(globalSearchQuery.text))
  let searchResults = $state<SearchIndexEntry[]>([])
  let highlightedGlobalSearchItemIndex = $state<number | null>(null)
  let isPerformingSearch = $state(false)

  let detailViewSearchQuery = $state({ text: '', tags: [] as { key: string; value: string }[] })
  const isDetailSearchActive = $derived(
    detailViewSearchQuery.text.trim() !== '' || detailViewSearchQuery.tags.length > 0
  )
  const isTypingDetailTag = $derived(isTypingTagHelper(detailViewSearchQuery.text))
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

    window.api.getContinueWatchingItems().then((items) => (continueWatchingItems = items))
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

    const unlistenSettingsUpdated = window.api.onSettingsPossiblyUpdated((newSettings) => {
      log('Received settings-possibly-updated event from main process.')
      settings = newSettings
    })

    return () => {
      unlistenSuggestions()
      unlistenErrors()
      unlistenSettingsUpdated()
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
        const isFilterQueryEmpty = filterQuery.text.trim() === '' && filterQuery.tags.length === 0
        // Only remember to restore the filter bar if it had content.
        if (!isFilterQueryEmpty) {
          wasFilterBarVisible = true
        }
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
    // Only perform search if the view is active AND the user is not in the middle of typing a tag.
    if (isGlobalSearchActive && !isTypingGlobalTag) {
      isPerformingSearch = true
      selectedItemForDetailView = null
      const plainQuery = JSON.parse(JSON.stringify(query))
      window.api.performSearch(plainQuery).then((results) => {
        searchResults = results
        isPerformingSearch = false
        highlightedGlobalSearchItemIndex = results.length > 0 ? 0 : null
      })
    } else if (!isGlobalSearchActive) {
      // Clear results if the search becomes inactive
      searchResults = []
      isPerformingSearch = false
      highlightedGlobalSearchItemIndex = null
    }
  })

  // --- Detail View Search Effect ---
  $effect(() => {
    const query = detailViewSearchQuery
    if (selectedItemForDetailView && isDetailSearchActive && !isTypingDetailTag) {
      isPerformingDetailSearch = true
      const plainQuery = JSON.parse(JSON.stringify(query))
      window.api.performSearch(plainQuery).then((results) => {
        detailViewSearchResults = results
        isPerformingDetailSearch = false
        highlightedDetailSearchItemIndex = results.length > 0 ? 0 : null
      })
    } else if (!isDetailSearchActive) {
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

  function handleItemUpdates(updatedItems: LibraryItem[]) {
    for (const updatedItem of updatedItems) {
      if (updatedItem.isHidden) {
        // --- Handle Hiding ---
        if (selectedItemForDetailView?.id === updatedItem.id) goBack()
        const parentInStack = findParentOfItem(currentFolder, updatedItem.id)
        if (parentInStack) {
          parentInStack.children = parentInStack.children.filter((c) => c.id !== updatedItem.id)
        }
        if (selectedItemForDetailView?.type === 'folder') {
          const parentInDetail = findParentOfItem(selectedItemForDetailView, updatedItem.id)
          if (parentInDetail) {
            parentInDetail.children = parentInDetail.children.filter((c) => c.id !== updatedItem.id)
          }
        }
        searchResults = searchResults.filter((r) => r.id !== updatedItem.id)
        detailViewSearchResults = detailViewSearchResults.filter((r) => r.id !== updatedItem.id)
        continue // Skip to next item
      }

      // --- Handle Updates ---
      updateCachedItem(updatedItem)

      // Find the item in the detail view tree and update its properties in place.
      const itemInDetailTree =
        selectedItemForDetailView?.type === 'folder'
          ? findItemInTree(selectedItemForDetailView, updatedItem.id)
          : null
      if (selectedItemForDetailView?.id === updatedItem.id) {
        Object.assign(selectedItemForDetailView, updatedItem)
      } else if (itemInDetailTree) {
        Object.assign(itemInDetailTree, updatedItem)
      }

      // Find the item in the main view stack and update its properties in place.
      const itemInViewStack = currentFolder ? findItemInTree(currentFolder, updatedItem.id) : null
      if (currentFolder?.id === updatedItem.id) {
        Object.assign(currentFolder, updatedItem)
      } else if (itemInViewStack) {
        Object.assign(itemInViewStack, updatedItem)
      }

      // Update search results list, if active.
      const indexInSearch = searchResults.findIndex((i) => i.id === updatedItem.id)
      if (indexInSearch > -1) {
        const itemInSearch = searchResults[indexInSearch]
        Object.assign(itemInSearch, {
          title: updatedItem.title ?? updatedItem.name,
          posterPath: updatedItem.posterPath,
          _v: updatedItem._v,
          watched: 'watched' in updatedItem ? updatedItem.watched : undefined
        })
      }

      // Update the item in an active modal.
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

    // Trigger Svelte reactivity
    viewStack = [...viewStack]
    searchResults = [...searchResults]
    if (selectedItemForDetailView) {
      selectedItemForDetailView = { ...selectedItemForDetailView }
    }
    if (activeModal) {
      activeModal = { ...activeModal }
    }
  }



  // Listener for BATCH metadata updates
  $effect(() => {
    const unlisten = window.api.onLibraryItemsUpdated((updatedItems) => {
      log(`Received batch update for ${updatedItems.length} items.`)
      handleItemUpdates(updatedItems)
      // If any of the updated items could affect the continue watching list, refresh it.
      const shouldRefresh = updatedItems.some(
        (item) =>
          (item.type === 'file' && 'watched' in item) ||
          (item.type === 'folder' && 'continueWatchingDismissed' in item)
      )
      if (shouldRefresh) {
        window.api.getContinueWatchingItems().then((items) => (continueWatchingItems = items))
      }
    })
    return () => unlisten()
  })

  // Listener for item deletion
  $effect(() => {
    const unlisten = window.api.onLibraryItemDeleted((deletedItemId) => {
      log(`Received deletion event for item ${deletedItemId}`)
      // This logic is similar to `isHidden`, but it's a permanent removal.
      if (selectedItemForDetailView?.id === deletedItemId) goBack()
      const parentInStack = findParentOfItem(currentFolder, deletedItemId)
      if (parentInStack) {
        parentInStack.children = parentInStack.children.filter((c) => c.id !== deletedItemId)
      }
      if (selectedItemForDetailView?.type === 'folder') {
        const parentInDetail = findParentOfItem(selectedItemForDetailView, deletedItemId)
        if (parentInDetail) {
          parentInDetail.children = parentInDetail.children.filter((c) => c.id !== deletedItemId)
          selectedItemForDetailView = { ...selectedItemForDetailView }
        }
      }
      searchResults = searchResults.filter((r) => r.id !== deletedItemId)
      detailViewSearchResults = detailViewSearchResults.filter((r) => r.id !== deletedItemId)
      viewStack = [...viewStack]
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
    const newRoot = await window.api.performInitialScan()
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

  function handleDismissContinueWatching(showId: string) {
    window.api.setContinueWatchingDismissed(showId)
    continueWatchingItems = continueWatchingItems.filter((cw) => cw.show.id !== showId)
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

  async function handleDeleteItemFromDb(item: LibraryItem) {
    const confirmed = await dialogStore.showConfirmation({
      title: 'Confirm Database Deletion',
      message: `Are you sure you want to permanently delete the record for "${
        item.title ?? item.name
      }" from the database?`,
      detail:
        'This only affects the library database, not the file on disk. This action cannot be undone.',
      confirmText: 'Delete Record',
      cancelText: 'Cancel',
      confirmClass: 'danger'
    })
    if (confirmed) {
      await window.api.deleteItemFromDb(item.id)
      // The `onLibraryItemDeleted` listener will handle UI updates.
    }
  }

  function onContextMenuDeleteItemFromDb() {
    if (contextMenuItem) {
      handleDeleteItemFromDb(contextMenuItem)
    }
  }

  async function handleItemClick(item: LibraryItem | SearchIndexEntry): Promise<void> {
    const fromSearch = 'staticScore' in item

    if ((item as any).isVirtual === true) {
      handleNavigateFolder(item as MediaFolder)
      return
    }

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
    appHeaderComponent?.blurSearchInput()
    if (!canGoBack) return

    if (isGlobalSearchActive && !selectedItemForDetailView) {
      if (lastDetailItem) {
        // We came from a detail page. Restore it.
        selectedItemForDetailView = lastDetailItem
        lastDetailItem = null
      }
      globalSearchQuery = { text: '', tags: [] } // In all cases, clear search
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

  async function handleClearItemMetadata(item: LibraryItem) {
    const isFolder = item.type === 'folder'
    const isVirtual = (item as any).isVirtual === true
    const message = isVirtual
      ? `This will permanently delete all metadata (including custom titles, posters, and tags) for all items currently shown in the virtual folder "${item.title ?? item.name}".`
      : `This will permanently delete all metadata (including custom titles, posters, and tags) for this item${isFolder ? ', and all its children recursively' : ''}.`

    if (isFolder && !isVirtual) {
      const result = await dialogStore.showConfirmationWithCheckbox({
        title: 'Confirm Metadata Clearing',
        message,
        detail: 'This action cannot be undone.',
        confirmText: 'Clear Metadata',
        cancelText: 'Cancel',
        confirmClass: 'danger',
        checkbox: {
          label: 'Preserve metadata for this item, only clear for its children.',
          checked: false
        }
      })
      if (result.confirmed) {
        await window.api.clearItemMetadata(item.id, result.checkboxValue)
      }
    } else {
      const confirmed = await dialogStore.showConfirmation({
        title: 'Confirm Metadata Clearing',
        message,
        detail: 'This action cannot be undone.',
        confirmText: 'Clear Metadata',
        cancelText: 'Cancel',
        confirmClass: 'danger'
      })

      if (!confirmed) return

      if (isVirtual && item.type === 'folder') {
        const childIds = item.children.map((c) => c.id)
        await window.api.clearVirtualFolderMetadata(childIds)
      } else {
        await window.api.clearItemMetadata(item.id, false)
      }
    }
    // The onLibraryItemUpdated/onLibraryItemsUpdated listeners will handle UI updates.
  }

  async function handleHideItemFromContext(item: LibraryItem) {
    const confirmed = await dialogStore.showConfirmation({
      title: 'Confirm Hide',
      message: `Are you sure you want to hide "${item.title ?? item.name}"?`,
      detail: "This is not a deletion. It can be unhidden from its parent folder's settings.",
      confirmText: 'Hide Item',
      cancelText: 'Cancel'
    })

    if (confirmed) {
      const itemToUpdate = { ...JSON.parse(JSON.stringify(item)), isHidden: true }
      await window.api.userUpdateItem(itemToUpdate)
      // The onLibraryItemUpdated listener will handle UI updates.
    }

    async function handleDeleteItemFromDb(item: LibraryItem) {
      const confirmed = await dialogStore.showConfirmation({
        title: 'Confirm Database Deletion',
        message: `Are you sure you want to permanently delete the record for "${
          item.title ?? item.name
        }" from the database?`,
        detail:
          'This only affects the library database, not the file on disk. This action cannot be undone.',
        confirmText: 'Delete Record',
        cancelText: 'Cancel',
        confirmClass: 'danger'
      })
      if (confirmed) {
        await window.api.deleteItemFromDb(item.id)
        // The `onLibraryItemDeleted` listener will handle UI updates.
      }
    }
  }

  async function handleOpenLibrary(): Promise<void> {
    const path = await window.api.selectLibraryDirectory()
    if (path) {
      await window.api.saveSettings({ libraryLocation: path })
      // Reload the entire application to apply the new library path
      window.location.reload()
    }
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
    lastDetailItem = selectedItemForDetailView
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
      on:close={() => {
        const wasSettings = activeModal?.type === 'settings'
        activeModal = null
        if (wasSettings) {
          window.api.getSettings().then((s) => (settings = s))
        }
      }}
      on:fullRescanCompleted={(e) => {
        activeModal = { type: 'initialFolderSettings', root: e.detail.root }
      }}
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
  {:else if activeModal.type === 'assignSeasons'}
    <AssignSeasonsModal item={activeModal.item} onClose={() => (activeModal = null)} />
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
        const resolvedSettings = resolveViewSettings(
          contextMenuItem as MediaFolder,
          settings
        ).settings
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
        const resolvedSettings = resolveViewSettings(
          contextMenuItem as MediaFolder,
          settings
        ).settings
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
        const resolvedSettings = resolveViewSettings(
          contextMenuItem as MediaFolder,
          settings
        ).settings
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
    onClearMetadata={() => {
      if (contextMenuItem) {
        handleClearItemMetadata(contextMenuItem)
      }
    }}
    onHideItem={() => {
      if (contextMenuItem) {
        handleHideItemFromContext(contextMenuItem)
      }
    }}
    onAssignSeasons={() => {
      if (contextMenuItem?.type === 'folder') {
        activeModal = { type: 'assignSeasons', item: contextMenuItem }
      }
    }}
    onDeleteItemFromDb={() => {
      if (contextMenuItem) {
        handleDeleteItemFromDb(contextMenuItem)
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
    checkbox={dialog.checkbox}
    onClose={(value) => dialogStore.close(value)}
  />
{/if}

{#if $autocompleteState.show}
  <AutocompleteMenu
    suggestions={$autocompleteState.suggestions}
    position={$autocompleteState.position}
    onSelect={$autocompleteState.onSelect}
    onClose={() => autocompleteState.update((s) => ({ ...s, show: false }))}
    activeIndex={$autocompleteState.activeIndex}
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
    {settings}
  />

  <MainView
    {isScanning}
    {continueWatchingItems}
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
    on:openLibrary={handleOpenLibrary}
    on:itemClick={(e) => handleItemClick(e.detail.item)}
    on:showContextMenu={(e) =>
      handleShowContextMenu(e.detail.item, e.detail.event, e.detail.options)}
    on:searchByTag={(e) => handleSearchByTag(e.detail.key, e.detail.value)}
    on:dismissContinueWatching={(e) => handleDismissContinueWatching(e.detail.showId)}
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
