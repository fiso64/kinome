<script lang="ts">
  import { untrack } from 'svelte'
  import ModalWindow from './_base/ModalWindow.svelte'
  import MetadataTab from './_parts/item-settings/MetadataTab.svelte'
  import ViewTab from './_parts/item-settings/ViewTab.svelte'
  import FolderTab from './_parts/item-settings/FolderTab.svelte'
  import FileTab from './_parts/item-settings/FileTab.svelte'
  import { navStore } from '@lib/navigation-store.svelte'
  import type {
    StoredViewSettings,
    MediaFolder,
    MediaFile,
    LibraryItem,
    Settings,
    AutocompleteSuggestions,
    ResolutionInfo
  } from '@shared/types'

  type VirtualFolderProps = {
    isVirtual?: boolean
    physicalParentId?: string
    groupByKey?: string
    groupByValue?: string
  }

  let {
    item,
    onClose,
    onNeedRefresh = async () => {}, // Make optional as it's not strictly required for saving
    initialTab = 'metadata',
    groupByKeys = [],
    defaultLayout = 'grid',
    settings,
    overrideParent
  }: {
    item: LibraryItem & VirtualFolderProps
    onClose: () => void
    onNeedRefresh?: () => Promise<void>
    initialTab?: 'metadata' | 'view' | 'folder' | 'settings'
    groupByKeys: string[]
    defaultLayout: 'grid' | 'horizontal-grid' | 'list' | 'tree' | 'tabs' | 'sections'
    settings: Settings | null
    overrideParent?: LibraryItem
  } = $props()

  const _isFolder = item.type === 'folder' // Local constant for one-time state initialization
  const isFolder = $derived(item.type === 'folder') // Reactive derived value for the template
  const isVirtual = $derived(item.isVirtual === true) // This derived value is fine for the template

  // For initializing `activeTab`, directly use the prop `item.isVirtual`
  // to avoid the compiler warning about capturing the initial value of a derived signal.
  let activeTab = $state<'metadata' | 'view' | 'folder' | 'settings'>(
    item.isVirtual === true && (initialTab === 'metadata' || initialTab === 'folder')
      ? 'view'
      : initialTab
  )

  // --- Shared Autocomplete Suggestions ---
  let suggestions = $state<AutocompleteSuggestions>({
    mediaType: [],
    genre: [],
    tags: {},
    virtualTags: {},
    person: null
  })

  function parseOptionalInt(val: string): number | undefined {
    const parsed = parseInt(val, 10)
    return isNaN(parsed) ? undefined : parsed
  }

  // --- Initial Data Tracking for Partial Updates ---
  let initialValues = $state<any>({})

  function captureInitialValues() {
    initialValues = {
      title,
      year,
      mediaType,
      overview,
      genres: JSON.parse(JSON.stringify(genres)),
      tags: tags.reduce((acc: Record<string, string>, tag) => {
        if (tag.key) acc[tag.key] = tag.value
        return acc
      }, {}),
      seasonNumber: parseOptionalInt(seasonNumber),
      episodeNumber: parseOptionalInt(episodeNumber),
      episodeSeasonNumber: parseOptionalInt(episodeSeasonNumber),
      selectedLayout,
      selectedClickAction,
      selectedGroupBy,
      gridPosterSize,
      listDescriptionRows,
      showHorizontalScrollbar,
      childViewSettings: childViewSettings ? JSON.parse(JSON.stringify(childViewSettings)) : null,
      retrieveChildrenMetadata,
      childrenTypeHint,
      processTvChildren
    }
  }

  // --- Metadata State ---
  async function refreshItemDetails() {
    if (isVirtual || !item.id) return
    try {
      const freshItem = await window.api.getItem(item.id)
      if (freshItem) {
        // Update local state with fresh data to correct any stale props
        title = freshItem.title ?? ''
        year = freshItem.year?.toString() ?? ''
        mediaType = freshItem.mediaType
        overview = freshItem.overview ?? ''
        genres = JSON.parse(JSON.stringify(freshItem.genres ?? []))
        tags = Object.entries(freshItem.tags ?? {}).map(([key, value]) => ({
          id: crypto.randomUUID(),
          key,
          value: value as string
        }))

        if (freshItem.type === 'folder') {
          const folder = freshItem as MediaFolder
          // Use stored settings directly from the item's viewSettings property
          const stored = folder.viewSettings ?? {}

          seasonNumber = folder.seasonNumber?.toString() ?? ''

          // Refresh View State
          selectedLayout = stored.layout ?? null
          selectedClickAction = stored.clickAction ?? null
          selectedGroupBy = stored.groupBy ?? null
          gridPosterSize = stored.gridPosterSize ?? null
          listDescriptionRows = stored.listDescriptionRows ?? null
          showHorizontalScrollbar = stored.showHorizontalScrollbar ?? null
          childViewSettings = stored.childViewSettings ?? null

          // Refresh Folder Settings
          retrieveChildrenMetadata = folder.scraperSettings?.retrieve_children_metadata ?? false
          childrenTypeHint = folder.scraperSettings?.children_type_hint ?? 'auto'
          processTvChildren = folder.scraperSettings?.process_tv_children ?? true
        } else if (freshItem.mediaType === 'episode') {
          episodeSeasonNumber = (freshItem as MediaFile).seasonNumber?.toString() ?? ''
          episodeNumber = (freshItem as MediaFile).episodeNumber?.toString() ?? ''
        }

        // After refreshing, re-capture initial values so they reflect the single source of truth
        captureInitialValues()
      }
    } catch (e) {
      console.error('Failed to refresh details', e)
    }
  }

  $effect(() => {
    // Only track item change (e.g. ID or refreshed object from parent)
    const id = item.id
    untrack(() => {
      refreshItemDetails()
    })
  })

  let title = $state(item.title ?? '')
  let year = $state(item.year?.toString() ?? '')
  let mediaType = $state(item.mediaType)
  let overview = $state(item.overview ?? '')
  let genres = $state<string[]>(JSON.parse(JSON.stringify(item.genres ?? [])))
  let tags = $state(
    Object.entries(item.tags ?? {}).map(([key, value]) => ({ id: crypto.randomUUID(), key, value }))
  )
  let seasonNumber = $state(_isFolder ? ((item as MediaFolder).seasonNumber?.toString() ?? '') : '')
  let episodeNumber = $state(
    !_isFolder ? ((item as MediaFile).episodeNumber?.toString() ?? '') : ''
  )
  let episodeSeasonNumber = $state(
    !_isFolder ? ((item as MediaFile).seasonNumber?.toString() ?? '') : ''
  )

  // --- View State (for folders) ---
  const initialStored = (() => {
    if (item.type !== 'folder') return {}
    const folder = item as MediaFolder

    // If we are in "Override Mode," we look at the parent's specific override for this child
    if (overrideParent?.viewSettings?.childViewSettings) {
      const parentChildSettings = overrideParent.viewSettings.childViewSettings
      if (parentChildSettings.overrides && parentChildSettings.overrides[item.id]) {
        return parentChildSettings.overrides[item.id]
      }
      // If no specific override exists yet, we return an empty object so fields are null
      // and fall back to the inherited defaults in the UI.
      return {}
    }

    // Default: use the item's own settings
    return folder.viewSettings ?? {}
  })()

  let selectedLayout = $state(_isFolder ? (initialStored.layout ?? null) : null)
  let selectedClickAction = $state(_isFolder ? (initialStored.clickAction ?? null) : null)
  let selectedGroupBy = $state(_isFolder ? (initialStored.groupBy ?? null) : null)
  let gridPosterSize = $state((_isFolder ? initialStored.gridPosterSize : null) ?? null)
  let listDescriptionRows = $state((_isFolder ? initialStored.listDescriptionRows : null) ?? null)
  let showHorizontalScrollbar = $state(
    (_isFolder ? initialStored.showHorizontalScrollbar : null) ?? null
  )
  let childViewSettings = $state(_isFolder ? (initialStored.childViewSettings ?? null) : null)

  // --- Folder Settings State ---
  let retrieveChildrenMetadata = $state(
    _isFolder ? (item.scraperSettings?.retrieve_children_metadata ?? false) : false
  )
  let childrenTypeHint = $state<'auto' | 'movie' | 'tv'>(
    _isFolder ? (item.scraperSettings?.children_type_hint ?? 'auto') : 'auto'
  )
  let processTvChildren = $state(
    _isFolder ? (item.scraperSettings?.process_tv_children ?? true) : true
  )
  let itemsToUnhide = $state<string[]>([])

  // Capture initial state from props/initialization
  captureInitialValues()

  // --- Actions ---

  /**
   * Applies the current view settings from the modal's state to a target object.
   * This centralizes the logic for both physical and virtual folders.
   * @param target The object to apply view settings to (either a LibraryItem or a virtual folder settings object).
   */
  function applyViewSettings(target: Partial<StoredViewSettings>) {
    target.layout = selectedLayout
    target.clickAction = selectedClickAction
    target.gridPosterSize = gridPosterSize
    target.listDescriptionRows = listDescriptionRows
    target.showHorizontalScrollbar = showHorizontalScrollbar
    target.groupBy =
      selectedGroupBy === 'folder' || selectedGroupBy === null ? null : selectedGroupBy
  }

  async function buildUpdatedItem(): Promise<LibraryItem | null> {
    const updates: any = { id: item.id }
    let changed = false

    const hasChanged = (current: any, initial: any, fieldName?: string): boolean => {
      // Treat null and undefined as equal for change detection
      const n1 = current === undefined || current === null ? null : current
      const n2 = initial === undefined || initial === null ? null : initial

      // Handle numeric comparisons (strings from inputs vs numbers from data)
      const isNumeric = (v: any) =>
        typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))

      let changedLocal = false
      if (isNumeric(n1) && isNumeric(n2)) {
        changedLocal = parseInt(n1.toString(), 10) !== parseInt(n2.toString(), 10)
      } else if (Array.isArray(n1) || (n1 && typeof n1 === 'object')) {
        changedLocal = JSON.stringify(n1) !== JSON.stringify(n2)
      } else {
        changedLocal = n1 !== n2
      }

      if (changedLocal && fieldName) {
        console.log(`[ItemSettingsModal] [DEBUG] Field "${fieldName}" changed:`, {
          from: n2,
          to: n1
        })
      }
      return changedLocal
    }

    if (overrideParent) {
      // --- Override Mode: We are saving settings to the parent's child overrides ---
      const parentUpdates: any = {
        id: overrideParent.id,
        overrideChildId: item.id, // This tells the backend we are performing an override
        viewSettings: {}
      }

      applyViewSettings(parentUpdates.viewSettings)
      if (childViewSettings) {
        parentUpdates.viewSettings.childViewSettings = JSON.parse(JSON.stringify(childViewSettings))
      }

      // Check if we actually changed anything relative to the initial override/parent settings
      if (
        hasChanged(parentUpdates.viewSettings.layout, initialValues.selectedLayout, 'layout') ||
        hasChanged(
          parentUpdates.viewSettings.clickAction,
          initialValues.selectedClickAction,
          'clickAction'
        ) ||
        hasChanged(parentUpdates.viewSettings.groupBy, initialValues.selectedGroupBy, 'groupBy') ||
        hasChanged(
          parentUpdates.viewSettings.gridPosterSize,
          initialValues.gridPosterSize,
          'gridPosterSize'
        ) ||
        hasChanged(
          parentUpdates.viewSettings.listDescriptionRows,
          initialValues.listDescriptionRows,
          'listDescriptionRows'
        ) ||
        hasChanged(
          parentUpdates.viewSettings.showHorizontalScrollbar,
          initialValues.showHorizontalScrollbar,
          'showHorizontalScrollbar'
        ) ||
        hasChanged(
          parentUpdates.viewSettings.childViewSettings,
          initialValues.childViewSettings,
          'childViewSettings'
        )
      ) {
        console.log(`[ItemSettingsModal] [DEBUG] Override mode changes detected.`, parentUpdates)
        return parentUpdates as LibraryItem
      }
      return null
    }

    if (isVirtual && item.physicalParentId) {
      // --- Editing a Virtual Folder (Legacy Redirection) ---
      // Note: We are moving towards 'overrides', but we still support the legacy
      // virtualFolderSettings storage for now.
      const settingsToSave: any = {
        id: item.id,
        isVirtual: true,
        physicalParentId: item.physicalParentId,
        groupByKey: item.groupByKey,
        groupByValue: item.groupByValue,
        viewSettings: {}
      }

      applyViewSettings(settingsToSave.viewSettings)

      if (childViewSettings) {
        settingsToSave.viewSettings.childViewSettings = JSON.parse(
          JSON.stringify(childViewSettings)
        )
      }

      if (
        hasChanged(settingsToSave.viewSettings.layout, initialValues.selectedLayout, 'layout') ||
        hasChanged(
          settingsToSave.viewSettings.clickAction,
          initialValues.selectedClickAction,
          'clickAction'
        ) ||
        hasChanged(settingsToSave.viewSettings.groupBy, initialValues.selectedGroupBy, 'groupBy') ||
        hasChanged(
          settingsToSave.viewSettings.gridPosterSize,
          initialValues.gridPosterSize,
          'gridPosterSize'
        ) ||
        hasChanged(
          settingsToSave.viewSettings.listDescriptionRows,
          initialValues.listDescriptionRows,
          'listDescriptionRows'
        ) ||
        hasChanged(
          settingsToSave.viewSettings.showHorizontalScrollbar,
          initialValues.showHorizontalScrollbar,
          'showHorizontalScrollbar'
        ) ||
        hasChanged(
          settingsToSave.viewSettings.childViewSettings,
          initialValues.childViewSettings,
          'childViewSettings'
        )
      ) {
        console.log(`[ItemSettingsModal] [DEBUG] Virtual folder changes detected.`, settingsToSave)
        return settingsToSave as LibraryItem
      }
      return null
    }

    // --- Editing a Standard Physical Item ---

    // 1. Metadata Changes
    const trimmedTitle = title.trim() ? title.trim() : undefined
    if (hasChanged(trimmedTitle, initialValues.title)) {
      updates.title = trimmedTitle
      changed = true
    }

    const parsedYear = parseInt(year, 10)
    const finalYear = !isNaN(parsedYear) ? parsedYear : undefined
    if (hasChanged(finalYear, initialValues.year)) {
      updates.year = finalYear
      changed = true
    }

    if (hasChanged(mediaType, initialValues.mediaType)) {
      updates.mediaType = mediaType
      changed = true
    }

    if (hasChanged(overview, initialValues.overview)) {
      updates.overview = overview
      changed = true
    }

    if (hasChanged(genres, initialValues.genres)) {
      updates.genres = [...genres]
      changed = true
    }

    const currentTags = tags.reduce((acc: Record<string, string>, tag) => {
      if (tag.key) acc[tag.key] = tag.value
      return acc
    }, {})
    if (hasChanged(currentTags, initialValues.tags)) {
      updates.tags = currentTags
      changed = true
    }

    if (isFolder) {
      if (mediaType === 'season') {
        const finalSeasonNumber = parseOptionalInt(seasonNumber)
        if (hasChanged(finalSeasonNumber, initialValues.seasonNumber)) {
          updates.seasonNumber = finalSeasonNumber
          changed = true
        }
      }
    } else {
      if (mediaType === 'episode') {
        const finalEpSeason = parseOptionalInt(episodeSeasonNumber)
        const finalEpNum = parseOptionalInt(episodeNumber)
        if (hasChanged(finalEpSeason, initialValues.episodeSeasonNumber)) {
          updates.seasonNumber = finalEpSeason
          changed = true
        }
        if (hasChanged(finalEpNum, initialValues.episodeNumber)) {
          updates.episodeNumber = finalEpNum
          changed = true
        }
      }
    }

    // 2. View and Folder Setting Changes (for folders)
    if (isFolder) {
      const viewUpdates: any = {}
      applyViewSettings(viewUpdates)

      if (
        hasChanged(viewUpdates.layout, initialValues.selectedLayout, 'layout') ||
        hasChanged(viewUpdates.clickAction, initialValues.selectedClickAction, 'clickAction') ||
        hasChanged(viewUpdates.groupBy, initialValues.selectedGroupBy, 'groupBy') ||
        hasChanged(viewUpdates.gridPosterSize, initialValues.gridPosterSize, 'gridPosterSize') ||
        hasChanged(
          viewUpdates.listDescriptionRows,
          initialValues.listDescriptionRows,
          'listDescriptionRows'
        ) ||
        hasChanged(
          viewUpdates.showHorizontalScrollbar,
          initialValues.showHorizontalScrollbar,
          'showHorizontalScrollbar'
        )
      ) {
        updates.viewSettings = viewUpdates
        changed = true
      }

      const finalChildViewSettings = childViewSettings
        ? JSON.parse(JSON.stringify(childViewSettings))
        : null
      if (
        hasChanged(finalChildViewSettings, initialValues.childViewSettings, 'childViewSettings')
      ) {
        if (!updates.viewSettings) updates.viewSettings = {}
        updates.viewSettings.childViewSettings = finalChildViewSettings
        changed = true
      }
      // 3. Folder Settings (Scraper, etc)
      const scraperSettings: any = {}
      if (hasChanged(retrieveChildrenMetadata, initialValues.retrieveChildrenMetadata)) {
        scraperSettings.retrieve_children_metadata = retrieveChildrenMetadata
      }
      if (hasChanged(childrenTypeHint, initialValues.childrenTypeHint)) {
        scraperSettings.children_type_hint = childrenTypeHint
      }
      if (hasChanged(processTvChildren, initialValues.processTvChildren)) {
        scraperSettings.process_tv_children = processTvChildren
      }

      if (Object.keys(scraperSettings).length > 0) {
        updates.scraperSettings = scraperSettings
        changed = true
      }
    }

    return changed ? (updates as LibraryItem) : null
  }

  async function handleSave() {
    const itemToUpdate = await buildUpdatedItem()
    let needsRefresh = false
    if (itemToUpdate) {
      const wasEnabled =
        item.type === 'folder' ? (item.scraperSettings?.retrieve_children_metadata ?? false) : false
      console.log(`[ItemSettingsModal] [DEBUG] Sending userUpdateItem:`, itemToUpdate)
      await window.api.userUpdateItem(itemToUpdate)
      if (
        itemToUpdate.type === 'folder' &&
        itemToUpdate.scraperSettings?.retrieve_children_metadata &&
        !wasEnabled
      ) {
        needsRefresh = true
      }
    }

    if (itemsToUnhide.length > 0) {
      for (const id of itemsToUnhide) {
        // We use userUpdateItem with just the ID and isHidden: false
        await window.api.userUpdateItem({ id, isHidden: false } as any)
      }
      needsRefresh = true
    }

    // If the item was hidden, the onLibraryItemUpdated listener in App.svelte
    // will handle removing it from the view. The modal should always close.
    handleClose()

    // Trigger refresh after closing the modal for a better user experience.
    if (needsRefresh) {
      await onNeedRefresh()
    }
  }

  function handleClose() {
    onClose()
  }

  $effect(() => {
    window.api.getAutocompleteSuggestions().then((data) => (suggestions = data))
  })
