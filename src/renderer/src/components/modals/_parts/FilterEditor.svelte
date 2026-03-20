<script lang="ts">
  import {
    autocomplete,
    getFuzzySuggestions,
    type AutocompleteConfig
  } from '@lib/autocomplete-manager'
  import type { LibraryCondition, LibraryConditionOp, AutocompleteSuggestions } from '@shared/types'

  let {
    groups = $bindable(),
    suggestions
  }: {
    groups: LibraryCondition[][]
    suggestions?: AutocompleteSuggestions
  } = $props()

  const builtinFields: { value: string; label: string }[] = [
    { value: 'genre', label: 'Genre' },
    { value: 'year', label: 'Year' },
    { value: 'title', label: 'Title' },
    { value: 'mediaType', label: 'Media Type' },
    { value: 'path', label: 'File Path' },
    { value: 'addedDaysAgo', label: 'Days Since Added' },
    { value: 'retrieveChildrenMetadata', label: 'Retrieve Children Metadata' }
  ]

  const fields = $derived.by(() => {
    const result = [...builtinFields]
    if (suggestions?.virtualTags) {
      for (const key of Object.keys(suggestions.virtualTags)) {
        result.push({ value: `vt.${key}`, label: `vt: ${key}` })
      }
    }
    if (suggestions?.tags) {
      for (const key of Object.keys(suggestions.tags)) {
        result.push({ value: `tags.${key}`, label: `tag: ${key}` })
      }
    }
    return result
  })

  const operators: { value: LibraryConditionOp; label: string }[] = [
    { value: 'eq', label: '=' },
    { value: 'ne', label: '≠' },
    { value: 'contains', label: 'contains' },
    { value: 'gt', label: '>' },
    { value: 'lt', label: '<' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' }
  ]

  function getTarget(field: string): 'item' | 'parent' {
    return field.startsWith('parent.') ? 'parent' : 'item'
  }

  function getBaseField(field: string): string {
    return field.startsWith('parent.') ? field.slice(7) : field
  }

  function setTarget(cond: LibraryCondition, target: 'item' | 'parent') {
    const base = getBaseField(cond.field)
    cond.field = target === 'parent' ? `parent.${base}` : base
  }

  function setField(cond: LibraryCondition, base: string) {
    const target = getTarget(cond.field)
    cond.field = target === 'parent' ? `parent.${base}` : base
  }

  function defaultCondition(): LibraryCondition {
    return { field: 'genre', op: 'contains', value: '' }
  }

  function addGroup() {
    groups = [...groups, [defaultCondition()]]
  }

  function removeGroup(gi: number) {
    groups = groups.filter((_, i) => i !== gi)
  }

  function addCondition(gi: number) {
    groups = groups.map((g, i) => (i === gi ? [...g, defaultCondition()] : g))
  }

  function removeCondition(gi: number, ci: number) {
    groups = groups
      .map((g, i) => (i === gi ? g.filter((_, j) => j !== ci) : g))
      .filter((g) => g.length > 0)
  }

  function getValuesForField(field: string): string[] {
    if (!suggestions) return []
    if (field === 'genre') return suggestions.genre ?? []
    if (field === 'mediaType') return suggestions.mediaType ?? []
    if (field.startsWith('vt.')) return suggestions.virtualTags?.[field.slice(3)] ?? []
    if (field.startsWith('tags.')) return suggestions.tags?.[field.slice(5)] ?? []
    return []
  }

  function makeAutocompleteConfig(cond: LibraryCondition): AutocompleteConfig {
    return {
      getSuggestions: (text) =>
        getFuzzySuggestions(getValuesForField(getBaseField(cond.field)), text),
      onSelect: (suggestion, node) => {
        cond.value = suggestion.label
        ;(node as HTMLInputElement).value = suggestion.label
      },
      triggerOnFocus: true
    }
  }
</script>

<div class="filter-editor">
  {#each groups as group, gi}
    {#if gi > 0}
      <div class="or-separator"><span>OR</span></div>
    {/if}
    <div class="and-group">
      {#each group as cond, ci}
        <div class="condition-row">
          {#if ci > 0}
            <span class="and-label">AND</span>
          {/if}
          <select
            value={getTarget(cond.field)}
            onchange={(e) => setTarget(cond, e.currentTarget.value as 'item' | 'parent')}
            class="target-select"
          >
            <option value="item">Item</option>
            <option value="parent">Parent</option>
          </select>
          <select
            value={getBaseField(cond.field)}
            onchange={(e) => setField(cond, e.currentTarget.value)}
            class="field-select"
          >
            {#each fields as f}
              <option value={f.value}>{f.label}</option>
            {/each}
            {#if !fields.some((f) => f.value === getBaseField(cond.field))}
              <option value={getBaseField(cond.field)}>{getBaseField(cond.field)}</option>
            {/if}
          </select>
          <select bind:value={cond.op} class="op-select">
            {#each operators as op}
              <option value={op.value}>{op.label}</option>
            {/each}
          </select>
          {#if cond.op !== 'isNull' && cond.op !== 'isNotNull' && cond.op !== 'isEmpty' && cond.op !== 'isNotEmpty'}
            {@const values = getValuesForField(getBaseField(cond.field))}
            {#if values.length > 0}
              <input
                type="text"
                bind:value={cond.value}
                placeholder="value"
                class="value-input"
                use:autocomplete={makeAutocompleteConfig(cond)}
              />
            {:else}
              <input type="text" bind:value={cond.value} placeholder="value" class="value-input" />
            {/if}
          {/if}
          <button
            class="remove-btn"
            onclick={() => removeCondition(gi, ci)}
            title="Remove condition">&times;</button
          >
        </div>
      {/each}
      <button class="add-link" onclick={() => addCondition(gi)}>+ AND</button>
    </div>
  {/each}
  <button class="add-link add-or" onclick={addGroup}>+ OR group</button>
</div>

<style>
  .filter-editor {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .and-group {
    background: var(--color-background);
    border: 1px solid var(--color-background-mute);
    border-radius: 4px;
    padding: 0.4rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .condition-row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .and-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--ev-c-text-3);
    text-transform: uppercase;
    width: 2rem;
    flex-shrink: 0;
  }
  .target-select {
    min-width: 4.5rem;
  }
  .field-select {
    min-width: 7rem;
  }
  .op-select {
    min-width: 4.5rem;
  }
  .value-input {
    flex: 1;
    min-width: 5rem;
  }
  .or-separator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.15rem 0;
  }
  .or-separator span {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--ev-c-text-3);
    text-transform: uppercase;
  }
  .or-separator::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--color-background-mute);
  }
  .remove-btn {
    background: none;
    border: none;
    color: var(--ev-c-text-3);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 0.2rem;
    flex-shrink: 0;
  }
  .remove-btn:hover {
    color: #e81123;
  }
  .add-link {
    background: none;
    border: none;
    color: var(--ev-c-text-3);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.15rem 0;
    text-align: left;
    width: fit-content;
  }
  .add-link:hover {
    color: var(--ev-c-text-1);
  }
  .add-or {
    margin-top: 0.15rem;
  }
</style>
