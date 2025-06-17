<script lang="ts">
  import TreeItem from './TreeItem.svelte'
  import MediaGrid from './MediaGrid.svelte' // Self-reference for recursion

  type Layout = 'grid' | 'tree' | 'tabs' | 'sections'
  type DisplayableItem = LibraryItem | SearchIndexEntry
  type VirtualFolder = MediaFolder & {
    isVirtual: boolean
    physicalParentId: string
    groupByKey: string
    groupByValue: string
  }

  let {
    parentItem,
    items = [],
    onItemClick,
    layout: layoutProp,
    onShowContextMenu,
    searchQuery,
    suggestions
  }: {
    parentItem?: MediaFolder | VirtualFolder
    items: DisplayableItem[]
    onItemClick: (item: DisplayableItem) => void
    layout?: Layout
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string }
    ) => void
    searchQuery?: { text: string; tags: { key: string; value: string }[] }
    suggestions?: AutocompleteSuggestions
  } = $props()

  const layout = $derived(layoutProp ?? parentItem?.layout ?? 'grid')

  // --- Helpers ---
  function normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/:[a-zA-Z0-9_]+:?[^:\s]*/g, ' ')
      .replace(/[.:_,-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function filterItems(
    itemsToFilter: DisplayableItem[],
    query: { text: string; tags: { key: string; value: string }[] }
  ): DisplayableItem[] {
    if (!query || (query.text === '' && query.tags.length === 0)) {
      return itemsToFilter
    }
    const normalizedQueryText = normalizeText(query.text)
    return itemsToFilter.filter((item) => {
      const itemTitle = item.title ?? ('name' in item ? (item as LibraryItem).name : '')
      if (normalizedQueryText && !normalizeText(itemTitle).includes(normalizedQueryText)) {
        return false
      }
      if (query.tags.length > 0) {
        for (const tag of query.tags) {
          let tagMatch = false
          if (tag.key === 'genre') {
            tagMatch =
              item.genres?.some((g) => g.toLowerCase() === tag.value.toLowerCase()) ?? false
          } else if (tag.key === 'year') {
            tagMatch = item.year?.toString() === tag.value
          } else if (
            item.virtualTags &&
            Object.prototype.hasOwnProperty.call(item.virtualTags, tag.key)
          ) {
            tagMatch = item.virtualTags[tag.key]?.toLowerCase() === tag.value.toLowerCase()
          } else if (item.tags) {
            const itemTagValue = item.tags[tag.key]
            if (typeof itemTagValue === 'string') {
              tagMatch = itemTagValue
                .split(',')
                .some((v) => v.trim().toLowerCase() === tag.value.toLowerCase())
            }
          }
          if (!tagMatch) return false
        }
      }
      return true
    })
  }

  function getValuesForKey(item: DisplayableItem, key: string): string[] {
    if (key === 'mediaType') return item.mediaType ? [item.mediaType] : []
    if (key === 'genre') return item.genres ?? []
    if (key === 'year') return item.year ? [item.year.toString()] : []
    if (key.startsWith('tags.')) {
      const tagKey = key.substring(5)
      const tagValue = item.tags?.[tagKey]
      return tagValue ? tagValue.split(',').map((v) => v.trim()) : []
    }
    if (key.startsWith('vt.')) {
      const vtKey = key.substring(3)
      const vtValue = item.virtualTags?.[vtKey]
      return vtValue ? [vtValue] : []
    }
    return []
  }

  // --- Derived State ---
  const { displayedItems, virtualFolders } = $derived.by(() => {
    const filteredItems = filterItems(items, searchQuery ?? { text: '', tags: [] })

    if (
      parentItem &&
      (layout === 'tabs' || layout === 'sections') &&
      parentItem.groupBy &&
      parentItem.groupBy !== 'folder'
    ) {
      const groupByKey = parentItem.groupBy
      const groups: Record<string, DisplayableItem[]> = {}
      for (const item of filteredItems) {
        const values = getValuesForKey(item, groupByKey)
        if (values.length === 0) {
          if (!groups['Uncategorized']) groups['Uncategorized'] = []
          groups['Uncategorized'].push(item)
        } else {
          for (const value of values) {
            if (!groups[value]) groups[value] = []
            groups[value].push(item)
          }
        }
      }
      const vFolders = Object.entries(groups)
        .map(([groupValue, groupItems]) => {
          const virtualSettings = parentItem.virtualFolderSettings?.[groupByKey]?.[groupValue] ?? {}
          const virtualFolder: VirtualFolder = {
            id: `virtual--${parentItem.id}--${groupByKey}--${groupValue}`,
            name: groupValue,
            title: virtualSettings.title ?? groupValue,
            type: 'folder',
            children: groupItems as LibraryItem[],
            path: '',
            isVirtual: true,
            physicalParentId: parentItem.id,
            groupByKey: groupByKey,
            groupByValue: groupValue,
            ...virtualSettings
          }
          return virtualFolder
        })
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      // In tabs/sections view, the filtering happens inside the recursive MediaGrid call,
      // so we pass the original unfiltered items down. The sections themselves are built from filtered items.
      return { displayedItems: items, virtualFolders: vFolders }
    }
    return { displayedItems: filteredItems, virtualFolders: null }
  })

  const sortedTreeItems = $derived(
    [...displayedItems].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? 1 : -1
      const aTitle = a.title ?? ('name' in a ? (a as LibraryItem).name : '')
      const bTitle = b.title ?? ('name' in b ? (b as LibraryItem).name : '')
      return aTitle.localeCompare(bTitle, undefined, { numeric: true })
    })
  )

  const physicalFolderItems = $derived(
    displayedItems.filter((item) => item.type === 'folder') as MediaFolder[]
  )

  const foldersForTabsOrSections = $derived(virtualFolders ?? physicalFolderItems)

  let activeTabId = $state<string | null>(null)
  $effect(() => {
    const currentFolders = foldersForTabsOrSections
    const currentFolderIds = currentFolders.map((f) => f.id)
    if (activeTabId === null || !currentFolderIds.includes(activeTabId)) {
      activeTabId = currentFolders[0]?.id ?? null
    }
  })

  $effect(() => {
    if (layout !== 'tabs') return

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (isInput) return

      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        const folders = foldersForTabsOrSections
        if (!folders || folders.length < 2) return

        const currentIndex = folders.findIndex((f) => f.id === activeTabId)
        if (currentIndex === -1) return

        const nextIndex = event.shiftKey
          ? (currentIndex - 1 + folders.length) % folders.length
          : (currentIndex + 1) % folders.length

        activeTabId = folders[nextIndex].id
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  })
</script>

