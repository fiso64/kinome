<script lang="ts">
  import MediaView from './MediaView.svelte'
  import CreditsView from './CreditsView.svelte'

  import ContinueWatchingItem from './ContinueWatchingItem.svelte'
  import { slide } from 'svelte/transition'
  import { getAssetUrl } from '../../lib/api'

  let {
    item: initialItem,
    onItemClick,
    showContextMenu,
    onSearchByTag,
    settings
  }: {
    item: LibraryItem
    onItemClick: (item: LibraryItem) => void
    showContextMenu: (item: LibraryItem, event: MouseEvent, options?: { layout?: string }) => void
    onSearchByTag: (key: string, value: string) => void
    settings: Settings
  } = $props()

  import { libraryDataService } from '../../lib/services/library-data-service.svelte'
  import { resolveViewSettings } from '../../../../shared/settings-helpers'
  import { getAllRequiredFields } from '../../lib/view-requirements'
  import type { LibraryItem, MediaFile, MediaFolder, Settings } from '@shared/types'

  // -- 1. Reactive Data Fetching (Lean Bundling) --

  // Resolve layout and required fields for the current item
  const resolvedSettings = $derived(
    settings ? resolveViewSettings(initialItem as MediaFolder, settings).settings : null
  )
  const requiredFields = $derived(resolvedSettings ? getAllRequiredFields(resolvedSettings) : [])

  // Fetch the full detail tree with only the required fields
  const detailsQuery = libraryDataService.getItemDetailsQuery(() => initialItem.id, {
    fields: () => requiredFields
  })

  // The authoritative reactive item for the entire component.
  // We fall back to initialItem for instant responsiveness while the query is loading.
  const item = $derived(detailsQuery.data || initialItem)

  // -- 2. Derived Template Properties --

  const displayTitle = $derived(
    item.mediaType === 'episode' && 'episodeNumber' in item && item.episodeNumber != null
      ? `${item.episodeNumber}. ${item.title ?? item.name}`
      : (item.title ?? item.name)
  )

  const showOverviewTab = $derived(!!item.overview)
  const showCreditsSection = $derived(
    (item.tmdbId && !item.tmdbCredits) ||
      (item.tmdbCredits && (item.tmdbCredits.cast.length > 0 || item.tmdbCredits.crew.length > 0))
  )

  const isSpecialFile = $derived(item.type === 'file' && item.opensAsFolder === true)
  const fileAsChild = $derived(
    isSpecialFile ? [{ ...JSON.parse(JSON.stringify(item)), opensAsFolder: false }] : []
  )

  const children = $derived(item?.type === 'folder' ? (item.children ?? []) : [])
  const contentsLayout = $derived(resolvedSettings?.layout ?? 'grid')
  const showRegularContents = $derived(item.type === 'folder' && children.length > 0)

  // -- 3. Local Component State & Queries --

  let activeInfoTab: 'overview' | 'credits' = $state('overview')
  let isCreditsExpanded = $state(settings?.creditsDisplay === 'shown')
  let lastSeenItemId = $state(initialItem.id)
  let overviewContainerElement = $state<HTMLDivElement>()
  let isOverviewExpanded = $state(false)
  let isOverviewOverflowing = $state(false)

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
      activeInfoTab = 'overview'
      lastSeenItemId = item.id
      isOverviewExpanded = false
      isOverviewOverflowing = false
    }
    if (!showOverviewTab && activeInfoTab === 'overview' && item.lastRefreshedAt) {
      activeInfoTab = 'credits'
    }
  })

  $effect(() => {
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
      overviewWrapper.style.maxHeight = ''
      infoCol.getBoundingClientRect()
      const posterHeight = posterCol.offsetHeight
      const infoHeight = infoCol.offsetHeight
      const isCurrentlyOverflowing = infoHeight > posterHeight
      isOverviewOverflowing = isCurrentlyOverflowing
      if (isCurrentlyOverflowing && !isExpanded) {
        const overflowAmount = infoHeight - posterHeight
        const currentOverviewWrapperHeight = overviewWrapper.offsetHeight
        const newMaxHeight = currentOverviewWrapperHeight - overflowAmount
        overviewWrapper.style.maxHeight = `${Math.max(10, newMaxHeight)}px`
      }
    }

    const observer = new ResizeObserver(checkOverflow)
    observer.observe(posterCol)
    observer.observe(infoCol)
    observer.observe(overviewP)
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
  <div class="backdrop-container" class:full-size={settings.itemDetailBackdropSize === 'full'}>
    {#if item.backdropPath}
      <img
        class="backdrop-image"
        src={getAssetUrl(item.backdropPath + (item._v ? `?v=${item._v}` : ''))}
        alt=""
        style:--backdrop-blur="{settings.itemDetailBackdropBlur}px"
      />
    {/if}
    <div class="backdrop-overlay"></div>
  </div>

  <div class="scroll-container">
    <div class="detail-content">
      <div class="info-grid">
        <div class="poster-column" bind:this={posterColumnElement}>
          <div class="poster">
            {#if item.posterPath}
              <div class="poster-container">
                <img
                  src={getAssetUrl(item.posterPath + (item._v ? `?v=${item._v}` : ''))}
                  alt="Poster"
                />
              </div>
            {:else}
              <div class="icon">
                {item.type === 'folder' ? '📁' : '📄'}
              </div>
            {/if}
          </div>
          {#if item.type === 'file' && !item.opensAsFolder}
            <button class="play-button" onclick={() => onItemClick(item)}> ▶ Play </button>
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
                  src={getAssetUrl(item.logoPath + (item._v ? `?v=${item._v}` : ''))}
                  alt="{item.title ?? item.name} Logo"
                  class="logo-image"
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
                      >
                        <p class="overview" bind:this={overviewParagraphElement}>{item.overview}</p>
                      </div>
                      {#if isOverviewOverflowing}
                        <div class="expand-button-wrapper">
                          <button
                            class="expand-overview-btn"
                            onclick={() => (isOverviewExpanded = !isOverviewExpanded)}
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
                >
                  <p class="overview" bind:this={overviewParagraphElement}>{item.overview}</p>
                </div>
                {#if isOverviewOverflowing}
                  <div class="expand-button-wrapper">
                    <button
                      class="expand-overview-btn"
                      onclick={() => (isOverviewExpanded = !isOverviewExpanded)}
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
          {#if contentsLayout !== 'tabs' && contentsLayout !== 'sections'}
            <h2 class="section-title">Contents</h2>
          {/if}
          <MediaView
            parentItem={item}
            items={children}
            {onItemClick}
            layout={contentsLayout}
            onShowContextMenu={showContextMenu}
            {settings}
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
    position: fixed;
    top: var(--header-height);
    bottom: 0;
    left: 0;
    right: 0;
    color: var(--color-text);
    background-color: var(--color-background);
    z-index: 5;
    overflow: hidden; /* Prevent this container from scrolling */
    /* Add a subtle fade-in for smoothness, but it's not hiding a long wait anymore */
    animation: fadeIn 0.15s ease-in;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .backdrop-container {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 50vh;
    max-height: 400px;
    overflow: hidden;
    transition:
      height 0.3s ease-in-out,
      max-height 0.3s ease-in-out;
  }
  .backdrop-container.full-size {
    height: 100vh;
    max-height: none;
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
    transition: filter 0.3s ease-in-out;
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
    padding: 1.5rem;
    padding-top: 10vh;
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 3rem;
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
    box-shadow: 0 8px 25px rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.1);
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
    background-color: rgba(255, 255, 255, 0.1);
    padding: 0.3rem 0.8rem;
    border-radius: 16px;
    font-size: 0.9rem;
    border: none;
    color: var(--ev-c-text-2);
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .genre-tag:hover {
    background-color: rgba(255, 255, 255, 0.2);
    color: var(--ev-c-text-1);
  }

  .play-button {
    width: 100%;
    background-color: var(--ev-c-white-soft);
    color: var(--ev-c-black);
    border: none;
    padding: 1rem;
    border-radius: 8px; /* Match poster */
    font-weight: bold;
    cursor: pointer;
    font-size: 1.2rem;
    transition:
      transform 0.2s ease,
      box-shadow 0.2s ease;
  }
  .play-button:hover {
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
    background: rgba(20, 20, 22, 0.5);
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
    background-color: rgba(20, 20, 22, 1); /* opaque for readability */
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-color: rgba(255, 255, 255, 0.1);
  }
  .full-backdrop-mode .collapsible-content {
    background: rgba(20, 20, 22, 0.5);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
  }

  /* Overview Expansion Styles */
  .overview-expandable-area {
    position: relative;
  }
  .overview-wrapper {
    transition: max-height 0.3s ease-in-out;
    overflow: hidden;
  }
  .overview-wrapper.collapsed {
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