</script>

<ModalWindow
  title={overrideParent ? `Override: ${overrideParent.name} > ${item.name}` : title || item.name}
  onClose={handleClose}
  onSave={handleSave}
  maxWidth="700px"
>
  {#snippet header()}
    <div class="tabs">
      {#if !isVirtual}
        <button class:active={activeTab === 'metadata'} onclick={() => (activeTab = 'metadata')}>
          Metadata
        </button>
      {/if}
      {#if isFolder}
        <button class:active={activeTab === 'view'} onclick={() => (activeTab = 'view')}>
          View
        </button>
        {#if !isVirtual}
          <button class:active={activeTab === 'folder'} onclick={() => (activeTab = 'folder')}>
            Settings
          </button>
        {/if}
      {:else if !isVirtual}
        <button class:active={activeTab === 'settings'} onclick={() => (activeTab = 'settings')}>
          Settings
        </button>
      {/if}
    </div>
  {/snippet}

  <div class="scroll-area">
    {#if activeTab === 'metadata' && !isVirtual}
      <MetadataTab
        {item}
        bind:title
        bind:year
        bind:mediaType
        bind:overview
        bind:genres
        bind:tags
        bind:seasonNumber
        bind:episodeNumber
        bind:episodeSeasonNumber
        {suggestions}
      />
    {:else if activeTab === 'view' && isFolder}
      {@const inheritedSettings = overrideParent?.viewSettings?.childViewSettings}
      {@const inheritedLabel = overrideParent
        ? (overrideParent.title ?? overrideParent.name)
        : undefined}
      <ViewTab
        item={item as MediaFolder}
        {groupByKeys}
        {settings}
        {inheritedSettings}
        {inheritedLabel}
        bind:selectedLayout
        bind:selectedClickAction
        bind:selectedGroupBy
        bind:gridPosterSize
        bind:listDescriptionRows
        bind:showHorizontalScrollbar
        bind:childViewSettings
      />
    {:else if activeTab === 'folder' && isFolder && !isVirtual}
      <FolderTab
        item={item as MediaFolder}
        bind:retrieveChildrenMetadata
        bind:childrenTypeHint
        bind:processTvChildren
        bind:itemsToUnhide
        {onNeedRefresh}
      />
    {:else if activeTab === 'settings' && !isFolder && !isVirtual}
      <FileTab />
    {/if}
  </div>
</ModalWindow>

<style>
  .tabs {
    display: flex;
  }
  .tabs button {
    padding: 0.8rem 1.2rem;
    background: none;
    color: var(--ev-c-text-2);
    font-size: 1rem;
    font-weight: 600;
    border-bottom: 3px solid transparent;
    transition: all 0.2s;
  }
  .tabs button:hover:not(:disabled) {
    color: var(--ev-c-text-1);
    background: none;
  }
  .tabs button.active {
    color: var(--ev-c-text-1);
    border-bottom-color: var(--ev-c-white-soft);
  }
</style>
