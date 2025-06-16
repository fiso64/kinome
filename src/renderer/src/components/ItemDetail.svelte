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

  // These values help manage the backdrop fade-in animation.
  let isBackdropLoaded = $state(false)
  let previousBackdropPath = $state(item.backdropPath)

  $effect(() => {
    // This effect runs whenever the `item` prop changes.
    const { id, backdropPath } = item

    // Only reset the animation flag if the image source itself is changing.
    if (backdropPath !== previousBackdropPath) {
      isBackdropLoaded = false
      previousBackdropPath = backdropPath
    }

    // Fetch details if they are missing. The main process will then send a
    // 'library-item-updated' event which App.svelte handles, causing this
    // component to re-render with the new data.
    if (!backdropPath) {
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
    <div class="header">
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
      <div class="header-info">
        <h1>{item.title ?? item.name}</h1>
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
        {#if item.type === 'file'}
          <button class="play-button" onclick={() => onPlayFile(item)}>
            ▶ Play
          </button>
        {/if}
      </div>
    </div>

    {#if item.overview}
      <p class="overview">{item.overview}</p>
    {/if}

    {#if item.type === 'folder' && item.children.length > 0}
      <div class="children-section">
        <h2>Contents</h2>
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
      var(--color-background) 5%,
      rgba(0, 0, 0, 0.6) 50%,
      rgba(0, 0, 0, 0.2) 100%
    );
  }

  .detail-content {
    position: relative;
    padding: 1.5rem;
    padding-top: 15vh; /* Push content down from top */
    max-width: 100ch;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .header {
    display: flex;
    gap: 1.5rem;
    align-items: flex-end;
  }

  .poster {
    width: 200px;
    flex-shrink: 0;
    aspect-ratio: 2 / 3;
    background-color: var(--color-background-soft);
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
  }

  .poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .poster .icon {
    font-size: 4rem;
  }

  .header-info {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    align-self: flex-end;
    flex-grow: 1;
  }

  h1 {
    font-size: 2.5rem;
    font-weight: bold;
    line-height: 1.1;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    color: var(--ev-c-text-2);
  }

  .year {
    font-size: 1.1rem;
    font-weight: 600;
  }

  .genres {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .genre-tag {
    background-color: rgba(255, 255, 255, 0.1);
    padding: 0.2rem 0.6rem;
    border-radius: 12px;
    font-size: 0.8rem;
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
    background-color: var(--ev-c-white-soft);
    color: var(--ev-c-black);
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 20px;
    font-weight: bold;
    cursor: pointer;
    font-size: 1rem;
    transition: transform 0.2s ease;
  }
  .play-button:hover {
    transform: scale(1.05);
  }

  .context-menu {
    position: fixed; /* Position relative to the viewport */
    background-color: var(--ev-c-black-soft);
    border: 1px solid var(--ev-c-black-mute);
    border-radius: 6px;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
    z-index: 1000; /* Ensure it's on top of everything */
    width: max-content;
    overflow: hidden;
  }

  .context-menu-item {
    display: block;
    width: 100%;
    padding: 0.75rem 1.25rem;
    background: none;
    border: none;
    color: var(--color-text);
    text-align: left;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .context-menu-item:hover {
    background-color: var(--ev-c-gray-2);
  }

  .overview {
    line-height: 1.6;
    max-width: 75ch; /* Good reading length */
  }

  .children-section {
    margin-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  h2 {
    font-size: 1.5rem;
    font-weight: bold;
    border-bottom: 1px solid var(--color-background-mute);
    padding-bottom: 0.5rem;
  }
</style>
