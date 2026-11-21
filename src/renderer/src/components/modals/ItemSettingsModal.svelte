<script lang="ts">
  import { untrack } from 'svelte'
  import { authStore } from '@lib/auth-store.svelte'
  import equal from 'fast-deep-equal'
  import ModalWindow from './_base/ModalWindow.svelte'
  import Skeleton from '@components/ui/Skeleton.svelte'
  import MetadataTab from './_parts/item-settings/MetadataTab.svelte'
  import ViewTab from './_parts/item-settings/ViewTab.svelte'
  import FolderTab from './_parts/item-settings/FolderTab.svelte'
  import VirtualFolderTab from './_parts/item-settings/VirtualFolderTab.svelte'
  import { getItemPlaybackDefault, saveItemPlaybackDefault } from '@lib/services/web-playback.service'
  import { isPlaybackLanguageList, normalizePlaybackLanguages, type PlaybackDefaultsEditor, type PlaybackLanguageDefaults } from '@shared/web-playback'
  import { resolveViewSettings } from '@shared/settings-helpers'
  import { itemCapabilities } from '@shared/item-capabilities'
  import { hasValidEpisodePrecision } from '@shared/metadata-fields'
  import { dialogStore } from '@lib/dialog-store'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import { ALL_VIEW_OVERRIDE_KEYS } from '@shared/types'
  import type {
    CascadableViewSettings,
    EditableViewSettings,
    MediaFolder,
    MediaFile,
    LibraryItem,
    LibraryFilter,
    Settings,
    AutocompleteSuggestions,
    ResolutionInfo,
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
  const editControl = $derived(authStore.control('editMetadata'))

  // Redirect to a valid tab if the requested one isn't available for this item
  let selectedTab = $state<'metadata' | 'view' | 'folder' | 'virtualFolder'>(
    (() => {
      const c = itemCapabilities(item)
      if (initialTab === 'virtualFolder' && !c.canEditVirtualFolder) return 'metadata'
      if (initialTab === 'folder' && !c.canEditFolderSettings) return c.canEditView ? 'view' : 'metadata'
      if ((initialTab as any) === 'settings') return 'metadata'
      return initialTab as any
    })()
  )

  const activeTab = $derived(editControl.disabled ? 'metadata' : selectedTab)

  let playbackDefaults = $state<PlaybackLanguageDefaults | null>(null)
  let savedPlaybackDefaults = $state.raw<PlaybackLanguageDefaults | null>(null)
  let trackLanguages = $state.raw<PlaybackDefaultsEditor['languages']>(null)
  let playbackDefaultsError = $state(false)
  let isSaving = $state(false)
  const playbackDefaultsChanged = $derived(!equal(playbackDefaults, savedPlaybackDefaults))

  $effect(() => {
    const id = item.id
    const controller = new AbortController()
    playbackDefaults = null
    savedPlaybackDefaults = null
    playbackDefaultsError = false
    trackLanguages = null
    void getItemPlaybackDefault(id, controller.signal).then(({ defaults, languages }) => {
      if (controller.signal.aborted) return
      savedPlaybackDefaults = defaults
      playbackDefaults = defaults ? { ...defaults } : null
      trackLanguages = languages
    }).catch(() => {
      if (!controller.signal.aborted) playbackDefaultsError = true
    })
    return () => controller.abort()
  })

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

  function cleanNulls<T extends object>(obj: T): { [K in keyof T]: NonNullable<T[K]> } {
    return Object.fromEntries(
      Object.entries(obj).filter(([, v]) => v != null)
    ) as any
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
      episodeNumber: episodeNumber ?? null,
      episodeSeasonNumber: parseOptionalInt(episodeSeasonNumber),
      viewSettings: $state.snapshot(cleanNulls(viewSettings)),
      pins: $state.snapshot(pins),
      selectedGroupBy,
      retrieveChildrenMetadata,
      childrenTypeHint,
      processTvChildren,
      vfolderFilter: JSON.parse(JSON.stringify(vfolderFilter))
    }
  }

  // --- Loading State ---
  let isRefreshing = $state(true)
  let refreshRequest = 0

  // --- Metadata State ---
  async function refreshItemDetails(id: string, canEdit: boolean) {
    const request = ++refreshRequest
    isRefreshing = true
    try {
      const freshItem = await window.api.getItem(id)
      if (request === refreshRequest && freshItem) {
        // Update local state with fresh data to correct any stale props
        title = freshItem.title ?? ''
        year = freshItem.year?.toString() ?? ''
        mediaType = freshItem.mediaType ?? null
        tmdbMetadata = freshItem.tmdbMetadata
        localMedia = freshItem.localMedia
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
          if (canEdit) {
            selectedGroupBy = folder.viewSettings?.appliedGrouping ?? null
            viewSettings = readEditableViewSettings(folder)
            pins = readPins(folder)

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
          }
        } else if (freshItem.mediaType === 'episode') {
          episodeSeasonNumber = (freshItem as MediaFile).seasonNumber?.toString() ?? ''
          episodeNumber = (freshItem as MediaFile).episodeNumber ?? undefined
        }

        // After refreshing, re-capture initial values so they reflect the single source of truth
        captureInitialValues()
      }
    } catch (e) {
      console.error('Failed to refresh details', e)
    } finally {
      if (request === refreshRequest) isRefreshing = false
    }
  }

  $effect(() => {
    const id = item.id
    const canEdit = !editControl.disabled
    if (id) untrack(() => { void refreshItemDetails(id, canEdit) })
  })

  let title = $state(item.title ?? '')
  let tmdbMetadata = $state(item.tmdbMetadata)
  let localMedia = $state(item.localMedia)
  let year = $state(item.year?.toString() ?? '')
  let mediaType = $state(item.mediaType ?? null)
  let overview = $state(item.overview ?? '')
  let genres = $state<string[]>(JSON.parse(JSON.stringify(item.genres ?? [])))
  let tags = $state(
    Object.entries(item.tags ?? {}).map(([key, value]) => ({ id: crypto.randomUUID(), key, value }))
  )
  let seasonNumber = $state(_isFolder ? ((item as MediaFolder).seasonNumber?.toString() ?? '') : '')
  let episodeNumber = $state<number | undefined>(
    !_isFolder ? (item as MediaFile).episodeNumber ?? undefined : undefined
  )
  let episodeSeasonNumber = $state(
    !_isFolder ? ((item as MediaFile).seasonNumber?.toString() ?? '') : ''
  )

  // --- View State (for folders) ---
  function readEditableViewSettings(folder: MediaFolder): EditableViewSettings {
    const parentStored = overrideParent?.viewSettings ?? overrideParent?.viewHierarchy?.stored
    const resolution = resolveViewSettings(folder, settings, new Set(), parentStored?.childViewSettings)
    const keys = [...ALL_VIEW_OVERRIDE_KEYS, 'sortBy', 'sortDescending'] as const
    const editable = Object.fromEntries(keys.map((key) => {
      const source = resolution.sources[key]?.source
      return [key, source === 'item' || source === 'override' ? resolution.settings[key] ?? null : null]
    })) as EditableViewSettings
    const stored = overrideParent
      ? parentStored?.childViewSettings?.overrides?.[folder.id] ?? parentStored?.overrides?.[folder.id]
      : folder.viewSettings
    if (stored?.childViewSettings) editable.childViewSettings = $state.snapshot(stored.childViewSettings)
    return editable
  }

  function readPins(folder?: MediaFolder) {
    return {
      top: [...(folder?.viewSettings?.sortTop ?? [])],
      bottom: [...(folder?.viewSettings?.sortBottom ?? [])]
    }
  }

  let pins = $state(readPins(item.type === 'folder' ? item : undefined))
  let selectedGroupBy = $state(_isFolder ? item.viewSettings?.appliedGrouping ?? null : null)
  let viewSettings = $state<EditableViewSettings>(
    item.type === 'folder' ? readEditableViewSettings(item) : {}
  )

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
        changedLocal = Number(n1) !== Number(n2)
      } else if (typeof n1 === 'object' || typeof n2 === 'object') {
        changedLocal = !equal(n1, n2)
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

      const viewUpdates = cleanNulls(viewSettings)
      parentUpdates.viewSettings = { ...parentUpdates.viewSettings, ...viewUpdates }

      // Check if we actually changed anything relative to the initial override/parent settings
      if (
        hasChanged(cleanNulls(viewSettings), initialValues.viewSettings, 'viewSettings') ||
        hasChanged(parentUpdates.viewSettings.childViewSettings, initialValues.viewSettings?.childViewSettings, 'childViewSettings')
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
        const finalEpNum = episodeNumber ?? null
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
        const viewUpdates = cleanNulls(viewSettings)
        if (hasChanged(viewUpdates, initialValues.viewSettings, 'viewSettings')) {
          updates.viewSettings = viewUpdates
          changed = true
        }
      }

      if (hasChanged(pins, initialValues.pins)) {
        updates.viewSettings = { ...updates.viewSettings, sortTop: [...pins.top], sortBottom: [...pins.bottom] }
        changed = true
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
    if (isRefreshing || isSaving || (editControl.disabled && !playbackDefaultsChanged)) return
    const defaultsUpdate = playbackDefaultsChanged && playbackDefaults ? {
      audioLanguage: playbackDefaults.audioLanguage === null ? null : normalizePlaybackLanguages(playbackDefaults.audioLanguage),
      subtitleLanguage: playbackDefaults.subtitleLanguage === null ? null : normalizePlaybackLanguages(playbackDefaults.subtitleLanguage)
    } : null
    if (defaultsUpdate && (
      (defaultsUpdate.audioLanguage !== null && !isPlaybackLanguageList(defaultsUpdate.audioLanguage)) ||
      (defaultsUpdate.subtitleLanguage !== null && defaultsUpdate.subtitleLanguage !== 'off' &&
        !isPlaybackLanguageList(defaultsUpdate.subtitleLanguage))
    )) {
      dialogStore.showError({
        title: 'Invalid Playback Language',
        message: 'Enter one or more language codes separated by commas, for example en, ja, pt-BR.'
      })
      return
    }
    if (
      !editControl.disabled &&
      !isFolder &&
      mediaType === 'episode' &&
      episodeNumber !== undefined &&
      episodeNumber !== initialValues.episodeNumber &&
      (!hasValidEpisodePrecision(episodeNumber) || episodeNumber < 1)
    ) {
      dialogStore.showError({
        title: 'Invalid Episode Number',
        message: 'Enter an episode number of at least 1 with at most one decimal place.'
      })
      return
    }

    isSaving = true
    let itemUpdates = 0
    let needsRefresh = false
    let changedGrouping = false

    try {
      const itemsToUpdate = editControl.disabled ? [] : await buildUpdatedItems()
      itemUpdates = itemsToUpdate.length
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
      if (!editControl.disabled && isFolder) {
        const newGroupBy = selectedGroupBy === 'folder' ? null : selectedGroupBy
        const initialGroupBy = initialValues.selectedGroupBy === 'folder' ? null : initialValues.selectedGroupBy
        if (newGroupBy !== initialGroupBy) {
          await window.api.setGrouping(item.id, newGroupBy)
          changedGrouping = true
        }
      }

      if (!editControl.disabled && itemsToUnhide.length > 0) {
        for (const id of itemsToUnhide) {
          // We use userUpdateItem with just the ID and isHidden: false
          await window.api.userUpdateItem({ id, isHidden: false } as any)
        }
        needsRefresh = true
      }

      if (defaultsUpdate && savedPlaybackDefaults) {
        const patch: Partial<PlaybackLanguageDefaults> = {}
        for (const field of ['audioLanguage', 'subtitleLanguage'] as const) {
          if (defaultsUpdate[field] !== savedPlaybackDefaults[field]) patch[field] = defaultsUpdate[field]
        }
        if (Object.keys(patch).length) await saveItemPlaybackDefault(item.id, patch)
      }
    } catch (err: any) {
      dialogStore.showError({ title: 'Error Saving', message: err.message || 'Failed to save settings.' })
      return
    } finally {
      isSaving = false
    }

    // If the item was hidden, the onLibraryItemUpdated listener in App.svelte
    // will handle removing it from the view. The modal should always close.
    handleClose()

    if (itemUpdates > 0 || changedGrouping) {
      libraryDataService.invalidateAllQueries()
    }

    // Trigger refresh after closing the modal for a better user experience.
    if (needsRefresh) {
      await onNeedRefresh()
    }
  }

  function handleClose() {
    onClose()
  }

  $effect(() => {
    if (editControl.disabled) return
    window.api.getAutocompleteSuggestions().then((data) => (suggestions = data)).catch(() => {})
  })
</script>

<ModalWindow
  title={overrideParent && activeTab === 'view' ? `Override: ${overrideParent.name} > ${item.name}` : title || item.name}
  onClose={handleClose}
  onSave={handleSave}
  submitDisabled={isRefreshing || isSaving || (editControl.disabled && !playbackDefaultsChanged)}
  cancelText={editControl.disabled && !playbackDefaultsChanged ? 'Close' : 'Cancel'}
  maxWidth="700px"
>
  {#snippet header()}
    <div class="selection-bar" role="group" aria-label="Item settings sections">
      {#if caps.canEditMetadata}
        <button type="button" aria-pressed={activeTab === 'metadata'} onclick={() => (selectedTab = 'metadata')}>
          Metadata
        </button>
      {/if}
      {#if caps.canEditView}
        <button type="button" aria-pressed={activeTab === 'view'} {...editControl} onclick={() => (selectedTab = 'view')}>
          View
        </button>
      {/if}
      {#if caps.canEditFolderSettings}
        <button type="button" aria-pressed={activeTab === 'folder'} {...editControl} onclick={() => (selectedTab = 'folder')}>
          Settings
        </button>
      {/if}
      {#if caps.canEditVirtualFolder}
        <button type="button" aria-pressed={activeTab === 'virtualFolder'} {...editControl} onclick={() => (selectedTab = 'virtualFolder')}>
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
        readOnly={editControl.disabled}
        bind:playbackDefaults
        {trackLanguages}
        {playbackDefaultsError}
        {item}
        {tmdbMetadata}
        {localMedia}
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
          bind:pins
          bind:viewSettings
          bind:selectedGroupBy
        />
    {:else if activeTab === 'virtualFolder' && caps.canEditVirtualFolder}
      <VirtualFolderTab bind:filter={vfolderFilter} folderId={item.id} parentId={item.parentId ?? ''} {suggestions} />
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
</style>
