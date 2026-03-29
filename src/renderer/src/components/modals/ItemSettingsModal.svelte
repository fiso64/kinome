<script lang="ts">
  import { untrack } from 'svelte'
  import ModalWindow from './_base/ModalWindow.svelte'
  import Skeleton from '@components/ui/Skeleton.svelte'
  import MetadataTab from './_parts/item-settings/MetadataTab.svelte'
  import ViewTab from './_parts/item-settings/ViewTab.svelte'
  import FolderTab from './_parts/item-settings/FolderTab.svelte'
  import VirtualFolderTab from './_parts/item-settings/VirtualFolderTab.svelte'
  import { resolveViewSettings } from '@shared/settings-helpers'
  import { itemCapabilities } from '@shared/item-capabilities'
  import { dialogStore } from '@lib/dialog-store'
  import { FOLDER_ORGANIZATION_KEYS } from '@shared/types'
  import type {
    StoredViewSettings,
    CascadableViewSettings,
    MediaFolder,
    MediaFile,
    LibraryItem,
    LibraryFilter,
    Settings,
    AutocompleteSuggestions,
    ResolutionInfo,
    ResolutionSource,
    ViewLayout
  } from '@shared/types'

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
    item: LibraryItem
    onClose: () => void
    onNeedRefresh?: () => Promise<void>
    initialTab?: 'metadata' | 'view' | 'folder' | 'virtualFolder'
    groupByKeys: string[]
    defaultLayout: ViewLayout
    settings: Settings | null
    overrideParent?: LibraryItem
  } = $props()

  const _isFolder = item.type === 'folder' // Local constant for one-time state initialization
  const isFolder = $derived(item.type === 'folder') // Reactive derived value for the template
  const caps = $derived(itemCapabilities(item))

  // Redirect to a valid tab if the requested one isn't available for this item
  let activeTab = $state<'metadata' | 'view' | 'folder' | 'virtualFolder'>(
    (() => {
      const c = itemCapabilities(item)
      if (initialTab === 'virtualFolder' && !c.canEditVirtualFolder) return 'metadata'
      if (initialTab === 'folder' && !c.canEditFolderSettings) return c.canEditView ? 'view' : 'metadata'
      if ((initialTab as any) === 'settings') return 'metadata'
      return initialTab as any
    })()
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
      selectedSortBy,
      selectedSortDescending,
      gridPosterSize,
      listDescriptionRows,
      showHorizontalScrollbar,
      scrollHorizontally,
      childViewSettings: childViewSettings ? JSON.parse(JSON.stringify(childViewSettings)) : null,
      retrieveChildrenMetadata,
      childrenTypeHint,
      processTvChildren,
      vfolderFilter: JSON.parse(JSON.stringify(vfolderFilter))
    }
  }

  // --- Loading State ---
  let isRefreshing = $state(true)

  // --- Metadata State ---
  async function refreshItemDetails() {
    if (!item.id) return
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

          // Use the centralized resolution logic to see what's currently active.
          // We pass overrideParent's childViewSettings as inheritedSettings.
          const parentStored = overrideParent?.viewSettings ?? overrideParent?.viewHierarchy?.stored
          const resolution = resolveViewSettings(
            folder,
            settings,
            new Set(),
            parentStored?.childViewSettings
          )

          // We only want to populate the modal with values that are actually STORED
          // at the relevant layer (Item layer or Override layer).
          const stored: StoredViewSettings = {}
          for (const [key, sourceInfo] of Object.entries(resolution.sources) as [
            keyof StoredViewSettings,
            ResolutionSource
          ][]) {
            if (sourceInfo.source === 'item' || sourceInfo.source === 'override') {
              ;(stored as any)[key] = (resolution.settings as any)[key]
            }
          }
          // Structural (non-cascading) fields are never in resolution.sources — merge directly.
          for (const key of FOLDER_ORGANIZATION_KEYS) {
            if (folder.viewSettings?.[key] !== undefined) {
              ;(stored as any)[key] = folder.viewSettings[key]
            }
          }

          seasonNumber = folder.seasonNumber?.toString() ?? ''

          // Refresh View State
          selectedLayout = stored.layout ?? null
          selectedClickAction = stored.clickAction ?? null
          selectedGroupBy = stored.appliedGrouping ?? null
          selectedSortBy = stored.sortBy ?? null
          selectedSortDescending = stored.sortDescending ?? null
          gridPosterSize = stored.gridPosterSize ?? null
          listDescriptionRows = stored.listDescriptionRows ?? null
          showHorizontalScrollbar = stored.showHorizontalScrollbar ?? null
          scrollHorizontally = stored.scrollHorizontally ?? null
          childViewSettings = stored.childViewSettings ?? null

          // Refresh Folder Settings
          retrieveChildrenMetadata = folder.folderSettings?.retrieveChildrenMetadata ?? false
          childrenTypeHint = folder.folderSettings?.childrenTypeHint ?? 'auto'
          processTvChildren = folder.folderSettings?.processTvChildren ?? true

          // Refresh Virtual Folder Filter State
          if (folder.isVirtual) {
            vfolderFilter = folder.filter
              ? JSON.parse(JSON.stringify(folder.filter))
              : { conditionGroups: [[{ field: 'genre', op: 'contains', value: '' }]] }
          }
        } else if (freshItem.mediaType === 'episode') {
          episodeSeasonNumber = (freshItem as MediaFile).seasonNumber?.toString() ?? ''
          episodeNumber = (freshItem as MediaFile).episodeNumber?.toString() ?? ''
        }

        // After refreshing, re-capture initial values so they reflect the single source of truth
        captureInitialValues()
      }
    } catch (e) {
      console.error('Failed to refresh details', e)
    } finally {
      isRefreshing = false
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

    const parentStored = overrideParent?.viewSettings ?? overrideParent?.viewHierarchy?.stored
    const resolution = resolveViewSettings(
      folder,
      settings,
      new Set(),
      parentStored?.childViewSettings
    )

    const stored: StoredViewSettings = {}
    for (const [key, sourceInfo] of Object.entries(resolution.sources) as [
      keyof StoredViewSettings,
      ResolutionSource
    ][]) {
      if (sourceInfo.source === 'item' || sourceInfo.source === 'override') {
        ;(stored as any)[key] = (resolution.settings as any)[key]
      }
    }
    // FolderOrganizationSettings fields are never in resolution.sources — merge directly.
    for (const key of FOLDER_ORGANIZATION_KEYS) {
      if (folder.viewSettings?.[key] !== undefined) {
        ;(stored as any)[key] = folder.viewSettings[key]
      }
    }

    return stored
  })()

  let selectedLayout = $state(_isFolder ? (initialStored.layout ?? null) : null)
  let selectedClickAction = $state(_isFolder ? (initialStored.clickAction ?? null) : null)
  let selectedGroupBy = $state(_isFolder ? (initialStored.appliedGrouping ?? null) : null)
  let selectedSortBy = $state(_isFolder ? (initialStored.sortBy ?? null) : null)
  let selectedSortDescending = $state(_isFolder ? (initialStored.sortDescending ?? null) : null)
  let gridPosterSize = $state((_isFolder ? initialStored.gridPosterSize : null) ?? null)
  let listDescriptionRows = $state((_isFolder ? initialStored.listDescriptionRows : null) ?? null)
  let showHorizontalScrollbar = $state(
    (_isFolder ? initialStored.showHorizontalScrollbar : null) ?? null
  )
  let scrollHorizontally = $state(
    (_isFolder ? initialStored.scrollHorizontally : null) ?? null
  )
  let childViewSettings = $state<CascadableViewSettings | null>(_isFolder ? (initialStored.childViewSettings ?? null) : null)

  // --- Folder Settings State ---
  let retrieveChildrenMetadata = $state(
    _isFolder ? (item.folderSettings?.retrieveChildrenMetadata ?? false) : false
  )
  let childrenTypeHint = $state<'auto' | 'movie' | 'tv'>(
    _isFolder ? (item.folderSettings?.childrenTypeHint ?? 'auto') : 'auto'
  )
  let processTvChildren = $state(
    _isFolder ? (item.folderSettings?.processTvChildren ?? true) : true
  )
  let itemsToUnhide = $state<string[]>([])

  // --- Virtual Folder Filter State ---
  let vfolderFilter = $state<LibraryFilter>(
    _isFolder && item.isVirtual && (item as MediaFolder).filter
      ? JSON.parse(JSON.stringify((item as MediaFolder).filter))
      : { conditionGroups: [[{ field: 'genre', op: 'contains', value: '' }]] }
  )

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
    target.sortBy = selectedSortBy
    target.sortDescending = selectedSortDescending
    target.gridPosterSize = gridPosterSize
    target.listDescriptionRows = listDescriptionRows
    target.showHorizontalScrollbar = showHorizontalScrollbar
    target.scrollHorizontally = scrollHorizontally
  }

  async function buildUpdatedItems(): Promise<LibraryItem[]> {
    const itemsToReturn: LibraryItem[] = []

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
        hasChanged(parentUpdates.viewSettings.sortBy, initialValues.selectedSortBy, 'sortBy') ||
        hasChanged(
          parentUpdates.viewSettings.sortDescending,
          initialValues.selectedSortDescending,
          'sortDescending'
        ) ||
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
          parentUpdates.viewSettings.scrollHorizontally,
          initialValues.scrollHorizontally,
          'scrollHorizontally'
        ) ||
        hasChanged(
          parentUpdates.viewSettings.childViewSettings,
          initialValues.childViewSettings,
          'childViewSettings'
        )
      ) {
        console.log(`[ItemSettingsModal] [DEBUG] Override mode changes detected.`, parentUpdates)
        itemsToReturn.push(parentUpdates as LibraryItem)
      }
    }

    // --- Editing a Standard Item (Physical or Virtual) ---
    const updates: any = { id: item.id }
    let changed = false

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
      // If we don't have an override parent, view settings are saved to the item itself.
      if (!overrideParent) {
        const viewUpdates: any = {}
        applyViewSettings(viewUpdates)

        if (
          hasChanged(viewUpdates.layout, initialValues.selectedLayout, 'layout') ||
          hasChanged(viewUpdates.clickAction, initialValues.selectedClickAction, 'clickAction') ||
          hasChanged(viewUpdates.sortBy, initialValues.selectedSortBy, 'sortBy') ||
          hasChanged(viewUpdates.sortDescending, initialValues.selectedSortDescending, 'sortDescending') ||
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
          ) ||
          hasChanged(
            viewUpdates.scrollHorizontally,
            initialValues.scrollHorizontally,
            'scrollHorizontally'
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
      }

      // 3. Folder Behavior Settings
      const folderSettingsUpdate: Record<string, any> = {}
      if (hasChanged(retrieveChildrenMetadata, initialValues.retrieveChildrenMetadata)) {
        folderSettingsUpdate.retrieveChildrenMetadata = retrieveChildrenMetadata
      }
      if (hasChanged(childrenTypeHint, initialValues.childrenTypeHint)) {
        folderSettingsUpdate.childrenTypeHint = childrenTypeHint
      }
      if (hasChanged(processTvChildren, initialValues.processTvChildren)) {
        folderSettingsUpdate.processTvChildren = processTvChildren
      }

      if (Object.keys(folderSettingsUpdate).length > 0) {
        updates.folderSettings = folderSettingsUpdate as any
        changed = true
      }
    }

    // 4. Virtual Folder Filter Changes
    if (caps.canEditVirtualFolder) {
      if (hasChanged(vfolderFilter, initialValues.vfolderFilter, 'filter')) {
        updates.filter = JSON.parse(JSON.stringify(vfolderFilter))
        changed = true
      }
    }

    if (changed) {
      itemsToReturn.push(updates as LibraryItem)
    }

    return itemsToReturn
  }

  async function handleSave() {
    const itemsToUpdate = await buildUpdatedItems()
    let needsRefresh = false

    try {
      for (const itemToUpdate of itemsToUpdate) {
        const wasEnabled =
          itemToUpdate.type === 'folder' ? (itemToUpdate.folderSettings?.retrieveChildrenMetadata ?? false) : false
        console.log(`[ItemSettingsModal] [DEBUG] Sending userUpdateItem:`, itemToUpdate)
        await window.api.userUpdateItem(itemToUpdate)
        if (
          itemToUpdate.type === 'folder' &&
          itemToUpdate.folderSettings?.retrieveChildrenMetadata &&
          !wasEnabled
        ) {
          needsRefresh = true
        }
      }

      // Apply grouping change as a separate action if it changed
      if (isFolder) {
        const newGroupBy = selectedGroupBy === 'folder' ? null : selectedGroupBy
        const initialGroupBy = initialValues.selectedGroupBy === 'folder' ? null : initialValues.selectedGroupBy
        if (newGroupBy !== initialGroupBy) {
          await window.api.setGrouping(item.id, newGroupBy)
        }
      }

      if (itemsToUnhide.length > 0) {
        for (const id of itemsToUnhide) {
          // We use userUpdateItem with just the ID and isHidden: false
          await window.api.userUpdateItem({ id, isHidden: false } as any)
        }
        needsRefresh = true
      }
    } catch (err: any) {
      dialogStore.showError({ title: 'Error Saving', message: err.message || 'Failed to save settings.' })
      return
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
    window.api.getAutocompleteSuggestions().then((data) => (suggestions = data)).catch(() => {})
  })
