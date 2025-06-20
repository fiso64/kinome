<script lang="ts">
  import MediaView from './MediaView.svelte'

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

  import { resolveViewSettings } from '../../../shared/settings-helpers'

  const contentsLayout = $derived(resolveViewSettings(item as MediaFolder, settings).layout)

  const showRegularContents = $derived(item.type === 'folder' && item.children.length > 0)

  // These values help manage the individual image fade-in animations.
  let isBackdropLoaded = $state(false)
  let isLogoLoaded = $state(false)
  let previousBackdropPath = $state<string | null | undefined>(undefined)
  let previousLogoPath = $state<string | null | undefined>(undefined)

  $effect(() => {
    // This effect runs when the `item` prop changes.
    // Note: The main detail fetch is now handled in `App.svelte` before this component is rendered.
    // Child content (like season episodes) is fetched on demand by child components (`TabsView`, etc.).

    // Reset fade-in animation flags if the image source itself has changed.
    // This prevents a re-fade if other metadata is updated.
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

<!-- No more complex loading state needed here. The view renders immediately. -->
<div class="detail-view" oncontextmenu={(e) => showContextMenu(item, e)}>
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
        {#if item.overview}
          <div class="overview-container">
            <h2 class="section-title">Overview</h2>
            <p class="overview">{item.overview}</p>
          </div>
        {/if}
      </div>
    </div>

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
    position: sticky;
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
    gap: 0.75rem;
  }

  .overview {
    line-height: 1.7;
    color: var(--ev-c-text-2);
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
</style>
