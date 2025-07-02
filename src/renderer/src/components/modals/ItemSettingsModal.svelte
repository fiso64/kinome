<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import MetadataTab from './_parts/item-settings/MetadataTab.svelte'
  import ViewTab from './_parts/item-settings/ViewTab.svelte'
  import FolderTab from './_parts/item-settings/FolderTab.svelte'
  import FileTab from './_parts/item-settings/FileTab.svelte'
  import type { StoredViewSettings } from '../../../../shared/types'

  type VirtualFolderProps = {
    isVirtual?: boolean
    physicalParentId?: string
    groupByKey?: string
    groupByValue?: string
  }

  let {
    item,
    onClose,
    onNeedRefresh,
    initialTab = 'metadata',
    groupByKeys,
    defaultLayout,
    settings
  }: {
    item: LibraryItem & VirtualFolderProps
    onClose: () => void
    onNeedRefresh: () => Promise<void>
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
    tagValues: {}
  })

  // --- Metadata State ---
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

  // --- Folder Settings State ---
  let retrieveChildrenMetadata = $state(
    _isFolder ? (item.retrieve_children_metadata ?? false) : false
  )
  let childrenTypeHint = $state(_isFolder ? (item.children_type_hint ?? 'auto') : 'auto')
  let processTvChildren = $state(_isFolder ? (item.process_tv_children ?? true) : true)

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
    if (isVirtual && item.physicalParentId) {
      // --- Editing a Virtual Folder ---
      const physicalParent = await window.api.getItemById(item.physicalParentId)
      if (!physicalParent || physicalParent.type !== 'folder') return null

      // Clone parent but exclude children for performance
      const { children, ...parentWithoutChildren } = physicalParent
      const updatedParent: MediaFolder = JSON.parse(JSON.stringify(parentWithoutChildren))

      if (!updatedParent.virtualFolderSettings) updatedParent.virtualFolderSettings = {}
      if (!updatedParent.virtualFolderSettings[item.groupByKey!]) {
        updatedParent.virtualFolderSettings[item.groupByKey!] = {}
      }
      const virtualFolderSettings =
        updatedParent.virtualFolderSettings[item.groupByKey!][item.groupByValue!] ?? {}

      applyViewSettings(virtualFolderSettings)

      updatedParent.virtualFolderSettings[item.groupByKey!][item.groupByValue!] =
        virtualFolderSettings
      return updatedParent
    } else {
      // --- Editing a Physical Item ---
      const { children, ...itemWithoutChildren } = item as MediaFolder
      const updatedItem: LibraryItem = JSON.parse(JSON.stringify(itemWithoutChildren))

      // Apply metadata changes
      updatedItem.title = title.trim() ? title.trim() : undefined
      const parsedYear = parseInt(year, 10)
      updatedItem.year = !isNaN(parsedYear) ? parsedYear : undefined
      updatedItem.mediaType = mediaType
      updatedItem.overview = overview
      updatedItem.genres = [...genres]
      updatedItem.tags = tags.reduce((acc: Record<string, string>, tag) => {
        if (tag.key) acc[tag.key] = tag.value
        return acc
      }, {})

      const parseOptionalInt = (val: string) => (!isNaN(parseInt(val)) ? parseInt(val) : undefined)
      if (updatedItem.type === 'folder') {
        if (mediaType === 'season')
          (updatedItem as MediaFolder).seasonNumber = parseOptionalInt(seasonNumber)
        else delete (updatedItem as MediaFolder).seasonNumber
      } else {
        if (mediaType === 'episode') {
          ;(updatedItem as MediaFile).seasonNumber = parseOptionalInt(episodeSeasonNumber)
          ;(updatedItem as MediaFile).episodeNumber = parseOptionalInt(episodeNumber)
        } else {
          delete (updatedItem as MediaFile).seasonNumber
          delete (updatedItem as MediaFile).episodeNumber
        }
      }

      // Apply view and folder changes if it's a folder
      if (updatedItem.type === 'folder') {
        applyViewSettings(updatedItem)

        updatedItem.retrieve_children_metadata = retrieveChildrenMetadata
        updatedItem.children_type_hint = childrenTypeHint === 'auto' ? undefined : childrenTypeHint
        updatedItem.process_tv_children = processTvChildren === true ? undefined : false
      }

      updatedItem.isHidden = item.isHidden

      return updatedItem
    }
  }

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
    onClose()

    // Trigger refresh after closing the modal for a better user experience.
    if (needsRefresh) {
      await onNeedRefresh()
    }
  }

  $effect(() => {
    window.api.getAutocompleteSuggestions().then((data) => (suggestions = data))
  })
</script>

<ModalWindow title={item.title ?? item.name} {onClose} onSave={handleSave} maxWidth="700px">
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
