<script lang="ts">
  import MediaView from './MediaView.svelte'
  import HomeView from './HomeView.svelte'
  import { createEventDispatcher, untrack } from 'svelte'
  import { fade } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { navStore } from '@lib/navigation-store.svelte'
  import { api } from '@lib/api'

  import { resolveViewSettings } from '@shared/settings-helpers'
  import { getAllRequiredFields } from '@lib/view-requirements'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import { authStore } from '@lib/auth-store.svelte'
  import { scrollPersistence } from '@lib/scroll-persistence.svelte'
  import { getViewKey } from '@lib/view-state-store.svelte'
  import { getAssetUrl } from '@lib/api'
  import ViewContextProvider from './ViewContextProvider.svelte'
  import { contextMenuStore } from '@lib/context-menu-store.svelte'

  import type {
    Settings,
    LibraryItem,
    MediaFolder,
    MediaFile,
    SearchIndexEntry,
    LibraryStatus
  } from '@shared/types'

  let {
    settings,
    isScanning,
    libraryStatus,
    suggestions,
    onStatusUpdate,
    disabled = false,
    hasBackdrop = false,
    onScroll
  }: {
    settings: Settings | null
    isScanning: boolean
    libraryStatus: LibraryStatus | null
    suggestions: any
    onStatusUpdate?: () => void
    disabled?: boolean
    hasBackdrop?: boolean
    onScroll?: (top: number) => void
  } = $props()

  const dispatch = createEventDispatcher<{
    scanLibrary: void
    openLibrary: void
    itemClick: { item: LibraryItem | SearchIndexEntry }
    play: { item: LibraryItem }
    dismissContinueWatching: { showId: string }
    showContextMenu: {
      item: LibraryItem | SearchIndexEntry
      event: MouseEvent
      options?: { layout?: string }
    }
    searchByTag: { key: string; value: string }
  }>()

  // --- V2 State ---
  const currentFolderId = $derived(navStore.state.currentFolderId)

  const currentFolderQuery = libraryDataService.getItemDetailsQuery(() => currentFolderId, {
    enabled: () => libraryStatus?.status === 'ready',
    include: () => ['viewHierarchy']
  })
  const currentFolder = $derived(currentFolderQuery.data as (LibraryItem & MediaFolder) | undefined)

  const resolvedSettings = $derived(resolveViewSettings(currentFolder, settings).settings)
  const requiredFields = $derived.by(() => getAllRequiredFields(currentFolder?.viewHierarchy))

  const childrenQuery = libraryDataService.getChildrenQuery(() => currentFolderId, {
    fields: () => requiredFields,
    enabled: () => libraryStatus?.status === 'ready' && currentFolder?.viewHierarchy != null
  })
  const children = $derived((childrenQuery.data as LibraryItem[]) ?? [])

  const continueWatchingQuery = libraryDataService.getContinueWatchingQuery({
    enabled: () =>
      !!settings?.showContinueWatching &&
      !!authStore.isAuthenticated &&
      libraryStatus?.status === 'ready'
  })
  const continueWatchingItems = $derived(continueWatchingQuery.data ?? [])

  const isHome = $derived(currentFolderId === 'home' || currentFolder?.id === 'virtual-home')
  const latestBackdrop = $derived(
    isHome && settings?.showContinueWatching ? continueWatchingItems[0]?.show?.backdropPath : null
  )
  function handleScroll(e: Event) {
    const target = e.target as HTMLElement
    onScroll?.(target.scrollTop)
  }
</script>

{#if currentFolder}
  <div
    class="view-wrapper"
    class:has-backdrop={hasBackdrop}
    onscroll={handleScroll}
    oncontextmenu={(e) => {
      // Catch any right-click that bubbles up from an unhandled area
      // (padding, section titles, CW background, gaps between grid items, etc.).
      // Item-level handlers call stopPropagation(), so this only fires for
      // genuine "empty space" clicks — show the current folder's menu.
      if (currentFolder) {
        contextMenuStore.openForBackground(currentFolder, e)
      } else {
        e.preventDefault()
      }
    }}
    use:scrollPersistence={{
      key: getViewKey('vertical'),
      disabled
    }}
  >
    {#key currentFolder.id}
      <div class="view-transition-inner">
        <ViewContextProvider id={currentFolder.id}>
          {#if isHome}
            <HomeView
              {continueWatchingItems}
              parentItem={currentFolder}
              items={children}
              onItemClick={(item) => dispatch('itemClick', { item })}
              onShowContextMenu={(item, event, options) =>
                dispatch('showContextMenu', { item, event, options })}
              on:dismissContinueWatching={(e) =>
                dispatch('dismissContinueWatching', { showId: e.detail.showId })}
              {suggestions}
              {settings}
              on:scanLibrary={() => dispatch('scanLibrary')}
              on:openLibrary={() => dispatch('openLibrary')}
            />
          {:else}
            <div class="folder-content-wrapper">
              <h2 class="folder-header-title">{currentFolder.title ?? currentFolder.name}</h2>
              <MediaView
                parentItem={currentFolder}
                items={children}
                onItemClick={(item) => dispatch('itemClick', { item })}
                onShowContextMenu={(item, e, options) =>
                  dispatch('showContextMenu', { item, event: e, options })}
                {suggestions}
                {settings}
                viewNode={currentFolder.viewHierarchy}
              />
            </div>
          {/if}
        </ViewContextProvider>
      </div>
    {/key}
  </div>
{/if}

<style>
  .view-wrapper {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-gutter: stable;
    background-color: var(--color-background);
  }

  .view-wrapper.has-backdrop {
    background-color: transparent;
  }

  .view-transition-inner {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  .folder-content-wrapper {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
    padding-top: 1.5rem;
    width: 100%;
    max-width: 1800px;
    margin: 0 auto;
    padding-left: 2.5rem;
    padding-right: 2.5rem;
    padding-bottom: 4rem;
  }

  .folder-header-title {
    width: 100%;
    max-width: 1800px;
    margin: 0 auto;
    font-size: 1.8rem;
    font-weight: bold;
    padding: 0 2.5rem;
    margin-bottom: 1rem;
    flex-shrink: 0;
  }
</style>
