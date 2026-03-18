<script lang="ts">
  import type { VirtualTagConfig, LibraryCondition, AutocompleteSuggestions } from '@shared/types'
  import FilterEditor from './FilterEditor.svelte'

  let {
    tag = $bindable(),
    booleanOnly = false,
    suggestions,
    onDelete
  }: {
    tag: VirtualTagConfig
    booleanOnly?: boolean
    suggestions?: AutocompleteSuggestions
    onDelete: () => void
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
      if (booleanOnly && vtCase.result !== 'true') {
        vtCase.result = 'true'
        changed = true
      }
    }
    if (booleanOnly && tag.defaultResult !== 'false') {
      tag.defaultResult = 'false'
      changed = true
    }
    if (changed) tag.cases = [...tag.cases]
  })

  function addCase() {
    tag.cases = [
      ...tag.cases,
      {
        filter: { conditionGroups: [[{ field: 'genre', op: 'contains', value: '' }]] },
        result: booleanOnly ? 'true' : ''
      }
    ]
  }

  function removeCase(index: number) {
    tag.cases = tag.cases.filter((_, i) => i !== index)
  }
</script>

<div class="virtual-tag-editor">
  <div class="header">
    <input
      type="text"
      bind:value={tag.name}
      placeholder="Tag name (e.g. is_animated)"
      class="tag-name-input"
    />
    <button class="delete-btn" onclick={onDelete} title="Remove Virtual Tag">&times;</button>
  </div>

  <div class="cases-list">
    {#each tag.cases as vtCase, i}
      <div class="case-block">
        <div class="case-header">
          <span class="case-label">{i === 0 ? 'If' : 'Else if'}</span>
          <button class="remove-case-btn" onclick={() => removeCase(i)} title="Remove case">&times;</button>
        </div>
        {#if vtCase.filter.conditionGroups}
          <FilterEditor bind:groups={vtCase.filter.conditionGroups} {suggestions} />
        {/if}
        {#if !booleanOnly}
          <div class="result-row">
            <span class="result-label">→</span>
            <input type="text" bind:value={vtCase.result} placeholder="Result value" class="result-input" />
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <div class="footer">
    <button class="add-link" onclick={addCase}>+ Add case</button>
    {#if !booleanOnly}
      <div class="default-row">
        <span class="else-label">Else →</span>
        <input type="text" bind:value={tag.defaultResult} placeholder="Default" class="default-input" />
      </div>
    {/if}
  </div>
</div>

<style>
  .virtual-tag-editor {
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-background-mute);
    border-radius: 6px;
    padding: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }
  .tag-name-input {
    font-weight: bold;
    flex: 1;
    margin-right: 0.5rem;
    font-size: 0.95rem;
  }
  .delete-btn {
    background: none;
    border: none;
    color: var(--ev-c-text-3);
    font-size: 1.4rem;
    cursor: pointer;
    line-height: 1;
  }
  .delete-btn:hover {
    color: #e81123;
  }
  .cases-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .case-block {
    border: 1px solid var(--color-background-mute);
    border-radius: 4px;
    padding: 0.5rem;
    background: var(--color-background);
  }
  .case-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.35rem;
  }
  .case-label {
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--ev-c-text-2);
    text-transform: uppercase;
  }
  .remove-case-btn {
    background: none;
    border: none;
    color: var(--ev-c-text-3);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
  }
  .remove-case-btn:hover {
    color: #e81123;
  }
  .result-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.4rem;
    padding-top: 0.35rem;
    border-top: 1px solid var(--color-background-mute);
  }
  .result-label {
    font-weight: 600;
    color: var(--ev-c-text-2);
    font-size: 0.9rem;
  }
  .result-input {
    flex: 1;
  }
  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.25rem;
  }
  .add-link {
    background: none;
    border: none;
    color: var(--ev-c-text-3);
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0.2rem 0;
  }
  .add-link:hover {
    color: var(--ev-c-text-1);
  }
  .default-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .else-label {
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--ev-c-text-2);
    white-space: nowrap;
  }
  .default-input {
    width: 8rem;
  }
</style>
