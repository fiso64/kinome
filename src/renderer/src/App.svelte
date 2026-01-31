<script lang="ts">
  import AppHeader from './components/layout/AppHeader.svelte'
  import MainView from './components/layout/MainView.svelte'
  import FilterBar from './components/ui/FilterBar.svelte'
  import ModalRoot from './components/layout/ModalRoot.svelte'
  import ContextMenuRoot from './components/layout/ContextMenuRoot.svelte'
  import Dialog from './components/ui/Dialog.svelte'
  import NotificationContainer from './components/ui/NotificationContainer.svelte'
  import { initializeShortcuts } from './lib/shortcuts'
  import { dialogStore } from './lib/dialog-store'
  import { notificationStore } from './lib/notification-store.svelte'
  import { autocompleteState } from './lib/autocomplete-manager'
  import AutocompleteMenu from './components/ui/AutocompleteMenu.svelte'
  import { navStoreV2 } from './lib/navigation-store-v2.svelte'
  import { searchStoreV2, initializeSearchEffects } from './lib/search-store-v2.svelte'
  import { modalStore } from './lib/modal-store.svelte'
  import { contextMenuStore } from './lib/context-menu-store.svelte'
  import { api } from './lib/api'
  import { onMount } from 'svelte'
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query'
  import type {
    Settings,
    MediaFolder,
    MediaFile,
    LibraryItem,
    AutocompleteSuggestions,
    SearchIndexEntry
  } from '../../shared/types'

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 5, // 5 minutes defaults
        retry: 1
      }
    }
  })

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
    persons: [],
    tagKeys: [],
    virtualTagKeys: [],
    tagValues: {}
  })

  let settings = $state<Settings | null>(null)

  const groupByKeys = $derived([
    'folder',
    'mediaType',
    'genre',
    'year',
    ...(settings?.virtualTags?.map((vt) => `vt.${vt.name}`) ?? []),
    ...allAutocompleteSuggestions.tagKeys.map((k) => `tags.${k}`)
  ])

  // --- Global Dialog State ---
  let activeDialogs = $state<Record<string, any>[]>([])
  $effect(() => {
    const unsubscribe = dialogStore.subscribe((dialogs) => {
      activeDialogs = dialogs
    })
    return unsubscribe
  })
  // ---

  let appHeaderComponent = $state<any>()

  // Initialize V2 Search Effects
  initializeSearchEffects()

  onMount(() => {
    log('App mounted. Initializing V2 services...')

    // In V2, we rely on the URL or the store defaults.
    navStoreV2.init()

    // If no folder is selected (root) and no specific item selected, try to load the library root
    if (!navStoreV2.state.currentFolderId && !navStoreV2.state.selectedItemId) {
      api.getLibraryRoot().then((root) => {
        if (root) {
          navStoreV2.navigateToRoot(root.id)
        }
      })
    }

    api.getContinueWatchingItems().then((items) => (continueWatchingItems = items))
    api.getAutocompleteSuggestions().then((s) => (allAutocompleteSuggestions = s))
    api.getSettings().then((s) => (settings = s))

    isScanning = false // Assume initially not scanning unless told otherwise via event?

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
      `${settings?.defaultLayoutSettings.grid.gridPosterSize ?? 200}px`
    )
  })

  $effect(() => {
    const unlistenItemsUpdated = api.onLibraryItemsUpdated((updatedItems) => {
      log(`Received batch update for ${updatedItems.length} items.`)
      // Invalidate queries for changed items
      for (const item of updatedItems) {
        queryClient.invalidateQueries({ queryKey: ['item', item.id] })

        // Refetch parent's children query so lists re-render
        if (item.parentId) {
          queryClient.refetchQueries({ queryKey: ['children', item.parentId] })
        }

        // Refetch tree queries for all ancestors (e.g., Season and Show when episode updates)
        if (item.ancestorIds && item.ancestorIds.length > 0) {
          for (const ancestorId of item.ancestorIds) {
            queryClient.refetchQueries({ queryKey: ['item', ancestorId, 'tree'] })
          }
        }

        // Also invalidate 'continue-watching' if relevant
        if (
          (item.type === 'file' && 'watched' in item) ||
          (item.type === 'folder' && 'continueWatchingDismissed' in item)
        ) {
          queryClient.invalidateQueries({ queryKey: ['continue-watching'] })
        }
      }
      // Global invalidation for virtual views (which depend on 'children' queries but potentially different IDs)
      queryClient.invalidateQueries({ queryKey: ['children'] })
    })
    return () => unlistenItemsUpdated()
  })

  // Listener for item deletion
  $effect(() => {
    const unlisten = api.onLibraryItemDeleted((deletedItemId) => {
      log(`Received deletion event for item ${deletedItemId}`)
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ['item', deletedItemId] })
      // If we are looking at this item, go back?
      if (
        navStoreV2.state.currentFolderId === deletedItemId ||
        navStoreV2.state.selectedItemId === deletedItemId
      ) {
        navStoreV2.goBack()
      }
      // Also children queries might be stale if we removed a child
      queryClient.invalidateQueries({ queryKey: ['children'] })
      // ^ A bit aggressive, but safe. Ideally invalidate parent's children.
    })
    return () => unlisten()
  })

  async function handleScan(): Promise<void> {
    isScanning = true
    navStoreV2.closeDetail()
    // V2: Query invlidations happen automatically via events or we force them
    const newRoot = await api.performInitialScan()
    if (newRoot) {
      // Force refresh root
      queryClient.invalidateQueries({ queryKey: ['item', newRoot.id] })
      // navStoreV2.navigateToRoot(newRoot.id) // Should be implied if init runs
      modalStore.open('initialFolderSettings', { root: newRoot })
    }
    isScanning = false
  }

  async function handleRefresh(): Promise<void> {
    if (isRefreshing || isScanning) return
    isRefreshing = true
    // clearItemCache() // Removed in V2
    const refreshedRoot = await api.refreshLibrary()
    if (refreshedRoot) {
      queryClient.invalidateQueries({ queryKey: ['item'] })
      queryClient.invalidateQueries({ queryKey: ['children'] })
    }
    isRefreshing = false
  }

  async function handlePlayFile(item: MediaFile): Promise<void> {
    const playlistUrl = `${window.location.origin}/api/playlist/${item.id}.m3u`
    try {
      await navigator.clipboard.writeText(playlistUrl)
      notificationStore.add('Playlist link copied to clipboard!', 'success')
      // Treat this action as "playing" the file, so update watched status and history
      await api.recordPlayback(item.id)
    } catch (err) {
      console.error('Failed to copy playlist link', err)
      notificationStore.add('Failed to copy link. Check console.', 'error')
    }
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
      // navStoreV2 should handle this
    }
  }

  async function handleItemClick(item: LibraryItem | SearchIndexEntry): Promise<void> {
    const fromSearch = 'staticScore' in item

    // Files: trigger play action (copy URL to clipboard)
    if (item.type === 'file') {
      await handlePlayFile(item as MediaFile)
      return
    }

    // Folders: navigate or open detail based on mediaType
    if (item.type === 'folder' && item.mediaType !== 'tv' && item.mediaType !== 'movie') {
      navStoreV2.navigateToFolder(item.id)
    } else {
      // Rich folder (TV/Movie) - open detail
      navStoreV2.openDetail(item.id)
    }

    if (fromSearch) {
      // V2 search store results - reserved for future use
    }
  }

  function goBack(): void {
    appHeaderComponent?.blurSearchInput()
    navStoreV2.goBack()
  }

  function goForward(): void {
    // This can be implemented in the future to handle forward navigation.
  }

  async function handleOpenLibrary(): Promise<void> {
    // Native picker removed.
    // TODO: Implement custom UI to input/browse for library path string
    const path = prompt('Enter the full server path to the library directory:')
    if (path) {
      await api.saveSettings({ libraryLocation: path })
      window.location.reload()
    }
  }

  function handleSearchByTag(key: string, value: string): void {
    searchStoreV2.searchByTag(key, value)
  }

  $effect(() => {
    const cleanupShortcuts = initializeShortcuts({
      openSettings: () => navStoreV2.openSettings(),
      focusSearch: () => appHeaderComponent?.focusSearchInput(),
      navigateBack: goBack,
      navigateForward: goForward,
      reloadLibrary: handleRefresh,
      showAndFocusFilterBar: () => {
        if (searchStoreV2.isFilterBarVisible) {
          searchStoreV2.filterFocusKey++
        } else {
          searchStoreV2.isFilterBarVisible = true
        }
      }
    })
    return () => cleanupShortcuts()
  })

  function openLayoutSelector() {
    // Layout selector requires context logic. For now, open settings logic updated.
    // navStoreV2 doesn't have openItemSettings('view').
    // Implementation:
    if (navStoreV2.state.currentFolderId) {
      navStoreV2.openItemSettings(navStoreV2.state.currentFolderId)
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

<QueryClientProvider client={queryClient}>
  <ModalRoot
    bind:settings
    {groupByKeys}
    onRefresh={handleRefresh}
    onApplyInitialSettings={handleApplyInitialSettings}
  />

  <ContextMenuRoot {settings} onRefresh={handleRefresh} onItemClick={handleItemClick} />
  <NotificationContainer />

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
      {isRefreshing}
      {isScanning}
      isContextMenuVisible={contextMenuStore.isVisible}
      on:refresh={handleRefresh}
      on:openSettings={() => navStoreV2.openSettings()}
      on:openLayoutSelector={openLayoutSelector}
      on:showContextMenu={(e) => handleShowContextMenu(e.detail.item, e.detail.event)}
      on:globalSearchItemClick={(e) => handleItemClick(e.detail.item)}
      on:detailSearchItemClick={(e) => handleItemClick(e.detail.item)}
      {settings}
    />

    <MainView
      {isScanning}
      {continueWatchingItems}
      {settings}
      suggestions={allAutocompleteSuggestions}
      on:scanLibrary={handleScan}
      on:openLibrary={handleOpenLibrary}
      on:itemClick={(e) => handleItemClick(e.detail.item)}
      on:showContextMenu={(e) =>
        handleShowContextMenu(e.detail.item, e.detail.event, e.detail.options)}
      on:searchByTag={(e) => handleSearchByTag(e.detail.key, e.detail.value)}
      on:dismissContinueWatching={(e) => handleDismissContinueWatching(e.detail.showId)}
    />

    {#if searchStoreV2.isFilterBarVisible}
      <FilterBar
        suggestions={allAutocompleteSuggestions}
        bind:query={searchStoreV2.filterQuery}
        focusKey={searchStoreV2.filterFocusKey}
        onClose={() => {
          searchStoreV2.isFilterBarVisible = false
          // Clear the filter state when it's manually closed.
          searchStoreV2.clearFilter()
        }}
      />
    {/if}
  </main>
</QueryClientProvider>

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
