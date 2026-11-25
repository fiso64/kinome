<script lang="ts">
  import Skeleton from '@components/ui/Skeleton.svelte'
  import { prefersReducedMotion } from 'svelte/motion'
  import Icon from '@components/ui/Icon.svelte'
  import { onMount, untrack } from 'svelte'
  import ModalWindow from './_base/ModalWindow.svelte'
  import { useDragSort } from '@lib/drag-sort.svelte'
  import { applySortPlacement, type SortPlacement } from '@shared/sort-placement'
  import type { LibraryItem, MediaFolder } from '@shared/types'
  import { flip } from 'svelte/animate'
  import { notificationStore } from '@lib/notification-store.svelte'

  let {
    item,
    placement: initialPlacement,
    onClose,
    onDone
  }: {
    item: MediaFolder
    placement?: SortPlacement
    onClose: () => void
    onDone: (placement: Required<SortPlacement>) => void
  } = $props()

  let loading = $state(true)
  // Children in the folder's own sort order, before any hand placement.
  let children = $state.raw<LibraryItem[]>([])
  const childrenById = $derived(new Map(children.map((child) => [child.id, child])))

  const saved = untrack(() => initialPlacement) ?? {
    top: item.viewSettings?.sortTop, bottom: item.viewSettings?.sortBottom, after: item.viewSettings?.sortAfter
  }
  let top = $state<string[]>([...(saved.top ?? [])])
  let bottom = $state<string[]>([...(saved.bottom ?? [])])
  let after = $state<Record<string, string[]>>(structuredClone($state.snapshot(saved.after) ?? {}))
  // The list as shown. It follows the placement, except while a row is being dragged.
  let order = $state<string[]>([])

  function showPlacement() {
    order = applySortPlacement(children.map(({ id }) => id), { top, bottom, after })
  }

  onMount(async () => {
    try {
      const result = await window.api.getChildren(item.id, { naturalOrder: true })
      if (Array.isArray(result)) {
        children = result
        // Drop children that were deleted or moved away.
        const present = (id: string) => childrenById.has(id)
        top = top.filter(present)
        bottom = bottom.filter(present)
        after = Object.fromEntries(Object.entries(after)
          .filter(([anchor]) => present(anchor))
          .map(([anchor, followers]) => [anchor, followers.filter(present)]))
        showPlacement()
      }
    } catch (err: any) {
      notificationStore.add(err.message || 'Failed to load children.', 'error')
    } finally {
      loading = false
    }
  })

  // --- Placement ---

  /** What a row shows about its placement. Unplaced rows have none. */
  const labels = $derived.by(() => {
    const result = new Map<string, string>()
    const name = (id: string) => displayName(childrenById.get(id))
    for (const id of top) result.set(id, 'Always first')
    for (const id of bottom) result.set(id, 'Always last')
    for (const [anchor, followers] of Object.entries(after)) {
      followers.forEach((id, index) => result.set(id, `After ${name(index ? followers[index - 1] : anchor)}`))
    }
    return result
  })

  function detach(id: string) {
    top = top.filter((other) => other !== id)
    bottom = bottom.filter((other) => other !== id)
    after = Object.fromEntries(Object.entries(after)
      .map(([anchor, followers]) => [anchor, followers.filter((other) => other !== id)] as const)
      .filter(([, followers]) => followers.length))
  }

  /** Everything that travels with a row: the rows placed after it, and after those. */
  function followersOf(id: string, result = new Set<string>()): Set<string> {
    for (const follower of after[id] ?? []) {
      if (!result.has(follower)) followersOf(follower, result.add(follower))
    }
    return result
  }

  function insertAfter(list: string[], previous: string, id: string): string[] {
    const index = list.indexOf(previous)
    return [...list.slice(0, index + 1), id, ...list.slice(index + 1)]
  }

  /** Saves where a dragged row was dropped as "after the row above it". */
  function placeWhereDropped(id: string) {
    const own = followersOf(id)
    const above = order.slice(0, order.indexOf(id))
    const previous = above.findLast((other) => !own.has(other))
    // Dropped among its own followers: there is no row to anchor to.
    if (!previous && above.length) return

    detach(id)
    if (!previous) top = [id, ...top]
    else if (top.includes(previous)) top = insertAfter(top, previous, id)
    else if (bottom.includes(previous)) bottom = insertAfter(bottom, previous, id)
    else {
      const anchor = Object.keys(after).find((key) => after[key].includes(previous))
      after = anchor
        ? { ...after, [anchor]: insertAfter(after[anchor], previous, id) }
        : { ...after, [previous]: [id, ...(after[previous] ?? [])] }
    }
  }

  function pin(id: string, edge: 'top' | 'bottom') {
    detach(id)
    if (edge === 'top') top = [...top, id]
    else bottom = [...bottom, id]
    showPlacement()
  }

  function reset(id: string) {
    detach(id)
    showPlacement()
  }

  // --- Dragging ---

  const drag = useDragSort(() => order, (next) => (order = next))
  let dragged: { id: string; index: number } | undefined

  $effect(() => {
    const index = drag.draggedIndex
    untrack(() => {
      if (index !== null) {
        dragged ??= { id: order[index], index }
        return
      }
      if (!dragged) return
      const { id, index: start } = dragged
      dragged = undefined
      if (order.indexOf(id) !== start) placeWhereDropped(id)
      showPlacement()
    })
  })

  function handleDone() {
    if (loading) return
    onDone($state.snapshot({ top, bottom, after }))
    onClose()
  }

  function displayName(child?: LibraryItem): string {
    return child ? (child as any).title ?? child.name : 'a removed item'
  }
