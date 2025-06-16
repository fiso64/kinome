<script lang="ts">
  import ModalWindow from './ModalWindow.svelte'

  // A virtual folder will have these extra properties when created in MediaGrid.svelte
  type VirtualFolderProps = {
    isVirtual?: boolean
    physicalParentId?: string
    groupByKey?: string
    groupByValue?: string
  }

  let {
    item,
    groupByKeys,
    onClose
  }: {
    item: MediaFolder & VirtualFolderProps
    groupByKeys: string[]
    onClose: () => void
  } = $props()

  // --- Svelte 5 runes: local state for the form ---
  let selectedLayout = $state(item.layout ?? 'grid')
  let selectedClickAction = $state(item.childrenClickAction ?? 'detail')
  let selectedGroupBy = $state(item.groupBy ?? 'folder')

  const layouts = [
    { value: 'grid', label: 'Grid', description: 'Classic poster grid view.' },
    { value: 'tree', label: 'Tree', description: 'Collapsible list view, good for files.' },
    { value: 'tabs', label: 'Tabs', description: 'Group children into tabs by metadata.' },
    {
      value: 'sections',
      label: 'Sections',
      description: 'Group children into sections by metadata.'
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

  function formatKey(key: string): string {
    if (key === 'folder') return 'Folder'
    let displayKey = key
    if (key.startsWith('tags.')) {
      displayKey = key.substring(5)
    } else if (key.startsWith('vt.')) {
      displayKey = key.substring(3)
    }
    return displayKey.charAt(0).toUpperCase() + displayKey.slice(1)
  }

  async function handleSave() {
    if (item.isVirtual && item.physicalParentId) {
      // --- Editing a Virtual Folder ---
      // Get the physical parent, which is where the configuration is stored.
      const physicalParent = await window.api.getItemById(item.physicalParentId)
      if (!physicalParent || physicalParent.type !== 'folder') return

      // Create a clonable copy to modify.
      const updatedParent: MediaFolder = JSON.parse(JSON.stringify(physicalParent))

      // Ensure the nested structure for virtual settings exists.
      if (!updatedParent.virtualFolderSettings) updatedParent.virtualFolderSettings = {}
      if (!updatedParent.virtualFolderSettings[item.groupByKey!]) {
        updatedParent.virtualFolderSettings[item.groupByKey!] = {}
      }
      const settings =
        updatedParent.virtualFolderSettings[item.groupByKey!][item.groupByValue!] ?? {}

      // Apply the new settings for this specific virtual group.
      settings.layout = selectedLayout
      settings.groupBy = selectedGroupBy === 'folder' ? undefined : selectedGroupBy
      settings.childrenClickAction = selectedClickAction
      updatedParent.virtualFolderSettings[item.groupByKey!][item.groupByValue!] = settings

      // Save the modified physical parent.
      await window.api.updateItem(updatedParent)
    } else {
      // --- Editing a Physical Folder ---
      const updatedItem: MediaFolder = JSON.parse(JSON.stringify(item))
      updatedItem.layout = selectedLayout
      updatedItem.groupBy = selectedGroupBy === 'folder' ? undefined : selectedGroupBy
      updatedItem.childrenClickAction = selectedClickAction
      await window.api.updateItem(updatedItem)
    }
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

<ModalWindow title="Set View Layout" {onClose} onSave={handleSave}>
  <div class="content">
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

    {#if selectedLayout === 'tabs' || selectedLayout === 'sections'}
      <div class="divider"></div>
      <h3>Group By</h3>
      <p class="help-text">
        Choose a metadata field to group the contents of this folder into {selectedLayout}.
      </p>
      <div class="form-group">
        <select bind:value={selectedGroupBy}>
          {#each groupByKeys as key (key)}
            <option value={key}>{formatKey(key)}</option>
          {/each}
        </select>
      </div>
    {/if}

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
  </div>
</ModalWindow>

<style>
  .content {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .help-text {
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
    /* The negative margin was pulling the text up. Spacing is now handled by the container's gap. */
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
  .divider {
    border-bottom: 1px solid var(--color-background-mute);
    margin: 0.5rem 0;
  }
  h3 {
    font-weight: bold;
  }
</style>
