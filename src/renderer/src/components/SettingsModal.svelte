<script lang="ts">
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

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div
  class="modal-backdrop"
  onmousedown={(e) => e.target === e.currentTarget && close()}
  role="dialog"
>
  <div class="modal-content">
    <header class="modal-header">
      <h2>Settings</h2>
      <div class="tabs">
        <button class:active={activeTab === 'general'} onclick={() => (activeTab = 'general')}
          >General</button
        >
        <button class:active={activeTab === 'library'} onclick={() => (activeTab = 'library')}
          >Library</button
        >
        <button class:active={activeTab === 'view'} onclick={() => (activeTab = 'view')}
          >View</button
        >
        <button
          class:active={activeTab === 'virtualTags'}
          onclick={() => (activeTab = 'virtualTags')}>Virtual Tags</button
        >
      </div>
    </header>

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
          <p>
            You must manually refresh the library (F5) after saving to apply changes.
          </p>
        </div>
      {/if}
    </div>

    <div class="actions">
      <button class="secondary" onclick={() => close()}>Cancel</button>
      <button class="primary" onclick={handleSave}>Save & Close</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 100;
  }
  .modal-content {
    background-color: var(--color-background-soft);
    padding: 0;
    border-radius: 8px;
    width: 90%;
    max-width: 600px;
    display: flex;
    flex-direction: column;
    max-height: 90vh;
  }
  .modal-header {
    padding: 1.5rem 1.5rem 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--color-background-mute);
    flex-shrink: 0;
  }
  .tabs {
    display: flex;
  }
  .tabs button {
    padding: 0.8rem 1.2rem;
    cursor: pointer;
    background: none;
    border: none;
    color: var(--ev-c-text-2);
    font-size: 1rem;
    font-weight: 600;
    border-bottom: 3px solid transparent;
    margin-bottom: -1px;
  }
  .tabs button:hover:not(:disabled) {
    color: var(--ev-c-text-1);
  }
  .tabs button.active {
    color: var(--ev-c-text-1);
    border-bottom-color: var(--ev-c-white-soft);
  }
  .tab-content {
    padding: 1.5rem;
    overflow-y: auto;
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
  input,
  select,
  textarea {
    padding: 0.5rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    color: var(--color-text);
    border-radius: 4px;
    font-family: inherit;
    font-size: 1rem;
  }
  input[type='text'] {
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
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    padding: 1.5rem;
    border-top: 1px solid var(--color-background-mute);
  }
  button {
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 5px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--ev-c-text-1);
  }
  button.primary {
    background-color: var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
  }
  button.primary:hover {
    background-color: var(--ev-c-gray-1);
  }
  button.secondary {
    background-color: var(--ev-button-alt-bg);
    border: 1px solid var(--ev-c-gray-2);
  }
  button.secondary:hover {
    background-color: var(--ev-c-black-mute);
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
    font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
    resize: vertical;
    min-height: 50px;
  }
  .remove-tag {
    background: none;
    border: none;
    color: var(--ev-c-text-2);
    font-size: 1.5rem;
    padding: 0 0.5rem;
    cursor: pointer;
    margin-top: 0.2rem;
  }
  .remove-tag:hover {
    color: #e81123;
  }
</style>