</script>

<ModalWindow
  title={overrideParent && activeTab === 'view' ? `Override: ${overrideParent.name} > ${item.name}` : title || item.name}
  onClose={handleClose}
  onSave={handleSave}
  maxWidth="700px"
>
  {#snippet header()}
    <div class="tabs">
      {#if caps.canEditMetadata}
        <button class:active={activeTab === 'metadata'} onclick={() => (activeTab = 'metadata')}>
          Metadata
        </button>
      {/if}
      {#if caps.canEditView}
        <button class:active={activeTab === 'view'} onclick={() => (activeTab = 'view')}>
          View
        </button>
      {/if}
      {#if caps.canEditFolderSettings}
        <button class:active={activeTab === 'folder'} onclick={() => (activeTab = 'folder')}>
          Settings
        </button>
      {/if}
      {#if caps.canEditVirtualFolder}
        <button class:active={activeTab === 'virtualFolder'} onclick={() => (activeTab = 'virtualFolder')}>
          Virtual Folder
        </button>
      {/if}
    </div>
  {/snippet}

  <div class="scroll-area">
    {#if isRefreshing}
      <div class="modal-skeleton">
        {#each [['40%', '2rem'], ['100%', '2.5rem'], ['100%', '2.5rem'], ['70%', '2rem'], ['100%', '2.5rem'], ['100%', '2.5rem']] as [w, h]}
          <Skeleton width={w} height={h} />
        {/each}
      </div>
    {:else if activeTab === 'metadata' && caps.canEditMetadata}
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
    {:else if activeTab === 'view' && caps.canEditView}
      {@const parentStored = overrideParent?.viewSettings ?? overrideParent?.viewHierarchy?.stored}
      {@const inheritedSettings = parentStored?.childViewSettings}
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
          bind:selectedSortBy
          bind:selectedSortDescending
          bind:gridPosterSize
          bind:listDescriptionRows
          bind:showHorizontalScrollbar
          bind:scrollHorizontally
          bind:childViewSettings
        />
    {:else if activeTab === 'virtualFolder' && caps.canEditVirtualFolder}
      <VirtualFolderTab bind:filter={vfolderFilter} parentId={item.parentId ?? ''} {suggestions} />
    {:else if activeTab === 'folder' && caps.canEditFolderSettings}
      <FolderTab
        item={item as MediaFolder}
        bind:retrieveChildrenMetadata
        bind:childrenTypeHint
        bind:processTvChildren
        bind:itemsToUnhide
        {onNeedRefresh}
      />
    {/if}
  </div>
</ModalWindow>

<style>
  .modal-skeleton {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.5rem;
  }

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
