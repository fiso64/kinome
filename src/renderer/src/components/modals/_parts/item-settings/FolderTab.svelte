<script lang="ts">
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

<div class="content">
  <div class="settings-group">
    <label class="checkbox-label">
      <input type="checkbox" bind:checked={retrieveChildrenMetadata} />
      <span>This folder directly contains media items (e.g., movies or TV shows)</span>
    </label>
    <p class="help-text">
      Enable this to fetch movie or TV show metadata for direct children of this folder.
    </p>
  </div>

  <div class="settings-group" class:disabled={!retrieveChildrenMetadata}>
    <label for="children-type-hint">Children Type Hint</label>
    <select
      id="children-type-hint"
      bind:value={childrenTypeHint}
      disabled={!retrieveChildrenMetadata}
    >
      <option value="auto">Automatic Detection</option>
      <option value="movie">Movie</option>
      <option value="tv">TV Show</option>
    </select>
    <p class="help-text">Improves matching accuracy by telling the retriever what to look for.</p>
  </div>

  {#if item.mediaType === 'tv'}
    <div class="settings-group">
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={processTvChildren} />
        <span>Enable TV show processing (seasons & episodes)</span>
      </label>
      <p class="help-text">
        If enabled, the app will analyze file/folder names to identify seasons and episodes, and
        fetch their specific metadata. Disable this for folders that contain TV shows but should
        be treated as simple folders.
      </p>
    </div>
  {/if}

  {#if hiddenChildren.length > 0}
    <div class="settings-group">
      <h4>Hidden Items in this Folder</h4>
      <p class="help-text">
        The following direct children are hidden. Unhiding them will make them visible again.
      </p>
      <ul class="hidden-items-list">
        {#each hiddenChildren as child (child.id)}
          {@const isPending = itemsToUnhide.includes(child.id)}
          <li class="hidden-item">
            <span class:strikethrough={isPending}>
              {child.type === 'folder' ? '📁' : '📄'}
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
  .content {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .settings-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: opacity 0.2s ease-in-out;
  }
  .settings-group.disabled {
    opacity: 0.5;
    pointer-events: none;
  }
  .help-text {
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
  }
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 1rem;
    cursor: pointer;
    font-weight: bold;
  }
  .checkbox-label input {
    width: 1rem;
    height: 1rem;
  }
  label {
    font-weight: bold;
  }

  .hidden-items-list {
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    border-radius: 6px;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 200px;
    overflow-y: auto;
  }
  .hidden-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem;
    border-radius: 4px;
  }
  .hidden-item:hover {
    background-color: var(--color-background-soft);
  }
  .hidden-item span {
    word-break: break-all;
    padding-right: 1rem;
  }
  .strikethrough {
    text-decoration: line-through;
    opacity: 0.6;
  }
</style>
