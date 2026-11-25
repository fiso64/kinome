<script lang="ts">
  import Icon from '@components/ui/Icon.svelte'
  import type { SortPlacement } from '@shared/sort-placement'
  import { resolveViewSettings, formatLayoutString } from '@shared/settings-helpers'
  import {
    LAYOUT_SPECIFIC_SETTINGS_CONFIG,
    ALL_VIEW_OVERRIDE_KEYS,
    DEFAULT_LAYOUTS_CONFIG,
    ALL_VIEW_LAYOUTS,
    type MediaFolder,
    type CascadableViewSettings,
    type EditableViewSettings,
    type StoredViewSettings,
    type Settings,
    type ViewLayout,
    type SortBy,
    type LayoutOption,
    type LayoutOptions,
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
    editCapability = 'editMetadata',
    settings,
    // Config props
    availableLayouts = [...ALL_VIEW_LAYOUTS],
    showClickAction = true,
    groupByKeys,
    configMode = false,
    // Bindings
    activeConfigLayout = $bindable('grid'),
    viewSettings = $bindable<EditableViewSettings>({}),
    selectedGroupBy = $bindable(),
    inheritedSettings,
    inheritedLabel,
    pins = $bindable()
  }: {
    // Context props
    item?: MediaFolder
    typeKey?: DefaultLayoutKey
    editCapability?: 'editSettings' | 'editMetadata'
    settings: Settings | null
    // Config props
    availableLayouts?: ViewLayout[]
    showClickAction?: boolean
    groupByKeys?: string[]
    configMode?: boolean
    // Bindings
    activeConfigLayout?: keyof Settings['defaultLayoutSettings']
    viewSettings?: EditableViewSettings
    selectedGroupBy?: string | null
    inheritedSettings?: CascadableViewSettings
    inheritedLabel?: string
    pins?: Required<SortPlacement>
  } = $props()

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
        [baseItemForResolving.id ?? 'config-dummy-id']: viewSettings.layout
          ? { layout: viewSettings.layout }
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

  const effectiveLayout = $derived(viewSettings.layout ?? inheritedInfo.settings.layout)
  const layoutToShowOptionsFor = $derived(configMode ? activeConfigLayout : effectiveLayout)

  type OptionControl = { title: string } & (
    { label: string } | { min: number; max: number; step: number; unit?: string }
  )
  const controls: Record<LayoutOption, OptionControl> = {
    gridPosterSize: { title: 'Poster Size', min: 50, max: 500, step: 10, unit: 'px' },
    scrollHorizontally: { title: 'Horizontal Scrolling', label: 'Scroll horizontally' },
    showHorizontalScrollbar: { title: 'Horizontal Scrollbar', label: 'Show horizontal scrollbar' },
    listDescriptionRows: { title: 'Description Rows', min: 0, max: 10, step: 1 }
  }

  function getLayoutOptions(layout: ViewLayout): Partial<LayoutOptions> {
    return layout === 'tree' ? {} : LAYOUT_SPECIFIC_SETTINGS_CONFIG[layout]
  }

  const optionDefaults = $derived(getLayoutOptions(layoutToShowOptionsFor))
  const layoutOptions = $derived((Object.keys(optionDefaults) as LayoutOption[]).filter((key) =>
    key !== 'showHorizontalScrollbar' || layoutToShowOptionsFor !== 'button-grid' ||
    (viewSettings.scrollHorizontally ?? inheritedInfo.settings.scrollHorizontally ?? optionDefaults.scrollHorizontally)
  ))

  function setLayoutOption<K extends LayoutOption>(key: K, value: EditableViewSettings[K]) {
    viewSettings = { ...viewSettings, [key]: value }
  }

  const effectiveGroupBy = $derived(selectedGroupBy ?? 'folder')

  const defaultSortBy = $derived<SortBy>(inheritedInfo.settings.sortBy ?? 'hybrid')
  const effectiveSortBy = $derived<SortBy>(viewSettings.sortBy ?? defaultSortBy)
  const defaultSortDescending = $derived(inheritedInfo.settings.sortDescending ?? false)
  const effectiveSortDescending = $derived(viewSettings.sortDescending ?? defaultSortDescending)
  const isSortOverridden = $derived(viewSettings.sortBy != null || viewSettings.sortDescending != null)

  const defaultClickAction = $derived(inheritedInfo.settings.clickAction ?? 'detail')
  const effectiveClickAction = $derived(viewSettings.clickAction ?? defaultClickAction)
  const isClickActionOverridden = $derived(viewSettings.clickAction != null)

  const hasLayoutOptions = $derived(layoutOptions.length > 0)

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
    // Strip overrides - they are per-item settings managed through the item's own settings modal,
    // not part of the generic child layout. Passing them in would risk clobbering them on save.
    const { overrides: _ignored, ...childWithoutOverrides } = viewSettings.childViewSettings ?? {}
    modalStore.open('viewSettings', {
      title: 'Configure Child Layout',
      initialSettings: childWithoutOverrides,
      typeKey: '_default',
      editCapability,
      settings,
      onDone: (newSettings) => {
        const overrides = viewSettings.childViewSettings?.overrides
        const next = overrides ? { ...newSettings, overrides } : newSettings
        if (Object.keys(next).length || viewSettings.childViewSettings) viewSettings.childViewSettings = next
      },
      groupByKeys,
      availableLayouts: [...ALL_VIEW_LAYOUTS],
      showClickAction: false
    })
  }
</script>

