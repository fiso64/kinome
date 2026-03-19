<script lang="ts">
  import FolderTree from '@components/ui/FolderTree.svelte'
  import type { LibraryItem } from '@shared/types'

  interface FolderNode {
    id: string
    name: string
    title?: string | null
    mediaType?: string | null
    isExpanded: boolean
    children: FolderNode[] | null
    isLoading: boolean
    retrieveChildrenMetadata: boolean
    childrenTypeHint: 'auto' | 'movie' | 'tv'
  }

  let rootNodes = $state<FolderNode[]>([])
  let isInitializing = $state(true)

  function itemToNode(item: LibraryItem): FolderNode {
    return {
      id: item.id,
      name: item.name,
      title: item.title,
      mediaType: item.mediaType,
      isExpanded: false,
      children: null,
      isLoading: false,
      retrieveChildrenMetadata: (item as any).folderSettings?.retrieveChildrenMetadata ?? false,
      childrenTypeHint: (item as any).folderSettings?.childrenTypeHint ?? 'auto'
    }
  }

  async function loadRoot() {
    isInitializing = true
    try {
      const rootItem = await window.api.getItem('root', {
        fields: ['id', 'name', 'title', 'type', 'mediaType', 'retrieveChildrenMetadata', 'childrenTypeHint', 'processTvChildren'],
      })
      if (rootItem) {
        rootNodes = [itemToNode(rootItem)]
      }
    } catch (err) {
      console.error('Failed to load library tree:', err)
    } finally {
      isInitializing = false
    }
  }

  async function toggleExpand(node: FolderNode) {
    if (node.isExpanded) {
      node.isExpanded = false
      return
    }
    node.isExpanded = true
    if (!node.children && !node.isLoading) {
      node.isLoading = true
      try {
        const children = await window.api.getChildren(node.id, {
          fields: ['id', 'name', 'title', 'type', 'mediaType', 'retrieveChildrenMetadata', 'childrenTypeHint', 'processTvChildren'],
        })
        node.children = children.filter(c => c.type === 'folder').map(itemToNode)
      } catch (err) {
        console.error(`Failed to load children for ${node.id}:`, err)
      } finally {
        node.isLoading = false
      }
    }
  }

  async function saveSettings(node: FolderNode) {
    await window.api.userUpdateItem({
      id: node.id,
      folderSettings: {
        retrieveChildrenMetadata: node.retrieveChildrenMetadata,
        childrenTypeHint: node.childrenTypeHint === 'auto' ? null : node.childrenTypeHint,
      },
    } as any)
  }

  $effect(() => {
    loadRoot()
  })
</script>

<FolderTree
  nodes={rootNodes}
  {isInitializing}
  loadingText="Loading library folders..."
  emptyText="No folders in library."
  emptyChildrenText="No subfolders"
  onToggle={toggleExpand}
>
  {#snippet label(node: FolderNode)}
    <span class="name">{node.title || node.name}</span>
    {#if node.mediaType}
      <span class="media-type-badge">{node.mediaType}</span>
    {/if}
  {/snippet}

  {#snippet controls(node: FolderNode)}
    <select
      bind:value={node.childrenTypeHint}
      class="type-select"
      disabled={!node.retrieveChildrenMetadata}
      onchange={() => saveSettings(node)}
    >
      <option value="auto">Auto-detect</option>
      <option value="movie">Movies</option>
      <option value="tv">TV Shows</option>
    </select>

    <label class="checkbox-label">
      <input type="checkbox" bind:checked={node.retrieveChildrenMetadata}
        onchange={() => saveSettings(node)} />
      <span>Fetch for children</span>
    </label>
  {/snippet}
</FolderTree>

<style>
  .name {
    flex: 1;
    font-size: 0.9rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .media-type-badge {
    font-size: 0.7rem;
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--ev-c-text-3);
    flex-shrink: 0;
  }
  .type-select {
    font-size: 0.8rem;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .type-select:disabled { opacity: 0.5; cursor: not-allowed; }
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: var(--ev-c-text-3);
    cursor: pointer;
    white-space: nowrap;
  }
  .checkbox-label input { cursor: pointer; }
</style>
