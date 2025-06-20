<script lang="ts">
  let {
    item,
    retrieveChildrenMetadata = $bindable(),
    childrenTypeHint = $bindable(),
    processTvChildren = $bindable(),
    onClearMetadata
  }: {
    item: MediaFolder
    retrieveChildrenMetadata: boolean
    childrenTypeHint: 'auto' | 'movie' | 'tv'
    processTvChildren: boolean
    onClearMetadata: () => Promise<void>
  } = $props()

  const isVirtual = $derived((item as any).isVirtual === true)
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
      <button class="danger" onclick={onClearMetadata}> Clear All Children Metadata... </button>
      <p class="help-text danger-help-text">
        Removes all fetched data (titles, posters, tags, etc.) for every item inside this folder.
        This is useful for forcing a complete re-fetch from scratch.
      </p>
    </div>
  </div>
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
</style>