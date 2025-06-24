<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import type { PlayerCommandConfig } from '../../../../shared/types'

  let {
    playerCommands = $bindable(),
    onClose
  }: {
    playerCommands: PlayerCommandConfig[]
    onClose: () => void
  } = $props()

  let localPlayerCommands = $state<PlayerCommandConfig[]>(
    JSON.parse(JSON.stringify(playerCommands))
  )
  let editCommandId = $state<string | null>(null) // ID of the command being edited
  let formCommandNameForNew = $state('') // For adding a new command
  let formCommandStringForNew = $state('') // For adding a new command

  // Drag and drop state
  let draggedItemIndex = $state<number | null>(null)
  let dragOverItemIndex = $state<number | null>(null)

  function addCommand() {
    if (newCommandName.trim() && newCommandString.trim()) {
      localPlayerCommands.push({
        id: crypto.randomUUID(),
        name: newCommandName.trim(),
        command: newCommandString.trim()
      })
      localPlayerCommands = localPlayerCommands // Trigger reactivity
      newCommandName = ''
      newCommandString = ''
    }
  }

  function removeCommand(id: string) {
    localPlayerCommands = localPlayerCommands.filter((cmd) => cmd.id !== id)
    if (editCommandId === id) {
      // If the removed command was being edited, reset the form
      clearForm()
    }
  }

  function populateFormForEdit(command: PlayerCommandConfig) {
    editCommandId = command.id
    // No need to set formCommandName/String here, we'll bind directly to the item
  }

  function clearForm() {
    editCommandId = null
    // The form will bind to a temporary 'newItem' object or similar
    // or simply be disabled/cleared if no item is selected for edit
    // and we are in 'add new' mode.
    // For simplicity now, we just clear the editCommandId.
    // The input fields will reflect the selected item or be empty for a new one.
  }

  function handleAddCommand() {
    // This function is now solely for adding a *new* command.
    // We'll need temporary state for the new command's name and string if not using a selected item.
    // For now, let's assume we use a dedicated "new item" state if `editCommandId` is null.
    // Or, more simply, the "Add Player" button will use separate input fields,
    // and the list items, when clicked, will make their fields editable directly or open a small inline edit.

    // Let's simplify: Add button now works on temporary new item state, separate from editing.
    // The form at the bottom will always be for adding a new item unless an item is *explicitly* selected for edit.
    // For now, we'll keep it simple: editing happens by clicking the item, then the main "Save & Close".
    // The "Add Player" button at the bottom is for *new* players.

    // The existing form fields `formCommandName` and `formCommandString` will be for a new item.
    if (formCommandNameForNew.trim() && formCommandStringForNew.trim()) {
      localPlayerCommands.push({
        id: crypto.randomUUID(),
        name: formCommandNameForNew.trim(),
        command: formCommandStringForNew.trim()
      })
      localPlayerCommands = [...localPlayerCommands]
      formCommandNameForNew = '' // Clear inputs for new item
      formCommandStringForNew = ''
    }
  }


  function handleSave() {
    playerCommands = JSON.parse(JSON.stringify(localPlayerCommands))
    onClose()
  }

  // --- Drag and Drop Handlers ---
  function handleDragStart(event: DragEvent, index: number) {
    draggedItemIndex = index
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      // Set some dummy data to make dragging work in Firefox
      event.dataTransfer.setData('text/plain', index.toString())
    }
  }

  function handleDragOver(event: DragEvent, index: number) {
    event.preventDefault() // Necessary to allow dropping
    if (draggedItemIndex !== null && index !== draggedItemIndex) {
      dragOverItemIndex = index
    }
  }

  function handleDrop(event: DragEvent, dropIndex: number) {
    event.preventDefault()
    if (draggedItemIndex === null || draggedItemIndex === dropIndex) {
      dragOverItemIndex = null
      return
    }

    const itemToMove = localPlayerCommands[draggedItemIndex]
    localPlayerCommands.splice(draggedItemIndex, 1) // Remove from old position
    localPlayerCommands.splice(dropIndex, 0, itemToMove) // Insert at new position

    localPlayerCommands = localPlayerCommands // Trigger reactivity
    draggedItemIndex = null
    dragOverItemIndex = null
  }

  function handleDragEnd() {
    draggedItemIndex = null
    dragOverItemIndex = null
  }
</script>

<ModalWindow
  title="Manage Player Commands"
  {onClose}
  onSave={handleSave}
  maxWidth="700px"
  zIndex={101}
>
  <div class="content">
    <div class="command-list">
      {#if localPlayerCommands.length === 0}
        <p class="empty-list-text">No player commands configured. Add one below.</p>
      {/if}
      {#each localPlayerCommands as cmd, i (cmd.id)}
        <div
          class="command-item"
          draggable="true"
          ondragstart={(e) => handleDragStart(e, i)}
          ondragover={(e) => handleDragOver(e, i)}
          ondragenter={(e) => e.preventDefault()}
          ondrop={(e) => handleDrop(e, i)}
          ondragend={handleDragEnd}
          class:dragging-over={dragOverItemIndex === i}
          class:editing={editCommandId === cmd.id}
          onclick={() => {
            if (editCommandId === cmd.id) {
              editCommandId = null // Click again to de-select for editing
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
                placeholder="Player Name"
                onclick={(e) => e.stopPropagation()}
                oninput={(e) => {
                  e.stopPropagation()
                  localPlayerCommands = localPlayerCommands
                }}
              />
              <input
                type="text"
                bind:value={cmd.command}
                placeholder="Player Command"
                onclick={(e) => e.stopPropagation()}
                oninput={(e) => {
                  e.stopPropagation()
                  localPlayerCommands = localPlayerCommands
                }}
              />
            </div>
          {:else}
            <div class="command-details">
              <div class="command-name">{cmd.name} {i === 0 ? '(Default)' : ''}</div>
              <div class="command-string">{cmd.command}</div>
            </div>
          {/if}
          <button
            class="remove-btn"
            onclick={(e) => {
              e.stopPropagation()
              removeCommand(cmd.id)
            }}>&times;</button
          >
        </div>
      {/each}
    </div>

    <div class="add-command-form">
      <h4>Add New Player</h4>
      <input
        type="text"
        bind:value={formCommandNameForNew}
        placeholder="Player Name (e.g., MPV)"
      />
      <input
        type="text"
        bind:value={formCommandStringForNew}
        placeholder="Command (e.g., mpv --fullscreen &quot;{'{PATH}'}&quot;)"
      />
      <div class="form-actions">
        <button
          class="primary add-btn"
          onclick={handleAddCommand}
          disabled={!formCommandNameForNew.trim() || !formCommandStringForNew.trim()}
        >
          Add Player
        </button>
        <!-- {#if editCommandId} Remove the "New Player" button, direct manipulation is preferred
          <button class="secondary" onclick={clearForm}>New Player</button>
        {/if} -->
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
    cursor: grab;
  }
  .command-item.dragging-over {
    border-color: var(--ev-c-gray-1);
  }
  .command-item.editing {
    background-color: var(--ev-c-gray-3); /* Highlight item being edited */
    border-color: var(--ev-c-gray-1);
    cursor: default; /* No longer grab when editing */
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
    font-size: 1.5rem;
    padding: 0 0.5rem;
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