<script lang="ts">
  import Icon from '@components/ui/Icon.svelte'
  import type { MediaFolder, LibraryItem } from '@shared/types'
  import { notificationStore } from '@lib/notification-store.svelte'
  let {
    item,
    retrieveChildrenMetadata = $bindable(),
    childrenTypeHint = $bindable(),
    processTvChildren = $bindable(),
    itemsToUnhide = $bindable([]),
    onNeedRefresh
  }: {
    item: MediaFolder
    retrieveChildrenMetadata: boolean
    childrenTypeHint: 'auto' | 'movie' | 'tv'
    processTvChildren: boolean
    itemsToUnhide: string[]
    onNeedRefresh: () => Promise<void>
  } = $props()

  let hiddenChildren = $state<LibraryItem[]>([])

  async function fetchHiddenChildren() {
    try {
      hiddenChildren = await window.api.getHiddenChildren(item.id)
    } catch (err: any) {
      notificationStore.add(err.message || 'Failed to load hidden items.', 'error')
    }
  }

  function toggleUnhide(child: LibraryItem) {
    if (itemsToUnhide.includes(child.id)) {
      itemsToUnhide = itemsToUnhide.filter((id) => id !== child.id)
    } else {
      itemsToUnhide = [...itemsToUnhide, child.id]
    }
  }

  $effect(() => {
    fetchHiddenChildren()
  })
</script>

<div class="form-stack">
  <div class="settings-group raised-surface">
    <label class="checkbox-label">
      <input type="checkbox" bind:checked={retrieveChildrenMetadata} />
      <span>Fetch metadata for direct children</span>
    </label>
    <p class="form-hint">
      Enable for folders that directly contain movies or shows.
    </p>
  </div>

  <div class="settings-group raised-surface" class:disabled={!retrieveChildrenMetadata}>
    <label class="field-label" for="children-type-hint">Media type</label>
    <select
      id="children-type-hint"
      bind:value={childrenTypeHint}
      disabled={!retrieveChildrenMetadata}
    >
      <option value="auto">Auto-detect</option>
      <option value="movie">Movie</option>
      <option value="tv">TV Show</option>
    </select>
    <p class="form-hint">Improves matching accuracy by telling the retriever what to look for.</p>
  </div>

  {#if item.mediaType === 'tv'}
    <div class="settings-group raised-surface">
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={processTvChildren} />
        <span>Detect seasons and episodes</span>
      </label>
      <p class="form-hint">
        Identify seasons and episodes from file and folder names and fetch their metadata.
      </p>
    </div>
  {/if}

  {#if hiddenChildren.length > 0}
    <div class="settings-group raised-surface">
      <h3>Hidden items</h3>
      <p class="form-hint">
        These items will reappear when you save your changes.
      </p>
      <ul class="hidden-items-list">
        {#each hiddenChildren as child (child.id)}
          {@const isPending = itemsToUnhide.includes(child.id)}
          <li class="hidden-item">
            <span class:pending={isPending}>
              <Icon name={child.type === 'folder' ? 'folder' : 'file'} size={20} />
              {child.name}
            </span>
            <button class="secondary" onclick={() => toggleUnhide(child)}>
              {isPending ? 'Undo' : 'Unhide'}
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .settings-group { display: grid; gap: .5rem; padding: .7rem .8rem; }
  .settings-group.disabled { opacity: .65; }
  .settings-group select { justify-self: start; max-width: 100%; }
  .checkbox-label { display: flex; align-items: center; gap: .5rem; font-size: .9rem; font-weight: 650; cursor: pointer; }
  .checkbox-label input { flex: none; }
  h3 { font-size: .93rem; font-weight: 650; }
  .hidden-items-list { display: grid; gap: .35rem; max-height: 15rem; overflow: auto; padding: 0; }
  .hidden-item {
    display: flex; align-items: center; justify-content: space-between; gap: .5rem;
    background: var(--color-inset); border-radius: var(--radius-field); padding: .4rem .5rem;
  }
  .hidden-item span { display: flex; align-items: center; gap: .4rem; min-width: 0; overflow-wrap: anywhere; font-size: .84rem; }
  .hidden-item span :global(svg) { flex: none; color: var(--color-primary-soft); }
  .hidden-item span.pending { opacity: .65; }
</style>
