<script lang="ts">
  import { resolveViewSettings, formatLayoutString } from '@shared/settings-helpers'
  import {
    LAYOUT_SPECIFIC_SETTINGS_CONFIG,
    ALL_VIEW_OVERRIDE_KEYS,
    DEFAULT_LAYOUTS_CONFIG,
    ALL_VIEW_LAYOUTS,
    type MediaFolder,
    type CascadableViewSettings,
    type StoredViewSettings,
    type Settings,
    type ViewLayout,
    type SortBy,
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
    selectedSortBy = $bindable(),
    selectedSortDescending = $bindable(),
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
    selectedSortBy?: SortBy | null
    selectedSortDescending?: boolean | null
    gridPosterSize?: number | null
    listDescriptionRows?: number | null
    showHorizontalScrollbar?: boolean | null
    scrollHorizontally?: boolean | null
    childViewSettings?: CascadableViewSettings | null
    inheritedSettings?: CascadableViewSettings
    inheritedLabel?: string
  } = $props()

  let localSortTop = $state<string[] | null>(null)
  let localSortBottom = $state<string[] | null>(null)
  let showLayoutOptions = $state(false)

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
      type: 'folder',
      mediaType: item?.mediaType ?? typeKey
    }

    const effectiveInheritedSettings: StoredViewSettings = {
      ...(inheritedSettings ?? {}),
      overrides: {
        ...(inheritedSettings?.overrides ?? {}),
        [baseItemForResolving.id ?? 'config-dummy-id']: selectedLayout
          ? { layout: selectedLayout }
          : {}
      }
    }

    dummyItemForResolution.id = baseItemForResolving.id ?? 'config-dummy-id'

    return resolveViewSettings(
      dummyItemForResolution,
      settings,
      layersToIgnore,
      effectiveInheritedSettings,
      null
    )
  })

  const effectiveLayout = $derived(selectedLayout ?? inheritedInfo.settings.layout)
  const layoutToShowOptionsFor = $derived(configMode ? activeConfigLayout : effectiveLayout)

  const defaultGridSize = $derived(
    inheritedInfo.settings.gridPosterSize ?? LAYOUT_SPECIFIC_SETTINGS_CONFIG.grid.gridPosterSize
  )
  const effectiveGridSize = $derived(gridPosterSize ?? defaultGridSize)
  const isGridSizeOverridden = $derived(gridPosterSize != null)

  const defaultDescriptionRows = $derived(
    inheritedInfo.settings.listDescriptionRows ??
      LAYOUT_SPECIFIC_SETTINGS_CONFIG.list.listDescriptionRows
  )
  const effectiveDescriptionRows = $derived(listDescriptionRows ?? defaultDescriptionRows)
  const isDescriptionRowsOverridden = $derived(listDescriptionRows != null)

  const defaultShowScrollbar = $derived(
    (inheritedInfo.settings as any).showHorizontalScrollbar ??
      LAYOUT_SPECIFIC_SETTINGS_CONFIG['horizontal-grid'].showHorizontalScrollbar
  )
  const effectiveShowScrollbar = $derived(showHorizontalScrollbar ?? defaultShowScrollbar)
  const isShowScrollbarOverridden = $derived(showHorizontalScrollbar != null)

  const defaultScrollHorizontally = $derived(
    (inheritedInfo.settings as any).scrollHorizontally ?? false
  )
  const effectiveScrollHorizontally = $derived(scrollHorizontally ?? defaultScrollHorizontally)
  const isScrollHorizontallyOverridden = $derived(scrollHorizontally != null)

  const effectiveGroupBy = $derived(selectedGroupBy ?? 'folder')

  const defaultSortBy = $derived<SortBy>(inheritedInfo.settings.sortBy ?? 'hybrid')
  const effectiveSortBy = $derived<SortBy>(selectedSortBy ?? defaultSortBy)
  const defaultSortDescending = $derived(inheritedInfo.settings.sortDescending ?? false)
  const effectiveSortDescending = $derived(selectedSortDescending ?? defaultSortDescending)
  const isSortOverridden = $derived(selectedSortBy != null || selectedSortDescending != null)

  const defaultClickAction = $derived(inheritedInfo.settings.clickAction ?? 'detail')
  const effectiveClickAction = $derived(selectedClickAction ?? defaultClickAction)
  const isClickActionOverridden = $derived(selectedClickAction != null)

  const hasLayoutOptions = $derived(
    layoutToShowOptionsFor === 'grid' ||
    layoutToShowOptionsFor === 'horizontal-grid' ||
    layoutToShowOptionsFor === 'button-grid' ||
    layoutToShowOptionsFor === 'list'
  )

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
        return 'Item'
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
        break
    }
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
  <!-- View As / Configure Defaults For -->
  {#if !configMode}
    <div class="heading-with-action">
      <h3>View As</h3>
      <div class="heading-actions">
        {#if selectedLayout !== null}
          <button class="link-button" onclick={() => (selectedLayout = null)}>Reset to default</button>
        {/if}
        {#if hasLayoutOptions}
          <button class="link-button" onclick={() => (showLayoutOptions = !showLayoutOptions)}>
            Options{showLayoutOptions ? ' ▴' : ' ▾'}
          </button>
        {/if}
      </div>
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
  {/if}

  <!-- Layout-specific options: always shown in configMode, toggled in item mode -->
  {#if (configMode || showLayoutOptions) && hasLayoutOptions}
    <div class="options-panel">
      {#if layoutToShowOptionsFor === 'grid' || layoutToShowOptionsFor === 'horizontal-grid' || layoutToShowOptionsFor === 'button-grid'}
        <div class="heading-with-action">
          <h4>Poster Size</h4>
          {#if !configMode}
            {#if isGridSizeOverridden}
              <button class="link-button" onclick={() => (gridPosterSize = null)}>Reset to default</button>
            {:else}
              <span class="inherited-value-text-inline">
                Using default from <strong>{formatSource(inheritedInfo.sources.gridPosterSize)}</strong>
              </span>
            {/if}
          {/if}
        </div>
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
      {/if}

      {#if layoutToShowOptionsFor === 'button-grid'}
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
        <label class="checkbox-label">
          <input
            type="checkbox"
            checked={effectiveScrollHorizontally}
            onchange={() => (scrollHorizontally = !effectiveScrollHorizontally)}
          />
          <span>Scroll horizontally</span>
        </label>
      {/if}

      {#if layoutToShowOptionsFor === 'horizontal-grid' || (layoutToShowOptionsFor === 'button-grid' && effectiveScrollHorizontally)}
        <div class="heading-with-action">
          <h4>Horizontal Scrollbar</h4>
          {#if !configMode}
            {#if isShowScrollbarOverridden}
              <button class="link-button" onclick={() => (showHorizontalScrollbar = null)}>Reset to default</button>
            {:else}
              <span class="inherited-value-text-inline">
                Using default from <strong>{formatSource(inheritedInfo.sources.showHorizontalScrollbar)}</strong>
              </span>
            {/if}
          {/if}
        </div>
        <label class="checkbox-label">
          <input
            type="checkbox"
            checked={effectiveShowScrollbar}
            onchange={() => (showHorizontalScrollbar = !effectiveShowScrollbar)}
          />
          <span>Show horizontal scrollbar</span>
        </label>
      {/if}

      {#if layoutToShowOptionsFor === 'list'}
        <div class="heading-with-action">
          <h4>Description Rows</h4>
          {#if !configMode}
            {#if isDescriptionRowsOverridden}
              <button class="link-button" onclick={() => (listDescriptionRows = null)}>Reset to default</button>
            {:else}
              <span class="inherited-value-text-inline">
                Using default from <strong>{formatSource(inheritedInfo.sources.listDescriptionRows)}</strong>
              </span>
            {/if}
          {/if}
        </div>
        <div class="slider-container">
          <input
            type="range"
            value={effectiveDescriptionRows}
            oninput={(e) => (listDescriptionRows = parseInt((e.target as HTMLInputElement).value, 10))}
            min="0"
            max="10"
            step="1"
          />
          <span>{effectiveDescriptionRows}</span>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Group By -->
  {#if !configMode}
    <div class="divider"></div>
    <h4>Group By</h4>
    <select value={effectiveGroupBy} onchange={(e) => (selectedGroupBy = e.currentTarget.value)}>
      {#if groupByKeys}
        {#each groupByKeys as key (key)}
          <option value={key}>{formatKey(key)}</option>
        {/each}
      {/if}
    </select>
  {/if}

  <!-- Ordering: Sort By + Sort Order combined -->
  {#if !configMode}
    <div class="divider"></div>
    <div class="heading-with-action">
      <h4>Ordering</h4>
      {#if isSortOverridden}
        <button class="link-button" onclick={() => { selectedSortBy = null; selectedSortDescending = null }}>Reset to default</button>
      {/if}
    </div>
    <div class="sort-controls">
      <select
        value={effectiveSortBy}
        onchange={(e) => (selectedSortBy = e.currentTarget.value as SortBy)}
      >
        <option value="hybrid">Hybrid</option>
        <option value="alpha">Alphabetic</option>
        <option value="date-added">Date Added</option>
        <option value="year">Release Year</option>
        <option value="random">Random</option>
      </select>
      <label class="checkbox-label">
        <input
          type="checkbox"
          checked={effectiveSortDescending}
          onchange={() => (selectedSortDescending = !effectiveSortDescending)}
        />
        <span>Descending</span>
      </label>
      {#if item}
        {@const pinnedCount = (localSortTop ?? item.viewSettings?.sortTop ?? []).length + (localSortBottom ?? item.viewSettings?.sortBottom ?? []).length}
        <button
          class="secondary pin-btn"
          onclick={() => modalStore.open('sortPinning', { item, initialSortTop: localSortTop ?? undefined, initialSortBottom: localSortBottom ?? undefined, onSaved: (top: string[], bottom: string[]) => { localSortTop = top; localSortBottom = bottom } })}
        >
          {#if pinnedCount > 0}Pinned ({pinnedCount})...{:else}Pin items...{/if}
        </button>
      {/if}
    </div>
  {/if}

  <!-- Child Item Layout -->
  {#if !configMode}
    <div class="divider"></div>
    <div class="heading-with-action">
      <h4>Child Item Layout</h4>
      {#if childViewSettings}
        <button class="link-button" onclick={() => (childViewSettings = null)}>Reset</button>
      {/if}
    </div>
    <div class="view-config-row" onclick={openChildSettings}>
      <span>{formatLayoutString(childViewSettings)}</span>
      <button class="secondary" tabindex="-1">Configure...</button>
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

  .inherited-value-text-inline {
    font-size: 0.8rem;
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
    -ms-overflow-style: none;
    scrollbar-width: none;
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

  /* Options panel for layout-specific settings */
  .options-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem 1.25rem;
    background: var(--color-background);
    border-radius: 6px;
    border: 1px solid var(--color-background-mute);
    margin-top: -0.5rem;
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
  .heading-actions {
    display: flex;
    gap: 0.75rem;
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

  .slider-container {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .slider-container input[type='range'] {
    flex-grow: 1;
  }

  .sort-controls {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .sort-controls select {
    flex: 1;
  }
  .pin-btn {
    margin-left: auto;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    white-space: nowrap;
    font-size: 0.9rem;
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

  .view-config-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: var(--color-background);
    border: 1px solid var(--color-background-mute);
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
  }
  .view-config-row:hover {
    background: var(--color-background-soft);
  }
</style>
