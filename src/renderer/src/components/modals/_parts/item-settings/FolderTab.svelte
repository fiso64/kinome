<script lang="ts">
  let {
    item,
    retrieveChildrenMetadata = $bindable(),
    childrenTypeHint = $bindable(),
    processTvChildren = $bindable(),
    onClearMetadata,
    onHideItem,
    onNeedRefresh
  }: {
    item: MediaFolder
    retrieveChildrenMetadata: boolean
    childrenTypeHint: 'auto' | 'movie' | 'tv'
    processTvChildren: boolean
    onClearMetadata: () => Promise<void>
    onHideItem: () => Promise<void>
    onNeedRefresh: () => Promise<void>
  } = $props()

  const isVirtual = $derived((item as any).isVirtual === true)

  let hiddenChildren = $state<LibraryItem[]>([])

  async function fetchHiddenChildren() {
    hiddenChildren = await window.api.getHiddenChildren(item.id)
  }

	async function handleUnhide(child: LibraryItem) {
		const itemToUpdate = { ...JSON.parse(JSON.stringify(child)), isHidden: false }
		await window.api.userUpdateItem(itemToUpdate)
		await fetchHiddenChildren() // Refresh the list
		await onNeedRefresh() // Refresh the main view to show the unhidden item
	}

  $effect(() => {
    if (!isVirtual) {
      fetchHiddenChildren()
    }
  })
</script>

<div class="content">
  {#if !isVirtual}
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
  {/if}

  <div class="danger-zone">
    <div class="danger-zone-header">
      <h4>Danger Zone</h4>
    </div>
    <div>
      <button class="danger" onclick={onClearMetadata}> Clear All Children Metadata </button>
      <p class="help-text danger-help-text">
        Removes all fetched data (titles, posters, tags, etc.) for every item inside this folder.
        This is useful for forcing a complete re-fetch from scratch.
      </p>
    </div>
    {#if !isVirtual}
      <div>
        <button class="danger" onclick={onHideItem}> Hide This Item </button>
        <p class="help-text danger-help-text">
          Hides this item from all library views and searches. It can be unhidden from its parent
          folder's settings.
        </p>
      </div>
    {/if}
  </div>

  {#if hiddenChildren.length > 0}
    <div class="settings-group">
      <h4>Hidden Items in this Folder</h4>
      <p class="help-text">
        The following direct children are hidden. Unhiding them will make them visible again.
      </p>
      <ul class="hidden-items-list">
        {#each hiddenChildren as child (child.id)}
          <li class="hidden-item">
            <span>{child.type === 'folder' ? '📁' : '📄'} {child.name}</span>
            <button class="secondary" onclick={() => handleUnhide(child)}>Unhide</button>
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

  .danger-zone {
    border: 1px solid #c50f1f;
    border-radius: 6px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background-color: rgba(197, 15, 31, 0.1);
  }
  .danger-zone-header h4 {
    color: #ff7d7d;
    font-weight: bold;
    margin: 0;
  }
  .danger-help-text {
    margin-top: 0.5rem;
  }
  button.danger {
    background-color: #c50f1f;
    color: white;
    align-self: flex-start;
  }
  button.danger:hover:not(:disabled) {
    background-color: #a40e19;
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
</style>
