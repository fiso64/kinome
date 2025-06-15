<script lang="ts">
  import TreeItem from './TreeItem.svelte'
  import MediaGrid from './MediaGrid.svelte' // Self-reference for recursion

  // Types are globally available from src/preload/index.d.ts
  type Layout = 'grid' | 'tree' | 'tabs' | 'sections'

  let {
    parentItem,
    items = [],
    itemclick,
    layout = 'grid',
    showContextMenu
  }: {
    parentItem: MediaFolder
    items?: LibraryItem[]
    itemclick: (item: LibraryItem) => void
    layout?: Layout
    showContextMenu: (item: LibraryItem, event: MouseEvent) => void
  } = $props()

  const folderItems = $derived(items.filter((item) => item.type === 'folder') as MediaFolder[])
  const fileItems = $derived(items.filter((item) => item.type === 'file'))

  // For tabs, pre-select the first folder tab if available
  let activeTabId = $state(folderItems[0]?.id ?? null)
</script>

{#if layout === 'grid'}
  <div class="media-grid" oncontextmenu={(e) => showContextMenu(parentItem, e)}>
    {#if items.length > 0}
      {#each items as item (item.id)}
        <button
          type="button"
          class="grid-item"
          onclick={() => itemclick(item)}
          oncontextmenu={(e) => showContextMenu(item, e)}
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
      <p class="empty-message">This folder is empty.</p>
    {/if}
  </div>
{:else if layout === 'tree'}
  <div class="media-tree" oncontextmenu={(e) => showContextMenu(parentItem, e)}>
    {#if items.length > 0}
      {#each items as item (item.id)}
        <TreeItem {item} {itemclick} {showContextMenu} />
      {/each}
    {:else}
      <p class="empty-message">This folder is empty.</p>
    {/if}
  </div>
{:else if layout === 'tabs'}
  <div class="tabs-view">
    <div class="tab-list">
      {#each folderItems as folder (folder.id)}
        <button
          class="tab"
          class:active={activeTabId === folder.id}
          onclick={() => (activeTabId = folder.id)}
          oncontextmenu={(e) => showContextMenu(folder, e)}
        >
          {folder.title ?? folder.name}
        </button>
      {/each}
    </div>
    <div class="tab-content">
      {#if folderItems.length > 0}
        {#each folderItems as folder (folder.id)}
      {#if activeTabId === folder.id}
        <!-- Recurse with the child folder's configured layout, defaulting to grid -->
        <MediaGrid
          parentItem={folder}
          items={folder.children}
          {itemclick}
          layout={folder.layout ?? 'grid'}
          {showContextMenu}
        />
      {/if}
        {/each}
      {:else}
        <p class="empty-message">No folders to display as tabs.</p>
      {/if}
    </div>
  </div>
{:else if layout === 'sections'}
  <div class="sections-view" oncontextmenu={(e) => showContextMenu(parentItem, e)}>
    {#if folderItems.length > 0}
      {#each folderItems as folder (folder.id)}
        <section class="content-section">
          <h2
            class="section-title"
            onclick={() => itemclick(folder)}
            oncontextmenu={(e) => showContextMenu(folder, e)}
          >
            {folder.title ?? folder.name}
          </h2>
          <!-- Recurse with the child folder's configured layout, defaulting to grid -->
          <MediaGrid
            parentItem={folder}
            items={folder.children}
            {itemclick}
            layout={folder.layout ?? 'grid'}
            {showContextMenu}
          />
        </section>
      {/each}
    {:else}
      <p class="empty-message">No folders to display as sections.</p>
    {/if}
  </div>
{/if}

<style>
  .empty-message {
    padding: 1.5rem;
    color: var(--ev-c-text-2);
  }

  /* --- VIEW CONTAINERS --- */
  .media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 1.8rem;
    padding: 1.5rem;
    width: 100%;
    align-content: start;
  }
  .media-tree {
    display: flex;
    flex-direction: column;
    padding: 0 0.5rem; /* Give some space for the tree */
  }

  /* --- ITEM BUTTONS (Grid only) --- */
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
    width: 100%;
  }
  .grid-item:hover .poster {
    transform: scale(1.05);
    background-color: var(--color-background-mute);
  }

  /* --- ITEM COMPONENTS (Grid only) --- */
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

  /* --- TABS LAYOUT --- */
  .tabs-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .tab-list {
    display: flex;
    flex-wrap: wrap;
    border-bottom: 2px solid var(--color-background-mute);
    padding: 0 1.5rem;
    flex-shrink: 0;
  }
  .tab {
    padding: 0.8rem 1.2rem;
    cursor: pointer;
    background: none;
    border: none;
    color: var(--ev-c-text-2);
    font-size: 1rem;
    font-weight: 600;
    border-bottom: 3px solid transparent;
    margin-bottom: -2px; /* Overlap the container's border */
    transition:
      color 0.2s,
      border-color 0.2s;
  }
  .tab:hover {
    color: var(--ev-c-text-1);
  }
  .tab.active {
    color: var(--ev-c-text-1);
    border-bottom-color: var(--ev-c-white-soft);
  }
  .tab-content {
    flex-grow: 1;
    overflow-y: auto; /* Important: content within a tab must scroll independently */
  }

  /* --- SECTIONS LAYOUT --- */
  .sections-view {
    padding: 1rem 0;
  }
  .content-section {
    margin-bottom: 2rem;
  }
  .section-title {
    font-size: 1.5rem;
    font-weight: bold;
    margin: 0 1.5rem 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--color-background-mute);
    cursor: pointer;
  }
  .section-title:hover {
    color: var(--ev-c-white-soft);
  }
</style>