</script>


<ModalWindow title="Sort Order" {onClose} onDone={handleDone} minWidth="560px" maxWidth="900px">
  {#if loading}
    <div class="form-stack" role="status" aria-label="Loading sort order"><Skeleton height="3rem" /><Skeleton height="3rem" /></div>
  {:else}
    <div class="sort-editor">
      <p class="form-hint">Drag an item to place it after another. Everything else keeps the folder's sort.</p>
      {#if order.length === 0}
        <div class="empty-state">This folder has no items.</div>
      {:else}
        <div class="sort-list raised-surface">
          {#each order as id, i (id)}
            {@const child = childrenById.get(id)}
            {@const label = labels.get(id)}
            <div
              class="item"
              class:placed={label}
              data-item-id={id}
              use:drag.item={i}
              use:drag.handle={i}
              class:drag-placeholder={drag.draggedIndex === i}
              animate:flip={{ duration: prefersReducedMotion.current ? 0 : 155 }}
            >
              <span class="drag-handle" title="Drag to reorder"><Icon name="grip" size={15} /></span>
              <span class="item-name" title={displayName(child)}>{displayName(child)}</span>
              {#if label}
                <span class="placement" title={label}>{label}</span>
                <button class="icon-button action-btn" type="button" data-action="reset-placement"
                  title="Return to the folder's sort" aria-label={`Return ${displayName(child)} to the folder's sort`}
                  onclick={() => reset(id)}><Icon name="close" size={14} /></button>
              {:else}
                <button class="icon-button action-btn" type="button" data-action="pin-first"
                  title="Always first" aria-label={`Always show ${displayName(child)} first`}
                  onclick={() => pin(id, 'top')}><Icon name="up" size={15} /></button>
                <button class="icon-button action-btn" type="button" data-action="pin-last"
                  title="Always last" aria-label={`Always show ${displayName(child)} last`}
                  onclick={() => pin(id, 'bottom')}><Icon name="down" size={15} /></button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</ModalWindow>

<style>
  /* Long names widen the window up to its limit, then truncate. */
  .sort-editor { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; gap: .65rem; padding: clamp(.85rem, 2.7vw, 1.35rem); }
  .sort-editor .form-hint { inline-size: 0; min-inline-size: 100%; }
  .sort-list { padding: .4rem .55rem; }
  .empty-state { color: var(--color-text-soft); font-size: .79rem; padding: .35rem .25rem; }
  .item { display: flex; align-items: center; gap: .4rem; min-width: 0; margin-block: .16rem; padding: .15rem .25rem;
    border: 1px solid var(--color-border-soft); border-radius: var(--radius-field); background: var(--color-inset); }
  .item.placed { border-color: var(--accent-border); }
  .item-name { flex: 1; min-width: 0; padding: .15rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: .83rem; }
  .placement { flex: 0 1 auto; min-width: 0; max-width: 45%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: var(--color-primary-soft); font-size: .74rem; }
  .drag-handle { display: flex; flex: none; color: var(--color-text-soft); }
  .drag-placeholder { opacity: .25; }
  .action-btn { flex: none; width: 27px; height: 27px; }
  .action-btn:hover { color: var(--color-primary-soft); }
</style>