<div class="form-stack">
  <!-- View As / Configure Defaults For -->
  {#if !configMode}
    <div class="heading-with-action">
      <h3>View As</h3>
      <div class="heading-actions">
        {#if viewSettings.layout != null}
          <button class="link-button" onclick={() => (viewSettings.layout = null)}>Reset to default</button>
        {/if}
        {#if hasLayoutOptions}
          <button class="link-button" onclick={() => (showLayoutOptions = !showLayoutOptions)}>
            Options <Icon name={showLayoutOptions ? 'up' : 'down'} size={15} />
          </button>
        {/if}
      </div>
    </div>
    <div class="selection-bar">
      {#each filteredLayouts as layout}
        <label>
          <input
            type="radio"
            name="layout"
            value={layout.value}
            checked={effectiveLayout === layout.value}
            onchange={() => (viewSettings.layout = layout.value as any)}
          />
          <span>{layout.label}</span>
        </label>
      {/each}
    </div>
  {:else}
    <h3>Configure Defaults For</h3>
    <div class="selection-bar">
      {#each layouts as layout}
        {#if layout.value !== 'tree' && Object.keys(LAYOUT_SPECIFIC_SETTINGS_CONFIG[layout.value]).length > 0}
          <label>
            <input
              type="radio"
              name="config-layout"
              value={layout.value}
              onchange={() => { if (layout.value !== 'tree') activeConfigLayout = layout.value }}
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
      {#each layoutOptions as key (key)}
        {@const control = controls[key]}
        {@const title = key === 'gridPosterSize' && layoutToShowOptionsFor === 'button-grid' ? 'Button Size' : control.title}
        {@const value = viewSettings[key] ?? inheritedInfo.settings[key] ?? optionDefaults[key]}
        <div class="heading-with-action">
          <h4>{title}</h4>
          {#if !configMode}
            {#if viewSettings[key] != null}
              <button class="link-button" onclick={() => setLayoutOption(key, null)}>Reset to default</button>
            {:else}
              <span class="inherited-value-text-inline">
                Using default from <strong>{formatSource(inheritedInfo.sources[key])}</strong>
              </span>
            {/if}
          {/if}
        </div>
        {#if 'label' in control}
          <label class="checkbox-label">
            <input type="checkbox" checked={Boolean(value)}
              onchange={(event) => setLayoutOption(key, event.currentTarget.checked)} />
            <span>{control.label}</span>
          </label>
        {:else}
          <label class="slider-container">
            <input type="range" aria-label={title}
              min={control.min} max={control.max} step={control.step} {value}
              oninput={(event) => setLayoutOption(key, event.currentTarget.valueAsNumber)} />
            <span>{value}{control.unit ?? ''}</span>
          </label>
        {/if}
      {/each}
    </div>
  {/if}

  <!-- Group By -->
  {#if !configMode}
    <div class="divider"></div>
    <h4>Group By</h4>
    <select aria-label="Group by" value={effectiveGroupBy} onchange={(e) => (selectedGroupBy = e.currentTarget.value)}>
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
        <button class="link-button" onclick={() => { viewSettings.sortBy = null; viewSettings.sortDescending = null }}>Reset to default</button>
      {/if}
    </div>
    <div class="sort-controls">
      <select
        aria-label="Sort by"
        value={effectiveSortBy}
        onchange={(e) => (viewSettings.sortBy = e.currentTarget.value as SortBy)}
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
          onchange={() => (viewSettings.sortDescending = !effectiveSortDescending)}
        />
        <span>Descending</span>
      </label>
      {#if item && pins}
        {@const placedCount = pins.top.length + pins.bottom.length + Object.values(pins.after).flat().length}
        <button
          class="secondary pin-btn"
          onclick={() => modalStore.open('sortPinning', { item, placement: pins, onDone: (placement) => (pins = placement) })}
        >
          {#if placedCount > 0}Arranged ({placedCount})...{:else}Arrange items...{/if}
        </button>
      {/if}
    </div>
  {/if}

  <!-- Child Item Layout -->
  {#if !configMode}
    <div class="divider"></div>
    <div class="heading-with-action">
      <h4>Child Item Layout</h4>
      {#if viewSettings.childViewSettings != null}
        <button class="link-button" onclick={() => (viewSettings.childViewSettings = null)}>Reset</button>
      {/if}
    </div>
    <button type="button" class="view-config-row" onclick={openChildSettings}>
      <span>{formatLayoutString(viewSettings.childViewSettings)}</span>
      <span>Configure <Icon name="right" size={15} /></span>
    </button>
  {/if}
</div>

<style>
  .inherited-value-text-inline {
    font-size: 0.8rem;
    color: var(--ev-c-text-2);
    white-space: nowrap;
  }
  .inherited-value-text-inline strong {
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: .25rem;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    color: var(--color-primary-soft);
    font-size: 0.8rem;
    padding: 0;
  }

  .options-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: .75rem .85rem;
    background: var(--surface-raised);
    border-radius: var(--radius-panel);
    border: 1px solid var(--color-border-soft);
  }

  .divider {
    border-bottom: 1px solid var(--color-background-mute);

  }
  .heading-with-action {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: .4rem;
    flex-wrap: wrap;
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
    font-size: 1.05rem;
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
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem;
  }
  .sort-controls select {
    flex: 1 0 7rem;
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
    display: inline-flex;
    align-items: center;
    gap: .25rem;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    color: var(--color-primary-soft);
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
    text-align: left;
    font-size: .9rem;
    color: var(--color-text-soft);
  }
  .view-config-row span:last-child { display: inline-flex; align-items: center; gap: .3rem; color: var(--color-primary-soft); }
  .view-config-row:hover {
    background: var(--color-background-soft);
  }
</style>
