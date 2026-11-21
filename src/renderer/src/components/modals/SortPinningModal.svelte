<script lang="ts">
  import Skeleton from '@components/ui/Skeleton.svelte'
  import { prefersReducedMotion } from 'svelte/motion'
  import Icon from '@components/ui/Icon.svelte'
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
    onDone
  }: {
    item: MediaFolder
    initialSortTop?: string[]
    initialSortBottom?: string[]
    onClose: () => void
    onDone: (sortTop: string[], sortBottom: string[]) => void
  } = $props()

  let loading = $state(true)
  let allChildren = $state<LibraryItem[]>([])
  let sortTopIds = $state<string[]>([...(initialSortTop ?? item.viewSettings?.sortTop ?? [])])
  let sortBottomIds = $state<string[]>([...(initialSortBottom ?? item.viewSettings?.sortBottom ?? [])])

  const topSet = $derived(new Set(sortTopIds))
  const bottomSet = $derived(new Set(sortBottomIds))

  const childrenById = $derived(new Map(allChildren.map((child) => [child.id, child])))
  const sortTopItems = $derived(sortTopIds.flatMap((id) => childrenById.get(id) ?? []))
  const sortBottomItems = $derived(sortBottomIds.flatMap((id) => childrenById.get(id) ?? []))

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

  function handleDone() {
    if (loading) return
    onDone([...sortTopIds], [...sortBottomIds])
    onClose()
  }

  function displayName(child: LibraryItem): string {
    return (child as any).title ?? child.name
  }
</script>

<ModalWindow title="Sort Order" {onClose} onDone={handleDone} maxWidth="480px">
  {#if loading}
    <div class="form-stack" role="status" aria-label="Loading sort order"><Skeleton height="3rem" /><Skeleton height="3rem" /></div>
  {:else}
    <div class="sort-editor">
      <!-- Sort Top -->
      <div class="pin-section raised-surface">
        <header class="section-header">
          <h3 class="section-label">Always first</h3>
          {#if sortTopItems.length > 0}
            <span class="count">{sortTopItems.length}</span>
          {/if}
        </header>
        {#if sortTopItems.length === 0}
          <div class="empty-state">No items pinned to the top</div>
        {:else}
          {#each sortTopItems as child, i (child.id)}
            <div
              class="item draggable"
              use:topDrag.item={i}
              use:topDrag.handle={i}
              class:drag-placeholder={topDrag.draggedIndex === i}
              animate:flip={{ duration: prefersReducedMotion.current ? 0 : 155 }}
            >
              <span class="drag-handle" title="Drag to reorder"><Icon name="grip" size={15} /></span>
              <span class="item-name" title={displayName(child)}>{displayName(child)}</span>
              <button
                class="icon-button action-btn" type="button"
                title="Unpin (move to default order)"
                onclick={() => unpinFromTop(child.id)}
              ><Icon name="down" size={15} /></button>
            </div>
          {/each}
        {/if}
      </div>

      <!-- Middle (default order) -->
      <div class="middle-section raised-surface">
        <header class="section-header">
          <h3 class="section-label">Default order</h3>
          {#if middleItems.length > 0}
            <span class="count">{middleItems.length}</span>
          {/if}
        </header>
        {#if middleItems.length === 0}
          <div class="empty-state">All items are pinned</div>
        {:else}
          {#each middleItems as child (child.id)}
            <div class="item">
              <span class="item-name" title={displayName(child)}>{displayName(child)}</span>
              <div class="middle-actions">
                <button
                  class="icon-button action-btn" type="button"
                  title="Pin to top"
                  onclick={() => pinToTop(child.id)}
                ><Icon name="up" size={15} /></button>
                <button
                  class="icon-button action-btn" type="button"
                  title="Pin to bottom"
                  onclick={() => pinToBottom(child.id)}
                ><Icon name="down" size={15} /></button>
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <!-- Sort Bottom -->
      <div class="pin-section raised-surface">
        <header class="section-header">
          <h3 class="section-label">Always last</h3>
          {#if sortBottomItems.length > 0}
            <span class="count">{sortBottomItems.length}</span>
          {/if}
        </header>
        {#if sortBottomItems.length === 0}
          <div class="empty-state">No items pinned to the bottom</div>
        {:else}
          {#each sortBottomItems as child, i (child.id)}
            <div
              class="item draggable"
              use:bottomDrag.item={i}
              use:bottomDrag.handle={i}
              class:drag-placeholder={bottomDrag.draggedIndex === i}
              animate:flip={{ duration: prefersReducedMotion.current ? 0 : 155 }}
            >
              <span class="drag-handle" title="Drag to reorder"><Icon name="grip" size={15} /></span>
              <span class="item-name" title={displayName(child)}>{displayName(child)}</span>
              <button
                class="icon-button action-btn" type="button"
                title="Unpin (move to default order)"
                onclick={() => unpinFromBottom(child.id)}
              ><Icon name="up" size={15} /></button>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</ModalWindow>

<style>
  .sort-editor { display: grid; min-width: 0; gap: .65rem; padding: clamp(.85rem, 2.7vw, 1.35rem); }
  .pin-section, .middle-section { padding: .55rem; }
  .section-header { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; padding: .15rem .25rem .45rem; }
  .section-label { font-size: .88rem; font-weight: 675; }
  .count, .empty-state { color: var(--color-text-soft); font-size: .79rem; }
  .empty-state { padding: .35rem .25rem; }
  .item { display: flex; align-items: center; gap: .4rem; min-width: 0; margin-block: .16rem; padding: .15rem .25rem;
    border: 1px solid var(--color-border-soft); border-radius: var(--radius-field); background: var(--color-inset); }
  .item-name { flex: 1; min-width: 0; padding: .15rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: .83rem; }
  .drag-handle, .middle-actions { display: flex; flex: none; color: var(--color-text-soft); }
  .drag-placeholder { opacity: .25; }
  .action-btn { width: 27px; height: 27px; }
  .action-btn:hover { color: var(--color-primary-soft); }
</style>
