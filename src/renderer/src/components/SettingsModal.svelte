<script lang="ts">
  import ModalWindow from './ModalWindow.svelte'
  const placeholderText = 'e.g., mpv {PATH} or "C:\\VLC\\vlc.exe" {PATH}'

  let { close, scanLibrary }: { close: () => void; scanLibrary: () => Promise<void> } = $props()

  let activeTab: 'general' | 'library' | 'view' | 'virtualTags' = $state('general')

  // --- Form State ---
  let playerCommand = $state('')
  let tmdbApiKey = $state('')
  let useLogos = $state(true)
  let libraryPath = $state('')
  let virtualTags = $state<{ id: string; name: string; expression: string }[]>([])

  $effect(() => {
    window.api.getSettings().then((settings) => {
      playerCommand = settings.playerCommand ?? ''
      tmdbApiKey = settings.tmdbApiKey ?? ''
      useLogos = settings.useLogos ?? true
      virtualTags = (settings.virtualTags ?? []).map((vt) => ({ ...vt, id: crypto.randomUUID() }))
    })

    window.api.getLibraryMediaSourcePath().then((path) => {
      libraryPath = path ?? 'Not set'
    })

    const TABS = ['general', 'library', 'view', 'virtualTags'] as const
    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        const currentIndex = TABS.indexOf(activeTab)
        const nextIndex = event.shiftKey
          ? (currentIndex - 1 + TABS.length) % TABS.length
          : (currentIndex + 1) % TABS.length
        activeTab = TABS[nextIndex]
        return
      }

      if (event.key === 'Escape') {
        close()
      } else if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'BUTTON') {
        event.preventDefault()
        handleSave()
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

  async function handleSave(): Promise<void> {
    const tagsToSave = virtualTags
      .map(({ name, expression }) => ({ name, expression }))
      .filter((vt) => vt.name && vt.expression)
    await window.api.saveSettings({ playerCommand, tmdbApiKey, useLogos, virtualTags: tagsToSave })
    close()
  }

  async function handleChangeLibrary() {
    await scanLibrary()
    libraryPath = (await window.api.getLibraryMediaSourcePath()) ?? 'Not set'
  }
</script>

<ModalWindow title="Settings" onClose={close} onSave={handleSave}>
  <div slot="header" class="tabs">
    <button class:active={activeTab === 'general'} onclick={() => (activeTab = 'general')}
      >General</button
    >
    <button class:active={activeTab === 'library'} onclick={() => (activeTab = 'library')}
      >Library</button
    >
    <button class:active={activeTab === 'view'} onclick={() => (activeTab = 'view')}>View</button>
    <button
      class:active={activeTab === 'virtualTags'}
      onclick={() => (activeTab = 'virtualTags')}>Virtual Tags</button
    >
  </div>

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
        <p class="help-text">
          Changing the folder will start a full re-scan of the new location.
        </p>
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
    {:else if activeTab === 'virtualTags'}
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
              ></textarea>
            </div>
            <button class="remove-tag" onclick={() => removeVirtualTag(tag.id)} title="Remove Tag"
              >&times;</button
            >
          </div>
        {/each}
      </div>
      <button class="secondary" onclick={addVirtualTag}>Add Virtual Tag</button>
      <div class="help-text">
        <p>
          Create tags based on existing data using JavaScript. Your expression can access:
          <br />
          <code>tags, genres, year, title, name, mediaType, path</code>
        </p>
        <p>
          Example: <code>genres.includes('Animation') ? 'Animated' : 'Live Action'</code>
        </p>
        <p>You must manually refresh the library (F5) after saving to apply changes.</p>
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
    font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
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
    font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
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
</style>
