<script lang="ts">
  import { untrack } from 'svelte'
  import equal from 'fast-deep-equal'
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

  let lastSettings: Record<string, any> | undefined

  function collectSettings() {
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
    return flatSettings
  }

  $effect(() => {
    if (rootPath) {
      loadInitial()
    }
  })

  $effect(() => {
    const settings = collectSettings()
    if (!equal(settings, lastSettings)) {
      lastSettings = settings
      untrack(() => onSettingsChange(settings))
    }
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
    <span class="folder-name">{entry.name}</span>
  {/snippet}

  {#snippet controls(entry: DirectoryEntry)}
    <select
      bind:value={entry.settings.children_type_hint}
      class="folder-type" aria-label={`Media type for ${entry.name}`}
      disabled={!entry.settings.retrieve_children_metadata}
    >
      <option value={null}>Auto-detect</option>
      <option value="movie">Movies</option>
      <option value="tv">TV Shows</option>
    </select>

    <label class="folder-fetch">
      <input type="checkbox" bind:checked={entry.settings.retrieve_children_metadata} />
      <span>Fetch for children</span>
    </label>
  {/snippet}
</FolderTree>
