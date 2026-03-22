<script lang="ts">
  import { onMount } from 'svelte'
  import ModalWindow from './_base/ModalWindow.svelte'
  import { useDragSort } from '@lib/drag-sort.svelte'
  import type { LibraryItem, MediaFolder } from '@shared/types'
  import { flip } from 'svelte/animate'
  import { notificationStore } from '@lib/notification-store.svelte'

  let {
    item,
    initialSortTop,
    initialSortBottom,
    onClose,
    onSaved
  }: {
    item: MediaFolder
    initialSortTop?: string[]
    initialSortBottom?: string[]
    onClose: () => void
    onSaved?: (sortTop: string[], sortBottom: string[]) => void
  } = $props()

  let loading = $state(true)
  let allChildren = $state<LibraryItem[]>([])
  let sortTopIds = $state<string[]>([...(initialSortTop ?? item.viewSettings?.sortTop ?? [])])
  let sortBottomIds = $state<string[]>([...(initialSortBottom ?? item.viewSettings?.sortBottom ?? [])])

  const topSet = $derived(new Set(sortTopIds))
  const bottomSet = $derived(new Set(sortBottomIds))

  const sortTopItems = $derived(
    sortTopIds.flatMap((id) => {
      const found = allChildren.find((c) => c.id === id)
      return found ? [found] : []
    })
  )

  const sortBottomItems = $derived(
    sortBottomIds.flatMap((id) => {
      const found = allChildren.find((c) => c.id === id)
      return found ? [found] : []
    })
  )

  const middleItems = $derived(
    allChildren.filter((c) => !topSet.has(c.id) && !bottomSet.has(c.id))
  )

  onMount(async () => {
    try {
      const result = await window.api.getChildren(item.id, {})
      if (Array.isArray(result)) {
        allChildren = result
        // Drop stale IDs from pin lists (deleted/moved children)
        const validIds = new Set(result.map((c) => c.id))
        sortTopIds = sortTopIds.filter((id) => validIds.has(id))
        sortBottomIds = sortBottomIds.filter((id) => validIds.has(id))
      }
    } catch (err: any) {
      notificationStore.add(err.message || 'Failed to load children.', 'error')
    } finally {
      loading = false
    }
  })

  // --- Drag state ---

  const topDrag = useDragSort(
    () => sortTopIds,
    (items) => (sortTopIds = items)
  )
  const bottomDrag = useDragSort(
    () => sortBottomIds,
    (items) => (sortBottomIds = items)
  )

  // --- Cross-section movement ---

  function pinToTop(id: string) {
    sortBottomIds = sortBottomIds.filter((x) => x !== id)
    if (!sortTopIds.includes(id)) sortTopIds = [...sortTopIds, id]
  }

  function pinToBottom(id: string) {
    sortTopIds = sortTopIds.filter((x) => x !== id)
    if (!sortBottomIds.includes(id)) sortBottomIds = [...sortBottomIds, id]
  }

  function unpinFromTop(id: string) {
    sortTopIds = sortTopIds.filter((x) => x !== id)
  }

  function unpinFromBottom(id: string) {
    sortBottomIds = sortBottomIds.filter((x) => x !== id)
  }

  // --- Save ---

  async function handleSave() {
    const top = sortTopIds.length ? sortTopIds : null
    const bottom = sortBottomIds.length ? sortBottomIds : null
    try {
      await window.api.userUpdateItem({
        id: item.id,
        viewSettings: {
          sortTop: top,
          sortBottom: bottom
        }
      })
    } catch (err: any) {
      notificationStore.add(err.message || 'Failed to save sort order.', 'error')
      return
    }
    onSaved?.(top ?? [], bottom ?? [])
    onClose()
  }

  function displayName(child: LibraryItem): string {
    return (child as any).title ?? child.name
  }
</script>

