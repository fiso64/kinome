<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import { formatLayoutString } from '../../../../shared/settings-helpers'
  import { type AutocompleteConfig } from '../../lib/autocomplete-manager'
  import { dialogStore } from '../../lib/dialog-store'
  import { createEventDispatcher } from 'svelte'
  import DefaultViewSettingsModal from './DefaultViewSettingsModal.svelte'
  import DefaultLayoutSettingsModal from './DefaultLayoutSettingsModal.svelte'
  import PlayerCommandsModal from './PlayerCommandsModal.svelte'
  import CustomActionsModal from './CustomActionsModal.svelte'
  import VirtualTagEditor from './_parts/VirtualTagEditor.svelte'
  import { DEFAULT_LAYOUTS_CONFIG } from '../../../../shared/types'
  import type { PlayerCommandConfig, CustomActionConfig } from '../../../../shared/types'
  const placeholderText = 'e.g., mpv "{PATH}" or "C:\\VLC\\vlc.exe" "{PATH}"'

  let { settings }: { settings: Settings | null } = $props()

  const dispatch = createEventDispatcher<{
    close: void
    fullRescanCompleted: { root: MediaFolder }
  }>()

  type ActiveViewSettingsModal = '_default' | 'movie' | 'tv' | 'season' | null

  let activeTab: 'general' | 'library' | 'view' | 'virtualTags' = $state('general')
  let activeViewSettingsModal = $state<ActiveViewSettingsModal>(null)
  let activeLayoutSettingsModal = $state(false)
  let activePlayerCommandsModal = $state(false)
  let activeCustomActionsModal = $state(false)

  // --- Form State ---
  let playerCommands = $state<PlayerCommandConfig[]>([])
  let customActions = $state<CustomActionConfig[]>([])
  let tmdbApiKey = $state('')
  let useLogos = $state(true)
  let creditsDisplay = $state<'shown' | 'collapsed' | 'hidden' | 'tab'>('tab')
  let grayOutWatched = $state(true)
  let showContinueWatching = $state(true)
  let showNextUp = $state(true)
  let itemDetailBackdropSize = $state<'small' | 'full'>('small')
  let itemDetailBackdropBlur = $state(4)
  let libraryDataLocation = $state('') // The path to the library data directory
  let mediaSourcePath = $state('') // The path to the user's media files
  let mediaSourcePathIsRelative = $state(false)
  let virtualTags = $state<Settings['virtualTags']>([])

  // New structured view settings state
  let defaultLayoutSettings = $state<Settings['defaultLayoutSettings'] | null>(null)
  let defaultLayouts = $state<Settings['defaultLayouts'] | null>(null)

  let settingsLoaded = $state(false)
  let resolvedMediaPath = $state('Resolving...')

  let suggestions = $state<AutocompleteSuggestions>({
    mediaTypes: [],
    genres: [],
    tagKeys: [],
    virtualTagKeys: [],
    tagValues: {}
  })

  const groupByKeys = $derived([
    'folder',
    'mediaType',
    'genre',
    'year',
    ...(suggestions?.virtualTagKeys?.map((vt) => `vt.${vt}`) ?? []),
    ...(suggestions?.tagKeys.map((k) => `tags.${k}`) ?? [])
  ])

  const VIRTUAL_TAG_CONTEXT_KEYS = [
    'title',
    'name',
    'year',
    'mediaType',
    'genres',
    'tags',
    'path',
    'watched',
    'seasonNumber',
    'episodeNumber',
    'overview',
    'posterPath',
    'backdropPath',
    'tmdbId'
  ]

  $effect(() => {
    window.api.getSettings().then((settings) => {
      playerCommands = JSON.parse(JSON.stringify(settings.playerCommands ?? []))
      customActions = JSON.parse(JSON.stringify(settings.customActions ?? []))
      tmdbApiKey = settings.tmdbApiKey
      useLogos = settings.useLogos
      creditsDisplay = settings.creditsDisplay
      grayOutWatched = settings.grayOutWatched
      showContinueWatching = settings.showContinueWatching
      showNextUp = settings.showNextUp
      itemDetailBackdropSize = settings.itemDetailBackdropSize
      itemDetailBackdropBlur = settings.itemDetailBackdropBlur
      virtualTags = (settings.virtualTags ?? []).map((vt) => ({
        ...vt,
        id: vt.id || crypto.randomUUID(),
        conditions: vt.conditions || []
      }))
      libraryDataLocation = settings.libraryLocation
      mediaSourcePath = settings.mediaSourcePath ?? ''
      mediaSourcePathIsRelative = settings.mediaSourcePathIsRelative ?? false

      // Set new view settings
      defaultLayoutSettings = JSON.parse(JSON.stringify(settings.defaultLayoutSettings))
      defaultLayouts = JSON.parse(JSON.stringify(settings.defaultLayouts))

      settingsLoaded = true
    })

    window.api.getAutocompleteSuggestions().then((data) => (suggestions = data))

    // This effect creates an async derived value for the resolved media path
    $effect(() => {
      let cancelled = false
      const resolve = async () => {
        if (!mediaSourcePath.trim()) {
          if (!cancelled) resolvedMediaPath = 'Not set'
          return
        }
        const resolved = await window.api.resolveMediaSourcePath({
          path: mediaSourcePath,
          isRelative: mediaSourcePathIsRelative
        })
        if (!cancelled) resolvedMediaPath = resolved
      }
      resolve()
      return () => {
        cancelled = true
      }
    })

    const TABS = ['general', 'library', 'view', 'virtualTags'] as const
    const handleKeydown = (event: KeyboardEvent): void => {
      // Don't interfere if a sub-modal is open
      if (activeViewSettingsModal || activeLayoutSettingsModal) return

      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        const currentIndex = TABS.indexOf(activeTab)
        const nextIndex = event.shiftKey
          ? (currentIndex - 1 + TABS.length) % TABS.length
          : (currentIndex + 1) % TABS.length
        activeTab = TABS[nextIndex]
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => {
      window.removeEventListener('keydown', handleKeydown)
    }
  })

  function addVirtualTag() {
    virtualTags = [...(virtualTags || []), { id: crypto.randomUUID(), name: '', conditions: [] }]
  }

  function removeVirtualTag(id: string) {
    virtualTags = virtualTags.filter((vt) => vt.id !== id)
  }

  import { navStack } from '../../lib/navigation-store.svelte'

  function handleCancel() {
    // If opened via history, use history back. Otherwise (e.g. forced open via code), dispatch close.
    if (navStack.isHistoryModalOpen) {
      navStack.closeModal()
    } else {
      dispatch('close')
    }
  }

  async function handleSave(): Promise<void> {
    const wasLibLocationChanged = libraryDataLocation !== settings?.libraryLocation
    const mediaPathChanged =
      mediaSourcePath !== settings?.mediaSourcePath ||
      mediaSourcePathIsRelative !== settings?.mediaSourcePathIsRelative

    // Deep clone to remove Svelte proxies before sending to IPC
    const plainVirtualTags = JSON.parse(JSON.stringify(virtualTags || []))

    const tagsToSave = plainVirtualTags
      .map((vt) => ({ ...vt, name: vt.name.trim() }))
      .filter((vt) => vt.name && vt.conditions.length > 0)

    await window.api.saveSettings({
      playerCommands: JSON.parse(JSON.stringify(playerCommands)),
      customActions: JSON.parse(JSON.stringify(customActions)),
      tmdbApiKey,
      useLogos,
      creditsDisplay,
      grayOutWatched,
      showContinueWatching,
      showNextUp,
      itemDetailBackdropSize,
      itemDetailBackdropBlur,
      virtualTags: tagsToSave,
      libraryLocation: libraryDataLocation,
      mediaSourcePath,
      mediaSourcePathIsRelative,
      defaultLayoutSettings: defaultLayoutSettings
        ? JSON.parse(JSON.stringify(defaultLayoutSettings))
        : undefined,
      defaultLayouts: defaultLayouts ? JSON.parse(JSON.stringify(defaultLayouts)) : undefined
    })

    if (wasLibLocationChanged) {
      // This will trigger a full app reload which is necessary
      return
    }

    if (mediaPathChanged) {
      const choice = await dialogStore.showDialog({
        title: 'Media Source Path Changed',
        message: 'How do you want to proceed?',
        detail:
          'A "Full Rescan" is for new libraries and wipes all metadata. A "Refresh" syncs changes for the existing library.',
        buttons: [
          { label: 'Do Nothing', value: 'nothing', class: 'secondary' },
          { label: 'Full Rescan (Wipe)', value: 'full_rescan', class: 'danger' },
          { label: 'Refresh (Sync)', value: 'rescan', class: 'primary' }
        ]
      })
      if (choice === 'full_rescan') {
        const root = await window.api.performFullRescan(resolvedMediaPath)
        if (root) {
          dispatch('fullRescanCompleted', { root })
        }
      } else if (choice === 'rescan') {
        await window.api.refreshLibrary()
      }
    }

    handleCancel() // Reuse cancel logic which handles history vs dispatch
  }

  async function handleBrowseMediaSource() {
    const newPath = await window.api.selectMediaSourceDirectory()
    if (newPath) {
      mediaSourcePath = newPath
    }
  }

  async function handleChangeLibraryDataLocation() {
    const path = await window.api.selectLibraryDirectory()
    if (path) {
      libraryDataLocation = path
    }
  }
</script>

{#if activeViewSettingsModal && defaultLayouts}
  {@const typeKey = activeViewSettingsModal}
  {@const config = DEFAULT_LAYOUTS_CONFIG[typeKey]}
  <DefaultViewSettingsModal
    {typeKey}
    title={config.label}
    initialSettings={defaultLayouts[typeKey]}
    {groupByKeys}
    availableLayouts={config.availableLayouts}
    showClickAction={config.showClickAction}
    {settings}
    onClose={() => (activeViewSettingsModal = null)}
    onSave={(newSettings) => {
      if (defaultLayouts) defaultLayouts[typeKey] = newSettings
    }}
  />
{/if}

{#if activePlayerCommandsModal}
  <PlayerCommandsModal bind:playerCommands onClose={() => (activePlayerCommandsModal = false)} />
{/if}

{#if activeCustomActionsModal}
  <CustomActionsModal bind:customActions onClose={() => (activeCustomActionsModal = false)} />
{/if}

{#if activeLayoutSettingsModal}
  <DefaultLayoutSettingsModal
    initialSettings={defaultLayoutSettings}
    {groupByKeys}
    onClose={() => (activeLayoutSettingsModal = false)}
    onSave={(newSettings) => {
      defaultLayoutSettings = newSettings
    }}
  />
{/if}

<ModalWindow title="Settings" onClose={handleCancel} onSave={handleSave} maxWidth="650px">
  {#snippet header()}
    <div class="tabs">
      <button class:active={activeTab === 'general'} onclick={() => (activeTab = 'general')}
        >General</button
      >
      <button class:active={activeTab === 'library'} onclick={() => (activeTab = 'library')}
        >Library</button
      >
      <button class:active={activeTab === 'view'} onclick={() => (activeTab = 'view')}>View</button>
      <button class:active={activeTab === 'virtualTags'} onclick={() => (activeTab = 'virtualTags')}
        >Virtual Tags</button
      >
    </div>
  {/snippet}

  <div class="tab-content">
    {#if activeTab === 'general'}
      <div class="form-group">
        <label for="player-command-display">Default Player Command</label>
        <div class="path-display-container">
          <input
            type="text"
            id="player-command-display"
            value="Copy Playlist URL to Clipboard"
            disabled
            style="flex-grow:1; font-style: italic; color: var(--ev-c-text-2);"
          />
          <button
            class="secondary"
            disabled
            title="Not available in Web UI"
            style="height: auto; align-self: stretch;"
          >
            Manage...
          </button>
        </div>
        <p class="help-text">
          In the Web UI, playing a file copies a streamable playlist URL to your clipboard. 
          Custom player commands are only available in the desktop client application.
        </p>
      </div>
      <div class="form-group">
        <label>Custom Actions</label>
        <div class="path-display-container">
          <div class="path-display" style="flex-grow: 1; text-align: center;">
            {customActions.length} action(s) configured
          </div>
          <button
            class="secondary"
            onclick={() => (activeCustomActionsModal = true)}
            style="height: auto; align-self: stretch;"
          >
            Manage...
          </button>
        </div>
        <p class="help-text">
          Define custom shell commands to run on items. These are available in the context menu.
        </p>
      </div>
      <div class="form-group">
        <label for="tmdb-api-key">The Movie Database (TMDB) API Key</label>
        <input type="password" id="tmdb-api-key" bind:value={tmdbApiKey} />
        <p class="help-text">Required for fetching movie and show posters and details.</p>
      </div>
    {:else if activeTab === 'library'}
      <div class="form-group">
        <label for="source-type">Media Source Type</label>
        <select id="source-type" disabled>
          <option>Local Path</option>
        </select>
      </div>
      <div class="form-group">
        <label>Media Source Path</label>
        <div class="path-display-container">
          <input
            type="text"
            class="path-input"
            bind:value={mediaSourcePath}
            placeholder="Enter local path to your media"
          />
          <button class="secondary" onclick={handleBrowseMediaSource}>Browse...</button>
        </div>
        <p class="help-text">
          Resolved Path: <code>{resolvedMediaPath}</code>
        </p>
      </div>
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={mediaSourcePathIsRelative} />
          <span>Store media source path relative to library data location</span>
        </label>
        <p class="help-text">
          Useful for portable libraries where the media folder and library data have a fixed
          relative position. The path is stored relative to the parent of the Library Data Location.
          For a local path <code>C:\Data\Library</code>, this is <code>C:\Data</code>. For a URL
          <code>http://server/library/</code>, this is <code>http://server/</code>.
        </p>
      </div>
      <div class="form-group">
        <label>Library Data Location</label>
        <div class="path-display-container">
          <input
            type="text"
            class="path-input"
            bind:value={libraryDataLocation}
            placeholder="Enter local path or http(s):// URL"
          />
          <button class="secondary" onclick={handleChangeLibraryDataLocation}>Browse...</button>
        </div>
        <p class="help-text">
          The folder (or URL) where metadata, images, and database files are stored. Changing this
          requires an app restart, which happens automatically after saving.
        </p>
      </div>
    {:else if activeTab === 'view'}
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={useLogos} />
          <span>Show and fetch logos for movies and shows</span>
        </label>
        <p class="help-text">
          When enabled, a high-quality logo will be displayed on detail pages if available.
        </p>
      </div>
      <div class="form-group">
        <label for="credits-display">Cast & Crew Section</label>
        <select id="credits-display" bind:value={creditsDisplay}>
          <option value="shown">Show Expanded</option>
          <option value="collapsed">Show Collapsed</option>
          <option value="tab">Show as Tab</option>
          <option value="hidden">Do Not Show or Fetch</option>
        </select>
        <p class="help-text">Controls the default visibility of the credits section.</p>
      </div>
      <div class="form-group">
        <label for="backdrop-size">Detail Page Backdrop Size</label>
        <select id="backdrop-size" bind:value={itemDetailBackdropSize}>
          <option value="small">Small (Default)</option>
          <option value="full">Full Screen</option>
        </select>
        <p class="help-text">Controls the size of the background image on item detail pages.</p>
      </div>
      <div class="form-group">
        <label>Detail Page Backdrop Blur</label>
        <div class="slider-container">
          <input type="range" bind:value={itemDetailBackdropBlur} min="0" max="50" step="1" />
          <span>{itemDetailBackdropBlur}px</span>
        </div>
        <p class="help-text">Controls the amount of blur applied to the background image.</p>
      </div>
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={grayOutWatched} />
          <span>Grey out watched items in lists</span>
        </label>
        <p class="help-text">Reduces the opacity of items that have been marked as watched.</p>
      </div>
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={showContinueWatching} />
          <span>Show "Continue Watching" on Home screen</span>
        </label>
      </div>
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={showNextUp} />
          <span>Show "Next Up" in TV Show details</span>
        </label>
      </div>
      <div class="form-group">
        <label>Default Layout Values</label>
        <p class="help-text">
          Configure global default values for specific layouts (e.g., poster size for Grid, group-by
          for Tabs).
        </p>
        <div class="view-config-row" onclick={() => (activeLayoutSettingsModal = true)}>
          <span>Global Defaults</span>
          <button class="secondary" tabindex="-1">Configure...</button>
        </div>
      </div>

      {#if defaultLayouts}
        {#each Object.entries(DEFAULT_LAYOUTS_CONFIG) as [key, config] (key)}
          <div class="form-group">
            <label>{config.label}</label>
            <p class="help-text">{config.help}</p>
            <div class="view-config-row" onclick={() => (activeViewSettingsModal = key as any)}>
              <span>{formatLayoutString(defaultLayouts[key])}</span>
              <button class="secondary" tabindex="-1">Configure...</button>
            </div>
          </div>
        {/each}
      {/if}
    {:else if activeTab === 'virtualTags'}
      <p class="help-text">
        Virtual tags are calculated automatically based on rules. They are stored in the database
        for fast searching and filtering.
      </p>
      <div class="virtual-tags-list">
        {#each virtualTags as tag, i (tag.id)}
          <VirtualTagEditor bind:tag={virtualTags[i]} onDelete={() => removeVirtualTag(tag.id)} />
        {/each}
      </div>
      <button class="secondary" onclick={addVirtualTag}>Add Virtual Tag</button>
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
    font-size: 1rem;
    font-weight: 600;
    color: var(--ev-c-text-2);
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
  .tab-content {
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
  label {
    font-weight: bold;
  }
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 1rem;
    cursor: pointer;
    font-weight: bold;
  }
  .checkbox-label input {
    width: 1.1rem;
    height: 1.1rem;
    flex-shrink: 0;
  }
  input[type='text'] {
    font-family:
      ui-monospace,
      SFMono-Regular,
      SF Mono,
      Menlo,
      Consolas,
      Liberation Mono,
      monospace;
  }
  select:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }
  .help-text {
    font-size: 0.8rem;
    color: var(--ev-c-text-2);
  }
  code {
    font-size: 0.8rem;
    padding: 2px 4px;
    background-color: var(--color-background-mute);
    border-radius: 3px;
  }

  .path-display-container {
    display: flex;
    gap: 0.5rem; /* Restore gap */
    align-items: center;
  }
  .path-display,
  .path-input {
    padding: 0.5rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    border-radius: 4px;
    font-family:
      ui-monospace,
      SFMono-Regular,
      SF Mono,
      Menlo,
      Consolas,
      Liberation Mono,
      monospace;
    font-size: 0.9rem;
    white-space: nowrap;
    overflow-x: auto;
    color: var(--ev-c-text-2);
    flex-grow: 1;
  }
  .path-input {
    color: var(--color-text);
    width: 100%;
  }
  /* Ensure the player command input looks like a normal input */
  #player-command-display {
    color: var(--color-text); /* Override the greyish text from .path-display */
  }
  #player-command-display.input-empty {
    /* Optional: different style for empty state if needed */
  }

  .virtual-tags-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .view-config-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background-color: var(--color-background);
    padding: 0.75rem 1rem;
    border-radius: 6px;
    border: 1px solid var(--color-background-mute);
    cursor: pointer;
    transition: border-color 0.2s;
    margin-top: 0.5rem;
  }
  .view-config-row:hover {
    border-color: var(--ev-c-gray-2);
  }
  .view-config-row span {
    font-weight: 600;
  }
  .view-config-row button {
    pointer-events: none;
  }
  .slider-container {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .slider-container input[type='range'] {
    flex-grow: 1;
  }
</style>
