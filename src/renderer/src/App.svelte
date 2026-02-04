<script lang="ts">
  import AppHeader from './components/layout/AppHeader.svelte'
  import MainView from './components/layout/MainView.svelte'
  import SettingsView from './components/layout/SettingsView.svelte'
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
  import { itemKeys, childKeys } from './lib/queries/query-keys'
  import { getPlaylistUrl, api } from './lib/api'
  import { resolveViewSettings } from '../../shared/settings-helpers'
  import { authStore } from './lib/auth-store.svelte'
  import LoginPage from './components/layout/LoginPage.svelte'
  import { onMount } from 'svelte'
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query'
  import type {
    Settings,
    MediaFolder,
    MediaFile,
    LibraryItem,
    AutocompleteSuggestions,
    SearchIndexEntry,
    LibraryStatus
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
  let libraryStatus = $state<LibraryStatus | null>(null)
  let isRefreshing = $state(false)
  let continueWatchingItems = $state<{ show: MediaFolder; nextEpisode: MediaFile }[]>([])
  let rootId = $state<string | null>(null)

  let allAutocompleteSuggestions = $state<AutocompleteSuggestions>({
    mediaTypes: [],
    genres: [],
    persons: [],
    tagKeys: [],
    virtualTagKeys: [],
    tagValues: {}
  })

  let settings = $state<Settings | null>(null)

  let continueWatchingTimeout: any
  const debouncedRefreshContinueWatching = () => {
    if (continueWatchingTimeout) clearTimeout(continueWatchingTimeout)
    continueWatchingTimeout = setTimeout(() => {
      if (!settings?.showContinueWatching) return
      log('Debounced refresh of continue-watching items.')
      api.getContinueWatchingItems().then((items) => (continueWatchingItems = items))
    }, 500)
  }

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
    log('App mounted. Waiting for auth...')

    // Global event listeners are fine to register early, they won't
    // trigger until the server emits something anyway.
    const unlistenSuggestions = api.onAutocompleteSuggestionsUpdated((s) => {
      allAutocompleteSuggestions = s
    })

    const unlistenSettingsUpdated = api.onSettingsPossiblyUpdated((newSettings) => {
      log('Received settings-possibly-updated event from main process.')
      settings = newSettings
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
      unlistenSuggestions()
      unlistenErrors()
      unlistenSettingsUpdated()
    }
  })

  // --- Authenticated Initialization ---
  let hasInitialized = $state(false)
  $effect(() => {
    if (authStore.isAuthenticated && !hasInitialized) {
      log('User authenticated. Starting initial data fetch...')
      hasInitialized = true

      navStoreV2.init()

      // Prioritize getLibraryRoot to show SetupScreen instantly if needed
      api.getLibraryRoot().then((status) => {
        libraryStatus = status
        if (status.root) rootId = status.root.id

        if (status.status !== 'ready') {
          // If library is not ready, we don't need to wait for other data to show setup screen
          isScanning = false
          log(`Library not ready (${status.status}). Ending initial scan state early.`)
        }
      })

      Promise.allSettled([
        api.getContinueWatchingItems().then((items) => (continueWatchingItems = items)),
        api.getAutocompleteSuggestions().then((s) => (allAutocompleteSuggestions = s)),
        api.getSettings().then((s) => (settings = s))
      ]).then(() => {
        isScanning = false
        log(`Initialization complete. isScanning: ${isScanning}`)
      })
    }
  })

  async function refreshLibraryStatus() {
    log('Refreshing library status...')
    const status = await api.getLibraryRoot()
    libraryStatus = status
    if (status.root) rootId = status.root.id

    // Also refresh other state if library is now ready
    if (status.status === 'ready') {
      Promise.allSettled([
        api.getContinueWatchingItems().then((items) => (continueWatchingItems = items)),
        api.getAutocompleteSuggestions().then((s) => (allAutocompleteSuggestions = s)),
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
    const unlistenItemsUpdated = api.onLibraryItemsUpdated((updatedItems) => {
      log(`Received batch update for ${updatedItems.length} items.`)

      const itemIdsToInvalidate = new Set<string>()
      const parentIdsToRefetch = new Set<string>()
      const ancestorIdsToRefetch = new Set<string>()
      let refreshContinueWatching = false
      let refreshRoot = false

      for (const item of updatedItems) {
        // Broadly invalidate everything related to this specific item ID across all contexts
        itemIdsToInvalidate.add(item.id)

        // Alias support: If the root folder was updated, also invalidate 'root'
        if (!item.parentId || item.id === rootId) {
          refreshRoot = true
        }

        // Refetch parent's children query so lists re-render
        if (item.parentId) {
          parentIdsToRefetch.add(item.parentId)
        }

        // Refetch tree queries for all ancestors (e.g., Season and Show when episode updates)
        if (item.ancestorIds && item.ancestorIds.length > 0) {
          for (const ancestorId of item.ancestorIds) {
            ancestorIdsToRefetch.add(ancestorId)
          }
        }

        // Also invalidate 'continue-watching' if relevant
        if (
          (item.type === 'file' && 'watched' in item) ||
          (item.type === 'folder' &&
            ('continueWatchingDismissed' in item || 'nextUpDismissed' in item))
        ) {
          refreshContinueWatching = true
        }
      }

      // Execute invalidations per item
      itemIdsToInvalidate.forEach((id) => {
        queryClient.invalidateQueries({
          queryKey: itemKeys.all,
          predicate: (query) => query.queryKey[1] === id
        })

        if (refreshRoot && id === rootId) {
          queryClient.invalidateQueries({ queryKey: itemKeys.details('root') })
          queryClient.invalidateQueries({ queryKey: itemKeys.settings('root') })
        }
      })

      // Execute refetches per parent
      parentIdsToRefetch.forEach((parentId) => {
        queryClient.refetchQueries({
          queryKey: childKeys.all,
          predicate: (query) => query.queryKey[1] === parentId
        })

        // Alias support: If parent is root, also invalidate 'children', 'root'
        if (parentId === rootId) {
          queryClient.refetchQueries({
            queryKey: childKeys.all,
            predicate: (query) => query.queryKey[1] === 'root'
          })
        }
      })

      // Execute refetches per ancestor
      ancestorIdsToRefetch.forEach((ancestorId) => {
        queryClient.refetchQueries({ queryKey: itemKeys.tree(ancestorId) })
      })

      // Global invalidations
      if (refreshContinueWatching) {
        queryClient.invalidateQueries({ queryKey: ['continue-watching'] })
        debouncedRefreshContinueWatching()
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
    continueWatchingItems = continueWatchingItems.filter((cw) => cw.show.id !== showId)
  }

  async function handleApplyInitialSettings(
    settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]
  ) {
    await api.applyInitialFolderSettings(settings)
    // Instead of reloading, just refresh the data
    queryClient.invalidateQueries({ queryKey: itemKeys.all })
    queryClient.invalidateQueries({ queryKey: childKeys.all })
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
      appHeaderComponent?.blurSearchInput()
      searchStoreV2.clearDetail()
      searchStoreV2.clearGlobal()
    }
  }

  function goBack(): void {
    appHeaderComponent?.blurSearchInput()
    if (navStoreV2.canGoBack) {
      navStoreV2.goBack()
    }
  }

  function handleEscape(): void {
    appHeaderComponent?.blurSearchInput()

    if (searchStoreV2.isGlobalActive) {
      searchStoreV2.clearGlobal()
      return
    }

    if (navStoreV2.isDetailViewActive) {
      if (searchStoreV2.isDetailActive) {
        searchStoreV2.clearDetail()
        return
      }
      navStoreV2.closeDetail()
      return
    }

    if (navStoreV2.canGoBack) {
      navStoreV2.goBack()
    }
  }

  function goForward(): void {
    // This can be implemented in the future to handle forward navigation.
  }

  function handleSearchByTag(key: string, value: string): void {
    searchStoreV2.searchByTag(key, value)
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
    if (navStoreV2.contextItemId) {
      const item = await api.getItemV2(navStoreV2.contextItemId)
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

{#if authStore.isChecking}
  <div class="loading-screen">
    <div class="spinner"></div>
  </div>
{:else if !authStore.isAuthenticated}
  <LoginPage />
{:else}
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
        activeIndex={$autocompleteState.activeIndex}
      />
    {/if}

    <main>
      {#if navStoreV2.state.path !== '/settings'}
        <AppHeader
          bind:this={appHeaderComponent}
          {isRefreshing}
          {isScanning}
          isContextMenuVisible={contextMenuStore.isVisible}
          on:refresh={handleRefresh}
          on:openSettings={() => navStoreV2.navigateToSettings()}
          on:openLayoutSelector={openLayoutSelector}
          on:showContextMenu={(e) => handleShowContextMenu(e.detail.item, e.detail.event)}
          on:globalSearchItemClick={(e) => handleItemClick(e.detail.item)}
          on:detailSearchItemClick={(e) => handleItemClick(e.detail.item)}
          {settings}
          suggestions={allAutocompleteSuggestions}
        />
      {/if}

      {#if navStoreV2.state.path === '/settings'}
        <SettingsView bind:settings />
      {:else}
        <MainView
          {isScanning}
          {libraryStatus}
          {continueWatchingItems}
          {settings}
          suggestions={allAutocompleteSuggestions}
          onStatusUpdate={refreshLibraryStatus}
          on:itemClick={(e) => handleItemClick(e.detail.item)}
          on:showContextMenu={(e) =>
            handleShowContextMenu(e.detail.item, e.detail.event, e.detail.options)}
          on:searchByTag={(e) => handleSearchByTag(e.detail.key, e.detail.value)}
          on:dismissContinueWatching={(e) => handleDismissContinueWatching(e.detail.showId)}
        />
      {/if}

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
