<script lang="ts">
  import type { VirtualTagConfig, VirtualTagCondition, VirtualTagTarget, VirtualTagOperator } from '../../../../../../shared/types'

  let { tag = $bindable(), onDelete }: { tag: VirtualTagConfig, onDelete: () => void } = $props()

  function addCondition() {
    tag.conditions = [...tag.conditions, {
      target: 'genre',
      operator: 'contains',
      value: '',
      result: ''
    }]
  }

  function removeCondition(index: number) {
    const newConds = [...tag.conditions]
    newConds.splice(index, 1)
    tag.conditions = newConds
  }

  const targets: { value: VirtualTagTarget; label: string }[] = [
    { value: 'genre', label: 'Genre' },
    { value: 'tag', label: 'Custom Tag' },
    { value: 'year', label: 'Year' },
    { value: 'title', label: 'Title' },
    { value: 'mediaType', label: 'Media Type' },
    { value: 'path', label: 'File Path' }
  ]

  const operators: { value: VirtualTagOperator; label: string }[] = [
    { value: 'equals', label: 'Equals' },
    { value: 'contains', label: 'Contains' },
    { value: 'greaterThan', label: 'Greater Than' },
    { value: 'lessThan', label: 'Less Than' }
  ]
</script>

<div class="virtual-tag-editor">
  <div class="header">
    <input type="text" bind:value={tag.name} placeholder="Virtual Tag Name (e.g. is_animated)" class="tag-name-input" />
    <button class="remove-btn" onclick={onDelete} title="Remove Virtual Tag">&times;</button>
  </div>

  <div class="conditions-list">
    {#each tag.conditions as condition, i}
      <div class="condition-row">
        <span class="if-label">{i === 0 ? 'If' : 'Else If'}</span>
        <select bind:value={condition.target}>
          {#each targets as t}
            <option value={t.value}>{t.label}</option>
          {/each}
        </select>

        {#if condition.target === 'tag'}
          <input type="text" bind:value={condition.targetKey} placeholder="Tag Key" class="small-input" />
        {/if}

        <select bind:value={condition.operator}>
          {#each operators as op}
            <option value={op.value}>{op.label}</option>
          {/each}
        </select>

        <input type="text" bind:value={condition.value} placeholder="Value" />

        <span class="then-label">Then</span>
        <input type="text" bind:value={condition.result} placeholder="Result (e.g. Yes)" />

        <button class="remove-condition-btn" onclick={() => removeCondition(i)}>&times;</button>
      </div>
    {/each}
  </div>

  <div class="footer-row">
    <button class="secondary small" onclick={addCondition}>+ Add Condition</button>
    
    <div class="default-result">
      <span>Else</span>
      <input type="text" bind:value={tag.defaultResult} placeholder="Default Result" />
    </div>
  </div>
</div>

<style>
  .virtual-tag-editor {
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    border-radius: 6px;
    padding: 1rem;
    margin-bottom: 1rem;
  }
  .header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  .tag-name-input {
    font-weight: bold;
    flex-grow: 1;
    margin-right: 1rem;
  }
  .remove-btn {
    background: none;
    border: none;
    color: var(--ev-c-text-2);
    font-size: 1.5rem;
    cursor: pointer;
    line-height: 1;
  }
  .remove-btn:hover {
    color: #e81123;
  }
  .conditions-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .condition-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    background-color: var(--color-background-soft);
    padding: 0.5rem;
    border-radius: 4px;
    flex-wrap: wrap;
  }
  .small-input {
    width: 80px;
  }
  .if-label, .then-label {
    font-weight: bold;
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
    width: 30px; 
  }
  .then-label {
    text-align: center;
  }
  .remove-condition-btn {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--ev-c-text-2);
    cursor: pointer;
    font-size: 1.2rem;
  }
  .remove-condition-btn:hover {
    color: #e81123;
  }
  .footer-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.5rem;
  }
  .default-result {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .default-result span {
    font-weight: bold;
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
  }
  button.small {
    padding: 0.3rem 0.6rem;
    font-size: 0.85rem;
  }
</style>