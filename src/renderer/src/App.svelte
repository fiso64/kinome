<script lang="ts">
  import AppSidebar from '@components/layout/AppSidebar.svelte'
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
  import { modalStore, withPending } from '@lib/modal-store.svelte'
  import { contextMenuStore } from '@lib/context-menu-store.svelte'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import { api } from '@lib/api'
  import { clientSettingsStore } from '@lib/client-settings-store.svelte'
  import {
    BUILTIN_WEB_PLAYER, playerLauncherService, resolveClientPlayers, resolvePlaybackQuality
  } from '@lib/services/player-launcher.service'
  import { isPlaybackQuality, type PlaybackQuality } from '@shared/playback-quality'
  import { getWebPlaybackInfo } from '@lib/services/web-playback.service'
  import { isWebQualityChoice, type WebPlaybackInfo, type WebQualityChoice } from '@shared/web-playback'
  import { itemCapabilities } from '@shared/item-capabilities'
  import { resolveViewSettings } from '@shared/settings-helpers'
  import { authStore } from '@lib/auth-store.svelte'
  import LoginPage from '@components/layout/LoginPage.svelte'
  import SetupScreen from '@components/layout/SetupScreen.svelte'
  import { onMount, tick } from 'svelte'
  import { QueryClientProvider } from '@tanstack/svelte-query'
  import { LIBRARY_ROOT_ID } from '@shared/types'
  import type {
    Settings,
    MediaFolder,
    MediaFile,
    PlayerCommandConfig,
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
  let scanStatus = $state<ScanStatus | null>(null)
  const isFastUpdating = $derived(scanStatus?.isFastUpdating ?? false)
  const isScanning = $derived(isFastUpdating || (scanStatus?.isProbingLocalMedia ?? false))
  let libraryStatus = $state<LibraryStatus | null>(null)
  let isWaitingForScan = $state(false)
  let allAutocompleteSuggestions = $state<AutocompleteSuggestions>({
    mediaType: [],
    genre: [],
    tags: {},
    virtualTags: {},
    person: null
  })

  let settings = $state<Settings | null>(null)
  let playback = $state.raw<{
    item: MediaFile
    quality?: WebQualityChoice
    info: Promise<WebPlaybackInfo>
    controller: AbortController
  }>()
  let webPlayer = $state<Promise<typeof import('@components/player/WebPlayer.svelte')>>()

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

  let appSidebarComponent = $state<AppSidebar>()
  let viewManager = $state<ViewManager>()
  let librarySearchOpen = $state(false)
  const librarySearchVisible = $derived(!navStore.isSettingsActive && !navStore.isDetailViewActive &&
    (librarySearchOpen || searchStore.isGlobalActive))

  async function openSearch() {
    if (navStore.isSettingsActive) return
    if (navStore.isDetailViewActive) {
      await appSidebarComponent?.focusSearchInput()
      return
    }
    librarySearchOpen = true
    await tick()
    viewManager?.focusLibrarySearch()
  }

  function closeLibrarySearch() {
    librarySearchOpen = false
    if (searchStore.isGlobalActive) searchStore.clearGlobal()
    appSidebarComponent?.focusSearchTrigger()
  }

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

      scanStatus = status

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

      // 1. Fetch library status and settings in parallel
      const statusPromise = api.getLibraryStatus().then((s) => (libraryStatus = s))
      const settingsPromise = api.getSettings().then((s) => (settings = s))

      // 2. Lift the loading veil as soon as both are done
      Promise.allSettled([statusPromise, settingsPromise]).then(() => {
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
      closeWebPlayer()
      queryClient.clear()
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
    libraryStatus = await api.getLibraryStatus()

    // Force WebSocket reconnection attempt to ensure we receive scan events
    // This is critical after SetupScreen where the connection might be stale or not established
    if (!authStore.isChecking) {
      log('[App] Ensuring WebSocket connection after library status refresh...')
      api.connectWebSocket(authStore.token)
    }

    // Also refresh other state if library is now ready
    if (libraryStatus.status === 'ready') {
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
        navStore.currentFolderId === deletedItemId ||
        navStore.selectedItemId === deletedItemId
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
      const needsSetup = libraryStatus?.status !== 'ready'
      if (needsSetup) {
        if (navStore.canGoBack) {
          log('Setup required: Forcing navigation to home.')
          navStore.navigateToHome()
        }
      }
    }
  })

  async function handleRefresh(): Promise<void> {
    if (!authStore.can.triggerLibraryScan || isWaitingForScan || isScanning || isInitializing) return
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

  // Resolves an item to pass to a modal immediately — uses the flat item map so
  // any item that has ever been displayed is available without a network round-trip.
  // The modal is responsible for fetching any missing fields it needs internally.
  function resolveItemForModal(itemOrId: LibraryItem | string | undefined): LibraryItem | null {
    if (!itemOrId) return null
    if (typeof itemOrId !== 'string') return itemOrId
    return libraryDataService.getItemFromCache(itemOrId) ?? { id: itemOrId, type: 'folder', name: '' } as LibraryItem
  }

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

    openViewSettings: (itemOrId?: LibraryItem | string) => {
      const id = itemOrId || navStore.contextItemId
      const targetItem = resolveItemForModal(id)
      if (!targetItem || targetItem.type !== 'folder') return

      const parentItem = contextMenuStore.parentItem
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
    },

    editMetadata: (
      itemOrId?: LibraryItem | string,
      initialTab: 'metadata' | 'view' | 'folder' | 'virtualFolder' = 'metadata'
    ) => {
      const id = itemOrId || navStore.contextItemId
      if (!id || id === LIBRARY_ROOT_ID) return

      const targetItem = resolveItemForModal(id)
      if (!targetItem) return

      const parentItem = contextMenuStore.parentItem
      const isSelf = parentItem?.id === targetItem.id
      modalStore.open('itemSettings', {
        item: targetItem,
        initialTab,
        overrideParent: isSelf ? undefined : parentItem,
        defaultLayout: resolveViewSettings(
          targetItem as any,
          settings,
          new Set(),
          parentItem?.viewSettings?.childViewSettings
        ).settings.layout as any
      })
    },

    showProperties: (itemOrId?: LibraryItem | string) => {
      const id = itemOrId || navStore.contextItemId
      const targetItem = resolveItemForModal(id)
      if (targetItem) {
        modalStore.open('properties', { item: targetItem })
      }
    },

    markUnwatched: async (itemOrId?: LibraryItem | string) => {
      const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id || navStore.contextItemId
      if (!id || id === LIBRARY_ROOT_ID || id === 'home') return

      api.markAsUnwatched(id).catch((err: any) => {
        notificationStore.add(err.message || 'Failed to mark as unwatched.', 'error')
      })
      // Optimistic local update for visual feedback
      libraryDataService.handleLibraryUpdates([{ id, watched: false } as any], false)
    },

    renameItem: (itemOrId: LibraryItem | string) =>
      withPending(async () => {
        const targetItem = await libraryDataService.ensureItemWithFields(itemOrId, ['name'])
        if (targetItem) {
          modalStore.open('rename', { item: targetItem })
        }
      }),

    manualSearch: (itemOrId: LibraryItem | string, initialTab: 'match' | 'artwork') => {
      const targetItem = resolveItemForModal(itemOrId)
      if (targetItem) {
        modalStore.open('manualSearch', { item: targetItem, initialTab })
      }
    },

    revealInExplorer: async (itemOrId: LibraryItem | string) => {
      if (!authStore.can.editSettings) return
      const targetItem = await libraryDataService.ensureItemWithFields(itemOrId, ['path'])
      if (targetItem?.path) {
        api.revealInExplorer(targetItem.path)
      }
    },

    trashItem: async (itemOrId: LibraryItem | string) => {
      if (!authStore.can.editMetadata) return
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
      if (!authStore.can.editMetadata) return
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

    assignSeasons: (itemOrId: LibraryItem | string) =>
      withPending(async () => {
        const targetItem = await libraryDataService.ensureItemWithFields(itemOrId, [
          'type',
          'mediaType'
        ])
        if (targetItem?.type === 'folder') {
          modalStore.open('assignSeasons', { item: targetItem as MediaFolder })
        }
      }),

    hideItem: async (itemOrId: LibraryItem | string) => {
      if (!authStore.can.editMetadata) return
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
      if (!authStore.can.editMetadata) return
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

    createVirtualFolder: (itemOrId: LibraryItem | string) =>
      withPending(async () => {
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
      })
  }

  function closeWebPlayer() {
    playback?.controller.abort()
    playback = undefined
  }

  function handlePlayFile(item: MediaFile, preferred?: PlayerCommandConfig, quality?: WebQualityChoice | PlaybackQuality): void {
    if (!itemCapabilities(item).canPlay) return
    const players = resolveClientPlayers(settings?.playerCommands ?? [], clientSettingsStore.settings.enabledPlayerIds)
    const player = preferred ?? players[0]
    if (player.id === BUILTIN_WEB_PLAYER.id) {
      webPlayer ??= import('@components/player/WebPlayer.svelte')
      playback?.controller.abort()
      const controller = new AbortController()
      const info = getWebPlaybackInfo(item.id, controller.signal)
      // The player handles the rejection when its lazy module has loaded.
      void info.catch(() => {})
      playback = { item, quality: isWebQualityChoice(quality) ? quality : undefined, info, controller }
    } else {
      void playerLauncherService.launchExternal(item, player,
        isPlaybackQuality(quality) ? quality : resolvePlaybackQuality(settings))
    }
  }

  function handleDismissContinueWatching(showId: string) {
    api.setContinueWatchingDismissed(showId)
    // Optimistic cache update
    libraryDataService.optimisticDismissContinueWatching(showId)
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
        handlePlayFile(item as MediaFile)
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

      appSidebarComponent?.blurSearchInput()
      librarySearchOpen = false

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
    appSidebarComponent?.blurSearchInput()
    if (librarySearchOpen && !searchStore.isGlobalActive) {
      closeLibrarySearch()
      return
    }
    librarySearchOpen = false
    if (navStore.canGoBack) {
      navStore.goBack()
    }
  }

  function handleEscape(): void {
    if (appSidebarComponent?.closeTitleSearch()) {
      searchStore.clearDetail()
      return
    }

    if (librarySearchVisible) {
      closeLibrarySearch()
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
      focusSearch: openSearch,
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

  function openLayoutSelector() {
    const item = resolveItemForModal(navStore.contextItemId ?? undefined)
    if (item) {
      modalStore.open('itemSettings', {
        item,
        initialTab: 'view',
        defaultLayout: resolveViewSettings(item as any, settings).settings.layout as any
      })
    }
  }

  async function handleShowContextMenu(
    item: LibraryItem | SearchIndexEntry,
    event: MouseEvent,
    options?: { layout?: string; parentItem?: LibraryItem; showLogout?: boolean }
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

{#if authStore.isAuthenticated ? isInitializing : authStore.isChecking}
  <div class="loading-screen" role="status" aria-label="Opening Kinome">
    <div class="busy-wheel"></div>
  </div>
{:else if !authStore.isAuthenticated}
  <LoginPage />
{:else}
  <QueryClientProvider client={queryClient}>
    <ModalRoot bind:settings {groupByKeys} onRefresh={handleRefresh} />

    <ContextMenuRoot {settings} {actions} onItemClick={handleItemClick} onOpenMatchingFile={(id) => navStore.openDetail(id)} onPlay={handlePlayFile} />
    {#if !playback}<NotificationContainer />{/if}

    {#if $autocompleteState.show}
      <AutocompleteMenu
        suggestions={$autocompleteState.suggestions}
        position={$autocompleteState.position}
        onSelect={$autocompleteState.onSelect}
        activeIndex={$autocompleteState.activeIndex}
      />
    {/if}

    <main class="application-shell">
      {#if libraryStatus?.status !== 'ready'}
        <div class="setup-content"><SetupScreen onStatusUpdate={refreshLibraryStatus} /></div>
      {:else}
        <AppSidebar
          bind:this={appSidebarComponent}
          {isWaitingForScan}
          {isScanning}
          {librarySearchVisible}
          on:refresh={handleRefresh}
          on:openSettings={() => { librarySearchOpen = false; navStore.navigateToSettings() }}
          on:home={() => { librarySearchOpen = false; navStore.navigateToHome() }}
          on:back={goBack}
          on:librarySearch={openSearch}
          on:openLayoutSelector={openLayoutSelector}
          on:showContextMenu={(e) => handleShowContextMenu(e.detail.item, e.detail.event, e.detail.options)}
          on:detailSearchItemClick={(e) => handleItemClick(e.detail.item, 'detail')}
          {settings}
          suggestions={allAutocompleteSuggestions}
        />

        <div class="application-content">
          <ViewManager
            bind:this={viewManager}
            {librarySearchOpen}
            {closeLibrarySearch}
            {libraryStatus}
            bind:settings
            suggestions={allAutocompleteSuggestions}
            on:itemClick={(e) => handleItemClick(e.detail.item)}
            on:play={(e) => handlePlayFile(e.detail.item)}
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
        </div>
      {/if}
    </main>

    {#if playback && webPlayer}
      {#key playback}
        {#await webPlayer}
          <div class="loading-screen" role="status" aria-label="Opening player"><div class="busy-wheel"></div></div>
        {:then { default: WebPlayer }}
          <WebPlayer item={playback.item} {settings} initialQuality={playback.quality} initialInfo={playback.info} onClose={closeWebPlayer} />
        {:catch}
          <Dialog
            title="Player could not open"
            message="Reload the page to load the latest player."
            buttons={[{ label: 'Close', value: 'close' }]}
            onClose={() => { closeWebPlayer(); webPlayer = undefined }}
          />
        {/await}
      {/key}
    {/if}
  </QueryClientProvider>
{/if}

<svelte:window
  onpopstate={() => { librarySearchOpen = false; appSidebarComponent?.blurSearchInput() }}
  ondragstart={(e) => {
    if ((e.target as HTMLElement).tagName === 'IMG') {
      e.preventDefault()
    }
  }}
/>

<style>
  .application-shell {
    --sidebar-width: 72px;
    /* Set relative, 0px, and 0px to return to an inset rail. */
    --rail-position: absolute;
    --content-inset: var(--sidebar-width);
    --rail-fade-overhang: 22px;
    position: relative;
    display: flex;
    isolation: isolate;
    width: 100%;
    height: 100dvh;
    overflow: hidden;
    background: var(--color-background);
  }

  .setup-content { flex: 1; min-width: 0; min-height: 0; overflow: auto; }

  .application-content {
    position: relative;
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    isolation: isolate;
  }

  .application-shell:has(:global(.modal-backdrop)) .application-content {
    z-index: 51;
  }

  @media (max-width: 600px) {
    .application-shell { --sidebar-width: 56px; }
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

</style>
