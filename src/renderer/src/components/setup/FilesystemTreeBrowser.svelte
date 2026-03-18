<script lang="ts">
  import { api } from '@lib/api'
  import FolderTree from '@components/ui/FolderTree.svelte'

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
    onSettingsChange(flatSettings)
  }

  $effect(() => {
    if (rootPath) {
      loadInitial()
    }
  })

  $effect(() => {
    JSON.stringify(rootEntries)
    handleSettingsChange()
  })
</script>

<FolderTree
  nodes={rootEntries}
  {isInitializing}
  loadingText="Scanning folder structure..."
  emptyText="No subdirectories found."
  onToggle={toggleExpand}
>
  {#snippet label(entry: DirectoryEntry)}
    <span class="name">{entry.name}</span>
  {/snippet}

  {#snippet controls(entry: DirectoryEntry)}
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
  {/snippet}
</FolderTree>

<style>
  .name {
    flex: 1;
    font-size: 0.9rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
</style>
