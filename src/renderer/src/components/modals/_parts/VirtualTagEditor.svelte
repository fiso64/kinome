<script lang="ts">
  import type { VirtualTagConfig, VirtualTagCase, LibraryConditionOp } from '@shared/types'

  let { tag = $bindable(), onDelete }: { tag: VirtualTagConfig; onDelete: () => void } = $props()

  function addCase() {
    tag.cases = [
      ...tag.cases,
      { filter: { conditions: [{ field: 'genre', op: 'contains', value: '' }] }, result: '' }
    ]
  }

  function removeCase(index: number) {
    const updated = [...tag.cases]
    updated.splice(index, 1)
    tag.cases = updated
  }

  // Each case editor works on the first condition of the filter (single-condition UI)
  function getCondition(vtCase: VirtualTagCase) {
    return vtCase.filter.conditions?.[0] ?? { field: 'genre', op: 'contains' as LibraryConditionOp, value: '' }
  }

  const fields: { value: string; label: string }[] = [
    { value: 'genre', label: 'Genre' },
    { value: 'year', label: 'Year' },
    { value: 'title', label: 'Title' },
    { value: 'mediaType', label: 'Media Type' },
    { value: 'path', label: 'File Path' },
    { value: 'addedDaysAgo', label: 'Days Since Added' }
  ]

  const operators: { value: LibraryConditionOp; label: string }[] = [
    { value: 'eq', label: 'Equals' },
    { value: 'ne', label: 'Not Equals' },
    { value: 'contains', label: 'Contains' },
    { value: 'gt', label: 'Greater Than' },
    { value: 'lt', label: 'Less Than' }
  ]
</script>

<div class="virtual-tag-editor">
  <div class="header">
    <input
      type="text"
      bind:value={tag.name}
      placeholder="Virtual Tag Name (e.g. is_animated)"
      class="tag-name-input"
    />
    <button class="remove-btn" onclick={onDelete} title="Remove Virtual Tag">&times;</button>
  </div>

  <div class="conditions-list">
    {#each tag.cases as vtCase, i}
      {@const cond = getCondition(vtCase)}
      <div class="condition-row">
        <span class="if-label">{i === 0 ? 'If' : 'Else If'}</span>
        <select bind:value={cond.field}>
          {#each fields as f}
            <option value={f.value}>{f.label}</option>
          {/each}
        </select>

        <select bind:value={cond.op}>
          {#each operators as op}
            <option value={op.value}>{op.label}</option>
          {/each}
        </select>

        <input type="text" bind:value={cond.value} placeholder="Value" />

        <span class="then-label">Then</span>
        <input type="text" bind:value={vtCase.result} placeholder="Result (e.g. Yes)" />

        <button class="remove-condition-btn" onclick={() => removeCase(i)}>&times;</button>
      </div>
    {/each}
  </div>

  <div class="footer-row">
    <button class="secondary small" onclick={addCase}>+ Add Case</button>

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
.if-label,
  .then-label {
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
