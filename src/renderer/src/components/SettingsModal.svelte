<script lang="ts">
  import ModalWindow from './ModalWindow.svelte'
  import AutocompleteMenu from './AutocompleteMenu.svelte'
  import DefaultViewSettingsModal from './settings/DefaultViewSettingsModal.svelte'
  import DefaultLayoutSettingsModal from './settings/DefaultLayoutSettingsModal.svelte'
  const placeholderText = 'e.g., mpv {PATH} or "C:\\VLC\\vlc.exe" {PATH}'

let {
  close,
  scanLibrary,
  settings
}: { close: () => void; scanLibrary: () => Promise<void>; settings: Settings | null } = $props()

  type ActiveViewSettingsModal = 'general' | 'movie' | 'tv' | 'season' | null

  let activeTab: 'general' | 'library' | 'view' | 'virtualTags' = $state('general')
  let activeViewSettingsModal = $state<ActiveViewSettingsModal>(null)
  let activeLayoutSettingsModal = $state(false)

  // --- Form State ---
  let playerCommand = $state('')
  let tmdbApiKey = $state('')
  let useLogos = $state(true)
  let libraryPath = $state('')
  let virtualTags = $state<{ id: string; name: string; expression: string }[]>([])

  // New structured view settings state
  let defaultLayoutSettings = $state<Settings['defaultLayoutSettings'] | null>(null)
  let defaultViewSettings = $state<StoredViewSettings | null>(null)
  let defaultMovieViewSettings = $state<StoredViewSettings | null>(null)
  let defaultTvShowViewSettings = $state<StoredViewSettings | null>(null)
  let defaultSeasonViewSettings = $state<StoredViewSettings | null>(null)

  let settingsLoaded = $state(false)

  function formatLayoutString(viewSettings: ViewSettings | null): string {
    if (!viewSettings) return 'Loading...'

    const layout = viewSettings.layout.charAt(0).toUpperCase() + viewSettings.layout.slice(1)
    if (viewSettings.layout === 'tabs' || viewSettings.layout === 'sections') {
      const groupByKey = viewSettings.groupBy
      if (!groupByKey || groupByKey === 'folder') return layout

      let displayKey = groupByKey
      if (groupByKey.startsWith('tags.')) {
        displayKey = groupByKey.substring(5)
      } else if (groupByKey.startsWith('vt.')) {
        displayKey = groupByKey.substring(3)
      }
      const formattedKey = displayKey.charAt(0).toUpperCase() + displayKey.slice(1)
      return `${layout} by ${formattedKey}`
    }
    return layout
  }

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

  // Autocomplete state
  let activeTextarea = $state<HTMLTextAreaElement | null>(null)
  let activeTagId = $state<string | null>(null)
  let autocompleteState = $state<{
    show: boolean
    suggestions: string[]
    position: { top: number; left: number }
    onSelect: (suggestion: string) => void
  }>({
    show: false,
    suggestions: [],
    position: { top: 0, left: 0 },
    onSelect: () => {}
  })

  $effect(() => {
    window.api.getSettings().then((settings) => {
      playerCommand = settings.playerCommand ?? ''
      tmdbApiKey = settings.tmdbApiKey ?? ''
      useLogos = settings.useLogos ?? true
      virtualTags = (settings.virtualTags ?? []).map((vt) => ({ ...vt, id: crypto.randomUUID() }))

      // Set new view settings
      defaultLayoutSettings = JSON.parse(JSON.stringify(settings.defaultLayoutSettings))
      defaultViewSettings = settings.defaultViewSettings
      defaultMovieViewSettings = settings.defaultMovieViewSettings
      defaultTvShowViewSettings = settings.defaultTvShowViewSettings
      defaultSeasonViewSettings = settings.defaultSeasonViewSettings

      settingsLoaded = true
    })

    window.api.getLibraryMediaSourcePath().then((path) => {
      libraryPath = path ?? 'Not set'
    })

    window.api.getAutocompleteSuggestions().then((data) => (suggestions = data))

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
    virtualTags.push({ id: crypto.randomUUID(), name: '', expression: '' })
    virtualTags = virtualTags
  }

  function removeVirtualTag(id: string) {
    virtualTags = virtualTags.filter((vt) => vt.id !== id)
  }

  function handleExpressionInput() {
    if (!activeTextarea) return

    const textarea = activeTextarea
    const text = textarea.value
    const cursorPos = textarea.selectionStart

    let wordStart = cursorPos
    while (wordStart > 0 && /\w|\./.test(text[wordStart - 1])) {
      wordStart--
    }
    const currentWord = text.substring(wordStart, cursorPos)

    let potentialSuggestions: string[] = []

    const tagsMatch = currentWord.match(/^tags\.(\w*)$/)
    if (tagsMatch) {
      const partialKey = tagsMatch[1]
      potentialSuggestions = (suggestions.tagKeys ?? [])
        .filter((key) => key.toLowerCase().startsWith(partialKey.toLowerCase()))
        .map((key) => `tags.${key}`) // Suggest the full path
    } else {
      potentialSuggestions = VIRTUAL_TAG_CONTEXT_KEYS.filter((key) =>
        key.toLowerCase().startsWith(currentWord.toLowerCase())
      )
    }

    if (potentialSuggestions.length > 0 && currentWord.length > 0) {
      autocompleteState.suggestions = potentialSuggestions
      autocompleteState.show = true

      const rect = textarea.getBoundingClientRect()
      const modalWindow = textarea.closest('.modal-window')
      const modalRect = modalWindow?.getBoundingClientRect() ?? { top: 0, left: 0 }

      autocompleteState.position = {
        top: rect.bottom - modalRect.top + 4,
        left: rect.left - modalRect.left
      }
      autocompleteState.onSelect = (suggestion: string) => {
        const before = text.substring(0, wordStart)
        const after = text.substring(cursorPos)
        const newText = `${before}${suggestion}${after}`

        const tag = virtualTags.find((t) => t.id === activeTagId)
        if (tag) {
          tag.expression = newText
          virtualTags = virtualTags // trigger reactivity

          const newCursorPos = (before + suggestion).length
          queueMicrotask(() => {
            textarea.focus()
            textarea.setSelectionRange(newCursorPos, newCursorPos)
          })
        }
        autocompleteState.show = false
      }
    } else {
      autocompleteState.show = false
    }
  }

  function handleCancel() {
    close()
  }

  async function handleSave(): Promise<void> {
    const tagsToSave = virtualTags
      .map(({ name, expression }) => ({ name, expression }))
      .filter((vt) => vt.name && vt.expression)
    await window.api.saveSettings({
      playerCommand,
      tmdbApiKey,
      useLogos,
      virtualTags: tagsToSave,
      // New structured settings
      defaultLayoutSettings: defaultLayoutSettings
        ? JSON.parse(JSON.stringify(defaultLayoutSettings))
        : undefined,
      defaultViewSettings: defaultViewSettings ? { ...defaultViewSettings } : undefined,
      defaultMovieViewSettings: defaultMovieViewSettings
        ? { ...defaultMovieViewSettings }
        : undefined,
      defaultTvShowViewSettings: defaultTvShowViewSettings
        ? { ...defaultTvShowViewSettings }
        : undefined,
      defaultSeasonViewSettings: defaultSeasonViewSettings
        ? { ...defaultSeasonViewSettings }
        : undefined
    })
    close()
  }

  async function handleChangeLibrary() {
    await scanLibrary()
    libraryPath = (await window.api.getLibraryMediaSourcePath()) ?? 'Not set'
  }
</script>

{#if activeViewSettingsModal}
{#if activeViewSettingsModal === 'general' && defaultViewSettings}
    <DefaultViewSettingsModal
      title="Default Folder View"
      initialSettings={defaultViewSettings}
      groupByKeys={groupByKeys}
      availableLayouts={['grid', 'list', 'tree']}
      showClickAction={false}
      {settings}
      onClose={() => (activeViewSettingsModal = null)}
      onSave={(newSettings) => (defaultViewSettings = newSettings)}
    />
  {/if}
  {#if activeViewSettingsModal === 'movie' && defaultMovieViewSettings}
    <DefaultViewSettingsModal
      title="Default Movie Contents View"
      initialSettings={defaultMovieViewSettings}
      {groupByKeys}
      {settings}
      onClose={() => (activeViewSettingsModal = null)}
      onSave={(newSettings) => (defaultMovieViewSettings = newSettings)}
    />
  {/if}
  {#if activeViewSettingsModal === 'tv' && defaultTvShowViewSettings}
    <DefaultViewSettingsModal
      title="Default TV Show Contents View"
      initialSettings={defaultTvShowViewSettings}
      {groupByKeys}
      {settings}
      onClose={() => (activeViewSettingsModal = null)}
      onSave={(newSettings) => (defaultTvShowViewSettings = newSettings)}
    />
  {/if}
  {#if activeViewSettingsModal === 'season' && defaultSeasonViewSettings}
    <DefaultViewSettingsModal
      title="Default Season Contents View"
      initialSettings={defaultSeasonViewSettings}
      {groupByKeys}
      {settings}
      onClose={() => (activeViewSettingsModal = null)}
      onSave={(newSettings) => (defaultSeasonViewSettings = newSettings)}
    />
  {/if}
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

<ModalWindow title="Settings" onClose={handleCancel} onSave={handleSave}>
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
        <label for="player-command">Player Command</label>
        <input
          type="text"
          id="player-command"
          bind:value={playerCommand}
          placeholder={placeholderText}
        />
        <p class="help-text">
          Use <code>&lbrace;PATH&rbrace;</code> as a placeholder for the file path.
        </p>
      </div>
      <div class="form-group">
        <label for="tmdb-api-key">The Movie Database (TMDB) API Key</label>
        <input type="password" id="tmdb-api-key" bind:value={tmdbApiKey} />
        <p class="help-text">Required for fetching movie and show posters and details.</p>
      </div>
    {:else if activeTab === 'library'}
      <div class="form-group">
        <label for="source-type">Source Type</label>
        <select id="source-type" disabled>
          <option>Local Path</option>
        </select>
      </div>
      <div class="form-group">
        <label>Current Path</label>
        <div class="path-display-container">
          <div class="path-display">{libraryPath}</div>
          <button class="secondary" onclick={handleChangeLibrary}>Browse...</button>
        </div>
        <p class="help-text">Changing the folder will start a full re-scan of the new location.</p>
      </div>
    {:else if activeTab === 'view'}
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={useLogos} />
          <span>Show and fetch logos for movies and shows</span>
        </label>
        <p class="help-text">
          When enabled, the app will try to download high-quality logos (e.g., a movie's title
          treatment) to display on detail pages.
        </p>
      </div>
      <div class="form-group">
        <label>Default Layout Values</label>
        <p class="help-text">
          Configure global default values for specific layouts (e.g., poster size for Grid,
          group-by for Tabs).
        </p>
        <div class="view-config-row" onclick={() => (activeLayoutSettingsModal = true)}>
          <span>Global Defaults</span>
          <button class="secondary" tabindex="-1">Configure...</button>
        </div>
      </div>
      <div class="form-group">
        <label>Default Folder View</label>
        <p class="help-text">
          The default view used for folders that do not have a specific layout set.
        </p>
        <div class="view-config-row" onclick={() => (activeViewSettingsModal = 'general')}>
          <span>{formatLayoutString(defaultViewSettings)}</span>
          <button class="secondary" tabindex="-1">Configure...</button>
        </div>
      </div>
      <div class="form-group">
        <label>Default Movie Contents View</label>
        <p class="help-text">
          The default view for the contents of a movie folder on its detail page.
        </p>
        <div class="view-config-row" onclick={() => (activeViewSettingsModal = 'movie')}>
          <span>{formatLayoutString(defaultMovieViewSettings)}</span>
          <button class="secondary" tabindex="-1">Configure...</button>
        </div>
      </div>
      <div class="form-group">
        <label>Default TV Show Contents View</label>
        <p class="help-text">
          The default view for the contents of a TV show folder on its detail page.
        </p>
        <div class="view-config-row" onclick={() => (activeViewSettingsModal = 'tv')}>
          <span>{formatLayoutString(defaultTvShowViewSettings)}</span>
          <button class="secondary" tabindex="-1">Configure...</button>
        </div>
      </div>
      <div class="form-group">
        <label>Default Season Contents View</label>
        <p class="help-text">
          The default view for the contents of a season folder on its detail page.
        </p>
        <div class="view-config-row" onclick={() => (activeViewSettingsModal = 'season')}>
          <span>{formatLayoutString(defaultSeasonViewSettings)}</span>
          <button class="secondary" tabindex="-1">Configure...</button>
        </div>
      </div>
    {:else if activeTab === 'virtualTags'}
    <p><b>This feature is a work in progress and is currently slow.</b></p>
    <div class="help-text">
        <p>
            Large numbers of virtual tag definitions or a large library can significantly impact startup and reload performance.</p>
      </div>
      <div class="virtual-tags-list">
        {#each virtualTags as tag (tag.id)}
          <div class="virtual-tag-item">
            <div class="virtual-tag-inputs">
              <input type="text" bind:value={tag.name} placeholder="Tag Name" class="tag-name" />
              <textarea
                bind:value={tag.expression}
                placeholder="JavaScript Expression (e.g., tags.favorite ? 'Yes' : 'No')"
                class="tag-expression"
                rows="2"
                onfocus={(e) => {
                  activeTextarea = e.currentTarget
                  activeTagId = tag.id
                }}
                oninput={handleExpressionInput}
                onblur={() => (autocompleteState.show = false)}
              ></textarea>
            </div>
            <button class="remove-tag" onclick={() => removeVirtualTag(tag.id)} title="Remove Tag"
              >&times;</button
            >
          </div>
        {/each}
      </div>
      <button class="secondary" onclick={addVirtualTag}>Add Virtual Tag</button>
      {#if autocompleteState.show && activeTextarea}
        <AutocompleteMenu
          suggestions={autocompleteState.suggestions}
          position={autocompleteState.position}
          onSelect={autocompleteState.onSelect}
          onClose={() => (autocompleteState.show = false)}
        />
      {/if}
      <div class="help-text">
        <p>
          Create tags based on existing data using JavaScript. Your expression can access most
          properties of a library item, such as:
          <br />
          <code>title, name, year, mediaType, genres, tags, path, watched, seasonNumber, etc.</code>
        </p>
        <p>
          Example: <code>genres.includes('Animation') ? 'Animated' : 'Live Action'</code>
        </p>
        <p>Changes will be applied to all library items automatically after saving.</p>
      </div>
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
  input[type='text'],
  textarea.tag-expression {
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
    gap: 0.5rem;
    align-items: center;
  }
  .path-display {
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

  .virtual-tags-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .virtual-tag-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .virtual-tag-inputs {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .tag-name,
  .tag-expression {
    width: 100%;
  }
  .tag-expression {
    resize: vertical;
    min-height: 50px;
  }
  .remove-tag {
    background: none;
    color: var(--ev-c-text-2);
    font-size: 1.5rem;
    padding: 0 0.5rem;
    margin-top: 0.2rem;
  }
  .remove-tag:hover {
    color: #e81123;
    background: none;
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
</style>
