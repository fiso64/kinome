<script lang="ts">
  import { resolveViewSettings, formatLayoutString } from '@shared/settings-helpers'
  import {
    LAYOUT_SPECIFIC_SETTINGS_CONFIG,
    ALL_VIEW_OVERRIDE_KEYS,
    DEFAULT_LAYOUTS_CONFIG,
    ALL_VIEW_LAYOUTS,
    type MediaFolder,
    type StoredViewSettings,
    type Settings,
    type ViewLayout
  } from '@shared/types'
  import type { DefaultLayoutKey, ResolutionSource, ResolutionInfo } from '@shared/types'
  import { modalStore } from '@lib/modal-store.svelte'

  const layouts: {
    value: ViewLayout
    label: string
    description: string
  }[] = [
    // TODO: Merge horizontal-grid into grid as configuration options.
    { value: 'grid', label: 'Grid', description: 'Classic poster grid view.' },
    {
      value: 'horizontal-grid',
      label: 'Horizontal Grid',
      description: 'A horizontally scrolling poster grid.'
    },
    { value: 'list', label: 'List', description: 'A detailed list with posters and info.' },
    { value: 'tree', label: 'Tree', description: 'Collapsible list view, good for files.' },
    { value: 'tabs', label: 'Tabs', description: 'Group children into tabs by metadata.' },
    {
        value: 'sections',
        label: 'Sections',
        description: 'Group children into sections by metadata.'
    },
    {
      value: 'button-grid',
      label: 'Buttons',
      description: 'A grid of wide buttons, ideal for categories or genres.'
    },
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
    // Context props
    item,
    typeKey,
    settings,
    // Config props
    availableLayouts = [...ALL_VIEW_LAYOUTS],
    showClickAction = true,
    groupByKeys,
    configMode = false,
    // Bindings
    activeConfigLayout = $bindable('grid'),
    selectedLayout = $bindable(),
    selectedClickAction = $bindable(),
    selectedGroupBy = $bindable(),
    gridPosterSize = $bindable(),
    listDescriptionRows = $bindable(),
    showHorizontalScrollbar = $bindable(),
    scrollHorizontally = $bindable(),
    childViewSettings = $bindable(),
    inheritedSettings,
    inheritedLabel
  }: {
    // Context props
    item?: MediaFolder
    typeKey?: DefaultLayoutKey
    settings: Settings | null
    // Config props
    availableLayouts?: ViewLayout[]
    showClickAction?: boolean
    groupByKeys?: string[]
    configMode?: boolean
    // Bindings
    activeConfigLayout?: ViewLayout
    selectedLayout?: ViewLayout | null
    selectedClickAction?: 'detail' | 'navigate'
    selectedGroupBy?: string | null
    gridPosterSize?: number | null
    listDescriptionRows?: number | null
    showHorizontalScrollbar?: boolean | null
    scrollHorizontally?: boolean | null
    childViewSettings?: StoredViewSettings | null
    inheritedSettings?: StoredViewSettings
    inheritedLabel?: string
  } = $props()

  let localSortTop = $state<string[] | null>(null)
  let localSortBottom = $state<string[] | null>(null)

  const filteredLayouts = $derived(layouts.filter((l) => availableLayouts.includes(l.value)))

  // This computes the "inherited" settings for the item/type, ignoring any local overrides.
  const inheritedInfo = $derived.by(() => {
    let baseItemForResolving: any
    const layersToIgnore = new Set<DefaultLayoutKey>()

    if (item) {
      baseItemForResolving = { ...item }
      for (const key of ALL_VIEW_OVERRIDE_KEYS) {
        delete (baseItemForResolving as any)[key]
      }
    } else if (typeKey) {
      baseItemForResolving = {}
      layersToIgnore.add(typeKey)
    } else {
      baseItemForResolving = {}
    }

    const dummyItemForResolution = {
      ...baseItemForResolving,
      name: '__DUMMY_FOR_RESOLUTION__',
      type: 'folder', // Assume folder for view settings
      mediaType: item?.mediaType ?? typeKey // Use the current selected layout to resolve its specific settings correctly
      // Note: We do NOT inject viewSettings here anymore, because item settings (Layer 3)
      // are lower priority than inherited settings (Layer 2). To force our draft selection
      // to win, we must inject it as an Override (Layer 1).
    }

    // Construct a simulated inherited settings object that includes our draft selection
    // as a high-priority override.
    const effectiveInheritedSettings: StoredViewSettings = {
      ...(inheritedSettings ?? {}),
      overrides: {
        ...(inheritedSettings?.overrides ?? {}),
        [baseItemForResolving.id ?? 'config-dummy-id']: selectedLayout
          ? { layout: selectedLayout }
          : {}
      }
    }

    // We use a dummy ID ensures we match the override key we just created
    dummyItemForResolution.id = baseItemForResolving.id ?? 'config-dummy-id'

    return resolveViewSettings(
      dummyItemForResolution,
      settings,
      layersToIgnore,
      effectiveInheritedSettings,
      null // We do NOT ignore any ID because we explicitly want our injected override to apply
    )
  })

  const effectiveLayout = $derived(selectedLayout ?? inheritedInfo.settings.layout) // This is now the currently selected layout, whether in config mode or item mode.

  const layoutToShowOptionsFor = $derived(configMode ? activeConfigLayout : effectiveLayout) // --- Grid Poster Size ---

  const defaultGridSize = $derived(
    inheritedInfo.settings.gridPosterSize ?? LAYOUT_SPECIFIC_SETTINGS_CONFIG.grid.gridPosterSize
  )
  const effectiveGridSize = $derived(gridPosterSize ?? defaultGridSize)
  const isGridSizeOverridden = $derived(gridPosterSize != null) // --- List Description Rows ---

  const defaultDescriptionRows = $derived(
    inheritedInfo.settings.listDescriptionRows ??
      LAYOUT_SPECIFIC_SETTINGS_CONFIG.list.listDescriptionRows
  )
  const effectiveDescriptionRows = $derived(listDescriptionRows ?? defaultDescriptionRows)
  const isDescriptionRowsOverridden = $derived(listDescriptionRows != null) // --- Horizontal Scrollbar ---

  const defaultShowScrollbar = $derived(
    (inheritedInfo.settings as any).showHorizontalScrollbar ??
      LAYOUT_SPECIFIC_SETTINGS_CONFIG['horizontal-grid'].showHorizontalScrollbar
  )
  const effectiveShowScrollbar = $derived(showHorizontalScrollbar ?? defaultShowScrollbar)
  const isShowScrollbarOverridden = $derived(showHorizontalScrollbar != null) // --- Scroll Horizontally ---

  const defaultScrollHorizontally = $derived(
    (inheritedInfo.settings as any).scrollHorizontally ?? false
  )
  const effectiveScrollHorizontally = $derived(scrollHorizontally ?? defaultScrollHorizontally)
  const isScrollHorizontallyOverridden = $derived(scrollHorizontally != null) // --- Group By ---

  const defaultGroupBy = $derived(
    inheritedInfo.settings.groupBy ?? LAYOUT_SPECIFIC_SETTINGS_CONFIG.tabs.groupBy
  )
  const effectiveGroupBy = $derived(selectedGroupBy ?? defaultGroupBy)
  const isGroupByOverridden = $derived(selectedGroupBy != null) // --- Click Action ---

  const defaultClickAction = $derived(inheritedInfo.settings.clickAction ?? 'detail')
  const effectiveClickAction = $derived(selectedClickAction ?? defaultClickAction)
  const isClickActionOverridden = $derived(selectedClickAction != null)

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

  function formatSource(sourceInfo: ResolutionSource | undefined): string {
    if (!sourceInfo) return ''
    switch (sourceInfo.source) {
      case 'item':
        return 'Item' // Should not happen for defaults, but for safety
      case 'global':
        return 'Global Default'
      case 'type':
        if (sourceInfo.sourceKey && DEFAULT_LAYOUTS_CONFIG[sourceInfo.sourceKey]) {
          const label = DEFAULT_LAYOUTS_CONFIG[sourceInfo.sourceKey].label.replace(' View', '')
          return `${label}`
        }
        return 'Type Default'
      case 'inherited':
        return inheritedLabel ?? 'Parent'
      case 'override':
        return 'Override'
      default:
        // Use default fallback instead of returning empty string immediately
        break
    }
    // Debug: If we get here, log the unknown source
    if (sourceInfo.source) {
      const src = sourceInfo.source as string
      console.warn(`[ViewConfigurator] Unknown resolution source: ${src}`, sourceInfo)
      return src?.charAt(0).toUpperCase() + src?.slice(1)
    }
    return 'Default'
  }

  function openChildSettings() {
    modalStore.open('viewSettings', {
      title: 'Configure Child Layout',
      initialSettings: childViewSettings ?? {},
      typeKey: '_default',
      settings,
      onSave: (newSettings) => {
        const merged = { ...(childViewSettings ?? {}), ...newSettings }
        Object.keys(merged).forEach((key) => {
          if (merged[key as keyof StoredViewSettings] === null) {
            delete merged[key as keyof StoredViewSettings]
          }
        })
        childViewSettings = merged
      },
      groupByKeys,
      availableLayouts: [...ALL_VIEW_LAYOUTS],
      showClickAction: false
    })
  }
