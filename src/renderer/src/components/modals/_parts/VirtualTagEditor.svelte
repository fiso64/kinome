<script lang="ts">
  import Icon from '@components/ui/Icon.svelte'
  import type { VirtualTagConfig, AutocompleteSuggestions } from '@shared/types'
  import FilterEditor from './FilterEditor.svelte'

  let {
    tag = $bindable(),
    suggestions
  }: {
    tag: VirtualTagConfig
    suggestions?: AutocompleteSuggestions
  } = $props()

  // Normalize all cases to use conditionGroups (migrate legacy conditions format)
  $effect(() => {
    let changed = false
    for (const vtCase of tag.cases) {
      if (!vtCase.filter.conditionGroups) {
        vtCase.filter.conditionGroups = vtCase.filter.conditions?.length
          ? [vtCase.filter.conditions]
          : [[{ field: 'genre', op: 'contains', value: '' }]]
        vtCase.filter.conditions = undefined
        changed = true
      }
    }
    if (changed) tag.cases = [...tag.cases]
  })

  function addCase() {
    tag.cases = [
      ...tag.cases,
      {
        filter: { conditionGroups: [[{ field: 'genre', op: 'contains', value: '' }]] },
        result: ''
      }
    ]
  }

  function removeCase(index: number) {
    tag.cases = tag.cases.filter((_, i) => i !== index)
  }
</script>

<div class="form-stack">
  <div class="form-field">
    <label for="virtual-tag-name">Tag name</label>
    <input id="virtual-tag-name" type="text" bind:value={tag.name} placeholder="e.g. is_animated" />
  </div>

  <div class="cases-list">
    {#each tag.cases as vtCase, i (vtCase)}
      <section class="case-block raised-surface">
        <header class="case-header">
          <h3>{i === 0 ? 'If' : 'Else if'}</h3>
          <button type="button" class="icon-button remove-case" onclick={() => removeCase(i)}
            aria-label={`Remove case ${i + 1}`}><Icon name="trash" size={16} /></button>
        </header>
        {#if vtCase.filter.conditionGroups}
          <FilterEditor bind:groups={vtCase.filter.conditionGroups} {suggestions} />
        {/if}
        <div class="form-field">
          <label for={`virtual-tag-result-${i}`}>Result</label>
          <input id={`virtual-tag-result-${i}`} type="text" bind:value={vtCase.result} />
        </div>
      </section>
    {/each}
  </div>

  <button class="add-case" type="button" onclick={addCase}><Icon name="plus" size={16} /> Add case</button>

  <div class="form-field">
    <label for="virtual-tag-default">Default result</label>
    <input id="virtual-tag-default" type="text" bind:value={tag.defaultResult} />
  </div>
</div>

<style>
  .cases-list, .case-block { display: grid; gap: .6rem; min-width: 0; }
  .case-block { padding: .65rem; }
  .case-header { display: flex; justify-content: space-between; align-items: center; gap: .35rem; }
  .case-header h3 { color: var(--color-primary-soft); font-size: .88rem; font-weight: 670; }
  .remove-case { width: 29px; height: 29px; }
  .remove-case:hover { color: var(--color-danger-soft); }
  .add-case { display: inline-flex; align-items: center; gap: .3rem; justify-self: start; }
</style>