<ModalWindow title="Sort Order" {onClose} onSave={handleSave} maxWidth="480px">
  {#if loading}
    <div class="loading">Loading...</div>
  {:else}
    <div class="sort-editor">
      <!-- Sort Top -->
      <div class="pin-section">
        <div class="section-header">
          <span class="section-label">Always First</span>
          {#if sortTopItems.length > 0}
            <span class="count">{sortTopItems.length}</span>
          {/if}
        </div>
        {#if sortTopItems.length === 0}
          <div class="empty-state">No items pinned — use ↑ below to pin items to the top</div>
        {:else}
          {#each sortTopItems as child, i (child.id)}
            <div
              class="item draggable"
              use:topDrag.item={i}
              use:topDrag.handle={i}
              class:drag-placeholder={topDrag.draggedIndex === i}
              animate:flip={{ duration: 200 }}
            >
              <span class="drag-handle" title="Drag to reorder">⠿</span>
              <span class="item-name">{displayName(child)}</span>
              <button
                class="action-btn"
                title="Unpin (move to default order)"
                onclick={() => unpinFromTop(child.id)}
              >↓</button>
            </div>
          {/each}
        {/if}
      </div>

      <div class="section-divider"></div>

      <!-- Middle (default order) -->
      <div class="middle-section">
        <div class="section-header">
          <span class="section-label">Default Order</span>
          {#if middleItems.length > 0}
            <span class="count">{middleItems.length}</span>
          {/if}
        </div>
        {#if middleItems.length === 0}
          <div class="empty-state">All items are pinned</div>
        {:else}
          {#each middleItems as child (child.id)}
            <div class="item">
              <span class="item-name middle-name">{displayName(child)}</span>
              <div class="middle-actions">
                <button
                  class="action-btn"
                  title="Pin to top"
                  onclick={() => pinToTop(child.id)}
                >↑</button>
                <button
                  class="action-btn"
                  title="Pin to bottom"
                  onclick={() => pinToBottom(child.id)}
                >↓</button>
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <div class="section-divider"></div>

      <!-- Sort Bottom -->
      <div class="pin-section">
        <div class="section-header">
          <span class="section-label">Always Last</span>
          {#if sortBottomItems.length > 0}
            <span class="count">{sortBottomItems.length}</span>
          {/if}
        </div>
        {#if sortBottomItems.length === 0}
          <div class="empty-state">No items pinned — use ↓ above to pin items to the bottom</div>
        {:else}
          {#each sortBottomItems as child, i (child.id)}
            <div
              class="item draggable"
              use:bottomDrag.item={i}
              use:bottomDrag.handle={i}
              class:drag-placeholder={bottomDrag.draggedIndex === i}
              animate:flip={{ duration: 200 }}
            >
              <span class="drag-handle" title="Drag to reorder">⠿</span>
              <span class="item-name">{displayName(child)}</span>
              <button
                class="action-btn"
                title="Unpin (move to default order)"
                onclick={() => unpinFromBottom(child.id)}
              >↑</button>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</ModalWindow>

<style>
  .loading {
    padding: 2rem;
    text-align: center;
    color: var(--ev-c-text-2);
  }

  .sort-editor {
    display: flex;
    flex-direction: column;
    padding: 0.75rem 0;
  }

  .pin-section,
  .middle-section {
    padding: 0.75rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.35rem;
  }

  .section-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ev-c-text-2);
  }

  .count {
    font-size: 0.75rem;
    background: var(--color-background-mute);
    color: var(--ev-c-text-2);
    border-radius: 10px;
    padding: 0 0.4rem;
    line-height: 1.4;
  }

  .section-divider {
    height: 1px;
    background: var(--color-background-mute);
    margin: 0.25rem 0;
  }

  .empty-state {
    font-size: 0.85rem;
    color: var(--ev-c-text-3);
    font-style: italic;
    padding: 0.4rem 0;
    border: 1px dashed var(--color-background-mute);
    border-radius: 4px;
    text-align: center;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border-radius: 4px;
    border: 1px solid transparent;
  }

  .item.draggable {
    cursor: default;
  }

  .item.drag-placeholder {
    opacity: 0.25;
    pointer-events: none;
  }

  .drag-handle {
    color: var(--ev-c-text-3);
    font-size: 1rem;
    user-select: none;
    flex-shrink: 0;
  }

  .item-name {
    flex: 1;
    font-size: 0.9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .middle-name {
    color: var(--ev-c-text-2);
  }

  .middle-actions {
    display: flex;
    gap: 0.2rem;
    flex-shrink: 0;
  }

  .action-btn {
    background: none;
    border: 1px solid var(--color-background-mute);
    border-radius: 3px;
    color: var(--ev-c-text-2);
    font-size: 0.8rem;
    width: 1.6rem;
    height: 1.6rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    padding: 0;
    transition: background-color 0.1s, color 0.1s;
  }

  .action-btn:hover {
    background: var(--color-background-mute);
    color: var(--ev-c-text-1);
  }
</style>
