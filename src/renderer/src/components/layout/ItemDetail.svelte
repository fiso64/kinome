<script lang="ts">
  import MediaView from './MediaView.svelte'
  import CreditsView from './CreditsView.svelte'
  import ContinueWatchingItem from './ContinueWatchingItem.svelte'
  import { slide } from 'svelte/transition'

  let {
    item,
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

  let activeInfoTab: 'overview' | 'credits' = $state('overview')
  let isCreditsExpanded = $state(settings?.creditsDisplay === 'shown')
  let lastSeenItemId = $state(item.id)
  let overviewContainerElement = $state<HTMLDivElement>()
  let continueWatchingInfo = $state<{ show: MediaFolder; nextEpisode: MediaFile } | null>(null)

  const showOverviewTab = $derived(!!item.overview)
  const showCreditsSection = $derived(
    (item.tmdbId && !item.tmdbCreditsFetched) ||
      (item.tmdbCreditsFetched &&
        item.tmdbCredits &&
        (item.tmdbCredits.cast.length > 0 || item.tmdbCredits.crew.length > 0))
  )

  $effect(() => {
    // If we switch to a new item (i.e., the ID has changed), reset the tab to overview.
    // This prevents the tab from resetting on a simple data update for the same item.
    if (item.id !== lastSeenItemId) {
      activeInfoTab = 'overview'
      lastSeenItemId = item.id
    }
    // If the overview tab is not visible but is selected, switch to credits.
    // We also check tmdbDetailsFetched to avoid switching tabs during a re-fetch.
    if (!showOverviewTab && activeInfoTab === 'overview' && item.tmdbDetailsFetched) {
      activeInfoTab = 'credits'
    }
  })

  $effect(() => {
    // On-demand fetching for credits
    if (settings?.creditsDisplay === 'tab') {
      if (activeInfoTab === 'credits' && !item.tmdbCreditsFetched) {
        window.api.fetchCredits(item.id)
      }
    } else {
      // Logic for 'shown'/'collapsed'
      if (isCreditsExpanded && !item.tmdbCreditsFetched) {
        window.api.fetchCredits(item.id)
      }
    }
  })

  $effect(() => {
    if (activeInfoTab !== 'credits') {
      return
    }

    const handleClickOutside = (event: MouseEvent) => {
      // Don't close if clicking on the popout container itself.
      if (overviewContainerElement && !overviewContainerElement.contains(event.target as Node)) {
        // Also, don't close if clicking on another modal or context menu on top.
        const targetElement = event.target as HTMLElement
        if (targetElement.closest('.modal-window, .context-menu, .dialog-window')) {
          return
        }
        activeInfoTab = 'overview'
      }
    }

    // Add listener on the next tick to avoid it firing from the same click that opened it.
    queueMicrotask(() => {
      window.addEventListener('mousedown', handleClickOutside)
    })

    // Cleanup function to remove the listener.
    return () => {
      window.removeEventListener('mousedown', handleClickOutside)
    }
  })

  const displayTitle = $derived(
    item.mediaType === 'episode' && 'episodeNumber' in item && item.episodeNumber != null
      ? `${item.episodeNumber}. ${item.title ?? item.name}`
      : (item.title ?? item.name)
  )

  const isSpecialFile = $derived(item.type === 'file' && item.opensAsFolder === true)
  // Create a "fake" child that is the file itself, but without the special property
  // to prevent an infinite loop of detail views. This also makes it playable by the grid.
  const fileAsChild = $derived(
    isSpecialFile ? [{ ...JSON.parse(JSON.stringify(item)), opensAsFolder: false }] : []
  )

  import { resolveViewSettings } from '../../../../shared/settings-helpers'

  const contentsLayout = $derived(
    resolveViewSettings(item as MediaFolder, settings).settings.layout
  )

  const showRegularContents = $derived(item.type === 'folder' && item.children.length > 0)

  // These values help manage the individual image fade-in animations.
  let isBackdropLoaded = $state(false)
  let isLogoLoaded = $state(false)
  let previousBackdropPath = $state<string | null | undefined>(undefined)
  let previousLogoPath = $state<string | null | undefined>(undefined)

  $effect(() => {
    // This effect runs whenever the item prop changes.
    // It's responsible for fetching data specific to this detail view,
    // like the "Continue Watching" info.

    // Always re-evaluate "Continue Watching" when the item changes.
    if (item.type === 'folder' && item.mediaType === 'tv') {
      window.api.getContinueWatchingForShow(item.id).then((info) => {
        continueWatchingInfo = info
      })
    } else {
      // If it's not a TV show, there's no "Next Up", so ensure it's cleared.
      continueWatchingInfo = null
    }

    // Also, reset fade-in animation flags if the image source has changed.
    // This prevents a re-fade if other metadata is updated but the image is the same.
    if (item.backdropPath !== previousBackdropPath) {
      isBackdropLoaded = false
      previousBackdropPath = item.backdropPath
    }
    if (item.logoPath !== previousLogoPath) {
      isLogoLoaded = false
      previousLogoPath = item.logoPath
    }
  })
</script>

<div class="detail-view" oncontextmenu={(e) => showContextMenu(item, e)}>
  {#if item.isMissing}
    <div class="missing-banner">
      <span class="icon">⚠️</span>
      <span>File or folder missing from disk.</span>
    </div>
  {/if}
  <div class="backdrop-container">
    {#if item.backdropPath}
      <img
        src="media-browser-asset://images/{item.backdropPath}{item._v ? `?v=${item._v}` : ''}"
        alt=""
        class="backdrop-image"
        class:loaded={isBackdropLoaded}
        onload={() => (isBackdropLoaded = true)}
      />
    {/if}
    <div class="backdrop-overlay"></div>
  </div>

  <div class="detail-content">
    <div class="info-grid">
      <div class="poster-column">
        <div class="poster">
          {#if item.posterPath}
            <img
              src="media-browser-asset://images/{item.posterPath}{item._v ? `?v=${item._v}` : ''}"
              alt="Poster"
            />
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

      <div class="info-column">
        <div class="title-and-meta">
          {#if (settings.useLogos ?? true) && item.logoPath}
            <div class="logo-container">
              <img
                src="media-browser-asset://images/{item.logoPath}{item._v ? `?v=${item._v}` : ''}"
                alt="{item.title ?? item.name} Logo"
                class="logo-image"
                class:loaded={isLogoLoaded}
                onload={() => (isLogoLoaded = true)}
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
                  <p class="overview">{item.overview}</p>
                {/if}
              </div>

              <!-- Credits "pop out" on top of the overview area -->
              {#if activeInfoTab === 'credits' && showCreditsSection}
                <div class="credits-popout">
                  <div class="tab-content-wrapper">
                    {#if item.tmdbCredits && (item.tmdbCredits.cast.length > 0 || item.tmdbCredits.crew.length > 0)}
                      <CreditsView {item} credits={item.tmdbCredits} {onSearchByTag} />
                    {:else if !item.tmdbCreditsFetched}
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
              <p class="overview">{item.overview}</p>
          </div>
        {/if}
      </div>
    </div>

    {#if settings.showNextUp && continueWatchingInfo}
      <section class="hero-banner-section">
        <h2 class="section-title">Next Up</h2>
        <ContinueWatchingItem
          item={continueWatchingInfo}
          layout="horizontal"
          on:itemClick={(e) => onItemClick(e.detail.item)}
          on:dismiss={() => {
            window.api.setContinueWatchingDismissed(continueWatchingInfo!.show.id)
            continueWatchingInfo = null
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
          items={item.children}
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
              {:else if !item.tmdbCreditsFetched}
                <div class="loading-credits">Loading...</div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .detail-view {
    position: fixed;
    top: var(--header-height);
    bottom: 0;
    left: 0;
    right: 0;
    color: var(--color-text);
    background-color: var(--color-background);
    z-index: 5;
    overflow-y: auto;
    scrollbar-gutter: stable;
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
  }

  .backdrop-image,
  .logo-image {
    opacity: 0;
    transition: opacity 0.4s ease-in-out;
  }
  .backdrop-image.loaded,
  .logo-image.loaded {
    opacity: 1;
  }

  .backdrop-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(4px);
  }

  .backdrop-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: linear-gradient(
      to top,
      var(--color-background) 15%,
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

  .poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
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
    gap: 1.5rem;
  }

  .logo-container {
    max-width: 350px;
  }

  .logo-image {
    width: 100%;
    height: 100%;
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
    border-bottom: 1px solid var(--color-background-mute);
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
    top: 47px; /* Height of tabs + gap */
    left: -1rem; /* Align with parent padding */
    right: -1rem; /* Align with parent padding */
    max-height: 50vh; /* Set a maximum height, but allow it to be smaller */

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
</style>
