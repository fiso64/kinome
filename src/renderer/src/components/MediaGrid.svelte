<script lang="ts">
  // Types are globally available from src/preload/index.d.ts
  let { items = [], itemclick }: { items?: LibraryItem[]; itemclick: (item: LibraryItem) => void } =
    $props()
</script>

<div class="media-grid">
  {#if items.length > 0}
    {#each items as item (item.id)}
      <button type="button" class="grid-item" onclick={() => itemclick(item)}>
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
  .media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 1.5rem;
    padding: 1.5rem;
    width: 100%;
    align-content: start;
  }

  .grid-item {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .grid-item:hover .poster {
    transform: scale(1.05);
    background-color: var(--color-background-mute);
  }

  .poster {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background-color: var(--color-background-soft);
    border-radius: 8px;
    width: 100%;
    aspect-ratio: 2 / 3;
    overflow: hidden;
    background-size: cover;
    background-position: center;
    transition:
      transform 0.2s ease,
      background-color 0.2s ease;
  }

  .icon {
    font-size: 4rem;
  }

  .name {
    font-size: 0.9rem;
    font-weight: 600;
    width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
