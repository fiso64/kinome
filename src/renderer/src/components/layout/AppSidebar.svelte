<script lang="ts">
  import { authStore } from '@lib/auth-store.svelte'
  import WindowControls from './WindowControls.svelte'
  import SearchInput from '../ui/SearchInput.svelte'
  import MediaView from './MediaView.svelte'
  import Skeleton from '@components/ui/Skeleton.svelte'
  import { createEventDispatcher, tick } from 'svelte'
  import Icon from '@components/ui/Icon.svelte'
  import { navStore } from '@lib/navigation-store.svelte'
  import { searchStore } from '@lib/search-store.svelte'
  import { api } from '@lib/api'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import { DETAIL_HEADER_FIELDS } from '@lib/view-requirements'
  import type {
    Settings,
    MediaFolder,
    LibraryItem,
    SearchIndexEntry,
    AutocompleteSuggestions
  } from '@shared/types'

  let {
    isWaitingForScan,
    isScanning,
    settings,
    librarySearchVisible,
    suggestions
  }: {
    isWaitingForScan: boolean
    isScanning: boolean
    settings: Settings | null
    librarySearchVisible: boolean
    suggestions: AutocompleteSuggestions
  } = $props()

  // Fetch Context Item for Configuration (Folder or Detail Item)
  // Use the same fields as ItemDetail when in detail view so both queries share the same
  // Tanstack Query cache key and only one HTTP request is sent.
  // In folder view, use no fields to match MainView's cache key.
  const contextItemQuery = libraryDataService.getItemDetailsQuery(() => navStore.contextItemId, {
    fields: () => (navStore.isDetailViewActive ? [...DETAIL_HEADER_FIELDS] : []),
    include: () => ['viewHierarchy']
  })

  const contextItem = $derived(contextItemQuery.data as MediaFolder | LibraryItem | undefined)
  const scanInProgress = $derived(isWaitingForScan || isScanning)

  // Search properties from store
  const isPerformingDetailSearch = $derived(searchStore.isPerformingDetailSearch)
  const detailSearchResults = $derived(searchStore.detailResults)

  const dispatch = createEventDispatcher<{
    refresh: void
    openSettings: void
    openLayoutSelector: void
    showContextMenu: { item: LibraryItem; event: MouseEvent; options?: { showLogout?: boolean } }
    librarySearch: void
    home: void
    back: void
    detailSearchItemClick: { item: SearchIndexEntry }
  }>()

  let searchInputEl = $state<HTMLInputElement>()
  let searchButton = $state<HTMLButtonElement>()
  let searchPanel = $state<HTMLElement>()
  let searchOpen = $state(false)

  function dismissOutsideSearch(event: MouseEvent) {
    const target = event.target
    if (searchOpen && target instanceof Element && !searchPanel?.contains(target) &&
      !searchButton?.contains(target) && !target.closest('.autocomplete-menu, .context-menu')) {
      blurSearchInput()
    }
  }

  export async function focusSearchInput() {
    if (!navStore.isDetailViewActive || navStore.isSettingsActive) return
    searchOpen = true
    await tick()
    searchInputEl?.focus()
    searchInputEl?.select()
  }

  export function blurSearchInput() {
    searchInputEl?.blur()
    searchOpen = false
  }

  export function focusSearchTrigger() {
    searchButton?.focus()
  }

  export function closeTitleSearch() {
    if (!searchOpen) return false
    blurSearchInput()
    focusSearchTrigger()
    return true
  }

  const searchPopupParentItem = $derived(
    settings
      ? ({
          id: 'search-popup-view',
          name: 'Search Popup',
          type: 'folder',
          path: '',
          children: [],
          viewSettings: settings.searchPopupView // Correctly nest under viewSettings
        } as MediaFolder)
      : undefined
  )
</script>


<svelte:window onclick={dismissOutsideSearch} />

