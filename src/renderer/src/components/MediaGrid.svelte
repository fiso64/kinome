<script lang="ts">
  // Types are globally available from src/preload/index.d.ts
  let { items = [], itemclick }: { items?: LibraryItem[]; itemclick: (item: LibraryItem) => void } =
    $props()
</script>

<div class="media-grid">
  {#if items.length > 0}
    {#each items as item (item.id)}
      <button
        type="button"
        class="grid-item"
        class:watched={item.type === 'file' && item.watched}
        onclick={() => itemclick(item)}
      >
        {#if item.type === 'file' && item.watched}
          <div class="watched-indicator" title="Watched">✔</div>
        {/if}
        <div class="icon">
          {item.type === 'folder' ? '📁' : '📄'}
        </div>
        <div class="name" title={item.name}>{item.name}</div>
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
    height: 100%;
    overflow-y: auto;
    align-content: start;
  }

  .grid-item {
    border: none;
    font: inherit;
    color: inherit;
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background-color: var(--color-background-soft);
    border-radius: 8px;
    padding: 1rem;
    cursor: pointer;
    transition:
      transform 0.2s ease,
      background-color 0.2s ease,
      opacity 0.2s ease;
    aspect-ratio: 2 / 3; /* Poster-like aspect ratio */
    width: 100%; /* Ensure button takes full grid cell width */
  }

  .grid-item.watched {
    opacity: 0.6;
  }

  .grid-item:hover {
    transform: scale(1.05);
    background-color: var(--color-background-mute);
  }

  .icon {
    font-size: 4rem;
    margin-bottom: 0.5rem;
  }

  .name {
    font-size: 0.9rem;
    text-align: center;
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
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: bold;
    z-index: 1;
  }
</style>
