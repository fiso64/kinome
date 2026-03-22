<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import { useDragSort } from '@lib/drag-sort.svelte'
  import type { CustomActionConfig } from '@shared/types'
  import { flip } from 'svelte/animate'
  import IconX from '@components/ui/IconX.svelte'

  let {
    customActions = $bindable(),
    onClose
  }: {
    customActions: CustomActionConfig[]
    onClose: () => void
  } = $props()

  let localCustomActions = $state<CustomActionConfig[]>(JSON.parse(JSON.stringify(customActions)))
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
      localCustomActions.push({
        id: crypto.randomUUID(),
        name: formCommandNameForNew.trim(),
        command: formCommandStringForNew.trim()
      })
      localCustomActions = [...localCustomActions]
      formCommandNameForNew = ''
      formCommandStringForNew = ''
    }
  }

  function handleSave() {
    customActions = JSON.parse(JSON.stringify(localCustomActions))
    onClose()
  }

</script>

<ModalWindow
  title="Manage Custom Actions"
  {onClose}
  onSave={handleSave}
  maxWidth="700px"
  zIndex={101}
>
  <div class="content">
    <div class="command-list">
      {#if localCustomActions.length === 0}
        <p class="empty-list-text">No custom actions configured. Add one below.</p>
      {:else}
        {#each localCustomActions as cmd, i (cmd.id)}
          <div
            class="command-item"
            use:drag.item={i}
            use:drag.handle={i}
            class:drag-placeholder={drag.draggedIndex === i}
            class:editing={editCommandId === cmd.id}
            animate:flip={{ duration: 200 }}
            onclick={() => {
              if (editCommandId === cmd.id) {
                editCommandId = null
              } else {
                editCommandId = cmd.id
              }
            }}
          >
            <div class="drag-handle">⠿</div>
            {#if editCommandId === cmd.id}
              <div class="command-edit-inputs">
                <input
                  type="text"
                  bind:value={cmd.name}
                  placeholder="Action Name"
                  onclick={(e) => e.stopPropagation()}
                  oninput={(e) => {
                    e.stopPropagation()
                    localCustomActions = localCustomActions
                  }}
                />
                <input
                  type="text"
                  bind:value={cmd.command}
                  placeholder="Command"
                  onclick={(e) => e.stopPropagation()}
                  oninput={(e) => {
                    e.stopPropagation()
                    localCustomActions = localCustomActions
                  }}
                />
              </div>
            {:else}
              <div class="command-details">
                <div class="command-name">{cmd.name}</div>
                <div class="command-string">{cmd.command}</div>
              </div>
            {/if}
            <button
              class="remove-btn"
              onclick={(e) => {
                e.stopPropagation()
                removeCommand(cmd.id)
              }}><IconX size={14} /></button
            >
          </div>
        {/each}
      {/if}
    </div>

    <div class="help-text">
      <p>
        Available variables: <code>{'{path}'}</code> <code>{'{title}'}</code>
        <code>{'{type}'}</code> <code>{'{year}'}</code>
      </p>
      <p>
        Be sure to wrap variables like <code>{'{path}'}</code> in quotes (e.g.,
        <code>&quot;{'{path}'}&quot;</code>) to handle spaces correctly in your command.
      </p>
    </div>

    <div class="add-command-form">
      <h4>Add New Action</h4>
      <input
        type="text"
        bind:value={formCommandNameForNew}
        placeholder="Action Name (e.g., Convert to MP4)"
      />
      <input
        type="text"
        bind:value={formCommandStringForNew}
        placeholder="Command (e.g., ffmpeg -i &quot;{'{path}'}&quot; &quot;{'{path}'}.mp4&quot;)"
      />
      <div class="form-actions">
        <button
          class="primary add-btn"
          onclick={handleAddCommand}
          disabled={!formCommandNameForNew.trim() || !formCommandStringForNew.trim()}
        >
          Add Action
        </button>
      </div>
    </div>
  </div>
</ModalWindow>

<style>
  .content {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .command-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 40vh;
    overflow-y: auto;
    border: 1px solid var(--color-background-mute);
    border-radius: 6px;
    padding: 0.5rem;
    background-color: var(--color-background);
  }
  .empty-list-text {
    text-align: center;
    color: var(--ev-c-text-2);
    padding: 1rem;
  }
  .command-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    background-color: var(--color-background-soft);
    border-radius: 4px;
    border: 1px solid transparent;
  }
  .command-item.drag-placeholder {
    opacity: 0.25;
    pointer-events: none;
  }
  .command-item.editing {
    background-color: var(--ev-c-gray-3);
    border-color: var(--ev-c-gray-1);
    cursor: default;
  }
  .drag-handle {
    color: var(--ev-c-text-2);
    font-size: 1.2rem;
    padding: 0 0.25rem;
  }
  .command-details {
    flex-grow: 1;
  }
  .command-name {
    font-weight: bold;
  }
  .command-string {
    font-size: 0.85rem;
    color: var(--ev-c-text-2);
    word-break: break-all;
  }
  .command-edit-inputs {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .command-edit-inputs input {
    padding: 0.25rem 0.5rem;
    font-size: 0.9rem;
  }
  .remove-btn {
    background: none;
    color: var(--ev-c-text-2);
    padding: 0;
    cursor: pointer;
    border-radius: 50%;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .remove-btn:hover {
    color: #e81123;
    background-color: var(--ev-c-gray-3);
  }
  .help-text {
    font-size: 0.8rem;
    color: var(--ev-c-text-2);
    line-height: 1.5;
    padding: 1rem;
    background: var(--color-background);
    border-radius: 6px;
  }
  .help-text code {
    font-size: 0.8rem;
    padding: 2px 4px;
    background-color: var(--color-background-mute);
    border-radius: 3px;
  }
  .add-command-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-background-mute);
  }
  .add-command-form h4 {
    font-weight: bold;
    margin-bottom: 0.25rem;
  }
  .form-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .add-btn {
    align-self: flex-start;
  }
</style>