<aside class="sidebar">
  <div class="rail-top">
    <button class="brand" type="button" aria-label="Kinome home" title="Kinome home" onclick={() => {
      blurSearchInput()
      dispatch('home')
    }}>
      <Icon name="brand" size={25} />
    </button>
  </div>

  <nav class="rail-nav" aria-label="Main navigation">
    <button class="rail-button" type="button" title="Home" aria-label="Home"
      aria-current={navStore.isHomeLocation && !librarySearchVisible ? 'page' : undefined}
      onclick={() => { blurSearchInput(); dispatch('home') }}>
      <Icon name="home" />
    </button>
    {#if !navStore.isSettingsActive}
      <div class="search-anchor">
        <button type="button" class="rail-button" bind:this={searchButton}
          aria-label="Search"
          aria-expanded={navStore.isDetailViewActive ? searchOpen : undefined}
          aria-current={librarySearchVisible && !navStore.isDetailViewActive ? 'page' : undefined}
          aria-controls={searchOpen ? 'sidebar-search' : librarySearchVisible ? 'library-search' : undefined}
          title="Search" onclick={() => {
            if (!navStore.isDetailViewActive) dispatch('librarySearch')
            else if (searchOpen) closeTitleSearch()
            else void focusSearchInput()
          }}>
          <Icon name="search" />
        </button>

        {#if searchOpen && navStore.isDetailViewActive}
          <section id="sidebar-search" class="search-panel glass-surface" aria-label="Search this title"
            tabindex="-1"
            bind:this={searchPanel}
            onkeydown={(event) => searchStore.handleResultKeys(event, 'title', searchInputEl, (item) => dispatch('detailSearchItemClick', { item }))}>
            <SearchInput label="Search this folder" bind:query={searchStore.detailQuery} {suggestions} bind:element={searchInputEl} />
            <button class="icon-button" type="button" aria-label="Close title search" title="Close"
              onclick={closeTitleSearch}><Icon name="close" size={19} /></button>
            <div class="search-results">
                {#if isPerformingDetailSearch && detailSearchResults.length === 0}
                  {#each [60, 80, 52] as width}
                    <div class="skeleton-row">
                      <Skeleton width="36px" height="49px" radius="7px" />
                      <Skeleton width={width + '%'} height="1rem" />
                    </div>
                  {/each}
                {:else if detailSearchResults.length > 0}
                  <MediaView items={detailSearchResults} parentItem={searchPopupParentItem}
                    onItemClick={(item) => dispatch('detailSearchItemClick', { item: item as SearchIndexEntry })}
                    onShowContextMenu={(item, event) => dispatch('showContextMenu', { item: item as LibraryItem, event })}
                    highlightedIndex={searchStore.highlightedDetailIndex} {settings} listFixedAspectRatio />
                {:else if searchStore.detailSearchError}
                  <p class="search-status" role="status">Could not load results. Edit the search to try again.</p>
                {:else if searchStore.isDetailActive}
                  <p class="search-status">No results found.</p>
                {/if}
            </div>
          </section>
        {/if}
      </div>
    {/if}
    {#if navStore.canGoBack || librarySearchVisible}
      <button class="rail-button" type="button" aria-label="Back" title="Back"
        onclick={() => { blurSearchInput(); dispatch('back') }}>
        <Icon name="back" />
      </button>
    {/if}
  </nav>

  <div class="rail-bottom">
    {#if !navStore.isSettingsActive}
      <div class="rail-tools" aria-label="Library tools">
        <button type="button" class="icon-button" onclick={() => dispatch('refresh')}
          {...authStore.control('triggerLibraryScan', 'Refresh library (Shift+R)')}
          disabled={!authStore.can.triggerLibraryScan || scanInProgress}
          aria-busy={scanInProgress}
          aria-label={scanInProgress ? 'Refreshing library' : 'Refresh library'}>
          <span class:reloading={scanInProgress}><Icon name="refresh" size={18} /></span>
        </button>
        {#if contextItem}
          {#if authStore.can.editMetadata}
            <button type="button" class="icon-button" onclick={() => dispatch('openLayoutSelector')}
              title="Set view layout" aria-label="Set view layout">
              <Icon name="grid" size={18} />
            </button>
          {/if}
          <button type="button" class="icon-button"
            onclick={(event) => dispatch('showContextMenu', { item: contextItem, event, options: { showLogout: true } })}
            title="More options" aria-label="More options">
            <Icon name="more" />
          </button>
        {/if}
      </div>
    {/if}
    <button type="button" class="rail-button" title="Settings" aria-label="Settings"
      aria-current={navStore.isSettingsActive ? 'page' : undefined}
      onclick={() => { blurSearchInput(); dispatch('openSettings') }}>
      <Icon name="settings" />
    </button>
    {#if api.capabilities.hasWindowControls}<WindowControls />{/if}
  </div>
</aside>

<style>
  .sidebar {
    position: var(--rail-position, relative);
    inset: 0 auto 0 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    flex: 0 0 var(--sidebar-width);
    width: var(--sidebar-width);
    min-height: 0;
    gap: 1rem;
    padding: .75rem .5rem;
  }
  .sidebar::before {
    content: '';
    position: absolute;
    inset: 0 calc(-1 * var(--rail-fade-overhang, 0px)) 0 0;
    z-index: -1;
    background: var(--rail-surface);
    pointer-events: none;
  }
  .rail-top { display: grid; place-items: center; -webkit-app-region: drag; }
  .brand {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    color: var(--color-primary-soft);
    border: 1px solid #efbd8f3d;
    border-radius: 12px;
    background: linear-gradient(145deg, #efbd8f1c, #efbd8f04);
    box-shadow: var(--edge-light), 0 5px 14px #0004;
  }
  .rail-nav, .rail-bottom, .rail-tools { display: grid; gap: .3rem; }
  .rail-bottom { margin-top: auto; }
  .rail-tools { justify-items: center; padding-bottom: .45rem; margin-bottom: .1rem; }
  .rail-button {
    width: 100%;
    min-height: 51px;
    display: grid;
    place-items: center;
    padding: .3rem 0;
    border: 1px solid transparent;
    border-radius: 11px;
    color: var(--color-text-soft);
    background: transparent;
    box-shadow: none;
  }
  .rail-button:is([aria-current="page"], [aria-expanded="true"]) {
    color: var(--color-primary-soft);
    border-color: #efbd8f28;
    background: linear-gradient(145deg, #efbd8f22, #efbd8f09);
    box-shadow: var(--edge-light);
  }
  .search-anchor { position: relative; }
  .search-panel {
    position: absolute;
    z-index: 5;
    top: 0;
    inset-inline-start: calc(100% + .9rem);
    width: min(36rem, calc(100dvw - var(--sidebar-width) - 1.1rem));
    padding: .7rem;
  }
  .search-panel { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: .45rem; }
  .search-results { grid-column: 1 / -1; }
  .search-results { max-height: min(32rem, calc(100dvh - 16rem)); overflow: auto; }
  .search-status { padding: 1.1rem .4rem .45rem; color: var(--color-text-soft); font-size: .85rem; }
  .skeleton-row { display: flex; align-items: center; gap: .65rem; padding: .5rem .25rem; }
  .reloading { display: flex; animation: rotate .9s linear infinite; }
  @keyframes rotate { to { transform: rotate(360deg); } }
  @media (max-width: 600px) {
    .sidebar { padding: .65rem .3rem; gap: .75rem; }
    .brand { width: 36px; height: 36px; }
    .rail-button { min-height: 46px; }
    .search-panel { inset-inline-start: calc(100% + .6rem); }
  }
  @media (prefers-reduced-motion: reduce) { .reloading { animation: none; } }
</style>
