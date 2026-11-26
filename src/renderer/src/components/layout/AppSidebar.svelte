<script lang="ts">
  import type { ContextMenuOptions } from '@lib/context-menu-store.svelte'
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
  import { itemCapabilities } from '@shared/item-capabilities'
  import { isPhoneLayout } from '@lib/view-helpers'
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
    showContextMenu: { item: LibraryItem; event: MouseEvent; options?: ContextMenuOptions }
    librarySearch: void
    expandSearch: void
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

  // On phones, the bar slides away while content scrolls down and returns when it scrolls up.
  let barHidden = $state(false)
  $effect(() => {
    const positions = new WeakMap<Element, number>()
    const track = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element) || !isPhoneLayout()) return
      const top = target.scrollTop
      const previous = positions.get(target) ?? 0
      positions.set(target, top)
      // Horizontal lists scroll without changing scrollTop.
      if (top !== previous) barHidden = top > previous && top > 48
    }
    window.addEventListener('scroll', track, { capture: true, passive: true })
    return () => window.removeEventListener('scroll', track, { capture: true })
  })
  $effect(() => {
    void [navStore.currentFolderId, navStore.selectedItemId, navStore.isSettingsActive, librarySearchVisible]
    barHidden = false
  })

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

<aside class="sidebar" class:bar-hidden={barHidden} class:in-settings={navStore.isSettingsActive}>
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
    <div class="search-anchor">
      <button type="button" class="rail-button" bind:this={searchButton}
        aria-label="Search"
        aria-expanded={navStore.isDetailViewActive ? searchOpen : undefined}
        aria-current={librarySearchVisible && !navStore.isDetailViewActive ? 'page' : undefined}
        aria-controls={searchOpen ? 'sidebar-search' : librarySearchVisible ? 'library-search' : undefined}
        title="Search" onclick={() => {
          if (!navStore.isDetailViewActive || navStore.isSettingsActive || isPhoneLayout()) dispatch('librarySearch')
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
          <header class="search-bar">
            <span class="search-bar-icon"><Icon name="search" size={18} /></span>
            <SearchInput label="Search this folder" bind:query={searchStore.detailQuery} {suggestions} bind:element={searchInputEl} />
            <button class="icon-button" type="button" data-action="expand-search"
              aria-label="Open in full search" title="Open in full search"
              onclick={() => dispatch('expandSearch')}><Icon name="expand" size={17} /></button>
            <button class="icon-button" type="button" aria-label="Close title search" title="Close"
              onclick={closeTitleSearch}><Icon name="close" size={18} /></button>
          </header>
          {#if searchStore.isDetailActive}
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
              {:else}
                <p class="search-status">No results found.</p>
              {/if}
            </div>
            {#if detailSearchResults.length > 0}
              <footer class="search-hints keyboard-only" aria-hidden="true">
                <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
                <span><kbd>Enter</kbd> Open</span>
                <span><kbd>Esc</kbd> Close</span>
              </footer>
            {/if}
          {/if}
        </section>
      {/if}
    </div>
    {#if navStore.canGoBack || librarySearchVisible}
      <button class="rail-button back-button" type="button" aria-label="Back" title="Back"
        class:beside-search={librarySearchVisible}
        onclick={() => { blurSearchInput(); dispatch('back') }}>
        <Icon name="back" />
      </button>
    {/if}
  </nav>

  <div class="rail-bottom">
    <div class="rail-tools" aria-label="Library tools">
      <button type="button" class="icon-button desktop-tool" onclick={() => dispatch('refresh')}
        {...authStore.control('triggerLibraryScan', 'Refresh library (Shift+R)')}
        disabled={!authStore.can.triggerLibraryScan || scanInProgress}
        aria-busy={scanInProgress}
        aria-label={scanInProgress ? 'Refreshing library' : 'Refresh library'}>
        <span class:reloading={scanInProgress}><Icon name="refresh" size={18} /></span>
      </button>
      {#if contextItem}
        {#if !navStore.isSettingsActive && authStore.can.editMetadata && itemCapabilities(contextItem).canEditView}
          <button type="button" class="icon-button desktop-tool" onclick={() => dispatch('openLayoutSelector')}
            title="Set view layout" aria-label="Set view layout">
            <Icon name="grid" size={18} />
          </button>
        {/if}
        <button type="button" class="icon-button"
          onclick={(event) => dispatch('showContextMenu', { item: contextItem, event, options: navStore.isSettingsActive ? { appOnly: true } : { showLogout: true } })}
          title="Menu" aria-label="Menu">
          <Icon name="menu" />
        </button>
      {/if}
    </div>
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
    padding: max(.75rem, env(safe-area-inset-top)) .5rem .75rem calc(.5rem + env(safe-area-inset-left));
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
    display: flex;
    flex-direction: column;
    width: min(33rem, calc(100dvw - var(--sidebar-width) - 1.1rem));
    max-height: min(36rem, calc(100dvh - 9rem));
    overflow: hidden;
    box-shadow: var(--edge-light), var(--shadow-window);
  }
  /* The panel frames the field, so the field itself is bare. */
  .search-bar { display: flex; align-items: center; gap: .15rem; padding: .35rem .45rem .35rem .85rem; }
  .search-bar-icon { display: grid; flex: none; color: var(--color-text-dim); }
  .search-bar :global(.search-input-wrapper) { flex: 1; min-width: 0; }
  .search-bar :global(.chip-field) { background: transparent; border-color: transparent; box-shadow: none; }
  .search-results {
    --collection-row-background: transparent;
    --collection-row-border: transparent;
    --collection-row-shadow: none;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: .35rem;
    border-top: 1px solid var(--color-border-soft);
    scrollbar-width: thin;
    scrollbar-color: var(--color-border) transparent;
  }
  .search-results :global(.media-list) { gap: .1rem; padding: 0; }
  .search-status { padding: 1.1rem .6rem; color: var(--color-text-soft); font-size: .85rem; }
  .skeleton-row { display: flex; align-items: center; gap: .65rem; padding: .5rem .45rem; }
  .search-hints {
    display: flex;
    gap: 1.1rem;
    padding: .45rem .85rem;
    border-top: 1px solid var(--color-border-soft);
    color: var(--color-text-dim);
    font-size: .74rem;
  }
  .search-hints kbd {
    display: inline-block;
    min-width: 1.25rem;
    margin-inline-end: .2rem;
    padding: 0 .3rem;
    border: 1px solid var(--color-border);
    border-radius: 5px;
    color: var(--color-text-soft);
    font: inherit;
    text-align: center;
  }
  .rail-tools .icon-button > span { display: flex; }
  .reloading { animation: rotate .9s linear infinite; }
  @keyframes rotate { to { transform: rotate(360deg); } }
  /* Short screens, such as phones held sideways, keep the rail without the brand. */
  @media (max-height: 500px) {
    .sidebar { padding-block: .4rem; gap: .3rem; }
    .rail-top { display: none; }
    .rail-button { min-height: 40px; }
    .rail-nav, .rail-bottom, .rail-tools { gap: 0; }
    .rail-tools { padding-bottom: 0; }
  }
  /* Phones get a floating navigation bar along the bottom of the screen and a round back button
     in the top left corner. Rescanning and the view layout are in the More menu. */
  @media (max-width: 600px) {
    .sidebar {
      position: fixed;
      inset: auto .75rem calc(.6rem + env(safe-area-inset-bottom));
      width: auto;
      height: 3.4rem;
      flex-direction: row;
      align-items: stretch;
      justify-content: space-around;
      gap: 0;
      padding: .3rem;
      transition: bottom .22s ease;
    }
    /* Settings is a page of its own on phones, left with the back button. */
    .sidebar:is(.bar-hidden, .in-settings) { bottom: -4.5rem; }
    /* The keyboard needs the room while a text field is focused. */
    :global(body:has(:is(input:not([type='checkbox'], [type='radio'], [type='range']), textarea):focus)) .sidebar { display: none; }
    .sidebar::before {
      inset: 0;
      background: var(--surface-glass);
      border: 1px solid var(--color-border);
      border-radius: 1.7rem;
      box-shadow: var(--edge-light), var(--shadow-standard);
      backdrop-filter: blur(18px);
    }
    .rail-top, .desktop-tool { display: none; }
    .rail-nav, .rail-bottom, .rail-tools, .search-anchor { display: contents; }
    .rail-button, .rail-tools .icon-button {
      flex: 1;
      width: auto;
      max-width: 5rem;
      height: auto;
      min-height: 0;
      border-radius: 1.4rem;
    }
    .rail-button.back-button {
      position: fixed;
      top: calc(.75rem + env(safe-area-inset-top));
      left: calc(.75rem + env(safe-area-inset-left));
      width: 2.75rem;
      height: 2.75rem;
      border: 1px solid var(--color-border);
      border-radius: 50%;
      color: var(--color-text);
      background: var(--surface-glass);
      box-shadow: var(--edge-light), var(--shadow-standard);
      backdrop-filter: blur(18px);
      transition: top .22s ease;
    }
    .bar-hidden .back-button { top: -3.5rem; }
    /* The library search has its own close button there. */
    .back-button.beside-search { display: none; }
    .search-panel {
      position: fixed;
      inset: auto .5rem calc(var(--bottom-bar-height) + .5rem);
      width: auto;
      max-height: calc(100dvh - var(--bottom-bar-height) - 1rem);
    }
  }
  @media (max-width: 600px) and (prefers-reduced-motion: reduce) {
    .sidebar, .rail-button.back-button { transition: none; }
  }
  @media (prefers-reduced-motion: reduce) { .reloading { animation: none; } }
</style>
