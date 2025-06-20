<script lang="ts">
  const layouts = [
    { value: 'grid', label: 'Grid', description: 'Classic poster grid view.' },
    { value: 'list', label: 'List', description: 'A detailed list with posters and info.' },
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

  let {
    availableLayouts = ['grid', 'list', 'tree', 'tabs', 'sections'],
    showClickAction = true,
    groupByKeys,
    selectedLayout = $bindable(),
    selectedClickAction = $bindable(),
    selectedGroupBy = $bindable()
  }: {
    availableLayouts?: ('grid' | 'list' | 'tree' | 'tabs' | 'sections')[]
    showClickAction?: boolean
    groupByKeys: string[]
    selectedLayout: 'grid' | 'list' | 'tree' | 'tabs' | 'sections'
    selectedClickAction: 'detail' | 'navigate'
    selectedGroupBy: string
  } = $props()

  const filteredLayouts = $derived(layouts.filter((l) => availableLayouts.includes(l.value)))

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
</script>

<div class="content">
  <div class="layout-options">
    {#each filteredLayouts as layout}
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

  {#if showClickAction}
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
  {/if}
</div>

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