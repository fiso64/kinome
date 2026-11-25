<script lang="ts">
  import { displayTitle as itemTitle } from '@lib/view-helpers'
  import Icon from '@components/ui/Icon.svelte'
  import MediaView from './MediaView.svelte'
  import TmdbMetadataSummary from '@components/ui/TmdbMetadataSummary.svelte'
  import { authStore } from '@lib/auth-store.svelte'
  import CreditsView from './CreditsView.svelte'
  import Skeleton from '@components/ui/Skeleton.svelte'

  import ContinueWatchingItem from './ContinueWatchingItem.svelte'
  import { slide, fade } from 'svelte/transition'
  import { prefersReducedMotion } from 'svelte/motion'
  import { itemCapabilities, selectMovieFile } from '@shared/item-capabilities'
  import { getAssetUrl } from '@lib/api'
  import { notificationStore } from '@lib/notification-store.svelte'

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

  type InfoTab = 'overview' | 'credits' | 'metadata'
  const infoTabLabels: Record<InfoTab, string> = { overview: 'Overview', credits: 'Cast & Crew', metadata: 'Metadata' }
  let activeInfoTab = $state<InfoTab>('overview')
  let isCreditsExpanded = $state(settings?.creditsDisplay === 'shown')
  let lastSeenItemId = $state(initialItem.id)
  let infoContainer = $state<HTMLElement>()
  let detailScroll = $state<HTMLDivElement>()
  let infoTabs = $state<HTMLDivElement>()
  let infoPanel = $state<HTMLDivElement>()
  let infoPanelContent = $state<HTMLDivElement>()
  let isOverviewExpanded = $state(false)
  let isOverviewOverflowing = $state(false)
  let isBackdropLoaded = $state(false)
  let isLogoLoaded = $state(false)
  let isPosterLoaded = $state(false)

  // References for safety checks
  let backdropImg = $state<HTMLImageElement>()
  let logoImg = $state<HTMLImageElement>()
  let posterImg = $state<HTMLImageElement>()

  // Tracking the "last" paths to avoid redundant resets
  let lastBackdrop = $state<string | undefined>()
  let lastLogo = $state<string | undefined>()
  let lastPoster = $state<string | undefined>()

  // -- 2. Reactive Data Fetching (Lean Bundling) --

  // Resolve layout and required fields for the current item
  const resolvedSettings = $derived(
    settings ? resolveViewSettings(initialItem as MediaFolder, settings).settings : null
  )

  // 1. Fetch metadata only (Fast, no large blobs) + Request View Settings Side-Channel
  const itemQuery = libraryDataService.getItemDetailsQuery(() => initialItem.id, {
    fields: () => DETAIL_HEADER_FIELDS,
    include: () => ['viewHierarchy']
  })

  // 1a. Fetch Credits lazily (Before item derivation)
  const creditsQuery = libraryDataService.getCreditsQuery(() => initialItem.id, {
    enabled: () => settings.creditsDisplay !== 'hidden' && (activeInfoTab === 'credits' || isCreditsExpanded)
  })

  // The authoritative reactive item for metadata (header, background)
  // We merge lazy credits into this object so the UI can simple access item.tmdbCredits
  const item = $derived({
    ...(itemQuery.data || initialItem),
    tmdbCredits: creditsQuery.data ?? (itemQuery.data || initialItem).tmdbCredits
  })

  const isHeaderLoading = $derived(itemQuery.status === 'pending')
  const releaseFacts = $derived([
    item.year,
    item.mediaType === 'movie' ? formatRuntime(item.tmdbRuntime) : '',
    item.tmdbMetadata?.productionCountries?.join(', '),
    item.mediaType === 'tv' ? formatNextEpisode(item.tmdbMetadata?.nextAirDate) : ''
  ].filter(Boolean))

  /**
   * The stored date is as of the last metadata fetch. A date that has passed
   * says nothing about the next episode, so it is not shown.
   */
  function formatNextEpisode(date: string | undefined): string {
    const match = date && /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (!match) return ''
    const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const daysAway = Math.round((day.getTime() - today.getTime()) / 86_400_000)
    if (daysAway < 0) return ''
    if (daysAway === 0) return 'Next episode today'
    if (daysAway === 1) return 'Next episode tomorrow'
    if (daysAway < 7) return `Next episode in ${daysAway} days`
    return `Next episode ${day.toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric'
    })}`
  }

  function formatRuntime(minutes: number | null | undefined): string {
    if (!minutes || minutes <= 0) return ''
    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60
    return hours > 0 ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`
  }

  // 1. Reset states ONLY if the path actually changed
  $effect.pre(() => {
    if (item.backdropPath !== lastBackdrop) {
      lastBackdrop = item.backdropPath
      isBackdropLoaded = false
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
    fields: () => item.mediaType === 'movie' ? [...new Set([...requiredFields, 'size'])] : requiredFields,
    isDetailView: () => true,
    enabled: () => item.type === 'folder' && item.viewHierarchy != null
  })

  // Structural children for the content list/tabs
  const children = $derived(
    childrenQuery.data || (initialItem.type === 'folder' ? initialItem.children || [] : [])
  )

  const movieFile = $derived(item.type === 'folder' && item.mediaType === 'movie'
    ? selectMovieFile(children as (LibraryItem & MediaFile)[]) : undefined)

  // -- 3. Derived Template Properties --

  const displayTitle = $derived(itemTitle(item))

  const showOverviewTab = $derived(!!item.overview)
  // Ensure we show the tab if we HAVE credits OR if we can fetch them (has tmdbId)
  const showCreditsSection = $derived(
    (item.tmdbId && !item.tmdbCredits) ||
      (item.tmdbCredits && (item.tmdbCredits.cast.length > 0 || item.tmdbCredits.crew.length > 0))
  )

  // A file's detail view lists the file itself, like a folder holding only that file.
  // The row stands for the file on disk: its name and no artwork. The page above already shows the title.
  const fileAsChild = $derived(
    item.type === 'file' ? [{
      ...JSON.parse(JSON.stringify(item)), opensAsFolder: false,
      title: null, posterPath: null, seasonNumber: null, episodeNumber: null
    }] : []
  )

  const availableInfoTabs = $derived.by(() => {
    const tabs: InfoTab[] = []
    if (showOverviewTab) tabs.push('overview')
    if (settings.creditsDisplay === 'tab' && showCreditsSection) tabs.push('credits')
    if (item.tmdbMetadata) tabs.push('metadata')
    return tabs
  })
  const popupTab = $derived(activeInfoTab !== 'overview' && availableInfoTabs.includes(activeInfoTab) ? activeInfoTab : null)
  const infoPanelId = $props.id()

  const contentsLayout = $derived(
    item.viewHierarchy?.effective?.layout ?? resolvedSettings?.layout ?? 'grid'
  )
  const loadingContents = $derived(childrenQuery.isPending && childrenQuery.isFetching)

  // -- 4. Additional Queries --

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
    if (!showOverviewTab && !item.tmdbMetadata && showCreditsSection && settings.creditsDisplay === 'tab') {
      activeInfoTab = 'credits'
    }
  })

  $effect(() => {
    // Wait for the lazy-load query to finish before deciding we need to scrape
    if (!authStore.can.editMetadata || !item.tmdbId || creditsQuery.isFetching || settings.creditsDisplay === 'hidden') return

    if (settings?.creditsDisplay === 'tab') {
      if (activeInfoTab === 'credits' && !item.tmdbCredits) {
        window.api.fetchCredits(item.id).catch((err: any) => {
          notificationStore.add(err.message || 'Failed to fetch credits.', 'error')
        })
      }
    } else {
      if (isCreditsExpanded && !item.tmdbCredits) {
        window.api.fetchCredits(item.id).catch((err: any) => {
          notificationStore.add(err.message || 'Failed to fetch credits.', 'error')
        })
      }
    }
  })

  $effect(() => {
    const wrapper = overviewWrapperElement
    const paragraph = overviewParagraphElement
    if (!wrapper || !paragraph) return

    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(wrapper).lineHeight)
      isOverviewOverflowing = paragraph.scrollHeight > lineHeight * 5 + 1
    }
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => observer.disconnect()
  })

  $effect(() => {
    const viewport = detailScroll
    const tabs = infoTabs
    const panel = infoPanel
    const content = infoPanelContent
    const anchor = panel?.parentElement
    if (!viewport || !tabs || !panel || !content || !anchor) return

    let frame = 0
    const measure = () => {
      const bounds = viewport.getBoundingClientRect()
      const tabBounds = tabs.getBoundingClientRect()
      const anchorTop = anchor.getBoundingClientRect().top
      const below = bounds.bottom - anchorTop - 12
      const above = tabBounds.top - bounds.top - 12
      const naturalHeight = content.getBoundingClientRect().height + 24
      const placeAbove = below < naturalHeight && above > below
      panel.classList.toggle('above-tabs', placeAbove)
      panel.style.setProperty('--info-panel-room', `${Math.max(0, placeAbove ? above : below)}px`)
      panel.style.setProperty('--info-panel-above-offset', `${Math.ceil(anchorTop - tabBounds.top + 6)}px`)
    }

    function scheduleMeasure() {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }

    const sizes = new ResizeObserver(scheduleMeasure)
    sizes.observe(viewport)
    sizes.observe(tabs)
    sizes.observe(content)
    viewport.addEventListener('scroll', scheduleMeasure, { passive: true })
    measure()
    return () => {
      viewport.removeEventListener('scroll', scheduleMeasure)
      sizes.disconnect()
      cancelAnimationFrame(frame)
    }
  })

  function handleInfoTabKeys(event: KeyboardEvent, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

    const tabs = availableInfoTabs
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break
      case 'ArrowRight': next = (index + 1) % tabs.length; break
      case 'Home': next = 0; break
      case 'End': next = tabs.length - 1; break
      default: return
    }
    event.preventDefault()
    activeInfoTab = tabs[next]
    document.getElementById(`${infoPanelId}-${activeInfoTab}`)?.focus()
  }

  function closeInfoPopup(restoreFocus: boolean) {
    const trigger = showOverviewTab ? 'overview' : activeInfoTab
    activeInfoTab = 'overview'
    if (restoreFocus) document.getElementById(`${infoPanelId}-${trigger}`)?.focus()
  }

  function dismissInfoPopup(event: PointerEvent) {
    if (!popupTab || !(event.target instanceof Element)) return
    if (!infoContainer?.contains(event.target) && !event.target.closest('.context-menu, .modal-backdrop')) {
      closeInfoPopup(false)
    }
  }
</script>

<svelte:window onpointerdown={dismissInfoPopup} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="detail-view"
  class:full-backdrop-mode={settings.itemDetailBackdropSize === 'full'}
  oncontextmenu={(e) => showContextMenu(item, e)}
>
  {#if item.isMissing}
    <div class="missing-banner">
      <span class="icon"><Icon name="warning" size={17} /></span>
      <span>File or folder missing from disk.</span>
    </div>
  {/if}
  <ViewContextProvider id={item.id}>
    <div class="scroll-container" bind:this={detailScroll} use:scrollPersistence={{ key: getViewKey('detail') }}>
      <div class="backdrop-container" class:full-size={settings.itemDetailBackdropSize === 'full'}>
        {#if item.backdropPath}
          <img
            bind:this={backdropImg}
            class="backdrop-image"
            class:show={isBackdropLoaded}
            src={getAssetUrl(item.backdropPath + (item._v ? `?v=${item._v}` : ''))}
            alt=""
            onload={() => (isBackdropLoaded = true)}
            onerror={() => (isBackdropLoaded = true)}
            style:--backdrop-blur="{settings.itemDetailBackdropBlur}px"
          />
        {/if}
        <div class="backdrop-overlay"></div>
      </div>

      <div class="detail-content" aria-busy={isHeaderLoading}>
        <div class="info-grid">
          <div class="poster-column">
            <div class="poster">
              {#if isHeaderLoading}
                <Skeleton width="100%" height="100%" radius="8px" />
              {:else if item.posterPath}
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
                  <Icon name={item.type === 'folder' ? 'folder' : 'file'} size={20} />
                </div>
              {/if}
            </div>

          </div>

          <div class="info-column">
            <div class="title-and-meta">
              {#if isHeaderLoading}
                <Skeleton width="65%" height="2.5rem" radius="6px" />
                <div class="skeleton-meta-row">
                  <Skeleton width="60px" height="1em" radius="4px" />
                  <Skeleton width="80px" height="1em" radius="4px" />
                  <Skeleton width="70px" height="1em" radius="4px" />
                </div>
              {:else}
                {#if item.mediaType === 'season' && parentShow}
                  <button class="parent-show-link" onclick={() => onItemClick(parentShow)}>
                    <span class="breadcrumb-arrow"><Icon name="left" size={17} /></span>{parentShow.title ?? parentShow.name}
                  </button>
                {/if}
                {#if (settings.useLogos ?? true) && item.logoPath}
                  <h1 class="logo-container">
                    <img
                      bind:this={logoImg}
                      src={getAssetUrl(item.logoPath + (item._v ? `?v=${item._v}` : ''))}
                      alt={displayTitle}
                      class="logo-image"
                      class:show={isLogoLoaded}
                      onload={() => (isLogoLoaded = true)}
                      onerror={() => (isLogoLoaded = true)}
                    />
                  </h1>
                {:else}
                  <h1>{displayTitle}</h1>
                {/if}
                <div class="media-meta">
                  {#if releaseFacts.length}
                    <div class="release-facts">
                      {#each releaseFacts as fact, index}
                        {#if index > 0}
                          <span class="fact-separator" aria-hidden="true"></span>
                        {/if}
                        <span class="release-fact">{fact}</span>
                      {/each}
                    </div>
                  {/if}
                  {#if item.genres?.length}
                    <div class="genres">
                      {#each item.genres as genre}
                        <button class="genre-tag" onclick={() => onSearchByTag('genre', genre)}>
                          {genre}
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>
                {#if item.type === 'file' && itemCapabilities(item).canPlay}
                  <button class="primary play-button" onclick={() => onPlay(item)}><Icon name="play" size={18} /> Play</button>
                {:else if movieFile}
                  {@const playableFile = movieFile}
                  <button class="primary play-button" onclick={() => onPlay({ ...playableFile, title: item.title ?? item.name })}>
                    <Icon name="play" size={18} /> Play
                  </button>
                {/if}
              {/if}
            </div>

            {#if isHeaderLoading}
              <div class="overview-container overview-loading" aria-hidden="true">
                <Skeleton width="25%" height="1.15rem" />
                <Skeleton width="95%" />
                <Skeleton width="85%" />
                <Skeleton width="70%" />
              </div>
            {:else if availableInfoTabs.some((tab) => tab !== 'overview')}
              <section class="overview-container" bind:this={infoContainer} aria-label="Title information"
                onkeydown={(event) => {
                  if (event.key === 'Escape' && popupTab && !event.defaultPrevented) {
                    event.preventDefault()
                    event.stopPropagation()
                    closeInfoPopup(true)
                  }
                }}>
                <div class="info-tabs" role="tablist" aria-label="Title information" bind:this={infoTabs}>
                  {#each availableInfoTabs as tab, index (tab)}
                    {@const selected = tab === 'overview' ? !popupTab : popupTab === tab}
                    <button type="button" role="tab" id={`${infoPanelId}-${tab}`} aria-selected={selected}
                      aria-controls={tab === 'overview' || selected ? `${infoPanelId}-${tab}-panel` : undefined}
                      tabindex={selected || (!popupTab && !showOverviewTab && index === 0) ? 0 : -1}
                      onkeydown={(event) => handleInfoTabKeys(event, index)}
                      onclick={() => {
                        if (tab === popupTab) closeInfoPopup(true)
                        else activeInfoTab = tab
                      }}>{infoTabLabels[tab]}</button>
                  {/each}
                </div>

                <div class="info-panels">
                  {#if showOverviewTab}
                    <div role="tabpanel" id={`${infoPanelId}-overview-panel`} aria-labelledby={`${infoPanelId}-overview`}
                      class="overview-panel" class:covered={!!popupTab} inert={!!popupTab}>
                      {@render overview()}
                    </div>
                  {/if}
                  {#if popupTab}
                    <div class="info-popout glass-surface" class:credits-popout={popupTab === 'credits'}
                      class:metadata-popout={popupTab === 'metadata'} role="tabpanel"
                      id={`${infoPanelId}-${popupTab}-panel`} aria-labelledby={`${infoPanelId}-${popupTab}`}
                      bind:this={infoPanel} in:fade={{ duration: prefersReducedMotion.current ? 0 : 135 }}>
                      <div bind:this={infoPanelContent}>
                        <div class="info-popout-heading">
                          <h2>{popupTab === 'credits' ? 'Cast & Crew' : 'TMDB metadata'}</h2>
                          <button class="icon-button" type="button" aria-label={popupTab === 'credits' ? 'Close cast and crew' : 'Close metadata'}
                            onclick={() => closeInfoPopup(true)}><Icon name="close" size={18} /></button>
                        </div>
                        {#if popupTab === 'credits'}
                          {@render credits()}
                        {:else if item.tmdbMetadata}
                          <TmdbMetadataSummary metadata={item.tmdbMetadata} tmdbId={item.tmdbId} mediaType={item.mediaType} />
                        {/if}
                      </div>
                    </div>
                  {/if}
                </div>
              </section>
            {:else if item.overview}
              <div class="overview-container">
                <h2 class="section-title">Overview</h2>
                {@render overview()}
              </div>
            {/if}
          </div>
        </div>

        {#if settings.showNextUp && continueWatchingInfo}
          <section class="hero-banner-section media-panel">
            <h2 class="section-title">Next Up</h2>
            <ContinueWatchingItem
              embedded
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

        {#if item.type === 'folder' && (children.length || loadingContents || childrenQuery.isError)}
          <section
            class="children-section"
            class:media-panel={contentsLayout !== 'tabs' || loadingContents || !children.length}
            aria-busy={loadingContents}
          >
            {#if !CONTAINER_LAYOUTS.includes(contentsLayout as any) || loadingContents}
              <h2 class="section-title">Contents</h2>
            {/if}
            {#if loadingContents}
              <div class="overview-loading" role="status" aria-label="Loading contents">
                <Skeleton height="2.2rem" />
                <Skeleton height="2.2rem" width="85%" />
              </div>
            {:else if childrenQuery.isError && !children.length}
              <div class="contents-status" role="status">
                <p>Could not load this title's contents.</p>
                <button type="button" onclick={() => childrenQuery.refetch()}>Try again</button>
              </div>
            {:else}
              <MediaView
                parentItem={item}
                items={children}
                {onItemClick}
                layout={contentsLayout}
                onShowContextMenu={showContextMenu}
                {settings}
                viewNode={item.viewHierarchy}
              />
            {/if}
          </section>
        {/if}

        {#if item.type === 'file'}
          <section class="children-section media-panel">
            <h2 class="section-title">File</h2>
            <MediaView
              parentItem={item as unknown as MediaFolder}
              items={fileAsChild}
              onItemClick={() => { if (itemCapabilities(item).canPlay) onPlay(item) }}
              layout="tree"
              onShowContextMenu={showContextMenu}
              {settings}
            />
          </section>
        {/if}

        {#if settings?.creditsDisplay !== 'hidden' && settings?.creditsDisplay !== 'tab'}
          {#if showCreditsSection}
            <div class="collapsible-section">
              <button
                class="section-title-button" aria-expanded={isCreditsExpanded}
                onclick={() => (isCreditsExpanded = !isCreditsExpanded)}
              >
                <h2 class="section-title">Cast & Crew</h2>
                <span class="chevron"><Icon name={isCreditsExpanded ? 'down' : 'right'} size={15} /></span>
              </button>
              {#if isCreditsExpanded}
                <div class="collapsible-content" transition:slide|local={{ duration: prefersReducedMotion.current ? 0 : 180 }}>
                  {@render credits()}
                </div>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    </div>
  </ViewContextProvider>
</div>

{#snippet overview()}
  <div class="overview-wrapper" bind:this={overviewWrapperElement}
    class:clamped={!isOverviewExpanded} class:fade-text={!isOverviewExpanded && isOverviewOverflowing}>
    <p class="overview" bind:this={overviewParagraphElement}>{item.overview}</p>
  </div>
  {#if isOverviewOverflowing}
    <button type="button" class="expand-overview" aria-expanded={isOverviewExpanded}
      onclick={() => (isOverviewExpanded = !isOverviewExpanded)}>
      {isOverviewExpanded ? 'Show less' : 'Read more'} <Icon name={isOverviewExpanded ? 'up' : 'down'} size={15} />
    </button>
  {/if}
{/snippet}

{#snippet credits()}
  {#if item.tmdbCredits && (item.tmdbCredits.cast.length || item.tmdbCredits.crew.length)}
    <div in:fade={{ duration: prefersReducedMotion.current ? 0 : 135 }}>
      <CreditsView {item} credits={item.tmdbCredits} {onSearchByTag} />
    </div>
  {:else if !item.tmdbCredits && item.tmdbId && (creditsQuery.isPending || creditsQuery.isFetching)}
    <div class="overview-loading" role="status" aria-label="Loading credits">
      <Skeleton width="70%" />
      <Skeleton width="45%" />
    </div>
  {:else}
    <p class="overview">No credits available.</p>
  {/if}
{/snippet}

<style>
  .detail-view { position: absolute; inset: 0; background: var(--color-background); overflow: hidden; }
  .scroll-container { position: absolute; inset: 0; overflow-y: auto; }

  .backdrop-container {
    position: absolute;
    inset: 0 0 auto;
    height: min(69dvh, 720px);
    overflow: hidden;
    pointer-events: none;
  }
  .backdrop-container.full-size { position: sticky; height: 100dvh; margin-bottom: -100dvh; }
  .backdrop-image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(var(--backdrop-blur, 4px));
    opacity: 0;
    transition: opacity .26s ease;
  }
  .backdrop-image.show { opacity: .9; }
  .backdrop-overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(0deg, var(--color-background) 2%, #0e0e0f9c 44%, #09090929 100%);
  }

  .detail-content {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: clamp(1.35rem, 3.8vw, 2.75rem);
    --detail-max-width: 1320px;
    width: min(calc(100% - var(--content-inset, 0px)), var(--detail-max-width));
    margin-inline-start: max(var(--content-inset, 0px), calc((100% + var(--content-inset, 0px) - var(--detail-max-width)) / 2));
    padding: clamp(1.25rem, 6vw, 5.35rem) clamp(.9rem, 4.25vw, 3.4rem) 4rem;
  }
  .info-grid {
    display: grid;
    grid-template-columns: clamp(150px, 25vw, 320px) minmax(0, 1fr);
    gap: clamp(1rem, 4vw, 3rem);
    align-items: start;
  }

  .poster {
    display: grid;
    place-items: center;
    width: 100%;
    aspect-ratio: 2 / 3;
    color: var(--color-primary-soft);
    background: var(--surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-panel);
    box-shadow: var(--shadow-standard);
    overflow: hidden;
  }
  .poster-container, .poster img { width: 100%; height: 100%; }
  .poster img { display: block; object-fit: cover; opacity: 0; transition: opacity .22s ease; }
  .poster img.show { opacity: 1; }

  .info-column, .title-and-meta, .overview-container { display: grid; min-width: 0; }
  .info-column { grid-template-columns: minmax(0, 1fr); gap: 1.25rem; padding-top: clamp(.45rem, 2.4vw, 1.85rem); }
  .title-and-meta { gap: .65rem; justify-items: start; }
  .parent-show-link {
    display: flex;
    align-items: center;
    gap: .18rem;
    padding: .1rem .2rem .1rem 0;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    color: var(--color-text-soft);
    text-align: left;
  }
  .parent-show-link:hover { color: var(--color-primary-soft); background: transparent; }
  h1 { font-size: clamp(1.55rem, 4.7vw, 3.85rem); line-height: 1.06; font-weight: 740; letter-spacing: -.045em; overflow-wrap: anywhere; }
  .logo-container { width: min(100%, 390px); }
  .logo-image {
    display: block;
    max-width: 100%;
    max-height: 165px;
    object-fit: contain;
    object-position: left bottom;
    opacity: 0;
    transition: opacity .22s ease;
    filter: drop-shadow(0 4px 8px #0008);
  }
  .logo-image.show { opacity: 1; }

  .media-meta, .release-facts, .genres {
    display: flex;
    align-items: center;
    gap: .35rem .55rem;
    flex-wrap: wrap;
    min-width: 0;
  }
  .release-facts { color: var(--color-text-soft); font-size: clamp(.82rem, 1.4vw, 1.03rem); font-weight: 650; }
  .fact-separator { width: .23em; height: .23em; border-radius: 50%; background: currentColor; }
  .genre-tag { padding: .2rem .53rem; color: var(--color-text-soft); font-size: .78rem; }
  .play-button { display: inline-flex; align-items: center; gap: .4rem; padding-inline: 1.05rem; margin-top: .25rem; }

  .overview-container { grid-template-columns: minmax(0, 1fr); gap: .55rem; position: relative; z-index: 2; }
  .overview-wrapper { line-height: 1.65; overflow: hidden; }
  .overview-wrapper.clamped { max-block-size: 5lh; }
  .overview-wrapper.fade-text { mask-image: linear-gradient(#000 77%, transparent); }
  .overview { color: var(--color-text-soft); line-height: inherit; }
  .overview-loading { display: grid; gap: .55rem; }
  .expand-overview {
    display: inline-flex;
    align-items: center;
    gap: .2rem;
    justify-self: start;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    padding: .15rem 0;
    color: var(--color-primary-soft);
    font-size: .84rem;
  }
  .expand-overview:hover { background: transparent; color: var(--color-text); }

  :is(.media-panel, .children-section > :global(.media-grid-container > .tabs-view > .tab-content)) {
    min-width: 0;
    padding: clamp(.72rem, 1.65vw, 1.2rem);
    background: linear-gradient(
      165deg,
      color-mix(in srgb, var(--color-background-soft) 60%, var(--color-background)),
      color-mix(in srgb, var(--color-background-soft) 30%, var(--color-background)) 72%
    );
    border: 1px solid color-mix(in srgb, var(--color-border-soft) 72%, transparent);
    border-radius: var(--radius-panel);
    box-shadow: var(--edge-light), var(--shadow-standard);
  }
  .hero-banner-section { position: relative; }
  .hero-banner-section .section-title { padding-inline-end: 2rem; }
  .children-section {
    --collection-row-background: transparent;
    --collection-row-border: #ffffff0c;
    --collection-row-shadow: none;
    --collection-row-hover: #ffffff0b;
  }
  .collapsible-section { min-width: 0; padding-top: .6rem; background: var(--section-rule) 0 0 / 100% 1px no-repeat; }
  .contents-status { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: .5rem; color: var(--color-text-soft); }
  .section-title { font-size: clamp(1.05rem, 2vw, 1.3rem); font-weight: 675; margin-bottom: .55rem; }
  .section-title-button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    padding-inline: 0;
  }
  .section-title-button .section-title { margin-bottom: 0; }
  .info-tabs {
    display: flex;
    gap: .28rem;
    max-width: 100%;
    padding: 2px 2px .28rem;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .info-tabs button { flex: none; white-space: nowrap; border-color: transparent; box-shadow: none; background: transparent; color: var(--color-text-soft); padding: .35rem .65rem; }
  .info-tabs button:hover { color: var(--color-text); background: var(--color-hover); }
  .info-tabs button[aria-selected='true'] { background: var(--accent-surface); color: var(--color-primary-soft); border-color: var(--accent-border); }
  .info-panels { position: relative; min-width: 0; }
  .overview-panel.covered { visibility: hidden; }
  .info-popout {
    position: absolute;
    inset: 0 0 auto;
    z-index: 3;
    max-height: var(--info-panel-room, calc(100dvh - 1.5rem));
    min-width: 0;
    padding: .6rem .72rem .75rem;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .info-popout:global(.above-tabs) {
    inset-block-start: auto;
    inset-block-end: calc(100% + var(--info-panel-above-offset, 3rem));
  }
  .info-popout-heading { display: flex; justify-content: space-between; align-items: center; gap: .45rem; margin-bottom: .35rem; }
  .info-popout-heading h2 { font-size: .94rem; font-weight: 675; }
  .collapsible-content { padding-block: .55rem; }
  .full-backdrop-mode :is(
    .overview-container,
    .media-panel,
    .collapsible-section,
    .children-section > :global(.media-grid-container > .tabs-view > .tab-content)
  ) {
    padding: .75rem .85rem;
    background: var(--surface-over-artwork);
    border: 1px solid var(--artwork-edge);
    border-radius: var(--radius-panel);
    box-shadow: var(--edge-light), 0 10px 35px #0005;
  }
  /* The contents panel can be arbitrarily tall. Its artwork is already blurred. */
  .full-backdrop-mode :is(.overview-container, .hero-banner-section, .collapsible-section) {
    backdrop-filter: blur(14px);
  }
  .full-backdrop-mode .info-popout {
    background: linear-gradient(150deg, #252832ec, #111218ed);
    border-color: var(--artwork-edge);
  }
  .missing-banner {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: .45rem;
    padding: .5rem 1rem .5rem calc(1rem + var(--content-inset, 0px));
    background: var(--color-danger);
    font-weight: 650;
  }
  .missing-banner .icon { display: flex; }
  .skeleton-meta-row { display: flex; flex-wrap: wrap; gap: .45rem; }

  @media (max-width: 700px) {
    .info-grid { grid-template-columns: clamp(80px, 29vw, 155px) minmax(0, 1fr); gap: .9rem; }
    .info-column { display: contents; }
    .poster { border-radius: var(--radius-field); }
    .title-and-meta { align-self: center; }
    .logo-image { max-height: 92px; }
    .overview-container { grid-column: 1 / -1; }
    .info-tabs { gap: .22rem; }
    .info-tabs button { padding-inline: .52rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .backdrop-image, .poster img, .logo-image { transition: none; }
  }
</style>