{#if layout === 'grid'}
  <div
    class="media-grid"
    oncontextmenu={parentItem ? (e) => onShowContextMenu(parentItem, e, { layout }) : undefined}
  >
    {#if displayedItems.length > 0}
      {#each displayedItems as item (item.id)}
        {@const title = item.title ?? ('name' in item ? (item as LibraryItem).name : '')}
        <button
          type="button"
          class="grid-item"
          class:watched={'watched' in item && item.watched}
          onclick={() => onItemClick(item)}
          oncontextmenu={(e) => onShowContextMenu(item, e, { layout })}
        >
          <div class="poster">
            {#if item.posterPath}
              <img
                src="media-browser-asset://images/{item.posterPath}{item._v ? `?v=${item._v}` : ''}"
                alt={title}
                loading="lazy"
              />
            {:else}
              <div class="icon">
                {item.type === 'folder' ? '📁' : '🎬'}
              </div>
            {/if}
          </div>
          <div class="name" {title}>
            {title}
          </div>
        </button>
      {/each}
    {:else}
      <p class="empty-message">No items match your filter.</p>
    {/if}
  </div>
{:else if layout === 'tree'}
  <div
    class="media-tree"
    oncontextmenu={parentItem ? (e) => onShowContextMenu(parentItem, e, { layout }) : undefined}
  >
    {#if sortedTreeItems.length > 0}
      {#each sortedTreeItems as item (item.id)}
        <TreeItem
          item={item as LibraryItem}
          itemclick={onItemClick as (item: LibraryItem) => void}
          showContextMenu={(treeItem, event) => onShowContextMenu(treeItem, event, { layout })}
        />
      {/each}
    {:else}
      <p class="empty-message">No items match your filter.</p>
    {/if}
  </div>
{:else if layout === 'tabs'}
  {@const folders = foldersForTabsOrSections}
  <div
    class="tabs-view"
    oncontextmenu={parentItem ? (e) => onShowContextMenu(parentItem, e, { layout }) : undefined}
  >
    <div class="tab-list">
      {#each folders as folder (folder.id)}
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
      {#if folders.length > 0}
        {#each folders as folder (folder.id)}
          {#if activeTabId === folder.id}
            <MediaGrid
              parentItem={folder}
              items={folder.children}
              {onItemClick}
              layout={folder.layout ?? 'grid'}
              {onShowContextMenu}
              {suggestions}
            />
          {/if}
        {/each}
      {:else}
        <p class="empty-message">No folders to display as tabs.</p>
      {/if}
    </div>
  </div>
{:else if layout === 'sections'}
  {@const folders = foldersForTabsOrSections}
  <div
    class="sections-view"
    oncontextmenu={parentItem ? (e) => onShowContextMenu(parentItem, e, { layout }) : undefined}
  >
    {#if folders.length > 0}
      {#each folders as folder (folder.id)}
        <section class="content-section">
          <h2
            class="section-title"
            onclick={() => onItemClick(folder)}
            oncontextmenu={(e) => onShowContextMenu(folder, e, { layout })}
          >
            {folder.title ?? folder.name}
          </h2>
          <MediaGrid
            parentItem={folder}
            items={folder.children}
            {onItemClick}
            layout={folder.layout ?? 'grid'}
            {onShowContextMenu}
            {suggestions}
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
    flex: 1;
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
  .grid-item:hover {
    background-color: transparent; /* Override global button hover */
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
    justify-content: center;
    background-color: var(--color-background);
    padding: 1rem 1.5rem;
    flex-shrink: 0;
    gap: 1rem;
  }
  .tab {
    padding: 0.75rem 1.5rem;
    cursor: pointer;
    background-color: var(--color-background-soft);
    border: 1px solid transparent;
    border-radius: 20px;
    color: var(--ev-c-text-2);
    font-size: 0.9rem;
    font-weight: 600;
    transition:
      color 0.2s,
      background-color 0.2s,
      border-color 0.2s;
  }
  .tab:hover {
    color: var(--ev-c-text-1);
    background-color: var(--ev-c-gray-3);
  }
  .tab.active {
    color: var(--ev-c-text-1);
    background-color: var(--ev-c-gray-2);
    border-color: var(--ev-c-gray-1);
  }
  .tab-content {
    flex-grow: 1;
    overflow-y: auto; /* Important: content within a tab must scroll independently */
  }

  /* --- SECTIONS LAYOUT --- */
  .sections-view {
    padding: 1rem 0;
    flex: 1;
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
