<script lang="ts">
  import { slide } from 'svelte/transition'
  import ConfigurableTreeItem from './ConfigurableTreeItem.svelte'
  import type { MediaFolder } from '@shared/types'

  type ItemSettings = { retrieve: boolean; hint?: 'movie' | 'tv' }

  let {
    item,
    level = 0,
    settings = $bindable()
  }: {
    item: MediaFolder
    level?: number
    settings: Map<string, ItemSettings>
  } = $props()

  let isExpanded = $state(false) // Default to collapsed

  function getSetting(id: string): ItemSettings {
    return settings.get(id) ?? { retrieve: false, hint: undefined }
  }

  function updateSetting(id: string, newValues: Partial<ItemSettings>) {
    const current = getSetting(id)
    settings.set(id, { ...current, ...newValues })
    settings = settings
  }
</script>

<div class="tree-item-container">
  <div class="tree-item" style:--level={level}>
    <button class="expand-btn" onclick={() => (isExpanded = !isExpanded)}>
      <span class="chevron">{isExpanded ? '▾' : '▸'}</span>
      <span>{item.name}</span>
    </button>

    <div class="controls">
      <select
        value={getSetting(item.id).hint ?? 'auto'}
        onchange={(e) =>
          updateSetting(item.id, {
            hint:
              (e.currentTarget.value as 'auto' | 'movie' | 'tv') === 'auto'
                ? undefined
                : (e.currentTarget.value as 'movie' | 'tv')
          })}
        onclick={(e) => e.stopPropagation()}
      >
        <option value="auto">Auto-detect</option>
        <option value="movie">Movie</option>
        <option value="tv">TV Show</option>
      </select>
      <label onclick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={getSetting(item.id).retrieve}
          onchange={(e) => updateSetting(item.id, { retrieve: e.currentTarget.checked })}
        />
        <span>Fetch for children</span>
      </label>
    </div>
  </div>

  {#if isExpanded && item.children && item.children.length > 0}
    <div class="children" transition:slide|local={{ duration: 150 }}>
      {#each item.children.filter((c) => c.type === 'folder') as child (child.id)}
        <ConfigurableTreeItem item={child as MediaFolder} level={level + 1} bind:settings />
      {/each}
    </div>
  {/if}
</div>

<style>
  .tree-item-container {
    display: flex;
    flex-direction: column;
  }
  .tree-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.25rem 0.5rem;
    padding-left: calc(0.5rem + var(--level, 0) * 1.5rem);
    border-radius: 4px;
    cursor: default; /* Remove cursor for the whole row */
  }

  .tree-item:hover {
    background-color: var(--ev-c-gray-3);
  }

  .expand-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
    flex-grow: 1;
    padding: 0.25rem;
  }
  .chevron {
    width: 1em;
    text-align: center;
    color: var(--ev-c-text-2);
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-shrink: 0;
  }

  .controls label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .controls select {
    background-color: var(--color-background);
  }

  .controls input[type='checkbox'] {
    width: 1.1rem;
    height: 1.1rem;
    cursor: pointer;
  }

  .children {
    overflow: hidden;
  }
</style>
