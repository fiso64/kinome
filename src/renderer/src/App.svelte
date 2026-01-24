<script lang="ts">
  import AppHeader from './components/layout/AppHeader.svelte'
  import MainView from './components/layout/MainView.svelte'
  import FilterBar from './components/ui/FilterBar.svelte'
  import ModalRoot from './components/layout/ModalRoot.svelte'
  import ContextMenuRoot from './components/layout/ContextMenuRoot.svelte'
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
  import { findParentOfItem, replaceItemInTree } from './lib/tree-helpers'
  import { navStack } from './lib/navigation-store.svelte' // Extracted navigation logic
  import { searchStore, initializeSearchEffects } from './lib/search-store.svelte'
  import { modalStore } from './lib/modal-store.svelte'
  import { contextMenuStore } from './lib/context-menu-store.svelte'
  import { api } from './lib/api'

  const log = (message: string): void => {
    console.log(`[${new Date().toISOString()}] [Renderer] ${message}`)
  }

  let isScanning = $state(true)
  let isRefreshing = $state(false)
  let continueWatchingItems = $state<{ show: MediaFolder; nextEpisode: MediaFile }[]>([])

  initializeSearchEffects()

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
  let settings = $state<Settings | null>(null)

  // --- Global Dialog State ---
  let activeDialogs = $state<Record<string, any>[]>([])
  $effect(() => {
    const unsubscribe = dialogStore.subscribe((dialogs) => {
      activeDialogs = dialogs
    })
    return unsubscribe
  })
  // ---

  const currentFolder = $derived(navStack.currentFolder)
  const selectedItemForDetailView = $derived(navStack.selectedItemForDetailView)
  const isDetailViewActive = $derived(navStack.isDetailViewActive)
  const canGoBack = $derived(navStack.canGoBack || searchStore.isGlobalActive)

  const currentFolderClickAction = $derived(
    resolveViewSettings(currentFolder, settings).settings.clickAction
  )

  const folderToConfigureLayout = $derived(
    navStack.selectedItemForDetailView?.type === 'folder'
      ? (navStack.selectedItemForDetailView as MediaFolder)
      : currentFolder
  )

  let appHeaderComponent = $state<any>()

  // This effect runs once on mount to fetch initial data
  $effect(() => {
    log('App mounted. Requesting library root from main process...')
    api.getLibraryRoot().then(async (root) => {
      log('Library root received from main process.')
      if (root) {
        primeCacheWithRoot(root)
        navStack.navigateToRoot(root)
        log('Root view rendered.')
      } else {
        log('No library found. Displaying welcome screen.')
      }
      isScanning = false
    })

    api.getContinueWatchingItems().then((items) => (continueWatchingItems = items))
    api.getAutocompleteSuggestions().then((s) => (allAutocompleteSuggestions = s))
    api.getSettings().then((s) => (settings = s))

    const unlistenSuggestions = api.onAutocompleteSuggestionsUpdated((s) => {
      allAutocompleteSuggestions = s
    })

    const unlistenErrors = api.onShowErrorDialog((options) => {
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

    const unlistenSettingsUpdated = api.onSettingsPossiblyUpdated((newSettings) => {
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

  function handleItemUpdates(updatedItems: LibraryItem[]) {
    for (const updatedItem of updatedItems) {
      if (updatedItem.isHidden) {
        // --- Handle Hiding ---
        if (navStack.selectedItemForDetailView?.id === updatedItem.id) navStack.goBack()
        const parentInStack = findParentOfItem(currentFolder, updatedItem.id)
        if (parentInStack) {
          parentInStack.children = parentInStack.children.filter((c) => c.id !== updatedItem.id)
        }
        if (navStack.selectedItemForDetailView?.type === 'folder') {
          const parentInDetail = findParentOfItem(
            navStack.selectedItemForDetailView as MediaFolder,
            updatedItem.id
          )
          if (parentInDetail) {
            parentInDetail.children = parentInDetail.children.filter((c) => c.id !== updatedItem.id)
          }
        }
        searchStore.searchResults = searchStore.searchResults.filter((r) => r.id !== updatedItem.id)
        searchStore.detailResults = searchStore.detailResults.filter((r) => r.id !== updatedItem.id)
        continue // Skip to next item
      }

      // --- Handle Updates ---
      const newItem = { ...updatedItem }
      updateCachedItem(newItem)

      // 1. Update Detail View
      if (navStack.selectedItemForDetailView?.id === newItem.id) {
        // If the item ITSELF is currently open in detail view, replace it
        navStack.selectedItemForDetailView = newItem
      } else if (navStack.selectedItemForDetailView?.type === 'folder') {
        // If a folder is open, see if the item is INSIDE that folder
        const currentDetail = navStack.selectedItemForDetailView as MediaFolder
        const updatedDetail = replaceItemInTree(currentDetail, newItem.id, newItem)
        if (updatedDetail !== currentDetail) {
          navStack.selectedItemForDetailView = updatedDetail
        }
      }

      // 2. Update Main View Stack (recursively find and replace in all stack levels)
      navStack.viewStack = navStack.viewStack.map((folderInStack) => {
        return replaceItemInTree(folderInStack, newItem.id, newItem)
      })

      // 3. Update search results list, if active.
      const indexInSearch = searchStore.searchResults.findIndex((i) => i.id === newItem.id)
      if (indexInSearch > -1) {
        searchStore.searchResults[indexInSearch] = {
          ...searchStore.searchResults[indexInSearch],
          ...newItem,
          title: newItem.title ?? newItem.name // Consolidate search titles
        }
        searchStore.searchResults = [...searchStore.searchResults]
      }

      // 4. Update the item in an active modal.
      const activeModal = modalStore.activeModal
      if (activeModal && 'item' in activeModal.props && activeModal.props.item.id === newItem.id) {
        activeModal.props.item = newItem
      }
    }
  }

  // Listener for BATCH metadata updates
  $effect(() => {
    const unlisten = api.onLibraryItemsUpdated((updatedItems) => {
      log(`Received batch update for ${updatedItems.length} items.`)
      // DEBUG: Check for S02 episode titles
      const s02ep = updatedItems.find(
        (i) => i.id === '3d69235ff950ca868da19df0626c7e518e51763212e2cb64e165193acdaefad4'
      )
      if (s02ep) console.log('[App] Received update for S02E01:', s02ep)

      handleItemUpdates(updatedItems)
      // If any of the updated items could affect the continue watching list, refresh it.
      const shouldRefresh = updatedItems.some(
        (item) =>
          (item.type === 'file' && 'watched' in item) ||
          (item.type === 'folder' && 'continueWatchingDismissed' in item)
      )
      if (shouldRefresh) {
        api.getContinueWatchingItems().then((items) => (continueWatchingItems = items))
      }
    })
    return () => unlisten()
  })

  // Listener for item deletion
  $effect(() => {
    const unlisten = api.onLibraryItemDeleted((deletedItemId) => {
      log(`Received deletion event for item ${deletedItemId}`)
      // This logic is similar to `isHidden`, but it's a permanent removal.
      if (navStack.selectedItemForDetailView?.id === deletedItemId) navStack.goBack()
      const parentInStack = findParentOfItem(currentFolder, deletedItemId)
      if (parentInStack) {
        parentInStack.children = parentInStack.children.filter((c) => c.id !== deletedItemId)
      }
      if (navStack.selectedItemForDetailView?.type === 'folder') {
        const parentInDetail = findParentOfItem(
          navStack.selectedItemForDetailView as MediaFolder,
          deletedItemId
        )
        if (parentInDetail) {
          parentInDetail.children = parentInDetail.children.filter((c) => c.id !== deletedItemId)
          navStack.selectedItemForDetailView = { ...navStack.selectedItemForDetailView }
        }
      }
      searchStore.searchResults = searchStore.searchResults.filter((r) => r.id !== deletedItemId)
      searchStore.detailResults = searchStore.detailResults.filter((r) => r.id !== deletedItemId)
      navStack.viewStack = [...navStack.viewStack]
    })
    return () => unlisten()
  })

  async function handleScan(): Promise<void> {
    isScanning = true
    navStack.selectedItemForDetailView = null
    clearItemCache()
    navStack.viewStack = [] // Clear the view stack to show the welcome/loading screen
    const newRoot = await api.performInitialScan()
    if (newRoot) {
      primeCacheWithRoot(newRoot)
      modalStore.open('initialFolderSettings', { root: newRoot })
    }
    isScanning = false
  }

  async function handleRefresh(): Promise<void> {
    if (isRefreshing || isScanning) return
    isRefreshing = true
    clearItemCache()
    const refreshedRoot = await api.refreshLibrary()
    if (refreshedRoot) {
      primeCacheWithRoot(refreshedRoot)
      const loadedRoot = await getLoadedItem(refreshedRoot.id)
      if (loadedRoot) {
        navStack.navigateToRoot(loadedRoot as MediaFolder)
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
    await api.playFile(plainFile)
  }

  function handleDismissContinueWatching(showId: string) {
    api.setContinueWatchingDismissed(showId)
    continueWatchingItems = continueWatchingItems.filter((cw) => cw.show.id !== showId)
  }

  async function handleApplyInitialSettings(
    settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]
  ) {
    await api.applyInitialFolderSettings(settings)
    const root = await api.getLibraryRoot()
    if (root) {
      primeCacheWithRoot(root)
      const loadedRoot = await getLoadedItem(root.id)
      if (loadedRoot) navStack.viewStack = [loadedRoot as MediaFolder]
    }
  }

  async function handleItemClick(item: LibraryItem | SearchIndexEntry): Promise<void> {
    const fromSearch = 'staticScore' in item
    const result = await navStack.handleItemClick(item)

    if (result?.action === 'play') {
      handlePlayFile(result.item as MediaFile)
    }

    if (fromSearch) {
      const clickedIndex = searchStore.searchResults.findIndex((sr) => sr.id === item.id)
      if (clickedIndex !== -1) {
        searchStore.highlightedGlobalIndex = clickedIndex
      }
    }
  }

  function goBack(): void {
    appHeaderComponent?.blurSearchInput()
    if (searchStore.isGlobalActive && !navStack.selectedItemForDetailView) {
      searchStore.clearGlobal()
      return
    }
    navStack.goBack()
  }

  function goForward(): void {
    // This can be implemented in the future to handle forward navigation.
  }

  async function handleOpenLibrary(): Promise<void> {
    const path = await api.selectLibraryDirectory()
    if (path) {
      await api.saveSettings({ libraryLocation: path })
      // Reload the entire application to apply the new library path
      window.location.reload()
    }
  }

  async function handleDetailSearchItemClick(item: SearchIndexEntry) {
    await navStack.handleDetailSearchItemClick(item)
    searchStore.clearDetail()
  }

  function handleSearchByTag(key: string, value: string): void {
    searchStore.searchByTag(key, value)
  }

  $effect(() => {
    const cleanupShortcuts = initializeShortcuts({
      openSettings: () => modalStore.open('settings'),
      focusSearch: () => appHeaderComponent?.focusSearchInput(),
      navigateBack: goBack,
      navigateForward: goForward,
      reloadLibrary: handleRefresh,
      showAndFocusFilterBar: () => {
        if (searchStore.isFilterBarVisible) {
          searchStore.filterFocusKey++
        } else {
          searchStore.isFilterBarVisible = true
        }
      }
    })
    return () => cleanupShortcuts()
  })

  function openLayoutSelector() {
    if (folderToConfigureLayout) {
      const resolvedSettings = resolveViewSettings(folderToConfigureLayout, settings).settings
      modalStore.open('itemSettings', {
        item: folderToConfigureLayout,
        initialTab: 'view',
        defaultLayout: resolvedSettings.layout
      })
    }
  }

  async function handleShowContextMenu(
    item: LibraryItem | SearchIndexEntry,
    event: MouseEvent,
    options?: { layout?: string }
  ) {
    contextMenuStore.open(item, event, options)
  }
</script>

<ModalRoot
  bind:settings
  {groupByKeys}
  onRefresh={handleRefresh}
  onApplyInitialSettings={handleApplyInitialSettings}
/>

<ContextMenuRoot {settings} onRefresh={handleRefresh} onItemClick={handleItemClick} />

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
    isGlobalSearchActive={searchStore.isGlobalActive}
    {currentFolder}
    {isRefreshing}
    {isScanning}
    isContextMenuVisible={contextMenuStore.isVisible}
    {folderToConfigureLayout}
    suggestions={allAutocompleteSuggestions}
    isPerformingGlobalSearch={searchStore.isPerformingGlobalSearch}
    globalSearchResults={searchStore.searchResults}
    isPerformingDetailSearch={searchStore.isPerformingDetailSearch}
    detailSearchResults={searchStore.detailResults}
    isDetailSearchActive={searchStore.isDetailActive}
    bind:globalSearchQuery={searchStore.globalQuery}
    bind:detailViewSearchQuery={searchStore.detailQuery}
    bind:highlightedGlobalSearchItemIndex={searchStore.highlightedGlobalIndex}
    bind:highlightedDetailSearchItemIndex={searchStore.highlightedDetailIndex}
    on:back={goBack}
    on:refresh={handleRefresh}
    on:openSettings={() => modalStore.open('settings')}
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
    isGlobalSearchActive={searchStore.isGlobalActive}
    searchResults={searchStore.searchResults}
    isPerformingSearch={searchStore.isPerformingGlobalSearch}
    highlightedSearchItemIndex={searchStore.highlightedGlobalIndex}
    {selectedItemForDetailView}
    filterQuery={searchStore.filterQuery}
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

  {#if searchStore.isFilterBarVisible}
    <FilterBar
      suggestions={allAutocompleteSuggestions}
      bind:query={searchStore.filterQuery}
      focusKey={searchStore.filterFocusKey}
      onClose={() => {
        searchStore.isFilterBarVisible = false
        // Clear the filter state when it's manually closed.
        searchStore.clearFilter()
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