</script>

<div class="content">
  {#if !configMode}
    <div class="heading-with-action">
      <h3>View As</h3>
      {#if selectedLayout !== null}
        <button class="link-button" onclick={() => (selectedLayout = null)}>Reset to default</button
        >
      {/if}
    </div>
    <div class="layout-options horizontal">
      {#each filteredLayouts as layout}
        <label class="layout-option horizontal-item">
          <input
            type="radio"
            name="layout"
            value={layout.value}
            checked={effectiveLayout === layout.value}
            onchange={() => (selectedLayout = layout.value as any)}
          />
          <span>{layout.label}</span>
        </label>
      {/each}
    </div>
    <p class="help-text">{layouts.find((l) => l.value === effectiveLayout)?.description}</p>
  {:else}
    <h3>Configure Defaults For</h3>
    <div class="layout-options horizontal">
      {#each layouts as layout}
        {#if Object.keys(LAYOUT_SPECIFIC_SETTINGS_CONFIG).includes(layout.value)}
          <label class="layout-option horizontal-item">
            <input
              type="radio"
              name="config-layout"
              value={layout.value}
              onchange={() => (activeConfigLayout = layout.value as any)}
              checked={activeConfigLayout === layout.value}
            />
            <span>{layout.label}</span>
          </label>
        {/if}
      {/each}
    </div>
    <p class="help-text">Set default values for when this layout is used.</p>
  {/if}

  <!-- Grid-specific settings -->
  {#if layoutToShowOptionsFor === 'grid' || layoutToShowOptionsFor === 'horizontal-grid' || layoutToShowOptionsFor === 'button-grid'}
    <div class="divider"></div>
    <div class="heading-with-action">
      <h4>Grid Poster Size</h4>
      {#if !configMode}
        {#if isGridSizeOverridden}
          <button class="link-button" onclick={() => (gridPosterSize = null)}
            >Reset to default</button
          >
        {:else}
          <span class="inherited-value-text-inline">
            Using default from <strong>{formatSource(inheritedInfo.sources.gridPosterSize)}</strong>
          </span>
        {/if}
      {/if}
    </div>
    <p class="help-text">
      Controls the {configMode ? 'default ' : ''}base width of posters in the grid view.
    </p>
    <div class="form-group">
      <div class="slider-container">
        <input
          type="range"
          value={effectiveGridSize}
          oninput={(e) => (gridPosterSize = parseInt((e.target as HTMLInputElement).value, 10))}
          min="50"
          max="500"
          step="10"
        />
        <span>{effectiveGridSize}px</span>
      </div>
    </div>
  {/if}

  <!-- Button-Grid-specific settings -->
  {#if layoutToShowOptionsFor === 'button-grid'}
    <div class="divider"></div>
    <div class="heading-with-action">
      <h4>Horizontal Scrolling</h4>
      {#if !configMode}
        {#if isScrollHorizontallyOverridden}
          <button class="link-button" onclick={() => (scrollHorizontally = null)}>Reset to default</button>
        {:else}
          <span class="inherited-value-text-inline">
            Using default from <strong>{formatSource((inheritedInfo.sources as any).scrollHorizontally)}</strong>
          </span>
        {/if}
      {/if}
    </div>
    <p class="help-text">Display items in a horizontally scrolling list instead of a wrapped grid.</p>
    <div class="form-group">
      <label class="checkbox-label">
        <input
          type="checkbox"
          checked={effectiveScrollHorizontally}
          onchange={() => (scrollHorizontally = !effectiveScrollHorizontally)}
        />
        <span>Scroll horizontally</span>
      </label>
    </div>
  {/if}

  <!-- Horizontal-Grid/Button-Grid specific settings -->
  {#if layoutToShowOptionsFor === 'horizontal-grid' || (layoutToShowOptionsFor === 'button-grid' && effectiveScrollHorizontally)}
    <div class="divider"></div>
    <div class="heading-with-action">
      <h4>Horizontal Scrollbar</h4>
      {#if !configMode}
        {#if isShowScrollbarOverridden}
          <button class="link-button" onclick={() => (showHorizontalScrollbar = null)}
            >Reset to default</button
          >
        {:else}
          <span class="inherited-value-text-inline">
            Using default from <strong
              >{formatSource(inheritedInfo.sources.showHorizontalScrollbar)}</strong
            >
          </span>
        {/if}
      {/if}
    </div>
    <p class="help-text">Show a scrollbar when the content overflows horizontally.</p>
    <div class="form-group">
      <label class="checkbox-label">
        <input
          type="checkbox"
          checked={effectiveShowScrollbar}
          onchange={() => (showHorizontalScrollbar = !effectiveShowScrollbar)}
        />
        <span>Show horizontal scrollbar</span>
      </label>
    </div>
  {/if}

  <!-- Group By -->
  <div class="divider"></div>
  <div class="heading-with-action">
    <h4>Group By</h4>
    {#if !configMode}
      {#if isGroupByOverridden}
        <button class="link-button" onclick={() => (selectedGroupBy = null)}
          >Reset to default</button
        >
      {:else}
        <span class="inherited-value-text-inline">
          Using default from <strong>{formatSource(inheritedInfo.sources.groupBy)}</strong>
        </span>
      {/if}
    {/if}
  </div>
  <p class="help-text">
    Choose the {configMode ? 'default ' : ''}metadata field to group contents by. Items will be organized into virtual subfolders.
  </p>
  <div class="form-group">
    <select value={effectiveGroupBy} onchange={(e) => (selectedGroupBy = e.currentTarget.value)}>
      {#if groupByKeys}
        {#each groupByKeys as key (key)}
          <option value={key}>{formatKey(key)}</option>
        {/each}
      {/if}
    </select>
  </div>

  {#if !configMode}
    <div class="divider"></div>
    <div class="heading-with-action">
      <h4>Child Item Layout</h4>
      {#if childViewSettings}
        <button class="link-button" onclick={() => (childViewSettings = null)}>Reset</button>
      {/if}
    </div>
    <p class="help-text">
      Optionally override the layout used for items inside each group. If not set, each
      item will use its own default view.
    </p>
    <div class="view-config-row" onclick={openChildSettings}>
      <span>{formatLayoutString(childViewSettings)}</span>
      <button class="secondary" tabindex="-1">Configure...</button>
    </div>
  {/if}
  <!-- List-specific settings -->
  {#if layoutToShowOptionsFor === 'list'}
    <div class="divider"></div>
    <div class="heading-with-action">
      <h4>Description Rows</h4>
      {#if !configMode}
        {#if isDescriptionRowsOverridden}
          <button class="link-button" onclick={() => (listDescriptionRows = null)}
            >Reset to default</button
          >
        {:else}
          <span class="inherited-value-text-inline">
            Using default from <strong
              >{formatSource(inheritedInfo.sources.listDescriptionRows)}</strong
            >
          </span>
        {/if}
      {/if}
    </div>
    <p class="help-text">
      Controls the {configMode ? 'default ' : ''}number of lines shown for the description in List
      view (0 to hide).
    </p>
    <div class="form-group">
      <div class="slider-container">
        <input
          type="range"
          value={effectiveDescriptionRows}
          oninput={(e) =>
            (listDescriptionRows = parseInt((e.target as HTMLInputElement).value, 10))}
          min="0"
          max="10"
          step="1"
        />
        <span>{effectiveDescriptionRows}</span>
      </div>
    </div>
  {/if}

  {#if !configMode && item}
    {@const pinnedCount = (localSortTop ?? item.viewSettings?.sortTop ?? []).length + (localSortBottom ?? item.viewSettings?.sortBottom ?? []).length}
    <div class="divider"></div>
    <div class="heading-with-action">
      <h4>Sort Order</h4>
    </div>
    <p class="help-text">Pin specific children to always appear first or last.</p>
    <div class="view-config-row" onclick={() => modalStore.open('sortPinning', { item, initialSortTop: localSortTop ?? undefined, initialSortBottom: localSortBottom ?? undefined, onSaved: (top, bottom) => { localSortTop = top; localSortBottom = bottom } })}>
      <span>
        {#if pinnedCount > 0}
          {pinnedCount} item(s) pinned
        {:else}
          No items pinned
        {/if}
      </span>
      <button class="secondary" tabindex="-1">Configure...</button>
    </div>
  {/if}

  <!-- On Click settings hidden for now — feature exists but adds UI clutter
  {#if !configMode && showClickAction}
    <div class="divider"></div>
    <div class="heading-with-action">
      <h3>On Click...</h3>
      {#if isClickActionOverridden}
        <button class="link-button" onclick={() => (selectedClickAction = null)}
          >Reset to default</button
        >
      {/if}
    </div>
    <p class="help-text">
      Choose what happens when clicking a child item. This does not apply to Tree view.
    </p>
    <div class="layout-options vertical">
      {#each clickActions as action}
        <label class="layout-option vertical-item">
          <input
            type="radio"
            name="click-action"
            value={action.value}
            checked={effectiveClickAction === action.value}
            onchange={() => (selectedClickAction = action.value as any)}
          />
          <div class="option-details">
            <div class="option-label">{action.label}</div>
            <div class="option-description">{action.description}</div>
          </div>
        </label>
      {/each}
    </div>
  {/if}
  -->
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

  .inherited-value-text-inline {
    font-size: 0.8rem; /* Match link-button */
    color: var(--ev-c-text-2);
    white-space: nowrap;
  }
  .inherited-value-text-inline strong {
    font-weight: 600;
    background: none;
    border: none;
    color: var(--ev-c-text-2);
    text-decoration: underline;
    font-size: 0.8rem;
    padding: 0;
  }

  .layout-options {
    display: flex;
    gap: 1rem;
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
  .heading-with-action h4 {
    margin: 0;
  }
  h3,
  h4 {
    font-weight: bold;
  }
  h3 {
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
