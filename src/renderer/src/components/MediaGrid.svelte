<script lang="ts">
  import TreeItem from './TreeItem.svelte'
  import MediaGrid from './MediaGrid.svelte' // Self-reference for recursion

  // Types are globally available from src/preload/index.d.ts
  type Layout = 'grid' | 'tree' | 'tabs' | 'sections'

  let {
    parentItem,
    items = [],
    onItemClick,
    layout = 'grid',
    onShowContextMenu,
    searchQuery
  }: {
    parentItem: MediaFolder
    items?: LibraryItem[]
    onItemClick: (item: LibraryItem) => void
    layout?: Layout
    onShowContextMenu: (item: LibraryItem, event: MouseEvent, options?: { layout?: string }) => void
    searchQuery?: { text: string; tags: { key: string; value: string }[] }
  } = $props()

  function normalizeText(text: string): string {
    return (
      text
        .toLowerCase()
        // First, remove any patterns that look like incomplete tags from the text search
        .replace(/:[a-zA-Z0-9_]+:?[^:\s]*/g, ' ')
        .replace(/[.:_,-]/g, ' ') // Replace common punctuation with space
        .replace(/\s+/g, ' ') // Collapse multiple spaces
        .trim()
    )
  }

  function filterItems(
    itemsToFilter: LibraryItem[],
    query?: { text: string; tags: { key: string; value: string }[] }
  ): LibraryItem[] {
    if (!query || (query.text === '' && query.tags.length === 0)) {
      return itemsToFilter
    }

    const normalizedQueryText = normalizeText(query.text)

    return itemsToFilter.filter((item) => {
      // Text search part (AND)
      if (normalizedQueryText) {
        const normalizedItemTitle = normalizeText(item.title ?? item.name)
        if (!normalizedItemTitle.includes(normalizedQueryText)) {
          return false
        }
      }

      // Tag search part (AND)
      if (query.tags.length > 0) {
        for (const tag of query.tags) {
          let tagMatch = false
          if (tag.key === 'genre') {
            tagMatch =
              item.genres?.some((g) => g.toLowerCase() === tag.value.toLowerCase()) ?? false
          } else if (tag.key === 'year') {
            tagMatch = item.year?.toString() === tag.value
          } else if (item.tags) {
            const itemTagValue = item.tags[tag.key]
            if (typeof itemTagValue === 'string') {
              tagMatch = itemTagValue
                .split(',')
                .some((v) => v.trim().toLowerCase() === tag.value.toLowerCase())
            }
          }
          if (!tagMatch) return false // Must match ALL tags
        }
      }

      return true // All conditions passed
    })
  }

  // For grid/tree views, we filter the items.
  // For tabs/sections, we filter the *content* of each tab/section, not the tabs/sections themselves.
  const displayedItems = $derived(
    layout === 'grid' || layout === 'tree' ? filterItems(items, searchQuery) : items
  )

  const sortedTreeItems = $derived(
    [...displayedItems].sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'file' ? -1 : 1 // Files before folders
      }
      // If types are the same, sort by name
      return (a.title ?? a.name).localeCompare(b.title ?? b.name, undefined, {
        numeric: true,
        sensitivity: 'base'
      })
    })
  )

  const folderItems = $derived(
    displayedItems.filter((item) => item.type === 'folder') as MediaFolder[]
  )

  // For tabs, pre-select the first folder tab if available, and reset if it becomes invalid.
  let activeTabId = $state<string | null>(null)

  $effect(() => {
    const currentFolderIds = folderItems.map((f) => f.id)
    if (activeTabId === null || !currentFolderIds.includes(activeTabId)) {
      activeTabId = folderItems[0]?.id ?? null
    }
  })
</script>

{#if layout === 'grid'}
  <div class="media-grid" oncontextmenu={(e) => onShowContextMenu(parentItem, e, { layout })}>
    {#if displayedItems.length > 0}
      {#each displayedItems as item (item.id)}
        <button
          type="button"
          class="grid-item"
          class:watched={item.type === 'file' && item.watched}
          onclick={() => onItemClick(item)}
          oncontextmenu={(e) => onShowContextMenu(item, e, { layout })}
        >
          <div class="poster">
            {#if item.posterPath}
              <img
                src="media-browser-asset://images/{item.posterPath}{item._v ? `?v=${item._v}` : ''}"
                alt={item.title ?? item.name}
                loading="lazy"
              />
            {:else}
              <div class="icon">
                {item.type === 'folder' ? '📁' : '🎬'}
              </div>
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
  <div class="media-tree" oncontextmenu={(e) => onShowContextMenu(parentItem, e, { layout })}>
    {#if sortedTreeItems.length > 0}
      {#each sortedTreeItems as item (item.id)}
        <TreeItem
          {item}
          itemclick={onItemClick}
          showContextMenu={(treeItem, event) => onShowContextMenu(treeItem, event, { layout })}
        />
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
          oncontextmenu={(e) => onShowContextMenu(folder, e, { layout })}
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
              {onItemClick}
              layout={folder.layout ?? 'grid'}
              {onShowContextMenu}
              {searchQuery}
            />
          {/if}
        {/each}
      {:else}
        <p class="empty-message">No folders to display as tabs.</p>
      {/if}
    </div>
  </div>
{:else if layout === 'sections'}
  <div class="sections-view" oncontextmenu={(e) => showContextMenu(parentItem, e, { layout })}>
    {#if folderItems.length > 0}
      {#each folderItems as folder (folder.id)}
        <section class="content-section">
          <h2
            class="section-title"
            onclick={() => onItemClick(folder)}
            oncontextmenu={(e) => onShowContextMenu(folder, e, { layout })}
          >
            {folder.title ?? folder.name}
          </h2>
          <!-- Recurse with the child folder's configured layout, defaulting to grid -->
          <MediaGrid
            parentItem={folder}
            items={folder.children}
            {onItemClick}
            layout={folder.layout ?? 'grid'}
            {onShowContextMenu}
            {searchQuery}
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
    flex: 1; /* Grow to fill available space */
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
    transition:
      transform 0.2s ease,
      background-color 0.2s ease;
  }
  .poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
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
  .grid-item.watched {
    opacity: 0.6;
    transition: opacity 0.2s ease;
  }
  .grid-item.watched:hover {
    opacity: 1;
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
