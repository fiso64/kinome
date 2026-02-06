<script lang="ts">
  import { api } from '@lib/api'
  import { slide } from 'svelte/transition'

  interface DirectoryEntry {
    name: string
    path: string
    isDirectory: boolean
    isExpanded: boolean
    children: DirectoryEntry[] | null
    isLoading: boolean
    settings: {
      retrieve_children_metadata: boolean
      children_type_hint?: 'movie' | 'tv' | null
    }
  }

  let {
    rootPath,
    onSettingsChange
  }: {
    rootPath: string
    onSettingsChange: (settings: Record<string, any>) => void
  } = $props()

  let rootEntries = $state<DirectoryEntry[]>([])
  let isInitializing = $state(true)

  async function loadInitial() {
    isInitializing = true
    try {
      // Create a single root entry representing the base path
      rootEntries = [
        {
          name: rootPath.split(/[\\/]/).pop() || rootPath,
          path: rootPath,
          isDirectory: true,
          isExpanded: false,
          children: null,
          isLoading: false,
          settings: {
            retrieve_children_metadata: false,
            children_type_hint: null
          }
        }
      ]
    } catch (err) {
      console.error('Failed to initialize tree:', err)
    } finally {
      isInitializing = false
    }
  }

  async function toggleExpand(entry: DirectoryEntry) {
    if (entry.isExpanded) {
      entry.isExpanded = false
      return
    }

    entry.isExpanded = true
    if (!entry.children && !entry.isLoading) {
      entry.isLoading = true
      try {
        const results = await api.listDirectory(entry.path)
        entry.children = results.map((r) => ({
          ...r,
          isExpanded: false,
          children: null,
          isLoading: false,
          settings: {
            retrieve_children_metadata: false,
            children_type_hint: null
          }
        }))
      } catch (err) {
        console.error(`Failed to load children for ${entry.path}:`, err)
      } finally {
        entry.isLoading = false
      }
    }
  }

  function handleSettingsChange() {
    const flatSettings: Record<string, any> = {}

    function collect(entries: DirectoryEntry[]) {
      for (const entry of entries) {
        if (entry.settings.retrieve_children_metadata || entry.settings.children_type_hint) {
          flatSettings[entry.path] = {
            retrieve_children_metadata: entry.settings.retrieve_children_metadata,
            children_type_hint: entry.settings.children_type_hint || undefined
          }
        }
        if (entry.children) {
          collect(entry.children)
        }
      }
    }

    collect(rootEntries)
    // console.log("[FilesystemTree] Emitting settings:", flatSettings);
    onSettingsChange(flatSettings)
  }

  $effect(() => {
    if (rootPath) {
      loadInitial()
    }
  })

  // Re-run settings change whenever nested settings change
  $effect(() => {
    // This is a bit of a hack to observe deep changes in rootEntries
    JSON.stringify(rootEntries)
    handleSettingsChange()
  })
</script>

{#snippet treeItem(entry: DirectoryEntry)}
  <li class="tree-item">
    <div class="item-content">
      <button class="expand-btn" onclick={() => toggleExpand(entry)}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="transition-transform {entry.isExpanded ? 'rotate-90' : ''}"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>

      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="folder-icon"
      >
        <path
          d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
        />
      </svg>
      <span class="name">{entry.name}</span>

      <div class="settings">
        <select
          bind:value={entry.settings.children_type_hint}
          class="type-select"
          disabled={!entry.settings.retrieve_children_metadata}
        >
          <option value={null}>Auto-detect</option>
          <option value="movie">Movies</option>
          <option value="tv">TV Shows</option>
        </select>

        <label class="checkbox-label">
          <input type="checkbox" bind:checked={entry.settings.retrieve_children_metadata} />
          <span>Fetch for children</span>
        </label>
      </div>
    </div>

    {#if entry.isExpanded}
      <div transition:slide>
        {#if entry.isLoading}
          <div class="indent loading-sub">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="animate-spin"
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          </div>
        {:else if entry.children}
          <ul class="indent">
            {#each entry.children as child}
              {@render treeItem(child)}
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

<div class="tree-container">
  {#if isInitializing}
    <div class="loading">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="animate-spin"
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <span>Scanning folder structure...</span>
    </div>
  {:else if rootEntries.length === 0}
    <div class="empty">No subdirectories found.</div>
  {:else}
    <ul class="tree">
      {#each rootEntries as entry}
        {@render treeItem(entry)}
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tree-container {
    max-height: 400px;
    overflow-y: auto;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 12px;
    background: rgba(0, 0, 0, 0.2);
  }

  .loading,
  .empty {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-muted);
    padding: 20px;
    justify-content: center;
  }

  .tree {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .tree-item {
    margin-bottom: 4px;
  }

  .item-content {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 4px;
    transition: background 0.2s;
  }

  .item-content:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .expand-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .expand-btn:hover {
    color: var(--text-color);
  }

  .folder-icon {
    color: #4a9eff;
  }

  .name {
    flex: 1;
    font-size: 0.9rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .settings {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .type-select {
    background: #2a2a2e;
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #e0e0e0;
    font-size: 0.8rem;
    padding: 2px 6px;
    border-radius: 4px;
    outline: none;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
    background-repeat: no-repeat;
    background-position: right 4px center;
    background-size: 10px;
    padding-right: 20px;
  }

  .type-select:hover {
    background-color: #35353a;
    border-color: rgba(255, 255, 255, 0.2);
  }

  .type-select option {
    background: #1a1a1e;
    color: #e0e0e0;
  }

  .type-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: var(--text-muted);
    cursor: pointer;
  }

  .checkbox-label input {
    cursor: pointer;
  }

  .indent {
    margin-left: 20px;
    border-left: 1px solid rgba(255, 255, 255, 0.1);
    list-style: none;
    padding-left: 8px;
  }

  .loading-sub {
    padding: 4px 0;
    color: var(--text-muted);
  }

  .transition-transform {
    transition: transform 0.2s;
  }

  .rotate-90 {
    transform: rotate(90deg);
  }
</style>
