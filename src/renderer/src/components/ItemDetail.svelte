<script lang="ts">
  import MediaGrid from './MediaGrid.svelte'

  let {
    item,
    onNavigateFolder,
    onPlayFile
  }: {
    item: LibraryItem
    onNavigateFolder: (folder: MediaFolder) => void
    onPlayFile: (file: MediaFile) => void
  } = $props()

  // Create a reactive copy of the item to hold fetched details
  let detailedItem = $state<LibraryItem>(JSON.parse(JSON.stringify(item)))

  $effect(() => {
    // This effect runs only when the `item` prop changes.
    // We create a local, non-reactive copy to use for logic. This prevents
    // the effect from depending on `detailedItem`, which would cause an infinite loop.
    const localCopy = JSON.parse(JSON.stringify(item))
    detailedItem = localCopy

    // Fetch details if the local copy doesn't have them.
    if (!localCopy.backdropPath) {
      window.api.getItemDetails(localCopy.id).then((updatedItem) => {
        // Before updating, ensure the component is still displaying the same item.
        if (updatedItem && updatedItem.id === detailedItem.id) {
          // Update our reactive state. This won't re-trigger this effect.
          Object.assign(detailedItem, updatedItem)
        }
      })
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

<div class="detail-view">
  <div class="backdrop-container">
    {#if detailedItem.backdropPath}
      <img
        src="media-browser-asset://images/{detailedItem.backdropPath}"
        alt=""
        class="backdrop-image"
      />
    {/if}
    <div class="backdrop-overlay"></div>
  </div>

  <div class="detail-content">
    <div class="header">
      <div class="poster">
        {#if detailedItem.posterPath}
          <img src="media-browser-asset://images/{detailedItem.posterPath}" alt="Poster" />
        {:else}
          <div class="icon">
            {detailedItem.type === 'folder' ? '📁' : '📄'}
          </div>
        {/if}
      </div>
      <div class="header-info">
        <h1>{detailedItem.title ?? detailedItem.name}</h1>
        <div class="meta">
          {#if detailedItem.year}
            <span class="year">{detailedItem.year}</span>
          {/if}
          {#if detailedItem.genres && detailedItem.genres.length > 0}
            <div class="genres">
              {#each detailedItem.genres as genre}
                <span class="genre-tag">{genre}</span>
              {/each}
            </div>
          {/if}
        </div>
        {#if detailedItem.type === 'file'}
          <button class="play-button" onclick={() => onPlayFile(detailedItem)}>
            ▶ Play
          </button>
        {/if}
      </div>
    </div>

    {#if detailedItem.overview}
      <p class="overview">{detailedItem.overview}</p>
    {/if}

    {#if detailedItem.type === 'folder' && detailedItem.children.length > 0}
      <div class="children-section">
        <h2>Contents</h2>
        <MediaGrid items={detailedItem.children} itemclick={handleItemClick} viewMode="tree" />
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
