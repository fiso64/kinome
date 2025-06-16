<script lang="ts">
  let {
    item,
    currentLayout,
    onClose
  }: {
    item: MediaFolder
    currentLayout: 'grid' | 'tree' | 'tabs' | 'sections'
    onClose: () => void
  } = $props()

  // Svelte 5 runes: local state for the form
  let selectedLayout = $state(currentLayout)
  let selectedClickAction = $state(item.childrenClickAction ?? 'detail')

  const layouts = [
    { value: 'grid', label: 'Grid', description: 'Classic poster grid view.' },
    { value: 'tree', label: 'Tree', description: 'Collapsible list view, good for files.' },
    {
      value: 'tabs',
      label: 'Tabs',
      description: 'Show each subfolder as a tab, good for seasons.'
    },
    {
      value: 'sections',
      label: 'Sections',
      description: 'Show each subfolder as a section on one page.'
    }
  ]

  const clickActions = [
    {
      value: 'detail',
      label: 'Open Detail Page',
      description: 'Clicking an item opens its own detailed view.'
    },
    {
      value: 'navigate',
      label: 'Navigate Into Folder',
      description: 'Clicking a folder navigates to a new list of its contents.'
    }
  ]

  async function handleSave() {
    // Create a deep, plain JavaScript object copy to ensure it's clonable for IPC.
    const updatedItem: MediaFolder = JSON.parse(JSON.stringify(item))
    // Apply the changes
    updatedItem.layout = selectedLayout
    updatedItem.childrenClickAction = selectedClickAction

    await window.api.updateItem(updatedItem)
    onClose()
  }

  $effect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      } else if (event.key === 'Enter') {
        const target = event.target as HTMLElement
        if (target.tagName !== 'BUTTON') {
          event.preventDefault()
          handleSave()
        }
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div
  class="modal-backdrop"
  onclick={(e) => e.target === e.currentTarget && onClose()}
  role="dialog"
  aria-modal="true"
  tabindex="-1"
>
  <div class="modal-content">
    <h2>Set View Layout</h2>
    <p class="help-text">Choose how the contents of "{item.title ?? item.name}" are displayed.</p>

    <div class="layout-options">
      {#each layouts as layout}
        <label class="layout-option">
          <input type="radio" name="layout" bind:group={selectedLayout} value={layout.value} />
          <div class="option-details">
            <div class="option-label">{layout.label}</div>
            <div class="option-description">{layout.description}</div>
          </div>
        </label>
      {/each}
    </div>

    <div class="divider"></div>
    <h3>On Click...</h3>
    <p class="help-text">
      Choose what happens when clicking a child item. This does not apply to Tree view.
    </p>
    <div class="layout-options">
      {#each clickActions as action}
        <label class="layout-option">
          <input
            type="radio"
            name="click-action"
            bind:group={selectedClickAction}
            value={action.value}
          />
          <div class="option-details">
            <div class="option-label">{action.label}</div>
            <div class="option-description">{action.description}</div>
          </div>
        </label>
      {/each}
    </div>

    <div class="actions">
      <button class="secondary" onclick={onClose}>Cancel</button>
      <button class="primary" onclick={handleSave}>Save & Close</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 200;
  }
  .modal-content {
    background-color: var(--color-background-soft);
    padding: 2rem;
    border-radius: 8px;
    width: 90%;
    max-width: 500px;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .help-text {
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
    margin-top: -1rem;
  }

  .layout-options {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .layout-option {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 1rem;
    border: 1px solid var(--color-background-mute);
    border-radius: 6px;
    cursor: pointer;
    transition:
      border-color 0.2s,
      background-color 0.2s;
  }
  .layout-option:hover {
    background-color: var(--color-background);
  }

  .layout-option input[type='radio'] {
    margin-top: 0.2rem;
    width: 1rem;
    height: 1rem;
  }

  .option-label {
    font-weight: bold;
  }

  .option-description {
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    flex-shrink: 0;
    padding-top: 1rem;
    border-top: 1px solid var(--color-background-mute);
    margin-top: auto;
  }
  button {
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 5px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--ev-c-text-1);
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  button.primary {
    background-color: var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
  }
  button.primary:hover:not(:disabled) {
    background-color: var(--ev-c-gray-1);
  }
  button.secondary {
    background-color: var(--ev-button-alt-bg);
    border: 1px solid var(--ev-c-gray-2);
  }
  button.secondary:hover:not(:disabled) {
    background-color: var(--ev-c-black-mute);
  }
  .divider {
    border-bottom: 1px solid var(--color-background-mute);
    margin: 0.5rem 0;
  }
  h3 {
    font-weight: bold;
    margin-top: -0.5rem;
  }
</style>
