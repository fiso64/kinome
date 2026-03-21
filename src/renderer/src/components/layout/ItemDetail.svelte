<script lang="ts">
  import MediaView from './MediaView.svelte'
  import CreditsView from './CreditsView.svelte'

  import ContinueWatchingItem from './ContinueWatchingItem.svelte'
  import { slide, fade, fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { getAssetUrl } from '@lib/api'

  let {
    item: initialItem,
    onItemClick,
    onPlay,
    showContextMenu,
    onSearchByTag,
    settings
  }: {
    item: LibraryItem
    onItemClick: (item: LibraryItem) => void
    onPlay: (item: LibraryItem) => void
    showContextMenu: (item: LibraryItem, event: MouseEvent, options?: { layout?: string }) => void
    onSearchByTag: (key: string, value: string) => void
    settings: Settings
  } = $props()

  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import { resolveViewSettings } from '@shared/settings-helpers'
  import { getAllRequiredFields, DETAIL_HEADER_FIELDS } from '@lib/view-requirements'
  import { scrollPersistence } from '@lib/scroll-persistence.svelte'
  import { getViewKey } from '@lib/view-state-store.svelte'
  import ViewContextProvider from './ViewContextProvider.svelte'
  import { CONTAINER_LAYOUTS } from '@shared/types'
  import type { LibraryItem, MediaFile, MediaFolder, Settings } from '@shared/types'

  // -- 1. Local Component State (Moved up for query dependencies) --

  let activeInfoTab = $state<'overview' | 'credits'>('overview')
  let isCreditsExpanded = $state(settings?.creditsDisplay === 'shown')
  let lastSeenItemId = $state(initialItem.id)
  let overviewContainerElement = $state<HTMLDivElement>()
  let isOverviewExpanded = $state(false)
  let isOverviewOverflowing = $state(false)
  let isBackdropLoaded = $state(false)
  let isLogoLoaded = $state(false)
  let isUserToggling = $state(false)
  let isPosterLoaded = $state(false)

  // References for safety checks
  let backdropImg = $state<HTMLImageElement>()
  let logoImg = $state<HTMLImageElement>()
  let posterImg = $state<HTMLImageElement>()

  // Tracking the "last" paths to avoid redundant resets
  let lastBackdrop = $state<string | undefined>()
  let lastLogo = $state<string | undefined>()
  let lastPoster = $state<string | undefined>()

  // Timing for adaptive fades
  let backdropStartTime = $state(performance.now())
  let backdropFadeDuration = $state(400)

  // -- 2. Reactive Data Fetching (Lean Bundling) --

  // Resolve layout and required fields for the current item
  const resolvedSettings = $derived(
    settings ? resolveViewSettings(initialItem as MediaFolder, settings).settings : null
  )

  // 1. Fetch metadata only (Fast, no large blobs) + Request View Settings Side-Channel
  $effect(() => {
    console.log('[DEBUG] DETAIL_HEADER_FIELDS:', DETAIL_HEADER_FIELDS)
  })
  const itemQuery = libraryDataService.getItemDetailsQuery(() => initialItem.id, {
    fields: () => DETAIL_HEADER_FIELDS,
    include: () => ['viewHierarchy']
  })

  // 1a. Fetch Credits lazily (Before item derivation)
  const creditsQuery = libraryDataService.getCreditsQuery(() => initialItem.id, {
    enabled: () => activeInfoTab === 'credits' || isCreditsExpanded
  })

  // The authoritative reactive item for metadata (header, background)
  // We merge lazy credits into this object so the UI can simple access item.tmdbCredits
  const item = $derived({
    ...(itemQuery.data || initialItem),
    tmdbCredits: creditsQuery.data ?? (itemQuery.data || initialItem).tmdbCredits
  })

  // 1. Reset states ONLY if the path actually changed
  $effect.pre(() => {
    if (item.backdropPath !== lastBackdrop) {
      lastBackdrop = item.backdropPath
      isBackdropLoaded = false
      backdropStartTime = performance.now()
    }
    if (item.logoPath !== lastLogo) {
      lastLogo = item.logoPath
      isLogoLoaded = false
    }
    if (item.posterPath !== lastPoster) {
      lastPoster = item.posterPath
      isPosterLoaded = false
    }
  })

  // 2. Safety check: If images are already in cache/complete, show them
  $effect(() => {
    // Add paths as dependencies for the safety check too
    item.backdropPath
    item.logoPath
    item.posterPath

    if (backdropImg?.complete && backdropImg.src && !isBackdropLoaded) {
      backdropFadeDuration = 300 // Snappy for ultra-fast cache
      isBackdropLoaded = true
    }
    if (logoImg?.complete && logoImg.src) isLogoLoaded = true
    if (posterImg?.complete && posterImg.src) isPosterLoaded = true
  })

  // Resolve required fields from the View Hierarchy Side-Channel
  const requiredFields = $derived(getAllRequiredFields(item.viewHierarchy))

  // 2. Fetch structural children separately with isDetailView: true
  // This allows the children endpoint to handle structural bundling (Season -> Episode)
  const childrenQuery = libraryDataService.getChildrenQuery(() => initialItem.id, {
    fields: () => requiredFields,
    isDetailView: () => true,
    enabled: () => initialItem.type === 'folder'
  })

  // Structural children for the content list/tabs
  const children = $derived(
    childrenQuery.data || (initialItem.type === 'folder' ? initialItem.children || [] : [])
  )

  // -- 3. Derived Template Properties --

  const displayTitle = $derived(
    item.mediaType === 'episode' && 'episodeNumber' in item && item.episodeNumber != null
      ? `${item.episodeNumber}. ${item.title ?? item.name}`
      : (item.title ?? item.name)
  )

  const showOverviewTab = $derived(!!item.overview)
  // Ensure we show the tab if we HAVE credits OR if we can fetch them (has tmdbId)
  const showCreditsSection = $derived(
    (item.tmdbId && !item.tmdbCredits) ||
      (item.tmdbCredits && (item.tmdbCredits.cast.length > 0 || item.tmdbCredits.crew.length > 0))
  )

  const isSpecialFile = $derived(item.type === 'file' && item.opensAsFolder === true)
  const fileAsChild = $derived(
    isSpecialFile ? [{ ...JSON.parse(JSON.stringify(item)), opensAsFolder: false }] : []
  )

  const contentsLayout = $derived(
    item.viewHierarchy?.effective?.layout ?? resolvedSettings?.layout ?? 'grid'
  )
  const showRegularContents = $derived(item.type === 'folder' && children.length > 0)

  // -- 4. Additional Queries --

  let posterColumnElement = $state<HTMLDivElement>()
  let infoColumnElement = $state<HTMLDivElement>()
  let overviewWrapperElement = $state<HTMLDivElement>()
  let overviewParagraphElement = $state<HTMLParagraphElement>()

  const parentQuery = libraryDataService.getParentQuery(() => item.id, {
    enabled: () => item.mediaType === 'season'
  })
  const parentShow = $derived(parentQuery.data)

  const cwQuery = libraryDataService.getContinueWatchingForShowQuery(() => item.id, {
    enabled: () => item.type === 'folder' && item.mediaType === 'tv'
  })
  const continueWatchingInfo = $derived(cwQuery.data)

  // -- 4. Interactive Effects --

  $effect(() => {
    if (item.id !== lastSeenItemId) {
      lastSeenItemId = item.id
      isOverviewExpanded = false
      isOverviewOverflowing = false

      if (overviewWrapperElement) {
        overviewWrapperElement.style.maxHeight = ''
      }
    }
    if (!showOverviewTab && activeInfoTab === 'overview' && item.lastRefreshedAt) {
      activeInfoTab = 'credits'
    }
  })

  $effect(() => {
    // Wait for the lazy-load query to finish before deciding we need to scrape
    if (creditsQuery.isFetching) return

    if (settings?.creditsDisplay === 'tab') {
      if (activeInfoTab === 'credits' && !item.tmdbCredits) {
        window.api.fetchCredits(item.id)
      }
    } else {
      if (isCreditsExpanded && !item.tmdbCredits) {
        window.api.fetchCredits(item.id)
      }
    }
  })

  $effect(() => {
    if (activeInfoTab !== 'credits') return undefined
    const handleClickOutside = (event: MouseEvent) => {
      if (overviewContainerElement && !overviewContainerElement.contains(event.target as Node)) {
        const targetElement = event.target as HTMLElement
        if (targetElement.closest('.modal-window, .context-menu, .dialog-window')) return
        activeInfoTab = 'overview'
      }
    }
    queueMicrotask(() => window.addEventListener('mousedown', handleClickOutside))
    return () => window.removeEventListener('mousedown', handleClickOutside)
  })

  function handleToggleOverview() {
    isUserToggling = true
    isOverviewExpanded = !isOverviewExpanded
    setTimeout(() => {
      isUserToggling = false
    }, 300) // Match transition duration
  }

  $effect(() => {
    const isExpanded = isOverviewExpanded
    const currentTab = activeInfoTab
    const currentSettings = settings

    const posterCol = posterColumnElement
    const infoCol = infoColumnElement
    const overviewWrapper = overviewWrapperElement
    const overviewP = overviewParagraphElement

    if (!item.overview || !posterCol || !infoCol || !overviewWrapper || !overviewP) {
      isOverviewOverflowing = false
      return undefined
    }

    const checkOverflow = () => {
      if (currentSettings?.creditsDisplay === 'tab' && currentTab !== 'overview') {
        isOverviewOverflowing = false
        return
      }

      const posterHeight = posterCol.offsetHeight
      const currentWrapperHeight = overviewWrapper.offsetHeight
      const infoHeight = infoCol.offsetHeight
      const otherContentHeight = infoHeight - currentWrapperHeight

      // Calculate available space for overview to align with poster bottom
      // We ensure a minimum of 0 to avoid negative values
      const availableSpace = Math.max(0, posterHeight - otherContentHeight)
      const fullHeight = overviewWrapper.scrollHeight

      // Check if content significantly exceeds available space
      const isOverflowing = fullHeight > availableSpace + 20
      isOverviewOverflowing = isOverflowing

      const targetHeight = isOverflowing && !isExpanded ? Math.max(60, availableSpace) : fullHeight

      overviewWrapper.style.maxHeight = `${targetHeight}px`
    }

    const observer = new ResizeObserver(checkOverflow)
    observer.observe(posterCol)

    observer.observe(infoCol)
    observer.observe(overviewP)
    // Important: checkOverflow will set initial pixel height
    queueMicrotask(checkOverflow)

    return () => observer.disconnect()
  })

  let previousV = $state<number | undefined>(undefined)

  $effect(() => {
    previousV = item._v
  })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="detail-view"
  class:full-backdrop-mode={settings.itemDetailBackdropSize === 'full'}
  oncontextmenu={(e) => showContextMenu(item, e)}
>
  {#if item.isMissing}
    <div class="missing-banner">
      <span class="icon">⚠️</span>
      <span>File or folder missing from disk.</span>
    </div>
  {/if}
  <ViewContextProvider id={item.id}>
    <div class="scroll-container" use:scrollPersistence={{ key: getViewKey('detail') }}>
      <div class="backdrop-container" class:full-size={settings.itemDetailBackdropSize === 'full'}>
        {#if item.backdropPath}
          <img
            bind:this={backdropImg}
            class="backdrop-image"
            class:show={isBackdropLoaded}
            src={getAssetUrl(item.backdropPath + (item._v ? `?v=${item._v}` : ''))}
            alt=""
            onload={async (e) => {
              const img = e.currentTarget as HTMLImageElement
              try {
                await img.decode() // Ensure GPU is ready before showing
                const loadTime = performance.now() - backdropStartTime
                backdropFadeDuration = loadTime > 150 ? 1000 : 300
                isBackdropLoaded = true
              } catch (err) {
                isBackdropLoaded = true
              }
            }}
            onerror={() => {
              backdropFadeDuration = 300
              isBackdropLoaded = true
            }}
            style:--backdrop-blur="{settings.itemDetailBackdropBlur}px"
            style="transition-duration: {backdropFadeDuration}ms"
          />
        {/if}
        <div class="backdrop-overlay"></div>
      </div>

      <div class="fade-shroud"></div>
      <div class="detail-content animate-arrival">
        <div class="info-grid">
          <div class="poster-column" bind:this={posterColumnElement}>
            <div class="poster">
              {#if item.posterPath}
                <div class="poster-container">
                  <img
                    bind:this={posterImg}
                    src={getAssetUrl(item.posterPath + (item._v ? `?v=${item._v}` : ''))}
                    alt="Poster"
                    class:show={isPosterLoaded}
                    onload={() => (isPosterLoaded = true)}
                    onerror={() => (isPosterLoaded = true)}
                  />
                </div>
              {:else}
                <div class="icon">
                  {item.type === 'folder' ? '📁' : '📄'}
                </div>
              {/if}
            </div>
            {#if item.type === 'file' && !item.opensAsFolder}
              <button class="play-button" onclick={() => onPlay(item)}> ▶ Play </button>
            {/if}
          </div>

          <div class="info-column" bind:this={infoColumnElement}>
            <div class="title-and-meta">
              {#if item.mediaType === 'season' && parentShow}
                <button class="parent-show-link" onclick={() => onItemClick(parentShow)}>
                  <span class="breadcrumb-arrow">‹</span>{parentShow.title ?? parentShow.name}
                </button>
              {/if}
              {#if (settings.useLogos ?? true) && item.logoPath}
                <div class="logo-container">
                  <img
                    bind:this={logoImg}
                    src={getAssetUrl(item.logoPath + (item._v ? `?v=${item._v}` : ''))}
                    alt="{item.title ?? item.name} Logo"
                    class="logo-image"
                    class:show={isLogoLoaded}
                    onload={() => (isLogoLoaded = true)}
                    onerror={() => (isLogoLoaded = true)}
                  />
                </div>
              {:else}
                <h1>{displayTitle}</h1>
              {/if}
              <div class="meta">
                {#if item.year}
                  <span class="year">{item.year}</span>
                {/if}
                {#if item.genres && item.genres.length > 0}
                  <div class="genres">
                    {#each item.genres as genre}
                      <button class="genre-tag" onclick={() => onSearchByTag('genre', genre)}>
                        {genre}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
            {#if settings?.creditsDisplay === 'tab'}
              <div class="overview-container" bind:this={overviewContainerElement}>
                {#if showOverviewTab || showCreditsSection}
                  <div class="info-tabs">
                    {#if showOverviewTab}
                      <button
                        class:active={activeInfoTab === 'overview'}
                        onclick={() => (activeInfoTab = 'overview')}
                      >
                        <h2 class="section-title">Overview</h2>
                      </button>
                    {/if}
                    {#if showCreditsSection}
                      <button
                        class:active={activeInfoTab === 'credits'}
                        onclick={() => (activeInfoTab = 'credits')}
                      >
                        <h2 class="section-title">Cast & Crew</h2>
                      </button>
                    {/if}
                  </div>
                {/if}

                <div class="content-holder">
                  <!-- Overview is always present to maintain content height -->
                  <div class="overview-content" class:hidden={activeInfoTab === 'credits'}>
                    {#if item.overview}
                      <div class="overview-expandable-area">
                        <div
                          class="overview-wrapper"
                          bind:this={overviewWrapperElement}
                          class:collapsed={isOverviewOverflowing && !isOverviewExpanded}
                          class:expanded={isOverviewExpanded}
                          style:transition={isUserToggling ? 'max-height 0.25s ease-out' : 'none'}
                        >
                          <p class="overview" bind:this={overviewParagraphElement}>
                            {item.overview}
                          </p>
                        </div>
                        {#if isOverviewOverflowing}
                          <div class="expand-button-wrapper">
                            <button
                              class="expand-overview-btn"
                              onclick={handleToggleOverview}
                              aria-label={isOverviewExpanded ? 'Show Less' : 'Show More'}
                            >
                              <span class="chevron" class:up={isOverviewExpanded}></span>
                            </button>
                          </div>
                        {/if}
                      </div>
                    {/if}
                  </div>

                  <!-- Credits "pop out" on top of the overview area -->
                  {#if activeInfoTab === 'credits' && showCreditsSection}
                    <div class="credits-popout">
                      <div class="tab-content-wrapper">
                        {#if item.tmdbCredits && (item.tmdbCredits.cast.length > 0 || item.tmdbCredits.crew.length > 0)}
                          <CreditsView {item} credits={item.tmdbCredits} {onSearchByTag} />
                        {:else if !item.tmdbCredits}
                          <div class="loading-credits">Loading...</div>
                        {:else}
                          <p class="overview no-overview">No credits available for this item.</p>
                        {/if}
                      </div>
                    </div>
                  {/if}
                </div>
              </div>
            {:else if item.overview}
              <div class="overview-container">
                <h2 class="section-title">Overview</h2>
                <div class="overview-expandable-area">
                  <div
                    class="overview-wrapper"
                    bind:this={overviewWrapperElement}
                    class:collapsed={isOverviewOverflowing && !isOverviewExpanded}
                    class:expanded={isOverviewExpanded}
                    style:transition={isUserToggling ? 'max-height 0.25s ease-out' : 'none'}
                  >
                    <p class="overview" bind:this={overviewParagraphElement}>{item.overview}</p>
                  </div>
                  {#if isOverviewOverflowing}
                    <div class="expand-button-wrapper">
                      <button
                        class="expand-overview-btn"
                        onclick={handleToggleOverview}
                        aria-label={isOverviewExpanded ? 'Show Less' : 'Show More'}
                      >
                        <span class="chevron" class:up={isOverviewExpanded}></span>
                      </button>
                    </div>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        </div>

        {#if settings.showNextUp && continueWatchingInfo}
          <section class="hero-banner-section">
            <h2 class="section-title">Next Up</h2>
            <ContinueWatchingItem
              item={continueWatchingInfo!}
              layout="horizontal"
              on:itemClick={(e) => onItemClick(e.detail.item)}
              on:showContextMenu={(e) => showContextMenu(e.detail.item, e.detail.event)}
              on:dismiss={() => {
                window.api.setNextUpDismissed(continueWatchingInfo!.show.id)
                libraryDataService.handleLibraryUpdates(
                  [{ ...continueWatchingInfo!.show, nextUpDismissed: true }],
                  false
                )
              }}
            />
          </section>
        {/if}

        {#if showRegularContents && item.type === 'folder'}
          <div class="children-section">
            {#if !CONTAINER_LAYOUTS.includes(contentsLayout as any)}
              <h2 class="section-title">Contents</h2>
            {/if}
            <MediaView
              parentItem={item}
              items={children}
              {onItemClick}
              layout={contentsLayout}
              onShowContextMenu={showContextMenu}
              {settings}
              viewNode={item.viewHierarchy}
            />
          </div>
        {/if}

        {#if isSpecialFile}
          <div class="children-section">
            <h2 class="section-title">Contents</h2>
            <MediaView
              parentItem={item as MediaFolder}
              items={fileAsChild}
              {onItemClick}
              layout="tree"
              onShowContextMenu={showContextMenu}
              {settings}
            />
          </div>
        {/if}

        {#if settings?.creditsDisplay !== 'hidden' && settings?.creditsDisplay !== 'tab'}
          {#if showCreditsSection}
            <div class="collapsible-section">
              <button
                class="section-title-button"
                onclick={() => (isCreditsExpanded = !isCreditsExpanded)}
              >
                <h2 class="section-title">Cast & Crew</h2>
                <span class="chevron">{isCreditsExpanded ? '▾' : '▸'}</span>
              </button>
              {#if isCreditsExpanded}
                <div class="collapsible-content" transition:slide|local={{ duration: 200 }}>
                  {#if item.tmdbCredits && (item.tmdbCredits.cast.length > 0 || item.tmdbCredits.crew.length > 0)}
                    <CreditsView {item} credits={item.tmdbCredits} {onSearchByTag} />
                  {:else if !item.tmdbCredits}
                    <div class="loading-credits">Loading...</div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    </div>
  </ViewContextProvider>
</div>

<style>
  .scroll-container {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  .detail-view {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    color: var(--color-text);
    background-color: var(--color-background);
    z-index: 1;
    overflow: hidden; /* Prevent this container from scrolling */
  }

  .backdrop-container {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 50vh;
    max-height: 400px;
    overflow: hidden;
    z-index: 0;
    pointer-events: none;
    transition:
      height 0.3s ease-in-out,
      max-height 0.3s ease-in-out;
  }
  .backdrop-container.full-size {
    position: sticky;
    height: 100vh;
    max-height: none;
    margin-bottom: -100vh;
  }

  .backdrop-image,
  .logo-image {
    /* opacity: 0; removed to fix visibility issue */
    /* transition: opacity 0.4s ease-in-out; removed */
    overflow: hidden;
  }
  /* .backdrop-image.loaded,
  .logo-image.loaded {
    opacity: 1;
  } removed */

  .backdrop-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(var(--backdrop-blur, 4px));
    opacity: 0;
    transition-property: opacity, filter;
    transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  }

  .backdrop-image.show {
    opacity: 1;
  }

  .backdrop-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: linear-gradient(
      to top,
      var(--color-background) 10%,
      rgba(0, 0, 0, 0.6) 60%,
      rgba(0, 0, 0, 0.2) 100%
    );
  }

  .detail-content {
    position: relative;
    z-index: 1;
    padding: 1.5rem;

    padding-top: 10vh;
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 3rem;
    /* Ensure opacity is 1 so Firefox keeps backdrop-filter active */
    opacity: 1;
  }

  .fade-shroud {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: var(--color-background);
    z-index: 5;
    pointer-events: none;
    animation: shroud-fade-out 0.4s ease-out forwards;
  }

  .animate-arrival {
    animation: ui-arrival-padding 0.4s cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }

  @keyframes shroud-fade-out {
    from {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }

  @keyframes ui-arrival-padding {
    from {
      padding-top: calc(10vh + 12px);
    }
    to {
      padding-top: 10vh;
    }
  }

  .info-grid {
    display: grid;
    grid-template-columns: 300px 1fr;
    gap: 2.5rem;
    align-items: start;
    position: relative; /* Create a stacking context */
    z-index: 2; /* Lift this grid above subsequent siblings like .children-section */
  }

  .poster-column {
    top: calc(var(--header-height) + 1.5rem);
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .poster {
    width: 100%;
    flex-shrink: 0;
    aspect-ratio: 2 / 3;
    background-color: var(--color-background-soft);
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: var(--shadow-standard);
    border: 1px solid var(--color-border);
  }

  .poster-container {
    width: 100%;
    height: 100%;
  }

  .poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    opacity: 0;
    transition: opacity 0.4s ease-out;
  }

  .poster img.show {
    opacity: 1;
  }

  .poster .icon {
    font-size: 6rem;
  }

  .info-column {
    display: flex;
    flex-direction: column;
    gap: 2rem;
    min-width: 0; /* Prevent wide content from breaking the grid layout */
  }

  .title-and-meta {
    display: flex;
    flex-direction: column;
    gap: 0.75rem; /* Reduced gap to accommodate parent link */
  }

  .parent-show-link {
    background: none;
    border: none;
    padding: 0;
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--ev-c-text-2);
    cursor: pointer;
    text-align: left;
    transition: color 0.2s ease;
    display: inline-block; /* Make button only as wide as its content */
    align-self: flex-start; /* Prevent it from stretching if parent is flex column */
  }
  .parent-show-link:hover {
    color: var(--ev-c-text-1);
    background: none; /* Explicitly remove background on hover */
    /* text-decoration: underline; removed */
  }
  .breadcrumb-arrow {
    margin-right: 0.4em; /* Space between arrow and text */
    color: var(--ev-c-text-3);
    transition: color 0.2s ease;
    font-weight: normal; /* Make arrow less bold than the link text */
  }
  .parent-show-link:hover .breadcrumb-arrow {
    color: var(--ev-c-text-1); /* Match text color on hover */
  }

  .logo-container {
    max-width: 350px;
  }

  .logo-image {
    max-width: 100%;
    max-height: 202.5px; /* 45% of poster height (300px width * 1.5 aspect ratio * 0.45) */
    object-fit: contain;
    object-position: left bottom;
    filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.7));
    opacity: 0;
    transition: opacity 0.4s ease-out;
  }

  .logo-image.show {
    opacity: 1;
  }

  h1 {
    font-size: 3.5rem;
    font-weight: 800;
    line-height: 1.1;
    letter-spacing: -0.02em;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7);
  }

  .meta,
  .genres {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .genres {
    gap: 0.5rem;
  }

  .year {
    font-size: 1.2rem;
    font-weight: 600;
    color: var(--ev-c-text-2);
  }

  .genre-tag {
    background-color: color-mix(in srgb, var(--color-text) 10%, transparent);
    padding: 0.3rem 0.8rem;
    border-radius: 16px;
    font-size: 0.9rem;
    border: 1px solid transparent;
    color: var(--color-text-soft);
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .genre-tag:hover {
    background-color: color-mix(in srgb, var(--color-text) 20%, transparent);
    color: var(--color-text);
  }

  .play-button {
    width: 100%;
    background-color: var(--color-primary);
    color: white;
    border: none;
    padding: 1rem;
    border-radius: 8px; /* Match poster */
    font-weight: bold;
    cursor: pointer;
    font-size: 1.2rem;
    transition:
      transform 0.2s ease,
      background-color 0.2s ease,
      box-shadow 0.2s ease;
  }
  .play-button:hover {
    background-color: var(--color-primary-soft);
    transform: scale(1.03);
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
  }

  .overview-container {
    display: flex;
    flex-direction: column;
    position: relative; /* Anchor for the popout */
  }

  .overview {
    line-height: 1.7;
    color: var(--ev-c-text-2);
  }

  .hero-banner-section {
    grid-column: 1 / -1;
  }
  .hero-banner-section .section-title {
    margin-left: 0;
    margin-right: 0;
  }
  .children-section {
    grid-column: 1 / -1;
    margin-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .section-title {
    font-size: 1.5rem;
    font-weight: bold;
    /* border-bottom: 1px solid var(--color-background-mute); */
    padding-bottom: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .collapsible-section {
    grid-column: 1 / -1; /* Span full width of the parent grid */
  }

  .section-title-button {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 0;
    display: flex;
    width: 100%;
    justify-content: space-between;
    align-items: center;
  }

  .section-title-button:hover .section-title {
    color: var(--ev-c-white-soft);
  }

  .section-title-button .section-title {
    margin: 0;
    border-bottom: none;
    padding-bottom: 0;
  }

  .section-title-button .chevron {
    font-size: 1.5rem;
    color: var(--ev-c-text-2);
  }

  .collapsible-content {
    overflow: hidden;
    padding-top: 1.5rem;
  }

  .loading-credits {
    color: var(--ev-c-text-2);
  }

  .info-tabs {
    display: flex;
    gap: 1.5rem;
    border-bottom: 1px solid var(--color-background-mute);
    margin-bottom: 0.75rem; /* This creates the gap between tabs and content */
    flex-shrink: 0; /* Prevent tabs from shrinking */
  }

  .info-tabs button {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
    transition: opacity 0.2s ease;
  }

  .info-tabs button:not(.active) {
    opacity: 0.4;
  }

  .info-tabs button:not(.active):hover {
    opacity: 1;
  }

  .info-tabs button .section-title {
    border-bottom: none;
    padding-bottom: 0.5rem;
    margin-bottom: 0;
  }

  .content-holder {
    /* No longer needs to be a positioning context */
    flex-grow: 1;
  }

  .overview-content {
    transition: opacity 0.2s ease-in-out;
  }
  .overview-content.hidden {
    opacity: 0;
    pointer-events: none;
  }

  .credits-popout {
    /* Position relative to the .overview-container */
    position: absolute;
    /* Start right after the tabs */
    top: 87px; /* Height of tabs + gap */
    left: -1rem; /* Align with parent padding */
    right: -1rem; /* Align with parent padding */

    background-color: var(--color-background-soft);
    border: 1px solid var(--color-background-mute);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    padding: 1rem;
    overflow-y: hidden;
    animation: fadeIn 0.2s ease-in-out;
    scrollbar-gutter: stable; /* Prevent scrollbar from causing layout shift */
    z-index: 10; /* Ensure it's on top */
  }

  .tab-content-wrapper {
    padding-top: 0.25rem;
  }

  .no-overview {
    color: var(--ev-c-text-2);
    font-style: italic;
  }

  .missing-banner {
    position: sticky; /* Sticks to the top of the scrollable container */
    top: 0;
    background-color: #c50f1f;
    color: white;
    padding: 0.75rem 1.5rem;
    text-align: center;
    z-index: 6; /* Above backdrop and content, below header */
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border-bottom: 1px solid rgba(0, 0, 0, 0.3);
  }

  /* --- Full Backdrop Mode Styles --- */
  .detail-view.full-backdrop-mode {
    background-color: transparent;
  }
  .full-backdrop-mode .overview-container {
    background-color: rgba(30, 30, 33, 0.7);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 1.5rem;
  }
  .full-backdrop-mode .overview-container .section-title {
    margin-bottom: 1rem;
  }
  .full-backdrop-mode .credits-popout {
    background-color: var(--color-background); /* opaque for readability */
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-color: var(--color-border);
  }
  .full-backdrop-mode .collapsible-content {
    background-color: rgba(30, 30, 33, 0.7);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 1.5rem;
  }

  .full-backdrop-mode .play-button {
    background-color: rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: white;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  }

  .full-backdrop-mode .play-button:hover {
    background-color: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.4);
    transform: translateY(-2px) scale(1.02);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }

  /* Overview Expansion Styles */
  .overview-expandable-area {
    position: relative;
  }
  .overview-wrapper {
    overflow: hidden;
    min-height: 1.2em; /* Ensure it's never 0 during first measurement */
    max-height: 12rem; /* Cap by default to prevent layout jumps on arrival */
  }

  .overview-wrapper.expanded {
    max-height: none;
  }

  .overview-wrapper.collapsed {
    transition: none;

    -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 3rem), transparent);
    mask-image: linear-gradient(to bottom, black calc(100% - 3rem), transparent);
  }

  .expand-button-wrapper {
    text-align: center;
    margin-top: -1.5rem;
    position: relative;
    z-index: 1;
    transition: margin-top 0.3s ease-in-out;
  }
  .overview-wrapper.expanded + .expand-button-wrapper {
    margin-top: 0.5rem;
  }
  .expand-overview-btn {
    background: none;
    border: none;
    color: var(--ev-c-text-2);
    cursor: pointer;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    transition: all 0.2s ease;
    display: inline-flex;
    justify-content: center;
    align-items: center;
  }
  .expand-overview-btn:hover {
    color: var(--ev-c-text-1);
    background-color: var(--color-background-soft);
  }
  .expand-overview-btn .chevron {
    display: inline-block;
    border: solid currentColor;
    border-width: 0 2px 2px 0;
    padding: 3px;
    transform: rotate(45deg); /* Down arrow */
    transition: transform 0.2s ease;
  }
  .expand-overview-btn .chevron.up {
    transform: rotate(-135deg); /* Up arrow */
  }
</style>
