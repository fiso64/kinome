<script lang="ts">
  import {
    autocomplete,
    getFuzzySuggestions,
    type AutocompleteConfig
  } from '@lib/autocomplete-manager'
  import { getMetadataField, isBuiltinMetadataField, metadataSuggestionLookup, METADATA_RULE_FIELDS } from '@shared/metadata-fields'
  import { getMetadataSuggestions } from '@lib/metadata-autocomplete'
  import type { LibraryCondition, LibraryConditionOp, AutocompleteSuggestions } from '@shared/types'
  import Icon from '@components/ui/Icon.svelte'

  let {
    groups = $bindable(),
    suggestions
  }: {
    groups: LibraryCondition[][]
    suggestions?: AutocompleteSuggestions
  } = $props()

  const fields = $derived.by(() => {
    const result: { value: string; label: string }[] = [...METADATA_RULE_FIELDS]
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

  const knownFields = $derived(new Set(fields.map((field) => field.value)))

  const operators: { value: LibraryConditionOp; label: string }[] =[
    { value: 'eq', label: '=' },
    { value: 'ne', label: '!=' },
    { value: 'contains', label: 'contains' },
    { value: 'notContains', label: 'does not contain' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '>=' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '<=' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' }
  ]

  const orderedOperators = new Set<LibraryConditionOp>(['gt', 'gte', 'lt', 'lte'])

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
    if (getMetadataField(base)?.kind === 'list' && orderedOperators.has(cond.op)) cond.op = 'eq'
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

  function getTagValues(field: string): string[] {
    if (!suggestions) return []
    if (field.startsWith('vt.')) return suggestions.virtualTags?.[field.slice(3)] ?? []
    if (field.startsWith('tags.')) return suggestions.tags?.[field.slice(5)] ?? []
    return []
  }

  function makeAutocompleteConfig(cond: LibraryCondition): AutocompleteConfig {
    return {
      getSuggestions: async (text) => {
        const field = getBaseField(cond.field)
        const values = isBuiltinMetadataField(field)
          ? await getMetadataSuggestions(field, text, suggestions)
          : getTagValues(field)
        return getFuzzySuggestions(values, text)
      },
      onSelect: (suggestion, node) => {
        cond.value = suggestion.label
        ;(node as HTMLInputElement).value = suggestion.label
      },
      triggerOnFocus: true
    }
  }
</script>

<div class="filter-editor">
  {#each groups as group, gi (group)}
    {#if gi > 0}
      <div class="or-separator"><span>OR</span></div>
    {/if}
    <div class="and-group" role="group" aria-label={`Condition group ${gi + 1}`}>
      {#each group as cond, ci (cond)}
        <div class="condition-row">
          {#if ci > 0}
            <span class="and-label">AND</span>
          {/if}
          <select
            value={getTarget(cond.field)}
            onchange={(e) => setTarget(cond, e.currentTarget.value as 'item' | 'parent')}
            class="target-select" aria-label="Match item or parent"
          >
            <option value="item">Item</option>
            <option value="parent">Parent</option>
          </select>
          <select
            value={getBaseField(cond.field)}
            onchange={(e) => setField(cond, e.currentTarget.value)}
            class="field-select" aria-label="Metadata field"
          >
            {#each fields as f}
              <option value={f.value}>{f.label}</option>
            {/each}
            {#if !knownFields.has(getBaseField(cond.field))}
              <option value={getBaseField(cond.field)}>{getBaseField(cond.field)}</option>
            {/if}
          </select>
          <select bind:value={cond.op} class="op-select" aria-label="Comparison">
            {#each operators as op}
              {#if getMetadataField(getBaseField(cond.field))?.kind !== 'list' || !orderedOperators.has(op.value)}
                <option value={op.value}>{op.label}</option>
              {/if}
            {/each}
          </select>
          {#if cond.op !== 'isNull' && cond.op !== 'isNotNull' && cond.op !== 'isEmpty' && cond.op !== 'isNotEmpty'}
            {@const field = getBaseField(cond.field)}
            {@const showSuggestions = isBuiltinMetadataField(field)
              ? !!metadataSuggestionLookup(field)
              : getTagValues(field).length > 0}
            {#if showSuggestions}
              <input
                type="text"
                bind:value={cond.value}
                placeholder="Value" aria-label="Comparison value"
                class="value-input"
                use:autocomplete={makeAutocompleteConfig(cond)}
              />
            {:else}
              <input type="text" bind:value={cond.value} placeholder="Value" aria-label="Comparison value" class="value-input" />
            {/if}
          {/if}
          <button
            type="button" class="icon-button remove-btn" aria-label="Remove condition"
            onclick={() => removeCondition(gi, ci)}
            title="Remove condition"><Icon name="close" size={16} /></button
          >
        </div>
      {/each}
      <button type="button" class="add-link" onclick={() => addCondition(gi)}><Icon name="plus" size={15} /> Add AND condition</button>
    </div>
  {/each}
  <button type="button" class="add-link add-or" onclick={addGroup}>
    <Icon name="plus" size={15} /> {groups.length === 0 ? 'Add condition' : 'Add OR group'}
  </button>
</div>

<style>
  .filter-editor {
    display: grid;
    gap: .45rem;
    min-width: 0;
    container-type: inline-size;
  }
  .and-group {
    display: grid;
    gap: .4rem;
    min-width: 0;
    padding: .55rem;
    background: var(--color-inset);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--radius-field);
  }
  .condition-row {
    display: grid;
    grid-template-columns: minmax(3.65rem, 1fr) minmax(0, 1.6fr) minmax(0, 1.55fr) minmax(0, 1.75fr) auto;
    gap: .32rem;
    align-items: center;
    min-width: 0;
  }
  .condition-row :is(input, select) { width: 100%; font-size: .81rem; padding: .39rem .44rem; }
  .condition-row .remove-btn { grid-column: -2; width: 28px; height: 28px; }
  .remove-btn:hover { color: var(--color-danger-soft); }
  .and-label, .or-separator { color: var(--color-primary-soft); font-size: .7rem; font-weight: 680; }
  .and-label { grid-column: 1 / -1; margin-top: .15rem; }
  .or-separator { display: flex; gap: .5rem; align-items: center; }
  .or-separator::after { content: ''; background: var(--section-rule); height: 1px; flex: 1; }
  .add-link {
    display: inline-flex;
    align-items: center;
    gap: .25rem;
    justify-self: start;
    padding: .28rem .45rem;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    color: var(--color-text-soft);
    font-size: .8rem;
  }
  .add-link:hover { color: var(--color-primary-soft); background: var(--color-hover); }
  .add-or { border-color: var(--color-border); }

  @container (max-width: 540px) {
    .condition-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr) auto; }
    .target-select { grid-row: auto; }
    .condition-row .remove-btn { grid-column: 3; grid-row: 1; }
    .condition-row:has(.and-label) .remove-btn { grid-row: 2; }
    .value-input { grid-column: 2 / 4; }
  }

  @container (max-width: 285px) {
    .condition-row { grid-template-columns: minmax(0, 1fr) auto; }
    .condition-row .remove-btn { grid-column: 2; }
    .field-select, .op-select, .value-input { grid-column: 1 / -1; }
  }
</style>
