<script lang="ts">
  import { dialogStore } from '@lib/dialog-store'
  import Icon from '@components/ui/Icon.svelte'
  import ModalWindow from './_base/ModalWindow.svelte'
  import { useDragSort } from '@lib/drag-sort.svelte'
  import type { CustomActionConfig } from '@shared/types'
  import { prefersReducedMotion } from 'svelte/motion'
  import { flip } from 'svelte/animate'

  let {
    customActions,
    onDone,
    onClose
  }: {
    customActions: CustomActionConfig[]
    onDone: (actions: CustomActionConfig[]) => void
    onClose: () => void
  } = $props()

  let localCustomActions = $state<CustomActionConfig[]>(customActions.map((action) => ({ ...action })))
  let editCommandId = $state<string | null>(null)
  let formCommandNameForNew = $state('')
  let formCommandStringForNew = $state('')

  const drag = useDragSort(
    () => localCustomActions,
    (items) => (localCustomActions = items)
  )

  function removeCommand(id: string) {
    localCustomActions = localCustomActions.filter((cmd) => cmd.id !== id)
    if (editCommandId === id) {
      editCommandId = null
    }
  }

  function handleAddCommand() {
    if (formCommandNameForNew.trim() && formCommandStringForNew.trim()) {
      localCustomActions = [...localCustomActions, {
        id: crypto.randomUUID(),
        name: formCommandNameForNew.trim(),
        command: formCommandStringForNew.trim()
      }]
      formCommandNameForNew = ''
      formCommandStringForNew = ''
    }
  }

  function handleDone() {
    if (formCommandNameForNew.trim() || formCommandStringForNew.trim()) {
      if (!formCommandNameForNew.trim() || !formCommandStringForNew.trim()) {
        dialogStore.showError({ title: 'Incomplete Action', message: 'Enter a name and command for the new action.' })
        return
      }
      handleAddCommand()
    }
    onDone($state.snapshot(localCustomActions))
    onClose()
  }

</script>

<ModalWindow title="Custom actions" {onClose} onDone={handleDone} maxWidth="680px" zIndex={101}>
  <div class="form-stack">
    <div class="command-list">
      {#each localCustomActions as action, i (action.id)}
        <div class="command-card raised-surface" class:drag-placeholder={drag.draggedIndex === i}
          use:drag.item={i} animate:flip={{ duration: prefersReducedMotion.current ? 0 : 145 }}>
          <div class="command-header">
            <span class="drag-handle" use:drag.handle={i} title="Drag to reorder"><Icon name="grip" size={16} /></span>
            <button type="button" class="action-toggle" aria-expanded={editCommandId === action.id}
              onclick={() => (editCommandId = editCommandId === action.id ? null : action.id)}>
              <span>{action.name || 'Unnamed action'}</span>
              <Icon name={editCommandId === action.id ? 'up' : 'edit'} size={16} />
            </button>
            <button type="button" class="icon-button remove-action" aria-label={`Remove ${action.name || 'action'}`}
              onclick={() => removeCommand(action.id)}><Icon name="trash" size={17} /></button>
          </div>
          {#if editCommandId === action.id}
            <div class="edit-fields">
              <div class="form-field">
                <label for={`action-name-${action.id}`}>Name</label>
                <input type="text" id={`action-name-${action.id}`} bind:value={action.name} />
              </div>
              <div class="form-field">
                <label for={`action-command-${action.id}`}>Command</label>
                <input type="text" class="command" id={`action-command-${action.id}`} bind:value={action.command} />
              </div>
            </div>
          {:else}
            <code>{action.command}</code>
          {/if}
        </div>
      {:else}
        <p class="form-hint">No custom actions configured.</p>
      {/each}
    </div>

    <form class="add-command raised-surface"
      onsubmit={(event) => { event.preventDefault(); handleAddCommand() }}>
      <h3>Add action</h3>
      <div class="form-field">
        <label for="new-action-name">Name</label>
        <input type="text" id="new-action-name" bind:value={formCommandNameForNew} required />
      </div>
      <div class="form-field">
        <label for="new-action-command">Command</label>
        <input type="text" id="new-action-command" class="command" bind:value={formCommandStringForNew} required />
      </div>
      <p class="form-hint">
        Variables are <code>{'{path}'}</code>, <code>{'{title}'}</code>, <code>{'{type}'}</code>, and <code>{'{year}'}</code>.
        Quote variables that may contain spaces.
      </p>
      <button type="submit" class="secondary"
        disabled={!formCommandNameForNew.trim() || !formCommandStringForNew.trim()}>
        <Icon name="plus" size={16} /> Add action
      </button>
    </form>
  </div>
</ModalWindow>

<style>
  .command-list, .edit-fields, .add-command { display: grid; min-width: 0; gap: .55rem; }
  .command-card, .add-command { padding: .55rem .65rem; }
  .command-card.drag-placeholder { opacity: .28; }
  .command-header { display: flex; min-width: 0; align-items: center; gap: .3rem; }
  .drag-handle { display: flex; color: var(--color-text-soft); align-items: center; align-self: stretch; cursor: grab; }
  .action-toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: .4rem;
    padding: .32rem;
    text-align: left;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    overflow-wrap: anywhere;
  }
  .action-toggle:hover, .action-toggle[aria-expanded='true'] { color: var(--color-primary-soft); }
  .remove-action:hover { color: var(--color-danger-soft); }
  .edit-fields { padding: .35rem; }
  code, .command { font-family: ui-monospace, monospace; }
  code { color: var(--color-primary-soft); overflow-wrap: anywhere; }
  .command-card > code { display: block; color: var(--color-text-soft); margin: .25rem .4rem; font-size: .8rem; }
  .add-command { padding: .85rem; }
  .add-command h3 { font-size: .95rem; }
  .add-command button { justify-self: start; display: inline-flex; align-items: center; gap: .25rem; }
</style>
