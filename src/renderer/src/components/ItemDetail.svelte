<script lang="ts">
  import MediaGrid from './MediaGrid.svelte'
  import LayoutSelector from './LayoutSelector.svelte'
  import MetadataEditor from './MetadataEditor.svelte'

  let {
    item,
    onNavigateFolder,
    onPlayFile,
    showContextMenu,
    onSearchByTag
  }: {
    item: LibraryItem
    onNavigateFolder: (folder: MediaFolder) => void
    onPlayFile: (file: MediaFile) => void
    showContextMenu: (item: LibraryItem, event: MouseEvent, options?: { layout?: string }) => void
    onSearchByTag: (key: string, value: string) => void
  } = $props()

  // These values help manage the image fade-in animations.
  let isBackdropLoaded = $state(false)
  let isLogoLoaded = $state(item.logoPath ? true : false) // No fade if logo already exists
  let previousBackdropPath = $state(item.backdropPath)
  let previousLogoPath = $state(item.logoPath)

  $effect(() => {
    // This effect runs whenever the `item` prop changes.
    const { id, backdropPath, logoPath } = item

    // Only reset the animation flag if the image source itself is changing.
    if (backdropPath !== previousBackdropPath) {
      isBackdropLoaded = false
      previousBackdropPath = backdropPath
    }
    if (logoPath !== previousLogoPath) {
      if (!previousLogoPath) {
        isLogoLoaded = false
      }
      previousLogoPath = logoPath
    }

    // Fetch details only if a path is explicitly undefined (meaning, we haven't checked yet).
    // This prevents re-fetching when a path is `null` (checked, but none found/deleted).
    if (typeof item.backdropPath === 'undefined' || typeof item.logoPath === 'undefined') {
      window.api.getItemDetails(id)
    }
  })

  function handleItemClick(clickedItem: LibraryItem) {
    if (clickedItem.type === 'folder') {
      onNavigateFolder(clickedItem)
    } else {
      onPlayFile(clickedItem)
    }
  }
</script>

<div class="detail-view" oncontextmenu={(e) => showContextMenu(item, e)}>
  <div class="backdrop-container">
    {#if item.backdropPath}
      <!--
        The 'load' event fires only after the image is decoded.
        We use this to trigger a CSS class that fades the image in,
        ensuring the transition is always smooth.
      -->
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
        {#if item.type === 'file'}
          <button class="play-button" onclick={() => onPlayFile(item)}> ▶ Play </button>
        {/if}
      </div>

      <div class="info-column">
        <div class="title-and-meta">
          {#if item.logoPath}
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
            <h1>{item.title ?? item.name}</h1>
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

    {#if item.type === 'folder' && item.children.length > 0}
      <div class="children-section">
        <h2 class="section-title">Contents</h2>
        <MediaGrid
          parentItem={item}
          items={item.children}
          onItemClick={handleItemClick}
          layout={item.layout ?? 'tree'}
          {showContextMenu}
        />
      </div>
    {/if}
  </div>
</div>

<style>
  .detail-view {
    position: fixed;
    top: var(--header-height); /* Position self below the header */
    bottom: 0;
    left: 0;
    right: 0;
    color: var(--color-text);
    background-color: var(--color-background); /* Cover the content underneath */
    z-index: 5;
    overflow-y: auto; /* The detail view now needs its own scrollbar */
    scrollbar-gutter: stable;
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

  .backdrop-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(4px);
    /* Start invisible and prepare for transition */
    opacity: 0;
    transition: opacity 0.4s ease-in-out;
  }

  .backdrop-image.loaded {
    /* Fade in when the 'loaded' class is applied */
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
      var(--color-background) 15%,
      rgba(0, 0, 0, 0.6) 60%,
      rgba(0, 0, 0, 0.2) 100%
    );
  }

  .detail-content {
    position: relative;
    padding: 1.5rem;
    padding-top: 10vh; /* Push content down less */
    max-width: 1200px; /* Wider content area */
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 3rem; /* More space between sections */
  }

  .info-grid {
    display: grid;
    grid-template-columns: 300px 1fr; /* Larger fixed poster size */
    gap: 2.5rem;
    align-items: start;
  }

  .poster-column {
    position: sticky;
    top: calc(var(--header-height) + 1.5rem); /* Stick below main header */
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
    /* max-height removed to allow natural logo height */
  }

  .logo-image {
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: left bottom;
    filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.7));
    /* Animation */
    opacity: 0;
    transition: opacity 0.5s ease-in-out;
  }

  .logo-image.loaded {
    opacity: 1;
  }

  h1 {
    font-size: 3.5rem;
    font-weight: 800;
    line-height: 1.1;
    letter-spacing: -0.02em;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    color: var(--ev-c-text-2);
  }

  .year {
    font-size: 1.2rem;
    font-weight: 600;
  }

  .genres {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
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
    grid-column: 1 / -1; /* Span full width if it were inside the grid */
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
