<script lang="ts">
  import FilterEditor from '../FilterEditor.svelte'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import type { LibraryCondition, LibraryFilter, AutocompleteSuggestions } from '@shared/types'

  let {
    filter = $bindable(),
    parentId,
    suggestions
  }: {
    filter: LibraryFilter
    parentId: string
    suggestions?: AutocompleteSuggestions
  } = $props()

  const rootId = libraryDataService.rootId

  // Initialize conditionGroups from filter, migrating legacy conditions format
  if (!filter.conditionGroups) {
    filter.conditionGroups = filter.conditions?.length
      ? [filter.conditions]
      : [[{ field: 'genre', op: 'contains', value: '' }]]
    filter.conditions = undefined
  }

  // Determine initial scope mode from filter state
  function detectScope(): 'none' | 'parent' | 'root' | 'library' {
    if (filter.scope?.manual) return 'none'
    const scopeId = filter.scope?.parentId
    if (!scopeId) return 'library'
    if (rootId && scopeId === rootId) return 'root'
    if (scopeId === parentId) return 'parent'
    return 'parent'
  }

  let scope = $state<'none' | 'parent' | 'root' | 'library'>(detectScope())
  let conditionGroups = $state<LibraryCondition[][]>(filter.conditionGroups)

  // Sync local state back to filter prop
  $effect(() => {
    filter.conditionGroups = conditionGroups
    filter.conditions = undefined
    if (scope === 'none') {
      filter.scope = { manual: true }
      filter.conditionGroups = undefined
      filter.conditions = undefined
    } else if (scope === 'parent' && parentId) {
      filter.scope = { parentId }
    } else if (scope === 'root' && rootId) {
      filter.scope = { parentId: rootId }
    } else if (scope === 'library') {
      filter.scope = undefined
    }
    // If scope is 'parent' but parentId is empty, preserve existing filter.scope
  })
</script>

<div class="virtual-folder-tab">
  <div class="form-group">
    <label for="vf-scope">Scope</label>
    <select id="vf-scope" bind:value={scope}>
      <option value="none">None (Manual)</option>
      <option value="parent">Parent Folder</option>
      <option value="root">Root Folder</option>
      <option value="library">Full Library — all files and folders</option>
    </select>
  </div>

  {#if scope !== 'none'}
    <div class="form-group">
      <label>Conditions</label>
      <FilterEditor bind:groups={conditionGroups} {suggestions} />
    </div>
  {/if}
</div>

<style>
  .virtual-folder-tab {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  label {
    font-weight: bold;
    font-size: 0.9rem;
  }
  select {
    max-width: 16rem;
  }
</style>
