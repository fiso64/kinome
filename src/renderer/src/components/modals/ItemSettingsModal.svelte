<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import MetadataTab from './_parts/item-settings/MetadataTab.svelte'
  import ViewTab from './_parts/item-settings/ViewTab.svelte'
  import FolderTab from './_parts/item-settings/FolderTab.svelte'
  import FileTab from './_parts/item-settings/FileTab.svelte'
  import type {
    StoredViewSettings,
    MediaFolder,
    MediaFile,
    LibraryItem,
    Settings,
    AutocompleteSuggestions
  } from '../../../../shared/types'

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
    settings
  }: {
    item: LibraryItem & VirtualFolderProps
    onClose: () => void
    onNeedRefresh?: () => Promise<void>
    initialTab?: 'metadata' | 'view' | 'folder' | 'settings'
    groupByKeys: string[]
    defaultLayout: 'grid' | 'tree'
    settings: Settings | null
  } = $props()

  const _isFolder = item.type === 'folder' // Local constant for one-time state initialization
  const isFolder = $derived(item.type === 'folder') // Reactive derived value for the template
  const isVirtual = $derived(item.isVirtual === true) // This derived value is fine for the template

  // For initializing `activeTab`, directly use the prop `item.isVirtual`
  // to avoid the compiler warning about capturing the initial value of a derived signal.
  let activeTab = $state(
    item.isVirtual === true && (initialTab === 'metadata' || initialTab === 'folder')
      ? 'view'
      : initialTab
  )

  // --- Shared Autocomplete Suggestions ---
  let suggestions = $state<AutocompleteSuggestions>({
    mediaTypes: [],
    genres: [],
    tagKeys: [],
    virtualTagKeys: [],
    tagValues: {},
    persons: []
  })

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
      seasonNumber: !isNaN(parseInt(seasonNumber)) ? parseInt(seasonNumber) : undefined,
      episodeNumber: !isNaN(parseInt(episodeNumber)) ? parseInt(episodeNumber) : undefined,
      episodeSeasonNumber: !isNaN(parseInt(episodeSeasonNumber))
        ? parseInt(episodeSeasonNumber)
        : undefined,
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
      const freshItem = await window.api.getItemV2(item.id)
      if (freshItem) {
        // Update local state with fresh data to correct any stale props
        title = freshItem.title ?? freshItem.name
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
          seasonNumber = folder.seasonNumber?.toString() ?? ''

          // Refresh View Settings
          selectedLayout = folder.layout ?? null
          selectedClickAction = folder.clickAction ?? null
          selectedGroupBy = folder.groupBy ?? null
          gridPosterSize = folder.gridPosterSize ?? null
          listDescriptionRows = folder.listDescriptionRows ?? null
          showHorizontalScrollbar = folder.showHorizontalScrollbar ?? null
          childViewSettings = folder.childViewSettings ?? null

          // Refresh Folder Settings
          retrieveChildrenMetadata = folder.retrieve_children_metadata ?? false
          childrenTypeHint = folder.children_type_hint ?? 'auto'
          processTvChildren = folder.process_tv_children ?? true
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
    refreshItemDetails()
  })

  let title = $state(item.title ?? item.name)
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
  let selectedLayout = $state(_isFolder ? (item.layout ?? null) : null)
  let selectedClickAction = $state(_isFolder ? (item.clickAction ?? null) : null)
  let selectedGroupBy = $state(_isFolder ? (item.groupBy ?? null) : null)
  let gridPosterSize = $state((_isFolder ? (item as MediaFolder).gridPosterSize : null) ?? null)
  let listDescriptionRows = $state(
    (_isFolder ? (item as MediaFolder).listDescriptionRows : null) ?? null
  )
  let showHorizontalScrollbar = $state(
    (_isFolder ? (item as MediaFolder).showHorizontalScrollbar : null) ?? null
  )
  let childViewSettings = $state(_isFolder ? (item.childViewSettings ?? null) : null)

  // --- Folder Settings State ---
  let retrieveChildrenMetadata = $state(
    _isFolder ? (item.retrieve_children_metadata ?? false) : false
  )
  let childrenTypeHint = $state(_isFolder ? (item.children_type_hint ?? 'auto') : 'auto')
  let processTvChildren = $state(_isFolder ? (item.process_tv_children ?? true) : true)

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

    const hasChanged = (current: any, initial: any): boolean => {
      if (Array.isArray(current) || (current && typeof current === 'object')) {
        return JSON.stringify(current) !== JSON.stringify(initial)
      }
      return current !== initial
    }

    if (isVirtual && item.physicalParentId) {
      // --- Editing a Virtual Folder ---
      const physicalParent = await (window as any).api.getItemById(item.physicalParentId)
      if (!physicalParent || physicalParent.type !== 'folder') return null

      // Prepare settings to save
      const settingsToSave: Partial<MediaFolder> = {}
      applyViewSettings(settingsToSave)

      // Clone childViewSettings before assigning it
      if (childViewSettings) {
        ;(settingsToSave as any).childViewSettings = JSON.parse(JSON.stringify(childViewSettings))
      }

      // Check if view settings changed
      if (
        hasChanged(settingsToSave.layout, initialValues.selectedLayout) ||
        hasChanged(settingsToSave.clickAction, initialValues.selectedClickAction) ||
        hasChanged(settingsToSave.groupBy, initialValues.selectedGroupBy) ||
        hasChanged(settingsToSave.gridPosterSize, initialValues.gridPosterSize) ||
        hasChanged(settingsToSave.listDescriptionRows, initialValues.listDescriptionRows) ||
        hasChanged(settingsToSave.showHorizontalScrollbar, initialValues.showHorizontalScrollbar) ||
        hasChanged(settingsToSave.childViewSettings, initialValues.childViewSettings)
      ) {
        // Construct the full path in virtualFolderSettings for the parent
        const updatedParent: Partial<MediaFolder> = {
          id: physicalParent.id,
          virtualFolderSettings: JSON.parse(
            JSON.stringify(physicalParent.virtualFolderSettings ?? {})
          )
        }
        if (!updatedParent.virtualFolderSettings![item.groupByKey!]) {
          updatedParent.virtualFolderSettings![item.groupByKey!] = {}
        }
        updatedParent.virtualFolderSettings![item.groupByKey!][item.groupByValue!] = settingsToSave
        return updatedParent as LibraryItem
      }
      return null // No changes
    } else {
      // --- Editing a Physical Item ---

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

      const parseOptionalInt = (val: string) => (!isNaN(parseInt(val)) ? parseInt(val) : undefined)
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
        const viewSettings: Partial<MediaFolder> = {}
        applyViewSettings(viewSettings)

        if (hasChanged(viewSettings.layout, initialValues.selectedLayout)) {
          updates.layout = viewSettings.layout
          changed = true
        }
        if (hasChanged(viewSettings.clickAction, initialValues.selectedClickAction)) {
          updates.clickAction = viewSettings.clickAction
          changed = true
        }
        if (hasChanged(viewSettings.groupBy, initialValues.selectedGroupBy)) {
          updates.groupBy = viewSettings.groupBy
          changed = true
        }
        if (hasChanged(viewSettings.gridPosterSize, initialValues.gridPosterSize)) {
          updates.gridPosterSize = viewSettings.gridPosterSize
          changed = true
        }
        if (hasChanged(viewSettings.listDescriptionRows, initialValues.listDescriptionRows)) {
          updates.listDescriptionRows = viewSettings.listDescriptionRows
          changed = true
        }
        if (
          hasChanged(viewSettings.showHorizontalScrollbar, initialValues.showHorizontalScrollbar)
        ) {
          updates.showHorizontalScrollbar = viewSettings.showHorizontalScrollbar
          changed = true
        }

        const finalChildViewSettings = childViewSettings
          ? JSON.parse(JSON.stringify(childViewSettings))
          : undefined
        if (hasChanged(finalChildViewSettings, initialValues.childViewSettings)) {
          updates.childViewSettings = finalChildViewSettings
          changed = true
        }

        if (hasChanged(retrieveChildrenMetadata, initialValues.retrieveChildrenMetadata)) {
          updates.retrieve_children_metadata = retrieveChildrenMetadata
          changed = true
        }

        const finalTypeHint =
          childrenTypeHint === 'auto' || (childrenTypeHint as string) === ''
            ? undefined
            : (childrenTypeHint as 'movie' | 'tv')
        if (hasChanged(finalTypeHint, initialValues.childrenTypeHint)) {
          updates.children_type_hint = finalTypeHint
          changed = true
        }

        const finalProcessTv = processTvChildren === true ? undefined : false
        if (hasChanged(finalProcessTv, initialValues.processTvChildren)) {
          updates.process_tv_children = finalProcessTv
          changed = true
        }
      }

      return changed ? (updates as LibraryItem) : null
    }
  }

  import { navStoreV2 } from '../../lib/navigation-store-v2.svelte'

  async function handleSave() {
    const itemToUpdate = await buildUpdatedItem()
    let needsRefresh = false
    if (itemToUpdate) {
      const wasEnabled = item.type === 'folder' ? (item.retrieve_children_metadata ?? false) : false
      await window.api.userUpdateItem(itemToUpdate)
      if (
        itemToUpdate.type === 'folder' &&
        itemToUpdate.retrieve_children_metadata &&
        !wasEnabled
      ) {
        needsRefresh = true
      }
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
    if (navStoreV2.state.itemSettingsId) {
      navStoreV2.closeModals()
    } else {
      onClose()
    }
  }

  $effect(() => {
    window.api.getAutocompleteSuggestions().then((data) => (suggestions = data))
  })
</script>

<ModalWindow
  title={item.title ?? item.name}
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
      <ViewTab
        item={item as MediaFolder}
        {groupByKeys}
        {settings}
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
  .scroll-area {
    /* This can be used if content overflows */
  }
</style>
