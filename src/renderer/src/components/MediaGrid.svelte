<script lang="ts">
  // Types are globally available from src/preload/index.d.ts
  let {
    items = [],
    itemclick,
    viewMode = 'grid'
  }: {
    items?: LibraryItem[]
    itemclick: (item: LibraryItem) => void
    viewMode?: 'grid' | 'list'
  } = $props()
</script>

<div class:media-grid={viewMode === 'grid'} class:media-list={viewMode === 'list'}>
  {#if items.length > 0}
    {#each items as item (item.id)}
      <button
        type="button"
        class={viewMode === 'grid' ? 'grid-item' : 'list-item'}
        onclick={() => itemclick(item)}
      >
        <div
          class="poster"
          style:background-image={item.posterPath
            ? `url(media-browser-asset://images/${item.posterPath})`
            : 'none'}
        >
          {#if !item.posterPath}
            <div class="icon">
              {item.type === 'folder' ? '📁' : '📄'}
            </div>
          {/if}

          {#if item.type === 'file' && item.watched}
            <div class="watched-indicator" title="Watched">✔</div>
          {/if}
        </div>
        <div class="name" title={item.title ?? item.name}>
          {item.title ?? item.name}
        </div>
      </button>
    {/each}
  {:else}
    <p>This folder is empty.</p>
  {/if}
</div>

<style>
  /* --- VIEW CONTAINERS --- */
  .media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 1.5rem;
    padding: 1.5rem;
    width: 100%;
    align-content: start;
  }
  .media-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* --- ITEM BUTTONS --- */
  .grid-item,
  .list-item {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
    display: flex;
    gap: 0.5rem;
    width: 100%;
  }

  /* Grid Item */
  .grid-item {
    flex-direction: column;
  }
  .grid-item:hover .poster {
    transform: scale(1.05);
    background-color: var(--color-background-mute);
  }

  /* List Item */
  .list-item {
    align-items: center;
    padding: 0.5rem;
    border-radius: 6px;
  }
  .list-item:hover {
    background-color: var(--color-background-soft);
  }

  /* --- ITEM COMPONENTS --- */
  .poster {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background-color: var(--color-background-soft);
    border-radius: 8px;
    overflow: hidden;
    background-size: cover;
    background-position: center;
    transition:
      transform 0.2s ease,
      background-color 0.2s ease;
  }

  .grid-item .poster {
    width: 100%;
    aspect-ratio: 2 / 3;
  }
  .list-item .poster {
    width: 40px;
    height: 60px;
    flex-shrink: 0;
  }

  .icon {
    font-size: 4rem; /* Default for grid */
  }
  .list-item .icon {
    font-size: 2rem;
  }

  .name {
    font-weight: 600;
    width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.9rem; /* Default for grid */
  }
  .list-item .name {
    flex-grow: 1;
    font-size: 1rem;
  }

  .watched-indicator {
    position: absolute;
    top: 8px;
    right: 8px;
    background-color: #4caf50;
    color: white;
    border-radius: 50%;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: bold;
    z-index: 1;
  }
</style>
