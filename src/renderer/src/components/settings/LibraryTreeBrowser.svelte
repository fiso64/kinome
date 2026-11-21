<script module lang="ts">
  import type { FolderSettings } from '@shared/types'

  type FolderMetadata = Pick<FolderSettings, 'retrieveChildrenMetadata' | 'childrenTypeHint'>
  export type FolderDrafts = Record<string, { saved: FolderMetadata; current: FolderMetadata }>
</script>

<script lang="ts">
  import { authStore } from '@lib/auth-store.svelte'
  import FolderTree from '@components/ui/FolderTree.svelte'
  import { LIBRARY_ROOT_ID, type LibraryItem } from '@shared/types'
  import { notificationStore } from '@lib/notification-store.svelte'

  interface FolderNode {
    id: string
    name: string
    title?: string | null
    mediaType?: string | null
    isExpanded: boolean
    children: FolderNode[] | null
    isLoading: boolean
    metadata: FolderMetadata
  }

  let { folderDrafts = $bindable() }: { folderDrafts: FolderDrafts } = $props()

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
      metadata: {
        retrieveChildrenMetadata: item.folderSettings?.retrieveChildrenMetadata ?? false,
        childrenTypeHint: item.folderSettings?.childrenTypeHint === 'auto' ? null : item.folderSettings?.childrenTypeHint ?? null
      }
    }
  }

  async function loadRoot() {
    isInitializing = true
    try {
      const rootItem = await window.api.getItem(LIBRARY_ROOT_ID, {
        fields: ['id', 'name', 'title', 'type', 'mediaType', 'retrieveChildrenMetadata', 'childrenTypeHint', 'processTvChildren'],
      })
      if (rootItem) {
        rootNodes = [itemToNode(rootItem)]
      }
    } catch (err: any) {
      console.error('Failed to load library tree:', err)
      notificationStore.add(err.message || 'Failed to load library tree.', 'error')
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
        node.children = children.filter(c => c.type === 'folder' && !c.isVirtual).map(itemToNode)
      } catch (err: any) {
        console.error(`Failed to load children for ${node.id}:`, err)
        notificationStore.add(err.message || 'Failed to load subfolders.', 'error')
      } finally {
        node.isLoading = false
      }
    }
  }

  function editMetadata(node: FolderNode, patch: Partial<FolderMetadata>) {
    const { saved, current } = folderDrafts[node.id] ?? { saved: node.metadata, current: node.metadata }
    folderDrafts[node.id] = { saved, current: { ...current, ...patch } }
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
    <span class="folder-name">{node.title || node.name}</span>
    {#if node.mediaType}
      <span class="folder-kind">{node.mediaType}</span>
    {/if}
  {/snippet}

  {#snippet controls(node: FolderNode)}
    {@const metadata = folderDrafts[node.id]?.current ?? node.metadata}
    <select
      value={metadata.childrenTypeHint ?? 'auto'}
      class="folder-type" aria-label={`Media type for ${node.title || node.name}`}
      {...authStore.control('editMetadata')}
      disabled={!authStore.can.editMetadata || !metadata.retrieveChildrenMetadata}
      onchange={(event) => {
        const value = event.currentTarget.value
        editMetadata(node, { childrenTypeHint: value === 'movie' || value === 'tv' ? value : null })
      }}
    >
      <option value="auto">Auto-detect</option>
      <option value="movie">Movies</option>
      <option value="tv">TV Shows</option>
    </select>

    <label class="folder-fetch">
      <input type="checkbox" checked={metadata.retrieveChildrenMetadata} {...authStore.control('editMetadata')}
        onchange={(event) => editMetadata(node, { retrieveChildrenMetadata: event.currentTarget.checked })} />
      <span>Fetch for children</span>
    </label>
  {/snippet}
</FolderTree>
