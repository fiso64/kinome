<script lang="ts">
  import AppHeader from '@components/layout/AppHeader.svelte'
  import ViewManager from '@components/layout/ViewManager.svelte'
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
  import { playerLauncherService, resolveClientPlayers } from '@lib/services/player-launcher.service'
  import { clientSettingsStore } from '@lib/client-settings-store.svelte'
  import { contextMenuStore } from '@lib/context-menu-store.svelte'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import { getPlaylistUrl, api } from '@lib/api'
  import { resolveViewSettings } from '@shared/settings-helpers'
  import { authStore } from '@lib/auth-store.svelte'
  import LoginPage from '@components/layout/LoginPage.svelte'
  import SetupScreen from '@components/layout/SetupScreen.svelte'
  import { onMount } from 'svelte'
  import { QueryClientProvider } from '@tanstack/svelte-query'
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

    const unlistenStatus = api.onAppStatusUpdated((status) => {
      if (status.settings) {
        log('Received settings update from backend.')
        settings = status.settings
      }
      if (status.forceReloadForNewLibrary) {
        log('Received force reload instruction.')
        window.location.reload()
      }
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
      unlistenStatus()
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

      // 1. Fetch library root first
      const rootPromise = api.getLibraryRoot().then((status) => {
        libraryStatus = status
        if (status.root) {
          rootId = status.root.id
          libraryDataService.rootId = rootId
        }
        return status
      })

      // 2. Fetch settings (needed for layout defaults before rendering content)
      const settingsPromise = api.getSettings().then((s) => (settings = s))

      // 3. Lift the loading veil as soon as the critical path is done
      Promise.allSettled([rootPromise, settingsPromise]).then(() => {
        isInitializing = false
        log(`Initialization complete. Status: ${libraryStatus?.status}`)
      })

      // 4. Load non-critical data in the background (search autocomplete, groupBy UI)
      api.getAutocompleteSuggestions({ excludeHidden: true }).then((s) => (allAutocompleteSuggestions = s))
      api.getGroupByKeys().then((keys) => (groupByKeys = keys))
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
        api.getAutocompleteSuggestions({ excludeHidden: true }).then((s) => (allAutocompleteSuggestions = s)),
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
      searchStore.handleLibraryUpdates(updatedItems)
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

      if (index.invalidateItems) {
        log('Metadata index update includes instruction to invalidate item cache.')
        libraryDataService.invalidateAllQueries()
      }
    })
    return unlisten
  })

  // Force Home Navigation if Setup is required
  $effect(() => {
    if (authStore.isAuthenticated && !isInitializing) {
      const needsSetup = !settings?.libraryLocation || libraryStatus?.status !== 'ready'
      if (needsSetup) {
        if (navStore.canGoBack) {
          log('Setup required: Forcing navigation to home.')
          navStore.navigateToHome()
        }
      }
    }
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

  // --- Centralized Actions ---
  const actions = {
    rescan: handleRefresh,

    toggleFullscreen: () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch((err) => {
          console.warn(`Error attempting to enable full-screen mode: ${err.message}`)
        })
      } else {
        document.exitFullscreen()
      }
    },

    openSettings: () => navStore.navigateToSettings(),

    openViewSettings: async (itemOrId?: LibraryItem | string) => {
      const id = itemOrId || navStore.contextItemId
      if (!id) return

      // Capture parentItem before any await — contextMenuStore.close() may null it
      const parentItem = contextMenuStore.parentItem

      const targetItem = await libraryDataService.ensureItemWithFields(id, [
        'type',
        'mediaType',
        'viewSettings'
      ])
      if (targetItem && targetItem.type === 'folder') {
        const isSelf = parentItem?.id === targetItem.id
        modalStore.open('itemSettings', {
          item: targetItem,
          initialTab: 'view',
          overrideParent: isSelf ? undefined : parentItem,
          defaultLayout: resolveViewSettings(
            targetItem as any,
            settings,
            new Set(),
            parentItem?.viewSettings?.childViewSettings
          ).settings.layout as any
        })
      }
    },

    editMetadata: async (
      itemOrId?: LibraryItem | string,
      initialTab: 'metadata' | 'view' | 'folder' | 'virtualFolder' = 'metadata'
    ) => {
      const id = itemOrId || navStore.contextItemId
      if (!id || id === 'root') return

      const parentItem = contextMenuStore.parentItem

      const targetItem = await libraryDataService.ensureItemWithFields(id, [
        'type',
        'mediaType',
        'path',
        'name',
        'overview',
        'genres',
        'tags',
        'seasonNumber',
        'episodeNumber',
        'viewSettings',
        'retrieveChildrenMetadata',
        'childrenTypeHint',
        'processTvChildren',
        'isVirtual',
        'virtualType',
        'filter',
        'parentId'
      ])

      if (targetItem) {
        const isSelf = parentItem?.id === targetItem.id
        modalStore.open('itemSettings', {
          item: targetItem,
          initialTab: initialTab,
          overrideParent: isSelf ? undefined : parentItem,
          defaultLayout: resolveViewSettings(
            targetItem as any,
            settings,
            new Set(),
            parentItem?.viewSettings?.childViewSettings
          ).settings.layout as any
        })
      }
    },

    showProperties: async (itemOrId?: LibraryItem | string) => {
      const id = itemOrId || navStore.contextItemId
      if (!id) return

      const targetItem = await libraryDataService.ensureItemWithFields(id, [
        'type',
        'mediaType',
        'path',
        'name'
      ])
      if (targetItem) {
        modalStore.open('properties', { item: targetItem })
      }
    },

    markUnwatched: async (itemOrId?: LibraryItem | string) => {
      const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id || navStore.contextItemId
      if (!id || id === 'root' || id === 'home') return

      api.markAsUnwatched(id)
      // Optimistic local update for visual feedback
      libraryDataService.handleLibraryUpdates([{ id, watched: false } as any], false)
    },

    renameItem: async (itemOrId: LibraryItem | string) => {
      const targetItem = await libraryDataService.ensureItemWithFields(itemOrId, ['path', 'name'])
      if (targetItem) {
        modalStore.open('rename', { item: targetItem })
      }
    },

    manualSearch: async (itemOrId: LibraryItem | string, initialTab: 'match' | 'artwork') => {
      const targetItem = await libraryDataService.ensureItemWithFields(itemOrId, [
        'tmdbId',
        'mediaType',
        'name',
        'path',
        'posterPath',
        '_v',
        'isVirtual',
        'virtualType'
      ])
      if (targetItem) {
        modalStore.open('manualSearch', { item: targetItem, initialTab })
      }
    },

    revealInExplorer: async (itemOrId: LibraryItem | string) => {
      const targetItem = await libraryDataService.ensureItemWithFields(itemOrId, ['path'])
      if (targetItem?.path) {
        api.revealInExplorer(targetItem.path)
      }
    },

    trashItem: async (itemOrId: LibraryItem | string) => {
      const targetItem = await libraryDataService.ensureItemWithFields(itemOrId, [
        'path',
        'name',
        'title'
      ])
      if (!targetItem?.path) return

      const confirmed = await dialogStore.showConfirmation({
        title: 'Confirm Deletion',
        message: `Are you sure you want to move "${targetItem.title ?? targetItem.name}" to the trash?`,
        detail: 'This action cannot be undone from within the app.',
        confirmText: 'Move to Trash',
        cancelText: 'Cancel',
        confirmClass: 'danger'
      })

      if (confirmed) {
        const success = await api.trashItem(targetItem.id)
        if (success) {
          await handleRefresh()
        }
      }
    },

    clearMetadata: async (itemOrId: LibraryItem | string) => {
      const targetItem = await libraryDataService.ensureItemWithFields(itemOrId, [
        'path',
        'name',
        'title',
        'type'
      ])
      if (!targetItem) return

      const path = targetItem.path || ''
      const isFolder = targetItem.type === 'folder'
      const isVirtual = path.startsWith('virtual://')
      const message = isVirtual
        ? `This will permanently delete all metadata (including custom titles, posters, and tags) for all items currently shown in the virtual folder "${targetItem.title ?? targetItem.name}".`
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
          await api.clearItemMetadata(targetItem.id, result.checkboxValue)
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

        if (isVirtual && targetItem.type === 'folder') {
          const childIds = (targetItem as any).children?.map((c: any) => c.id) || []
          await api.clearVirtualFolderMetadata(childIds)
        } else {
          await api.clearItemMetadata(targetItem.id, false)
        }
      }
    },

    assignSeasons: async (itemOrId: LibraryItem | string) => {
      const targetItem = await libraryDataService.ensureItemWithFields(itemOrId, [
        'type',
        'mediaType'
      ])
      if (targetItem?.type === 'folder') {
        modalStore.open('assignSeasons', { item: targetItem as MediaFolder })
      }
    },

    hideItem: async (itemOrId: LibraryItem | string) => {
      const targetItem = await libraryDataService.ensureItemWithFields(itemOrId, ['name', 'title'])
      if (!targetItem) return

      const confirmed = await dialogStore.showConfirmation({
        title: 'Confirm Hide',
        message: `Are you sure you want to hide "${targetItem.title ?? targetItem.name}"?`,
        detail: "This is not a deletion. It can be unhidden from its parent folder's settings.",
        confirmText: 'Hide Item',
        cancelText: 'Cancel'
      })

      if (confirmed) {
        const itemToUpdate = { ...JSON.parse(JSON.stringify(targetItem)), isHidden: true }
        await api.userUpdateItem(itemToUpdate)
      }
    },

    deleteFromDb: async (itemOrId: LibraryItem | string) => {
      const targetItem = await libraryDataService.ensureItemWithFields(itemOrId, ['name', 'title'])
      if (!targetItem) return

      const confirmed = await dialogStore.showConfirmation({
        title: 'Confirm Database Deletion',
        message: `Are you sure you want to permanently delete the record for "${
          targetItem.title ?? targetItem.name
        }" from the database?`,
        detail:
          'This only affects the library database, not the file on disk. This action cannot be undone.',
        confirmText: 'Delete Record',
        cancelText: 'Cancel',
        confirmClass: 'danger'
      })
      if (confirmed) {
        await api.deleteItemFromDb(targetItem.id)
      }
    },

    createVirtualFolder: async (itemOrId: LibraryItem | string) => {
      const targetItem = await libraryDataService.ensureItemWithFields(itemOrId, ['type', 'name'])
      if (!targetItem || targetItem.type !== 'folder') return

      modalStore.open('createVirtualFolder', {
        parentItem: targetItem,
        onCreated: (newId: string) => {
          modalStore.close()
          handleRefresh().then(() => {
            navStore.navigateToFolder(newId)
          })
        }
      })
    }
  }

  async function handlePlayFile(item: MediaFile): Promise<void> {
    await playerLauncherService.playItem(
      item,
      resolveClientPlayers(settings?.playerCommands ?? [], clientSettingsStore.settings.enabledPlayerIds)
    )
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

  async function handleItemClick(
    item: LibraryItem | SearchIndexEntry,
    source?: 'global' | 'detail'
  ): Promise<void> {
    const fromSearch = 'staticScore' in item || source === 'detail' || source === 'global'

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
    if (
      item.type === 'folder' &&
      item.mediaType !== 'tv' &&
      item.mediaType !== 'movie' &&
      item.mediaType !== 'season'
    ) {
      navStore.navigateToFolder(item.id)
    } else {
      // Rich folder (TV/Movie/Season) - open detail
      navStore.openDetail(item.id)
    }

    if (fromSearch) {
      // Sync highlight with the clicked item so it remains "selected" on return
      if (source !== 'detail') {
        const index = searchStore.searchResults.findIndex((i) => i.id === item.id)
        if (index !== -1) {
          searchStore.highlightedGlobalIndex = index
        }
      }

      appHeaderComponent?.blurSearchInput()

      if (source === 'detail' || (navStore.isDetailViewActive && !searchStore.isGlobalActive)) {
        searchStore.clearDetail()
      }

      // searchStore.clearGlobal()
      // ^-- WE NO LONGER CLEAR GLOBAL SEARCH ON CLICK.
      // This allows the search view to remain "active" as a background view,
      // preserving its scroll position and results for when the user navigates back.
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
      navigateBack: () => goBack(),
      navigateForward: () => goForward(),
      escapeAction: () => handleEscape(),
      focusSearch: () => appHeaderComponent?.focusSearchInput(),
      rescan: actions.rescan,
      toggleFullscreen: actions.toggleFullscreen,
      openSettings: actions.openSettings,
      openViewSettings: () => actions.openViewSettings(),
      markAsUnwatched: () => actions.markUnwatched(),
      editMetadata: () => actions.editMetadata(),
      openProperties: () => actions.showProperties()
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
    options?: { layout?: string; parentItem?: LibraryItem }
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

    <ContextMenuRoot {settings} {actions} onItemClick={handleItemClick} />
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
      {#if !settings?.libraryLocation || libraryStatus?.status !== 'ready'}
        <SetupScreen onStatusUpdate={refreshLibraryStatus} />
      {:else}
        <AppHeader
          bind:this={appHeaderComponent}
          {isWaitingForScan}
          {isScanning}
          isContextMenuVisible={contextMenuStore.isVisible}
          on:refresh={handleRefresh}
          on:openSettings={() => navStore.navigateToSettings()}
          on:openLayoutSelector={openLayoutSelector}
          on:showContextMenu={(e) => handleShowContextMenu(e.detail.item, e.detail.event)}
          on:globalSearchItemClick={(e) => handleItemClick(e.detail.item, 'global')}
          on:detailSearchItemClick={(e) => handleItemClick(e.detail.item, 'detail')}
          {settings}
          suggestions={allAutocompleteSuggestions}
        />

        <ViewManager
          {isScanning}
          {libraryStatus}
          bind:settings
          suggestions={allAutocompleteSuggestions}
          on:statusUpdate={refreshLibraryStatus}
          on:itemClick={(e) => handleItemClick(e.detail.item)}
          on:play={(e) => handlePlayFile(e.detail.item)}
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

<svelte:window
  ondragstart={(e) => {
    if ((e.target as HTMLElement).tagName === 'IMG') {
      e.preventDefault()
    }
  }}
/>

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
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--color-background);
    z-index: 9999;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(255, 255, 255, 0.1);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
