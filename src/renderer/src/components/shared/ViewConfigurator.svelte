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
    selectedGroupBy = $bindable(),
    gridPosterSize = $bindable(),
    settings,
    configMode = false,
    initialConfigLayout = 'grid'
  }: {
    availableLayouts?: ('grid' | 'list' | 'tree' | 'tabs' | 'sections')[]
    showClickAction?: boolean
    groupByKeys?: string[]
    selectedLayout?: 'grid' | 'list' | 'tree' | 'tabs' | 'sections'
    selectedClickAction?: 'detail' | 'navigate'
    selectedGroupBy?: string
    gridPosterSize?: number | null
    settings: any | null // Can be partial settings object
    configMode?: boolean
    initialConfigLayout?: 'grid' | 'list' | 'tree' | 'tabs' | 'sections'
  } = $props()

  const filteredLayouts = $derived(layouts.filter((l) => availableLayouts.includes(l.value)))

  // --- State for different modes ---
  let activeConfigLayout = $state(initialConfigLayout)
  const layoutToShowOptionsFor = $derived(configMode ? activeConfigLayout : selectedLayout)

  // --- Grid Poster Size ---
  const globalDefaultSize = $derived(settings?.gridPosterSize ?? 200)

  // This is a derived value representing the current effective size for the slider.
  // It will automatically update if the parent prop or global default changes.
  const localSize = $derived(gridPosterSize ?? globalDefaultSize)

  // This is also derived directly from the prop.
  const isOverridden = $derived(gridPosterSize != null)

  // When the user moves the slider, it sets the override by updating the bound prop.
  function handleSliderInput(e: Event) {
    const value = parseInt((e.target as HTMLInputElement).value, 10)
    gridPosterSize = value
  }

  // The reset button removes the override by setting the bound prop to null.
  function handleReset() {
    gridPosterSize = null
  }

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
  {#if !configMode}
    <h3>View As</h3>
    <div class="layout-options horizontal">
      {#each filteredLayouts as layout}
        <label class="layout-option horizontal-item">
          <input type="radio" name="layout" bind:group={selectedLayout} value={layout.value} />
          <span>{layout.label}</span>
        </label>
      {/each}
    </div>
    <p class="help-text">{layouts.find((l) => l.value === selectedLayout)?.description}</p>
  {:else}
    <h3>Configure Defaults For</h3>
    <div class="layout-options horizontal">
      {#each filteredLayouts as layout}
        <label class="layout-option horizontal-item">
          <input
            type="radio"
            name="config-layout"
            value={layout.value}
            onchange={() => (activeConfigLayout = layout.value)}
            checked={activeConfigLayout === layout.value}
          />
          <span>{layout.label}</span>
        </label>
      {/each}
    </div>
    <p class="help-text">Set default values for when this layout is used.</p>
  {/if}

  {#if layoutToShowOptionsFor === 'grid'}
    <div class="divider"></div>
    <div class="heading-with-action">
      <h3>Grid Poster Size</h3>
      {#if isOverridden}
        <button class="link-button" onclick={handleReset}>Reset to default</button>
      {/if}
    </div>
    <p class="help-text">
      Controls the base width of posters in this grid view. The current default is
      {globalDefaultSize}px.
    </p>
    <div class="form-group">
      <div class="slider-container">
        <input
          type="range"
          value={localSize}
          oninput={handleSliderInput}
          min="50"
          max="500"
          step="10"
        />
        <span>{localSize}px</span>
      </div>
    </div>
  {/if}

  {#if !configMode && (layoutToShowOptionsFor === 'tabs' || layoutToShowOptionsFor === 'sections')}
    <div class="divider"></div>
    <h3>Group By</h3>
    <p class="help-text">
      Choose a metadata field to group the contents of this folder into {layoutToShowOptionsFor}.
    </p>
    <div class="form-group">
      <select bind:value={selectedGroupBy}>
        {#if groupByKeys}
          {#each groupByKeys as key (key)}
            <option value={key}>{formatKey(key)}</option>
          {/each}
        {/if}
      </select>
    </div>
  {/if}

  {#if !configMode && showClickAction}
    <div class="divider"></div>
    <h3>On Click...</h3>
    <p class="help-text">
      Choose what happens when clicking a child item. This does not apply to Tree view.
    </p>
    <div class="layout-options vertical">
      {#each clickActions as action}
        <label class="layout-option vertical-item">
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
    margin-top: -0.75rem; /* Reduce space after a heading */
  }

  .layout-options {
    display: flex;
    gap: 1rem;
  }
  .layout-options.vertical {
    flex-direction: column;
  }
  .layout-options.horizontal {
    flex-direction: row;
    overflow-x: auto;
    gap: 0.5rem;
    background: var(--color-background);
    border-radius: 6px;
    padding: 0.5rem;
    border: 1px solid var(--color-background-mute);
    padding-bottom: 0.5rem;
    -ms-overflow-style: none; /* IE and Edge */
    scrollbar-width: none; /* Firefox */
  }
  .layout-options.horizontal::-webkit-scrollbar {
    display: none;
  }

  .layout-option {
    cursor: pointer;
    transition:
      border-color 0.2s,
      background-color 0.2s;
  }

  /* Vertical Layout Items (for Click Action) */
  .vertical-item {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 1rem;
    border: 1px solid var(--color-background-mute);
    border-radius: 6px;
  }
  .vertical-item:hover {
    background-color: var(--color-background);
  }
  .vertical-item input[type='radio'] {
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

  /* Horizontal Layout Items (for View As) */
  .horizontal-item {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    white-space: nowrap;
  }
  .horizontal-item:hover {
    background-color: var(--color-background-soft);
  }
  .horizontal-item input[type='radio'] {
    position: absolute;
    opacity: 0;
  }
  .horizontal-item span {
    font-weight: 600;
  }
  .horizontal-item:has(input:checked) {
    background-color: var(--ev-c-gray-2);
  }
  .horizontal-item:has(input:checked) span {
    color: var(--ev-c-text-1);
  }

  .divider {
    border-bottom: 1px solid var(--color-background-mute);
    margin-top: -0.5rem;
  }
  .heading-with-action {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .heading-with-action h3 {
    margin: 0;
  }
  h3 {
    font-weight: bold;
    margin-bottom: -0.75rem;
  }

  /* Slider specific styles */
  .slider-container {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .slider-container input[type='range'] {
    flex-grow: 1;
  }
  .link-button {
    background: none;
    border: none;
    color: var(--ev-c-text-2);
    text-decoration: underline;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0;
  }
  .link-button:hover {
    color: var(--ev-c-text-1);
  }
</style>