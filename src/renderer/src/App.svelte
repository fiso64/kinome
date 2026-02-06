<script lang="ts">
  import AppHeader from '@components/layout/AppHeader.svelte'
  import MainView from '@components/layout/MainView.svelte'
  import SettingsView from '@components/layout/SettingsView.svelte'
  import FilterBar from '@ui/FilterBar.svelte'
  import ModalRoot from '@components/layout/ModalRoot.svelte'
  import ContextMenuRoot from '@components/layout/ContextMenuRoot.svelte'
  import Dialog from '@ui/Dialog.svelte'
  import NotificationContainer from '@ui/NotificationContainer.svelte'
  import { initializeShortcuts } from '@lib/shortcuts'
  import { dialogStore } from '@lib/dialog-store'
  import { notificationStore } from '@lib/notification-store.svelte'
  import { autocompleteState } from '@lib/autocomplete-manager'
  import AutocompleteMenu from '@ui/AutocompleteMenu.svelte'
  import { navStore } from '@lib/navigation-store.svelte'
  import { searchStore, initializeSearchEffects } from '@lib/search-store.svelte'
  import { modalStore } from '@lib/modal-store.svelte'
  import { contextMenuStore } from '@lib/context-menu-store.svelte'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import { getPlaylistUrl, api } from '@lib/api'
  import { resolveViewSettings } from '@shared/settings-helpers'
  import { authStore } from '@lib/auth-store.svelte'
  import LoginPage from '@components/layout/LoginPage.svelte'
  import { onMount } from 'svelte'
  import { QueryClient, QueryClientProvider, createQuery } from '@tanstack/svelte-query'
  import type {
    Settings,
    MediaFolder,
    MediaFile,
    LibraryItem,
    AutocompleteSuggestions,
    SearchIndexEntry,
    LibraryStatus,
    ScanStatus
  } from '@shared/types'

  const queryClient = libraryDataService.init()

  const log = (message: string): void => {
    console.log(`[${new Date().toISOString()}] [Renderer] ${message}`)
  }

  let isInitializing = $state(true)
  let isFileScanningLibrary = $state(false)
  let isMetadataFetchingLibrary = $state(false)
  let isFastUpdating = $derived(isFileScanningLibrary || isMetadataFetchingLibrary)

  // Deprecated: used for props in components that haven't been updated yet
  let isScanning = $derived(isFastUpdating)
  let libraryStatus = $state<LibraryStatus | null>(null)
  let isWaitingForScan = $state(false)
  let rootId = $state<string | null>(null)

  let allAutocompleteSuggestions = $state<AutocompleteSuggestions>({
    mediaType: [],
    genre: [],
    tags: {},
    virtualTags: {},
    person: null
  })

  let settings = $state<Settings | null>(null)

  let groupByKeys = $state<string[]>([])

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
    log('App mounted. Waiting for auth...')

    // Global event listeners are fine to register early, they won't
    // trigger until the server emits something anyway.

    const unlistenSettingsUpdated = api.onSettingsPossiblyUpdated((newSettings) => {
      log('Received settings-possibly-updated event from main process.')
      settings = newSettings
    })

    const unlistenScanStatus = api.onScanStatusChanged(async (status) => {
      log(`Scan status changed from backend: ${JSON.stringify(status)}`)

      if (status.isFileScanningLibrary !== undefined) {
        isFileScanningLibrary = status.isFileScanningLibrary
      }
      if (status.isMetadataFetchingLibrary !== undefined) {
        isMetadataFetchingLibrary = status.isMetadataFetchingLibrary
      }

      if (!isFastUpdating) {
        log('All background library tasks finished, flushing throttled updates.')
        libraryDataService.flush()
      }
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

    return () => {
      unlistenErrors()
      unlistenSettingsUpdated()
      unlistenScanStatus()
    }
  })

  // --- Authenticated Initialization ---
  let hasInitialized = $state(false)
  $effect(() => {
    if (authStore.isAuthenticated && !hasInitialized) {
      log('User authenticated. Starting initial data fetch...')
      hasInitialized = true

      navStore.init()

      // Prioritize getLibraryRoot to show SetupScreen instantly if needed
      api.getLibraryRoot().then((status) => {
        libraryStatus = status
        if (status.root) {
          rootId = status.root.id
          libraryDataService.rootId = rootId
        }

        if (status.status !== 'ready') {
          // If library is not ready, we don't need to wait for other data to show setup screen
          isInitializing = false
          log(`Library not ready (${status.status}). Ending initial load state early.`)
        }
      })

      Promise.allSettled([
        api.getAutocompleteSuggestions().then((s) => (allAutocompleteSuggestions = s)),
        api.getGroupByKeys().then((keys) => (groupByKeys = keys)),
        api.getSettings().then((s) => (settings = s))
      ]).then(() => {
        isInitializing = false
        log(`Initialization complete. isFastUpdating: ${isFastUpdating}`)
      })
    } else if (!authStore.isAuthenticated && hasInitialized) {
      log('User logged out. Resetting initialization state.')
      hasInitialized = false
      isInitializing = true
    }
  })

  // WebSocket Connection Management
  $effect(() => {
    // Only attempt connection if auth check is complete and we are authorized
    if (!authStore.isChecking) {
      log(
        `[App] Initiating WebSocket connection... (isAuth: ${authStore.isAuthenticated}, hasToken: ${!!authStore.token})`
      )
      api.connectWebSocket(authStore.token)
    }
  })

  async function refreshLibraryStatus() {
    log('Refreshing library status...')
    const status = await api.getLibraryRoot()
    libraryStatus = status
    if (status.root) {
      rootId = status.root.id
      libraryDataService.rootId = rootId
    }

    // Force WebSocket reconnection attempt to ensure we receive scan events
    // This is critical after SetupScreen where the connection might be stale or not established
    if (!authStore.isChecking) {
      log('[App] Ensuring WebSocket connection after library status refresh...')
      api.connectWebSocket(authStore.token)
    }

    // Also refresh other state if library is now ready
    if (status.status === 'ready') {
      Promise.allSettled([
        api.getAutocompleteSuggestions().then((s) => (allAutocompleteSuggestions = s)),
        api.getGroupByKeys().then((keys) => (groupByKeys = keys)),
        api.getSettings().then((s) => (settings = s))
      ])
    }
  }

  // This effect is reactive and will update the global default CSS variable whenever the settings change
  $effect(() => {
    document.documentElement.style.setProperty(
      '--grid-poster-size',
      `${settings?.defaultLayoutSettings.grid.gridPosterSize ?? 200}px`
    )
  })

  $effect(() => {
    log('[App] Registering library items update listener')
    const unlistenItemsUpdated = api.onLibraryItemsUpdated((updatedItems) => {
      log(`[App] Received batch update for ${updatedItems.length} items.`)
      libraryDataService.handleLibraryUpdates(updatedItems, isFastUpdating)
    })
    return () => {
      log('[App] Unregistering library items update listener')
      unlistenItemsUpdated()
    }
  })

  // Listener for item deletion
  $effect(() => {
    const unlisten = api.onLibraryItemDeleted((deletedItemId) => {
      log(`Received deletion event for item ${deletedItemId}`)
      libraryDataService.handleLibraryDeletion(deletedItemId)

      // If we are looking at this item, go back
      if (
        navStore.state.currentFolderId === deletedItemId ||
        navStore.state.selectedItemId === deletedItemId
      ) {
        navStore.goBack()
      }
    })
    return unlisten
  })

  $effect(() => {
    const unlisten = api.onMetadataIndexUpdated((index) => {
      allAutocompleteSuggestions = index.suggestions
      groupByKeys = index.groupByKeys
    })
    return unlisten
  })

  async function handleRefresh(): Promise<void> {
    if (isWaitingForScan || isFastUpdating || isInitializing) return
    isWaitingForScan = true
    // clearItemCache() // Removed in V2
    try {
      await api.performScan()
      libraryDataService.invalidateAllQueries()
    } catch (e) {
      console.error('Failed to trigger scan:', e)
    }
    isWaitingForScan = false
  }

  async function handlePlayFile(item: MediaFile): Promise<void> {
    const playlistUrl = getPlaylistUrl(item.id)
    try {
      await navigator.clipboard.writeText(playlistUrl)
      notificationStore.add('Playlist link copied to clipboard!', 'success')
      // Watched status is now updated by the backend when the stream is actually started.
    } catch (err) {
      console.error('Failed to copy playlist link', err)
      notificationStore.add('Failed to copy link. Check console.', 'error')
    }
  }

  function handleDismissContinueWatching(showId: string) {
    api.setContinueWatchingDismissed(showId)
    // Optimistic cache update
    libraryDataService.optimisticDismissContinueWatching(showId)
  }

  async function handleApplyInitialSettings(
    settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]
  ) {
    // Legacy removed
  }

  async function handleItemClick(item: LibraryItem | SearchIndexEntry): Promise<void> {
    const fromSearch = 'staticScore' in item

    // Files: navigate to detail if movie, otherwise play
    if (item.type === 'file') {
      if ('mediaType' in item && item.mediaType === 'movie') {
        navStore.openDetail(item.id)
      } else {
        await handlePlayFile(item as MediaFile)
      }
      return
    }

    // Folders: navigate or open detail based on mediaType
    if (item.type === 'folder' && item.mediaType !== 'tv' && item.mediaType !== 'movie') {
      navStore.navigateToFolder(item.id)
    } else {
      // Rich folder (TV/Movie) - open detail
      navStore.openDetail(item.id)
    }

    if (fromSearch) {
      appHeaderComponent?.blurSearchInput()
      searchStore.clearDetail()
      searchStore.clearGlobal()
    }
  }

  function goBack(): void {
    appHeaderComponent?.blurSearchInput()
    if (navStore.canGoBack) {
      navStore.goBack()
    }
  }

  function handleEscape(): void {
    appHeaderComponent?.blurSearchInput()

    if (searchStore.isGlobalActive) {
      searchStore.clearGlobal()
      return
    }

    if (navStore.isDetailViewActive) {
      if (searchStore.isDetailActive) {
        searchStore.clearDetail()
        return
      }
      navStore.closeDetail()
      return
    }

    if (navStore.canGoBack) {
      navStore.goBack()
    }
  }

  function goForward(): void {
    // This can be implemented in the future to handle forward navigation.
  }

  function handleSearchByTag(key: string, value: string): void {
    searchStore.searchByTag(key, value)
  }

  $effect(() => {
    const cleanupShortcuts = initializeShortcuts({
      navigateBack: () => {
        goBack()
      },
      navigateForward: () => {
        goForward()
      },
      escapeAction: () => {
        handleEscape()
      }
    })
    return () => cleanupShortcuts()
  })

  async function openLayoutSelector() {
    if (navStore.contextItemId) {
      const item = await api.getItem(navStore.contextItemId)
      if (item) {
        modalStore.open('itemSettings', {
          item,
          initialTab: 'view',
          defaultLayout: resolveViewSettings(item as any, settings).settings.layout as any
        })
      }
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

{#if authStore.isChecking || (authStore.isAuthenticated && isInitializing)}
  <div class="loading-screen">
    <div class="spinner"></div>
  </div>
{:else if !authStore.isAuthenticated}
  <LoginPage />
{:else}
  <QueryClientProvider client={queryClient}>
    <ModalRoot bind:settings {groupByKeys} onRefresh={handleRefresh} />

    <ContextMenuRoot {settings} onRefresh={handleRefresh} onItemClick={handleItemClick} />
    <NotificationContainer />

    {#if $autocompleteState.show}
      <AutocompleteMenu
        suggestions={$autocompleteState.suggestions}
        position={$autocompleteState.position}
        onSelect={$autocompleteState.onSelect}
        activeIndex={$autocompleteState.activeIndex}
      />
    {/if}

    <main>
      {#if navStore.state.path !== '/settings'}
        <AppHeader
          bind:this={appHeaderComponent}
          {isWaitingForScan}
          {isScanning}
          isContextMenuVisible={contextMenuStore.isVisible}
          on:refresh={handleRefresh}
          on:openSettings={() => navStore.navigateToSettings()}
          on:openLayoutSelector={openLayoutSelector}
          on:showContextMenu={(e) => handleShowContextMenu(e.detail.item, e.detail.event)}
          on:globalSearchItemClick={(e) => handleItemClick(e.detail.item)}
          on:detailSearchItemClick={(e) => handleItemClick(e.detail.item)}
          {settings}
          suggestions={allAutocompleteSuggestions}
        />
      {/if}

      {#if navStore.state.path === '/settings'}
        <SettingsView bind:settings />
      {:else}
        <MainView
          {isScanning}
          {libraryStatus}
          {settings}
          suggestions={allAutocompleteSuggestions}
          onStatusUpdate={refreshLibraryStatus}
          on:itemClick={(e) => handleItemClick(e.detail.item)}
          on:play={(e) => handlePlayFile(e.detail.item as MediaFile)}
          on:showContextMenu={(e) =>
            handleShowContextMenu(e.detail.item, e.detail.event, e.detail.options)}
          on:searchByTag={(e) => handleSearchByTag(e.detail.key, e.detail.value)}
          on:dismissContinueWatching={(e) => handleDismissContinueWatching(e.detail.showId)}
        />
      {/if}

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
  </QueryClientProvider>
{/if}

<style>
  main {
    --header-height: 54px;
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }

  .loading-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100vw;
    height: 100vh;
    background: #0f0f13;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(255, 255, 255, 0.1);
    border-radius: 50%;
    border-top-color: #6366f1;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
